// The one-mcp reporter's two published files against shared/fsjson.ts's fences.
//
// This module used to publish BOTH of them — the canonical committed
// `.one.json` and the derived, gitignored `one-mcp-report.json` — through a
// private `writeJson` built straight on `fs`, so neither got the consent fence,
// the symlink refusal or the containment check. The escape was constructed
// before it was fixed: with a directory symlink planted at
// `<project>/.traffic-one` on a CONSENTED project, `prepareReport` reported
// `started: true` while both files landed in the link's target, outside the
// project root, 56 and 740 bytes respectively — the second one carrying the
// whole collected mcpPayload.
//
// Every test below is the mutation proof for one edit. Reverting that edit
// alone turns exactly that test red; the quoted failure text is in each
// assertion message.
//
// ── FIXTURE SHAPE MATTERS, and the two files need DIFFERENT shapes ───────────
// A dangling symlink is the right refusal fixture only for a write-ONLY path.
// Both publishers here READ the destination first, and they answer a failed
// read differently, which was measured rather than assumed:
//
//   `.one.json`             a dangling link reads as ENOENT -> `absent`, which
//                           is a legal base, so the publisher proceeds. A
//                           dangling fixture would NOT be vacuous here.
//   `one-mcp-report.json`   a dangling link reads as `{}`/null, and BOTH
//                           readers bail on it before any write
//                           (backfillDebugPayload -> false, runReport ->
//                           'not-queued'). A dangling fixture there passes for
//                           a reason that has nothing to do with the fence.
//
// So the status-file tests use the move-aside-and-link shape with a guard
// asserting the read still resolves, and `.one.json` uses it too — one shape
// for both, and the one that cannot be vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../../../config/paths';
import { STATUS_FILE } from '../../../config/reporting';
import { writeProjectState } from '../lib';
import { prepareReport } from '../prepareReport';
import { runReport } from '../runReport';
import { backfillDebugPayload } from '../report-payload';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import { recordPluginUseChoice, resetPluginUseCache } from '../../../shared/state/plugin-use';
import { writeState } from '../../../shared/state/normalize';

const TMP_PREFIX = 't1-onemcp-fence-';
const REPORT_ID = '0197f0aa-2222-7abc-8def-0123456789ab';

interface Fixture {
  /** The project root. */
  readonly cwd: string;
  /** A directory OUTSIDE the project, for a planted link to point at. */
  readonly outside: string;
  readonly statePath: string;
  readonly statusPath: string;
}

/**
 * A project in its own temp tree, with its own HOME and XDG_STATE_HOME so the
 * recorded consent answer never touches the real machine dir. `outside` is a
 * sibling of the project, which is the whole point: a write that lands there
 * has left the project.
 */
function withProject(body: (fixture: Fixture) => void | Promise<void>, consent: boolean | null = true): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  const cwd = path.join(base, 'project');
  const outside = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"shop"}\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  process.env.HOME = path.join(base, 'home');
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  resetPluginUseCache();
  resetAuthoringRootCache();
  if (consent !== null) recordPluginUseChoice(cwd, consent, 'test');
  const restore = (): void => {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.XDG_STATE_HOME;
    resetPluginUseCache();
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  };
  const fixture: Fixture = {
    cwd,
    outside,
    statePath: path.join(cwd, STATE_FILE),
    statusPath: path.join(cwd, STATUS_FILE),
  };
  let result: void | Promise<void>;
  try {
    result = body(fixture);
  } catch (error) {
    restore();
    throw error;
  }
  return Promise.resolve(result).then(restore, (error) => { restore(); throw error; });
}

/**
 * Move `filePath` to `asidePath` and leave a symlink behind under the original
 * name — the refusal fixture for a publisher that READS before it writes.
 *
 * The guard is the whole reason this exists rather than a dangling link: it
 * asserts the read STILL RESOLVES, so a test that then observes "nothing was
 * written" is observing the fence and not the publisher declining to start.
 */
function moveAsideAndLink(filePath: string, asidePath: string): string {
  fs.renameSync(filePath, asidePath);
  fs.symlinkSync(asidePath, filePath);
  const throughTheLink = fs.readFileSync(filePath, 'utf8');
  assert.equal(throughTheLink, fs.readFileSync(asidePath, 'utf8'),
    'fixture guard: the publisher must still be able to READ the destination through the link, '
    + 'or "nothing was written" would prove nothing about the fence');
  assert.equal(fs.lstatSync(filePath).isSymbolicLink(), true, 'fixture guard: the original name is a link');
  return throughTheLink;
}

/** A populated, legible `.one.json`, so no test is measuring the illegible-base refusal. */
function seedState(statePath: string, extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const bytes = `${JSON.stringify({ version: 7, mode: 'existing-codebase', stack: 'default', ...extra }, null, 2)}\n`;
  fs.writeFileSync(statePath, bytes, 'utf8');
  return bytes;
}

function seedQueuedStatus(statusPath: string, reportId: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify({
    status: 'queued', reportId, queuedAt: '2026-01-01T00:00:00Z', attempts: 0, ...extra,
  }, null, 2)}\n`, 'utf8');
}

// ── .one.json ────────────────────────────────────────────────────────────────

test('writeProjectState refuses a planted DIRECTORY symlink at the state dir instead of publishing outside the project', () => withProject(({ cwd, outside }) => {
  // Writable baseline FIRST: without it a fence that refused everything, or a
  // fixture that broke the writer outright, would look identical to a pass.
  assert.equal(writeProjectState(cwd, { mode: 'existing-codebase' }), true,
    'baseline: an ordinary consented project must still publish');
  fs.rmSync(path.join(cwd, STATE_DIR), { recursive: true, force: true });

  fs.symlinkSync(outside, path.join(cwd, STATE_DIR));
  assert.equal(fs.readdirSync(outside).length, 0, 'fixture guard: the escape target starts empty');

  const persisted = writeProjectState(cwd, { mode: 'existing-codebase', secret: 'must-not-escape' });

  assert.equal(persisted, false,
    'a write that resolves outside the project state dir is refused, and says so');
  assert.deepEqual(fs.readdirSync(outside), [],
    'nothing landed in the link target: this is the measured escape (.one.json, 56 bytes) closed');
  assert.equal(fs.lstatSync(path.join(cwd, STATE_DIR)).isSymbolicLink(), true,
    'the planted link is left alone rather than reclaimed');
}));

test('writeProjectState refuses a final-component link at .one.json and leaves the moved-aside target byte-identical', () => withProject(({ cwd, outside, statePath }) => {
  const before = seedState(statePath, { 'one-uid': REPORT_ID });
  const aside = path.join(outside, 'victim.json');
  moveAsideAndLink(statePath, aside);

  const persisted = writeProjectState(cwd, { mode: 'existing-codebase', secret: 'must-not-escape' });

  assert.equal(persisted, false, 'a link AT the destination is refused, whatever it points at');
  assert.equal(fs.readFileSync(aside, 'utf8'), before,
    'the link target is byte-identical — which it also was under the raw writer, because rename '
    + 'replaces the link; the fence adds that the LINK itself survives too');
  assert.equal(fs.lstatSync(statePath).isSymbolicLink(), true,
    'the raw writer turned this path into a regular file; the fenced one does not touch it');
}));

test('writeProjectState refuses on a consent-PENDING project, at the writer rather than at its caller', () => withProject(({ cwd, statePath }) => {
  const saved = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  resetPluginUseCache();
  try {
    // Called DIRECTLY, which is the point: prepareReport's pluginUseEnabled
    // check one frame up is what covered this before, so the only way to see
    // whether the writer itself is fenced is to be the second caller.
    const persisted = writeProjectState(cwd, { mode: 'existing-codebase' });

    assert.equal(persisted, false,
      'a project whose use-plugin question is unanswered must stay byte-identical, and the '
      + 'writer must enforce that itself rather than inherit it from one particular caller');
    assert.equal(fs.existsSync(statePath), false, 'no .one.json was created');
    assert.equal(fs.existsSync(path.join(cwd, STATE_DIR)), false, 'and no state dir either');
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = saved;
    resetPluginUseCache();
  }
}, null));

test('a new .one.json gets the same mode the canonical writeState gives it', () => withProject(({ cwd, statePath }) => {
  assert.equal(writeProjectState(cwd, { mode: 'existing-codebase' }), true, 'baseline: it published');
  const minted = fs.statSync(statePath).mode & 0o777;
  fs.rmSync(path.join(cwd, STATE_DIR), { recursive: true, force: true });
  assert.equal(writeState(cwd, { mode: 'existing-codebase' }), true, 'baseline: writeState published');
  const canonical = fs.statSync(statePath).mode & 0o777;

  assert.equal(minted.toString(8), canonical.toString(8),
    'the lifted recipe created this shared, COMMITTED file 0600 while its normal creator used the '
    + 'default; comparing the two writers rather than a literal keeps this umask-independent');
}));

// ── one-mcp-report.json ──────────────────────────────────────────────────────

test('runReport keeps the status file inside the project: a planted link at one-mcp-report.json is refused and the POST still succeeds', () => withProject(async ({ cwd, outside, statePath, statusPath }) => {
  seedState(statePath, { 'one-uid': REPORT_ID });
  seedQueuedStatus(statusPath, REPORT_ID);
  const aside = path.join(outside, 'status-aside.json');
  const before = moveAsideAndLink(statusPath, aside);

  const result = await runReport(cwd, { featureEnabled: true, transport: async () => 'ok' });

  assert.deepEqual(result, { ok: true, reportId: REPORT_ID, statusUnpersisted: true },
    'the POST is the product, so `ok` stays true — and the refusal is ROUTED into its own field '
    + 'rather than dropped, because an unqualified success over a status file that recorded '
    + 'nothing is a certification with no artifact behind it');
  assert.equal(fs.readFileSync(aside, 'utf8'), before,
    'the 740-byte payload the raw writer published through this link — pending, then ok — never leaves the project');
  assert.equal(fs.lstatSync(statusPath).isSymbolicLink(), true,
    'and the planted link is still a link rather than a regular file the writer replaced it with');
}));

// The test above plants a link AT the status path, which the symlink half of
// the fence refuses. Containment is a DIFFERENT rule and only an INTERMEDIATE
// link exercises it — no open flag refuses those. This is also the one shape
// where the detached worker escapes on its own: prepareReport is stopped by
// `.one.json`'s refusal one step earlier, but runReport reads the registered id
// straight through the planted link and would carry on writing beyond it.
test('runReport under a planted state-dir link publishes nothing outside the project', () => withProject(async ({ cwd, outside }) => {
  fs.writeFileSync(path.join(outside, '.one.json'), `${JSON.stringify({ mode: 'existing-codebase', 'one-uid': REPORT_ID })}\n`, 'utf8');
  const escapedStatus = path.join(outside, 'one-mcp-report.json');
  seedQueuedStatus(escapedStatus, REPORT_ID);
  const before = fs.readFileSync(escapedStatus, 'utf8');
  fs.symlinkSync(outside, path.join(cwd, STATE_DIR));
  // Fixture guard: reads are never fenced anywhere in this codebase, so the
  // worker must still resolve its id and its queued status through the link —
  // otherwise it would skip before reaching the write and prove nothing.
  assert.equal(fs.existsSync(path.join(cwd, STATE_FILE)), true,
    'fixture guard: the registered id is readable through the planted link');

  const result = await runReport(cwd, { featureEnabled: true, transport: async () => 'ok' });

  assert.equal(result.ok, true, 'the worker got as far as a successful POST, so it did reach the status writes');
  assert.equal(result.statusUnpersisted, true, 'and it says the status file does not describe this run');
  assert.equal(fs.readFileSync(escapedStatus, 'utf8'), before,
    'the pending/ok status updates were refused: an intermediate link is what the containment '
    + 'rule exists for, and it is the shape that landed 740 bytes of mcpPayload outside the project');
  assert.deepEqual(fs.readdirSync(outside).sort(), ['.one.json', 'one-mcp-report.json'],
    'and nothing new was created in the link target either');
}));

test('backfillDebugPayload reports the refusal instead of claiming a payload it did not write', () => withProject(({ cwd, outside, statePath, statusPath }) => {
  seedState(statePath, { 'one-uid': REPORT_ID });
  seedQueuedStatus(statusPath, REPORT_ID);
  // Writable baseline first: the same call on an unplanted path must backfill,
  // so a `false` below cannot be the reader bailing on its own precondition.
  assert.equal(backfillDebugPayload(cwd, REPORT_ID, {}), true, 'baseline: an ordinary status file is backfilled');

  seedQueuedStatus(statusPath, REPORT_ID);
  const aside = path.join(outside, 'status-aside.json');
  const before = moveAsideAndLink(statusPath, aside);

  const backfilled = backfillDebugPayload(cwd, REPORT_ID, {});

  assert.equal(backfilled, false,
    'the return value is the claim "I backfilled"; a discarded refusal made prepareReport report '
    + 'debugPayloadSaved: true for a file that was never written');
  assert.equal(fs.readFileSync(aside, 'utf8'), before, 'and nothing was written through the link');
}));

test('prepareReport does not authorize a spawn when the queued status write is refused', () => withProject(({ cwd, outside, statePath, statusPath }) => {
  seedState(statePath);
  // The status file must EXIST for the move-aside shape, and must not already
  // be queued for the id prepareReport is about to mint — a stale id keeps the
  // shouldAttempt gate out of the way without pre-empting the write.
  seedQueuedStatus(statusPath, 'stale-id-from-a-previous-report');
  const aside = path.join(outside, 'status-aside.json');
  const before = moveAsideAndLink(statusPath, aside);

  const result = prepareReport(cwd, { featureEnabled: true, spawn: false });

  assert.equal(result.started, false,
    'a refused queue write cannot carry the spawn authorization: with saving on, the worker '
    + 'requires a queued status for THIS id and could only skip');
  assert.equal(result.reason, 'status-write-refused', 'and the refusal is named, not silently dropped');
  assert.equal(fs.readFileSync(aside, 'utf8'), before, 'the link target is untouched');
  assert.notEqual(result.reportId, undefined, 'the id was still minted and persisted — only the queue was refused');
}));
