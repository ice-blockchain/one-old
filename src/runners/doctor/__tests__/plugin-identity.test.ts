// src/runners/doctor/__tests__/plugin-identity.test.ts
// The two probes that answer "which copy of the plugin produced this report" —
// the single most load-bearing fact in a Traffic One bug report, and the one an
// operator cannot check by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { probePluginIdentity } from '../plugin-identity';
import { probePluginRoot } from '../plugin-root-probe';

function withRoot<T>(build: (root: string) => void, fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-doctor-root-'));
  const saved: Record<string, string | undefined> = {};
  for (const key of ['TRAFFIC_ONE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    build(root);
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = root;
    return fn(root);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function installedTree(root: string, provenance: { content?: unknown; runtime?: unknown } = {}): void {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'hook-runtime.cjs'), '// runtime\n');
  fs.writeFileSync(path.join(root, 'rules', 'core.md'), '# rules\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.8.7' }));
  if (provenance.content) fs.writeFileSync(path.join(root, 'build-provenance.json'), JSON.stringify(provenance.content));
  if (provenance.runtime) fs.writeFileSync(path.join(root, 'scripts', 'build-provenance.json'), JSON.stringify(provenance.runtime));
}

test('probePluginRoot reports which env var supplied the root, its layout, and both provenance files', () => {
  withRoot(
    (root) => installedTree(root, {
      content: { gitSha: 'sha-a', sourceHash: 'hash-a' },
      runtime: { gitSha: 'sha-a', sourceHash: 'hash-a' },
    }),
    (root) => {
      const probe = probePluginRoot();
      assert.equal(probe.root, root);
      assert.equal(probe.layout, 'installed');
      assert.equal(probe.source, 'TRAFFIC_ONE_PLUGIN_ROOT');
      assert.equal(probe.contentProvenancePath, path.join(root, 'build-provenance.json'));
      assert.equal(probe.runtimeProvenancePath, path.join(root, 'scripts', 'build-provenance.json'));
      assert.deepEqual(probe.contentProvenance, { gitSha: 'sha-a', sourceHash: 'hash-a' });
      assert.deepEqual(probe.runtimeProvenance, { gitSha: 'sha-a', sourceHash: 'hash-a' });
      assert.equal(probe.layerMismatch, false);
    },
  );
});

test('probePluginRoot flags a mixed install only when BOTH provenance copies exist and disagree', () => {
  withRoot(
    (root) => installedTree(root, {
      content: { gitSha: 'sha-a', sourceHash: 'hash-a' },
      runtime: { gitSha: 'sha-b', sourceHash: 'hash-a' },
    }),
    () => assert.equal(probePluginRoot().layerMismatch, true, 'same content hash, different commit is still a mix'),
  );
  withRoot(
    (root) => installedTree(root, { content: { gitSha: 'sha-a', sourceHash: 'hash-a' } }),
    () => {
      const probe = probePluginRoot();
      assert.equal(probe.runtimeProvenance, null);
      assert.equal(probe.layerMismatch, false, 'a missing half is a dev/partial tree, not proof of a stale mix');
    },
  );
  withRoot(
    (root) => {
      installedTree(root);
      fs.writeFileSync(path.join(root, 'build-provenance.json'), 'not json{');
      fs.writeFileSync(path.join(root, 'scripts', 'build-provenance.json'), '[1,2,3]');
    },
    () => {
      const probe = probePluginRoot();
      assert.equal(probe.contentProvenance, null, 'unparseable provenance reads as absent, never throws');
      assert.equal(probe.runtimeProvenance, null, 'an array is not a provenance record');
      assert.equal(probe.layerMismatch, false);
    },
  );
});

test('probePluginRoot classifies a root with no runtime and no content as unverified', () => {
  withRoot(
    (root) => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' })),
    () => assert.equal(probePluginRoot().layout, 'unverified'),
  );
});

test('probePluginIdentity reads version and contentHash off the resolved root, never re-deriving them', () => {
  withRoot(
    (root) => installedTree(root, { content: { gitSha: 'sha-a', sourceHash: 'content-hash' } }),
    (root) => {
      const identity = probePluginIdentity(probePluginRoot(), {}, []);
      assert.equal(identity.root, root);
      assert.equal(identity.layout, 'installed');
      assert.equal(identity.version, '9.8.7', 'the version comes from THIS root, not the ambient default');
      assert.equal(identity.contentHash, 'content-hash');
      assert.equal(identity.source, 'TRAFFIC_ONE_PLUGIN_ROOT');
    },
  );
  // Falls back to the runtime subtree's hash, and to null when a source
  // checkout has never run gen/build.
  withRoot(
    (root) => installedTree(root, { runtime: { gitSha: 'sha-a', sourceHash: 'runtime-hash' } }),
    () => assert.equal(probePluginIdentity(probePluginRoot(), {}, []).contentHash, 'runtime-hash'),
  );
  withRoot(
    (root) => installedTree(root),
    () => assert.equal(probePluginIdentity(probePluginRoot(), {}, []).contentHash, null),
  );
});

// `root` without `source` cannot answer the question the block exists for: a
// stale override and a correct install produce the same-looking path, so the
// reader needs to know which env var chose it. Pinned to the probe rather than
// asserted as a literal, so it cannot drift into a second resolution.
test('probePluginIdentity carries the root SOURCE, taken from the probe, for both env-supplied and default roots', () => {
  withRoot(
    (root) => installedTree(root),
    () => {
      const probe = probePluginRoot();
      assert.equal(probe.source, 'TRAFFIC_ONE_PLUGIN_ROOT');
      assert.equal(probePluginIdentity(probe, {}, []).source, probe.source);
    },
  );
  // No override set at all: the root comes from the runtime's own location, and
  // the block has to say so rather than naming an env var that is not in play.
  const saved: Record<string, string | undefined> = {};
  for (const key of ['TRAFFIC_ONE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const probe = probePluginRoot();
    assert.equal(probe.source, 'default');
    assert.equal(probePluginIdentity(probe, {}, []).source, 'default');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('plugin.host is null without positive evidence, and never a detectHost fallback guess', () => {
  withRoot(
    (root) => installedTree(root),
    () => {
      // A plain terminal invocation: detectHost() answers 'claude' because a
      // gate always needs SOME host, but a report that prints "claude" on a
      // machine running Codex is worse than one that admits it does not know.
      assert.equal(probePluginIdentity(probePluginRoot(), {}, []).host, null);
      assert.equal(probePluginIdentity(probePluginRoot(), { PATH: '/usr/bin' }, ['node', 'doctor.cjs']).host, null);

      const cases: Array<[NodeJS.ProcessEnv, string[], string]> = [
        [{ TRAFFIC_ONE_HOST: 'cursor' }, [], 'cursor'],
        [{ CURSOR_PLUGIN_ROOT: '/x' }, [], 'cursor'],
        [{ CLAUDE_PLUGIN_ROOT: '/x' }, [], 'claude'],
        [{ CODEX_PLUGIN_ROOT: '/x' }, [], 'codex'],
        [{ CODEX_THREAD_ID: 't' }, [], 'codex'],
        [{}, ['node', 'doctor.cjs', '--host=windsurf'], 'windsurf'],
      ];
      for (const [env, argv, expected] of cases) {
        assert.equal(probePluginIdentity(probePluginRoot(), env, argv).host, expected, `${JSON.stringify(env)} ${argv.join(' ')}`);
      }
    },
  );
});

test('a null host still reports WHICH markers were looked for, so the bug report stays usable', () => {
  withRoot(
    (root) => installedTree(root),
    () => {
      // `host: null` alone drops the only field naming the host, and leaves an
      // operator unable to tell "we could not detect it" from "no host".
      const blind = probePluginIdentity(probePluginRoot(), {}, ['node', 'doctor.cjs']);
      assert.equal(blind.host, null);
      assert.deepEqual(blind.hostEvidence.present, []);
      assert.deepEqual(blind.hostEvidence.absent, [
        '--host=', 'CLAUDE_PLUGIN_ROOT', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_PLUGIN_ROOT',
        'CODEX_THREAD_ID', 'CURSOR_PLUGIN_ROOT', 'TRAFFIC_ONE_HOST',
      ]);

      const codex = probePluginIdentity(probePluginRoot(), { CODEX_THREAD_ID: 't', CODEX_PLUGIN_ROOT: '/x' }, []);
      assert.equal(codex.host, 'codex');
      assert.deepEqual(codex.hostEvidence.present, ['CODEX_PLUGIN_ROOT', 'CODEX_THREAD_ID']);
      assert.equal(codex.hostEvidence.absent.includes('TRAFFIC_ONE_HOST'), true);
      // Marker VALUES are never reported — they are absolute paths the
      // plugin-root probe already covers, and presence is the whole question.
      assert.equal(JSON.stringify(codex.hostEvidence).includes('/x'), false);
    },
  );
});
