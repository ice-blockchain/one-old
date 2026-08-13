// PROPERTY 5 OF THE RECOVERY_RUNNERS ADMISSION RULE, ENFORCED BY ENUMERATION.
//
//   A row may not move a pointer that a gate uses as a key to state it is
//   holding, unless it carries that state forward.
//
// Properties 3 and 4 are about what the row WRITES, and `reset` satisfies both
// honestly. This one is about what it DISCARDS, and it is the one that was
// missing: measured on a project driven to terminal `failed` through the
// OpenCode maintenance path, a deny-repeat ladder standing at 5 — two past the
// threshold that produces the "stop retrying and report BLOCKED"
// instruction — read 1 on the successor. Every gate obligation is keyed by run
// id, so the pointer move did not reset that state, it made it unreachable.
//
// A prose rule would be satisfied by the next author BELIEVING they satisfied
// it. So the enforcement here is an ENUMERATION: the first test walks the
// source for every run-scoped path any module builds and fails on any entry
// name that obligations.ts has not classified; the second drives a fixture RUN
// DIRECTORY and fails on anything that reaches disk without a row. The
// behaviour tests below then pin the classification's actual effect — and they
// do it through the PRODUCT's own readers, never through file existence, which
// is how a previous round measured a "400-call tally preserved" against a file
// shape `activity.ts` has never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  RUN_OBLIGATIONS,
  WIDEN_AT,
  carryRunObligations,
  obligationFor,
  undeclaredRunEntries,
} from '../obligations';
import { resetPluginUseCache } from '../../../shared/state/plugin-use';
import { sweepTrafficOneRetention } from '../../../shared/retention';
import { RESETS_FILE, readResetRecord, recordReset } from '../resets';
import {
  agentActivityCapDenied,
  bumpRunAgentActivity,
  markAgentActivityCapDenied,
  readRunAgentActivity,
} from '../../../shared/state/run-agent/activity';
import { DENY_REPEAT_ESCALATE_AT, recordDenyRepeat } from '../../../shared/state/deny-repeat';
import { recordScanBoundHit } from '../../../modules/plan-guard/plan-readiness/context';
import { boundedScanTruncated } from '../../../modules/plan-guard/plan-readiness/context';
import {
  clearExhaustedModels,
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  modelIsExhausted,
  recordExhaustedModel,
} from '../../../modules/agent-model/exhausted-models';
import {
  liveRunAgent,
  recordRunAgent,
  verdictAgentConflict,
} from '../../../shared/state/run-agent/registry';
import {
  listCursorSpawnObservations,
  recordCursorSpawnObservation,
} from '../../../shared/state/run-agent/cursor-observations';
import {
  markModelChoicePrompted,
  modelChoicePrompted,
  readModelChoice,
  writeModelChoice,
} from '../../../modules/agent-model/model-choice';
import {
  modelChoiceReplySweep,
  recordPendingModelChoiceReply,
} from '../../../modules/agent-model/choice-reply';
import type { Ctx } from '../../../core/types';
import { resetRun } from '../reset';
import { ensureRunLedger, transitionRunStatus } from '../../../shared/state';

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(abs, found);
    } else if (entry.name.endsWith('.ts')) {
      found.push(abs);
    }
  }
  return found;
}

// The spellings this codebase actually uses to name something under
// `runs/<id>/`, read off the source rather than assumed:
//
//   path.join(runDir(cwd, runId), 'entry')                     — the helper
//   path.join(cwd, '.traffic-one', 'runs', runId, 'entry')     — hand-spelled
//   path.join(cwd, T1_DIR, 'runs', runId, 'entry')             — dir constant
//   path.join(root, MEMORY_DIR, 'runs', runId, 'entry')        — another one
//   path.join(cwd, RUNS_REL_DIR, safeSegment(runId), 'entry')  — joined constant
//
// Hence the second pattern anchors on `'runs'` alone rather than on the
// `.traffic-one` before it: that segment is a literal in some modules and a
// constant (T1_DIR, MEMORY_DIR) in others, and anchoring on the literal missed
// eight real entries — measured, before this was widened.
//
// Only the LEADING segment is taken: `debug/deny-repeats.json` is classified as
// `debug`, because the reset carries or drops at the top level.
// The run-id segment is matched as "an expression containing no quote and no
// newline", which is what keeps a THREE-segment path from being read as a
// four-segment one. `shared/once.ts` builds `runs/.once` — a project-level
// marker dir beside the runs, not a run — and a looser middle group ran past
// its closing paren to the next quoted string in the file, inventing entries
// named `_` and `FAIL` out of an unrelated regex two functions later.
const RUN_ID_EXPR = String.raw`[^,'"\n]+`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const LITERAL_PATTERNS: readonly RegExp[] = [
  /runDir\([^)\n]*\)\s*,\s*'([^']+)'/g,
  new RegExp(String.raw`'runs'\s*,\s*${RUN_ID_EXPR},\s*'([^']+)'`, 'g'),
  new RegExp(String.raw`RUNS_REL_DIR\s*,\s*${RUN_ID_EXPR},\s*'([^']+)'`, 'g'),
];

// THE CONSTANT AND TEMPLATE CLASSES, which this scanner used to be blind to and
// documented itself as blind to. Four rows were uncorroborated for that reason:
// `model-policy.json`, `codex-model-observations.json` and
// `delegated-model-observations.json` arrive as `const STORE_FILE = …`, and the
// `.lock` siblings are built as `` `${filePath}.lock` `` over a path a builder
// returned. The second class is the one that mattered: THREE run-scoped entries
// fall in it and a hand sweep had found one, so the set the first test claims to
// close was incomplete — not as a laundering vector (a lock is never a bound),
// but "completeness of a set" is the property, and a bound could have been
// sitting there instead.
//
// Measured after teaching it both classes: 50 of the 50 rows are corroborated
// by a real writer, up from 44 of 48. That number is exactly the withholding
// guarantee — a row deleted from the table leaves its entry still found by the
// scan, so every one of the 50 is caught, where four used to be invisible and
// could have been withheld silently.
//
// Both are resolved mechanically rather than by widening the literal patterns
// into a heuristic:
//   CONSTANTS  a file-local `const NAME = '<literal>'` map, consulted when a
//              run-scoped path's final segment is an identifier.
//   LOCKS      a builder map (`function f(…): string { return path.join(… runs
//              …, ENTRY) }`) plus, per file, the identifier a `${…}.lock`
//              template interpolates and the builder that identifier was
//              assigned from. Nothing is guessed: a template over a variable
//              this pass cannot trace to a run-scoped builder contributes
//              nothing.
const CONST_DECL = new RegExp(String.raw`const\s+(${IDENT})\s*=\s*'([^'\n]+)'`, 'g');
const IDENT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`runDir\([^)\n]*\)\s*,\s*(${IDENT})\s*\)`, 'g'),
  new RegExp(String.raw`'runs'\s*,\s*${RUN_ID_EXPR},\s*(${IDENT})\s*\)`, 'g'),
  new RegExp(String.raw`RUNS_REL_DIR\s*,\s*${RUN_ID_EXPR},\s*(${IDENT})\s*\)`, 'g'),
];
const BUILDER_DEF = new RegExp(
  String.raw`function\s+(${IDENT})\s*\([^)]*\)\s*:\s*string\s*\{[^}]*?return\s+path\.join\(([\s\S]*?)\);`,
  'g',
);
const LOCK_TEMPLATE = new RegExp(String.raw`\`\$\{(${IDENT})\}\.lock\``, 'g');
const BUILDER_ASSIGN = new RegExp(String.raw`const\s+(${IDENT})\s*=\s*(${IDENT})\(`, 'g');

// THE QUARANTINE CLASS, the third one and the last one both halves of the
// enforcement were blind to: `` `${<a run-scoped path>}${<A_SUFFIX>}` ``, where
// the suffix is a file-local constant. Two entries live here — `agents.json
// .corrupt` (registry.ts, before the only whole-registry republisher heals over
// bytes nobody can parse) and `run.json.corrupt` (run-settlement/projection.ts,
// same convention) — and they are not templates in the harmless sense the lock
// siblings are: the product writes them, and it writes them in exactly the
// corrupt-state incident a reset exists to recover from. Driven through the real
// healers, both reached disk and `undeclaredRunEntries` reported them as
// unclassified, so the table's completeness claim was 50 rows against 52 written
// entries.
//
// Resolving the base identifier needs one tracer the lock class did not: a
// run-scoped path can arrive either from a BUILDER (`const registryFile =
// agentRegistryFile(cwd, runId)`, already traced above) or from a `path.join`
// over a run directory held in a local (`const dir = runDir(…); const file =
// path.join(dir, 'run.json')`). Both are mechanical; a base this pass cannot
// trace to a run-scoped path contributes nothing, which is why the `.one.json`
// quarantine in state/normalize.ts — the same template shape over a
// project-scoped path — is correctly not collected here.
const RUN_DIR_ASSIGN = new RegExp(String.raw`const\s+(${IDENT})\s*=\s*runDir\(`, 'g');
const PATH_JOIN_ASSIGN = new RegExp(String.raw`const\s+(${IDENT})\s*=\s*path\.join\(([^)\n]*)\)`, 'g');
const SUFFIX_TEMPLATE = new RegExp(String.raw`\`\$\{(${IDENT})\}\$\{(${IDENT})\}\``, 'g');

/** Locals holding a path to a run-scoped ENTRY, by the two spellings that
 *  produce one without going through a named builder. */
function runScopedLocals(text: string): Map<string, string> {
  const constants = fileConstants(text);
  const runDirs = new Set<string>();
  RUN_DIR_ASSIGN.lastIndex = 0;
  let dir = RUN_DIR_ASSIGN.exec(text);
  while (dir !== null) {
    runDirs.add(dir[1] as string);
    dir = RUN_DIR_ASSIGN.exec(text);
  }
  const out = new Map<string, string>();
  PATH_JOIN_ASSIGN.lastIndex = 0;
  let join = PATH_JOIN_ASSIGN.exec(text);
  while (join !== null) {
    const parts = (join[2] ?? '').split(',').map((part) => part.trim());
    const head = parts[0] ?? '';
    const last = parts.at(-1) ?? '';
    const entry = last.startsWith("'") ? last.slice(1, -1) : (constants.get(last) ?? '');
    if (entry && (head.startsWith('runDir(') || runDirs.has(head))) {
      out.set(join[1] as string, entry.split('/')[0] as string);
    }
    join = PATH_JOIN_ASSIGN.exec(text);
  }
  return out;
}

function fileConstants(text: string): Map<string, string> {
  const out = new Map<string, string>();
  CONST_DECL.lastIndex = 0;
  let match = CONST_DECL.exec(text);
  while (match !== null) {
    out.set(match[1] as string, match[2] as string);
    match = CONST_DECL.exec(text);
  }
  return out;
}

/** `builder name -> the run-scoped entry it returns a path to`, per file and
 *  then globally. Per file FIRST, and that is not tidiness: `storePath` is
 *  defined in both codex-model-observation.ts and
 *  delegated-model-observation.ts, so a single global map resolves one file's
 *  lock template to the other file's entry — measured, it named
 *  `delegated-model-observations.json.lock`, an entry nothing builds. The global
 *  map is still needed as the fallback, because one real case crosses files:
 *  `model-policy.json.lock`'s template is in run-model-policy.ts and its
 *  builder in run-model-policy-schema.ts. */
function buildersIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const constants = fileConstants(text);
  BUILDER_DEF.lastIndex = 0;
  let match = BUILDER_DEF.exec(text);
  while (match !== null) {
    const args = (match[2] ?? '').replace(/\s+/g, ' ');
    const runScoped = args.includes("'runs'") || args.includes('RUNS_REL_DIR') || args.includes('runDir(');
    const last = args.split(',').map((part) => part.trim()).pop() ?? '';
    const entry = last.startsWith("'") ? last.slice(1, -1) : (constants.get(last) ?? '');
    if (runScoped && entry) out.set(match[1] as string, entry.split('/')[0] as string);
    match = BUILDER_DEF.exec(text);
  }
  return out;
}

function runScopedBuilders(files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    for (const [name, entry] of buildersIn(fs.readFileSync(file, 'utf8'))) out.set(name, entry);
  }
  return out;
}

function declaredEntryNames(): Map<string, string[]> {
  const files = sourceFiles(SRC_ROOT);
  const builders = runScopedBuilders(files);
  const byEntry = new Map<string, string[]>();
  const add = (entry: string, file: string): void => {
    const leading = entry.split('/')[0] as string;
    if (!leading || leading.includes('$') || leading.includes('*')) return;
    const where = byEntry.get(leading) ?? [];
    where.push(path.relative(SRC_ROOT, file));
    byEntry.set(leading, where);
  };
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const constants = fileConstants(text);
    for (const pattern of LITERAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        add(match[1] as string, file);
        match = pattern.exec(text);
      }
    }
    for (const pattern of IDENT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        const resolved = constants.get(match[1] as string);
        if (resolved) add(resolved, file);
        match = pattern.exec(text);
      }
    }
    // The lock-template class: `${<ident>}.lock` where <ident> was assigned
    // from a run-scoped path builder.
    const assigned = new Map<string, string>();
    BUILDER_ASSIGN.lastIndex = 0;
    let assign = BUILDER_ASSIGN.exec(text);
    while (assign !== null) {
      assigned.set(assign[1] as string, assign[2] as string);
      assign = BUILDER_ASSIGN.exec(text);
    }
    const local = buildersIn(text);
    LOCK_TEMPLATE.lastIndex = 0;
    let lock = LOCK_TEMPLATE.exec(text);
    while (lock !== null) {
      const builder = assigned.get(lock[1] as string) ?? '';
      const entry = local.get(builder) ?? builders.get(builder);
      if (entry) add(`${entry}.lock`, file);
      lock = LOCK_TEMPLATE.exec(text);
    }
    // The quarantine class: `${<run-scoped path>}${<SUFFIX const>}`, where the
    // base is either a traced builder call or a local `path.join` over a run
    // directory, and the suffix resolves to a literal in this same file.
    const locals = runScopedLocals(text);
    SUFFIX_TEMPLATE.lastIndex = 0;
    let suffixed = SUFFIX_TEMPLATE.exec(text);
    while (suffixed !== null) {
      const base = suffixed[1] as string;
      const builder = assigned.get(base) ?? '';
      const entry = locals.get(base) ?? local.get(builder) ?? builders.get(builder);
      const suffix = constants.get(suffixed[2] as string) ?? '';
      if (entry && suffix) add(`${entry}${suffix}`, file);
      suffixed = SUFFIX_TEMPLATE.exec(text);
    }
  }
  // obligations.ts names every entry in its own table; it is the classifier,
  // not a writer, so it cannot corroborate itself.
  for (const [entry, list] of byEntry) {
    const others = list.filter((f) => !f.endsWith(path.join('traffic-one-reset', 'obligations.ts')));
    if (others.length === 0) byEntry.delete(entry); else byEntry.set(entry, others);
  }
  return byEntry;
}

test('every run-scoped entry is classified: a new gate obligation cannot arrive unclassified', () => {
  const found = declaredEntryNames();
  assert.ok(found.size >= 40,
    `fixture guard: the scanner must still find run-scoped paths (found ${found.size}, expected >= 40). `
    + 'A sharp DROP here means the path-building spellings moved and the patterns above went blind, '
    + 'which would make this test pass by finding nothing.');

  const unclassified: string[] = [];
  for (const [entry, files] of found) {
    if (!obligationFor(entry)) unclassified.push(`  ${entry}  (written by ${files[0]})`);
  }

  assert.deepEqual(unclassified, [], [
    '',
    'These entries live under runs/<id>/ and obligations.ts has not classified them:',
    ...unclassified,
    '',
    'PROPERTY 5 of the RECOVERY_RUNNERS admission rule:',
    '  a row may not move a pointer that a gate uses as a key to state it is',
    '  holding, unless it carries that state forward.',
    '',
    '`reset` moves currentRunId. Anything keyed by it becomes UNREACHABLE, and the',
    'successor starts with a clean copy — so if what you added BOUNDS AN AGENT (it',
    'exists to stop a loop or spend a budget), leaving it unclassified hands every',
    'agent a way to launder it: reach terminal `failed`, which an OpenCode',
    'delegation can do on its own, then ask for the recovery.',
    '',
    'Add a row to RUN_OBLIGATIONS with one of:',
    '  bound-carried  a bound whose carry cannot deny the successor anything the',
    '                 retired run was not already denied. Wire it into',
    '                 carryRunObligations.',
    '  bound-dropped  it bounds something, but carrying it WEDGES the successor.',
    '                 Read the four admission rules in that file first: a wedge,',
    '                 not an inconvenience; split before you drop; name every',
    '                 axis; and "gone" means gone (this transaction releases',
    '                 CLAIMS, it terminates no process).',
    '  evidence       it describes work that was done, and belongs to the run',
    '                 that did it.',
    '',
  ].join('\n'));
});

// The three entries the hand sweep did not find, now found mechanically. Pinned
// on their own so a regression in the constant/template resolution shows up as
// "the scanner went blind again" rather than as a silently smaller set.
test('the scanner sees the constant and lock-template classes it used to be blind to', () => {
  const found = declaredEntryNames();
  for (const entry of [
    'model-policy.json',
    'codex-model-observations.json',
    'delegated-model-observations.json',
    'exhausted-models.json.lock',
    'codex-model-observations.json.lock',
    'model-policy.json.lock',
    'agents.json.corrupt',
    'run.json.corrupt',
  ]) {
    assert.ok(found.has(entry),
      `${entry} must be corroborated by a real writer, not by a hand sweep — `
      + 'the constant/template resolution above is what finds it');
  }

  // AND THE SET BOTH WAYS. The test above proves nothing on disk is missing from
  // the table; this proves nothing in the table is missing from `src/**` — a row
  // no writer produces is a row describing an entry that no longer exists, which
  // rots into a reason nobody can check. Four rows used to sit here and were
  // reported as "real, not stale" on a hand sweep; they are now mechanical.
  const uncorroborated = RUN_OBLIGATIONS.map((row) => row.entry).filter((entry) => !found.has(entry));
  assert.deepEqual(uncorroborated, [],
    'every row must be corroborated by a real writer in src/**; a row with no writer is either stale '
    + 'or the scanner went blind to how its path is spelled');
});

test('the classification table is well-formed and every row is justified', () => {
  const seen = new Set<string>();
  for (const row of RUN_OBLIGATIONS) {
    assert.ok(!seen.has(row.entry), `duplicate row for ${row.entry}`);
    seen.add(row.entry);
    assert.ok(row.why.length > 40,
      `${row.entry}: 'why' is the claim a reviewer checks, so it must actually make one`);
  }
  // The point of the exercise: at least one bound is genuinely carried. A table
  // that classified everything as evidence or as dropped would pass the scan
  // above while conserving nothing.
  const carried = RUN_OBLIGATIONS.filter((row) => row.kind === 'bound-carried');
  assert.ok(carried.length >= 3,
    'if nothing is carried, property 5 is satisfied only vacuously');
  // Every widening note belongs to a row that is already carried in part: the
  // widening is an extra key on a carried row, never a whole row that the
  // classification calls dropped and the code carries anyway.
  for (const row of RUN_OBLIGATIONS.filter((r) => r.widened)) {
    assert.equal(row.kind, 'bound-carried',
      `${row.entry}: a widened row must be classified as carried, or the table and the code disagree`);
  }
});

// ── the behaviour, so the table cannot drift from what the runner does ──────

// A CONSENTING project, and that is not fixture boilerplate: the carry writes
// through the same guarded primitives every other state writer uses, so without
// a recorded use-plugin answer fsjson's consent fence refuses every carry and
// this file would pass while measuring nothing. `carryRunObligations` reporting
// them as `failed` is the fence working.
function fixture(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-obligations-')));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({
    pluginUse: { enabled: true, source: 'test', decidedAt: new Date().toISOString() },
  }), 'utf8');
  resetPluginUseCache();
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', 'OLD', 'debug'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', onboardingComplete: true, confirmed: true,
  }), 'utf8');
  return dir;
}

function discard(dir: string): void {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  resetPluginUseCache();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('carrying bounds forward closes the laundering path, measured through the readers', () => {
  const dir = fixture();

  // EVERY fixture below is written by the PRODUCT's own writer. A hand-rolled
  // JSON blob is how the previous round measured nothing: `agent-activity/
  // senior-frontend` holding `{"child-A":400}` is a file `activity.ts` never
  // writes and `readRunAgentActivity` never reads, so "the 400-call tally
  // survived" was an assertion about a file the cap cannot see.
  assert.equal(recordDenyRepeat(dir, 'OLD', 'materialization-not-converged|src/app.ts'), 1);
  for (let i = 1; i < 5; i += 1) recordDenyRepeat(dir, 'OLD', 'materialization-not-converged|src/app.ts');
  for (let i = 0; i < 120; i += 1) bumpRunAgentActivity(dir, 'OLD', 'senior-frontend', 'child-A');
  assert.ok(markAgentActivityCapDenied(dir, 'OLD', 'senior-frontend'));
  recordScanBoundHit(dir, 'OLD', 'structure-walk-file-cap');
  recordExhaustedModel(dir, 'OLD', 'senior-frontend', 'gpt-5.6-terra-medium');
  markModelChoicePrompted(dir, 'OLD');
  recordRunAgent(dir, 'OLD', 'senior-frontend', { agentId: 'agent-frontend-1', parentSessionId: 'parent-A' });

  // Fixture guards, through the same readers the assertions use.
  assert.equal(readRunAgentActivity(dir, 'OLD', 'senior-frontend').bySession['child-A'], 120,
    'fixture guard: the retired child is 20 over the exploration cap of 100');
  assert.equal(boundedScanTruncated(dir, 'OLD'), true, 'fixture guard: the evidence floor is raised');

  // Evidence, which must NOT follow.
  fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', 'OLD', 'architecture-v1.json'),
    JSON.stringify({ compiled: true }), 'utf8');

  const outcome = carryRunObligations(dir, 'OLD', 'NEW');
  assert.deepEqual(outcome.failed, [], 'every declared carry must land');
  assert.deepEqual(outcome.widened, [], 'a first reset widens nothing');

  assert.equal(recordDenyRepeat(dir, 'NEW', 'materialization-not-converged|src/app.ts'), 6,
    'the escalated ladder must survive the pointer move — the next draw is the 6th, not the 1st');
  assert.equal(readRunAgentActivity(dir, 'NEW', 'senior-frontend').bySession['child-A'], 120,
    'the over-cap child stays over cap, read through the cap\'s own reader');
  assert.equal(agentActivityCapDenied(dir, 'NEW', 'senior-frontend'), true,
    'the spent one-shot deny carries WITH the tally, or the successor gets a free extra deny');
  assert.equal(boundedScanTruncated(dir, 'NEW'), true, 'the raised evidence floor stays raised');
  assert.equal(modelIsExhausted(dir, 'NEW', 'senior-frontend', 'gpt-5.6-terra-medium'), true,
    'the TTL condemnation carries: the rate-limited model is NOT admissible again for the same role');
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'senior-frontend'), false,
    'and the non-expiring terminal marker does not, at a first reset');
  assert.equal(modelChoicePrompted(dir, 'NEW'), true,
    'the build pause waiting on a user reply is still pending');
  assert.equal(verdictAgentConflict(dir, 'NEW', 'senior-reviewer', 'agent-frontend-1')?.role, 'senior-frontend',
    'the verifier-independence record carries: a reviewer may not continue the frontend id');

  // Evidence stays with the run that produced it.
  assert.ok(!fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'NEW', 'architecture-v1.json')));
  assert.ok(!fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'NEW', 'run.json')));

  // And the retired run keeps everything: nothing is moved, only copied.
  assert.equal(readRunAgentActivity(dir, 'OLD', 'senior-frontend').total, 120);
  assert.equal(boundedScanTruncated(dir, 'OLD'), true);

  discard(dir);
});

test('the ladder carry is a MAX merge, so a successor count is never lowered', () => {
  const dir = fixture();
  const runs = path.join(dir, '.traffic-one', 'runs');
  fs.writeFileSync(path.join(runs, 'OLD', 'debug', 'deny-repeats.json'),
    JSON.stringify({ shared: 2, 'only-old': 7 }), 'utf8');
  fs.mkdirSync(path.join(runs, 'NEW', 'debug'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'NEW', 'debug', 'deny-repeats.json'),
    JSON.stringify({ shared: 9, 'only-new': 3 }), 'utf8');

  carryRunObligations(dir, 'OLD', 'NEW');

  const merged = JSON.parse(fs.readFileSync(path.join(runs, 'NEW', 'debug', 'deny-repeats.json'), 'utf8'));
  assert.equal(merged.shared, 9, 'the ladder is monotone: the higher count wins, never the retired one');
  assert.equal(merged['only-old'], 7, 'a signature only the retired run saw still carries');
  assert.equal(merged['only-new'], 3, 'a signature the successor already saw is untouched');

  discard(dir);
});

// THE MERGE RULE THAT WAS LOSING. The carry runs after the pointer move, so a
// still-live child's next tool call can land in the successor first — the exact
// window carryDenyRepeats documents. Copy-if-absent then dropped the retired
// 120-call tally whole and refunded the exploration cap.
test('a tally the successor has already started is SUMMED with the retired one, never replaced', () => {
  const dir = fixture();
  for (let i = 0; i < 120; i += 1) bumpRunAgentActivity(dir, 'OLD', 'senior-frontend', 'child-A');
  bumpRunAgentActivity(dir, 'NEW', 'senior-frontend', 'child-LIVE');

  carryRunObligations(dir, 'OLD', 'NEW');

  const after = readRunAgentActivity(dir, 'NEW', 'senior-frontend');
  assert.equal(after.bySession['child-A'], 120, 'the over-cap child arrives in the successor');
  assert.equal(after.bySession['child-LIVE'], 1, 'and the live child keeps its own count');
  assert.equal(after.total, 121, 'both, because every line in either log is a distinct tool call');

  discard(dir);
});

/**
 * THE OTHER HALF OF THE LADDER'S DISCIPLINE: the carry publishes FLOORS and
 * re-reads, so a deny that republishes a stale base right after our write does
 * not undo the carry.
 *
 * `countDenyRepeat` is an unlocked read-increment-write against a file with no
 * lease, so the successor's very next deny can be holding a base read before the
 * carry landed. Publishing once would then leave the ladder at that deny's own
 * count and the retired run's escalation gone — the laundering this row exists
 * to close, arriving one millisecond after it was closed.
 *
 * The clobber is injected at the carry's own publishing rename rather than
 * raced: what lands is exactly what an unlocked incrementer with a pre-carry
 * base publishes, and it lands in the window that makes it a lost update.
 */
test('a deny republishing a stale base right after the ladder carry does not undo it', () => {
  const dir = fixture();
  const signature = 'materialization-not-converged|src/app.ts';
  for (let draw = 0; draw < 5; draw += 1) recordDenyRepeat(dir, 'OLD', signature);

  const target = path.join('NEW', 'debug', 'deny-repeats.json');
  const mutableFs = createRequire(__filename)('fs') as { renameSync: typeof fs.renameSync };
  const realRename = mutableFs.renameSync;
  let clobbered = 0;
  mutableFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to);
    if (clobbered === 0 && String(to).endsWith(target)) {
      clobbered += 1;
      // A concurrent deny whose base predates the carry: it saw nothing, counted
      // its own draw, and published `1` over five.
      fs.writeFileSync(String(to), JSON.stringify({ [signature]: 1 }), 'utf8');
    }
  }) as typeof fs.renameSync;

  try {
    carryRunObligations(dir, 'OLD', 'NEW');
  } finally {
    mutableFs.renameSync = realRename;
  }

  assert.equal(clobbered, 1, 'fixture guard: the carry published once and the stale base landed on top of it');
  assert.equal(recordDenyRepeat(dir, 'NEW', signature), 6,
    'the floor is raised again on the next pass, so the successor continues the retired ladder. '
    + 'Publishing once and trusting it reads 2 here — the escalation refunded by one unlucky deny');

  discard(dir);
});

/**
 * THE WRITER DISCIPLINE, not the merge rule. The test above proves the retired
 * tally is not DROPPED; this one proves the successor's own tally is not
 * OVERWRITTEN, which is a different failure with a different cause.
 *
 * `bumpRunAgentActivity` appends one line on an `O_APPEND` fd and takes no lock.
 * The carry used to read the successor's log, concatenate and write the whole
 * file back, so every line a live child appended between those two halves was
 * destroyed — measured against a continuous appender at 2 lines of ~200,000 in a
 * 7ms window, always in the direction that refunds a cap.
 *
 * REPRODUCED DETERMINISTICALLY rather than by racing: the injection below runs
 * one REAL `bumpRunAgentActivity` at the instant the carry opens the successor's
 * log for writing, which is inside the old shape's read-then-write window and
 * inside nothing at all in the new one. The interception point is the same
 * syscall in both shapes, so the two arms differ only in the discipline.
 */
test('a line a live child appends DURING the carry survives it', () => {
  const dir = fixture();
  for (let i = 0; i < 120; i += 1) bumpRunAgentActivity(dir, 'OLD', 'senior-frontend', 'child-A');
  bumpRunAgentActivity(dir, 'NEW', 'senior-frontend', 'child-LIVE');

  const target = path.join('NEW', 'agent-activity', 'senior-frontend.log');
  const mutableFs = createRequire(__filename)('fs') as { openSync: typeof fs.openSync };
  const realOpen = mutableFs.openSync;
  let injected = 0;
  let injecting = false;
  mutableFs.openSync = ((file: fs.PathLike, flags?: unknown, mode?: unknown) => {
    const forWrite = typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0;
    if (!injecting && forWrite && String(file).endsWith(target)) {
      injecting = true;
      try {
        bumpRunAgentActivity(dir, 'NEW', 'senior-frontend', 'child-LIVE');
        injected += 1;
      } finally {
        injecting = false;
      }
    }
    return (realOpen as (f: fs.PathLike, g?: unknown, m?: unknown) => number)(file, flags, mode);
  }) as typeof fs.openSync;

  try {
    carryRunObligations(dir, 'OLD', 'NEW');
  } finally {
    mutableFs.openSync = realOpen;
  }

  assert.equal(injected, 1,
    "fixture guard: exactly one real append landed inside the carry's own write, which is the window");
  const after = readRunAgentActivity(dir, 'NEW', 'senior-frontend');
  assert.equal(after.bySession['child-LIVE'], 2,
    'the live child keeps BOTH lines: the carry may not republish a document it read before that append. '
    + 'A read-modify-write against an O_APPEND writer loses exactly this line');
  assert.equal(after.bySession['child-A'], 120, 'and the retired tally still arrives whole');
  assert.equal(after.total, 122);

  discard(dir);
});

/**
 * The append's SEPARATOR, pinned — and its reachability stated rather than
 * implied, because it is the honest half of this row.
 *
 * `bumpRunAgentActivity` writes one short line per call on an `O_APPEND` fd, and
 * a single small write of that shape lands whole, so NO product writer leaves
 * this file without a trailing newline. The state below is therefore built by
 * hand: it is what an external writer, a hand edit, or a filesystem that broke a
 * write in half leaves behind. That is a weaker reachability claim than any other
 * fixture in this file makes, and it is the reason the separator is one byte of
 * belt rather than a lock — but the cost of being wrong is a permanently
 * miscounted cap in the successor, which is why the byte is there and why this
 * pins it.
 */
test('a successor log whose last line lacks a newline does not fuse with the carried tally', () => {
  const dir = fixture();
  for (let i = 0; i < 3; i += 1) bumpRunAgentActivity(dir, 'OLD', 'senior-frontend', 'child-A');
  const target = path.join(dir, '.traffic-one', 'runs', 'NEW', 'agent-activity', 'senior-frontend.log');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'child-LIVE\nchild-LIVE', 'utf8');
  assert.equal(readRunAgentActivity(dir, 'NEW', 'senior-frontend').bySession['child-LIVE'], 2,
    'fixture guard: both existing lines count before the carry, newline or not');

  carryRunObligations(dir, 'OLD', 'NEW');

  const after = readRunAgentActivity(dir, 'NEW', 'senior-frontend');
  assert.equal(after.bySession['child-LIVE'], 2,
    'the unterminated last line is still one call by that child — without the separator it becomes '
    + '`child-LIVEchild-A`, which is a call by nobody');
  assert.equal(after.bySession['child-A'], 3, 'and all three carried lines are attributed to the child that made them');
  assert.equal(after.total, 5);

  discard(dir);
});

test('the model-choice latch is carried only while it is genuinely pending', () => {
  // ANSWERED: the marker must not follow, or the successor reads "prompted with
  // no reply" — a pause the retired run was never in, with no prompt left to
  // fire.
  const answered = fixture();
  markModelChoicePrompted(answered, 'OLD');
  assert.ok(writeModelChoice(answered, 'OLD', 'use-fallback'));
  carryRunObligations(answered, 'OLD', 'NEW');
  assert.equal(modelChoicePrompted(answered, 'NEW'), false,
    'an answered run carries no latch: the answer is what made the marker harmless');
  assert.ok(!fs.existsSync(path.join(answered, '.traffic-one', 'runs', 'NEW', 'model-choice.json')),
    'and the permissive answer itself never follows — dropping it makes the successor re-ask');
  discard(answered);

  // UNANSWERED: the latch follows.
  const pending = fixture();
  markModelChoicePrompted(pending, 'OLD');
  carryRunObligations(pending, 'OLD', 'NEW');
  assert.equal(modelChoicePrompted(pending, 'NEW'), true,
    'an unanswered pause is a latch waiting on a human, and a pointer move must not release it');
  discard(pending);
});

test('the live-agent registry carries without clobbering a child that bound in the successor first', () => {
  const dir = fixture();
  recordRunAgent(dir, 'OLD', 'senior-frontend', { agentId: 'agent-old', parentSessionId: 'parent-A' });
  recordRunAgent(dir, 'OLD', 'senior-tester', { agentId: 'agent-tester', parentSessionId: 'parent-A' });
  recordRunAgent(dir, 'NEW', 'senior-frontend', { agentId: 'agent-new', parentSessionId: 'parent-B' });

  carryRunObligations(dir, 'OLD', 'NEW');

  assert.equal(liveRunAgent(dir, 'NEW', 'senior-frontend', 'parent-B')?.agentId, 'agent-new',
    'the successor row wins: a child that bound after the pointer move is never overwritten');
  assert.equal(verdictAgentConflict(dir, 'NEW', 'senior-reviewer', 'agent-tester')?.role, 'senior-tester',
    'and a role only the retired run recorded still arrives, which is what keeps the conflict check honest');
  assert.equal(liveRunAgent(dir, 'NEW', 'senior-tester', 'parent-B'), null,
    'the duplicate-spawn axis self-limits: a carried row spawned by another session is not live here');

  discard(dir);
});

test('cursor spawn observations carry, because the store is designed to outlive the child', () => {
  const dir = fixture();
  recordCursorSpawnObservation(dir, 'OLD', {
    parentSessionId: 'parent-A',
    toolCallId: 'tool_old',
    role: 'senior-frontend',
    requestedModel: 'gpt-5.6-terra-medium',
    tier: 'highest',
    expectedModel: 'gpt-5.6-terra-medium',
  });

  carryRunObligations(dir, 'OLD', 'NEW');

  const carried = listCursorSpawnObservations(dir, 'NEW');
  assert.equal(carried.length, 1, 'the prescription follows the role, not the retired child');
  assert.equal(carried[0]?.toolCallId, 'tool_old');
  assert.equal(carried[0]?.role, 'senior-frontend');

  discard(dir);
});

// WIDEN_AT's docblock says the number is the deny-repeat ladder's rather than a
// fresh invention — "a reset is the same shape of event, so it gets the same
// number". That was a sentence and nothing else: no import, no assertion, and
// every test in this suite asserts against the constant itself, so bumping it
// changed the product's generosity and broke nothing. One equality makes the
// stated provenance real; if the two are ever meant to diverge, this line is
// where that decision has to be made out loud.
test('WIDEN_AT is the deny-repeat escalation threshold, which is what its docblock claims', () => {
  assert.equal(WIDEN_AT, DENY_REPEAT_ESCALATE_AT);
});

// The split, and WHERE each half is paid. The TTL entries are merged into the
// successor's own store; the terminal marker is not copied at any count — at
// WIDEN_AT it travels as an obligation the caller records in `.resets.json`,
// which is the one file a held lease cannot suppress (resets.ts
// ResetObligation). The gate-facing assertion is therefore made through the
// composition the product performs: the carry computes it, `recordReset`
// persists it, and `modelExhaustionTerminalForRole` reads it.
test('the exhaustion split: TTL entries always carry, the terminal marker only once widened', () => {
  const first = fixture();
  recordExhaustedModel(first, 'OLD', 'senior-frontend', 'gpt-5.6-terra-medium');
  assert.ok(markModelExhaustionTerminal(first, 'OLD', 'senior-frontend'));
  const early = carryRunObligations(first, 'OLD', 'NEW', { priorResets: WIDEN_AT - 2 });
  assert.deepEqual(early.widened, []);
  assert.deepEqual(early.obligation.terminalRoles, []);
  assert.equal(modelIsExhausted(first, 'NEW', 'senior-frontend', 'gpt-5.6-terra-medium'), true);
  assert.equal(modelExhaustionTerminalForRole(first, 'NEW', 'senior-frontend'), false,
    'a first or second reset forgives the terminal marker: no admissible model is a wedge');
  discard(first);

  const widened = fixture();
  recordExhaustedModel(widened, 'OLD', 'senior-frontend', 'gpt-5.6-terra-medium');
  assert.ok(markModelExhaustionTerminal(widened, 'OLD', 'senior-frontend'));
  const late = carryRunObligations(widened, 'OLD', 'NEW', { priorResets: WIDEN_AT - 1 });
  assert.equal(late.widened.length, 1, 'the WIDEN_AT-th reset widens');
  assert.deepEqual(late.obligation.terminalRoles, ['senior-frontend'],
    'and names the role, per role rather than per project');
  assert.equal(readExhaustedTerminal(widened, 'NEW', 'senior-frontend'), false,
    'never into the successor\'s own store: that file is what one held lease defeats');
  assert.ok(recordReset(widened, {
    at: new Date().toISOString(), from: 'OLD', to: 'NEW', status: 'failed', carried: late.carried,
  }, late.obligation));
  assert.equal(modelExhaustionTerminalForRole(widened, 'NEW', 'senior-frontend'), true,
    'and the marker follows through the record: the third recovery is not free');
  assert.equal(modelExhaustionTerminalForRole(widened, 'NEW', 'senior-backend'), false,
    'per role, so a role that never exhausted its rotation is untouched');
  discard(widened);
});

/**
 * THE "ONE WRITER" CLAIM, AND WHY IT IS NO LONGER A SOURCE SCAN.
 *
 * `.resets.json` holds the reset ladder, and three docblocks plus the
 * RECOVERY_RUNNERS row (hooks/fail-closed.ts property 2) argue from "one
 * writer, no lease" that the price a reset pays cannot be suppressed by the
 * capability that drops the bound. A lease-free file with TWO read-modify-
 * writers does not merely weaken that argument, it loses increments: 300
 * attempted increments returned `true` and 228/242/228 reached disk while the
 * second writer was live, and a re-derivation against a reconstruction of it
 * lands 175/197/158 of a 301 baseline over three trials, where the same 300
 * increments with no second writer land 301 of 301. Every lost one rolls the
 * ladder back toward the free resets this record exists to price. The rate is
 * load- and shape-dependent; that it is not zero is the part that matters.
 *
 * The scan below is a DENYLIST OF SPELLINGS and it fell to one character. An
 * adversarial review wrote a genuine second lease-free read-modify-writer whose
 * path is assembled from `runsRoot`, whose constant is file-local, and whose
 * filename is a TEMPLATE literal — the character class here is `['"]`, and a
 * backtick is not in it. Wired into `recordPendingModelChoiceReply`, the same
 * registered hook handler that produced the original defect, it passed this lane
 * and agent-model entirely green — 102/102 and 275/275 as those suites then
 * stood. Widening the class would forbid one more spelling and nothing else,
 * which is all a text rule can ever do: it can only ban what someone has already
 * been defeated by.
 *
 * WHAT DID CATCH a weaker variant — the same writer wired into
 * `clearExhaustedModels` — was the byte-identity assertion that used to sit
 * alone below it. Bytes cannot be spelled around. It missed the hook-path
 * variant only because it drove ONE entrypoint, so it is now driven over a
 * TABLE of them, and that test is what the claim rests on.
 *
 * The scan is kept, unwidened, as a tripwire for the naive spelling. Stated
 * honestly, it catches a writer that names `resetsPath`, `RESETS_FILE` or the
 * quoted literal, in a `.ts` file, outside `__tests__`. It does not catch: a
 * template literal, an assembled or concatenated literal, a path handed in by a
 * caller, `.mts`/`.mjs` files (`runners/lighthouse/index.mts` and `build/*.mjs`
 * are real product code and are not scanned), or anything under `__tests__`. It
 * also matches inside COMMENTS, which is deliberate rather than a defect to fix:
 * the property is that nothing outside this module NAMES the record, and a file
 * close enough to discuss it is close enough for that to be a deliberate act.
 * `resetsPath` is module-private now, so the compiler enforces the first
 * spelling independently of this scan.
 */
/**
 * Files that name the record in order to REFUSE writes to it.
 *
 * The scan's property is "nothing outside this module names the record", and a
 * write FENCE has to name what it fences — `reset-record-owner-gate` refuses
 * `.traffic-one/runs/.resets.json` at the plan gate, and the shell arm matches
 * the basename in command text because that is the only thing a command reliably
 * contains. Kept as an explicit, verified list rather than a pattern: the loop at
 * the end of the test re-derives that each entry still names the record and
 * still calls no write primitive, so the exemption cannot outlive its reason or
 * quietly become the second writer.
 *
 * `plan-readiness/context.ts` holds the same path and is NOT here, because the
 * scan's character class requires a quote adjacent to the filename and that
 * file spells the full relative path. That is an accident of the instrument, not
 * a ruling — noted so the next reader does not infer a distinction that was
 * never drawn.
 */
const RECORD_NAMERS: ReadonlySet<string> = new Set([
  'modules/plan-guard/plan-write/reset-record-shell.ts',
]);

test('`.resets.json` has exactly one writer, and it is `recordReset`', () => {
  const resets = path.join(SRC_ROOT, 'runners', 'traffic-one-reset', 'resets.ts');
  const source = fs.readFileSync(resets, 'utf8');

  const writes = [...source.matchAll(/writeJson\(/g)].map((match) => match.index as number);
  assert.equal(writes.length, 1,
    'a second write to this file is a second lease-free read-modify-writer of the reset ladder. The '
    + 'discharge is a fold in resetObligationFor, not a write; if a new writer is genuinely needed it '
    + 'needs a concurrency story first — see the ResetObligation docblock for why a lease is the wrong one');
  const recorder = source.indexOf('export function recordReset');
  assert.ok(recorder >= 0 && (writes[0] as number) > recorder,
    'and the one write is inside recordReset, the operator command\'s own recorder');

  const named = sourceFiles(SRC_ROOT)
    .filter((file) => file !== resets)
    .filter((file) => !RECORD_NAMERS.has(path.relative(SRC_ROOT, file)))
    .filter((file) => /\bresetsPath\b|\bRESETS_FILE\b|['"]\.resets\.json['"]/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC_ROOT, file));
  assert.deepEqual(named, [],
    'the reset record is named outside resets.ts. That is the naive way a second writer gets in — but it '
    + 'is only the naive way, and this scan is not what the one-writer claim rests on: see the entrypoint '
    + 'table below, which compares the record\'s BYTES and cannot be spelled around');

  // The exemptions are not taken on trust. Each one is admitted for naming the
  // record in order to REFUSE writes to it, and that is the whole of what it may
  // do: a write primitive appearing in one of these files is the second writer
  // this test exists to find, arriving through the door the exemption opened. The
  // alternative was worse — a fence that spells the path around the scan is
  // exactly the one-character evasion the docblock above records as this
  // instrument's known defeat, and doing it deliberately would leave the next
  // reader unable to tell an exemption from an attack.
  for (const relative of RECORD_NAMERS) {
    const file = path.join(SRC_ROOT, relative);
    assert.ok(fs.existsSync(file), `the exemption ${relative} no longer exists — drop it from RECORD_NAMERS`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(/\.resets\.json/.test(text),
      `${relative} no longer names the record, so its exemption is stale — drop it from RECORD_NAMERS`);
    const primitives = ['writeJson', 'writeFileSync', 'appendFileSync', 'truncateSync', 'unlinkSync',
      'rmSync', 'renameSync', 'copyFileSync', 'createWriteStream', 'openSync'];
    const found = primitives.filter((primitive) => new RegExp(`\\b${primitive}\\s*\\(`).test(text));
    assert.deepEqual(found, [],
      `${relative} is exempted from the naming scan because it REFUSES writes to the record, and it now `
      + 'calls a write primitive itself. If that call cannot touch the record, the exemption is the wrong '
      + 'shape and the file needs splitting; if it can, this is the second lease-free writer.');
  }
});

/** A Cursor UserPromptSubmit context — the surface `modelChoiceReplySweep` is
 *  registered on, and the only host whose flags ask the user at all. */
function cursorPrompt(cwd: string, prompt: string): Ctx {
  return {
    input: { event: 'UserPromptSubmit', host: 'cursor', cwd, workspaceRoot: cwd, prompt, raw: {} },
    host: 'cursor',
    cwd,
    now: () => 'x',
  } as unknown as Ctx;
}

/** A project whose CURRENT run carries a live widening obligation, with the
 *  choice prompt armed so the reply handlers have something to record. */
function owing(): string {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', onboardingComplete: true, confirmed: true,
    team: { mode: 'subagents', approved: true }, currentRunId: 'NEW',
  }), 'utf8');
  markModelExhaustionTerminal(dir, 'OLD', 'senior-frontend');
  const carried = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: WIDEN_AT - 1 });
  assert.ok(recordReset(dir, {
    at: new Date().toISOString(), from: 'OLD', to: 'NEW', status: 'failed', carried: carried.carried,
  }, carried.obligation));
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'senior-frontend'), true,
    'fixture guard: the successor really is carrying the widened bound');
  markModelChoicePrompted(dir, 'NEW');
  return dir;
}

/** The same project, wedged the way the reset command requires: current run
 *  terminally `failed`, so `resetRun` reaches its settle path instead of a
 *  refusal. */
function wedgedOwing(): string {
  const dir = owing();
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', onboardingComplete: true, confirmed: true,
    lifecycle: { phase: 'maintenance', source: 'heuristic', completedAt: new Date().toISOString() },
    team: { mode: 'subagents', approved: true }, currentRunId: 'NEW',
  }), 'utf8');
  assert.ok(ensureRunLedger(dir, 'NEW', { status: 'planned', kind: 'agent-claim' }));
  assert.ok(transitionRunStatus(dir, 'NEW', { status: 'active' }));
  assert.ok(transitionRunStatus(dir, 'NEW', { status: 'failed', outcome: 'agent-failed' }));
  return dir;
}

/**
 * EVERY PRODUCT ENTRYPOINT THAT COULD PLAUSIBLY ACQUIRE A WRITE, DRIVEN.
 *
 * This is the assertion the source scan above cannot make. Each row drives real
 * product code and then byte-compares the record, so a writer's SPELLING stops
 * mattering. RE-RUN against the exact mutant that beat the scan — same backtick
 * literal, same file-local constant, same reassembled path, same registered hook
 * handler: the scan still reports nothing, and row 2 reds on the bytes.
 *
 * `drive` PROVES ITS OWN ARM RAN. An entrypoint that returned early writes
 * nothing and would satisfy a byte-comparison by doing nothing at all, which is
 * the failure this whole file exists to make impossible one level down.
 *
 * `resetRun` is in the table as the POSITIVE CONTROL and is not decoration: an
 * instrument that never observes a change cannot tell "nothing wrote" from
 * "this test cannot see a write". The reset command must move these bytes.
 *
 * WHAT THIS DOES NOT COVER, said plainly: a writer reached from an entrypoint
 * that is not in this table — a retention sweep, a doctor subcommand, a new
 * hook. The table is hand-maintained and there is no enumeration behind it, so
 * it is a strictly stronger instrument than the scan on the paths it drives and
 * no instrument at all off them. A runtime chokepoint was considered and
 * rejected; the reason is in the ResetObligation docblock.
 */
const RESET_RECORD_ENTRYPOINTS: readonly {
  readonly what: string;
  readonly make: () => string;
  readonly drive: (dir: string) => void;
  /** Only the command that COUNTS a reset may move these bytes. */
  readonly writes: boolean;
}[] = [
  {
    what: 'clearExhaustedModels — the remedy, after the answer the product writes first',
    make: owing,
    drive: (dir) => {
      assert.ok(writeModelChoice(dir, 'NEW', 'enable-retry'));
      clearExhaustedModels(dir, 'NEW');
      assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'senior-frontend'), false,
        'arm guard: the remedy must actually have discharged the bound, or this row measured nothing');
    },
    writes: false,
  },
  {
    what: 'recordPendingModelChoiceReply — the registered hook handler the original defect lived in',
    make: owing,
    drive: (dir) => {
      assert.ok(recordPendingModelChoiceReply(dir, 'enable'),
        'arm guard: the handler must have recorded the reply, not returned null on an unarmed latch');
      assert.equal(readModelChoice(dir, 'NEW'), 'enable-retry', 'arm guard: and the answer is on disk');
    },
    writes: false,
  },
  {
    what: 'modelChoiceReplySweep — the same handler through its own hook surface',
    make: owing,
    drive: (dir) => {
      assert.equal(modelChoiceReplySweep(cursorPrompt(dir, 'enable')).kind, 'context',
        'arm guard: the sweep must have reached the recorder, not no-opped on host flags or project root');
      assert.equal(readModelChoice(dir, 'NEW'), 'enable-retry', 'arm guard: and the answer is on disk');
    },
    writes: false,
  },
  {
    what: 'resetRun — the operator command\'s settle path (the POSITIVE CONTROL)',
    make: wedgedOwing,
    drive: (dir) => {
      const result = resetRun(dir, 'NEW');
      assert.equal(result.ok, true, `arm guard: the reset must reach its settle path — ${result.message}`);
    },
    writes: true,
  },
];

test('`.resets.json` is byte-identical across every product entrypoint but the reset itself', () => {
  for (const row of RESET_RECORD_ENTRYPOINTS) {
    const dir = row.make();
    const record = path.join(dir, '.traffic-one', 'runs', RESETS_FILE);
    const before = fs.readFileSync(record, 'utf8');
    row.drive(dir);
    const after = fs.readFileSync(record, 'utf8');

    if (row.writes) {
      assert.notEqual(after, before,
        `POSITIVE CONTROL FAILED: ${row.what} left the reset ladder untouched. Either the reset stopped `
        + 'recording itself, or this test can no longer see a write at all — in which case every `false` '
        + 'row above is passing vacuously and proves nothing');
      assert.equal(readResetRecord(dir).count, 2, 'and the second reset is counted');
    } else {
      assert.equal(after, before,
        `${row.what} rewrote the reset ladder. That is a second lease-free read-modify-writer of a file `
        + 'whose whole argument is that it has one writer and takes no lease: the increments it clobbers '
        + 'are the price of the NEXT reset, and the caller is told they landed. The discharge is a fold in '
        + 'resetObligationFor — a READ — and it must stay one; see the ResetObligation docblock for why a '
        + 'lease is the wrong repair');
    }
    discard(dir);
  }
});

/**
 * THE DISCHARGE IS A READ. Not "the discharge works" — that is the next test —
 * but that paying it leaves the record BYTE-IDENTICAL, which is the property
 * the writer count above depends on and the one a well-meaning revert would
 * break while every behavioural assertion stayed green.
 */
test('the remedy discharges the obligation without writing the reset record', () => {
  const dir = fixture();
  markModelExhaustionTerminal(dir, 'OLD', 'senior-frontend');
  const carried = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: WIDEN_AT - 1 });
  assert.ok(recordReset(dir, {
    at: new Date().toISOString(), from: 'OLD', to: 'NEW', status: 'failed', carried: carried.carried,
  }, carried.obligation));
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'senior-frontend'), true,
    'fixture guard: the successor really is carrying the widened bound');

  const record = path.join(dir, '.traffic-one', 'runs', RESETS_FILE);
  const before = fs.readFileSync(record, 'utf8');

  // The user's answer, through the product's own writers in the order
  // choice-reply.ts performs them in.
  assert.ok(writeModelChoice(dir, 'NEW', 'enable-retry'));
  clearExhaustedModels(dir, 'NEW');

  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'senior-frontend'), false,
    'the widened bound has a route out, which is what keeps it a cost rather than a brick');
  assert.equal(fs.readFileSync(record, 'utf8'), before,
    'and the route out does not touch the ladder: a discharge that rewrote this file would be the '
    + 'second lease-free writer again, and the count it clobbers is the price of the NEXT reset');
  assert.equal(readResetRecord(dir).count, 1, 'the reset still happened and is still counted');
  discard(dir);
});

test('the remedy is scoped to the run that was given it, so it cannot discharge a successor', () => {
  const dir = fixture();
  markModelExhaustionTerminal(dir, 'OLD', 'senior-frontend');
  const first = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: WIDEN_AT - 1 });
  assert.ok(recordReset(dir, {
    at: new Date().toISOString(), from: 'OLD', to: 'NEW', status: 'failed', carried: first.carried,
  }, first.obligation));
  assert.ok(writeModelChoice(dir, 'NEW', 'enable-retry'));
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'senior-frontend'), false,
    'fixture guard: NEW is discharged');

  // Reset again. `model-choice.json` is bound-dropped, so the answer stays with
  // the run that gave it and the successor is priced on its own count — which is
  // what stops "answer enable once, then reset for free" being a strategy.
  markModelExhaustionTerminal(dir, 'NEW', 'senior-frontend');
  const second = carryRunObligations(dir, 'NEW', 'NEWER', { priorResets: WIDEN_AT });
  assert.ok(recordReset(dir, {
    at: new Date().toISOString(), from: 'NEW', to: 'NEWER', status: 'failed', carried: second.carried,
  }, second.obligation));
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEWER', 'senior-frontend'), true,
    'the successor inherits the widening again: a discharged answer is not a standing exemption');
  discard(dir);
});

/** The successor's own `exhausted-models.json`, read directly — the site the
 *  widening used to be paid into, and must no longer be. */
function readExhaustedTerminal(cwd: string, runId: string, role: string): boolean {
  const file = path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { roles?: Record<string, { terminal?: unknown }> };
    return Boolean(raw.roles?.[role]?.terminal);
  } catch {
    return false;
  }
}

/**
 * CARRY_LEASE_RETRY_MS, pinned on a fixture that REACHES the branch it defends.
 *
 * Round 6 measured the sleep at 571 attempts against 564 without it and called
 * the mutant equivalent. That measurement was taken on a fixture where the
 * acquire always ran its own 2s inner retry loop, which dominates everything: a
 * loop whose body already sleeps for two seconds does not care whether the
 * caller sleeps 25ms between iterations. The branch the sleep exists for is the
 * one with NO inner loop — `acquireOwnedDirLock` returns null IMMEDIATELY when
 * the lock's parent directory can neither be found nor created
 * (`if (!ensureDir(path.dirname(lockDir))) return null`) — and it is reachable
 * with the runs root at mode 0500, which is what this fixture builds and what
 * the guard below asserts before measuring anything.
 *
 * MEASURED there: 261 acquire attempts, 195ms of CPU over an 8,003ms carry (2%)
 * with the sleep; 8,152 attempts, 2,492ms of CPU over 8,036ms (31%) with
 * `CARRY_LEASE_RETRY_MS` set to 0. So the sleep is load-bearing, the equivalence
 * claim was false, and it was false because of the fixture rather than the code.
 *
 * ASSERTED ON THE ATTEMPT COUNT rather than on a duration, because the count is
 * a property of the loop (at most `budget / retry` iterations) while a duration
 * is a property of the machine. `fs.mkdirSync` is the acquire's own first
 * syscall, so counting calls at it counts attempts exactly.
 */
test('the carry lease retry sleep bounds a loop the acquire does not bound', () => {
  const dir = fixture();
  const runs = path.join(dir, '.traffic-one', 'runs');
  const to = 'NEW-run';
  // Something for a LEASED row to carry: a carry with nothing to carry returns
  // before it ever asks for a lease.
  fs.writeFileSync(path.join(runs, 'OLD', 'agents.json'), JSON.stringify({
    agents: { 'senior-frontend': { agentId: 'agent-1', parentSessionId: 'parent-A' } },
  }), 'utf8');

  const nodeFs = require('fs') as { mkdirSync: typeof fs.mkdirSync };
  const realMkdir = nodeFs.mkdirSync;
  let attempts = 0;
  try {
    fs.chmodSync(runs, 0o500);
    // REACHABILITY, asserted before the measurement rather than assumed after
    // it. This is the whole lesson of the round-6 mistake: a measurement taken
    // on a fixture that cannot reach the code under test is not evidence about
    // that code.
    let creatable = true;
    try { fs.mkdirSync(path.join(runs, to)); } catch { creatable = false; }
    assert.equal(creatable, false,
      'fixture guard: the successor run dir must be uncreatable, or the acquire runs its own inner loop '
      + 'and this measures nothing');

    nodeFs.mkdirSync = ((target: fs.PathLike, options?: unknown) => {
      if (String(target).includes(to)) attempts += 1;
      return (realMkdir as (t: fs.PathLike, o?: unknown) => string | undefined)(target, options);
    }) as typeof fs.mkdirSync;

    const outcome = carryRunObligations(dir, 'OLD', to);
    assert.ok(outcome.failed.includes('agents.json'),
      'fixture guard: the leased row really did spend the budget and report itself not carried');
  } finally {
    nodeFs.mkdirSync = realMkdir;
    fs.chmodSync(runs, 0o700);
  }

  assert.ok(attempts > 1, `fixture guard: the loop must actually iterate, saw ${attempts}`);
  assert.ok(attempts < 1_000,
    `an 8s budget with a ${25}ms floor between fruitless attempts admits a few hundred acquire attempts; `
    + `saw ${attempts}. Without the sleep this branch answers instantly and burns the whole budget on `
    + 'back-to-back syscalls (measured: 8,152)');

  discard(dir);
});

test('a condemnation is never shortened by the merge', () => {
  const dir = fixture();
  const later = new Date().toISOString();
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const runs = path.join(dir, '.traffic-one', 'runs');
  fs.writeFileSync(path.join(runs, 'OLD', 'exhausted-models.json'), JSON.stringify({
    version: 2, roles: { 'senior-frontend': { entries: [{ model: 'm-shared', at: later }, { model: 'm-old', at: later }] } },
  }), 'utf8');
  fs.mkdirSync(path.join(runs, 'NEW'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'NEW', 'exhausted-models.json'), JSON.stringify({
    version: 2, roles: { 'senior-frontend': { entries: [{ model: 'm-shared', at: earlier }] } },
  }), 'utf8');

  carryRunObligations(dir, 'OLD', 'NEW');

  const store = JSON.parse(fs.readFileSync(path.join(runs, 'NEW', 'exhausted-models.json'), 'utf8'));
  const entries = store.roles['senior-frontend'].entries as Array<{ model: string; at: string }>;
  assert.equal(entries.find((e) => e.model === 'm-shared')?.at, later,
    'the later stamp wins: the merge may lengthen a condemnation, never shorten one');
  assert.ok(entries.some((e) => e.model === 'm-old'), 'and a model only the retired run condemned arrives');

  discard(dir);
});

// ── the disk-driven half of the enumeration ─────────────────────────────────
// The header used to claim a test "drives a fixture run and fails on any entry
// that reaches disk without a row". No such test existed, and
// undeclaredRunEntries had no production and no caller at all — so the claim
// described nothing. It also treated EVERY top-level `*.json` as a per-session
// claim file, which is the one shape that most needs catching: a future gate's
// `budget.json` was silently unreportable.
test('undeclaredRunEntries reports anything on disk the table has not classified', () => {
  const dir = fixture();
  const runDirPath = path.join(dir, '.traffic-one', 'runs', 'OLD');

  // A real claim file, by the product's own definition (claims-store.ts reads a
  // top-level *.json and requires a VALID_AGENT_ROLES role; the sweep touches
  // only rows carrying a claimId).
  fs.writeFileSync(path.join(runDirPath, 'child-thread-7.json'),
    JSON.stringify({ claimId: 'c1', role: 'senior-frontend', status: 'claimed' }), 'utf8');
  // Classified entries.
  fs.writeFileSync(path.join(runDirPath, 'run.json'), JSON.stringify({ status: 'failed' }), 'utf8');
  // A future gate's per-run budget, which the old shape test waved through.
  fs.writeFileSync(path.join(runDirPath, 'budget.json'), JSON.stringify({ spent: 3 }), 'utf8');
  fs.mkdirSync(path.join(runDirPath, 'a-new-gate-dir'), { recursive: true });

  assert.deepEqual(undeclaredRunEntries(runDirPath), ['a-new-gate-dir', 'budget.json'],
    'a claim file is recognised by the claim machinery\'s own test; anything else is reported');

  discard(dir);
});

// ── the fifty-third class: the atomic writers' own staging siblings ─────────
// A row per name is impossible — the names carry a pid, an epoch, a counter or
// random hex — so this is a SHAPE exclusion beside the claim-file test, and the
// shape is read out of fsjson.ts rather than transcribed, so a writer that
// changes its template fails here instead of quietly re-opening the class.
const FSJSON = path.join(SRC_ROOT, 'shared', 'fsjson.ts');

test('an interrupted atomic write leaves a staging sibling, and it is not reported as undeclared', () => {
  // Why they reach disk at all: all three writers unlink the temp in a `finally`,
  // which requires the PROCESS to survive. A kill or a power loss between write
  // and rename leaves the sibling — the residue incident this runner exists for.
  const templates = fs.readFileSync(FSJSON, 'utf8')
    .match(/`\$\{(?:filePath|entry\.path)\}[^`]*\.tmp`/g) ?? [];
  assert.deepEqual(templates, [
    '`${filePath}.${process.pid}.tmp`',
    '`${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`',
    '`${entry.path}.${process.pid}.${index}.set.tmp`',
  ], 'fixture guard: the staging templates the exclusion is shaped against, read out of fsjson.ts');

  const dir = fixture();
  const runDirPath = path.join(dir, '.traffic-one', 'runs', 'OLD');
  const dest = 'run.json';
  const staged = [
    `${dest}.${process.pid}.tmp`, // writeJson
    `${dest}.${process.pid}.${Date.now()}.a1b2c3.tmp`, // writeJsonDurable
    `${dest}.${process.pid}.0.set.tmp`, // writeJsonSet
  ];
  for (const name of staged) fs.writeFileSync(path.join(runDirPath, name), '{"half":', 'utf8');

  assert.deepEqual(undeclaredRunEntries(runDirPath), [],
    'a residue sibling of a classified destination is the writer\'s, not an unclassified entry');

  // And the exclusion is a SHAPE, not a `.tmp` waiver: a future gate's own
  // scratch file still has to earn a row.
  const foreign = ['scratch.tmp', 'budget.json.tmp', 'run.json.tmp', 'notes.txt.4242.tmp'];
  for (const name of foreign) fs.writeFileSync(path.join(runDirPath, name), 'x', 'utf8');
  assert.deepEqual(undeclaredRunEntries(runDirPath), [...foreign].sort(),
    'nothing but the three templates is waved through');

  discard(dir);
});

test('a real run directory reaches disk with every entry classified', () => {
  // The fixture RUN, driven through product writers rather than a list of
  // names: whatever these leave behind must be classified or reported.
  const dir = fixture();
  const runDirPath = path.join(dir, '.traffic-one', 'runs', 'OLD');
  recordDenyRepeat(dir, 'OLD', 'sig');
  bumpRunAgentActivity(dir, 'OLD', 'senior-frontend', 'child-A');
  markAgentActivityCapDenied(dir, 'OLD', 'senior-frontend');
  recordScanBoundHit(dir, 'OLD', 'structure-walk-file-cap');
  recordExhaustedModel(dir, 'OLD', 'senior-frontend', 'gpt-5.6-terra-medium');
  markModelChoicePrompted(dir, 'OLD');
  writeModelChoice(dir, 'OLD', 'use-fallback');
  recordRunAgent(dir, 'OLD', 'senior-frontend', { agentId: 'a1', parentSessionId: 'p1' });
  recordCursorSpawnObservation(dir, 'OLD', {
    parentSessionId: 'p1',
    toolCallId: 'tool_1',
    role: 'senior-frontend',
    requestedModel: 'gpt-5.6-terra-medium',
    tier: 'highest',
    expectedModel: 'gpt-5.6-terra-medium',
  });

  assert.deepEqual(undeclaredRunEntries(runDirPath), [],
    'every entry a driven run leaves on disk has a row');

  discard(dir);
});

test('the reset record is never mistaken for a run id by the retention sweep', () => {
  // resets.ts puts `.resets.json` directly under `runs/`, beside the run dirs,
  // because a record kept INSIDE the run being retired is one the next reset
  // walks away from. That placement is only safe if nothing enumerating `runs/`
  // treats a file there as a run — and `shared/retention.ts` is fenced to
  // another lane, so this pins the behaviour rather than trusting a comment.
  const dir = fixture();
  const runs = path.join(dir, '.traffic-one', 'runs');
  fs.writeFileSync(path.join(runs, RESETS_FILE), JSON.stringify({ count: 1, events: [] }), 'utf8');

  // The predicate every run enumerator in this codebase uses.
  const asRuns = fs.readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.deepEqual(asRuns, ['OLD'],
    'the record is a FILE, so a directory-filtered enumeration cannot see it as a run');

  // And it survives a real retention pass over the project.
  sweepTrafficOneRetention(dir);
  assert.ok(fs.existsSync(path.join(runs, RESETS_FILE)),
    'the record outlives retention; a record the sweep collects is no record at all');

  discard(dir);
});

test('carrying from a run that holds nothing is a no-op, not a failure', () => {
  const dir = fixture();
  const outcome = carryRunObligations(dir, 'OLD', 'NEW');
  assert.deepEqual(outcome.carried, []);
  assert.deepEqual(outcome.failed, []);
  assert.ok(!fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'NEW')),
    'an empty carry must not create the successor dir as a side effect');
  discard(dir);
});
