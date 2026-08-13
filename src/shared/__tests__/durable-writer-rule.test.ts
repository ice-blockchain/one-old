// The original plan said "one durable writer": unify every `writeJson` on
// fsync-fd -> rename -> fsync-dir. The reader half of that plan shipped
// (`readJsonResult`); the writer half was deliberately not unified, and
// fsjson.ts's `writeJsonDurable` docblock carries the measurement and the rule
// that replaced it. This file is the enforcement that ratification promised,
// because the reason the deviation went unrecorded for as long as it did is
// that a convention nothing checks is indistinguishable from an oversight.
//
// Measured, this machine, APFS: +8.8 ms per call, flat across an 84 B and a
// 40 KB payload. A denying PreToolUse invocation on the THINNEST materialized
// project performs TEN state writes, FIVE of them `writeJson`, and takes
// 2.94 ms p50; routing those five through the durable writer MEASURES +47 ms —
// 50 ms p50, 17x, on the floor case. That is a direct A/B between the shipped
// tree and a copy whose `writeJson` body is the durable one, not a derivation:
// the export is not reroutable in-process under this loader, so a same-process
// A/B silently compares the shipped writer against itself.
//
// +47 is MEASURED, not computed: five calls at +8.8 ms is +44 ms, and the model
// is a floor rather than an identity. Both numbers are stated wherever either
// is, because an earlier draft quoted +47 as though it fell out of 5 x 8.8.
//
// The earlier figure here said "3 state writes … +24 ms, 7.6x", and a later
// correction said "1 writeJson … +7 ms, 3.0x". Both undercounted the same way:
// `drainStateWrites()` after the invocation returns sees only what happened
// AFTER core/pipeline.ts's own drain at settle — 3 of the 10 writes, 1 of the 5
// `writeJson` calls. The multiplier is pinned below from the union of the two
// production surfaces, so it cannot drift again without a red test — and that
// union is the whole population of THIS fixture rather than structurally: a
// write to a plain path is recorded by neither surface and both are bounded at
// 64. Both gaps undercount, so five is a floor.
//
// Three assertions, and they fail for different reasons:
//   1. the durable SET is bounded — a sixth caller has to come here and argue;
//   2. the two members are still durable AT THE CHOKEPOINT, driven through the
//      real `writeState` rather than by reading the source, so a refactor that
//      demotes `.one.json` back to the atomic writer fails here and not in
//      somebody's power-loss postmortem;
//   3. the floor case still makes five `writeJson` calls — the multiplier the
//      whole affordability argument rests on, and the one number in it that a
//      refactor can move without anybody noticing.
//
// What it does NOT do is classify a new artifact. Nothing mechanical can: the
// question is whether the fact was minted once and already observed off this
// machine, and only the writer knows. That is what the rule in fsjson.ts is
// for; this file only stops the answer drifting once it has been given.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codexAdapter } from '../../adapters/claude';
import { dispatch } from '../../core/dispatch';
import { deny } from '../../core/result';
import type { Handler } from '../../core/types';
import { appendTextFile, appendTextFileDurable, writeJson } from '../fsjson';
import { drainStateWrites } from '../state/state-write-log';
import { recordPluginUseChoice, resetPluginUseCache } from '../state/plugin-use';
import { statePath, writeState } from '../state/normalize';
import { trackedTempDirs } from '../../test-support/__tests__/temp-dirs';

const RUN_ID = 'R';

/**
 * The two durable primitives the allowlist below bounds.
 *
 * BOTH, not just `writeJsonDurable`. `appendTextFileDurable` used to be exempted
 * in prose — fsjson.ts argued that a key naming an append-only caller would fail
 * the `deepEqual` from the other side, which was true of a scan that only looked
 * for `writeJsonDurable(` and is exactly how a bound turns into a convention
 * nobody checks. Scanning for both means the append primitive's caller set is
 * ASSERTED (it is empty today) instead of being trusted to stay that way.
 */
const DURABLE_PRIMITIVES = ['writeJsonDurable', 'appendTextFileDurable'] as const;

/**
 * Every non-test source file permitted to call a durable primitive, with the
 * artifact that earns it. Adding a row means the rule in fsjson.ts applies to
 * the new artifact: minted once, already observed off this machine.
 */
const DURABLE_CALLERS: Readonly<Record<string, string>> = {
  // The canonical `.one.json`. Carries the project uid and the one-mcp report
  // id — minted once each, both quoted outside this machine.
  'src/shared/state/normalize.ts': 'the canonical .one.json publish',
  // The report status/payload, which name the report id a reporter has been
  // handed. Same property, different artifact.
  'src/runners/one-mcp-report/lib.ts': "the report's own .one.json publish",
  'src/runners/one-mcp-report/prepareReport.ts': 'the report status',
  'src/runners/one-mcp-report/report-payload.ts': 'the report status payload',
  'src/runners/one-mcp-report/runReport.ts': 'the report status',
};

const dirs = trackedTempDirs('t1-durable-rule-');
const savedPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;

after(() => {
  if (savedPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
  dirs.cleanup();
});

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

test('the durable-writer set is exactly the artifacts the rule names', () => {
  const src = path.resolve(__dirname, '..', '..');
  const repo = path.dirname(src);
  const calls = new RegExp(`\\b(?:${DURABLE_PRIMITIVES.join('|')})\\s*\\(`);
  const callers = sourceFiles(src)
    // fsjson.ts declares them; naming yourself is not calling yourself.
    .filter((file) => path.relative(src, file) !== 'shared/fsjson.ts')
    .filter((file) => calls.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(repo, file).split(path.sep).join('/'))
    .sort();

  // FIXTURE READBACK — a renamed primitive would match nothing and pass empty
  // against an empty table, so the scan has to be shown to SEE its own subject.
  assert.ok(
    DURABLE_PRIMITIVES.every((name) => new RegExp(`export function ${name}\\b`)
      .test(fs.readFileSync(path.join(src, 'shared', 'fsjson.ts'), 'utf8'))),
    `FIXTURE both durable primitives must still be declared under these names: ${DURABLE_PRIMITIVES.join(', ')}`,
  );

  assert.deepEqual(
    callers, Object.keys(DURABLE_CALLERS).sort(),
    'the durable writer costs +8.8 ms a call and a MEASURED +47 ms (17x) on a floor-case hook invocation '
    + '(five calls, so +44 ms by the per-call model alone), so its set '
    + 'is bounded on purpose. A new caller: confirm the artifact was minted once and is already '
    + 'observed off this machine (fsjson.ts states the rule), then add it to DURABLE_CALLERS with '
    + 'the artifact named. A caller that DISAPPEARED is the direction that matters — a durable '
    + 'artifact demoted to the atomic writer loses a commitment somebody else already acted on.',
  );
});

test('the canonical .one.json is still published durably, driven through the real writer', () => {
  // Asserted at the chokepoint rather than by reading normalize.ts, because the
  // hazard is a refactor that keeps the call site and changes what it reaches.
  const cwd = dirs.make();
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'prefs.json');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  recordPluginUseChoice(cwd, true, 'test');

  drainStateWrites();
  const published = writeState(cwd, {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' }, onboardingComplete: true,
  });
  assert.equal(published, true, 'the fixture must actually publish, or the assertion below is vacuous');

  const writes = drainStateWrites().filter((write) => write.path === statePath(cwd));
  assert.deepEqual(
    writes.map((write) => write.op), ['write-json-durable'],
    'writeState publishes the project uid and the one-mcp report id, which are minted once and '
    + 'quoted outside this machine. Reaching the atomic writer here means a power loss retracts '
    + `an identity a reporter already has. Recorded: ${JSON.stringify(writes)}`,
  );
});

// ── the durable APPEND, for the artifacts writeJsonDurable cannot serve ──────
//
// `writeJsonDurable` renames a whole document over the destination, so it has
// nothing to offer an append-only ledger. `appendTextFileDurable` is that
// shape's writer, and it has no row in DURABLE_CALLERS because it has no
// production caller yet — a fact the allowlist now ENFORCES rather than a prose
// exemption. Its first caller will be a diff there, arguing the artifact against
// the same rule.
//
// The property under test is the one a hand-rolled `fs.openSync(path,'a')`
// silently loses. Durability itself is not assertable from userland — there is
// no way to observe an fsync — so what is pinned here is everything the reach
// past the guarded writer would have dropped: the append semantics, the
// no-follow refusal, and the reported op.

test('appendTextFileDurable appends under the fence and reports its own op', () => {
  const cwd = dirs.make();
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'prefs.json');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  recordPluginUseChoice(cwd, true, 'test');

  const ledger = path.join(cwd, '.traffic-one', 'ledger.jsonl');
  drainStateWrites();
  assert.equal(appendTextFileDurable(ledger, '{"n":1}\n'), true);
  assert.equal(appendTextFileDurable(ledger, '{"n":2}\n'), true);

  assert.equal(
    fs.readFileSync(ledger, 'utf8'), '{"n":1}\n{"n":2}\n',
    'the second call must APPEND. An explicit write position turns an O_APPEND write into a pwrite at '
    + 'byte 0 and every line erases the one before it — the defect fs-nofollow.ts documents.',
  );
  assert.deepEqual(
    drainStateWrites().filter((write) => write.path === ledger).map((write) => write.op),
    ['append-text-durable', 'append-text-durable'],
    'a durable append must still report at the chokepoint. A hand-rolled fs append reports nothing, so '
    + 'a refused or failed ledger write would stop appearing in the decision record.',
  );
});

test('appendTextFileDurable refuses a symlinked ledger instead of appending through it', () => {
  const cwd = dirs.make();
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'prefs.json');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  recordPluginUseChoice(cwd, true, 'test');

  const secret = path.join(cwd, 'outside.txt');
  fs.writeFileSync(secret, 'untouched\n', 'utf8');
  const planted = path.join(cwd, '.traffic-one', 'ledger.jsonl');
  fs.symlinkSync(secret, planted);

  assert.equal(appendTextFileDurable(planted, '{"pwned":true}\n'), false);
  assert.equal(
    fs.readFileSync(secret, 'utf8'), 'untouched\n',
    'the no-follow protection is exactly what reaching past the guarded writer would have dropped',
  );
});

/**
 * The consent fence, asked of all three primitives in PARITY rather than of the
 * new one alone — and asked under BOTH values of the ask-first question, because
 * the fence's answer for a pending project IS that value and a suite that
 * inherits it silently is not testing the product.
 *
 * THE CORRECTION THIS ROW CARRIES. This started as a single assertion — "refused
 * while the use-plugin question is unanswered" — it was RED, and the conclusion
 * drawn from that was wrong: that `projectStateWriteAllowed` is open for a
 * project nobody has asked about yet and has to be, because the writes that
 * CARRY the question happen before there is an answer. It is not open under what
 * ships. `ASK_USE_PLUGIN_FIRST = true` (config/onboarding.ts) and
 * `projectWritesPermitted` returns `!askUsePluginFirst(env)` for a project with
 * no recorded choice, so a pending project is REFUSED. The assertion was red
 * because `src/build/test-preload.mjs` pins `TRAFFIC_ONE_ASK_USE_PLUGIN` to '0'
 * for every test file in this repository, and this file inherited that without
 * naming it — so three of the nine cells below exercised a configuration that
 * does not ship, and the row that failed did so on the EXISTING writer while the
 * message accused the new primitive of being a hole in the fence.
 *
 * The necessity argument was satisfied by a mechanism it did not credit. Nothing
 * needs the fence open by default: the write that RECORDS the answer goes to the
 * per-user machine dir under `projects/`, which `projectRootForStatePath` resolves
 * to null via MACHINE_OWNED_ENTRIES and the fence therefore never governs; and
 * the one writer that must reach inside a pending project's own state dir — the
 * decline cleanup — declares itself through `withPreConsentProjectWrites`, a
 * named window scoped to the single root being declined. Both are in
 * state/plugin-use.ts. A default-open fence is not the price of asking a
 * question.
 *
 * The pin is still not flipped here: the preload's '0' is what ~290 other test
 * files depend on and this file is not the place to change that. What this row
 * does is stop depending on it invisibly — it sets the value it means, both ways,
 * and names the shipped one. The parity question it was reaching for is answered
 * in the shape that stays true: does the DURABLE append sit behind the same fence
 * as everything else, or did adding a primitive open a hole? A divergence in any
 * direction is a diff here, under either configuration.
 */
test('appendTextFileDurable sits behind exactly the fence its two siblings do, under both ask-first values', () => {
  type Primitive = readonly [name: string, call: (target: string) => boolean];
  const primitives: readonly Primitive[] = [
    ['writeJson', (target) => writeJson(target, { n: 1 })],
    ['appendTextFile', (target) => appendTextFile(target, 'x\n')],
    ['appendTextFileDurable', (target) => appendTextFileDurable(target, 'x\n')],
  ];

  // Each state is a fresh project, because consent is recorded per project and
  // a state cannot be un-recorded. `pending` is the only row the ask-first value
  // can move, and it moves it completely: that is the product contract (a
  // project stays byte-identical until the user answers) and it is the cell the
  // inherited pin was quietly inverting.
  const states: readonly (readonly [label: string, record: null | boolean])[] = [
    ['never asked', null],
    ['recorded YES', true],
    ['recorded NO', false],
  ];
  const configurations: readonly (readonly [askFirst: string, note: string])[] = [
    ['1', 'THE SHIPPED DEFAULT (ASK_USE_PLUGIN_FIRST = true), pinned explicitly rather than inherited'],
    ['0', 'ask-first disabled — the legacy wizard flow, and what the suite-wide preload pins'],
  ];

  const savedAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  try {
    for (const [askFirst, note] of configurations) {
      process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = askFirst;
      for (const [label, record] of states) {
        // Pending is governed by the ask-first value; a recorded answer governs
        // itself under either.
        const allowed = record === null ? askFirst === '0' : record;
        for (const [name, call] of primitives) {
          const cwd = dirs.make();
          process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'prefs.json');
          fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
          if (record !== null) recordPluginUseChoice(cwd, record, 'test');
          resetPluginUseCache();
          drainStateWrites();

          const where = `${name} under "${label}", TRAFFIC_ONE_ASK_USE_PLUGIN=${askFirst} (${note})`;
          const target = path.join(cwd, '.traffic-one', `${name}.dat`);
          assert.equal(
            call(target), allowed,
            `${where}: the durable append must not be a hole in the fence, and must not be `
            + 'stricter than its siblings either — a primitive that refuses where the others write is a '
            + 'deadlock waiting for the one caller that needs it before consent exists',
          );
          assert.equal(fs.existsSync(target), allowed, `${where}: file presence must match the answer`);
          const reported = drainStateWrites().filter((write) => write.path === target);
          assert.equal(reported.length, 1, `${where}: the attempt must be REPORTED either way`);
          assert.equal(reported[0]!.ok, allowed);
          if (!allowed) {
            assert.equal(
              reported[0]!.errno, 'consent-fence',
              `${where}: and it must say WHY. Reporting is the other half of what reaching `
              + 'past the guarded writer would have dropped',
            );
          }
        }
      }
    }
  } finally {
    if (savedAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = savedAsk;
    resetPluginUseCache();
  }
});

/**
 * A suite that asks the consent fence a question must SAY which answer it is
 * asking under.
 *
 * The parity row above spent a round asserting three cells of a configuration
 * that does not ship, and nothing could have told it: `src/build/test-preload.mjs`
 * hands every one of ~290 test files `TRAFFIC_ONE_ASK_USE_PLUGIN='0'`, so a file
 * that never mentions the variable still gets an answer — the opposite of the
 * product default — and reads it as the fence's behaviour. Meanwhile
 * `state/__tests__/consent-write-fence.test.ts` pins '1' locally and calls it the
 * shipped default. One tree asserting both behaviours of one state, with only one
 * of the two naming its dependency.
 *
 * The GLOBAL default is deliberately not flipped: that is a change to every
 * fixture project in the repository. This is the narrow enforcement instead —
 * whoever reads the fence declares the configuration, and the file that forgets
 * fails here with the variable named rather than passing under a value it never
 * chose.
 *
 * Deliberately NOT "every test that writes state". Almost every fixture in the
 * suite writes under `.traffic-one/` and is therefore behind the fence; requiring
 * all of them to declare would be a 290-file ceremony that nobody reads. The
 * population is the files that assert on the fence's OWN ANSWER: they name a
 * decision function, or they assert the `consent-fence` errno. For those the
 * value is not background, it is the subject.
 */
/**
 * A file that ASKS the fence something. Widened twice, by measurement rather
 * than by taste, and the boundary it stops at is worth recording because the
 * next reader will want to cross it.
 *
 * `pluginUseEnabled` and `removeDeclinedProjectArtifacts` are questions put to
 * the fence's own module, and adding them cost exactly one new file — the
 * dedicated suite for that module, `state/__tests__/plugin-use.test.ts`, which
 * decides the fence's answer for a living and named no value at all. A suite
 * about the decider itself escaping a guard about the decider is the worst
 * offender this scan can have.
 *
 * The reader family (`readPluginUseChoice`, `pluginUseDeclined`) is IN as of this
 * round, and what it cost was RE-MEASURED here rather than carried over from the
 * round that deferred it: the population goes 9 → 12 of 422 test files, and two
 * of the three newcomers were silent —
 * `runners/onboarding-wait/__tests__/wait.test.ts` (the lane the earlier round
 * was fenced out of) and `shared/__tests__/path-spelling-contract.test.ts`. The
 * third, `shared/materialize/__tests__/materialize-writer.test.ts`, already
 * pinned '1' and needed nothing. Both newcomers now run their fence reads under
 * BOTH values, because that is what their subject asks for: they read the
 * RECORDED CHOICE out of the per-user machine bucket, which
 * `projectRootForStatePath` never fences, so the ask-first value governs nothing
 * either of them asserts — a claim that is now asserted twice a run instead of
 * assumed. Neither was passing vacuously; a module-scope pin of '1' in the
 * runner suite would have been the wrong remedy anyway, since 7 of its other 24
 * tests stage a project with no recorded answer and write through the fence.
 *
 * `recordPluginUseChoice` stays OUT, and it is the wrong rule rather than merely
 * an expensive one — it is also more expensive than this docblock used to say:
 * re-measured it is 53 files, 26 of them silent, +41 over the population above
 * rather than the TWENTY-NINE measured on an older tree. Recording consent for a
 * fixture is not asking the fence anything; it is the very remedy the failure
 * message below offers ("either record consent for the fixture or pin '0'"), so
 * a scan that flagged it would contradict its own instruction. What that
 * spelling WOULD catch — a file that records consent for one fixture family and
 * silently inherits the preload for the rest, with a header crediting the
 * preload for it — needs a rule about per-fixture declaration, which this
 * whole-file scan cannot express and which widening the vocabulary does not
 * close.
 */
const FENCE_DECIDER = /(?<!['"`])\b(?:projectStateWriteAllowed|projectWritesPermitted|projectStateWritable|askUsePluginFirst|ASK_USE_PLUGIN_FIRST|pluginUseEnabled|removeDeclinedProjectArtifacts|readPluginUseChoice|pluginUseDeclined)\b(?!['"`])/;
const FENCE_ERRNO = /errno[^\n]*['"]consent-fence['"]|['"]consent-fence['"][^\n]*errno/;
const ASK_FIRST_ENV = 'TRAFFIC_ONE_ASK_USE_PLUGIN';

/** Read CODE, not documentation: a file that merely DISCUSSES the fence (this
 *  docblock names three decision functions) is not asking it anything. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') testFiles(abs, out);
    } else if (entry.name.endsWith('.test.ts')) out.push(abs);
  }
  return out;
}

test('a suite that reads the consent fence names the ask-first value it reads it under', () => {
  const src = path.resolve(__dirname, '..', '..');
  const repo = path.dirname(src);
  const silent: string[] = [];
  const population: string[] = [];
  for (const file of [...testFiles(src), ...testFiles(path.join(repo, 'tests'))]) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    if (!FENCE_DECIDER.test(code) && !FENCE_ERRNO.test(code)) continue;
    const rel = path.relative(repo, file).split(path.sep).join('/');
    population.push(rel);
    if (!code.includes(ASK_FIRST_ENV)) silent.push(rel);
  }

  // FIXTURE READBACK — a broken pattern scans nothing and passes empty. THIS
  // file and the dedicated fence suite must both be in the population, and they
  // exercise the two detectors separately: this one asserts the errno, that one
  // calls the decision function.
  assert.ok(
    population.includes('src/shared/__tests__/durable-writer-rule.test.ts'),
    `FIXTURE the errno detector must find this very file, found ${JSON.stringify(population)}`,
  );
  assert.ok(
    population.includes('src/shared/state/__tests__/consent-write-fence.test.ts'),
    'FIXTURE the decision-function detector must find the dedicated fence suite',
  );

  assert.deepEqual(
    silent, [],
    `a test file asks the consent fence for its answer and never sets ${ASK_FIRST_ENV}, so it is being `
    + `answered by src/build/test-preload.mjs's '0' — the OPPOSITE of the shipped ASK_USE_PLUGIN_FIRST. `
    + 'Set the value the assertions mean, at module scope or around the assertion, and say which it is. '
    + 'If the file means the shipped behaviour it wants \'1\'; if it means a project the user already '
    + 'said yes to, either record consent for the fixture or pin \'0\' and say so. Inheriting is the one '
    + 'option that produced a ratified claim about a security control that was false under what ships.',
  );
});

// ── the multiplier the affordability argument rests on ───────────────────────
//
// COUNTS, NOT MILLISECONDS. The per-call cost is a filesystem barrier and
// asserting it here would be a flaky timing test on shared CI hardware; the
// number that decides whether durability-for-everyone is affordable is how many
// times a single hook invocation calls `writeJson`, and that is deterministic.
//
// Read from the only two surfaces that hold the whole population: the decision
// record's own `stateWrites` (core/pipeline.ts drains the buffer at settle and
// writes it there) plus a post-run drain for the writes that happen after it.
// Draining ONLY after the run is what produced both of the wrong figures this
// file used to carry — it sees three of ten writes and one of five `writeJson`
// calls.

interface LoggedWrite { readonly op: string; readonly path: string }

function decisionRecordWrites(cwd: string, runId: string): LoggedWrite[] {
  const logPath = path.join(cwd, '.traffic-one', 'runs', runId, 'debug', 'decisions.jsonl');
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => (JSON.parse(line) as { stateWrites?: LoggedWrite[] }).stateWrites ?? []);
}

test('a floor-case denying PreToolUse makes five writeJson calls, and that is the multiplier', async () => {
  const cwd = dirs.make();
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'prefs.json');
  process.env.XDG_STATE_HOME = path.join(cwd, 'machine-state');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'thin' }), 'utf8');
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', onboardingComplete: true, currentRunId: RUN_ID, stack: 'default',
  }), 'utf8');
  recordPluginUseChoice(cwd, true, 'test');

  const handlers: Handler[] = [{
    id: 'durable-rule.deny',
    event: 'PreToolUse',
    priority: 0,
    run: () => deny('traffic-one — floor-case fixture: refused so the invocation is a DENYING one.', {
      denyId: 'plan-gate',
    }),
  }];
  const invocation = {
    stdin: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd,
      tool_input: { file_path: path.join(cwd, 'src', 'main.ts'), content: 'x' },
    }),
    argv: [] as string[],
  };

  // Two warm invocations first: the first one materializes, and the floor case
  // is the STEADY state a run spends its life in, not the one-off first hook.
  await dispatch(codexAdapter, handlers, invocation);
  await dispatch(codexAdapter, handlers, invocation);
  const logPath = path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'debug', 'decisions.jsonl');
  fs.writeFileSync(logPath, '', 'utf8');
  drainStateWrites();

  await dispatch(codexAdapter, handlers, invocation);
  const observed = [...decisionRecordWrites(cwd, RUN_ID), ...drainStateWrites()];

  // FIXTURE READBACK — an invocation that recorded nothing would pass the
  // count assertion below vacuously in the direction that matters.
  assert.ok(observed.length >= 5, `FIXTURE the invocation must record state writes, got ${observed.length}`);

  const writeJsonCalls = observed.filter((write) => write.op === 'write-json').length;
  assert.equal(
    writeJsonCalls, 5,
    'the floor case\'s writeJson count is the multiplier on the +8.8 ms per-call barrier, and it is the '
    + 'whole affordability argument for keeping writeJson atomic (fsjson.ts writeJsonDurable). It moved: '
    + 'FEWER calls means the cost of durability-for-everyone is lower than the docblock claims and the '
    + 'deviation deserves re-arguing; MORE means it is higher. Re-measure and update both, do not just '
    + `bump this number. Recorded ops: ${JSON.stringify(observed.map((write) => write.op))}`,
  );
  assert.equal(
    observed.filter((write) => write.op === 'write-json-durable').length, 0,
    'nothing on the floor-case hook path may reach the durable writer — the durable set is two '
    + 'artifacts, neither of which a denying PreToolUse publishes',
  );
});
