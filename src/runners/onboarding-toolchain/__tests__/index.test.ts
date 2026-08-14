import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOnboardingToolchain } from '../index';
import { readGlobalCodeGraphProvider } from '../../../shared/state';

// Run with a sandboxed project-prefs file + machine-wide one.json + managed-
// toolchain root, then restore. codeGraphProvider is machine-wide now, so it goes
// into one.json (TRAFFIC_ONE_STATE_PATH); any other keys stay per-project prefs.
function withTemp(prefs: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbtc-'));
  const env = process.env;
  const savedPath = env.PATH;
  const savedRoot = env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  const savedPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const savedState = env.TRAFFIC_ONE_STATE_PATH;
  const savedCodexHome = env.CODEX_HOME;
  const savedCodexPluginRoot = env.CODEX_PLUGIN_ROOT;
  const savedTrafficOnePluginRoot = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const savedCodexOriginator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  const savedCodexThreadId = env.CODEX_THREAD_ID;
  const savedCursorPluginRoot = env.CURSOR_PLUGIN_ROOT;
  const savedHost = env.TRAFFIC_ONE_HOST;
  const prefsPath = path.join(dir, 'prefs.json');
  const onePath = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed-tools');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsPath;
  env.TRAFFIC_ONE_STATE_PATH = onePath;
  env.CODEX_HOME = path.join(dir, 'codex-home');
  delete env.CODEX_PLUGIN_ROOT;
  delete env.TRAFFIC_ONE_PLUGIN_ROOT;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_THREAD_ID;
  delete env.CURSOR_PLUGIN_ROOT;
  delete env.TRAFFIC_ONE_HOST;
  const { codeGraphProvider, mode, ...projectPrefs } = prefs;
  fs.writeFileSync(prefsPath, JSON.stringify(projectPrefs), 'utf8');
  // codeGraphProvider is machine-wide → one.json (TRAFFIC_ONE_STATE_PATH).
  if (codeGraphProvider) {
    fs.writeFileSync(onePath, JSON.stringify({ schemaVersion: 3, codeGraphProvider, hosts: {} }), 'utf8');
  }
  // mode is a per-PROJECT state field → cwd/.traffic-one/.one.json.
  if (mode) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ mode }), 'utf8');
  }
  try {
    fn(dir);
  } finally {
    if (savedPath === undefined) delete env.PATH; else env.PATH = savedPath;
    if (savedRoot === undefined) delete env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
    if (savedPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
    if (savedState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = savedState;
    if (savedCodexHome === undefined) delete env.CODEX_HOME; else env.CODEX_HOME = savedCodexHome;
    if (savedCodexPluginRoot === undefined) delete env.CODEX_PLUGIN_ROOT; else env.CODEX_PLUGIN_ROOT = savedCodexPluginRoot;
    if (savedTrafficOnePluginRoot === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = savedTrafficOnePluginRoot;
    if (savedCodexOriginator === undefined) delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE; else env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = savedCodexOriginator;
    if (savedCodexThreadId === undefined) delete env.CODEX_THREAD_ID; else env.CODEX_THREAD_ID = savedCodexThreadId;
    if (savedCursorPluginRoot === undefined) delete env.CURSOR_PLUGIN_ROOT; else env.CURSOR_PLUGIN_ROOT = savedCursorPluginRoot;
    if (savedHost === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = savedHost;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Plants `body` as an interpreter under EVERY name resolvePython() probes, and
 * returns a log path the stub appends one line to per invocation.
 *
 * A stub written to `python3` alone does not win. runtime-resolve.ts walks
 * VERSIONED names first — `python3.13` down to the required minor, each via
 * `which` and then at absolute dirs — and only reaches the generic `python3`
 * after all of them miss. Any machine carrying a versioned interpreter earlier in
 * that ladder therefore gets a REAL one: on the ubuntu leg `/usr/bin/python3.11`
 * answered the probe, so these rows drove a live `pip install graphify` from
 * PyPI. That passes where the network does, which is why it stayed invisible on
 * CI, and fails as a product bug where it does not (a container with no
 * `python3-venv`: three rows red, the report never written).
 *
 * The whole ladder is covered rather than today's ceiling, so raising the probe
 * ceiling cannot silently re-open the escape.
 */
function plantPythonStub(binDir: string, body: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(binDir, 'python-invocations.log');
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${body}`;
  for (let minor = 10; minor <= 20; minor += 1) {
    fs.writeFileSync(path.join(binDir, `python3.${minor}`), script, { mode: 0o755 });
  }
  for (const name of ['python3', 'python']) {
    fs.writeFileSync(path.join(binDir, name), script, { mode: 0o755 });
  }
  return log;
}

// Stub python3 that fakes `-m venv` → a venv python whose `-m pip install` drops
// a graphify bin that writes graphify-out/GRAPH_REPORT.md on `update .`.
function writeGraphifyStubPython(binDir: string): string {
  return plantPythonStub(binDir, `if [ "$1" = "-c" ]; then echo "3.12"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  cat > "$venv/bin/python" <<'PY'
#!/bin/sh
if [ "$1" = "-c" ]; then echo "3.12"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then
  dir=$(dirname "$0")
  cat > "$dir/graphify" <<'G'
#!/bin/sh
if [ "$1" = "update" ]; then mkdir -p graphify-out; printf '# graph\n' > graphify-out/GRAPH_REPORT.md; printf '{"nodes":[{"id":"src/index.ts"}],"links":[]}\n' > graphify-out/graph.json; fi
exit 0
G
  chmod +x "$dir/graphify"
  exit 0
fi
exit 1
PY
  chmod +x "$venv/bin/python"
  exit 0
fi
exit 1
`);
}

// Like above, but the installed graphify FAILS its scan the way real graphify
// does on a project with no code files (empty/new project at onboarding time):
// prints "No code files found" and exits 1, writing no report.
function writeGraphifyStubPythonScanFails(binDir: string): string {
  return plantPythonStub(binDir, `if [ "$1" = "-c" ]; then echo "3.12"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  cat > "$venv/bin/python" <<'PY'
#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  if [ "$3" = "show" ]; then echo "Version: 0.7.10"; exit 0; fi
  if [ "$3" = "install" ]; then
    dir=$(dirname "$0")
    cat > "$dir/graphify" <<'G'
#!/bin/sh
echo "No code files found - nothing to rebuild." 1>&2
exit 1
G
    chmod +x "$dir/graphify"
    exit 0
  fi
fi
exit 1
PY
  chmod +x "$venv/bin/python"
  exit 0
fi
exit 1
`);
}

// Like writeGraphifyStubPython, but the outer python3 ALSO answers the version
// probe (`-c 'import sys;print(...)'` → "3.12"), so the GUI-PATH-proof
// resolvePython() in providerRuntimeAvailable('graphify') accepts it. Lets a
// sibling-fallback test drive a real graphify install through the shared
// runtime resolver.
function writeGraphifyStubPythonWithVersion(binDir: string): string {
  return plantPythonStub(binDir, `if [ "$1" = "-c" ]; then echo "3.12"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  cat > "$venv/bin/python" <<'PY'
#!/bin/sh
if [ "$1" = "-c" ]; then echo "3.12"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then
  dir=$(dirname "$0")
  cat > "$dir/graphify" <<'G'
#!/bin/sh
if [ "$1" = "update" ]; then mkdir -p graphify-out; printf '# graph\n' > graphify-out/GRAPH_REPORT.md; printf '{"nodes":[{"id":"src/index.ts"}],"links":[]}\n' > graphify-out/graph.json; fi
exit 0
G
  chmod +x "$dir/graphify"
  exit 0
fi
exit 1
PY
  chmod +x "$venv/bin/python"
  exit 0
fi
exit 1
`);
}

test('new project: a first scan that finds no code does NOT gate onboarding (ok=true)', () => {
  withTemp({ codeGraphProvider: 'graphify' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    writeGraphifyStubPythonScanFails(bin);
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureOnboardingToolchain(cwd);
      // Tool is installed; an empty-project scan finding no code must NOT block
      // onboarding. Whether the (GUI-PATH-proof) install lands a real graphify
      // that scans the temp dir or defers, the never-block invariant is ok=true.
      assert.equal(r.ok, true);
      const gf = r.results.find((x) => x.tool === 'graphify');
      assert.equal(gf?.ok, true);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('existing-codebase: the first scan does NOT gate completion (graph is a soft note, never-block)', () => {
  withTemp({ codeGraphProvider: 'graphify', mode: 'existing-codebase' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    writeGraphifyStubPythonScanFails(bin);
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureOnboardingToolchain(cwd);
      // The graph is a token optimization — even on an existing codebase the first
      // scan is a soft note, NEVER a hard gate (was: gated completion). The
      // SessionStart self-heal + post-build hook rebuild it later.
      assert.equal(r.ok, true);
      const gf = r.results.find((x) => x.tool === 'graphify');
      assert.equal(gf?.ok, true);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('existing-codebase: a successful first scan completes onboarding + builds the graph', () => {
  withTemp({ codeGraphProvider: 'graphify', mode: 'existing-codebase' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    const log = writeGraphifyStubPython(bin);
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureOnboardingToolchain(cwd);
      // FIXTURE READBACK — no log means the resolver reached a real interpreter and
      // the report below would be written by a live PyPI graphify, not this fixture.
      assert.equal(fs.existsSync(log), true,
        'the stub python was never invoked: resolvePython escaped to a real interpreter');
      assert.equal(r.ok, true);
      assert.equal(r.results.find((x) => x.tool === 'graphify')?.ok, true);
      assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md')), true);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('graph provider succeeds + OpenCode fails → ok=true (warn-and-proceed)', () => {
  withTemp({ codeGraphProvider: 'graphify', openCode: { enabled: true } }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    writeGraphifyStubPython(bin);
    const savedPath = process.env.PATH;
    // python3 present (graphify installs via managed venv); npm absent (OpenCode fails).
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureOnboardingToolchain(cwd);
      assert.equal(r.provider, 'graphify');
      assert.equal(r.openCodeEnabled, true);
      // Required graph provider installed + scanned → not gated.
      assert.equal(r.ok, true);
      assert.equal(r.results.find((x) => x.tool === 'graphify')?.ok, true);
      // OpenCode failed but does NOT flip ok (optional token-saver).
      assert.equal(r.results.find((x) => x.tool === 'opencode')?.ok, false);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('Codex Desktop onboarding registers opencode-worker without plugin-root env', () => {
  withTemp({ codeGraphProvider: 'graphify', openCode: { enabled: true } }, (cwd) => {
    const env = process.env;
    assert.ok(env.CODEX_HOME, 'test CODEX_HOME is sandboxed');
    const pluginRoot = path.join(env.CODEX_HOME, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'opencode-mcp.cjs'), '#!/usr/bin/env node\n', 'utf8');
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';

    const bin = path.join(cwd, 'bin');
    writeGraphifyStubPython(bin);
    const savedPath = env.PATH;
    env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter); // graphify works; npm absent → OpenCode install warns only
    try {
      const r = ensureOnboardingToolchain(cwd);
      assert.equal(r.ok, true);
      const mcp = r.results.find((x) => x.tool === 'opencode-mcp');
      assert.equal(mcp?.ok, true);
      assert.equal(mcp?.action, 'codex-register:registered');
      const cfg = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
      assert.ok(cfg.includes('[mcp_servers.opencode-worker]'));
      assert.ok(cfg.includes('local-marketplaces/traffic-one-local/plugins/traffic-one/scripts/opencode-mcp.cjs'));
      assert.equal(r.results.find((x) => x.tool === 'graphify')?.ok, true);
      assert.equal(r.results.find((x) => x.tool === 'opencode')?.ok, false);
    } finally {
      if (savedPath === undefined) delete env.PATH; else env.PATH = savedPath;
    }
  });
});

test('neither provider can install → DEFERS (ok=true, never-block)', () => {
  // codeGraphAutoRun:false makes BOTH graphify and its gitnexus sibling return
  // install-skipped deterministically (machine-independent — no dependence on
  // whether a real Python/Node happens to be present). The provider must DEFER,
  // never gate onboarding.
  withTemp({ codeGraphProvider: 'graphify', codeGraphAutoRun: false }, (cwd) => {
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin');
    try {
      const r = ensureOnboardingToolchain(cwd);
      // Never-block: a provider that cannot be installed defers, ok stays true.
      assert.equal(r.ok, true);
      const gf = r.results.find((x) => x.tool === 'graphify');
      assert.equal(gf?.ok, true);
      assert.equal(gf?.action, 'deferred');
      assert.equal(gf?.error, null);
      // A deferral marker is persisted so doctor can surface the pending graph.
      const prefs = JSON.parse(fs.readFileSync(path.join(cwd, 'prefs.json'), 'utf8'));
      assert.ok(typeof prefs.graphDeferredAt === 'string' && prefs.graphDeferredAt);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('chosen provider fails but sibling runtime is available → falls back + persists the switch', () => {
  withTemp({ codeGraphProvider: 'gitnexus' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    // graphify python stub present (answers the version probe → resolvePython
    // accepts it, and installs via the managed venv). No node ≥22 and no ~/.nvm
    // (empty HOME) → the chosen gitnexus install fails fast, so the runner falls
    // back to graphify (the sibling whose Python runtime IS available).
    const log = writeGraphifyStubPythonWithVersion(bin);
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    process.env.HOME = path.join(cwd, 'empty-home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    try {
      const r = ensureOnboardingToolchain(cwd);
      // FIXTURE READBACK — the fallback is only proven if the SIBLING's runtime is
      // this stub. A real interpreter answering instead makes the row's subject a
      // live install.
      assert.equal(fs.existsSync(log), true,
        'the stub python was never invoked: resolvePython escaped to a real interpreter');
      // Never-block + graceful degrade: the working sibling carries the result.
      assert.equal(r.ok, true);
      const gf = r.results.find((x) => x.tool === 'graphify');
      assert.equal(gf?.ok, true);
      assert.match(gf?.action || '', /fell-back-to-graphify/);
      // The switch is persisted machine-wide so future sessions reuse graphify.
      assert.equal(readGlobalCodeGraphProvider(), 'graphify');
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });
});

test('unwritable prefs path during a defer must NOT throw (never-block holds on locked-down machines)', () => {
  // The exact locked-down / GUI-launched class this change must tolerate: the
  // per-project prefs file is unwritable (here: replaced by a DIRECTORY → every
  // writeFileSync throws EISDIR). The deferral's prefs write must be swallowed
  // (safePrefs); the runner must still return ok=true and never throw out.
  withTemp({ codeGraphProvider: 'graphify' }, (cwd) => {
    const savedPath = process.env.PATH;
    const prevProbe = process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF;
    process.env.PATH = path.join(cwd, 'empty-bin');
    process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF = '1'; // no runtime for either provider → deterministic defer
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    fs.rmSync(prefsPath, { force: true });
    fs.mkdirSync(prefsPath, { recursive: true }); // make every prefs write throw EISDIR
    try {
      assert.doesNotThrow(() => {
        const r = ensureOnboardingToolchain(cwd);
        assert.equal(r.ok, true);
        assert.equal(r.results.find((x) => x.tool === 'graphify')?.ok, true);
      });
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      if (prevProbe === undefined) delete process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF; else process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF = prevProbe;
    }
  });
});

test('progress snapshots: install → scan → done transitions on a successful run', () => {
  withTemp({ codeGraphProvider: 'graphify', mode: 'existing-codebase' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    const log = writeGraphifyStubPython(bin);
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    const snapshots: Array<Array<{ id: string; status: string }>> = [];
    try {
      const r = ensureOnboardingToolchain(cwd, (steps) => snapshots.push(steps.map((s) => ({ id: s.id, status: s.status }))));
      // FIXTURE READBACK — a `done` scan step is only this fixture's if the stub ran.
      assert.equal(fs.existsSync(log), true,
        'the stub python was never invoked: resolvePython escaped to a real interpreter');
      assert.equal(r.ok, true);
      // The initial plan snapshot lists every step before any work starts.
      assert.deepEqual(snapshots[0], [
        { id: 'graph-install', status: 'pending' },
        { id: 'graph-scan', status: 'pending' },
      ]);
      // The install→scan boundary is visible (graph-install done while the scan runs)…
      assert.ok(snapshots.some((s) => s[0]?.status === 'done' && s[1]?.status === 'running'));
      // …and the final snapshot reports everything done.
      const last = snapshots[snapshots.length - 1];
      assert.deepEqual(last, [
        { id: 'graph-install', status: 'done' },
        { id: 'graph-scan', status: 'done' },
      ]);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('progress snapshots: a deferred provider ends in warn, never blocking', () => {
  withTemp({ codeGraphProvider: 'graphify', codeGraphAutoRun: false }, (cwd) => {
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin');
    const snapshots: Array<Array<{ id: string; status: string }>> = [];
    try {
      const r = ensureOnboardingToolchain(cwd, (steps) => snapshots.push(steps.map((s) => ({ id: s.id, status: s.status }))));
      assert.equal(r.ok, true);
      const last = snapshots[snapshots.length - 1];
      assert.deepEqual(last, [
        { id: 'graph-install', status: 'warn' },
        { id: 'graph-scan', status: 'warn' },
      ]);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('no provider chosen → ok=true (nothing required to install)', () => {
  withTemp({}, (cwd) => {
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin');
    try {
      const r = ensureOnboardingToolchain(cwd);
      assert.equal(r.provider, null);
      assert.equal(r.ok, true);
      assert.equal(r.results.length, 0);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('OpenCode-compatible self hosts never install the optional OpenCode delegation tool', () => {
  for (const host of ['opencode', 'kilo'] as const) {
    withTemp({ openCode: { enabled: true, source: 'prompted' } }, (cwd) => {
      process.env.TRAFFIC_ONE_HOST = host;
      const r = ensureOnboardingToolchain(cwd);
      assert.equal(r.openCodeEnabled, false, host);
      assert.equal(r.results.some((entry) => entry.tool === 'opencode'), false, host);
    });
  }
});
