// The operator override: the token itself, the one predicate that decides what
// it may lift, and the pipeline path that consumes it.
//
// Every test redirects XDG_STATE_HOME into a temp dir, because the machine dir
// is where the per-install HMAC key lives — a leak here writes a key into the
// developer's own `~/.traffic-one` and, worse, a passing test would then be
// reading THEIR ledger.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildContext } from '../../../core/context';
import { runPipeline } from '../../../core/pipeline';
import { context, deny, askUser } from '../../../core/result';
import { toolClassForRawName } from '../../../core/events';
import { NEVER_OVERRIDABLE_DENY_IDS } from '../../../config/deny-ids';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';
import { isTrafficOneDoctorCommand } from '../../tool-classify';
import { parseArgs } from '../../../runners/doctor/lib';
import {
  OVERRIDE_MAX_TTL_MS,
  activeOverrideToken,
  mintOverride,
  operatorOverrideHint,
  overridableDeny,
  overrideForDeny,
  overrideLedgerPath,
  parseOverrideTtl,
  readOverrideLedger,
  runOverrideRecords,
  runUsedOperatorOverride,
  unblockCommand,
  unvouchableOverrideEntries,
  type MintOverrideInput,
} from '../index';
import { overrideKeyPath } from '../paths';
import type { Ctx, Handler, HookInput, HookResult } from '../../../core/types';

// ── fixture ──────────────────────────────────────────────────────────────────

const TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  // realpath: macOS's tmpdir is a symlink, and projectRootHash resolves before
  // hashing — an unresolved fixture path would key the ledger differently from
  // every read.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TEMP_DIRS.push(dir);
  return dir;
}

interface Fixture {
  readonly projectRoot: string;
  readonly machineDir: string;
}

function withOverrideStore(body: (fixture: Fixture) => void): void {
  const saved = process.env.XDG_STATE_HOME;
  const base = tempDir('t1-override-');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  resetPluginUseCache();
  recordPluginUseChoice(projectRoot, true, 'test');
  try {
    body({ projectRoot, machineDir: path.join(base, 'state', 'traffic-one') });
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    resetPluginUseCache();
  }
}

function mint(over: Partial<MintOverrideInput> & { projectRoot: string }): void {
  const result = mintOverride({
    runId: 'run-1',
    scope: 'gate',
    target: 'plan-guard',
    snapshot: { fixture: true },
    ...over,
  });
  assert.equal(result.ok, true, `mint failed: ${result.ok ? '' : result.reason}`);
}

/** Rewrite one ledger line, the way something without the key would have to. */
function rewriteLedgerLine(projectRoot: string, edit: (token: Record<string, unknown>) => void): void {
  const file = overrideLedgerPath(projectRoot);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const token = JSON.parse(lines[0] as string) as Record<string, unknown>;
  edit(token);
  fs.writeFileSync(file, `${[JSON.stringify(token), ...lines.slice(1)].join('\n')}\n`, 'utf8');
}

// ── TTL ──────────────────────────────────────────────────────────────────────

test('the TTL grammar takes bounded windows and refuses everything else', () => {
  assert.equal(parseOverrideTtl('30m'), 30 * 60_000);
  assert.equal(parseOverrideTtl('90s'), 90_000);
  assert.equal(parseOverrideTtl('2h'), 2 * 3_600_000);
  assert.equal(parseOverrideTtl(' 45m '), 45 * 60_000, 'surrounding whitespace is not an error');
  assert.equal(parseOverrideTtl('24h'), OVERRIDE_MAX_TTL_MS, 'the ceiling itself is accepted');
  // A bare number is the dangerous one: guessing "minutes" would eventually
  // guess wrong in the permissive direction (`--ttl 30` meaning 30 hours).
  assert.equal(parseOverrideTtl('30'), null);
  assert.equal(parseOverrideTtl('25h'), null, 'past the 24h ceiling');
  assert.equal(parseOverrideTtl('1441m'), null, 'the ceiling is on the WINDOW, not on the unit');
  assert.equal(parseOverrideTtl('0m'), null);
  assert.equal(parseOverrideTtl('-5m'), null);
  assert.equal(parseOverrideTtl('30 m'), null);
  assert.equal(parseOverrideTtl(''), null);
});

test('a ttl past the ceiling is clamped at mint rather than trusted', () => {
  withOverrideStore(({ projectRoot }) => {
    const nowMs = Date.parse('2030-01-01T00:00:00.000Z');
    const result = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: {},
      ttlMs: 90 * 24 * 3_600_000, nowMs,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(Date.parse(result.token.expiresAt) - nowMs, OVERRIDE_MAX_TTL_MS);
  });
});

// ── the token ────────────────────────────────────────────────────────────────

test('a minted token is honoured for its own (run, gate) and nothing else', () => {
  withOverrideStore(({ projectRoot }) => {
    mint({ projectRoot });
    assert.ok(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), 'the token it was minted for');
    assert.equal(activeOverrideToken(projectRoot, 'run-2', 'gate', 'plan-guard'), null, 'another run');
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'authoring-guard'), null, 'another gate');
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'evidence', 'plan-guard'), null, 'another scope');
    assert.equal(activeOverrideToken(projectRoot, null, 'gate', 'plan-guard'), null, 'no run at all');
  });
});

test('an expired token is absent to gates but still visible to the abuse guard', () => {
  withOverrideStore(({ projectRoot }) => {
    mint({ projectRoot, ttlMs: 1_000, nowMs: Date.now() - 60_000 });
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null, 'past its TTL is absent');
    // The whole point of the guard being TTL-blind: otherwise waiting out 30
    // minutes launders the run.
    assert.equal(runOverrideRecords(projectRoot, 'run-1').length, 1);
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), true);
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-2'), false, 'and it is scoped to its own run');
  });
});

test('every field of the token is authenticated: a tampered line is forged, not honoured', () => {
  for (const [field, value] of [
    ['target', 'authoring-guard'],
    ['runId', 'run-2'],
    ['expiresAt', new Date(Date.now() + 9 * 3_600_000).toISOString()],
    ['scope', 'evidence'],
    ['projectRoot', '/somewhere/else'],
    ['id', 'deadbeef'],
  ] as const) {
    withOverrideStore(({ projectRoot }) => {
      mint({ projectRoot });
      rewriteLedgerLine(projectRoot, (token) => { token[field] = value; });
      const entries = readOverrideLedger(projectRoot);
      assert.equal(entries.length, 1, field);
      assert.equal(entries[0]?.outcome, 'forged', `${field} must be covered by the MAC`);
      assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false,
        `a forged line must not even count for the abuse guard (${field})`);
    });
  }
});

test('a line written by something that never held the key is forged and reported', () => {
  withOverrideStore(({ projectRoot }) => {
    mint({ projectRoot });
    // The realistic attempt: an agent that has read the format and writes its
    // own line, MAC and all. It cannot compute one over a key it never read.
    const forged = {
      v: 1,
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      scope: 'gate',
      target: 'authoring-guard',
      projectKey: JSON.parse(fs.readFileSync(overrideLedgerPath(projectRoot), 'utf8').split('\n')[0] as string).projectKey,
      projectRoot,
      runId: 'run-1',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      issuedByUser: 'agent',
      issuedByHostname: 'agent',
      issuedByPid: 1,
      snapshot: 'none.json',
      mac: 'f'.repeat(64),
    };
    fs.appendFileSync(overrideLedgerPath(projectRoot), `${JSON.stringify(forged)}\n`, 'utf8');
    fs.appendFileSync(overrideLedgerPath(projectRoot), 'not json at all\n', 'utf8');

    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'authoring-guard'), null, 'not honoured');
    assert.ok(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), 'the genuine line still works');
    // Treated as absent AND reported — a silently ignored forgery is a signal
    // nobody ever sees.
    const unvouchable = unvouchableOverrideEntries(projectRoot);
    assert.equal(unvouchable.length, 2);
    assert.deepEqual(unvouchable.map((entry) => entry.outcome).sort(), ['forged', 'malformed']);
  });
});

test('without a readable per-install key nothing is honoured', () => {
  withOverrideStore(({ projectRoot }) => {
    mint({ projectRoot });
    assert.ok(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'));

    // Key rotated/restored from another machine: every previously minted token
    // stops verifying. Fail-closed is the correct direction here.
    fs.writeFileSync(overrideKeyPath(), `${'a'.repeat(64)}\n`, 'utf8');
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null, 'a rotated key');
    assert.equal(unvouchableOverrideEntries(projectRoot).length, 1);

    // A symlink where the key belongs is refused rather than followed: a key
    // aimed somewhere else is either not ours or is aimed where an attacker
    // can read it.
    const elsewhere = path.join(tempDir('t1-override-key-'), 'key');
    fs.writeFileSync(elsewhere, `${'a'.repeat(64)}\n`, 'utf8');
    fs.rmSync(overrideKeyPath());
    fs.symlinkSync(elsewhere, overrideKeyPath());
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null, 'a symlinked key');
  });
});

test('a token minted for one project is not honoured in another', () => {
  withOverrideStore(({ projectRoot }) => {
    const other = path.join(path.dirname(projectRoot), 'other');
    fs.mkdirSync(other, { recursive: true });
    mint({ projectRoot });
    // Copy the ledger verbatim into the other project's bucket: the MAC covers
    // projectKey, so relocating a valid line cannot make it apply here.
    const target = overrideLedgerPath(other);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(overrideLedgerPath(projectRoot), target);
    assert.equal(activeOverrideToken(other, 'run-1', 'gate', 'plan-guard'), null);
    assert.equal(readOverrideLedger(other)[0]?.outcome, 'forged');
  });
});

test('the mint writes its audit line and its pre-override snapshot, and never mutates either', () => {
  withOverrideStore(({ projectRoot }) => {
    const first = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { before: 'state-A' },
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(JSON.parse(fs.readFileSync(first.snapshotPath, 'utf8')), { before: 'state-A' });

    // A second override for the same gate APPENDS: there is no update path, so
    // the audit trail cannot be rewritten by minting again.
    mint({ projectRoot });
    const lines = fs.readFileSync(overrideLedgerPath(projectRoot), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] as string).id, first.token.id, 'the first line is untouched');
    assert.equal(runOverrideRecords(projectRoot, 'run-1').length, 2);
  });
});

// ── the tier-1 predicate ─────────────────────────────────────────────────────

test('tier-1 is PreToolUse, not askUser, not never-overridable — and nothing else is offered a command', () => {
  assert.equal(overridableDeny({ event: 'PreToolUse', denyId: 'scaffold-plan-gate' }), true);

  // An approval prompt is not a refusal: the human IS the gate, so there is
  // nothing to override, and offering an escape hatch inside a yes/no modal
  // would be an invitation to route around the person being asked.
  assert.equal(overridableDeny({ event: 'PreToolUse', denyId: 'user-approval-request', askUser: true }), false);
  assert.equal(overridableDeny({ event: 'PreToolUse', denyId: 'scaffold-plan-gate', askUser: true }), false);

  // A Stop/UserPromptSubmit deny does not block a tool call, so there is
  // nothing wedged for an operator to unwedge.
  assert.equal(overridableDeny({ event: 'Stop', denyId: 'scaffold-plan-gate' }), false);
  assert.equal(overridableDeny({ event: 'UserPromptSubmit', denyId: 'scaffold-plan-gate' }), false);

  // An unattributed deny (denyId filled in by stampDeny AFTER this runs) is not
  // overridable: with no stable identity there is nothing to check the
  // never-overridable list against.
  assert.equal(overridableDeny({ event: 'PreToolUse', denyId: undefined }), false);
  assert.equal(overridableDeny({ event: 'PreToolUse', denyId: 'not-a-real-deny-id' }), false);
});

test('no deny on the never-overridable list is offered a command or lifted by a token', () => {
  assert.ok(NEVER_OVERRIDABLE_DENY_IDS.length > 0);
  for (const denyId of NEVER_OVERRIDABLE_DENY_IDS) {
    assert.equal(overridableDeny({ event: 'PreToolUse', denyId }), false, denyId);
    assert.equal(operatorOverrideHint({ event: 'PreToolUse', denyId, gateId: 'g', runId: 'run-1' }), '', denyId);
  }
  // …and the read path refuses independently of the mint path, so a token that
  // reached the ledger some other way still lifts nothing.
  withOverrideStore(({ projectRoot }) => {
    mint({ projectRoot, target: 'authoring-guard' });
    assert.equal(
      overrideForDeny(projectRoot, 'run-1', 'authoring-guard', { event: 'PreToolUse', denyId: 'authoring-guard' }),
      null,
    );
  });
});

// ── the printed command ──────────────────────────────────────────────────────

test('the command a deny prints is the command doctor parses — and is still not gate-exempt', () => {
  const command = unblockCommand('plan-guard', 'run-42');
  assert.match(command, /--unblock plan-guard --run run-42$/);

  // The anti-lie property: what is printed must actually work. Parsed with
  // doctor's OWN argv parser, not a regex that agrees with itself.
  const argv = command.split(' ').slice(1);
  const args = parseArgs(argv.slice(1));
  assert.equal(args.unblock, 'plan-guard');
  assert.equal(args.run, 'run-42');

  // …and the same string must NOT satisfy the gate-exemption grammar, or an
  // agent could mint by re-emitting the deny's own advice.
  assert.equal(isTrafficOneDoctorCommand('Bash', { command }), false);

  // An id the grammar could not carry declines rather than printing a command
  // that would be rejected on arrival.
  assert.equal(unblockCommand('plan guard', 'run-1'), '');
  assert.equal(unblockCommand('', 'run-1'), '');
  assert.equal(unblockCommand('plan-guard', 'not a run id').includes('--run'), false);
});

test('the hint names the run, the human, and the price', () => {
  const hint = operatorOverrideHint({
    event: 'PreToolUse', denyId: 'scaffold-plan-gate', gateId: 'plan-guard', runId: 'run-42',
  });
  assert.match(hint, /--unblock plan-guard --run run-42/);
  assert.match(hint, /human \(not the agent\)/);
  assert.match(hint, /verified\/shipped/);
});

// ── the pipeline ─────────────────────────────────────────────────────────────

function gate(id: string, priority: number, run: () => HookResult): Handler {
  return { id, event: 'PreToolUse', priority, tools: ['shell'], run };
}

function ctxFor(cwd: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: {},
    tool: { class: toolClassForRawName('Bash'), rawName: 'Bash' },
  };
  return buildContext(input);
}

function withRun(projectRoot: string, runId: string): void {
  const stateDir = path.join(projectRoot, '.traffic-one');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.one.json'), JSON.stringify({ currentRunId: runId }), 'utf8');
}

test('an overridable deny with no token is refused, with the command for its own gate', async () => {
  await withOverrideStoreAsync(async ({ projectRoot }) => {
    withRun(projectRoot, 'run-1');
    const result = await runPipeline(
      [gate('plan-guard', 10, () => deny('plan write refused', { denyId: 'scaffold-plan-gate' }))],
      ctxFor(projectRoot),
    );
    assert.equal(result.kind, 'deny');
    if (result.kind !== 'deny') return;
    assert.match(result.reason, /^plan write refused/, 'the gate\'s own text still leads');
    assert.match(result.reason, /--unblock plan-guard --run run-1/);
  });
});

test('a live token skips that gate, records why, and lets every later gate still refuse', async () => {
  await withOverrideStoreAsync(async ({ projectRoot }) => {
    withRun(projectRoot, 'run-1');
    mint({ projectRoot });
    const ran: string[] = [];
    const result = await runPipeline([
      gate('plan-guard', 10, () => { ran.push('plan-guard'); return deny('plan write refused', { denyId: 'scaffold-plan-gate' }); }),
      gate('later', 20, () => { ran.push('later'); return context('later ran'); }),
    ], ctxFor(projectRoot));

    assert.deepEqual(ran, ['plan-guard', 'later'], 'the pipeline continues instead of returning an allow');
    assert.notEqual(result.kind, 'deny');
    const merged = result.kind === 'context' ? result.context ?? '' : '';
    assert.match(merged, /OPERATOR OVERRIDE ACTIVE/);
    assert.match(merged, /scaffold-plan-gate/);
    assert.match(merged, /can no longer settle as verified or shipped/);
    assert.match(merged, /later ran/, 'the later gate\'s context survives');
  });
});

test('a later gate still denies through an override that names an earlier one', async () => {
  await withOverrideStoreAsync(async ({ projectRoot }) => {
    withRun(projectRoot, 'run-1');
    mint({ projectRoot });
    const result = await runPipeline([
      gate('plan-guard', 10, () => deny('plan write refused', { denyId: 'scaffold-plan-gate' })),
      gate('authoring-guard', 20, () => deny('authoring refused', { denyId: 'authoring-guard' })),
    ], ctxFor(projectRoot));
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') assert.match(result.reason, /^authoring refused/);
  });
});

test('a token for another gate, another run, or past its TTL leaves the deny standing', async () => {
  for (const [label, over] of [
    ['another gate', { target: 'other-gate' }],
    ['another run', { runId: 'run-9' }],
    ['expired', { ttlMs: 1_000, nowMs: Date.now() - 60_000 }],
  ] as const) {
    await withOverrideStoreAsync(async ({ projectRoot }) => {
      withRun(projectRoot, 'run-1');
      mint({ projectRoot, ...over });
      const result = await runPipeline(
        [gate('plan-guard', 10, () => deny('plan write refused', { denyId: 'scaffold-plan-gate' }))],
        ctxFor(projectRoot),
      );
      assert.equal(result.kind, 'deny', label);
    });
  }
});

test('an askUser prompt is never rewritten by the override path', async () => {
  await withOverrideStoreAsync(async ({ projectRoot }) => {
    withRun(projectRoot, 'run-1');
    const result = await runPipeline(
      [gate('approval', 10, () => askUser('Approve this?', 'waiting on the operator'))],
      ctxFor(projectRoot),
    );
    assert.equal(result.kind, 'deny');
    // The question rendered in the host's approve/reject modal, verbatim: no
    // correlation ref, and no override advice inviting a way around the person
    // being asked.
    if (result.kind === 'deny') assert.equal(result.reason, 'Approve this?');
  });
});

test('a crashed gate is never overridable, even with a token minted for it', async () => {
  await withOverrideStoreAsync(async ({ projectRoot }) => {
    withRun(projectRoot, 'run-1');
    mint({ projectRoot, target: 'boom' });
    const result = await runPipeline(
      [gate('boom', 10, () => { throw new Error('gate exploded'); })],
      ctxFor(projectRoot),
    );
    assert.equal(result.kind, 'deny');
    if (result.kind !== 'deny') return;
    assert.equal(result.denyId, 'pipeline-handler-crashed');
    assert.equal(result.reason.includes('--unblock'), false, 'and it is not advertised as overridable');
  });
});

async function withOverrideStoreAsync(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const saved = process.env.XDG_STATE_HOME;
  const base = tempDir('t1-override-');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  resetPluginUseCache();
  recordPluginUseChoice(projectRoot, true, 'test');
  try {
    await body({ projectRoot, machineDir: path.join(base, 'state', 'traffic-one') });
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    resetPluginUseCache();
  }
}
