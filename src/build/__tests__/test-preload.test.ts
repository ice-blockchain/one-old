// src/build/test-preload.mjs decides the environment EVERY test in the suite
// runs in, and it is the only file that does. It had no test of its own, and
// CI "covered" it by running the whole suite a second time with a hostile
// TRAFFIC_ONE_PLUGIN_ROOT exported — a leg that could not fail, because the
// pin under test overwrote that value before a single test file loaded, making
// the second run byte-identical to the first at full suite cost.
//
// Everything that leg claimed to prove is a property of ~20 lines of env
// handling, so it is proven here instead: by spawning node with the preload
// and a hostile env and reading back what the preload left behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');

// The child reports its ENTIRE environment, not a hand-listed subset. That
// distinction is the point: an observation list can only ever catch variables
// the preload already decided to manage, so it could not have caught
// TRAFFIC_ONE_HOST leaking into the suite — the variable AGENTS.md tells
// maintainers to export — and it would not catch the next one either.
type Observed = Partial<Record<string, string>>;

// A DELIBERATELY minimal env: inheriting this process's would inherit the very
// pin under test (the suite runs under this preload), so every assertion below
// would be reading its own parent's state.
function preloadEnv(ambient: Record<string, string>, preload: string = PRELOAD): Observed {
  const script = 'process.stdout.write(JSON.stringify(process.env))';
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, '-e', script],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...ambient } },
  );
  assert.equal(result.status, 0, `preload run failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Observed;
}

// ── the machine state root ───────────────────────────────────────────────────
// The defect these cover: the suite wrote into the maintainer's real
// ~/.traffic-one for six weeks — measured, 3,329 project buckets / 13 MB, of
// which exactly one was a genuine user record. Nothing in the suite had to NAME
// the machine dir to reach it (the worst offender,
// state/__tests__/decision-log.test.ts, mentions neither the dir nor
// XDG_STATE_HOME and wrote 12 buckets per run through ordinary production code),
// so the property is asserted here, at the one place that can hold it, rather
// than per call site.

// Every case below runs the preload under a PRIVATE TMPDIR. os.tmpdir() reads
// TMPDIR on POSIX, so the whole scratch tree moves with it — which keeps these
// assertions from touching, or racing, the scratch parent the surrounding
// suite's own 291 test-file processes are using while this file runs.
function withPrivateTmp(fn: (tmp: string, scratchParent: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-preload-state-'));
  try {
    fn(tmp, path.join(tmp, 'traffic-one-test-state'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// Backdated far past any plausible staleness threshold, and deliberately not
// derived from the preload's own constant: the property under test is "an
// abandoned dir is eventually swept / a fresh one never is", not the exact
// number of minutes, so a case that restated the constant would only be
// asserting that a copy matches its original.
const LONG_ABANDONED_MS = 24 * 60 * 60 * 1000;

function seedScratch(scratchParent: string, pid: number, ageMs: number): string {
  const dir = path.join(scratchParent, String(pid));
  fs.mkdirSync(path.join(dir, 'traffic-one', 'projects', 'seeded-bucket'), { recursive: true });
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(dir, when, when);
  return dir;
}

// A pid that has definitely exited, taken from a real process rather than
// invented: a made-up number could belong to something live on the machine.
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  const pid = result.pid as number;
  assert.ok(Number.isInteger(pid) && pid > 0, 'could not obtain a pid to retire');
  try {
    process.kill(pid, 0);
    return 0; // recycled already — the caller skips rather than asserting falsely
  } catch {
    return pid;
  }
}

test('an ambient XDG_STATE_HOME is OVERRIDDEN, so the real ~/.traffic-one is unreachable from the suite', () => {
  withPrivateTmp((tmp, scratchParent) => {
    // The shape that makes this urgent: XDG_STATE_HOME is routinely set on
    // Linux, so a `??=`-style guard would file 13 MB of test residue under the
    // developer's real state dir on every CI machine and every Linux checkout.
    const ambient = path.join(tmp, 'a-real-looking', '.local', 'state');
    const env = preloadEnv({ TMPDIR: tmp, XDG_STATE_HOME: ambient });

    assert.notEqual(env.XDG_STATE_HOME, ambient, 'the ambient value must not survive');
    assert.ok(
      env.XDG_STATE_HOME?.startsWith(scratchParent + path.sep),
      `expected a scratch root under ${scratchParent}, got ${env.XDG_STATE_HOME}`,
    );
    // state/plugin-use.ts's machineStateDir and traffic-one-paths.ts's
    // globalTrafficOneDir both fall back to $HOME when XDG_STATE_HOME is
    // absent, so "set to something" is the whole mechanism.
    assert.notEqual(env.XDG_STATE_HOME, undefined);
  });
});

test('the scratch root is a STRICT subdirectory of the temp dir, never the temp dir itself', () => {
  withPrivateTmp((tmp, scratchParent) => {
    const env = preloadEnv({ TMPDIR: tmp });
    const pinned = env.XDG_STATE_HOME as string;

    // Not a tidiness preference. authoring-root.ts's homeStateRoots() adds
    // XDG_STATE_HOME to the machine-config roots, and isMachineConfigRoot() is
    // true for anything INSIDE one — while every fixture project in the suite is
    // an os.tmpdir() mkdtemp dir. Pinning the temp dir itself would reclassify
    // all of them as machine-config space and stand every hook down.
    assert.notEqual(path.resolve(pinned), path.resolve(tmp));
    assert.equal(path.dirname(pinned), scratchParent);
    assert.equal(path.dirname(scratchParent), tmp);
    // Named after the owning process, which is what makes the sweep below able
    // to tell an abandoned dir from a live one.
    assert.match(path.basename(pinned), /^\d+$/);
  });
});

test('a descendant keeps the state root its parent chose, so two preload-loading processes share one machine dir', () => {
  withPrivateTmp((tmp, scratchParent) => {
    // What this protects: state/__tests__/claims-cas-race.test.ts and
    // shared/__tests__/run-model-policy.test.ts race two real preload-loading
    // processes over ONE state root. Handing the child its own would make both
    // of them characterize nothing.
    const chosen = path.join(scratchParent, '4242');
    assert.equal(preloadEnv({ TMPDIR: tmp, XDG_STATE_HOME: chosen }).XDG_STATE_HOME, chosen);

    // And the boundary, because provenance is read off the VALUE rather than a
    // marker variable: a path in the same temp dir but OUTSIDE the scratch
    // parent is not ours and is still overridden.
    const notOurs = path.join(tmp, 'not-the-scratch-parent');
    assert.notEqual(preloadEnv({ TMPDIR: tmp, XDG_STATE_HOME: notOurs }).XDG_STATE_HOME, notOurs);
  });
});

test('the scratch root is removed when its process exits, so a full run leaks nothing', () => {
  withPrivateTmp((tmp, scratchParent) => {
    // The trade this makes explicit: `node --test` loads the preload once per
    // test FILE (291 of them), so a dir that outlived its process would trade
    // 3,329 real-dir entries for ~291 leaked temp trees per run — the exact
    // leak class this repo has already swept three times.
    const pinned = preloadEnv({ TMPDIR: tmp }).XDG_STATE_HOME as string;
    assert.ok(pinned, 'nothing was pinned, so this case would pass vacuously');
    assert.equal(fs.existsSync(pinned), false, `${pinned} outlived the process that owned it`);
    assert.deepEqual(
      fs.existsSync(scratchParent) ? fs.readdirSync(scratchParent) : [],
      [],
      'the scratch parent must be empty once every owner has exited',
    );
  });
});

test('an ABANDONED scratch root is swept, while a live owner\'s and a fresh one are left alone', () => {
  withPrivateTmp((tmp, scratchParent) => {
    // 'exit' is the plan; this is the backstop it cannot be. A SIGKILL, a runner
    // crash, or the Ctrl-C a developer presses on a 7-minute suite leaves up to
    // 291 dirs behind with no handler having run, and without a sweep that
    // residue is permanent rather than self-healing.
    // Two RETIRED pids, not one plus an adjacent guess: pids are handed out in
    // increasing order, so both are safely below whatever the preload child gets
    // and neither can be cleared by its owner rather than by the sweep. (An
    // earlier draft used `retired + 1` for the fresh case; the child took that
    // pid, claimed the dir and removed it on exit, and the case failed for a
    // reason that had nothing to do with sweeping.)
    const retired = deadPid();
    const alsoRetired = deadPid();
    if (retired === 0 || alsoRetired === 0) return; // a pid recycled; nothing to assert
    const abandoned = seedScratch(scratchParent, retired, LONG_ABANDONED_MS);
    // This test process is alive, so its dir must survive however old it looks —
    // deleting a live suite's machine state mid-run is strictly worse than
    // leaking a directory.
    const live = seedScratch(scratchParent, process.pid, LONG_ABANDONED_MS);
    // Age is required as well as liveness: without it, a dir claimed moments ago
    // by a REUSED pid is indistinguishable from residue, and a sweep racing that
    // claim deletes a running file's state root silently.
    const fresh = seedScratch(scratchParent, alsoRetired, 0);

    preloadEnv({ TMPDIR: tmp });

    assert.equal(fs.existsSync(abandoned), false, 'an abandoned dir whose owner is gone must be swept');
    assert.equal(fs.existsSync(live), true, 'a LIVE process\'s state root must never be swept');
    assert.equal(fs.existsSync(fresh), true, 'a just-claimed dir must never be swept, however dead its pid looks');
  });
});

test('a recycled pid inherits no residue: the claim is a delete THEN a create', () => {
  withPrivateTmp((tmp) => {
    // The coupling being closed, in its narrowest form. Pids recycle, and the
    // sweep deliberately skips the running process's OWN dir, so without this a
    // run could open onto residue a crashed predecessor left under the same
    // name — residue read as state, which is the cross-run non-determinism this
    // whole fix is about.
    //
    // Seeded by a preload that runs BEFORE the one under test (--import is
    // evaluated in order), so the residue is planted in the very process that
    // then has to clear it. Guessing a child's pid from the outside could only
    // ever produce a case that skips itself.
    const seed = path.join(tmp, 'seed.mjs');
    fs.writeFileSync(seed, [
      'import * as fs from "node:fs";',
      'import * as os from "node:os";',
      'import * as path from "node:path";',
      'const own = path.join(os.tmpdir(), "traffic-one-test-state", String(process.pid));',
      'fs.mkdirSync(path.join(own, "traffic-one", "projects", "residue-bucket"), { recursive: true });',
      // Proof the seed actually landed, kept outside the scratch so the claim
      // cannot erase the evidence that there was something to erase.
      'fs.writeFileSync(path.join(os.tmpdir(), "seeded.txt"), own, "utf8");',
    ].join('\n'), 'utf8');

    const observer = path.join(tmp, 'observe.mjs');
    fs.writeFileSync(observer, [
      'import * as fs from "node:fs";',
      'import * as path from "node:path";',
      'const dir = path.join(process.env.XDG_STATE_HOME, "traffic-one", "projects");',
      'process.stdout.write(JSON.stringify(fs.existsSync(dir) ? fs.readdirSync(dir) : []));',
    ].join('\n'), 'utf8');

    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(seed).href, '--import', pathToFileURL(PRELOAD).href, observer],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: tmp } },
    );
    assert.equal(result.status, 0, result.stderr);

    const seeded = fs.readFileSync(path.join(tmp, 'seeded.txt'), 'utf8');
    assert.ok(seeded, 'the seed preload did not run, so this case would pass vacuously');
    assert.deepEqual(
      JSON.parse(result.stdout) as string[], [],
      `residue under ${seeded} survived the claim and was handed to the new owner`,
    );
  });
});

test('the state root pin survives the plugin-root pin opt-out', () => {
  withPrivateTmp((tmp, scratchParent) => {
    // TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN=off means "I am steering this run's plugin
    // root and host environment from outside". It is not a licence to write to
    // the developer's real machine dir, so it must not reach this pin — same
    // posture as the ask-first and managed-runtime guards above.
    const env = preloadEnv({ TMPDIR: tmp, TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN: 'off' });
    assert.ok(env.XDG_STATE_HOME?.startsWith(scratchParent + path.sep), env.XDG_STATE_HOME);
  });
});

// Kept in sync with the preload by assertion, not by hope: the test below
// derives its expectation from the preload's own source text, so adding a
// namespace there without widening this list is a failure here.
const NAMESPACE_PREFIXES = [
  'TRAFFIC_ONE_', 'CLAUDE_', 'CODEX_', 'CURSOR_', 'COPILOT_',
  'WINDSURF_', 'KILO_', 'OPENCODE_', 'DEVIN_', 'GITNEXUS_', 'GRAPHIFY_',
];

const NAMESPACE_EXACT = ['CLAUDECODE', 'GITHUB_COPILOT_CLI', 'CODEIUM_EDITOR'];

function inNamespace(key: string): boolean {
  return NAMESPACE_PREFIXES.some((prefix) => key.startsWith(prefix)) || NAMESPACE_EXACT.includes(key);
}

const STALE = '/tmp/stale-plugin-root-that-must-never-win';

test('the pin overrides a hostile ambient plugin root and closes the three host-specific channels', () => {
  const env = preloadEnv({
    TRAFFIC_ONE_PLUGIN_ROOT: STALE,
    CODEX_PLUGIN_ROOT: STALE,
    CLAUDE_PLUGIN_ROOT: STALE,
    CURSOR_PLUGIN_ROOT: STALE,
  });

  assert.equal(env.TRAFFIC_ONE_PLUGIN_ROOT, REPO_ROOT);
  // Deleted, not overwritten: src/shared/host, codex-mcp.ts and the doctor
  // probes read these directly instead of going through pluginRoot().
  assert.equal(env.CODEX_PLUGIN_ROOT, undefined);
  assert.equal(env.CLAUDE_PLUGIN_ROOT, undefined);
  assert.equal(env.CURSOR_PLUGIN_ROOT, undefined);
});

// The blocker this closes, named: exporting TRAFFIC_ONE_HOST is documented in
// AGENTS.md for `npm run plugin:sync`, and doing it made `npm test` red — 4
// failures across session/prompt-submit, session/session-start-lib and
// state/run-agent — because detectHost() reads it before anything else.
// CODEX_THREAD_ID is the same class of input and failed a fifth test.
test('the host-detection inputs detectHost() reads cannot reach the suite from the shell', () => {
  const env = preloadEnv({
    TRAFFIC_ONE_HOST: 'windsurf',
    CODEX_THREAD_ID: 'thread-from-the-surrounding-session',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode_extension',
    CLAUDECODE: '1',
  });

  for (const key of ['TRAFFIC_ONE_HOST', 'CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CLAUDECODE']) {
    assert.equal(env[key], undefined, `${key} survived the wipe and steers detectHost()`);
  }
});

// The property an observation list cannot have. Every namespace is fed a
// variable the preload has never heard of — including an invented one — and the
// only survivors permitted are the three the preload owns plus the root it
// pins. This is what makes the isolation a policy: a variable added to src/
// tomorrow is already covered, with no audit and no edit here.
test('nothing in the plugin or host namespaces survives except what the preload explicitly owns', () => {
  const hostile: Record<string, string> = {
    TRAFFIC_ONE_HOST: 'windsurf',
    TRAFFIC_ONE_AUTH: 'on',
    TRAFFIC_ONE_USER_PLAN: 'pro',
    TRAFFIC_ONE_A_VARIABLE_NOBODY_HAS_AUDITED_YET: 'x',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'x',
    CODEX_THREAD_ID: 'x',
    CODEX_HOME: '/tmp/somebody-elses-codex',
    CURSOR_TRACE_ID: 'x',
    COPILOT_HOME: '/tmp/somebody-elses-copilot',
    WINDSURF_SESSION_ID: 'x',
    KILO_SESSION_ID: 'x',
    OPENCODE_SERVER: 'http://127.0.0.1:1',
    DEVIN_SESSION_ID: 'x',
    GITNEXUS_TOKEN: 'x',
    GRAPHIFY_BIN: '/tmp/graphify',
    GITHUB_COPILOT_CLI: '1',
    CODEIUM_EDITOR: 'x',
  };
  // Every key above must actually be in the wiped surface, or this test would
  // "pass" by testing variables the policy was never meant to cover.
  for (const key of Object.keys(hostile)) {
    assert.ok(inNamespace(key), `${key} is not in the namespace policy — fix the fixture or the policy`);
  }

  const survivors = Object.keys(preloadEnv(hostile)).filter(inNamespace).sort();
  assert.deepEqual(survivors, [
    'TRAFFIC_ONE_ASK_USE_PLUGIN',
    'TRAFFIC_ONE_MANAGED_RUNTIME_OFF',
    'TRAFFIC_ONE_PLUGIN_ROOT',
    // Stamped by the wipe itself, so a child this process spawns inherits the
    // environment it was handed instead of being re-isolated — see below.
    'TRAFFIC_ONE_TEST_ENV_ISOLATED',
  ]);
});

// A test that spawns a preload-loading CHILD is configuring that child on
// purpose. src/shared/__tests__/run-model-policy.test.ts races two of them with
// TRAFFIC_ONE_POLICY_STATE/TRAFFIC_ONE_HOST/TRAFFIC_ONE_PROJECT_PREFS_PATH set,
// because two real processes are the only way to characterize a create-once
// policy — a second wipe deletes that configuration and the child dies reading
// an undefined path. The already-isolated parent stamps a marker, and a process
// that sees it leaves the environment alone.
test('a child of an already-isolated process keeps the environment its parent handed it', () => {
  const handedDown = {
    TRAFFIC_ONE_TEST_ENV_ISOLATED: REPO_ROOT,
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_POLICY_STATE: '/tmp/a-path-the-parent-chose.json',
    TRAFFIC_ONE_USER_PLAN: 'pro',
  };
  const env = preloadEnv(handedDown);
  for (const [key, value] of Object.entries(handedDown)) {
    assert.equal(env[key], value, `${key} must survive: an isolated parent chose it deliberately`);
  }
  // The root pin is unconditional, exactly as before: only the wipe is nested.
  assert.equal(env.TRAFFIC_ONE_PLUGIN_ROOT, REPO_ROOT);
});

// What makes the marker above safe is that it is checked by EQUALITY against the
// resolved repo root, not by presence. A presence test would hand every shell an
// off switch for the entire wipe — `export TRAFFIC_ONE_TEST_ENV_ISOLATED=1` and
// the isolation is gone — which is the blocklist defect one level up, protected
// by nothing but the obscurity of a name we invented.
//
// BOTH directions are asserted on purpose. A fix that only closes the forgery is
// easy to over-correct into "always wipe", which silently reintroduces the
// run-model-policy failure (a child configured through the env, stripped), and no
// forgery-only test could tell the two apart.
test('a forged isolation marker cannot disable the wipe, while the authentic one is honoured', () => {
  // Read back what an isolating process actually stamps rather than restating it,
  // so the round trip below is proven against the real value.
  const authentic = preloadEnv({}).TRAFFIC_ONE_TEST_ENV_ISOLATED;
  assert.equal(authentic, REPO_ROOT, 'the stamp must be the resolved repo root');

  // Every shape a shell might plausibly hold: a boolean-ish value, an empty
  // export, a near-miss on the real path, and another checkout entirely.
  const forgeries = [
    '1', '', 'true', '0', 'isolated',
    `${REPO_ROOT}/`, `${REPO_ROOT}/src`, path.dirname(REPO_ROOT),
    '/tmp/some-other-checkout',
  ];
  for (const forged of forgeries) {
    const label = `TRAFFIC_ONE_TEST_ENV_ISOLATED=${JSON.stringify(forged)}`;
    const env = preloadEnv({
      TRAFFIC_ONE_TEST_ENV_ISOLATED: forged,
      TRAFFIC_ONE_HOST: 'windsurf',
      CODEX_THREAD_ID: 'thread-from-the-surrounding-session',
      CLAUDECODE: '1',
    });
    for (const key of ['TRAFFIC_ONE_HOST', 'CODEX_THREAD_ID', 'CLAUDECODE']) {
      assert.equal(env[key], undefined, `${label} disabled the wipe and ${key} reached the suite`);
    }
    // The forgery is not merely ignored: it is wiped and re-stamped, so a child
    // of this process is a genuine descendant instead of inheriting a value that
    // means nothing.
    assert.equal(env.TRAFFIC_ONE_TEST_ENV_ISOLATED, authentic, `${label} was left in place`);
  }

  // The other direction, with the value the parent really stamps: a genuine
  // descendant's deliberate configuration survives untouched.
  const descendant = preloadEnv({
    TRAFFIC_ONE_TEST_ENV_ISOLATED: authentic as string,
    TRAFFIC_ONE_HOST: 'codex',
    CODEX_THREAD_ID: 'a-thread-the-parent-chose',
  });
  assert.equal(descendant.TRAFFIC_ONE_HOST, 'codex');
  assert.equal(descendant.CODEX_THREAD_ID, 'a-thread-the-parent-chose');
});

// The namespace list is data in another file, so a namespace added there and
// not here would leave this file asserting less than it appears to.
test('the namespaces this test polices are the namespaces the preload wipes', () => {
  const source = fs.readFileSync(PRELOAD, 'utf8');
  const literals = (name: string): string[] => {
    const block = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source);
    assert.ok(block, `could not find ${name} in ${PRELOAD}`);
    return [...block![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
  };
  assert.deepEqual(literals('HOST_AND_PLUGIN_ENV_PREFIXES'), [...NAMESPACE_PREFIXES].sort());
  assert.deepEqual(literals('HOST_ENV_EXACT'), [...NAMESPACE_EXACT].sort());
});

test('the pin is derived from the preload\'s own location, not cwd', () => {
  assert.equal(preloadEnv({}).TRAFFIC_ONE_PLUGIN_ROOT, REPO_ROOT);
});

// fileURLToPath vs import.meta.url.pathname: pathname is percent-encoded, so
// a checkout under a path containing a space (or any non-ASCII byte) would pin
// `/Users/me/my%20code` — a directory that does not exist — and every test
// resolving prose from the plugin root would silently read nothing.
test('a checkout path containing a space pins a root that actually exists', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-preload-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const spaced = path.join(parent, 'my code checkout');
  fs.mkdirSync(path.join(spaced, 'src', 'build'), { recursive: true });
  const copy = path.join(spaced, 'src', 'build', 'test-preload.mjs');
  fs.copyFileSync(PRELOAD, copy);

  const pinned = preloadEnv({}, copy).TRAFFIC_ONE_PLUGIN_ROOT;
  // realpath, because node resolves import.meta.url through symlinks and
  // macOS's tmpdir is one (/var -> /private/var).
  assert.equal(pinned, fs.realpathSync(spaced));
  assert.ok(pinned!.includes('my code checkout'), `the space must survive verbatim, not as %20: ${pinned}`);
  assert.equal(fs.existsSync(pinned!), true);
});

// The escape hatch AGENTS.md documents, and the reason the CI leg that
// exported a stale root could not fail: without this opt-out, an ambient
// TRAFFIC_ONE_PLUGIN_ROOT has no effect whatsoever on a `npm test` run.
// The opt-out covers the wipe as well as the pin, on one switch: it means "I am
// steering this run's plugin root and host environment from outside", and
// standing the pin down while still deleting CLAUDE_PLUGIN_ROOT would honour
// half of that and silently discard the other half.
test('TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN=off leaves the ambient root and host environment entirely alone', () => {
  const env = preloadEnv({
    TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN: 'off',
    TRAFFIC_ONE_PLUGIN_ROOT: STALE,
    CLAUDE_PLUGIN_ROOT: STALE,
    TRAFFIC_ONE_HOST: 'windsurf',
  });

  assert.equal(env.TRAFFIC_ONE_PLUGIN_ROOT, STALE);
  assert.equal(env.CLAUDE_PLUGIN_ROOT, STALE);
  assert.equal(env.TRAFFIC_ONE_HOST, 'windsurf');
});

test('only the exact value `off` opts out — a truthy-looking value must not disable the pin', () => {
  for (const value of ['0', 'false', 'no', 'OFF', '']) {
    const env = preloadEnv({ TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN: value, TRAFFIC_ONE_PLUGIN_ROOT: STALE });
    assert.equal(env.TRAFFIC_ONE_PLUGIN_ROOT, REPO_ROOT, `TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN=${JSON.stringify(value)} must not opt out`);
  }
});

// The consent fence default reverses what a bare mkdtemp fixture MEANS: under
// the shipped default the unanswered question is a write fence, so without
// this the suite fails wholesale. It is independent of the root pin and must
// survive the opt-out.
test('the ask-first and managed-runtime guards default closed and survive the pin opt-out', () => {
  const pinned = preloadEnv({});
  assert.equal(pinned.TRAFFIC_ONE_ASK_USE_PLUGIN, '0');
  assert.equal(pinned.TRAFFIC_ONE_MANAGED_RUNTIME_OFF, '1');

  const unpinned = preloadEnv({ TRAFFIC_ONE_TEST_PLUGIN_ROOT_PIN: 'off' });
  assert.equal(unpinned.TRAFFIC_ONE_ASK_USE_PLUGIN, '0');
  assert.equal(unpinned.TRAFFIC_ONE_MANAGED_RUNTIME_OFF, '1');
});

// `??=`, not `=`: the ask-first cases and the replay corpus set these
// deliberately, and a preload that clobbered them would erase the only
// coverage of the shipped defaults.
test('a test that sets the guards itself is never clobbered', () => {
  const env = preloadEnv({ TRAFFIC_ONE_ASK_USE_PLUGIN: '1', TRAFFIC_ONE_MANAGED_RUNTIME_OFF: '0' });
  assert.equal(env.TRAFFIC_ONE_ASK_USE_PLUGIN, '1');
  assert.equal(env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF, '0');
});
