import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  GITNEXUS_MIN_NODE_MAJOR,
  bootstrap,
  currentNodeMajor,
  findNvmNode22,
  gitnexusGraphIsEmpty,
  gitnexusPackageSpec,
  nodeVersionMismatchMessage,
  nvmPresent,
} from '../index';
import { backupConflicts } from '../bootstrap-env';

// Run a fn with a fake $HOME pointing at a temp dir (synchronous; restored after).
function withHome(setup: (home: string) => void, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gnvm-'));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    setup(dir);
    fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeNvmNode(home: string, version: string, bins: string[]): void {
  const bin = path.join(home, '.nvm', 'versions', 'node', version, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\n', { mode: 0o755 });
}

test('findNvmNode22 picks the highest v22.x.y + returns absolute bin paths', () => {
  withHome((home) => {
    makeNvmNode(home, 'v20.18.3', ['node', 'npm']);
    makeNvmNode(home, 'v22.9.0', ['node', 'npm', 'gitnexus']);
    makeNvmNode(home, 'v22.11.0', ['node', 'npm', 'gitnexus']);
  }, () => {
    const found = findNvmNode22();
    assert.ok(found);
    assert.equal(found?.version, 'v22.11.0');
    assert.ok(found?.node?.endsWith(path.join('v22.11.0', 'bin', 'node')));
    assert.ok(found?.gitnexus?.endsWith(path.join('v22.11.0', 'bin', 'gitnexus')));
  });
});

test('findNvmNode22 returns null when no v22 install exists', () => {
  withHome((home) => {
    makeNvmNode(home, 'v20.18.3', ['node', 'npm']);
  }, () => {
    assert.equal(findNvmNode22(), null);
  });
});

test('findNvmNode22 reports null bins that are absent', () => {
  withHome((home) => {
    makeNvmNode(home, 'v22.10.0', ['node']); // no npm / gitnexus
  }, () => {
    const found = findNvmNode22();
    assert.ok(found?.node);
    assert.equal(found?.npm, null);
    assert.equal(found?.gitnexus, null);
  });
});

test('nvmPresent keys off ~/.nvm/nvm.sh', () => {
  withHome((home) => {
    fs.mkdirSync(path.join(home, '.nvm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.nvm', 'nvm.sh'), '# nvm\n', 'utf8');
  }, () => {
    assert.equal(nvmPresent(), true);
  });
  withHome(() => { /* no .nvm */ }, () => {
    assert.equal(nvmPresent(), false);
  });
});

test('currentNodeMajor returns the running major', () => {
  const major = currentNodeMajor();
  assert.equal(typeof major, 'number');
  assert.ok((major ?? 0) >= 1);
});

test('gitnexusPackageSpec installs LATEST (not the recommended pin)', () => {
  // toolchain-versions.json marks gitnexus installLatest=true, so the install
  // target is "gitnexus@latest" — a stale `recommended` pin must never doom an
  // install. The probed version is what gets stamped afterwards.
  assert.equal(gitnexusPackageSpec(), 'gitnexus@latest');
});

test('constants + messages are stable', () => {
  assert.equal(GITNEXUS_MIN_NODE_MAJOR, 22);
  const msg = nodeVersionMismatchMessage(20);
  assert.ok(msg.includes('Node 20'));
  assert.ok(msg.includes('>=22'));
  assert.ok(msg.includes('graphify'));
  assert.ok(nodeVersionMismatchMessage(null).includes('an unknown Node version'));
});

test('backupConflicts skips an unchanged snapshot and links CLAUDE.md instead of copying it twice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gnbackup-'));
  const backupsRoot = path.join(dir, '.traffic-one', 'backups');
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'agent context\n', 'utf8');
    let linked = true;
    try { fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md')); } catch { linked = false; }

    const first = backupConflicts(dir, '2026-01-01T00-00-00Z');
    assert.equal(path.basename(first.backupRoot), '2026-01-01T00-00-00Z');
    if (linked) {
      // Observed live: each snapshot stored two full 8703-byte copies because
      // copyFileSync/cpSync dereference the CLAUDE.md → AGENTS.md symlink.
      assert.equal(fs.lstatSync(path.join(first.backupRoot, 'CLAUDE.md')).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(path.join(first.backupRoot, 'CLAUDE.md')), 'AGENTS.md');
    }

    // Unchanged content → no second snapshot at all; the existing one is reused.
    // Four identical snapshots in four minutes used to rotate out (keep 3) the
    // only snapshot that could have differed.
    const second = backupConflicts(dir, '2026-01-01T00-01-00Z');
    assert.equal(second.backupRoot, first.backupRoot);
    assert.deepEqual(fs.readdirSync(backupsRoot).sort(), ['2026-01-01T00-00-00Z']);
    assert.deepEqual(second.recorded.map((r) => r.rel), first.recorded.map((r) => r.rel));

    // Changed content → a real new snapshot.
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'agent context v2\n', 'utf8');
    const third = backupConflicts(dir, '2026-01-01T00-02-00Z');
    assert.equal(path.basename(third.backupRoot), '2026-01-01T00-02-00Z');
    assert.equal(fs.readFileSync(path.join(third.backupRoot, 'AGENTS.md'), 'utf8'), 'agent context v2\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// bootstrap: both early-return branches that never spawn gitnexus.
function withGnProject(fn: (cwd: string, prefs: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gnboot-'));
  const saved = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prefs = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
  try {
    fn(dir, prefs);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('bootstrap honours the codeGraphAutoRun:false opt-out', () => {
  withGnProject((cwd, prefs) => {
    fs.writeFileSync(prefs, JSON.stringify({ codeGraphAutoRun: false }), 'utf8');
    const r = bootstrap(cwd);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'install-skipped');
    assert.match(r.error || '', /codeGraphAutoRun is false/);
  });
});

test('bootstrap short-circuits on a fresh .gitnexus/ cache', () => {
  withGnProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one', '.gitnexus'), { recursive: true });
    const r = bootstrap(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh');
    assert.ok(r.report?.endsWith('.gitnexus'));
    assert.equal(r.license, 'PolyForm Noncommercial');
  });
});

test('bootstrap runs an existing GitNexus binary, relocates its index, stamps the toolchain, then reuses the cache', () => {
  withGnProject((cwd) => {
    const binDir = path.join(cwd, 'fake-bin');
    const gitnexusBin = path.join(binDir, 'gitnexus');
    const invocationLog = path.join(cwd, 'gitnexus-invocations.log');
    const prefs = path.join(cwd, '.traffic-one', 'preferences.json');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(gitnexusBin, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gitnexus 1.6.9"
  exit 0
fi
if [ "$1" = "analyze" ]; then
  printf '%s\\n' "$*" >> "$T1_FAKE_GITNEXUS_LOG"
  mkdir -p .gitnexus
  printf '%s' '{"stats":{"files":1,"nodes":2},"indexedAt":"2026-07-13T00:00:00.000Z"}' > .gitnexus/meta.json
  printf '%s' '{"modules":[{"name":"src"}]}' > .gitnexus/index.json
  exit 0
fi
exit 64
`, { mode: 0o755 });
    fs.writeFileSync(path.join(cwd, 'index.ts'), 'export const ready = true;\n', 'utf8');

    const saved = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      T1_FAKE_GITNEXUS_LOG: process.env.T1_FAKE_GITNEXUS_LOG,
      TRAFFIC_ONE_TOOLCHAIN_ROOT: process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.HOME = path.join(cwd, 'home');
    process.env.PATH = `${binDir}${path.delimiter}${saved.PATH || ''}`;
    process.env.T1_FAKE_GITNEXUS_LOG = invocationLog;
    process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(cwd, 'toolchains');
    process.env.XDG_STATE_HOME = path.join(cwd, 'xdg-state');
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
    try {
      const first = bootstrap(cwd, { nodeMajor: 22 });
      assert.equal(first.ok, true);
      assert.equal(first.action, 'used-existing');
      assert.equal(first.installedVersion, '1.6.9');
      assert.equal(first.report, path.join(cwd, '.traffic-one', '.gitnexus'));
      assert.equal(fs.existsSync(path.join(cwd, '.gitnexus')), false, 'provider output is moved out of the project root');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.gitnexus', 'meta.json'), 'utf8')),
        { stats: { files: 1, nodes: 2 }, indexedAt: '2026-07-13T00:00:00.000Z' },
      );
      assert.match(fs.readFileSync(path.join(cwd, '.traffic-one', 'graph-preview.md'), 'utf8'), /Provider: gitnexus.*src/s);
      assert.match(fs.readFileSync(invocationLog, 'utf8'), /^analyze \. --skip-agents-md --skip-git\n$/);
      assert.equal(fs.existsSync(path.join(cwd, '.gitnexusignore')), false, 'temporary scan ignore is restored');

      const local = JSON.parse(fs.readFileSync(prefs, 'utf8')) as {
        gitnexusLastRunAt?: string;
        toolchain?: { gitnexus?: { installedVersion?: string; installedAt?: string; binPath?: string } };
      };
      assert.match(local.gitnexusLastRunAt || '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(local.toolchain?.gitnexus?.installedVersion, '1.6.9');
      assert.match(local.toolchain?.gitnexus?.installedAt || '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(local.toolchain?.gitnexus?.binPath, gitnexusBin);

      const second = bootstrap(cwd, { nodeMajor: 22 });
      assert.equal(second.ok, true);
      assert.equal(second.action, 'fresh');
      assert.equal(fs.readFileSync(invocationLog, 'utf8').trim().split('\n').length, 1, 'fresh cache avoids a second scan');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

test('gitnexusGraphIsEmpty flags a 0-file index (so a pre-scaffold graph reindexes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gnempty-'));
  try {
    assert.equal(gitnexusGraphIsEmpty(dir), false); // no meta → can't tell → not empty
    fs.mkdirSync(path.join(dir, '.traffic-one', '.gitnexus'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 0, nodes: 0 } }), 'utf8');
    assert.equal(gitnexusGraphIsEmpty(dir), true);
    fs.writeFileSync(path.join(dir, '.traffic-one', '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 7, nodes: 20 } }), 'utf8');
    assert.equal(gitnexusGraphIsEmpty(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
