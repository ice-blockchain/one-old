import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { REPO_ROOT_PATH, defaultConfig } from '../config/test-config';
import { buildAndInstall, cleanupBuildInstall } from './build-and-install';
import {
  distTreeFingerprint,
  readDistRuntimeProof,
  RUNTIME_PROOF_FILE_ENV,
  stageCodexMarketplace,
} from './current-dist';

function makeDist(): { root: string; dispose: () => void } {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 't1-current-dist-'));
  const root = path.join(owner, 'dist');
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules', 'common'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'traffic-one', version: '2.9.274' }), 'utf8');
  fs.writeFileSync(path.join(root, 'rules', 'common', 'auth-gate.md'), '# current auth gate\n', 'utf8');
  for (const entry of [
    'hook-runtime.cjs',
    'cursor-hook-runtime.cjs',
    'opencode-hook-runtime.cjs',
    'kilo-hook-runtime.cjs',
    'copilot-hook-runtime.cjs',
    'windsurf-hook-runtime.cjs',
  ]) fs.writeFileSync(path.join(root, 'scripts', entry), 'module.exports = {};\n', 'utf8');
  return { root, dispose: () => fs.rmSync(owner, { recursive: true, force: true }) };
}

test('Codex uses a discoverable copied marketplace and install failure fails current-dist proof', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const stagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-marketplaces-'));
  t.after(() => fs.rmSync(stagesRoot, { recursive: true, force: true }));
  const config = defaultConfig();
  config.build = { refreshDist: false, updateHosts: true };
  const calls: Array<{ cmd: string; args: string[] }> = [];

  const result = buildAndInstall(config, ['claude', 'codex'], {
    distRoot: dist.root,
    stagesRoot,
    commandRunner(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'codex') return { ok: false, out: 'marketplace rejected current dist' };
      return { ok: true, out: '' };
    },
  });
  t.after(() => { cleanupBuildInstall(result, () => ({ ok: true, out: '' })); });

  assert.equal(result.currentDistReady, false);
  assert.deepEqual(result.sessionProof, ['claude']);
  assert.deepEqual(result.installed, []);
  assert.equal(result.currentDistFailures.length, 1);
  assert.equal(result.currentDistFailures[0]?.host, 'codex');
  assert.match(result.currentDistFailures[0]?.detail ?? '', /codex plugin marketplace add .* failed: marketplace rejected current dist/);
  assert.equal(calls.filter((call) => call.cmd === 'claude').length, 0, 'Claude must bypass the version cache with --plugin-dir');
  assert.equal(calls.filter((call) => call.cmd === 'codex').length, 1, 'stop after the failed marketplace step');

  const marketplace = result.marketplaces.codex;
  assert.ok(marketplace);
  const manifest = JSON.parse(fs.readFileSync(path.join(marketplace.root, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(manifest.name, marketplace.name);
  assert.equal(manifest.plugins[0].source.path, './plugins/traffic-one');
  assert.deepEqual(manifest.plugins[0].policy, {
    installation: 'AVAILABLE',
    authentication: 'ON_INSTALL',
  });
  assert.equal(manifest.plugins[0].category, 'Developer Tools');
  assert.ok(fs.existsSync(path.join(marketplace.root, 'plugins', 'traffic-one', '.codex-plugin', 'plugin.json')));
  assert.equal(marketplace.sourceFingerprint, distTreeFingerprint(dist.root));
});

test('Claude direct-session, per-case wrappers, and Cursor fingerprint exemption need no scripted install', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const config = defaultConfig();
  config.build = { refreshDist: false, updateHosts: true };

  const result = buildAndInstall(config, ['claude', 'cursor', 'opencode', 'kilo'], {
    distRoot: dist.root,
    commandRunner() {
      throw new Error('these proof modes must not invoke a host install command');
    },
  });
  t.after(() => { cleanupBuildInstall(result, () => ({ ok: true, out: '' })); });

  assert.equal(result.currentDistReady, true);
  assert.deepEqual(result.sessionProof, ['claude']);
  assert.deepEqual(result.perCaseProof, ['opencode', 'kilo']);
  assert.deepEqual(result.exempted, ['cursor']);
  assert.deepEqual(result.currentDistFailures, []);
});

test('Claude proof rejects a session that could reuse user-scoped cached plugins', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const config = defaultConfig();
  config.build = { refreshDist: false, updateHosts: true };
  config.hosts = {
    ...config.hosts,
    claude: {
      ...config.hosts.claude,
      runArgs: ['--plugin-dir', '{DIST}', '-p', '{PROMPT}'],
    },
  };
  const result = buildAndInstall(config, ['claude'], {
    distRoot: dist.root,
    commandRunner() {
      throw new Error('Claude proof validation must not invoke an install command');
    },
  });
  t.after(() => { cleanupBuildInstall(result, () => ({ ok: true, out: '' })); });
  assert.equal(result.currentDistReady, false);
  assert.deepEqual(result.currentDistFailures, [{
    host: 'claude',
    detail: 'session-plugin-dir proof requires Claude runArgs with user settings excluded and `--plugin-dir {DIST}`',
  }]);
});

test('missing proof, misapplied exemptions, and --no-install for Codex fail closed', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const config = defaultConfig();
  config.build = { refreshDist: false, updateHosts: false };
  config.hosts = {
    ...config.hosts,
    claude: { ...config.hosts.claude, currentDistProof: undefined },
    codex: { ...config.hosts.codex, currentDistProof: 'manual-live-pointer' },
  };

  const result = buildAndInstall(config, ['claude', 'codex'], {
    distRoot: dist.root,
    commandRunner() {
      throw new Error('invalid proof configurations must fail before running commands');
    },
  });

  assert.equal(result.currentDistReady, false);
  assert.deepEqual(result.currentDistFailures, [
    { host: 'claude', detail: 'no explicit current-dist proof is configured' },
    { host: 'codex', detail: 'manual-live-pointer exemption is reserved for Cursor' },
  ]);
  assert.deepEqual(cleanupBuildInstall(result, () => ({ ok: true, out: '' })).failures, []);

  const noInstall = defaultConfig();
  noInstall.build = { refreshDist: false, updateHosts: false };
  const noInstallResult = buildAndInstall(noInstall, ['codex'], {
    distRoot: dist.root,
    commandRunner() {
      throw new Error('--no-install must fail before running commands');
    },
  });
  assert.deepEqual(noInstallResult.currentDistFailures, [{
    host: 'codex',
    detail: 'host update disabled by --no-install; current dist is unproven',
  }]);
  assert.deepEqual(cleanupBuildInstall(noInstallResult, () => ({ ok: true, out: '' })).failures, []);
});

test('content changes create a different Codex cache key even when the package version is unchanged', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const stagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-marketplaces-'));
  t.after(() => fs.rmSync(stagesRoot, { recursive: true, force: true }));

  const first = stageCodexMarketplace(dist.root, stagesRoot);
  fs.writeFileSync(path.join(dist.root, 'rules', 'common', 'auth-gate.md'), '# changed without a package version bump\n', 'utf8');
  const second = stageCodexMarketplace(dist.root, stagesRoot);

  assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);
  assert.notEqual(first.cacheVersion, second.cacheVersion);
  assert.notEqual(first.name, second.name);
});

test('failed Codex staging removes its just-created marketplace root', (t) => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 't1-bad-current-dist-'));
  const distRoot = path.join(owner, 'dist');
  const stagesRoot = path.join(owner, 'marketplaces');
  fs.mkdirSync(path.join(distRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(distRoot, 'scripts', 'hook-runtime.cjs'), 'module.exports = {};\n', 'utf8');
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));

  assert.throws(() => stageCodexMarketplace(distRoot, stagesRoot), /plugin\.json|ENOENT/);
  assert.deepEqual(fs.readdirSync(stagesRoot), []);
});

test('cleanup rejects lookalike commands instead of executing them', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const stagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-marketplaces-'));
  t.after(() => fs.rmSync(stagesRoot, { recursive: true, force: true }));
  const config = defaultConfig();
  config.build = { refreshDist: false, updateHosts: true };
  const result = buildAndInstall(config, ['codex'], {
    distRoot: dist.root,
    stagesRoot,
    commandRunner: () => ({ ok: true, out: '' }),
  });
  const marketplace = result.marketplaces.codex!;
  result.cleanupSteps[0]!.args = ['plugin', 'remove', `${marketplace.pluginSelector}-lookalike`];
  const calls: string[][] = [];
  const cleanup = cleanupBuildInstall(result, (_cmd, args) => {
    calls.push(args);
    return { ok: true, out: '' };
  });

  assert.match(cleanup.failures[0]?.detail ?? '', /refused unsafe cleanup command/);
  assert.equal(calls.some((args) => args.includes(`${marketplace.pluginSelector}-lookalike`)), false);
  assert.equal(fs.existsSync(marketplace.root), true, 'unsafe command keeps staging for manual inspection');
});

test('cleanup requires staging containment and exact marker contents before recursive removal', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const stagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-marketplaces-'));
  t.after(() => fs.rmSync(stagesRoot, { recursive: true, force: true }));
  const config = defaultConfig();
  config.build = { refreshDist: false, updateHosts: true };

  const containment = buildAndInstall(config, ['codex'], {
    distRoot: dist.root,
    stagesRoot,
    commandRunner: () => ({ ok: true, out: '' }),
  });
  containment.cleanupSteps = [];
  containment.marketplaces.codex!.stagesRoot = path.join(stagesRoot, 'not-the-recorded-parent');
  const containmentCleanup = cleanupBuildInstall(containment, () => ({ ok: true, out: '' }));
  assert.match(containmentCleanup.failures[0]?.detail ?? '', /not a direct child/);
  assert.equal(fs.existsSync(containment.marketplaces.codex!.root), true);

  // The first cleanup restored dist; a second build can safely arm a fresh token.
  const marker = buildAndInstall(config, ['codex'], {
    distRoot: dist.root,
    stagesRoot,
    commandRunner: () => ({ ok: true, out: '' }),
  });
  marker.cleanupSteps = [];
  const markerPath = path.join(marker.marketplaces.codex!.root, '.traffic-one-e2e.json');
  const markerJson = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  markerJson.pluginSelector = 'traffic-one@traffic-one-e2e-lookalike';
  fs.writeFileSync(markerPath, `${JSON.stringify(markerJson, null, 2)}\n`, 'utf8');
  const markerCleanup = cleanupBuildInstall(marker, () => ({ ok: true, out: '' }));
  assert.match(markerCleanup.failures[0]?.detail ?? '', /marker mismatch for pluginSelector/);
  assert.equal(fs.existsSync(marker.marketplaces.codex!.root), true);
});

test('successful Codex staging is cleaned with only its unique E2E ids', (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const stagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-marketplaces-'));
  t.after(() => fs.rmSync(stagesRoot, { recursive: true, force: true }));
  const config = defaultConfig();
  config.build = { refreshDist: false, updateHosts: true };
  const runtimePath = path.join(dist.root, 'scripts', 'hook-runtime.cjs');
  const originalRuntime = fs.readFileSync(runtimePath);

  const result = buildAndInstall(config, ['codex'], {
    distRoot: dist.root,
    stagesRoot,
    commandRunner: () => ({ ok: true, out: '' }),
  });
  assert.equal(result.currentDistReady, true);
  assert.deepEqual(result.installed, ['codex']);
  const proofFile = path.join(stagesRoot, 'runtime-proof.json');
  const probe = spawnSync(process.execPath, [runtimePath], {
    env: { ...process.env, [RUNTIME_PROOF_FILE_ENV]: proofFile },
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(proofFile, 'utf8')), {
    version: 1,
    token: result.runtimeProof?.metadata.token,
    entry: 'scripts/hook-runtime.cjs',
  });

  const cleanupCalls: string[][] = [];
  const cleanup = cleanupBuildInstall(result, (_cmd, args) => {
    cleanupCalls.push(args);
    return { ok: true, out: '' };
  });
  assert.deepEqual(cleanup.failures, []);
  assert.equal(cleanupCalls.length, 2);
  assert.deepEqual(cleanupCalls.map((args) => args.slice(0, 2)), [
    ['plugin', 'remove'],
    ['plugin', 'marketplace'],
  ]);
  assert.ok(cleanupCalls.flat().some((arg) => arg.includes('traffic-one-e2e-')));
  assert.ok(cleanupCalls.flat().every((arg) => !arg.includes('traffic-one-local')));
  assert.equal(fs.readFileSync(runtimePath).equals(originalRuntime), true);
  assert.equal(readDistRuntimeProof(dist.root), null);
});

test('the production E2E package script enables strict result handling', () => {
  const pkg = JSON.parse(fs.readFileSync(`${REPO_ROOT_PATH}/package.json`, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.match(pkg.scripts?.['test:env:e2e'] ?? '', /(?:^|\s)--strict(?:\s|$)/);
  assert.ok(defaultConfig().hosts.codex.runArgs.includes('--dangerously-bypass-hook-trust'));
});
