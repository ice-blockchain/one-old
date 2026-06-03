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

test('ensureOpenCodeTool installs through a managed npm prefix', () => {
  withTemp((cwd) => {
    const bin = path.join(cwd, 'bin');
    const log = path.join(cwd, 'npm-args.log');
    fs.mkdirSync(bin, { recursive: true });
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
