// tests/replay-corpus/env.ts
// Determinism + isolation harness for the replay corpus. Imported FIRST by
// every other file in this directory (replay.test.ts, coverage.test.ts,
// rebaseline.ts) so every later `process.env` default-param read
// (readPluginUseChoice, preseed, detectHost, …) already sees the isolated
// values.
//
// The isolation is by POLICY, not by blocklist: every env var in the plugin's
// or a host's namespace is WIPED and only the handful this file sets survives
// (see wipeHostAndPluginEnv). A blocklist was the previous design and it
// leaked — it deleted CURSOR_PLUGIN_ROOT/CODEX_PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT
// but not TRAFFIC_ONE_PLUGIN_ROOT, which is FIRST in PLUGIN_ROOT_ENV
// (shared/paths.ts) and outranks all three, so the corpus read whatever root
// the maintainer's shell exported. A blocklist can only ever be as complete as
// the last audit of src/; the wipe cannot be outgrown by a new variable.
//
// Hazards this neutralizes, one per line so a future reviewer can check each
// off against the report:
//   - wall-clock time      -> never placed in the snapshot (see run-case.ts);
//                             freshness windows (deploy-gate's 10-minute
//                             stamps) are either absent or stamped at fixture
//                             build time, i.e. pinned to one side of the
//                             window for the whole ~10-second run — never near
//                             the boundary the boolean flips at.
//   - pid                   -> never placed in the snapshot; TRAFFIC_ONE_AUTH
//                             and the isolated HOME below remove every
//                             pid-keyed lock/lookup from the DECISION path
//                             (the decision log itself still keys on pid, but
//                             the replay harness reads runPipeline's RETURN
//                             VALUE, never the decision log).
//   - temp/absolute paths   -> never placed in the snapshot; every fixture
//                             root is a fresh mkdtemp dir, and the columns
//                             the snapshot stores (decision/gate/denyId, plus
//                             a denyTarget REDUCED to a shape token) contain
//                             no path segments.
//   - run ids               -> minted per fixture (Date.now-based in some
//                             writers) but never placed in the snapshot.
//   - hostname / machine    -> HOME and the XDG_*_HOME dirs point at an
//                             isolated, per-process temp tree, so every
//                             per-user global file (~/.traffic-one/**, host
//                             billing-tier probes under ~/.claude, ~/.codex,
//                             …) reads as "absent" identically on every
//                             machine, instead of reflecting the developer's
//                             real machine state. XDG_STATE_HOME is the ONE
//                             exception and is deliberately left unset — see
//                             the comment above the HOME assignment.
//   - ordering of fs reads  -> module/handler discovery already sorts by id
//                             (core/registry.ts); this file adds nothing here
//                             because it changes no read order.
//   - ordering of CASES     -> handlers mutate process.env mid-run
//                             (applyTrafficOneEnv is called by several hook
//                             paths), so run-case.ts calls resetCorpusEnv()
//                             before every single case. Without it, case N's
//                             verdict could depend on which cases ran before
//                             it, which is the one determinism property this
//                             corpus cannot be allowed to lose.
//   - ambient environment   -> every TRAFFIC_ONE_*/CLAUDE_*/CODEX_*/CURSOR_*/
//                             COPILOT_*/WINDSURF_*/KILO_*/OPENCODE_*/DEVIN_*/
//                             GITNEXUS_*/GRAPHIFY_* variable is deleted, so
//                             neither detectHost() nor a plugin-root reader
//                             nor a host session/identity probe can pick up
//                             the session that is running THIS test. Each case
//                             sets TRAFFIC_ONE_HOST explicitly for the
//                             duration of its own replay (see run-case.ts).
//   - plugin root           -> PINNED, not deleted: see pluginRootForCorpus.
//   - locale / timezone     -> pinned to C / UTC so any date formatting a
//                             gate performs cannot vary by developer locale.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 't1-replay-home-'));

// Everything the corpus is allowed to inherit from the surrounding process is
// listed here, and nothing else in these namespaces survives. Assigned BELOW
// the wipe, so the order is: wipe, then set.
const CORPUS_OWNED_ENV = [
  'TRAFFIC_ONE_AUTH',
  'TRAFFIC_ONE_ONBOARDING_NO_SPAWN',
  'TRAFFIC_ONE_MANAGED_RUNTIME_OFF',
  'TRAFFIC_ONE_PLUGIN_ROOT',
] as const;

// Namespaces src/ reads ambient values from: the plugin's own, every supported
// host's, and the two code-graph providers'. Derived from the full env-name
// inventory of src/ (`rg -o '\b(TRAFFIC_ONE|CLAUDE|…)_[A-Z0-9_]+' src`), which
// is why this is a prefix policy rather than the ~90 individual names that
// inventory contains.
const HOST_AND_PLUGIN_ENV_PREFIXES = [
  'TRAFFIC_ONE_',
  'CLAUDE_',
  'CODEX_',
  'CURSOR_',
  'COPILOT_',
  'WINDSURF_',
  'KILO_',
  'OPENCODE_',
  'DEVIN_',
  'GITNEXUS_',
  'GRAPHIFY_',
];

function wipeHostAndPluginEnv(): void {
  const owned = new Set<string>(CORPUS_OWNED_ENV);
  for (const key of Object.keys(process.env)) {
    if (owned.has(key)) continue;
    if (!HOST_AND_PLUGIN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    delete process.env[key];
  }
}

wipeHostAndPluginEnv();

// Per-user state is isolated through HOME ALONE, and XDG_STATE_HOME is
// deliberately left UNSET even though it is the more specific override and
// every unit test in src/ uses it.
//
// Reason: on the opencode host, production deletes it. OpenCode ships as an
// Electron app that exports XDG_STATE_HOME=~/Library/Application
// Support/ai.opencode.desktop, which would file Traffic One's per-user state
// inside OpenCode's app bundle instead of ~/.traffic-one, so
// normalizeElectronEnvForTrafficOne strips it (unconditionally, and asserted by
// state/__tests__/traffic-one-paths.test.ts) to keep every host agreeing on one
// state dir. applyTrafficOneEnv then writes that decision straight into
// process.env.
//
// For this corpus that had two teeth:
//   1. the strip lands BETWEEN a fixture's consent write and the gate's consent
//      read, so every opencode case saw its own fixture's answer disappear and
//      characterized `onboarding-use-plugin-question` instead of the gate it
//      names;
//   2. the strip is process-wide and permanent, so the FIRST opencode case
//      silently moved the state dir for every case after it — verdicts became
//      order-dependent.
// HOME survives the same code path untouched (it is re-pinned to os.homedir(),
// which returns $HOME on POSIX), and every state-dir resolver in src/
// (state/plugin-use.ts's machineStateDir, traffic-one-paths.ts's
// globalTrafficOneDir, one-settings.ts, toolchain-paths.ts) falls back to
// $HOME/.traffic-one when XDG_STATE_HOME is absent. So HOME-only isolation is
// both complete and immune to the normalization — and it is also what a real
// macOS user's environment looks like.
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;
delete process.env.XDG_STATE_HOME;
process.env.XDG_CONFIG_HOME = path.join(ISOLATED_HOME, 'xdg-config');
process.env.XDG_DATA_HOME = path.join(ISOLATED_HOME, 'xdg-data');
process.env.XDG_CACHE_HOME = path.join(ISOLATED_HOME, 'xdg-cache');

// Master auth switch off: the priority-0 session.auth gate (src/shared/auth)
// stands down unconditionally, so no fixture needs a fake API key just to
// reach the gates under test. session.auth's own enforcing behavior is
// characterized deliberately instead, by the two cases that flip this for the
// span of one replay (see AUTH_ENFORCED below + session-guards.cases.ts).
process.env.TRAFFIC_ONE_AUTH = 'off';

// NEVER let onboarding-gate spawn a real wizard server (a live HTTP listener
// on a real port, backed by a real child process) — the exact hazard this
// corpus exists to avoid. Mirrors the precedent in
// src/modules/onboarding-gate/__tests__/onboarding-gate.test.ts's withProject.
// With this set, ensure()/prepareOnboardingServer hands back a deterministic
// placeholder instead of spawning anything.
process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';

// Never fetch a managed standalone runtime (a 50-200MB interpreter download).
// src/build/test-preload.mjs pins this for `npm test`, but the corpus must
// hold on its own too: rebaseline.ts is a plain `node` entry point and the
// snapshot WRITER may never take a network path the READER does not.
process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF = '1';

// Ask-first stays at its COMMITTED DEFAULT (config/onboarding.ts's
// ASK_USE_PLUGIN_FIRST) — deliberately not pinned to '0' the way
// src/build/test-preload.mjs pins it for the rest of the suite.
//
// The reasoning, since it decides what this whole corpus characterizes: with
// ask-first on, an unconsented project is a WRITE FENCE (state/plugin-use.ts's
// projectWritesPermitted + the path fence in shared/fsjson.ts), so a fixture
// that has not recorded an answer characterizes the fence and nothing else —
// every later gate is unreachable behind it. Pinning '0' here would remove the
// fence globally and make `undecidedProject` indistinguishable from
// `freshProject`, which would delete the ask-first surface from the corpus
// entirely. So: the flag keeps its shipped value, every fixture that means "a
// project the user already said yes to" records that answer through the real
// writer (recordPluginUseChoice — see fixtures.ts), and the pre-consent states
// are characterized by the fixtures that deliberately withhold the answer
// (undecidedProject) or record a "no" (declinedProject). A change to the
// shipped default is then a real verdict change and shows up as snapshot drift
// instead of being silently absorbed here.
delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;

process.env.TZ = 'UTC';
process.env.LANG = 'C';

// ── the plugin root ─────────────────────────────────────────────────────────
// PINNED to a synthetic INSTALLED plugin tree built under the isolated HOME
// (plugin-root.ts), and pinned rather than deleted for two independent
// reasons:
//
//  1. Writer/reader agreement. `pluginRoot()` reads four env vars before its
//     __dirname fallback (shared/paths.ts). Deleting all four left the root at
//     the fallback — which resolves DIFFERENTLY depending on how the corpus
//     was entered (`npm test` preloads test-preload.mjs, which pins this
//     checkout; `node tests/replay-corpus/rebaseline.ts` does not), so the
//     baseline was captured against one root and verified against another.
//     Setting it here, after the wipe, makes both entry points identical by
//     construction — it also overrides the preload's own pin, so the corpus
//     does not depend on whether the preload ran.
//
//  2. Reachability, which is the whole point of the corpus. Materialization
//     REFUSES on any root that is not 'installed' (materialize.ts's layout
//     refusal), and this checkout classifies as 'source'. Every onboarded
//     fixture therefore stayed unmaterialized, so onboarding-gate's own
//     priority-10 convergence denied `repaired-materialization` for EVERY
//     mutating PreToolUse and agent-model denied `agent-materialization-
//     missing` for every spawn — swallowing plan-guard, the agent-model
//     ladder, and every control case behind them. Nine of the ten
//     plan-guard cases landed on onboarding-gate that way. A real user's
//     plugin root is an installed one; characterizing a broken install
//     instead is what made the corpus useless for the phases it exists to
//     protect.
export const CORPUS_PLUGIN_ROOT = path.join(ISOLATED_HOME, 'traffic-one-plugin');
process.env.TRAFFIC_ONE_PLUGIN_ROOT = CORPUS_PLUGIN_ROOT;

// require(), not a top-level import: the builder pulls in src/gen and src/core,
// and every module in that graph must load with the environment above ALREADY
// in place. `import` is hoisted above these assignments; `require` is not.
// eslint-disable-next-line @typescript-eslint/no-var-requires
(require('./plugin-root') as typeof import('./plugin-root')).buildCorpusPluginRoot(CORPUS_PLUGIN_ROOT);

// ── keeping the environment above true for the WHOLE run ────────────────────
// Everything above runs once, at import. Handlers then mutate process.env while
// they work — applyTrafficOneEnv (state/traffic-one-paths.ts) is called from the
// hook entries and from onboarding-gate, and it deletes XDG_STATE_HOME and
// re-pins HOME on the opencode host; other paths set TRAFFIC_ONE_* markers. Any
// such mutation outlives the case that caused it, which would make a verdict
// depend on the cases that ran BEFORE it.
//
// So the values this file owns are snapshotted here, once, and re-asserted
// before every case (run-case.ts). The snapshot is taken AFTER all the
// assignments above, and covers exactly two groups: the non-namespaced vars this
// file sets (HOME/USERPROFILE/XDG_*/TZ/LANG), and whatever it left behind in the
// host+plugin namespaces — so a variable a handler INVENTS in one of those
// namespaces is deleted again rather than inherited by the next case.
const OWNED_NON_PREFIXED = [
  'HOME', 'USERPROFILE', 'TZ', 'LANG',
  'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
] as const;

const CORPUS_ENV_SNAPSHOT: Map<string, string | undefined> = (() => {
  const snapshot = new Map<string, string | undefined>();
  for (const key of OWNED_NON_PREFIXED) snapshot.set(key, process.env[key]);
  for (const key of Object.keys(process.env)) {
    if (HOST_AND_PLUGIN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      snapshot.set(key, process.env[key]);
    }
  }
  return snapshot;
})();

export function resetCorpusEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (CORPUS_ENV_SNAPSHOT.has(key)) continue;
    if (!HOST_AND_PLUGIN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    delete process.env[key];
  }
  for (const [key, value] of CORPUS_ENV_SNAPSHOT) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function cleanupIsolatedHome(): void {
  // maxRetries/retryDelay: macOS occasionally holds a just-written file open
  // for a moment (Spotlight indexing), which turns a recursive rm into a
  // transient ENOTEMPTY/EBUSY right after a fixture writes its last file —
  // without a retry, that one directory survives the process exit.
  fs.rmSync(ISOLATED_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

// Every entry point into this directory (replay.test.ts, coverage.test.ts,
// rebaseline.ts, any ad-hoc debug script) imports env.ts first, so registering
// the cleanup here once — rather than requiring every caller to remember an
// explicit teardown — is what actually prevents this from leaking an
// isolated-HOME tree into the real OS tmpdir on every single run. fs.rmSync is
// synchronous, which is the only kind of work Node permits inside an 'exit'
// handler.
//
// 'exit' is the BACKSTOP, not the plan: node:test only fires it after the whole
// file finishes, and a `--test`-runner crash or a SIGINT never reaches it at
// all. The test files additionally call cleanupReplayTempTrees() from
// `test.after`, which is what keeps a long suite from holding the tree for its
// whole duration. Both paths are idempotent (`force: true`).
process.once('exit', cleanupIsolatedHome);

// The two deliberate per-case escapes from the process-wide values above, both
// applied through CaseSpec.env (run-case.ts), which restores them around every
// single replay so no other case's verdict can depend on one:
//
//   - AUTH_ENFORCED   the priority-0 session.auth gate itself, which the
//                     corpus-wide `TRAFFIC_ONE_AUTH=off` stands down.
//   - CURSOR_PAID_PLAN every Cursor model-tier read resolves a plan, and the
//                     detected default ('free', DEFAULT_HOST_PLAN) pins all
//                     three Cursor tiers to the Composer floor
//                     (config/model-tiers.ts) — a floor pick can never be
//                     "unavailable" (cursor-eligibility.ts skips /^composer/),
//                     so the model-choice pause is unreachable on a free plan.
//                     TRAFFIC_ONE_USER_PLAN is the documented seam for this
//                     (shared/host/plan.ts's header names it as the test seam,
//                     and computePlan reads it before any host probe).
export const AUTH_ENFORCED: Readonly<Record<string, string>> = { TRAFFIC_ONE_AUTH: 'on' };
export const CURSOR_PAID_PLAN: Readonly<Record<string, string>> = { TRAFFIC_ONE_USER_PLAN: 'pro' };
