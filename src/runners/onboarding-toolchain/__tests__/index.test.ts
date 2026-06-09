import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOnboardingToolchain } from '../index';

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
  const prefsPath = path.join(dir, 'prefs.json');
  const onePath = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed-tools');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsPath;
  env.TRAFFIC_ONE_STATE_PATH = onePath;
  const { codeGraphProvider, mode, ...projectPrefs } = prefs;
  fs.writeFileSync(prefsPath, JSON.stringify(projectPrefs), 'utf8');
  // codeGraphProvider is machine-wide → one.json (TRAFFIC_ONE_STATE_PATH).
  if (codeGraphProvider) fs.writeFileSync(onePath, JSON.stringify({ version: 1, codeGraphProvider }), 'utf8');
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
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Stub python3 that fakes `-m venv` → a venv python whose `-m pip install` drops
// a graphify bin that writes graphify-out/GRAPH_REPORT.md on `update .`.
function writeGraphifyStubPython(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'python3'), `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  cat > "$venv/bin/python" <<'PY'
#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then
  dir=$(dirname "$0")
  cat > "$dir/graphify" <<'G'
#!/bin/sh
if [ "$1" = "update" ]; then mkdir -p graphify-out; printf '# graph\n' > graphify-out/GRAPH_REPORT.md; fi
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
`, { mode: 0o755 });
}

// Like above, but the installed graphify FAILS its scan the way real graphify
// does on a project with no code files (empty/new project at onboarding time):
// prints "No code files found" and exits 1, writing no report.
function writeGraphifyStubPythonScanFails(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'python3'), `#!/bin/sh
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
`, { mode: 0o755 });
}

test('graph provider installs but the first scan finds no code → ok=true (scan not gated)', () => {
  withTemp({ codeGraphProvider: 'graphify' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    writeGraphifyStubPythonScanFails(bin);
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureOnboardingToolchain(cwd);
      // Tool is installed; an empty-project scan failure must NOT block onboarding.
      assert.equal(r.ok, true);
      const gf = r.results.find((x) => x.tool === 'graphify');
      assert.equal(gf?.ok, true);
      assert.match(gf?.action || '', /scan deferred/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('existing-codebase: a failed first scan GATES completion (graph required, no later trigger)', () => {
  withTemp({ codeGraphProvider: 'graphify', mode: 'existing-codebase' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    writeGraphifyStubPythonScanFails(bin);
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureOnboardingToolchain(cwd);
      // Existing repo has code now → the graph MUST build; a failed scan blocks.
      assert.equal(r.ok, false);
      const gf = r.results.find((x) => x.tool === 'graphify');
      assert.equal(gf?.ok, false);
      assert.match(gf?.action || '', /scan failed/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('existing-codebase: a successful first scan completes onboarding + builds the graph', () => {
  withTemp({ codeGraphProvider: 'graphify', mode: 'existing-codebase' }, (cwd) => {
    const bin = path.join(cwd, 'bin');
    writeGraphifyStubPython(bin);
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureOnboardingToolchain(cwd);
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

test('required graph provider fails → ok=false (gates completion)', () => {
  withTemp({ codeGraphProvider: 'graphify' }, (cwd) => {
    const savedPath = process.env.PATH;
    // Empty PATH: no pipx, no python3 → graphify cannot install.
    process.env.PATH = path.join(cwd, 'empty-bin');
    try {
      const r = ensureOnboardingToolchain(cwd);
      assert.equal(r.ok, false);
      assert.equal(r.results.find((x) => x.tool === 'graphify')?.ok, false);
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
