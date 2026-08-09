// src/shared/state/run-agent/__tests__/linked-runs.test.ts
// The workspace-feature join key, and the property it exists to have: it
// correlates runs across members and it decides NOTHING.
//
// The central row is `two members with different stacks…` below. It is a
// DIFFERENTIAL: the same two-member scenario is driven twice, once with the
// join key recorded on both ledgers and once without, and every verdict either
// run produces is compared. Anything the field could couple would show up as a
// transcript that differs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { ensureRunLedger, transitionRunStatus } from '../ledger';
import { runLedgerFingerprint } from '../run-paths';
import { settleTerminalRunLedger } from '../run-settle';
import { runReachedTerminalVerdict } from '../terminal-verdict';
import {
  LINKED_RUN_SIBLING_LIMIT,
  readWorkspaceFeatureLink,
  recordWorkspaceFeatureLinkResult,
  workspaceFeatureReport,
  type LinkedRunSibling,
  type WorkspaceFeatureLink,
} from '../linked-runs';

// `os.tmpdir()`, never a path in this repository: a `.traffic-one/` tree under
// the plugin's own checkout trips the authoring-repo stand-down, and every
// fixture here creates project state.
function tmpProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  return dir;
}

function ledgerFile(dir: string, runId: string): string {
  return path.join(dir, '.traffic-one', 'runs', runId, 'run.json');
}

function readLedger(dir: string, runId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(ledgerFile(dir, runId), 'utf8')) as Record<string, unknown>;
}

function writeDigest(dir: string, runId: string, name: string, verdict: string): void {
  const d = path.join(dir, '.traffic-one', 'digests', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), `# ${name}\nverdict: ${verdict}\n`, 'utf8');
}

function writePassingQaReport(dir: string, runId: string): void {
  const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', runId);
  fs.mkdirSync(qaDir, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(qaDir, 'mobile.png'), png);
  fs.writeFileSync(path.join(qaDir, 'desktop.png'), png);
  const viewport = (width: 390 | 768 | 1440, screenshotPath?: string) => ({
    width,
    status: 'passed',
    consoleErrorCount: 0,
    documentOverflow: false,
    elementOverflow: false,
    primaryAction: { status: 'reachable' },
    ...(screenshotPath ? { screenshotPath } : {}),
  });
  fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    producer: 'senior-tester',
    status: 'passed',
    routes: [{ route: '/', viewports: [viewport(390, 'mobile.png'), viewport(768), viewport(1440, 'desktop.png')] }],
  }));
}

// ── THE MEASUREMENT ──────────────────────────────────────────────────────────

const GO_STACK = 'default|none|go|none';
const REACT_STACK = 'default|react-vite|supabase|none';
const FEATURE = 'feat-checkout';

interface Verdict {
  step: string;
  status: unknown;
  outcome: unknown;
  terminal: boolean;
  fingerprint: string;
}

/**
 * Drive a two-member feature end to end and record every verdict either member
 * reaches. `linked` decides only whether the join key is written.
 *
 * Member A is a Go service whose run needs no browser evidence; member B is a
 * React app whose run does. That asymmetry is the point: under one shared run
 * id they would share `stackFingerprint` and one QA contract, so B's browser
 * requirement would land on A.
 */
function driveFeature(linked: boolean): Verdict[] {
  const goDir = tmpProject('t1-linked-go-');
  const webDir = tmpProject('t1-linked-web-');
  const transcript: Verdict[] = [];
  try {
    const goRun = 'run-go';
    const webRun = 'run-web';
    ensureRunLedger(goDir, goRun, { status: 'active', kind: 'orchestration', stackFingerprint: GO_STACK });
    ensureRunLedger(webDir, webRun, { status: 'active', kind: 'orchestration', stackFingerprint: REACT_STACK });

    if (linked) {
      const onGo = recordWorkspaceFeatureLinkResult(goDir, goRun, {
        workspaceFeatureId: FEATURE,
        memberId: 'api',
        siblings: [{ memberId: 'web', runId: webRun, stackFingerprint: REACT_STACK }],
      });
      assert.equal(onGo.outcome, 'applied', `go member link: ${onGo.reason}`);
      const onWeb = recordWorkspaceFeatureLinkResult(webDir, webRun, {
        workspaceFeatureId: FEATURE,
        memberId: 'web',
        siblings: [{ memberId: 'api', runId: goRun, stackFingerprint: GO_STACK }],
      });
      assert.equal(onWeb.outcome, 'applied', `web member link: ${onWeb.reason}`);
    }

    const observe = (step: string): void => {
      transcript.push({
        step: `${step}/api`,
        status: readLedger(goDir, goRun).status,
        outcome: readLedger(goDir, goRun).outcome,
        terminal: runReachedTerminalVerdict(goDir, goRun),
        fingerprint: runLedgerFingerprint(goDir, goRun),
      });
      transcript.push({
        step: `${step}/web`,
        status: readLedger(webDir, webRun).status,
        outcome: readLedger(webDir, webRun).outcome,
        terminal: runReachedTerminalVerdict(webDir, webRun),
        fingerprint: runLedgerFingerprint(webDir, webRun),
      });
    };

    observe('minted');

    // Each member earns its verdict from its OWN evidence. The Go run never
    // produces a QA report and never needs one; the React run does.
    writeDigest(goDir, goRun, 'backend.md', 'BUILD_COMPLETE');
    writeDigest(goDir, goRun, 'reviewer.md', 'APPROVED');
    writeDigest(goDir, goRun, 'tester.md', 'TESTS_GREEN');
    writeDigest(webDir, webRun, 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(webDir, webRun, 'reviewer.md', 'APPROVED');
    writeDigest(webDir, webRun, 'tester.md', 'TESTS_GREEN');
    observe('digests-only');

    // The React run is NOT terminal yet — its own missing browser evidence is
    // what holds it, and the Go sibling's completeness does nothing about that.
    // The tester re-emits after the report exists, which is what the freshness
    // watermark requires of a real tester.
    writePassingQaReport(webDir, webRun);
    writeDigest(webDir, webRun, 'tester.md', 'TESTS_GREEN');
    observe('qa-added');

    const webSettled = settleTerminalRunLedger(webDir, webRun, 'verified');
    transcript.push({
      step: 'web-settled/return',
      status: webSettled?.status ?? null,
      outcome: webSettled?.outcome ?? null,
      terminal: runReachedTerminalVerdict(webDir, webRun),
      fingerprint: runLedgerFingerprint(webDir, webRun),
    });
    observe('web-settled');

    // Now break the sibling: the Go member's run goes to a terminal `failed`,
    // the one status with no transition out of it.
    const failed = transitionRunStatus(goDir, goRun, { status: 'failed', outcome: 'agent-failed' });
    assert.equal(failed?.status, 'failed', 'fixture: the Go run must actually reach failed');
    observe('sibling-failed');

    // …and the React member's settled verdict must not have moved, including
    // when the settle path is re-driven against the failed sibling in place.
    const webResettled = settleTerminalRunLedger(webDir, webRun, 'verified');
    transcript.push({
      step: 'web-resettled/return',
      status: webResettled?.status ?? null,
      outcome: webResettled?.outcome ?? null,
      terminal: runReachedTerminalVerdict(webDir, webRun),
      fingerprint: runLedgerFingerprint(webDir, webRun),
    });
    observe('web-resettled');

    // The converse direction: removing the React member's OWN evidence is what
    // moves the React member, and it still moves nothing on the Go side.
    fs.rmSync(path.join(webDir, '.traffic-one', 'reports', 'qa', webRun), { recursive: true, force: true });
    writeDigest(webDir, webRun, 'tester.md', 'TESTS_FAILING');
    observe('web-evidence-pulled');

    if (linked) {
      // The join key survived every transition above — including the Go run's
      // terminal failure, which rewrites its ledger through the state machine.
      const goLink = readWorkspaceFeatureLink(goDir, goRun);
      assert.equal(goLink.kind, 'linked');
      const webLink = readWorkspaceFeatureLink(webDir, webRun);
      assert.equal(webLink.kind, 'linked');
      assert.deepEqual(
        workspaceFeatureReport([
          (goLink as { link: WorkspaceFeatureLink }).link,
          (webLink as { link: WorkspaceFeatureLink }).link,
        ]),
        [{
          workspaceFeatureId: FEATURE,
          members: [
            { memberId: 'api', runId: goRun, stackFingerprint: GO_STACK },
            { memberId: 'web', runId: webRun, stackFingerprint: REACT_STACK },
          ],
          // TWO stacks under ONE feature — the arrangement a shared run id
          // structurally cannot express.
          stackFingerprints: [GO_STACK, REACT_STACK].sort(),
          fingerprintDisagreements: [],
        }],
      );
    }
    return transcript;
  } finally {
    fs.rmSync(goDir, { recursive: true, force: true });
    fs.rmSync(webDir, { recursive: true, force: true });
  }
}

test('two members with different stacks share a feature id and settle entirely on their own evidence', () => {
  const withKey = driveFeature(true);
  const withoutKey = driveFeature(false);

  // Non-vacuity first: assert the transcript actually contains the verdicts the
  // comparison is supposed to be about, so a scenario that silently stopped
  // producing them fails here instead of passing on two empty lists.
  const step = (steps: Verdict[], name: string): Verdict => {
    const found = steps.find((entry) => entry.step === name);
    assert.ok(found, `transcript is missing ${name}`);
    return found;
  };
  assert.equal(step(withKey, 'qa-added/web').terminal, true, 'the React run earns its own terminal verdict');
  assert.equal(step(withKey, 'digests-only/web').terminal, false, 'and it is held by its OWN missing QA evidence');
  assert.equal(step(withKey, 'digests-only/api').terminal, true,
    'while the Go run is terminal without any browser evidence — two contracts, one feature');
  assert.equal(step(withKey, 'web-settled/return').outcome, 'verified');
  assert.equal(step(withKey, 'sibling-failed/api').status, 'failed');
  assert.equal(step(withKey, 'sibling-failed/web').status, 'completed',
    "the sibling's terminal failure does not move this member's settled status");
  assert.equal(step(withKey, 'sibling-failed/web').outcome, 'verified');
  assert.equal(step(withKey, 'web-resettled/return').outcome, 'verified',
    're-driving settlement beside a failed sibling still certifies on own evidence');
  assert.equal(step(withKey, 'web-evidence-pulled/api').status, 'failed',
    "pulling this member's evidence does not move the sibling either");
  assert.equal(step(withKey, 'sibling-failed/api').fingerprint, GO_STACK,
    'each run keeps the identity it was minted with');
  assert.equal(step(withKey, 'sibling-failed/web').fingerprint, REACT_STACK);

  // …and the whole transcript is byte-identical with and without the join key.
  assert.deepEqual(withKey, withoutKey,
    'recording the workspace feature join key changed a verdict somewhere — it is a reporting key and must decide nothing');
});

// ── The record itself ────────────────────────────────────────────────────────

test('recording a link adds exactly one namespaced key and moves no lifecycle field', () => {
  const dir = tmpProject('t1-linked-fields-');
  try {
    const runId = 'r1';
    ensureRunLedger(dir, runId, { status: 'active', kind: 'orchestration', stackFingerprint: GO_STACK });
    const before = readLedger(dir, runId);
    const result = recordWorkspaceFeatureLinkResult(dir, runId, {
      workspaceFeatureId: FEATURE,
      memberId: 'api',
      siblings: [{ memberId: 'web', runId: 'run-web', stackFingerprint: REACT_STACK }],
    });
    assert.equal(result.outcome, 'applied', result.reason);
    const after = readLedger(dir, runId);
    // ONE key, not three: the three parts are one fact and they live under one
    // name, so nothing this module writes can collide with a flat ledger key.
    assert.deepEqual(
      Object.keys(after).filter((key) => !(key in before)).sort(),
      ['workspaceFeature'],
    );
    // And all three parts are always present on disk, which is what makes an
    // absent part mean "edited" rather than "empty".
    assert.deepEqual(after.workspaceFeature, {
      id: FEATURE,
      memberId: 'api',
      siblings: [{ memberId: 'web', runId: 'run-web', stackFingerprint: REACT_STACK }],
    });
    for (const key of Object.keys(before)) {
      assert.deepEqual(after[key], before[key], `${key} must not move for a reporting write`);
    }
    // Named individually as well as by the loop above: these are the four the
    // whole design turns on, and a `before` that stopped carrying one would
    // make the loop pass vacuously for it.
    assert.equal(after.stackFingerprint, GO_STACK);
    assert.equal(after.status, 'active');
    assert.equal(after.qaContractVersion, before.qaContractVersion);
    assert.deepEqual(after.transitionHistory, before.transitionHistory);
    assert.equal(after.updatedAt, before.updatedAt,
      'a reporting annotation must not look like a state-machine event');

    const read = readWorkspaceFeatureLink(dir, runId);
    assert.equal(read.kind, 'linked');
    assert.deepEqual((read as { link: WorkspaceFeatureLink }).link, {
      workspaceFeatureId: FEATURE,
      self: { memberId: 'api', runId, stackFingerprint: GO_STACK },
      siblings: [{ memberId: 'web', runId: 'run-web', stackFingerprint: REACT_STACK }],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a sibling fingerprint is never adopted as this run\'s own frozen identity', () => {
  const dir = tmpProject('t1-linked-freeze-');
  try {
    const runId = 'r1';
    ensureRunLedger(dir, runId, { status: 'active', stackFingerprint: GO_STACK });
    const result = recordWorkspaceFeatureLinkResult(dir, runId, {
      workspaceFeatureId: FEATURE,
      memberId: 'api',
      siblings: [{ memberId: 'web', runId: 'run-web', stackFingerprint: REACT_STACK }],
    });
    assert.equal(result.outcome, 'applied', result.reason);
    assert.equal(runLedgerFingerprint(dir, runId), GO_STACK,
      'the sibling copy must not reach the frozen field or the cache in front of it');
    assert.equal(readLedger(dir, runId).stackFingerprint, GO_STACK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('siblings merge across calls, an exact re-record is applied, and the ids are immutable', () => {
  const dir = tmpProject('t1-linked-merge-');
  try {
    const runId = 'r1';
    ensureRunLedger(dir, runId, { status: 'active', stackFingerprint: GO_STACK });
    const base = { workspaceFeatureId: FEATURE, memberId: 'api' };
    const web: LinkedRunSibling = { memberId: 'web', runId: 'run-web', stackFingerprint: REACT_STACK };
    const etl: LinkedRunSibling = { memberId: 'etl', runId: 'run-etl', stackFingerprint: 'default|none|python|none' };

    assert.equal(recordWorkspaceFeatureLinkResult(dir, runId, { ...base, siblings: [web] }).outcome, 'applied');
    // A member joining later EXTENDS the record rather than replacing it.
    const second = recordWorkspaceFeatureLinkResult(dir, runId, { ...base, siblings: [etl] });
    assert.equal(second.outcome, 'applied', second.reason);
    assert.deepEqual(second.value?.siblings, [etl, web], 'sorted by member id, both retained');

    // Asserting the same thing again is a satisfied postcondition, not a refusal.
    const again = recordWorkspaceFeatureLinkResult(dir, runId, { ...base, siblings: [web, etl] });
    assert.equal(again.outcome, 'applied', again.reason);
    assert.deepEqual(again.value?.siblings, [etl, web]);

    assert.equal(
      recordWorkspaceFeatureLinkResult(dir, runId, { ...base, workspaceFeatureId: 'feat-other' }).reason,
      'feature-id-immutable',
    );
    assert.equal(
      recordWorkspaceFeatureLinkResult(dir, runId, { ...base, memberId: 'renamed' }).reason,
      'member-id-immutable',
    );
    // A frozen value cannot have two spellings; the disagreement is refused
    // rather than resolved by last-write-wins.
    const conflict = recordWorkspaceFeatureLinkResult(dir, runId, {
      ...base,
      siblings: [{ ...web, stackFingerprint: 'default|nextjs|none|none' }],
    });
    assert.equal(conflict.outcome, 'precondition-failed');
    assert.equal(conflict.reason, 'sibling-fingerprint-conflict');
    assert.deepEqual(readWorkspaceFeatureLink(dir, runId).kind, 'linked');
    assert.deepEqual(
      (readLedger(dir, runId).workspaceFeature as { siblings: unknown }).siblings,
      [etl, web],
      'a refused merge writes nothing',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the sibling bound refuses rather than truncating a membership list', () => {
  const dir = tmpProject('t1-linked-bound-');
  try {
    const runId = 'r1';
    ensureRunLedger(dir, runId, { status: 'active', stackFingerprint: GO_STACK });
    const many = Array.from({ length: LINKED_RUN_SIBLING_LIMIT }, (_, index) => ({
      memberId: `m${String(index).padStart(3, '0')}`,
      runId: `run-${index}`,
      stackFingerprint: GO_STACK,
    }));
    const atLimit = recordWorkspaceFeatureLinkResult(dir, runId, {
      workspaceFeatureId: FEATURE,
      memberId: 'api',
      siblings: many,
    });
    assert.equal(atLimit.outcome, 'applied', atLimit.reason);
    assert.equal(atLimit.value?.siblings.length, LINKED_RUN_SIBLING_LIMIT);

    const overLimit = recordWorkspaceFeatureLinkResult(dir, runId, {
      workspaceFeatureId: FEATURE,
      memberId: 'api',
      siblings: [{ memberId: 'one-too-many', runId: 'run-x', stackFingerprint: GO_STACK }],
    });
    assert.equal(overLimit.outcome, 'precondition-failed');
    assert.equal(overLimit.reason, 'sibling-limit');
    assert.equal(
      ((readLedger(dir, runId).workspaceFeature as { siblings: unknown[] }).siblings).length,
      LINKED_RUN_SIBLING_LIMIT,
      'nothing was dropped to make room',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused or illegible ledger is reported, never minted over', () => {
  const dir = tmpProject('t1-linked-refusal-');
  try {
    const request = { workspaceFeatureId: FEATURE, memberId: 'api' };

    // No ledger at all: refuse rather than create a run.json with a feature id
    // and no lifecycle fields.
    const absent = recordWorkspaceFeatureLinkResult(dir, 'ghost', request);
    assert.equal(absent.outcome, 'precondition-failed');
    assert.equal(absent.reason, 'no-ledger');
    assert.equal(fs.existsSync(ledgerFile(dir, 'ghost')), false, 'a refusal must not mint a ledger');

    // Bytes that are not JSON: `unavailable`, because nothing was decided.
    const torn = 'torn';
    ensureRunLedger(dir, torn, { status: 'active', stackFingerprint: GO_STACK });
    fs.writeFileSync(ledgerFile(dir, torn), '{ "status": ', 'utf8');
    const corrupt = recordWorkspaceFeatureLinkResult(dir, torn, request);
    assert.equal(corrupt.outcome, 'unavailable');
    assert.equal(corrupt.reason, 'ledger-corrupt');
    assert.equal(fs.readFileSync(ledgerFile(dir, torn), 'utf8'), '{ "status": ',
      'the torn bytes are preserved, not replaced by this one field');
    assert.equal(readWorkspaceFeatureLink(dir, torn).kind, 'illegible',
      'and the reader says it could not tell, rather than "no siblings"');

    // A planted symlink at run.json: readable (reads are never fenced) and
    // unwritable (the symlink fence). The refusal must reach the caller.
    const linkedRun = 'planted';
    ensureRunLedger(dir, linkedRun, { status: 'active', stackFingerprint: GO_STACK });
    const real = `${ledgerFile(dir, linkedRun)}.real`;
    fs.renameSync(ledgerFile(dir, linkedRun), real);
    fs.symlinkSync(real, ledgerFile(dir, linkedRun));
    const refused = recordWorkspaceFeatureLinkResult(dir, linkedRun, request);
    assert.equal(refused.outcome, 'unavailable', refused.reason);
    assert.equal(refused.reason, 'link-write-refused');
    assert.equal(readWorkspaceFeatureLink(dir, linkedRun).kind, 'none',
      'nothing was recorded through the link');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed ids and a self-referential sibling are refused before anything is written', () => {
  const dir = tmpProject('t1-linked-untrusted-');
  try {
    const runId = 'r1';
    ensureRunLedger(dir, runId, { status: 'active', stackFingerprint: GO_STACK });
    const cases: [string, Parameters<typeof recordWorkspaceFeatureLinkResult>[2], string][] = [
      ['a traversing feature id', { workspaceFeatureId: '../evil', memberId: 'api' }, 'unsafe-feature-id'],
      ['an empty feature id', { workspaceFeatureId: '', memberId: 'api' }, 'unsafe-feature-id'],
      ['a traversing member id', { workspaceFeatureId: FEATURE, memberId: 'a/b' }, 'unsafe-member-id'],
      ['a sibling naming this member', {
        workspaceFeatureId: FEATURE,
        memberId: 'api',
        siblings: [{ memberId: 'api', runId: 'other', stackFingerprint: GO_STACK }],
      }, 'unsafe-siblings'],
      ['a sibling with a traversing run id', {
        workspaceFeatureId: FEATURE,
        memberId: 'api',
        siblings: [{ memberId: 'web', runId: '../../etc', stackFingerprint: GO_STACK }],
      }, 'unsafe-siblings'],
    ];
    for (const [what, request, reason] of cases) {
      const result = recordWorkspaceFeatureLinkResult(dir, runId, request);
      assert.equal(result.outcome, 'precondition-failed', what);
      assert.equal(result.reason, reason, what);
    }
    assert.equal(readWorkspaceFeatureLink(dir, runId).kind, 'none', 'no refusal recorded anything');

  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a half-written feature record is opaque and is never completed with defaults', () => {
  const dir = tmpProject('t1-linked-halfrecord-');
  try {
    const runId = 'r1';
    ensureRunLedger(dir, runId, { status: 'active', stackFingerprint: GO_STACK });
    const pristine = readLedger(dir, runId);
    const plant = (workspaceFeature: unknown): void => {
      fs.writeFileSync(ledgerFile(dir, runId), JSON.stringify({ ...pristine, workspaceFeature }), 'utf8');
    };

    const halves: [string, unknown][] = [
      ['the record is not an object', 'feat-checkout'],
      ['the record is an array', [FEATURE]],
      ['the id is missing', { memberId: 'api', siblings: [] }],
      ['the id traverses', { id: '../evil', memberId: 'api', siblings: [] }],
      ['the member id is missing', { id: FEATURE, siblings: [] }],
      // The case the namespace exists to make legible: a DELETED list is not an
      // empty one. Under three flat keys this is indistinguishable from a
      // record that never had siblings.
      ['the siblings key was deleted', { id: FEATURE, memberId: 'api' }],
      ['the siblings key is not a list', { id: FEATURE, memberId: 'api', siblings: 'none' }],
      ['a sibling entry is malformed', { id: FEATURE, memberId: 'api', siblings: [{ memberId: 'web' }] }],
    ];
    for (const [what, planted] of halves) {
      plant(planted);
      const read = readWorkspaceFeatureLink(dir, runId);
      assert.equal(read.kind, 'opaque', what);
      assert.ok((read as { why: string }).why.includes('workspaceFeature'), `${what}: names the record`);
      // …and a writer must not merge into, or silently replace, a record it
      // could not read. The bytes stay exactly as planted.
      const before = fs.readFileSync(ledgerFile(dir, runId), 'utf8');
      const merge = recordWorkspaceFeatureLinkResult(dir, runId, { workspaceFeatureId: FEATURE, memberId: 'api' });
      assert.equal(merge.outcome, 'precondition-failed', what);
      assert.equal(merge.reason, 'feature-record-malformed', what);
      assert.equal(fs.readFileSync(ledgerFile(dir, runId), 'utf8'), before, `${what}: nothing was rewritten`);
    }

    // The contrast that keeps the rows above non-vacuous: an EXPLICIT empty
    // list is a valid record and reads as a link with no siblings.
    plant({ id: FEATURE, memberId: 'api', siblings: [] });
    const empty = readWorkspaceFeatureLink(dir, runId);
    assert.equal(empty.kind, 'linked');
    assert.deepEqual((empty as { link: WorkspaceFeatureLink }).link.siblings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the authoring repo stands down before any read or write', () => {
  // The system temp ROOT is a machine-config root by `isNonProjectRoot`'s own
  // rule, so this exercises the same guard the plugin checkout takes without
  // creating state anywhere.
  const result = recordWorkspaceFeatureLinkResult(os.tmpdir(), 'r1', {
    workspaceFeatureId: FEATURE,
    memberId: 'api',
  });
  assert.equal(result.outcome, 'precondition-failed');
  assert.equal(result.reason, 'authoring-root');
});

test('the report names a fingerprint disagreement instead of picking a winner', () => {
  const authoritative: WorkspaceFeatureLink = {
    workspaceFeatureId: FEATURE,
    self: { memberId: 'web', runId: 'run-web', stackFingerprint: REACT_STACK },
    siblings: [],
  };
  const staleCopy: WorkspaceFeatureLink = {
    workspaceFeatureId: FEATURE,
    self: { memberId: 'api', runId: 'run-go', stackFingerprint: GO_STACK },
    // A copy taken before the React run stamped its identity.
    siblings: [{ memberId: 'web', runId: 'run-web', stackFingerprint: 'default|none|none|none' }],
  };
  const [row] = workspaceFeatureReport([staleCopy, authoritative]);
  assert.ok(row);
  assert.deepEqual(row.members, [
    { memberId: 'api', runId: 'run-go', stackFingerprint: GO_STACK },
    // The member's OWN record wins the row, whichever arrived first.
    { memberId: 'web', runId: 'run-web', stackFingerprint: REACT_STACK },
  ]);
  assert.deepEqual(row.fingerprintDisagreements, [{
    memberId: 'web',
    runId: 'run-web',
    recorded: ['default|none|none|none', REACT_STACK].sort(),
  }]);
});

// ── The structural half ──────────────────────────────────────────────────────

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function sourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(absolute);
        continue;
      }
      if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name)) out.push(absolute);
    }
  };
  walk(root);
  return out;
}

const OWN_MODULE = path.join(SRC_ROOT, 'shared', 'state', 'run-agent', 'linked-runs.ts');
const OWN_TEST = path.resolve(__filename);

/**
 * Modules other than this one that are allowed to name the feature id.
 *
 * EMPTY TODAY, and that empty list IS the dormancy proof: nothing outside this
 * module and its test so much as spells the token, so no production path can
 * currently record a link. It is a RATCHET, not a permanent zero — workspace
 * onboarding will eventually call the writer and will have to add itself here,
 * which is the review point where somebody asks whether the new caller is a
 * REPORTER or has started deciding something. The invariant that must never be
 * relaxed is the parse below, which has no allowlist.
 */
const FEATURE_CALLERS: readonly string[] = [];

test('no module outside this one so much as mentions the feature join key', () => {
  // METHOD: a TEXT scan over every source file under src/, counting FILES whose
  // bytes contain the token — deliberately NOT a parse. For a claim of ZERO the
  // text superset is strictly stronger than an AST scan: it also catches the
  // token in a string literal, a computed key, a comment or a template, any of
  // which could become a read.
  //
  // THE SUBJECT IS `workspaceFeature`, the ledger key, and it is a different
  // string from the `workspaceFeatureId` this scan used before the record was
  // namespaced — re-measured here rather than inherited. It is also a PREFIX of
  // this module's in-memory `workspaceFeatureId` field names, which makes the
  // scan a superset of both spellings, which is the direction that is safe.
  const files = sourceFilesUnder(SRC_ROOT);
  assert.ok(files.length > 500, `fixture: expected to scan the whole tree, scanned ${files.length}`);
  const mentions = files.filter((file) => (
    file !== OWN_MODULE
    && file !== OWN_TEST
    && fs.readFileSync(file, 'utf8').includes('workspaceFeature')
  ));
  assert.deepEqual(mentions.map((file) => path.relative(SRC_ROOT, file)), [...FEATURE_CALLERS],
    'the feature record is a reporting key: a new module naming it must be a reporter, not a decider');
});

test('no ledger or settlement module reads the feature record or its parts', () => {
  // METHOD: a PARSE, because `memberId` and `siblings` are ordinary English and
  // a text scan over them counts prose. Every property access, property-name
  // write and string-literal element access in the run-ledger and settlement
  // modules is walked, and the scope is named rather than implied: this
  // measures src/shared/state/run-agent/** and src/shared/run-settlement/**,
  // which are the modules that decide a run's status, its claim admission and
  // its settlement.
  //
  // `id` IS NOT IN THE WATCH SET AND CANNOT BE. It is a two-letter property
  // name that appears legitimately all over any codebase, so neither a scan nor
  // a parse can say anything about it — stated here rather than papered over.
  // What covers it instead is the namespace: `id` is a part of the
  // `workspaceFeature` object and no reader can reach it without first naming
  // that key, which both this parse and the text scan above do catch. Under the
  // flat spelling the plan proposed, there would have been no such cover.
  const scope = [
    ...sourceFilesUnder(path.join(SRC_ROOT, 'shared', 'state', 'run-agent')),
    ...sourceFilesUnder(path.join(SRC_ROOT, 'shared', 'run-settlement')),
  ].filter((file) => file !== OWN_MODULE && file !== OWN_TEST && !file.includes(`${path.sep}__tests__${path.sep}`));
  assert.ok(scope.length > 20, `fixture: expected the whole ledger/settlement surface, got ${scope.length}`);

  const watched = new Set(['workspaceFeature', 'workspaceFeatureId', 'memberId', 'siblings']);
  const hits: string[] = [];
  for (const file of scope) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && watched.has(node.name.text)) {
        hits.push(`${path.relative(SRC_ROOT, file)}: .${node.name.text}`);
      }
      if (ts.isElementAccessExpression(node)
        && ts.isStringLiteralLike(node.argumentExpression)
        && watched.has(node.argumentExpression.text)) {
        hits.push(`${path.relative(SRC_ROOT, file)}: [${node.argumentExpression.text}]`);
      }
      if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node))
        && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
        && watched.has(node.name.text)) {
        hits.push(`${path.relative(SRC_ROOT, file)}: ${node.name.text}:`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(hits, [],
    'a member/sibling field reached a module that decides a run status, claim admission or settlement');
});
