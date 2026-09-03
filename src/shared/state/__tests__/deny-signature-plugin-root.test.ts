// The deny-repeat signature is the rendered message byte for byte, and the
// rendered message can name things that MOVE FOR REASONS THE AGENT DID NOT
// CAUSE. Two such inputs are known and both are folded out before signing
// (deny-repeat.ts `signatureText`); this file pins both, and scans for a third.
//
//   1. THIS INSTALL'S LOCATION. Several escalatable denies hand the agent a
//      runnable command built from `pluginRoot()` — an environment-supplied
//      absolute path — so a version-keyed cache directory, a `plugin:sync` or a
//      restart onto a second host rewrote the key of a loop that had not
//      changed. Measured before the fold (this file's first test, inverted):
//      counts 1,2,1,2,3 across a version bump and 1,1,2,2,3,3,4,4 with two
//      hosts alternating — escalation on the fifth identical refusal instead of
//      the third, permanently in the second case.
//
//   2. A LIVE WIZARD SERVER'S ADDRESS. `claude-wait-background-denied`
//      interpolates `Open Traffic One setup: <dashboardUrl>`, whose port is
//      ephemeral and whose token is minted per server instance — and the line
//      is ABSENT entirely when no server is alive. Measured here (the wizard
//      test below, inverted): one unchanged loop of five draws with a restart
//      between draws 2 and 3 and a dead server at draw 5 signs THREE keys and
//      never escalates.
//
// A count that never reaches the threshold reads exactly like an agent making
// progress, so both failures are silent in the one direction the counter exists
// to catch.
//
// ── WHY THE KEY WAS NOT MOVED TO (denyId, denyTarget) INSTEAD ────────────────
// That would retire the whole class in one move, so it was measured rather than
// argued. NO FIGURES ARE RESTATED HERE, deliberately: they used to be, and this
// file's copy disagreed with deny-repeat.ts's on the same page (55 escalatable
// ids on one line, 56 on another) while both disagreed with the artefacts. There
// is exactly one copy now — the table in deny-repeat.ts's `denySignature`
// docblock — and section 4 below recomputes every entry in it and fails with the
// current numbers printed. Read the table there; do not add a second one here.
//
// Over the replay corpus, no (denyId, denyTarget) pair carried more than one
// distinct rendered reason — and that is NOT evidence, because the corpus cannot
// express the collision for all but two of those pairs: only
// `apply-patch-payload-invalid` (empty target, two cases) and `one-mcp-tool-gate
// :: tool-name` (three) are fired by more than one case at all. A corpus that
// draws one deny per pair reports "no pair carried two reasons" whatever the
// truth is. An earlier version of this note said the corpus fires each id in
// exactly one scenario; that is the claim those two pairs disprove.
//
// What the corpus DOES report is decisive on its own: a sixth of its escalatable
// deny rows carry an EMPTY target, spread over eleven escalatable ids, so for
// those ids the key degenerates to one bucket per gate. `spawn-role-conflict` is
// the shape that settles it — empty target, and its prose interpolates
// `{{CANDIDATES}}`, the conflicting identity evidence that IS the subject of the
// refusal. Driven: two different conflicts count 1,1,2 today and would count
// 1,2,3 under the proposed key, escalating on an agent that changed subject
// every attempt. That is the false positive deny-repeat.ts's header calls worse
// than never firing at all. The empty-target version of that measurement is
// pinned below, beside the existing one that varies the target — which, alone,
// would NOT have caught it.
//
// ── THE RECORDED DEAD END: populating those eleven targets ──────────────────
// The obvious repair to the paragraph above is to give the eleven a target, and
// then the tuple key is safe. It is not: thirteen of the ids the corpus fires
// have a populated target whose prose still varies on something that target is
// not, and ZERO have a target covering everything their prose renders. The
// eleven are a symptom; the property the tuple needs is that the target fully
// discriminates the refusal, and nothing observed has it.
//
// The table below is kept because the work was done and is worth not repeating,
// NOT because it is a plan. Populating a target is independently worth doing —
// `denyTarget` is already half of today's key and it feeds the decision log and
// the escalation prose — and each row is written to be DISCRIMINATING (two
// genuinely different refusals differ) and STABLE (nothing machine-local,
// ephemeral or version-bearing, so the target cannot reintroduce the very class
// the folds below exist to close). Three of the eleven can only be populated
// inside `modules/plan-guard/**`.
//
//   spawn-role-conflict          the conflicting ROLE NAMES, deduplicated and
//     modules/agent-model/         sorted, `+`-joined. The `{{CANDIDATES}}`
//     handler.ts:86                subject with the evidence SOURCE dropped —
//                                  the same conflict re-detected through a
//                                  different tier is the same refusal. Role
//                                  names are a closed product vocabulary.
//   spawn-child-cannot-mint-run  the child's resolved role, else `subagent`.
//     …/handler.ts:131             Closed vocabulary.
//   browser-open-denied          the opener verb (`open`/`xdg-open`/`start`).
//     modules/onboarding-gate/     The refusal is "do not open it yourself"
//     handler.ts:316               whatever URL followed. NOT the observed
//                                  command, which carries the wizard URL.
//   claude-wait-background-      `bootstrap` or `wait` — which onboarding
//     denied  …:304                command was backgrounded. Two literals. NOT
//                                  URL_LINE (port+token) or WAIT_CMD (install-
//                                  rooted): both are the folded class below.
//   repaired-materialization     the literal `.traffic-one`. Exactly one
//     …:717                        refusal — the prose has no placeholders and
//                                  repeats byte-identically by construction.
//   team-mode-marker-guard       the marker path, PROJECT-RELATIVE, so it
//     …:243                        survives a project move.
//   team-mode-downgrade-guard    the mode transition (`team->solo`). The file
//     …:246                        is always `.one.json`, so the transition is
//                                  the only thing that varies.
//   tech-classify-required       the literal `tech-detect`. NOT `{{HINTS}}`,
//     …:336, modules/session/      which is derived from codebase detection and
//     prompt-submit.ts:270         therefore MOVES as the agent edits the repo —
//                                  a value that changes while the refusal does
//                                  not is a third member of the volatile class.
//   apply-patch-payload-invalid  tool name + a normalized failure CLASS
//     modules/session/             (`apply_patch:no-file-path`). The classes are
//     workspace-boundary-          few and their remedies differ. NOT the raw
//     guard.ts:160,                parse error, which quotes payload bytes.
//     authoring-guard.ts:72,       (third site is under plan-guard)
//   opencode-external-temp-shell the external ROOT only (`/tmp`,
//     plan-guard/plan-write/       `/private/tmp`, `/var/tmp`). NOT the full
//     index.ts:373                 path, which carries a run id.
//   registry-probe-gate          the probing subcommand, normalized
//     …/index.ts:429               (`npm view`, `pnpm view`, `yarn info`).
//
// One-time cost, for whoever takes this up: changing what a signature keys on
// resets existing escalation counters once, and so does adding a target to an
// id that had none, because `denyTarget` is already part of this key. Both are
// one-time and neither can escalate spuriously — a reset only ever DELAYS.
//
// Five things are pinned here and they fail for different reasons:
//   1. the install-location FOLD works — one loop, one key, across a moved root;
//   2. the wizard-link FOLD works — across a restart AND a dead server, with
//      each of its anchors and its token floor observable on its own;
//   3. the real reason-producing helpers still carry a root, so a future
//      refactor that stops interpolating one does not leave test 1 passing
//      vacuously against text that never had a path in it;
//   4. the mechanical scan for a THIRD volatile input, over every escalatable
//      id's shipped prose and every source file that can render one;
//   5. the DERIVATION of every figure the dead-end argument records.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  denyRepeat,
  denySignature,
  isFilesystemRoot,
  isBareLinkLine,
  signatureText,
  withoutInstallLocation,
  withoutWizardLink,
} from '../deny-repeat';
import { recordPluginUseChoice } from '../plugin-use';
import { isNativeState } from '../web';
import { DENY_IDS, NEVER_OVERRIDABLE_DENY_IDS, isEscalatableDenyId } from '../../../config/deny-ids';
import type { Ctx } from '../../../core/types';
import { ensureArchitectureRunSnapshot } from '../../architecture-contract';
import { planStaticViolations } from '../../../modules/plan-guard/plan-static';
import { scaffoldGate } from '../../../modules/plan-guard/scaffold-gate';
import { SKILL_FALLBACKS } from '../../skill-fallbacks.generated';
import { modelCaptureCommand } from '../../model-gate-command';
import {
  onboardingSetTechCommandTemplate,
  onboardingWaitCommand,
} from '../../onboarding-server/wait-command';
import { trackedTempDirs } from '../../../test-support/__tests__/temp-dirs';

const RUN_ID = 'R';

// Two REAL layouts for one machine, not two arbitrary strings: a version-keyed
// managed cache (what `plugin:sync` bumps) and the second host's own cache
// (Cursor imports the `~/.claude` user-scope bundle, Codex keeps its own).
const ROOT_V1 = '/Users/dev/.claude/plugins/cache/traffic-one/1.0.43';
const ROOT_V2 = '/Users/dev/.claude/plugins/cache/traffic-one/1.0.44';
const ROOT_CODEX = '/Users/dev/.codex/plugins/cache/traffic-one/1.0.43';

const dirs = trackedTempDirs('t1-deny-root-');
const savedEnv = {
  root: process.env.TRAFFIC_ONE_PLUGIN_ROOT,
  prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
  state: process.env.XDG_STATE_HOME,
};

after(() => {
  for (const [key, value] of Object.entries({
    TRAFFIC_ONE_PLUGIN_ROOT: savedEnv.root,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: savedEnv.prefs,
    XDG_STATE_HOME: savedEnv.state,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  dirs.cleanup();
});

function freshProject(): string {
  const dir = dirs.make();
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  // Consent and the per-user bucket both live outside the project; pin them
  // inside our own root so nothing here reads or writes real machine state.
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.XDG_STATE_HOME = path.join(dir, 'machine-state');
  recordPluginUseChoice(dir, true, 'test');
  return dir;
}

function withRoot<T>(root: string, fn: () => T): T {
  const saved = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = root;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved;
  }
}

/** `tech-classify-required` as onboarding-gate/handler.ts renders it. */
function techClassifyReason(cwd: string): string {
  return 'traffic-one — setup required: the stack could not be detected. Inspect the repo, '
    + `then run:\n${onboardingSetTechCommandTemplate(cwd, 'claude')} --frontend=<id> --backend=<id>`;
}

function counts(cwd: string, roots: readonly string[]): { counts: number[]; escalatedAt: number } {
  const seen: number[] = [];
  let escalatedAt = -1;
  for (const [index, root] of roots.entries()) {
    const repeat = withRoot(root, () => denyRepeat(cwd, RUN_ID, {
      reason: techClassifyReason(cwd),
      denyTarget: '',
      denyId: 'tech-classify-required',
    }));
    seen.push(repeat.count ?? -1);
    if (escalatedAt < 0 && repeat.suffix !== '') escalatedAt = index + 1;
  }
  return { counts: seen, escalatedAt };
}

function counterKeys(cwd: string): string[] {
  const file = path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'debug', 'deny-repeats.json');
  return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>);
}

// ── 1. the fold ──────────────────────────────────────────────────────────────

test('a plugin-root move does not restart the count: one loop, one key', () => {
  const cwd = freshProject();
  const observed = counts(cwd, [ROOT_V1, ROOT_V1, ROOT_V2]);

  assert.deepEqual(
    observed.counts, [1, 2, 3],
    'the third identical refusal must escalate even though the install moved between attempts 2 and 3. '
    + `Measured without the fold: [1,2,1,2,3]. Got ${JSON.stringify(observed.counts)}`,
  );
  assert.equal(observed.escalatedAt, 3, 'escalation lands on the attempt the threshold names');
  assert.deepEqual(counterKeys(cwd).length, 1, 'one loop must not occupy two of the 64 tracked keys');
});

test('two hosts alternating over one project are one loop', () => {
  const cwd = freshProject();
  // The shape that never heals on its own: no version bump, just a project
  // worked from two hosts whose bundles live in different caches.
  const observed = counts(cwd, [ROOT_V1, ROOT_CODEX, ROOT_V1, ROOT_CODEX]);

  assert.deepEqual(
    observed.counts, [1, 2, 3, 4],
    `measured without the fold: [1,1,2,2,...]. Got ${JSON.stringify(observed.counts)}`,
  );
  assert.equal(observed.escalatedAt, 3);
  assert.equal(counterKeys(cwd).length, 1);
});

test('the fold does not merge two genuinely different refusals', () => {
  const cwd = freshProject();
  // Everything the counter is FOR still has to work: two subjects under one
  // gate stay two counts, and neither reaches the threshold on the other's
  // attempts.
  const refuse = (target: string): number => withRoot(ROOT_V1, () => denyRepeat(cwd, RUN_ID, {
    reason: 'traffic-one — run-team enforcement gate: this file belongs to another role.',
    denyTarget: target,
    denyId: 'run-team-wrong-role',
  }).count ?? -1);

  assert.equal(refuse('apps/web/src/a.tsx'), 1);
  assert.equal(refuse('apps/web/src/b.tsx'), 1, 'a second file is a second loop');
  assert.equal(refuse('apps/web/src/a.tsx'), 2);
  assert.equal(counterKeys(cwd).length, 2);
});

test('the TARGET is folded too, and a root-bearing subject is where that shows', () => {
  const cwd = freshProject();
  // Every other fold row above varies the REASON, so all of them stay green
  // with the target passed through raw — measured: removing `signatureText`
  // from the target survived both suites. This row is the one that cannot.
  //
  // `authoring-guard` (modules/session/authoring-guard.ts) refuses a write to
  // the plugin's OWN tree and passes that absolute path as `denyTarget`, while
  // its reason names no path at all. The signature is `target::reason`, so an
  // unfolded target reintroduces through the subject exactly what the reason no
  // longer carries: a `plugin:sync` between two attempts restarts the count, in
  // the silent direction, because a count that never reaches the threshold
  // reads like an agent making progress.
  const refuse = (root: string): number => withRoot(root, () => denyRepeat(cwd, RUN_ID, {
    reason: 'traffic-one — this file belongs to the Traffic One plugin itself. Edit it in the plugin '
      + 'source repository and re-sync; the installed copy is generated.',
    denyTarget: `${root}/skills-catalog/refactor/SKILL.md`,
    denyId: 'authoring-guard',
  }).count ?? -1);

  assert.equal(refuse(ROOT_V1), 1, 'FIXTURE this id must be counted at all, or the row proves nothing');
  assert.equal(refuse(ROOT_V1), 2);
  assert.equal(
    refuse(ROOT_V2), 3,
    'the same file refused for the same reason across a version bump is one loop. With the target '
    + 'unfolded this is 1 again, and the agent is never told it is looping.',
  );
  assert.equal(
    counterKeys(cwd).length, 1,
    'and one loop must occupy ONE of the 64 tracked keys, not one per install location',
  );
});

test('two different refusals under one id with an EMPTY target are still two loops', () => {
  // The test above varies the TARGET, so it stays green under a signature keyed
  // on (denyId, denyTarget) — and that key is the standing proposal for
  // retiring the folds in this file. Twelve of the sixty-two escalatable deny
  // rows in the replay corpus carry no target at all (derived in section 4, not
  // restated), and for those the proposed key is one bucket per gate. This is
  // that population: `spawn-role-conflict` is escalatable,
  // sets no target, and names the conflicting identity evidence — the SUBJECT
  // of the refusal — inside the prose.
  const cwd = freshProject();
  const reason = (candidates: string): string =>
    'Traffic One spawn identity gate: this spawn carries conflicting valid Traffic One role evidence in '
    + `the same highest-priority tier: ${candidates}. The spawn was blocked before a child started.`;
  const refuse = (candidates: string): number => withRoot(ROOT_V1, () => denyRepeat(cwd, RUN_ID, {
    reason: reason(candidates), denyTarget: '', denyId: 'spawn-role-conflict',
  }).count ?? -1);

  assert.deepEqual(
    [refuse('senior-architect, senior-frontend'), refuse('tester, shipper'), refuse('senior-architect, senior-frontend')],
    [1, 1, 2],
    'a signature that stopped reading the rendered reason would count these 1,2,3 and escalate on the '
    + 'third — telling an agent that changed subject every attempt to report BLOCKED. The rendered text '
    + 'is what the agent can see, and whose loop this is measures.',
  );
  assert.equal(counterKeys(cwd).length, 2, 'two subjects, two keys, from one id and one (empty) target');
});

test('a degenerate plugin root cannot collapse unrelated refusals', () => {
  // `pluginRoot()` resolves, so it is never relative and never empty — but it
  // CAN be the filesystem root (a `TRAFFIC_ONE_PLUGIN_ROOT=/` in a container
  // entrypoint, or a `__dirname` two levels below `/`). Substituting that would
  // rewrite the leading separator of every absolute path in the message and
  // make two refusals about two different files one key.
  //
  // Asserted on the fold directly: a plugin root of `/` puts every temp fixture
  // inside the authoring repo, so the counter declines to count before the fold
  // is reached and this case cannot be driven through `denyRepeat`.
  const folded = (file: string): string => withRoot(path.sep, () => withoutInstallLocation(
    `traffic-one — workspace boundary: ${file} is outside the opened workspace.`,
  ));

  assert.notEqual(
    folded('/etc/hosts'), folded('/usr/local/bin/x'),
    'a root of `/` must not fold two absolute paths into one key',
  );
  assert.equal(
    folded('/etc/hosts'), 'traffic-one — workspace boundary: /etc/hosts is outside the opened workspace.',
    'and must not rewrite the message at all',
  );
  // The non-degenerate control, so the row above cannot pass because the fold
  // stopped working everywhere.
  assert.equal(
    withRoot(ROOT_V1, () => withoutInstallLocation(`run ${ROOT_V1}/scripts/x.cjs`)),
    'run <plugin-root>/scripts/x.cjs',
  );
});

test('the degenerate-root guard is a root-EQUALITY test, so it catches the Windows shapes too', () => {
  // Asserted on the predicate rather than through the fold, because a POSIX
  // `path.resolve('C:\\')` is not a root at all (it anchors under the process
  // cwd), so the Windows spellings are unreachable through `pluginRoot()` from
  // a test running here. Windows is a supported platform and the old spelling
  // — `root.length <= 1 || root === path.sep` — recognised neither a drive root
  // nor a UNC share root, both of which prefix every absolute path on that
  // platform exactly the way `/` does here.
  for (const degenerate of ['/', 'C:\\', 'C:/', 'c:\\', '\\\\srv\\share', '', 'x']) {
    assert.equal(isFilesystemRoot(degenerate), true, `${JSON.stringify(degenerate)} IS a filesystem root`);
  }
  for (const real of [
    '/Users/dev/.claude/plugins/cache/traffic-one/1.0.43',
    'C:\\Users\\dev\\.claude\\plugins\\cache\\traffic-one',
    '\\\\srv\\share\\traffic-one',
    '/var',
  ]) {
    assert.equal(isFilesystemRoot(real), false, `${JSON.stringify(real)} is a real install location`);
  }
});

// ── 1b. the second volatile input: a live wizard server's address ────────────

/** `claude-wait-background-denied` as shared/onboarding-server/claude-setup.ts
 *  renders it: the setup-link line is present only while a server is alive. */
function waitBackgroundReason(urlLine: string, waitCommand: string): string {
  return [
    'This onboarding command was requested with run_in_background: true. A backgrounded run writes its '
    + 'output — including the setup link it prints — into a background task file the user never opens.',
    urlLine,
    'Post the setup link to the user in a CHAT MESSAGE, then re-run this SAME command in the FOREGROUND.',
    waitCommand,
  ].filter((line) => line !== '').join('\n\n');
}

// The onboarding server mints 32 random bytes and hex-encodes them
// (runners/onboarding-server/server.ts), so a REAL token is 64 hex characters.
// The fixtures here used `a1b2c3` and `abc`, which is shorter than any token the
// product can emit and shorter than the floor the pattern now enforces to keep a
// dev server's `?t=<timestamp>` cache-buster out of the fold. A fixture token
// that no server could mint proves nothing about the fold either way.
const TOKEN_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_B = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

const WIZARD_URL = (port: number, token: string): string =>
  `Open Traffic One setup: https://traffic.io/onboarding/agent#p=${port}&t=${token}`;
const WAIT_CMD = `node '${ROOT_V1}/scripts/onboarding-wait.cjs' '/tmp/proj' '--host=claude'`;

test('a wizard restart, and the wizard dying, do not restart the count: one loop, one key', () => {
  const cwd = freshProject();
  // One unchanged loop. The wizard server restarts between draws 2 and 3 (new
  // ephemeral port, new per-instance token) and is DEAD by draw 5, which is the
  // spelling a substitution alone would not fold: `urlLine` is '' when
  // `liveWizardLink` finds no live pid.
  const draws = [
    WIZARD_URL(51234, TOKEN_A), WIZARD_URL(51234, TOKEN_A),
    WIZARD_URL(60111, TOKEN_B), WIZARD_URL(60111, TOKEN_B),
    '',
  ];
  const observed = draws.map((line, index) => {
    const repeat = withRoot(ROOT_V1, () => denyRepeat(cwd, RUN_ID, {
      reason: waitBackgroundReason(line, WAIT_CMD),
      denyTarget: '',
      denyId: 'claude-wait-background-denied',
    }));
    return { count: repeat.count ?? -1, escalated: repeat.suffix !== '', draw: index + 1 };
  });

  assert.deepEqual(
    observed.map((row) => row.count), [1, 2, 3, 4, 5],
    'the wizard server restarts routinely and its port and token are minted per instance, so a restart '
    + 'between two draws of one unchanged loop must not rewrite the key. Measured without the fold: '
    + `three keys and no escalation at all. Got ${JSON.stringify(observed.map((row) => row.count))}`,
  );
  assert.equal(observed.find((row) => row.escalated)?.draw, 3, 'escalation lands on the attempt the threshold names');
  assert.equal(counterKeys(cwd).length, 1, 'one loop must not occupy three of the 64 tracked keys');
});

test('without the fold the same five draws are three keys — the measurement, inverted', () => {
  const raw = new Set([
    WIZARD_URL(51234, TOKEN_A), WIZARD_URL(51234, TOKEN_A),
    WIZARD_URL(60111, TOKEN_B), WIZARD_URL(60111, TOKEN_B), '',
  ].map((line) => denySignature('', [waitBackgroundReason(line, WAIT_CMD)])));
  assert.equal(raw.size, 3, 'FIXTURE the unfolded text really does carry three spellings of one loop');
});

test('the wizard fold takes a BARE link line, in both shapes and both fragment orders', () => {
  // The whole line goes, because the liveness flip is a second spelling the
  // substitution shape cannot reach. Both wizard shapes are covered: the hosted
  // deep link and the loopback fallback (config/dashboard.ts builds both from
  // the same port+token pair).
  assert.equal(
    withoutWizardLink(`before\nOpen Traffic One setup: https://traffic.io/onboarding/agent#p=1&t=${TOKEN_A}\nafter`),
    'before\nafter',
  );
  assert.equal(
    withoutWizardLink(`before\nOpen Traffic One setup: http://127.0.0.1:51234/local?t=${TOKEN_A}\nafter`),
    'before\nafter',
  );
  assert.equal(
    withoutWizardLink(`before\nDirect local fallback: http://127.0.0.1:51234/?t=${TOKEN_A}\nafter`),
    'before\nafter',
    'the loopback ROOT that redirects to the hosted page is the third URL agentOnboardingUrls builds',
  );
  // Nothing in the URL grammar fixes the order of the two fragment parameters,
  // and the pattern used to be written as if `p=` came first. A reader who
  // swapped them at the producer would not think of this file.
  assert.equal(
    withoutWizardLink(`before\nOpen Traffic One setup: https://traffic.io/onboarding/agent#t=${TOKEN_A}&p=1\nafter`),
    'before\nafter',
    'token-first is the same link and must fold the same way',
  );
  assert.equal(withoutWizardLink('nothing volatile here'), 'nothing volatile here');
});

test('the fold is anchored tightly enough that an echoed development-server URL survives', () => {
  // The anchor used to be "a URL carrying a `t` query parameter", and `t` is one
  // of the most common cache-buster names there is. Every row below is a URL an
  // agent's own command can legitimately carry into a deny, and every one of
  // them lost its whole line — merging two distinct refusals into one count.
  //
  // EACH ROW NAMES THE ANCHOR IT OBSERVES, because the earlier version of this
  // test did not and two anchors went unheld: every row used a token BELOW the
  // 16-character floor, so the floor alone killed all of them and removing the
  // loopback HOST anchor or the loopback PATH anchor changed nothing. The rows
  // that carry a 64-character token are the ones that reach the anchors, and they
  // are not contrived — a content hash or a git SHA under `?t=` is the ordinary
  // above-floor cache-buster (measured: eight such families all clear the floor).
  const anchored: readonly (readonly [anchor: string, text: string])[] = [
    ['no `t=` at all', 'traffic-one — the command `curl http://localhost:3000/health` is refused.'],
    ['the token FLOOR (13-digit Vite HMR stamp)',
      'traffic-one — the command `curl http://localhost:3000/app.js?t=1699999999999` is refused.'],
    ['the token floor (a two-digit stamp, and `t` is not the first parameter)',
      'traffic-one — the command `curl http://localhost:5173/search?q=cart&t=42` is refused.'],
    // Above the floor from here down: the floor cannot decide these, so exactly
    // one anchor is left holding each.
    ['the loopback HOST anchor',
      `traffic-one — the command \`curl http://dev.example.test:5173/local?t=${TOKEN_A}\` is refused.`],
    ['the loopback host anchor (a PUBLIC host that ends in a loopback-looking label)',
      `traffic-one — the command \`curl https://api.example.com/local?t=${TOKEN_A}\` is refused.`],
    ['the loopback PATH anchor (a real asset path on a loopback dev server)',
      `traffic-one — the command \`curl http://localhost:5173/assets/app.js?t=${TOKEN_A}\` is refused.`],
    ['the loopback path anchor (`/localhost` is not `/local`)',
      `traffic-one — the command \`curl http://127.0.0.1:5173/locale?t=${TOKEN_A}\` is refused.`],
    ['the hosted deep link\'s own PATH anchor (`/onboarding/agent` is not any path)',
      `traffic-one — the command \`curl https://traffic.io/docs#p=1&t=${TOKEN_A}\` is refused.`],
  ];
  for (const [anchor, echoed] of anchored) {
    assert.equal(
      withoutWizardLink(echoed), echoed,
      `an agent-supplied URL is the SUBJECT of the refusal, so folding it merges two different refusals. `
      + `This row is the only thing observing ${anchor}: the fold must match only the shapes `
      + 'config/dashboard.ts emits.',
    );
  }
  // …and the discrimination is real in both directions: two dev-server ports
  // stay two signatures.
  assert.notEqual(
    signatureText('refused: `curl http://localhost:3000/x?t=1`'),
    signatureText('refused: `curl http://localhost:4000/x?t=1`'),
  );
  // FIXTURE READBACK — the above-floor rows prove nothing unless the SAME URL
  // with the product's own host and path DOES fold. Otherwise a pattern that
  // stopped matching anything would pass every row above.
  assert.equal(
    withoutWizardLink(`Direct local fallback: http://127.0.0.1:5173/local?t=${TOKEN_A}`), '',
    'FIXTURE the product\'s own loopback shape, same token, must still fold',
  );
});

test('the wizard-token floor is pinned from both sides, at the character it claims', () => {
  // 16 is a compromise: the one minting site emits 64 (runners/onboarding-server/
  // server.ts, 32 random bytes hex-encoded) and the thing that must NOT match is a
  // timestamp — 13 digits for Vite's `?t=${Date.now()}`, 10 for a seconds epoch.
  // Nothing the product emits sits between 16 and 64, so the floor cannot be
  // observed from above by a REAL value; what pins it is the boundary itself,
  // which is the constant's own claim. Without this, raising the floor from 16 to
  // 40 changed no test in the suite.
  const local = (token: string): string => `Direct local fallback: http://127.0.0.1:51234/local?t=${token}`;
  const hex = (length: number): string => 'a1b2c3d4e5f60718'.repeat(8).slice(0, length);

  assert.equal(withoutWizardLink(local(hex(16))), '', 'a token AT the floor must fold');
  assert.equal(
    withoutWizardLink(local(hex(15))), local(hex(15)),
    'and one below it must not — this is the 13-digit timestamp family, with two characters of margin',
  );
  assert.equal(withoutWizardLink(local(hex(64))), '', 'the length the product actually mints must fold');
  assert.equal(
    withoutWizardLink(local('1699999999999')), local('1699999999999'),
    'the value the floor exists for: Vite\'s HMR cache-buster on the loopback root',
  );
});

test('a discriminating subject sharing the link line is never folded away, whatever it looks like', () => {
  // The rule used to decide drop-vs-substitute from the SHAPE of the remaining
  // text: under 100 characters, no backtick, no path separator, no `{{`. The
  // premise was that "every deny that names a file, a role or a command renders
  // it either backticked or as a path", and the shipped prose says otherwise —
  // `{{ROLE}}` is bare five times against 38 backticked, in four named blocks. So
  // these six subjects all read as labels and folded to the SAME empty string,
  // merging refusals that are not the same refusal. A bare identifier and a prose
  // label have no lexical difference; that is why the predicate is now a closed
  // list of the labels this product ships.
  const subjects: readonly (readonly [kind: string, a: string, b: string])[] = [
    ['a ROLE name', 'senior-frontend', 'senior-architect'],
    ['a RUN id', '2026-06-17T12-09-40Z', '2026-06-17T14-22-08Z'],
    ['a MEMBER id', 'apps-web', 'apps-mobile'],
    ['a bare FILENAME with no directory', 'LessonPage.tsx', 'CoursePage.tsx'],
    ['a HOST name', 'cursor', 'codex'],
    ['a STACK id', 'nextjs-supabase', 'expo-supabase'],
  ];
  for (const [kind, a, b] of subjects) {
    const render = (subject: string): string =>
      `setup required for ${subject}. Open Traffic One setup: https://traffic.io/onboarding/agent#p=51234&t=${TOKEN_A}`;
    const foldedA = signatureText(render(a));
    const foldedB = signatureText(render(b));
    assert.notEqual(
      foldedA, foldedB,
      `${kind} is the SUBJECT of the refusal and two of them are two loops. Both folded to `
      + `${JSON.stringify(foldedA)} — a false escalation, which this module ranks as worse than never `
      + 'firing at all.',
    );
    assert.ok(
      foldedA.includes(a) && foldedA.includes('<setup-link>'),
      `the subject must survive with the volatile URL still folded out: ${JSON.stringify(foldedA)}`,
    );
    // …and the fold's own job still gets done on that line: a restart moves the
    // port and the token and the two still sign as one loop.
    assert.equal(
      foldedA,
      signatureText(`setup required for ${a}. Open Traffic One setup: `
        + `https://traffic.io/onboarding/agent#p=60111&t=${TOKEN_B}`),
      `${kind}: keeping the line must not reintroduce the port and token it was folded for`,
    );
  }
});

test('the fold does not erase a subject that shares the link line', () => {
  // Whole-line dropping is what makes the liveness flip foldable, and it is also
  // what can take a discriminator with it. Driven before the narrowing: these
  // two folded to the SAME empty string and signed identically.
  const render = (file: string): string =>
    `traffic-one — setup required for \`${file}\`. Open Traffic One setup: `
    + `https://traffic.io/onboarding/agent#p=51234&t=${TOKEN_A}`;
  const a = signatureText(render('src/a.ts'));
  const b = signatureText(render('src/b.ts'));
  assert.notEqual(a, b, 'two refusals about two different files must not sign identically');
  assert.notEqual(denySignature('', [a]), denySignature('', [b]));
  assert.ok(a.includes('<setup-link>'), `the volatile URL is still folded out of the kept line: ${a}`);
  assert.ok(!a.includes(TOKEN_A) && !a.includes('51234'), 'neither the token nor the port may survive');
  // The same line at a different port and token is still ONE refusal.
  assert.equal(
    a,
    signatureText(`traffic-one — setup required for \`src/a.ts\`. Open Traffic One setup: `
      + `https://traffic.io/onboarding/agent#p=60111&t=${TOKEN_B}`),
    'the whole point of the fold survives the narrowing',
  );
});

test('every link line the product actually renders is recognised as BARE', () => {
  // The tripwire for the closed label list. `isBareLinkLine` decides drop-vs-
  // substitute, and the direction it can now get wrong is the SPLIT one: a prose
  // rewrite that changes a label stops the line being dropped, the dead-server
  // render omits the line entirely, and one loop becomes two keys with no
  // escalation ever arriving. Driven through the four renderers, and then — the
  // part that matters, because prose is what this codebase rewrites most — through
  // every `{{URL}}`-bearing line in the SHIPPED prose table, which is where the
  // labels are actually authored.
  const url = `https://traffic.io/onboarding/agent#p=51234&t=${TOKEN_A}`;
  const local = `http://127.0.0.1:51234/local?t=${TOKEN_A}`;
  const rendered = [
    // modules/onboarding-gate/handler.ts urlLine; shared/onboarding-server/codex-setup.ts
    `Open Traffic One setup: ${url}`,
    // shared/onboarding-server/windsurf-setup.ts
    `[Open Traffic One setup](${url})`,
    // shared/onboarding-server/wizard-links.ts localFallbackSection
    `If the hosted page is unavailable or returns 404, open the local wizard directly: ${local}`,
    // …localFallbackLine
    `Direct local fallback: ${local}`,
    // A line the link is ALL of — the only case where "removing it removes no
    // discriminator" is an identity rather than a claim about prose.
    url,
  ];
  for (const line of rendered) {
    assert.equal(
      withoutWizardLink(line), '',
      `this is a bare link line and must be dropped whole, or the dead-server render (which omits the `
      + `line entirely) signs differently from the live one: ${JSON.stringify(line)}`,
    );
  }

  // The shipped prose, mechanically. `{{URL}}` is the placeholder the wizard link
  // is interpolated into, so every line carrying it is a line this fold has to
  // decide about — including the four-space-indented one in `server-deny-reason`,
  // which is what the whitespace normalization in the predicate is for.
  const proseLines: string[] = [];
  for (const [key, body] of Object.entries(SKILL_FALLBACKS)) {
    for (const line of body.split('\n')) {
      if (!line.includes('{{URL}}')) continue;
      proseLines.push(`${key}\n    ${line}`);
      assert.equal(
        withoutWizardLink(line.split('{{URL}}').join(url)), '',
        `${key}: this shipped line carries the wizard link and is no longer recognised as one of the `
        + 'labels BARE_LINK_LABELS names, so it will be KEPT while the dead-server render omits it '
        + `entirely — one loop, two keys, escalation silently gone. Line: ${JSON.stringify(line)}. Either `
        + 'restore the label or add the new one to BARE_LINK_LABELS in deny-repeat.ts, having checked it '
        + 'carries no subject of its own.',
      );
    }
  }
  // FIXTURE READBACK — a renamed placeholder would scan nothing and pass.
  assert.ok(
    proseLines.length >= 5,
    `FIXTURE the shipped prose must carry several {{URL}} lines, found ${proseLines.length}`,
  );

  assert.equal(
    isBareLinkLine('Open Traffic One setup: <setup-link>'), true,
    'FIXTURE the predicate itself must accept the canonical label, or every row above passes for the '
    + 'wrong reason',
  );
  assert.equal(
    isBareLinkLine('setup required for `src/a.ts`. Open Traffic One setup: <setup-link>'), false,
    'a subject on the line is what says "there is a discriminator here"',
  );
  assert.equal(
    isBareLinkLine('Open the local wizard: <setup-link>'), false,
    'and a plausible REWRITE of a label is not one of the labels we ship — the safe direction, and the '
    + 'reason the scan above exists to name it',
  );
});

test('the whitespace the fold leaves behind is collapsed by denySignature', () => {

  // Dropping the line leaves a DIFFERENT number of blank lines than the
  // dead-server render does, and that is fine for exactly one reason worth
  // writing down: the two are compared after `denySignature`'s whitespace
  // normalization, never before it. Asserted rather than assumed, because the
  // whole liveness half of this fold rests on it.
  const live = signatureText(waitBackgroundReason(WIZARD_URL(51234, TOKEN_A), WAIT_CMD));
  const dead = signatureText(waitBackgroundReason('', WAIT_CMD));
  assert.notEqual(live, dead, 'FIXTURE the two folded texts differ in whitespace — that is what is being folded');
  assert.equal(
    denySignature('', [live]), denySignature('', [dead]),
    'a live wizard and a dead one must sign one key; denySignature collapses the blank-line difference',
  );
});

// ── 2. the population is real ────────────────────────────────────────────────

test('the escalatable denies that interpolate a command still carry the plugin root', () => {
  // Without this the fold could be pinned against prose that never had a path
  // in it, and every test above would keep passing while the hazard returned
  // through a helper somebody rewrote.
  const cwd = freshProject();
  const producers: readonly { readonly id: string; readonly render: (cwd: string) => string }[] = [
    // onboarding-gate/handler.ts, SET_TECH_TEMPLATE. Escalatable by explicit
    // ruling in config/deny-ids.ts ("pending on the AGENT, not the user").
    { id: 'tech-classify-required', render: (dir) => onboardingSetTechCommandTemplate(dir, 'claude') },
    // agent-model/handler.ts, CAPTURE_CMD.
    { id: 'cursor-models-capture', render: (dir) => modelCaptureCommand(dir, 'cursor') },
    // The same builder family, reached by several never-escalated onboarding
    // denies — carried here so the family is measured as a whole.
    { id: 'onboarding WAIT_CMD family', render: (dir) => onboardingWaitCommand(dir, 'claude') },
  ];

  for (const producer of producers) {
    const rendered = withRoot(ROOT_V1, () => producer.render(cwd));
    assert.ok(
      rendered.includes(ROOT_V1),
      `${producer.id}: the fixture assumes this command embeds the plugin root, and it no longer does. `
      + 'Either the hazard is gone (delete the fold and its tests, with a measurement) or the '
      + 'population moved to a helper this list does not name.',
    );
    assert.notEqual(
      rendered, withRoot(ROOT_V2, () => producer.render(cwd)),
      `${producer.id}: the two roots must render differently, or this row proves nothing`,
    );
  }
});

// ── 3. the scan for a THIRD volatile input ───────────────────────────────────
//
// Both folds above were added AFTER a loop had already failed to escalate, and
// the second one was found by reading 174 ids by hand. That is the part this
// section replaces: the prose used to claim outright that no other escalatable
// deny carries a volatile absolute path, and nothing checked it.
//
// Two scans, deliberately different in what they can see, and neither is a
// proof of the whole class — see the note at the end for what stays uncovered.

/**
 * Literal machine-local-LOOKING text in shipped prose, with the reason it is
 * inert.
 *
 * NOT A SUPPRESSION LIST, and the difference is the whole point of the scan: a
 * row here is a claim that the value is the SAME BYTES on every machine and in
 * every run, so it cannot move while the refusal stays the same and therefore
 * cannot split one loop into two keys. A value that only LOOKS constant does not
 * belong here — it belongs in a fold in deny-repeat.ts, and adding a row instead
 * is how this scan would be turned off one entry at a time. Every row carries
 * the argument at the row, so the next reader can check it rather than trust it.
 *
 * A row suppresses ITS OWN BYTES, plus trailing punctuation, and nothing else.
 * The match is not an equality because the scan's patterns are greedy to
 * whitespace and the prose closes these paths with a backtick — the `/var/tmp`
 * row really arrives as ``/var/tmp` ``. It was a bare `startsWith`, and that is a
 * different and wider claim: it suppressed every path BENEATH the row too, so
 * `/var/tmp/traffic-one-<runId>/scratch` would have been silently exempted by a
 * row whose whole argument is "the same bytes on every machine, in every run". No
 * shipped prose renders one today; `suppressedByConstantRow` below is what keeps
 * the claim the size of the row rather than the size of the subtree.
 */
const CONSTANT_LITERALS: Readonly<Record<string, string>> = {
  // A path the deny tells the agent NOT to write to. Constant prose, identical
  // on every machine and in every run — nothing here is derived from state.
  'opencode-external-temp-shell': '/var/tmp',
  // The product's own hosted dashboard origin, a compile-time constant
  // (config/dashboard.ts DEFAULT_DASHBOARD_URL). No port, no token.
  'supabase-local-stack-gate': 'https://traffic.io/',
  // The managed-runtime launcher paths, written with a LITERAL `~` in the prose
  // rather than interpolated from anything — the character is in the shipped
  // block, not a home directory that was expanded into it. That is the whole
  // argument: an EXPANDED home path is the volatile class (it is the install
  // location, differently spelled, and withoutInstallLocation folds it), while
  // an unexpanded tilde is the same six bytes everywhere and does not move when
  // the machine dir does. The prose is telling the agent where the runner lives
  // in a form it can paste, which is why it is written that way in the first
  // place. Both rows were invisible to the scan until the tilde pattern was
  // added, which is why they arrive here as a pair: the pattern set that could
  // not see the tilde could not see the shape the first fold exists for either.
  'opencode-plan-batch-required': '~/.traffic-one/bin/opencode-runner.cjs',
  'tester-qa-v2-gate': '~/.traffic-one/bin/qa-evidence-runner.cjs',
  'tester-qa-build-identity-missing': '~/.traffic-one/bin/qa-evidence-runner.cjs',
  'tester-qa-build-identity-mismatch': '~/.traffic-one/bin/qa-evidence-runner.cjs',
  // The tilde here is an ILLUSTRATION rather than the setting: the sentence
  // shows that an unreadable literal which does NOT spell the runs tree stays
  // permitted, and a tilde is the shortest unreadable head there is. A home
  // directory nobody's machine has to own is the point — respelling the root
  // would leave the sentence claiming a permission with nothing to permit.
  // Constant: an unexpanded tilde is the same bytes on every machine and does
  // not move when the home directory does.
  //
  // This row USED TO READ '~/.traffic-one/runs', excused on the ground that
  // "the path IS the finding" — the block disclosed a tilde-spelled path as one
  // the gate could not see. Write-detector round 10 refused all four tilde
  // spellings, so that literal left the prose entirely and this row sat
  // ORPHANED, suppressing nothing while still asserting a residue that no
  // longer exists. An excusal outlives the sentence it was written for unless
  // someone checks, and nothing here checks: the scan cannot report a row that
  // matches no text, so a stale row is invisible in exactly the direction that
  // matters.
  'runtime-sidecar-owner-gate': '~/Downloads/tmp',
};

/**
 * The spellings a machine-local value arrives in. The first five rows were the
 * whole list and they missed five real shapes, found by probing the scan rather
 * than by reading it — which is the same way both folds were found:
 *
 *   - `~/…`, the tilde home. This is the install-location shape the FIRST fold
 *     exists for, written the way a human writes it in prose
 *     (`~/.claude/plugins/cache/traffic-one/1.0.43`), so the pattern set that
 *     misses it misses the very thing it was added to catch;
 *   - `$HOME/…` and `${HOME}/…`, the same path deferred to the shell. A deny
 *     quoting a shell EXAMPLE has tripped this row three times now. Twice the
 *     resolution was to respell the root as a neutral placeholder
 *     (`$ELSEWHERE`) rather than to add a CONSTANT_LITERALS row: the example is
 *     about the SHAPE of an unresolvable root, so the identity of the variable
 *     carries nothing, and the tilde rows below are excused for the opposite
 *     reason — their path is content the prose has to hand the agent in a
 *     pasteable form. The third time SPLIT, and it is the case worth reading:
 *     one sentence carried both spellings because its whole point was that the
 *     two DIVERGE — a tilde path goes unseen where the `$HOME` spelling of the
 *     same path is refused. The `$HOME` half respelled (dropping the trailing
 *     slash is enough to leave this pattern, and the variable is named in prose
 *     either way), while the tilde half earned a row, because respelling the
 *     subject of a residue disclosure deletes the disclosure. So the question a
 *     row has to answer is not which spelling appeared but whether the bytes
 *     are the finding or the setting;
 *   - `/tmp/…`, which `/var/…` does not cover;
 *   - `\\server\share\…`, the Windows UNC form. It matters here rather than
 *     theoretically: `isFilesystemRoot` below has a UNC branch and the test
 *     under it asserts `\\srv\share\traffic-one` is a real install location, so
 *     the codebase explicitly supports that root and the scan was blind to it;
 *   - `localhost:<port>` / `127.0.0.1:<port>` with no scheme, which the
 *     `https?://` row cannot see and which is the wizard's own host and port.
 */
const MACHINE_LOCAL_LITERAL: readonly RegExp[] = [
  /\/Users\/\S+/g,
  /\/home\/\S+/g,
  /\/var\/\S+/g,
  // Anchored at the START of a path, or `.traffic-one/tmp/<runId>/` — a
  // project-relative path a deny legitimately recommends — reads as `/tmp/…`.
  /(?:^|[\s'"`([])\/tmp\/\S+/g,
  /(?:^|[\s'"`([])~\/\S+/g,
  /\$\{?HOME\}?\/\S+/g,
  /[A-Za-z]:\\\S+/g,
  /\\\\[A-Za-z0-9._-]+\\\S+/g,
  /https?:\/\/\S+/g,
  /\b(?:localhost|127\.0\.0\.1|\[::1\]):\d+\S*/g,
];

/** Is `matched` the constant row itself, closed by prose punctuation — and not
 *  something UNDER it? See CONSTANT_LITERALS for why this is not `startsWith`. */
function suppressedByConstantRow(matched: string, row: string | undefined): boolean {
  if (!row || !matched.startsWith(row)) return false;
  return /^[`'")\]}.,;:!?]*$/.test(matched.slice(row.length));
}

test('no escalatable deny ships prose carrying a machine-local literal', () => {
  const found: string[] = [];
  let scanned = 0;
  for (const [key, body] of Object.entries(SKILL_FALLBACKS)) {
    const id = key.split(' :: ')[1] ?? '';
    if (!isEscalatableDenyId(id)) continue;
    scanned += 1;
    for (const pattern of MACHINE_LOCAL_LITERAL) {
      for (const match of body.matchAll(pattern)) {
        if (suppressedByConstantRow(match[0].trim(), CONSTANT_LITERALS[id])) continue;
        found.push(`${id}: ${match[0]}`);
      }
    }
  }
  // FIXTURE READBACK — the suppression must be the size of the ROW. A bare
  // prefix test exempts the whole subtree beneath it, which is a claim no row
  // makes: a per-run path under `/var/tmp` is not the same bytes on every run.
  for (const [label, matched, row, expected] of [
    ['the row itself', '/var/tmp', '/var/tmp', true],
    ['the row as the prose closes it', '/var/tmp`', '/var/tmp', true],
    ['a per-run path BENEATH the row', '/var/tmp/traffic-one-51234/scratch`', '/var/tmp', false],
    ['a longer sibling of the row', '/var/tmpfoo', '/var/tmp', false],
    ['a row with no entry at all', '/var/tmp', undefined, false],
  ] as const) {
    assert.equal(
      suppressedByConstantRow(matched, row), expected,
      `FIXTURE ${label}: a constant row suppresses its own bytes and trailing punctuation, nothing more`,
    );
  }
  // FIXTURE READBACK — the patterns must be able to SEE the shapes they were
  // added for, or the deepEqual below passes because nothing matches anything.
  for (const [label, probe] of [
    ['tilde home', 'run `node ~/.claude/plugins/cache/traffic-one/1.0.43/x.cjs`'],
    ['$HOME', 'run "$HOME/.claude/plugins/cache/traffic-one/1.0.44/x.cjs"'],
    ['tmp', 'do not write to /tmp/traffic-one-51234'],
    ['UNC', 'run \\\\srv\\share\\traffic-one\\scripts\\x.cjs'],
    ['schemeless host:port', 'open localhost:51234/local?t=abc'],
    ['posix home', 'run /Users/dev/x'],
  ] as const) {
    assert.ok(
      MACHINE_LOCAL_LITERAL.some((pattern) => { pattern.lastIndex = 0; return pattern.test(probe); }),
      `FIXTURE the scan must match the ${label} spelling — it did not, so its row proves nothing`,
    );
  }
  // FIXTURE READBACK — a renamed table or a broken id predicate would scan
  // nothing and pass.
  assert.ok(scanned >= 100, `FIXTURE expected the shipped block table to carry many escalatable ids, scanned ${scanned}`);

  assert.deepEqual(
    found, [],
    'an escalatable deny ships prose with an absolute path or a URL in it. If the value is a CONSTANT '
    + '(the same bytes on every machine, in every run) add it to CONSTANT_LITERALS with that argument. '
    + 'If it is derived from this machine or from a live local server, it is a third member of the '
    + 'volatile class: fold it in deny-repeat.ts signatureText and pin it above, because a value that '
    + 'moves without the refusal changing splits one loop into two keys and escalation silently stops '
    + 'arriving.',
  );
});

/**
 * Every non-test source file that BOTH declares an escalatable deny id AND can
 * reach something naming this machine or a live local server, with what covers
 * it. A new entry is the signal: some gate can now render a value the signature
 * has not been shown to be stable against.
 */
const VOLATILE_PRODUCER_SITES: Readonly<Record<string, string>> = {
  // Renders `modelCaptureCommand` (CAPTURE_CMD) — install-rooted, folded by
  // withoutInstallLocation.
  'modules/agent-model/handler.ts': 'modelCaptureCommand, folded as the install location',
  // The whole onboarding family: install-rooted commands AND the wizard links.
  // Both folds live for this file.
  'modules/onboarding-gate/handler.ts': 'set-tech/wait commands and the wizard link, both folded',
  // The rest reach `pluginRoot` only as makeSkillBlock's SKILL.md resolver, so
  // nothing machine-local enters the prose — and if one ever interpolated the
  // root anyway, withoutInstallLocation already covers that value.
  'modules/plan-guard/plan-write/index.ts': 'pluginRoot as the skill-block resolver only',
  'modules/plan-guard/scaffold-gate.ts': 'pluginRoot as the skill-block resolver only',
  'modules/plan-guard/supabase-local-gate.ts': 'pluginRoot as the skill-block resolver only',
  'modules/session/authoring-guard.ts': 'pluginRoot as the skill-block resolver only',
  'shared/tool-scope.ts': 'pluginRoot as the skill-block resolver only',
  // ── reached, not declaring ─────────────────────────────────────────────────
  // The rows below carry no deny id of their own; they are the HELPERS the rows
  // above render through, and the one-file scan could not see any of them. That
  // is not a hypothetical hole: `claude-setup.ts` is the file that ASSEMBLES the
  // wizard text the second fold exists for, so moving the interpolation one
  // function outward — the ordinary refactor of pulling prose out of a
  // handler — silenced both scans at once while changing nothing about the
  // hazard.
  'shared/onboarding-server/claude-setup.ts': 'assembles the wizard text for the onboarding gate; link folded',
  'shared/onboarding-server/wizard-links.ts': 'builds the wizard URL and the local-fallback line; link folded',
  'shared/onboarding-server/ensure.ts': 'the wizard banner and the local fallback; link folded',
  // Per-host spelling of the same setup prose. Windsurf is still imported by
  // the onboarding handler; Codex/Cursor setup helpers are not, so they are
  // not a one-hop carrier from a declaring file.
  'shared/onboarding-server/windsurf-setup.ts': 'same carriers, currently non-escalatable ids; link folded',
  // Builds the install-rooted wait command the onboarding denies quote.
  'shared/onboarding-server/bootstrap.ts': 'the wait command, folded as the install location',
};

// Anything that can put THIS MACHINE's install location, or a LIVE LOCAL
// SERVER's address, into a string a gate might render.
const VOLATILE_PRODUCER = new RegExp('\\b(?:pluginRoot|dashboardUrlFromEnv|agentOnboardingUrls?|liveWizardLink'
  + '|localFallbackSection|localFallbackLine|onboardingWaitCommand|onboardingSetTechCommandTemplate'
  + '|modelCaptureCommand|dashboardUrl|localWizardUrl|redirectUrl)\\b');

// The names a produced value travels under once it crosses out of the file that
// produced it. This is what arm 2 needs and arm 1 never did: a prose helper one
// hop out does not CALL a producer, it RECEIVES what the producer returned.
// `claude-setup.ts` — the file that assembles the wizard text the second fold
// exists for — mentions no producer at all; it takes `urlLine`, `localFallback`
// and `waitCommand` and interpolates them, and moving the interpolation out of
// the handler into it is the ordinary refactor that made both scans blind.
const VOLATILE_CARRIER = /\b(?:urlLine|localFallback|LocalFallback|waitCommand|captureCommand)\b/;

// Both arms read CODE, not documentation. Without this, a file that merely
// discusses the hazard matches it: `deny-repeat.ts` names every producer above
// in the two fold docblocks and nowhere else, and it was in the scan's output
// for exactly that reason — a scan that flags its own explanation is measuring
// its own vocabulary.
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__') sourceFiles(abs, out); }
    else if (abs.endsWith('.ts') && !abs.endsWith('.test.ts')) out.push(abs);
  }
  return out;
}

/** The relative imports a file makes, resolved to absolute `.ts` paths. */
function relativeImports(file: string, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/from\s+'(\.[^']*)'/g)) {
    const base = path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, ''));
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate)) { out.push(candidate); break; }
    }
  }
  return out;
}

test('the set of gates that can render a machine-local value is the declared one', () => {
  // TWO ARMS, because one was not enough. The first arm is the original: a file
  // that BOTH declares an escalatable deny id and names a volatile producer. Its
  // blind spot is that the two halves have to be in the same file, and the
  // normal shape of this codebase is a handler that declares the id importing a
  // helper that builds the text — which is exactly where the wizard link is
  // built. The second arm follows one import hop out of every arm-1 file, which
  // is where a value has to come from to reach a deny reason in the first place.
  const declaring: string[] = [];
  const bodies = new Map<string, string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    bodies.set(file, text);
    if ([...text.matchAll(/denyId:\s*'([a-z0-9-]+)'/g)].some((m) => isEscalatableDenyId(m[1]))) {
      declaring.push(file);
    }
  }
  const sites = new Set<string>();
  const rel = (file: string): string => path.relative(SRC_ROOT, file).split(path.sep).join('/');
  for (const file of declaring) {
    const text = bodies.get(file)!;
    if (VOLATILE_PRODUCER.test(text)) sites.add(rel(file));
    for (const imported of relativeImports(file, text)) {
      const body = bodies.get(imported);
      if (body && VOLATILE_CARRIER.test(body)) sites.add(rel(imported));
    }
  }
  // FIXTURE READBACK — the two files the folds exist for must be in the scan's
  // own output, or the scan is not looking at anything.
  assert.ok(sites.has('modules/onboarding-gate/handler.ts'), 'FIXTURE the onboarding gate must be found');
  assert.ok(sites.has('modules/agent-model/handler.ts'), 'FIXTURE the model gate must be found');
  assert.ok(
    sites.has('shared/onboarding-server/claude-setup.ts'),
    'FIXTURE arm 2 must reach the file that assembles the wizard text — that gap is why it exists',
  );

  assert.deepEqual(
    [...sites].sort(), Object.keys(VOLATILE_PRODUCER_SITES).sort(),
    'a source file that declares an escalatable deny id can now also reach a value naming this machine '
    + 'or a live local server. Decide which: a value the signature already folds (the install location, '
    + 'a wizard link) needs only a row in VOLATILE_PRODUCER_SITES naming it; anything else needs a fold '
    + 'in deny-repeat.ts signatureText FIRST, because an unfolded one splits a loop into two keys and '
    + 'the escalation just stops arriving.',
  );
});

// ── 4. the recorded figures, DERIVED ────────────────────────────────────────
//
// deny-repeat.ts's `denySignature` docblock argues the (denyId, denyTarget) dead
// end from a measured partition of the escalatable ids, and said the table sat
// "beside the reproduction of the figures" HERE. There was no reproduction: only
// prose, in two inconsistent copies, and the numbers in them were wrong. The
// partition did not sum (four buckets adding to 41 against a stated population of
// 56), one file said 55 escalatable ids on one line and 56 on another, a case
// count of 133 had gone stale against 134 inside a working tree, and two adjacent
// figures — 122 counted denies and 24 of them — exceeded every population the
// artefact they were attributed to can produce (81 deny rows in the whole
// snapshot).
//
// Recording the withdrawal permanently was still right, and this finding argues
// FOR it: a record that is wrong today is a reason to make it derivable, not a
// reason to delete it. So every figure is recomputed here from the three
// artefacts that hold it — config/deny-ids.ts, the shipped prose table, and the
// replay-corpus snapshot — and the docblock's copy is asserted against the
// derivation. The next edit that moves a number turns this red with the new table
// printed, instead of silently invalidating a paragraph.
//
// ONE figure is a JUDGEMENT and is marked as one: whether a populated target
// carries everything its prose renders. That is not mechanically decidable — the
// snapshot records the target, not the rendered reason — and an automated pass
// that tried scored `absolute-traffic-one-path` as fully covered on name
// similarity, which manual review found wrong rather than the docblock: its
// corpus target is the offending FILE and its `{{BAD_PATHS}}` placeholder is the
// paths written INSIDE it. Name similarity is not coverage. So the derivation
// computes the population — the ids that have both a target and placeholders —
// and the verdict over it (zero covered) is recorded, with that population pinned
// by name so a new member cannot join it without review.

interface CorpusRow {
  readonly decision: string;
  readonly denyId: string;
  readonly target: string;
}

interface DerivedFigures {
  readonly [label: string]: number;
}

/**
 * The 13 ids the corpus fires with a POPULATED target AND placeholders in their
 * prose — the population BOTH reviewed verdicts in the derived table are about:
 * that zero of them have a target carrying everything their prose renders, and
 * that zero of them are RUN-FROZEN (whole placeholder set fixed once the run id
 * is minted, so the tuple key could not merge two different refusals of theirs
 * inside one run).
 *
 * EVERY member's placeholder set is pinned, and that is the drift guard rather
 * than bookkeeping. `frozen = 0` is a hard literal while `movable` is derived as
 * the whole population, so nothing recomputes the split: an id that BECAME
 * run-frozen — a prose rewrite dropping its one moving placeholder — would be
 * counted movable in silence, and the figure in deny-repeat.ts would be wrong
 * with every test green. Pinning only the four that once carried the withdrawn
 * claim left the other nine able to do exactly that. Now any prose change to any
 * member turns this red, and re-deciding "can it still move inside one run?" is
 * part of answering it.
 *
 * `movedBy` is the reviewed half and is present only where a mechanism is DRIVEN
 * below: the named mechanism is executed and the two renders are shown to sign
 * two keys inside one run id. Its absence on a row is not a claim that the row
 * cannot move — nine of these move for reasons no test here executes (a second
 * offending file, a second role, a different host) — it is a claim that nothing
 * in this file demonstrates it, which is why the withdrawal is total rather than
 * a subtraction of a declared list. While an id could be declared frozen, a
 * declared list was subtracted from a derived figure, so a prose rewrite that
 * added a moving placeholder could be answered by adding a name here: 22 tests
 * green, every figure unchanged, and the sentence in deny-repeat.ts quietly
 * wrong again.
 */
const TARGET_AND_PLACEHOLDER_IDS: Readonly<Record<string, {
  readonly placeholders: readonly string[];
  readonly movedBy?: string;
}>> = {
  // The target is the offending FILE; `{{BAD_PATHS}}` is the paths written
  // inside it, and `{{PROJECT_ROOT}}` is a third thing again. This is the row an
  // automated pass scored as fully covered.
  'absolute-traffic-one-path': { placeholders: ['BAD_PATHS', 'PROJECT_ROOT'] },
  'architect-phase-incomplete': { placeholders: ['MISSING', 'ROLE', 'RUN_ID'] },
  // "Components must live in {{TARGET}}" — two literals, chosen by
  // `isNativeState(state)` (`.one.json`'s `mobile.framework`/`stack`), NOT by
  // the run snapshot the freeze claim was about.
  'component-placement': { placeholders: ['TARGET'], movedBy: 'declared-state' },
  // The target is the offending FILE; the prose names which feature imported
  // which. Two cross-imports in one file are two fixes and today two counts.
  'cross-feature-import': { placeholders: ['CROSS', 'CURRENT'] },
  'cursor-agent-type-required': {
    placeholders: ['AGENT_PATH', 'AGENT_TYPE', 'EXPECTED_AGENT', 'FALLBACK_AGENT', 'ROLE'],
  },
  'kilo-general-agent-required': { placeholders: ['AGENT_PATH', 'AGENT_TYPE', 'ROLE'] },
  'opencode-named-agent-required': {
    placeholders: ['AGENT_PATH', 'AGENT_TYPE', 'EXPECTED_AGENT', 'HOST', 'MODEL_NOTE', 'ROLE'],
  },
  'performance-main-agent': { placeholders: ['LEVEL', 'ROLE'] },
  // The target is the ROLE; the prose names the expected model, the level, the
  // host and the alternates.
  'performance-model-param': {
    placeholders: ['ALTERNATES', 'EXPECTED', 'HOST', 'LEVEL', 'PASSED_NOTE', 'ROLE'],
  },
  'run-id-mismatch': { placeholders: ['EXPECTED', 'WRONG'] },
  // `capabilityProfileForRun` reads the run snapshot, and
  // `ensureArchitectureRunSnapshot` re-mints it through
  // `supersedeBlockedRunSnapshot` on every read of an existing run id once a
  // blocked profile resolves clean. Same run id, different summary.
  'scaffold-main-agent-plan-gate': { placeholders: ['PROFILE_SUMMARY'], movedBy: 'supersede' },
  'scaffold-plan-gate': { placeholders: ['PROFILE_SUMMARY'], movedBy: 'supersede' },
  'scaffold-stack-gate': { placeholders: ['PROFILE_SUMMARY'], movedBy: 'supersede' },
};

function corpusRows(): CorpusRow[] {
  const snapshot = path.resolve(SRC_ROOT, '..', 'tests', 'replay-corpus', 'snapshot.txt');
  return fs.readFileSync(snapshot, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => {
      const [, decision, , denyId, target] = line.split('\t');
      return { decision: decision ?? '', denyId: denyId ?? '', target: target ?? '' };
    });
}

/** Every escalatable id that ships prose, mapped to its `{{PLACEHOLDER}}` set. */
function placeholdersByEscalatableId(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, body] of Object.entries(SKILL_FALLBACKS)) {
    const id = key.split(' :: ')[1] ?? '';
    if (!isEscalatableDenyId(id)) continue;
    const set = out.get(id) ?? new Set<string>();
    for (const match of body.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) set.add(match[1]!);
    out.set(id, set);
  }
  return out;
}

function deriveFigures(): { figures: DerivedFigures; targetAndPlaceholders: string[] } {
  const prose = placeholdersByEscalatableId();
  const rows = corpusRows();
  const escalatableDenyRows = rows.filter((row) => row.decision === 'deny' && isEscalatableDenyId(row.denyId));
  const emptyTarget = (row: CorpusRow): boolean => row.target === '' || row.target === '-';
  const fired = [...new Set(escalatableDenyRows.map((row) => row.denyId))];
  const firedWithProse = fired.filter((id) => prose.has(id));

  const targetsById = new Map<string, string[]>();
  for (const row of escalatableDenyRows) {
    if (emptyTarget(row)) continue;
    targetsById.set(row.denyId, [...(targetsById.get(row.denyId) ?? []), row.target]);
  }

  // Order is load-bearing and was the whole discrepancy: EMPTY TARGET is asked
  // first. Six ids have no target on any row AND no placeholders, and scoring
  // them as "no placeholders" instead moved six out of the bucket the tuple-key
  // argument is about (3 vs 9, and 25 vs 19).
  const emptyTargetIds: string[] = [];
  const noPlaceholderIds: string[] = [];
  const targetAndPlaceholders: string[] = [];
  for (const id of firedWithProse) {
    if ((targetsById.get(id) ?? []).length === 0) emptyTargetIds.push(id);
    else if (prose.get(id)!.size === 0) noPlaceholderIds.push(id);
    else targetAndPlaceholders.push(id);
  }

  return {
    targetAndPlaceholders: targetAndPlaceholders.sort(),
    figures: {
      'escalatable ids with shipped prose': prose.size,
      'of those, ids the corpus fires': firedWithProse.length,
      'of those, ids the corpus never fires': prose.size - firedWithProse.length,
      'fired ids whose target is empty on every row': emptyTargetIds.length,
      'fired ids whose prose renders no placeholder at all': noPlaceholderIds.length,
      'fired ids with a populated target AND placeholders': targetAndPlaceholders.length,
      'of those, ids whose target covers everything the prose renders': 0,
      // A reviewed verdict, like the zero above it and for the same reason:
      // nothing mechanical can decide whether a value moves inside a run. It is
      // a LITERAL rather than a subtraction of a declared list deliberately —
      // see TARGET_AND_PLACEHOLDER_IDS, whose per-id placeholder pin is what
      // stops this literal drifting once one of the thirteen stops moving. The
      // four ids that once made this 4 are each driven below.
      'of those, ids whose every placeholder is frozen for the run': 0,
      'of those, ids whose prose can move WITHIN one run': targetAndPlaceholders.length,
      'escalatable deny rows in the corpus': escalatableDenyRows.length,
      'escalatable deny rows carrying an empty target': escalatableDenyRows.filter(emptyTarget).length,
      'ids the corpus fires with an empty target, prose or not':
        new Set(escalatableDenyRows.filter(emptyTarget).map((row) => row.denyId)).size,
      'replay-corpus cases': rows.length,
      'distinct (denyId, target) pairs among the escalatable deny rows':
        new Set(escalatableDenyRows.map((row) => `${row.denyId}::${row.target}`)).size,
    },
  };
}

test('the recorded partition sums, and every figure is derivable from its artefact', () => {
  const { figures, targetAndPlaceholders } = deriveFigures();
  const table = Object.entries(figures).map(([label, value]) => ` *     ${label} = ${value}`).join('\n');

  // FIXTURE READBACK — an unreadable snapshot or a broken id predicate derives
  // zeroes and every identity below holds vacuously.
  assert.ok(figures['replay-corpus cases']! > 100, `FIXTURE the corpus must be readable\n${table}`);
  assert.ok(
    figures['escalatable ids with shipped prose']! > 100,
    `FIXTURE the shipped prose table must be readable\n${table}`,
  );

  // The identities. These can never go stale, because they are relations rather
  // than counts — the partition must exhaust the population, and the two totals
  // must agree with each other.
  assert.equal(
    figures['fired ids whose target is empty on every row']!
    + figures['fired ids whose prose renders no placeholder at all']!
    + figures['fired ids with a populated target AND placeholders']!,
    figures['of those, ids the corpus fires']!,
    `the four buckets must partition the ids the corpus fires — the recorded ones summed to 41 against a `
    + `stated population of 56, which is the arithmetic that made the whole paragraph uncheckable\n${table}`,
  );
  assert.equal(
    figures['of those, ids the corpus fires']! + figures['of those, ids the corpus never fires']!,
    figures['escalatable ids with shipped prose']!,
    `fires + never-fires must be the whole prose population\n${table}`,
  );
  assert.ok(
    figures['escalatable deny rows carrying an empty target']! <= figures['escalatable deny rows in the corpus']!,
    `a subset cannot exceed its set — the withdrawn figures said 24 of 122 against a snapshot with 81 deny `
    + `rows in total\n${table}`,
  );

  // The coverage verdict's population, by name. The number above it (zero) is a
  // reviewed judgement, not a computation, so a new member has to be reviewed too.
  assert.deepEqual(
    targetAndPlaceholders, Object.keys(TARGET_AND_PLACEHOLDER_IDS).sort(),
    'the ids whose target is populated AND whose prose renders placeholders have changed. The recorded '
    + 'verdict over this set — that ZERO of them have a target carrying everything their prose renders, '
    + 'which is the number the dead end turns on — cannot be recomputed: the snapshot records the target, '
    + 'not the rendered reason, and an automated pass that guessed from name similarity got '
    + '`absolute-traffic-one-path` wrong. Read the new member\'s prose against its target and either add it '
    + `with that argument or move the verdict.\n${table}`,
  );
});

test('every one of the thirteen still renders the placeholders the frozen/movable split was decided on', () => {
  // THE DRIFT GUARD for a figure nothing recomputes. `frozen` is a literal 0 and
  // `movable` is the whole population, so the split survives any prose change in
  // silence — including the one that would invalidate it, an id losing its last
  // moving placeholder and BECOMING run-frozen. This loop used to cover only the
  // four ids that carried the withdrawn claim, which left nine able to drift.
  // The by-name pin above catches a new member JOINING the thirteen; this one
  // catches a sitting member changing underneath the verdict.
  const prose = placeholdersByEscalatableId();
  const { figures, targetAndPlaceholders } = deriveFigures();

  for (const [id, claim] of Object.entries(TARGET_AND_PLACEHOLDER_IDS)) {
    assert.ok(
      targetAndPlaceholders.includes(id),
      `${id} is recorded as one of the ids with a populated target AND placeholders and is not one any `
      + 'more, so the record in deny-repeat.ts is about a set it is not in',
    );
    assert.deepEqual(
      [...(prose.get(id) ?? new Set<string>())].sort(), [...claim.placeholders].sort(),
      `${id}'s shipped prose no longer renders exactly the placeholders this record names. The derived `
      + 'table says ZERO of the thirteen are run-frozen and ALL of them can move within one run, and '
      + 'neither number is recomputed from the prose — so this is not an invitation to edit the row. '
      + 'Read what the new placeholder set is fed by. If everything it renders is fixed once the run id '
      + 'is minted, this id is now run-frozen and the two figures are wrong. If it still moves, say what '
      + 'moves it on the row, and drive it where you can, the way the supersede and the state flip are '
      + 'driven below.',
    );
  }

  // `movedBy` names a mechanism DRIVEN in section 5, and those two drives are
  // the only ones this file contains: a third name here, or a row losing its
  // name, is a record claiming a demonstration that is not present.
  const driven = new Map<string, string[]>();
  for (const [id, claim] of Object.entries(TARGET_AND_PLACEHOLDER_IDS)) {
    if (!claim.movedBy) continue;
    driven.set(claim.movedBy, [...(driven.get(claim.movedBy) ?? []), id].sort());
  }
  assert.deepEqual(
    Object.fromEntries([...driven.entries()].sort()),
    {
      'declared-state': ['component-placement'],
      supersede: ['scaffold-main-agent-plan-gate', 'scaffold-plan-gate', 'scaffold-stack-gate'],
    },
    'the rows that name a driven mechanism have changed. Every `movedBy` must be executed end to end '
    + 'in section 5 — that is the whole difference between this record and the paragraph it replaced',
  );

  assert.equal(
    figures['of those, ids whose every placeholder is frozen for the run']!
    + figures['of those, ids whose prose can move WITHIN one run']!,
    figures['fired ids with a populated target AND placeholders']!,
    'the split must exhaust the thirteen — it is a partition of them, not a second population',
  );
  assert.equal(
    figures['of those, ids whose prose can move WITHIN one run'],
    figures['fired ids with a populated target AND placeholders'],
    'the movable side is the whole population now: the run-frozen narrowing is withdrawn, so a per-run '
    + 'exemption is not something this file can grant by declaring one',
  );
});

// ── 5. the withdrawn narrowing, DRIVEN ──────────────────────────────────────
//
// The narrowing rested on "the capability profile is frozen with the run id".
// It is not, and the code that unfreezes it is one call deep in the path every
// hook takes: `ensureCurrentRunId` reads an existing run id, calls
// `ensureArchitectureRunSnapshot`, and that re-mints a BLOCKED snapshot through
// `supersedeBlockedRunSnapshot` the moment live detection resolves clean. The
// two tests below drive both mechanisms end to end, because a paragraph is what
// was wrong last time.

/** A hybrid project: Next.js under `packages/dashboard`, Expo at the root. Both
 *  UI surfaces detected and no `architectureTarget`, which is the sole producer
 *  of a blocking capability issue and therefore the only route to a supersede. */
function hybridProject(): { cwd: string; state: Record<string, unknown> } {
  const cwd = freshProject();
  fs.mkdirSync(path.join(cwd, 'packages/dashboard/app'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'packages/dashboard/package.json'), JSON.stringify({
    dependencies: { next: '16.0.0', react: '19.0.0' },
  }));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { expo: '55.0.0', react: '19.0.0', 'react-native': '0.83.0' },
  }));
  const state: Record<string, unknown> = {
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'none',
    backend: 'none',
    mobile: { framework: 'react-native-expo' },
    onboardingComplete: true,
    currentRunId: RUN_ID,
  };
  return { cwd, state };
}

function writeProjectState(cwd: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
}

/** The scaffold gate as Windsurf reaches it: a `create-next-app` on a
 *  new-project root, which is arm (A) — the stack gate — and renders
 *  `{{PROFILE_SUMMARY}}` from `capabilityProfileForRun`. */
function scaffoldDeny(cwd: string): { reason: string; denyId: string; target: string } {
  const input = {
    event: 'PreToolUse', host: 'windsurf', cwd, workspaceRoot: cwd, raw: {},
    tool: { class: 'shell', rawName: 'run_command', command: 'npx create-next-app@latest app' },
  };
  const result = scaffoldGate({ input, host: 'windsurf', cwd, now: () => 'x' } as unknown as Ctx);
  assert.equal(result.kind, 'deny', 'FIXTURE the scaffold gate must refuse, or nothing is being measured');
  const deny = result as { reason: string; denyId?: string; denyTarget?: string };
  return { reason: deny.reason, denyId: deny.denyId ?? '', target: deny.denyTarget ?? '' };
}

test('the capability profile MOVES inside one run id, and a gate\'s prose moves with it', () => {
  const { cwd, state } = hybridProject();
  writeProjectState(cwd, state);

  // Minted before the hybrid question is answered: the fail-closed profile.
  const blocked = ensureArchitectureRunSnapshot(cwd, RUN_ID, state);
  assert.equal(blocked.profile.profileId, 'unsupported-hybrid', 'FIXTURE the run must freeze blocked');
  assert.equal(blocked.profile.blockingIssues?.[0]?.code, 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED');

  const first = scaffoldDeny(cwd);
  assert.equal(first.denyId, 'scaffold-stack-gate');
  assert.match(first.reason, /profile=unsupported-hybrid; framework=hybrid/);
  const before = withRoot(ROOT_V1, () => denyRepeat(cwd, RUN_ID, first));
  assert.equal(before.count, 1);

  // The user answers the hybrid question — the one input that resolves a
  // blocking issue — and the NEXT read of this same run id supersedes in place.
  const answered = { ...state, architectureTarget: 'web-ui' };
  writeProjectState(cwd, answered);
  const healed = ensureArchitectureRunSnapshot(cwd, RUN_ID, answered);
  assert.equal(healed.profile.profileId, 'next-app', 'the SAME run id now resolves a different profile');
  assert.equal(healed.baselineHash, blocked.baselineHash, 'same immutable baseline: this is one run');

  const second = scaffoldDeny(cwd);
  assert.equal(second.denyId, 'scaffold-stack-gate', 'the same gate, refusing the same command');
  assert.match(second.reason, /profile=next-app; framework=nextjs/);
  assert.notEqual(
    first.reason, second.reason,
    'FIXTURE the rendered summary must actually move, or the rest of this proves nothing',
  );
  // The consequence, which is the only thing the docblock's sentence was about:
  // an UNCHANGED loop — same gate, same command, same target — signs two keys
  // inside one run id, because the profile moved under it.
  const after = withRoot(ROOT_V1, () => denyRepeat(cwd, RUN_ID, second));
  assert.equal(
    after.count, 1,
    'a second key, inside one run: `{{PROFILE_SUMMARY}}` is NOT frozen with the run id, so the '
    + 'four-of-thirteen narrowing this drives was withdrawn',
  );
  assert.equal(withRoot(ROOT_V1, () => denyRepeat(cwd, RUN_ID, second)).count, 2, 'and the new key counts on');
  assert.equal(counterKeys(cwd).length, 2, 'one loop, two keys, one run id');

  // …and mint-once resumes: a healthy snapshot is never superseded again, so
  // this is one move per run rather than a value that drifts continuously.
  const stable = ensureArchitectureRunSnapshot(cwd, RUN_ID, { ...answered, architectureTarget: 'native-ui' });
  assert.equal(stable.snapshotHash, healed.snapshotHash);
});

test('component-placement\'s two targets are chosen by declared state, not by the run profile', () => {
  // The second withdrawn claim, and it is wrong about the MECHANISM rather than
  // about the freeze: plan-static.ts picks the literal on `isNativeState`, which
  // reads `.one.json`'s `mobile.framework`/`stack` — user- and command-owned
  // state that the shipped set-tech command rewrites through `--mobile=` — and
  // never consults the run snapshot the freeze claim was about.
  const web = { mode: 'new-project', stack: 'custom-frontend', frontend: 'react-vite', mobile: { framework: 'none' } };
  const native = { ...web, mobile: { framework: 'react-native-expo' } };
  assert.equal(isNativeState(web), false, 'FIXTURE the predicate must flip on this one field');
  assert.equal(isNativeState(native), true);

  const render = (state: Record<string, unknown>): string[] => planStaticViolations(
    'apps/web/src/Widget.tsx',
    'export const Widget = () => null;\n',
    isNativeState(state),
    (_id: string, text: string) => text,
  );
  const [webText] = render(web);
  const [nativeText] = render(native);
  assert.match(String(webText), /packages\/ui\/\*/);
  assert.match(String(nativeText), /packages\/ui-native\/\*/);
  assert.notEqual(webText, nativeText, 'two literals, and the state field is what chooses between them');

  // Same consequence as the supersede above, from the other mechanism: two
  // renders of one id inside one run are two keys today, and one bucket that
  // escalates on the third under the tuple key.
  const cwd = freshProject();
  const refuse = (text: string): number => withRoot(ROOT_V1, () => denyRepeat(cwd, RUN_ID, {
    reason: String(text), denyTarget: 'apps/web/src/Widget.tsx', denyId: 'component-placement',
  }).count ?? -1);
  assert.deepEqual([refuse(String(webText)), refuse(String(nativeText))], [1, 1]);
  assert.equal(counterKeys(cwd).length, 2);
});

test('the figures deny-repeat.ts records are the derived ones', () => {
  // The docblock is the ONE copy, and this is what keeps it one. The previous
  // arrangement had the numbers in prose in two files, disagreeing with each
  // other and with the artefacts; correcting them by hand is what let them rot
  // in the first place.
  const { figures } = deriveFigures();
  const source = fs.readFileSync(path.join(SRC_ROOT, 'shared', 'state', 'deny-repeat.ts'), 'utf8');
  const recorded = new Map<string, number>();
  for (const match of source.matchAll(/^\s*\*\s{4,}(.+?)\s+=\s+(\d+)\s*$/gm)) {
    recorded.set(match[1]!.trim(), Number(match[2]));
  }

  const table = Object.entries(figures).map(([label, value]) => ` *     ${label} = ${value}`).join('\n');
  assert.deepEqual(
    [...recorded.entries()].sort(), Object.entries(figures).sort(),
    'deny-repeat.ts\'s recorded figures no longer match the artefacts they are derived from. Replace the '
    + `table in the denySignature docblock with exactly this:\n\n${table}\n`,
  );
});

test('the overridable-remainder figures deny-ids.ts records are the derived ones', () => {
  // The sibling above exists because two hand-maintained copies of a number rot.
  // A SINGLE hand-maintained copy rots too, just more quietly: the sentence this
  // reads said 168 and had been wrong since the id before last, with nothing
  // checking it, and it was found by a reviewer counting rather than by a red.
  const source = fs.readFileSync(path.join(SRC_ROOT, 'config', 'deny-ids.ts'), 'utf8');
  const sentence = /(\d+) remaining ids \((\d+) declared, less the (\d+) below\)/.exec(source);
  assert.ok(sentence, 'the overridable-remainder sentence in deny-ids.ts has been reworded past this pin');

  const never = new Set<string>(NEVER_OVERRIDABLE_DENY_IDS);
  const derived = [DENY_IDS.filter((id) => !never.has(id)).length, DENY_IDS.length, never.size];
  assert.deepEqual(
    sentence.slice(1, 4).map(Number), derived,
    'the deny-id counts moved and the sentence explaining the overridable default did not. Expected '
    + `"${derived[0]} remaining ids (${derived[1]} declared, less the ${derived[2]} below)".`,
  );
});

// WHAT THESE TWO SCANS DO NOT COVER, stated so the next reader does not over-
// read them.
//
// Both are NAME LISTS at heart, and a name list is exactly as good as its
// vocabulary. Two ways past them, both now smaller than they were:
//
//   - an already-listed file that starts interpolating a value from a producer
//     `VOLATILE_PRODUCER` does not name. Unchanged: the first scan only reads
//     shipped prose (volatile values arrive through `{{PLACEHOLDER}}`s at render
//     time) and the second reads identifiers.
//   - a prose helper TWO import hops out of the declaring file. Arm 2 follows
//     one, which is the hop the real refactor took; a second hop is possible and
//     is not followed, because every additional hop trades a real narrowing of
//     this residue for a table nobody will maintain.
//
// The first scan's spelling set was widened after five real shapes were found
// missing from it — including the tilde form, which is the install-location
// shape the FIRST fold exists for, so the scan added to catch that class could
// not see the class's most human spelling. It carries its own fixture readback
// now, so a future narrowing of a pattern fails here rather than passing empty.
//
// What the two do is convert both known members from "somebody has to remember"
// into a failing diff, and put a floor under the claim the docblock used to make
// for free.
