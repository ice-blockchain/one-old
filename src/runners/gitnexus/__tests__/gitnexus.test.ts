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
