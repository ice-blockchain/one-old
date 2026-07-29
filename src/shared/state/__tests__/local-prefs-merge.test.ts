import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

import {
  clearProjectHostPrefs,
  effectiveState,
  mergeMissingProjectPrefs,
  mergeProjectHostPrefs,
  mergeProjectPrefs,
  PROJECT_PREFS_LOCK_TIMEOUT_MS,
  readProjectPrefs,
} from '../local-prefs';
import { scrubProjectStateLocalPrefs } from '../normalize';

function withPrefs(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const stamp = (prefs: Record<string, unknown>, tool: string): Record<string, unknown> => {
  const tc = prefs.toolchain as Record<string, Record<string, unknown>>;
  return tc[tool] ?? {};
};

const fingerprint = (digit: string): string => digit.repeat(64);

// normalize embeds the initialized-null toolchain skeleton in shared state, so
// every writeState(readState(...)) round-trip merges nulls back into prefs. A
// null patch must never erase a real stamp — otherwise the wizard's install
// task stamps OpenCode and finalize immediately un-stamps it, leaving
// openCodeDelegationActive() false for the whole first build session.
test('toolchain merge: a null-skeleton patch never erases a real stamp', () => {
  withPrefs((cwd) => {
    mergeProjectPrefs(cwd, {
      toolchain: { opencode: { installedVersion: '1.15.13', installedAt: '2026-06-12T06:32:52Z', binPath: '/managed/bin/opencode' } },
    });
    mergeProjectPrefs(cwd, {
      toolchain: { opencode: { installedVersion: null, installedAt: null } },
    });
    const prefs = readProjectPrefs(cwd);
    assert.equal(stamp(prefs, 'opencode').installedVersion, '1.15.13');
    assert.equal(stamp(prefs, 'opencode').installedAt, '2026-06-12T06:32:52Z');
    assert.equal(stamp(prefs, 'opencode').binPath, '/managed/bin/opencode');
  });
});

test('toolchain merge: a real new stamp still overwrites an older one', () => {
  withPrefs((cwd) => {
    mergeProjectPrefs(cwd, { toolchain: { gitnexus: { installedVersion: '1.6.0', installedAt: '2026-01-01T00:00:00Z' } } });
    mergeProjectPrefs(cwd, { toolchain: { gitnexus: { installedVersion: '1.6.4', installedAt: '2026-06-12T00:00:00Z' } } });
    const prefs = readProjectPrefs(cwd);
    assert.equal(stamp(prefs, 'gitnexus').installedVersion, '1.6.4');
    assert.equal(stamp(prefs, 'gitnexus').installedAt, '2026-06-12T00:00:00Z');
  });
});

test('toolchain merge: null patches on never-stamped tools stay null', () => {
  withPrefs((cwd) => {
    mergeProjectPrefs(cwd, { toolchain: { graphify: { installedVersion: null, installedAt: null } } });
    const prefs = readProjectPrefs(cwd);
    assert.equal(stamp(prefs, 'graphify').installedVersion, null);
  });
});

test('scrubProjectStateLocalPrefs strips machine-local prefs a stale runner left in committed .one.json', () => {
  withPrefs((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    const stateFile = path.join(cwd, '.traffic-one', '.one.json');
    // The 6c-shape leak: a RAW .one.json carrying team / toolchain (machine binPath) / performance.
    fs.writeFileSync(stateFile, JSON.stringify({
      mode: 'new-project', stack: 'default', currentRunId: '1',
      performance: { level: 'balanced', source: 'prompted' },
      team: { mode: 'subagents', overrides: { 'senior-frontend': 'highest' } },
      toolchain: { gitnexus: { installedVersion: '1.6.7', binPath: '/Users/x/.traffic-one/toolchains/gitnexus/bin/gitnexus' } },
    }), 'utf8');

    assert.equal(scrubProjectStateLocalPrefs(cwd), true, 'scrubs when local-prefs are present');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(!('performance' in onDisk) && !('team' in onDisk) && !('toolchain' in onDisk), '.one.json no longer carries local-prefs');
    assert.equal(onDisk.currentRunId, '1', 'durable project fields are preserved');
    // Host-agnostic legacy performance/team are deliberately NOT promoted into
    // the active host. The next host access must re-open Performance instead of
    // silently inheriting another user's/host's lineup. Non-host prefs survive.
    const prefs = readProjectPrefs(cwd);
    assert.ok('toolchain' in prefs, 'non-host local prefs are routed to preferences.json');
    assert.equal(prefs.performance, undefined);
    assert.equal(prefs.team, undefined);
    assert.equal(prefs.hosts, undefined);
    // Idempotent: a clean .one.json is a no-op.
    assert.equal(scrubProjectStateLocalPrefs(cwd), false, 'no-op on an already-clean state file');
  });
});

test('readProjectPrefs never reads a project-local preferences file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-fallback-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  try {
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'preferences.json'), JSON.stringify({
      hosts: {
        codex: {
          performance: {
            level: 'balanced', source: 'prompted',
            target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 0 },
          },
          team: { mode: 'subagents', source: 'prompted', approved: true },
        },
      },
    }), 'utf8');

    const prefs = readProjectPrefs(cwd);
    assert.equal(prefs.hosts, undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy top-level performance/team are discarded instead of silently assigned to a host', () => {
  withPrefs((cwd) => {
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify({
      openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-12T00:00:00Z' },
      performance: { level: 'balanced', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    }), 'utf8');

    const prefs = readProjectPrefs(cwd);
    assert.equal(prefs.performance, undefined);
    assert.equal(prefs.team, undefined);
    assert.equal(prefs.hosts, undefined);
    assert.equal((prefs.openCode as Record<string, unknown>).enabled, false);
  });
});

test('host preference writes preserve additive fields and future host siblings', () => {
  withPrefs((cwd) => {
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify({
      hosts: {
        codex: {
          performance: {
            level: 'balanced',
            source: 'prompted',
            target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
            futurePerformanceField: { keep: true },
          },
          team: { mode: 'subagents', source: 'prompted', approved: true },
          futureHostField: { keep: true },
        },
        'future-host': { futureState: 7 },
      },
    }), 'utf8');

    mergeProjectHostPrefs(cwd, 'codex', {
      team: { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-tester': 'balanced' } },
    });

    const hosts = readProjectPrefs(cwd).hosts as Record<string, Record<string, unknown>>;
    const codex = hosts.codex!;
    assert.deepEqual(codex.futureHostField, { keep: true });
    assert.deepEqual((codex.performance as Record<string, unknown>).futurePerformanceField, { keep: true });
    assert.deepEqual(hosts['future-host'], { futureState: 7 });
  });
});

test('effectiveState projects only the active host performance snapshot', () => {
  const prefs = {
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-12T00:00:00Z' },
    hosts: {
      codex: {
        performance: {
          level: 'high', source: 'prompted',
          target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
        },
        team: { mode: 'subagents', source: 'prompted', approved: true },
      },
      cursor: {
        performance: {
          level: 'low', source: 'prompted',
          target: { plan: 'free', appliedFingerprint: fingerprint('b'), configVersion: 0 },
        },
        team: { mode: 'main-agent', source: 'prompted' },
        availableModels: {
          models: [' composer-2.5-fast ', 'composer-2.5-fast', 'claude-4.6-sonnet'],
          capturedAt: '2026-07-12T08:00:00Z',
          target: { plan: 'free', appliedFingerprint: fingerprint('b') },
        },
      },
    },
  };

  const codex = effectiveState({ stack: 'default' }, prefs, 'codex');
  assert.deepEqual(codex.performance, {
    level: 'high', source: 'prompted',
    target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
  });
  assert.equal(codex.configuredFor, undefined);
  assert.equal(codex.availableModels, undefined);
  assert.equal(codex.hosts, undefined);

  const cursor = effectiveState({ stack: 'default' }, prefs, 'cursor');
  assert.deepEqual(cursor.performance, {
    level: 'low', source: 'prompted',
    target: { plan: 'free', appliedFingerprint: fingerprint('b'), configVersion: 0 },
  });
  assert.deepEqual(cursor.availableModels, {
    models: ['composer-2.5-fast', 'claude-4.6-sonnet'],
    capturedAt: '2026-07-12T08:00:00Z',
    target: { plan: 'free', appliedFingerprint: fingerprint('b') },
  });
});

test('host preference merge preserves sibling hosts and Cursor availableModels', () => {
  withPrefs((cwd) => {
    mergeProjectHostPrefs(cwd, 'cursor', {
      performance: {
        level: 'balanced', source: 'prompted',
        target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
      },
      team: { mode: 'subagents', source: 'prompted', approved: true },
      availableModels: {
        models: ['claude-opus-4-8-thinking-high'],
        capturedAt: '2026-07-12T08:00:00Z',
        target: { plan: 'pro', appliedFingerprint: fingerprint('a') },
      },
    });
    mergeProjectHostPrefs(cwd, 'codex', {
      performance: {
        level: 'low', source: 'prompted',
        target: { plan: 'free', appliedFingerprint: fingerprint('b'), configVersion: 0 },
      },
      team: { mode: 'main-agent', source: 'prompted' },
    });
    mergeProjectHostPrefs(cwd, 'cursor', {
      performance: {
        level: 'high', source: 'prompted',
        target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
      },
      team: { mode: 'subagents', source: 'prompted' },
    });

    const hosts = readProjectPrefs(cwd).hosts as Record<string, Record<string, unknown>>;
    const codex = hosts.codex;
    const cursor = hosts.cursor;
    assert.ok(codex);
    assert.ok(cursor);
    assert.equal(codex.configuredFor, undefined);
    assert.equal(cursor.configuredFor, undefined);
    assert.deepEqual(cursor.availableModels, {
      models: ['claude-opus-4-8-thinking-high'],
      capturedAt: '2026-07-12T08:00:00Z',
      target: { plan: 'pro', appliedFingerprint: fingerprint('a') },
    });
    assert.deepEqual(cursor.team, { mode: 'subagents', source: 'prompted' });
  });
});

test('pre-release acknowledgement fields are discarded instead of migrated', () => {
  withPrefs((cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    fs.writeFileSync(prefsPath, JSON.stringify({
      oneMcp: { schemaVersion: 1, hosts: { codex: { plan: 'pro' } } },
      hosts: {
        codex: {
          performance: {
            level: 'balanced', source: 'prompted',
            target: { plan: 'pro', appliedFingerprint: fingerprint('a') },
          },
          configuredFor: { plan: 'pro', modelsUpdatedAt: '2026-07-16' },
        },
      },
    }), 'utf8');

    const prefs = readProjectPrefs(cwd) as Record<string, any>;
    assert.equal(prefs.oneMcp, undefined);
    assert.equal(prefs.hosts.codex.configuredFor, undefined);
    assert.equal(
      prefs.hosts.codex.performance.target,
      undefined,
      'pre-release target without configVersion is intentionally not backfilled',
    );
  });
});

test('Performance selection and semantic target are stamped and cleared atomically', () => {
  withPrefs((cwd) => {
    mergeProjectHostPrefs(cwd, 'codex', {
      performance: {
        level: 'balanced', source: 'prompted',
        target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
      },
      team: { mode: 'subagents', source: 'prompted' },
    });

    let prefs = readProjectPrefs(cwd) as Record<string, any>;
    assert.equal(prefs.hosts.codex.performance.level, 'balanced');
    assert.equal(prefs.hosts.codex.performance.target.appliedFingerprint, fingerprint('a'));

    clearProjectHostPrefs(cwd, 'codex', ['performance', 'team']);
    prefs = readProjectPrefs(cwd) as Record<string, any>;
    assert.equal(prefs.hosts?.codex, undefined);
  });
});

test('locked preference merge fills missing values without overwriting a newer Performance target', () => {
  withPrefs((cwd) => {
    mergeProjectHostPrefs(cwd, 'codex', {
      performance: {
        level: 'high', source: 'prompted',
        target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
      },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    });
    mergeMissingProjectPrefs(cwd, {
      openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-01T00:00:00.000Z' },
      hosts: {
        codex: {
          performance: {
            level: 'low', source: 'prompted',
            target: { plan: 'free', appliedFingerprint: fingerprint('b'), configVersion: 0 },
          },
        },
      },
    });

    const prefs = readProjectPrefs(cwd) as Record<string, any>;
    assert.equal(prefs.openCode.enabled, false);
    assert.equal(prefs.hosts.codex.performance.level, 'high');
    assert.equal(prefs.hosts.codex.performance.target.appliedFingerprint, fingerprint('a'));
  });
});

function runPrefsChild(modulePath: string, cwd: string, prefsPath: string, operation: string): Promise<void> {
  const childSource = [
    `const { mergeMissingProjectPrefs, mergeProjectHostPrefs } = require(${JSON.stringify(modulePath)});`,
    'const cwd = process.argv[1];',
    'const operation = process.argv[2];',
    'const target = { plan: "pro", appliedFingerprint: "a".repeat(64), configVersion: 3 };',
    'const cursorPerformance = { performance: { level: "high", source: "prompted", target }, team: { mode: "subagents", source: "prompted", approved: true } };',
    'const cursorCapture = { availableModels: { models: ["claude-opus-4-8-thinking-high"], capturedAt: "2026-07-12T08:00:00Z", target } };',
    'const codexPerformance = { performance: { level: "balanced", source: "prompted", target }, team: { mode: "subagents", source: "prompted", approved: true } };',
    'for (let i = 0; i < 25; i += 1) {',
    '  if (operation === "cursor-performance") mergeProjectHostPrefs(cwd, "cursor", cursorPerformance);',
    '  if (operation === "cursor-capture") mergeProjectHostPrefs(cwd, "cursor", cursorCapture);',
    '  if (operation === "codex-performance") mergeProjectHostPrefs(cwd, "codex", codexPerformance);',
    '  if (operation === "legacy-merge") mergeMissingProjectPrefs(cwd, { openCode: { enabled: false, source: "prompted", decidedAt: "2026-07-01T00:00:00.000Z" }, hosts: { cursor: cursorPerformance } });',
    '}',
  ].join(' ');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', childSource, cwd, operation], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath },
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

test('concurrent host preference writers preserve Cursor and Codex siblings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-concurrent-hosts-'));
  const prefsPath = path.join(dir, 'preferences.json');
  const modulePath = path.resolve(__dirname, '..', 'local-prefs', 'index.ts');
  try {
    await Promise.all([
      runPrefsChild(modulePath, dir, prefsPath, 'cursor-performance'),
      runPrefsChild(modulePath, dir, prefsPath, 'codex-performance'),
    ]);
    const prefs = readProjectPrefs(dir, { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath });
    const hosts = prefs.hosts as Record<string, Record<string, unknown>>;
    assert.ok(hosts.cursor);
    assert.ok(hosts.codex);
    assert.equal((hosts.cursor!.performance as Record<string, unknown>).level, 'high');
    assert.equal((hosts.codex!.performance as Record<string, unknown>).level, 'balanced');
    assert.equal(fs.statSync(prefsPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp')), []);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.lock') || name.includes('.pending')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent Cursor capture and performance writes preserve both fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-concurrent-cursor-'));
  const prefsPath = path.join(dir, 'preferences.json');
  const modulePath = path.resolve(__dirname, '..', 'local-prefs', 'index.ts');
  try {
    await Promise.all([
      runPrefsChild(modulePath, dir, prefsPath, 'cursor-performance'),
      runPrefsChild(modulePath, dir, prefsPath, 'cursor-capture'),
    ]);
    const prefs = readProjectPrefs(dir, { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath });
    const cursor = (prefs.hosts as Record<string, Record<string, unknown>>).cursor;
    assert.ok(cursor);
    assert.equal((cursor!.performance as Record<string, unknown>).level, 'high');
    assert.deepEqual((cursor!.availableModels as Record<string, unknown>).models, ['claude-opus-4-8-thinking-high']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent fallback merge and host writes preserve both', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-concurrent-migration-'));
  const prefsPath = path.join(dir, 'preferences.json');
  const modulePath = path.resolve(__dirname, '..', 'local-prefs', 'index.ts');
  try {
    await Promise.all([
      runPrefsChild(modulePath, dir, prefsPath, 'legacy-merge'),
      runPrefsChild(modulePath, dir, prefsPath, 'codex-performance'),
    ]);
    const prefs = readProjectPrefs(dir, { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath }) as Record<string, any>;
    assert.equal(prefs.openCode.enabled, false);
    assert.equal(prefs.hosts.cursor.performance.level, 'high');
    assert.equal(prefs.hosts.codex.performance.level, 'balanced');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project preference lock timeout is bounded and never falls back to an unlocked write', () => {
  withPrefs((cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const lockDir = `${prefsPath}.lock`;
    const token = '1a1e123';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `owner-${token}.json`), JSON.stringify({
      pid: process.pid,
      token,
      createdAt: Date.now(),
    }), 'utf8');
    const started = Date.now();
    assert.throws(() => mergeProjectHostPrefs(cwd, 'codex', {
      performance: { level: 'low', source: 'prompted' },
    }), /lock timed out/i);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= PROJECT_PREFS_LOCK_TIMEOUT_MS - 50);
    assert.ok(elapsed < PROJECT_PREFS_LOCK_TIMEOUT_MS + 1_000);
    assert.equal(fs.existsSync(prefsPath), false);
    assert.equal(fs.existsSync(lockDir), true);
  });
});

test('an abandoned project preference lock is recovered without unlocked writes', () => {
  withPrefs((cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const lockDir = `${prefsPath}.lock`;
    const token = 'abadd0ed123';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `owner-${token}.json`), JSON.stringify({
      pid: 2_147_483_647,
      token,
      createdAt: Date.now() - 60_000,
    }), 'utf8');

    mergeProjectHostPrefs(cwd, 'codex', {
      performance: {
        level: 'low', source: 'prompted',
        target: { plan: 'free', appliedFingerprint: fingerprint('b'), configVersion: 0 },
      },
      team: { mode: 'main-agent', source: 'prompted' },
    });
    const codex = (readProjectPrefs(cwd).hosts as Record<string, Record<string, unknown>>).codex;
    assert.equal((codex!.performance as Record<string, unknown>).level, 'low');
    assert.equal(fs.existsSync(lockDir), false);
  });
});

test('an old empty project preference lock left by an interrupted release is recovered', () => {
  withPrefs((cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const lockDir = `${prefsPath}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const abandonedAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, abandonedAt, abandonedAt);

    mergeProjectHostPrefs(cwd, 'codex', {
      performance: { level: 'low', source: 'prompted' },
    });

    const codex = (readProjectPrefs(cwd).hosts as Record<string, Record<string, unknown>>).codex;
    assert.equal((codex!.performance as Record<string, unknown>).level, 'low');
    assert.equal(fs.existsSync(lockDir), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(prefsPath)).filter((name) => name.endsWith('.released')),
      [],
    );
  });
});

test('an old project preference lock held by a live process is never reaped by age alone', () => {
  withPrefs((cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const lockDir = `${prefsPath}.lock`;
    const token = '11fe123';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `owner-${token}.json`), JSON.stringify({
      pid: process.pid,
      token,
      createdAt: Date.now() - 60_000,
    }), 'utf8');

    assert.throws(() => mergeProjectHostPrefs(cwd, 'codex', {
      performance: { level: 'low', source: 'prompted' },
    }), /lock timed out/i);
    assert.equal(fs.existsSync(path.join(lockDir, `owner-${token}.json`)), true);
    assert.equal(fs.existsSync(prefsPath), false);
  });
});

test('the same shared project keeps different users preferences isolated by home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pref-users-'));
  const cwd = path.join(root, 'shared-project');
  fs.mkdirSync(cwd, { recursive: true });
  const userA = { HOME: path.join(root, 'user-a') } as NodeJS.ProcessEnv;
  const userB = { HOME: path.join(root, 'user-b') } as NodeJS.ProcessEnv;
  try {
    mergeProjectHostPrefs(cwd, 'codex', {
      performance: {
        level: 'high', source: 'prompted',
        target: { plan: 'pro', appliedFingerprint: fingerprint('a'), configVersion: 3 },
      },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    }, userA);
    mergeProjectHostPrefs(cwd, 'codex', {
      performance: {
        level: 'low', source: 'prompted',
        target: { plan: 'free', appliedFingerprint: fingerprint('b'), configVersion: 0 },
      },
      team: { mode: 'main-agent', source: 'prompted' },
    }, userB);

    const a = readProjectPrefs(cwd, userA) as { hosts?: { codex?: { performance?: { level?: string } } } };
    const b = readProjectPrefs(cwd, userB) as { hosts?: { codex?: { performance?: { level?: string } } } };
    assert.equal(a.hosts?.codex?.performance?.level, 'high');
    assert.equal(b.hosts?.codex?.performance?.level, 'low');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
