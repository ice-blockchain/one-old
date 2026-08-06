// src/build/test-preload.mjs
// Loaded via `node --import` before the test suite (see package.json `test`).
// Forces the managed standalone-runtime fetcher OFF so `npm test` can NEVER hit
// the network or download a 50-200MB interpreter: any test that reaches a real
// graphify/gitnexus/opencode install path on a runtime-less machine must degrade
// to install-skipped/defer, exactly as it does in the deterministic env. Real
// onboarding does not load this preload, so the download path runs there.
//
// `??=`-style guard: a test that explicitly wants the fetcher enabled can set the
// var beforehand and this won't clobber it.
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

if (process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF === undefined) {
  process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF = '1';
}

// Same `??=` guard, for the ask-first question. A unit test's fixture project is
// a bare mkdtemp dir with no recorded pluginUse answer, which under the shipped
// default (ASK_USE_PLUGIN_FIRST=true) reads as "the question is still pending"
// — and pending is a WRITE FENCE (shared/state/plugin-use.ts): every write under
// `<project>/.traffic-one/` is refused until the user answers. That is the
// product contract, but it is not what a unit test of writeState/ensureRunAgentClaim/
// captureClaimDebug/… is trying to characterize; those fixtures mean "a project
// the user already said yes to", they just never had to say so before the fence
// existed. Pinning the question off here says it once for the whole suite
// instead of 30-odd times, and matches the six test files that already pinned
// '0' at module scope for the same reason.
//
// The contract itself is still covered, deliberately rather than incidentally:
// state/__tests__/consent-write-fence.test.ts, the ask-first cases in
// session-start/prompt-submit/onboarding-gate/post-stack-setup/materialize-writer/
// pipeline all pin '1' locally, and tests/replay-corpus/env.ts DELETES this var
// so the whole replay corpus runs on the shipped default.
if (process.env.TRAFFIC_ONE_ASK_USE_PLUGIN === undefined) {
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';
}

// ── the machine state root ─────────────────────────────────────────────────
// The suite wrote into the DEVELOPER'S REAL ~/.traffic-one for six weeks:
// measured, 3,329 sha256-named project buckets / 13 MB, of which exactly one
// was the maintainer's genuine record and 3,328 were test residue.
// state/plugin-use.ts's machineStateDir, state/traffic-one-paths.ts's
// globalTrafficOneDir, one-settings.ts and toolchain-paths.ts all resolve that
// dir from XDG_STATE_HOME, falling back to $HOME — so nothing had to MENTION a
// path helper to reach it. The worst offender (state/__tests__/decision-log.test.ts,
// 12 buckets per run) names neither the machine dir nor this variable: it calls
// recordPluginUseChoice through ordinary production code, which is why a grep
// for the machine dir cannot enumerate the affected files and why this is pinned
// here instead of per call site.
//
// The pollution is the lesser half. The machine dir PERSISTS ACROSS RUNS, so it
// is the one piece of state that CI's "run npm test twice" leg structurally
// cannot police: a test that reads a bucket an earlier run left behind passes on
// both legs. Every test that writes a bucket was silently coupled to every later
// test — and to every later RUN — through the maintainer's home directory.
//
// Deliberately NOT inside the TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN opt-out below.
// That switch means "I am steering this run's plugin root and host environment
// from outside"; it is not a licence to write to the real machine dir, and the
// two guards above are already asserted to survive it.
const STATE_SCRATCH_PARENT = path.join(os.tmpdir(), 'traffic-one-test-state');

// A STRICT subdirectory of the temp dir, never the temp dir itself, and this is
// load-bearing rather than tidy: authoring-root.ts's homeStateRoots() adds
// XDG_STATE_HOME to the set of machine-config roots, and isMachineConfigRoot()
// is true for anything INSIDE one. Every fixture project in the suite is an
// os.tmpdir() mkdtemp dir, so pinning XDG_STATE_HOME at os.tmpdir() would
// reclassify all 291 test files' fixtures as machine-config space and stand
// every hook down. Under `<tmpdir>/traffic-one-test-state/<pid>` the scratch is
// a SIBLING of those fixtures, not an ancestor.
//
// Provenance is read off the VALUE, not off a separate marker variable: a path
// inside our own scratch parent can only have been set by a preload-isolated
// process, so a descendant recognises what its parent chose without us having to
// stamp anything. That matters in both directions. An ambient XDG_STATE_HOME —
// routine on Linux, where it is ~/.local/state — is NOT ours and is overridden,
// which is the whole defect; a value we handed a child IS ours and is left
// alone, so the child shares the parent's machine dir (what
// state/__tests__/claims-cas-race.test.ts and shared/__tests__/run-model-policy.test.ts
// mean when they race two real preload-loading processes over one state root).
// Do not relax this to `??=`: that honours the developer's real XDG_STATE_HOME
// and reinstates the bug on every Linux machine.
function stateScratchIsOurs(value) {
  return typeof value === 'string' && value !== ''
    && path.resolve(value).startsWith(STATE_SCRATCH_PARENT + path.sep);
}

// `node --test` runs this preload once per test FILE (measured: 291 child
// processes, one per file, and the runner process does not load it at all —
// nothing the runner sets could propagate anyway, since children are spawned
// from the ORIGINAL environment). So this is a per-file dir, which is stronger
// than one dir per run: two files can no longer couple through the machine dir
// even within a single run, and node:test's concurrency cannot race on it.
//
// Per-file also means ~291 dirs per run, i.e. exactly the leak class this repo
// has already swept three times (~600 dirs, then 2,376 dirs / 303 MB, then a
// third wave). Two mechanisms, because one is not enough:
//   - 'exit' removes this process's own dir. This is the PLAN, and it is what
//     makes a normal run delta-0 in the temp dir as well as in ~/.traffic-one;
//     the same hook is what keeps tests/replay-corpus/env.ts's isolated HOME
//     from leaking. rmSync is synchronous, the only kind of work 'exit' permits.
//   - the sweep is the BACKSTOP for the paths 'exit' cannot reach: a SIGKILL,
//     a runner crash, or the Ctrl-C a developer presses on a 7-minute suite.
//     Without it a single interrupted run leaks up to 291 dirs permanently,
//     which is how the previous waves accumulated.
const STATE_SCRATCH_STALE_MS = 10 * 60 * 1000;

// Liveness AND age, both required. Liveness alone has a race: pid N's dir is
// found stale, and before the rmSync lands the OS hands N to a new preload
// process that has just claimed that exact name — the sweep then deletes a live
// suite's machine state mid-test, silently. The age gate closes it, since a
// just-claimed dir is seconds old, and it costs nothing in the case that
// matters: residue from a crashed run is swept by the next run that starts more
// than STATE_SCRATCH_STALE_MS after the crash, so growth stays bounded and
// self-healing instead of monotonic.
function sweepAbandonedStateScratch(now) {
  let entries;
  try {
    entries = fs.readdirSync(STATE_SCRATCH_PARENT);
  } catch {
    return; // first run on this machine: nothing to sweep
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const dir = path.join(STATE_SCRATCH_PARENT, entry);
    try {
      if (now - fs.statSync(dir).mtimeMs < STATE_SCRATCH_STALE_MS) continue;
      // EPERM (someone else's pid) reads as ALIVE and is skipped: only ESRCH,
      // "no such process", is evidence the owner is gone.
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if (error && error.code !== 'ESRCH') continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort: a sweep failure must never fail a test run */ }
  }
}

if (!stateScratchIsOurs(process.env.XDG_STATE_HOME)) {
  const own = path.join(STATE_SCRATCH_PARENT, String(process.pid));
  sweepAbandonedStateScratch(Date.now());
  // Removed before it is created: a recycled pid must never hand this run the
  // residue of a previous one, which is the coupling being closed here.
  fs.rmSync(own, { recursive: true, force: true });
  fs.mkdirSync(own, { recursive: true });
  process.env.XDG_STATE_HOME = own;
  // Registered ONLY on the branch that created the dir. A descendant that
  // inherited its parent's scratch must not register this: it exits first, and
  // would delete the machine state its parent is still asserting against.
  process.once('exit', () => {
    // maxRetries: macOS can hold a just-written file open (Spotlight), turning
    // the rm into a transient ENOTEMPTY — the same retry replay-corpus/env.ts
    // needs for its isolated HOME.
    try {
      fs.rmSync(own, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch { /* best-effort */ }
  });
}

// ── the host + plugin env surface ──────────────────────────────────────────
// Everything in these namespaces the suite is allowed to inherit, and nothing
// else in them survives. An ALLOWLIST, because the previous design was a
// blocklist and it leaked exactly the way tests/replay-corpus/env.ts (which
// reached this same conclusion first, for this same reason) says a blocklist
// always will: it deleted CODEX_/CLAUDE_/CURSOR_PLUGIN_ROOT and left
// TRAFFIC_ONE_HOST — which detectHost() (src/shared/host/index.ts) reads FIRST
// and which AGENTS.md tells maintainers to export for `npm run plugin:sync`. A
// maintainer who did that got 4 failures across session/prompt-submit,
// session/session-start-lib and state/run-agent, with nothing naming the cause;
// CODEX_THREAD_ID (a second detectHost input) failed a fifth. A blocklist can
// only ever be as complete as the last audit of src/; the policy below cannot
// be outgrown by the next variable someone adds.
const PRELOAD_OWNED_ENV = new Set([
  // The two `??=`-guarded guards above: set by this file, or deliberately by a
  // test/harness that wants the other value, so they must outlive the wipe.
  'TRAFFIC_ONE_ASK_USE_PLUGIN',
  'TRAFFIC_ONE_MANAGED_RUNTIME_OFF',
  // The documented opt-out itself, read below.
  'TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN',
]);

// The plugin's own namespace, every supported host's, and the two code-graph
// providers' — the same inventory tests/replay-corpus/env.ts wipes, kept
// deliberately identical so the corpus and the rest of the suite cannot drift
// into disagreeing about what "isolated" means.
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

// Host markers with no underscore, which a prefix policy structurally cannot
// see: `CLAUDECODE` does not start with `CLAUDE_`. Every marker src/ names that
// is not covered above (see TERMINAL_MARKERS in src/build/sync-hosts.ts).
const HOST_ENV_EXACT = ['CLAUDECODE', 'GITHUB_COPILOT_CLI', 'CODEIUM_EDITOR'];

function wipeHostAndPluginEnv() {
  for (const key of Object.keys(process.env)) {
    if (PRELOAD_OWNED_ENV.has(key)) continue;
    if (!HOST_AND_PLUGIN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
      && !HOST_ENV_EXACT.includes(key)) continue;
    delete process.env[key];
  }
}

// The wipe belongs to the process that inherits the DEVELOPER'S SHELL, and to
// that process only.
//
// A test may legitimately spawn a child that loads this preload and configure it
// THROUGH the environment: src/shared/__tests__/run-model-policy.test.ts spawns
// two concurrent children with TRAFFIC_ONE_POLICY_STATE, TRAFFIC_ONE_HOST and
// TRAFFIC_ONE_PROJECT_PREFS_PATH set on purpose, because two real processes
// racing is the only way to characterize a create-once policy. Re-running the
// wipe there deletes that entire configuration — the child read
// `TRAFFIC_ONE_POLICY_STATE` as undefined and died in readFileSync.
//
// So the first isolated process stamps this marker, every descendant inherits
// it, and a descendant leaves the environment its parent handed it alone. That
// is not a hole: the values a descendant inherits are the ones an
// ALREADY-ISOLATED process chose, which is precisely what a test spawning a
// child means to control, and it also means a test that deliberately hands a
// child a hostile marker (to characterize detectHost) still gets what it asked
// for instead of having it silently erased.
//
// The check is EQUALITY against the resolved repo root, never presence. A
// presence test would make this variable an off switch for the whole wipe that
// any exported value — `=1`, an empty string, a leftover in a long-lived
// shell — silently flips, which is the blocklist failure one level up: the
// isolation would be protected by nothing but the obscurity of a name we
// invented. The stamped value is the absolute path this file resolves to at
// runtime, so an ambient marker does not match, falls through to the wipe (and
// is itself wiped, since it is in the TRAFFIC_ONE_ namespace and deliberately
// NOT in PRELOAD_OWNED_ENV, then re-stamped authentically), while a genuine
// descendant of this checkout matches exactly and keeps its configuration.
// Do not simplify this back to `!== undefined`.
const ISOLATION_MARKER = 'TRAFFIC_ONE_TEST_ENV_ISOLATED';

// Pin the plugin root to THIS checkout's repo root, derived from this file's
// own location, not process.cwd() (a test runner may be invoked from anywhere).
// pluginRoot() (src/shared/paths.ts) reads TRAFFIC_ONE_PLUGIN_ROOT/CODEX_*/
// CLAUDE_*/CURSOR_* first, so a developer shell's ambient TRAFFIC_ONE_PLUGIN_ROOT
// (routinely set to a stale `dist/` build) would otherwise steer the whole
// suite at a generated tree the suite's expectations aren't written against
// (makeSkillBlock/roleAgentDocCandidates resolve prose from `<root>/src/...`).
// The wipe closes the same channel for code that reads any of these vars
// directly instead of going through pluginRoot() (e.g. src/shared/host,
// src/shared/codex-mcp.ts, src/runners/doctor/probes.ts).
//
// fileURLToPath, not `.pathname` — pathname is percent-encoded, so a checkout
// path with a space or any non-ASCII byte would pin a root that doesn't exist.
//
// Escape hatch: a test that deliberately wants a different root must opt out
// with TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN=off set BEFORE this file loads — we do
// not honour an ambient TRAFFIC_ONE_PLUGIN_ROOT for this, since that is the bug.
// The wipe shares that one switch on purpose: opting out means "I am steering
// this run's plugin root and host environment from outside", and a pin that
// stood down while the wipe still deleted CLAUDE_PLUGIN_ROOT would honour half
// of that and silently discard the other half.
if (process.env.TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN !== 'off') {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  if (process.env[ISOLATION_MARKER] !== repoRoot) {
    wipeHostAndPluginEnv();
    // Stamped AFTER the wipe, so the wipe cannot remove what it just earned.
    process.env[ISOLATION_MARKER] = repoRoot;
  }
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = repoRoot;
}
