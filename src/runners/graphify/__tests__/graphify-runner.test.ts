import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { bootstrap, ensureGraphifyTool } from '../index';

function withProject(fn: (cwd: string, prefs: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gfboot-'));
  const saved = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const savedRoot = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  const prefs = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
  process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed-tools');
  try {
    fn(dir, prefs);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved;
    if (savedRoot === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('graphify bootstrap honours the graphifyAutoRun:false opt-out', () => {
  withProject((cwd, prefs) => {
    fs.writeFileSync(prefs, JSON.stringify({ graphifyAutoRun: false }), 'utf8');
    const r = bootstrap(cwd);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'install-skipped');
    assert.match(r.error || '', /graphifyAutoRun is false/);
  });
});

test('graphify bootstrap short-circuits on a fresh GRAPH_REPORT.md', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '# graph\n', 'utf8');
    const r = bootstrap(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh');
    assert.ok(r.report?.endsWith(path.join('graphify-out', 'GRAPH_REPORT.md')));
  });
});

test('graphify bootstrap returns install-skipped when graphify is absent + skipInstall', () => {
  withProject((cwd) => {
    // Force the "not on PATH" branch deterministically by pointing PATH at an
    // empty dir, so which('graphify') fails regardless of the host machine.
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin');
    try {
      const r = bootstrap(cwd, { skipInstall: true });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'install-skipped');
      assert.match(r.error || '', /missing or below the minimum supported version and skipInstall=true/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('graphify ensure falls back to a managed venv without pip --user', () => {
  withProject((cwd, prefs) => {
    // Stub a python3 that fakes `-m venv` (creates a venv python which, on
    // `-m pip install`, drops a graphify bin). pipx is absent on PATH, so the
    // installer must take the managed-venv path — never `pip install --user`.
    const bin = path.join(cwd, 'bin');
    const log = path.join(cwd, 'python-args.log');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  cat > "$venv/bin/python" <<'PY'
#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  dir=$(dirname "$0")
  cat > "$dir/graphify" <<'G'
#!/bin/sh
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

    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureGraphifyTool(cwd);
      assert.equal(r.ok, true);
      assert.equal(r.action, 'installed-venv');
      assert.equal(r.installedVersion, '0.7.10');
      assert.ok(r.binPath?.includes(path.join('graphify', 'venv', 'bin', 'graphify')));
      assert.equal(fs.readFileSync(log, 'utf8').includes('--user'), false);
      const saved = JSON.parse(fs.readFileSync(prefs, 'utf8'));
      assert.equal(saved.toolchain?.graphify?.installedVersion, '0.7.10');
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});
