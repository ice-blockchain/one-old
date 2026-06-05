import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOpenCodeTool } from '../onboarding';

function withTemp(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-'));
  const env = process.env;
  const savedPath = env.PATH;
  const savedRoot = env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  const savedPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed-tools');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(dir);
  } finally {
    if (savedPath === undefined) delete env.PATH; else env.PATH = savedPath;
    if (savedRoot === undefined) delete env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
    if (savedPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureOpenCodeTool installs through a managed npm prefix (never global)', () => {
  withTemp((cwd) => {
    const bin = path.join(cwd, 'bin');
    const log = path.join(cwd, 'npm-args.log');
    fs.mkdirSync(bin, { recursive: true });
    // Stub npm: honour `--prefix <dir>` by dropping an opencode bin there.
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$@" >> "${log}"
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    shift
    prefix="$1"
  fi
  shift
done
if [ -z "$prefix" ]; then
  exit 1
fi
mkdir -p "$prefix/bin"
cat > "$prefix/bin/opencode" <<'OPENCODE'
#!/bin/sh
exit 0
OPENCODE
chmod +x "$prefix/bin/opencode"
exit 0
`, { mode: 0o755 });
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);

    const r = ensureOpenCodeTool(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'installed-managed-npm');
    assert.equal(r.installedVersion, '1.15.13');
    assert.ok(r.binPath?.includes(path.join('opencode', 'npm-prefix', 'bin', 'opencode')));
    const args = fs.readFileSync(log, 'utf8');
    assert.ok(args.includes('--prefix'));
    assert.ok(args.includes('opencode-ai@1.15.13'));
    const prefs = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH || '', 'utf8'));
    assert.equal(prefs.toolchain?.opencode?.installedVersion, '1.15.13');
  });
});

test('ensureOpenCodeTool reports install-skipped when npm is not on PATH', () => {
  withTemp((cwd) => {
    process.env.PATH = path.join(cwd, 'empty-bin');
    const r = ensureOpenCodeTool(cwd);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'install-skipped');
    assert.match(r.error || '', /npm/);
  });
});

test('ensureOpenCodeTool recognizes a present managed bin even if --version yields no version', () => {
  withTemp((cwd) => {
    // Managed OpenCode present, but its `--version` prints nothing — e.g. the
    // first-run DB migration timed out the 10s probe (the `_6_`-style
    // "enabled but installedVersion:null"). It must still be stamped, not dropped.
    const binDir = path.join(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT || '', 'opencode', 'npm-prefix', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // Empty PATH → no npm: a reinstall is impossible, so only the present-bin
    // fallback can make this succeed (proves the fix, not a reinstall).
    process.env.PATH = path.join(cwd, 'empty-bin');
    const r = ensureOpenCodeTool(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'used-managed');
    assert.equal(r.installedVersion, '1.15.13'); // recommended fallback
    const prefs = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH || '', 'utf8'));
    assert.equal(prefs.toolchain?.opencode?.installedVersion, '1.15.13');
  });
});
