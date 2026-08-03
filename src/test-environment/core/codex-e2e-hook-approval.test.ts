import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { REPO_ROOT_PATH } from '../config/test-config';
import type { CodexMarketplaceStage } from './current-dist';
import { approveCodexE2EHooks } from './codex-e2e-hook-approval';
import type {
  CodexProofAppServer,
  CodexProofAppServerFactory,
} from './codex-trust-upgrade-proof';

interface FixtureEntry {
  key: string;
  currentHash: string;
}

function setup(): {
  owner: string;
  codexHome: string;
  marketplace: CodexMarketplaceStage;
  entries: FixtureEntry[];
} {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-hook-approval-'));
  const codexHome = path.join(owner, 'codex-home');
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[analytics]\nenabled = false\n', { mode: 0o600 });
  const fingerprint = 'abcdef0123456789'.repeat(4);
  const name = 'traffic-one-e2e-abcdef0123456789-Hooks1';
  const marketplace: CodexMarketplaceStage = {
    root: path.join(owner, name),
    stagesRoot: owner,
    name,
    pluginSelector: `traffic-one@${name}`,
    stagedPluginRoot: path.join(owner, name, 'plugins', 'traffic-one'),
    sourceFingerprint: fingerprint,
    cacheVersion: `0.0.0-e2e.${fingerprint.slice(0, 16)}`,
  };
  const fixture = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT_PATH, 'tests', 'fixtures', 'codex-hook-abi.v1.json'), 'utf8'),
  ) as { entries: FixtureEntry[] };
  return { owner, codexHome, marketplace, entries: fixture.entries };
}

function factoryFor(
  codexHome: string,
  marketplace: CodexMarketplaceStage,
  entries: FixtureEntry[],
  sourceOverride?: string,
): CodexProofAppServerFactory {
  let instance = 0;
  return async (): Promise<CodexProofAppServer> => {
    instance += 1;
    const trustStatus = instance === 1 ? 'untrusted' : 'trusted';
    return {
      async request<T>(method: string, params?: unknown): Promise<T> {
        if (method === 'config/batchWrite') {
          const edits = (params as { edits?: Array<{ value?: Record<string, unknown> }> })?.edits;
          assert.equal(Object.keys(edits?.[0]?.value ?? {}).length, entries.length);
          return { filePath: path.join(codexHome, 'config.toml') } as T;
        }
        assert.equal(method, 'hooks/list');
        const sourcePath = sourceOverride ?? path.join(
          codexHome,
          'plugins',
          'cache',
          marketplace.name,
          'traffic-one',
          marketplace.cacheVersion,
          'hooks',
          'hooks.json',
        );
        return {
          data: [{
            cwd: REPO_ROOT_PATH,
            hooks: entries.map((entry) => ({
              key: `${marketplace.pluginSelector}:hooks/hooks.json:${entry.key}`,
              currentHash: entry.currentHash,
              sourcePath,
              source: 'plugin',
              pluginId: marketplace.pluginSelector,
              handlerType: 'command',
              enabled: true,
              isManaged: false,
              trustStatus,
            })),
            warnings: [],
            errors: [],
          }],
        } as T;
      },
      async close(): Promise<void> {},
      stderrTail(): string { return ''; },
    };
  };
}

test('Codex E2E hook approval verifies exact staged ABI, writes trust, and re-lists trusted', async (t) => {
  const f = setup();
  t.after(() => fs.rmSync(f.owner, { recursive: true, force: true }));
  const result = await approveCodexE2EHooks({
    codexBin: 'codex',
    codexHome: f.codexHome,
    marketplace: f.marketplace,
    appServerFactory: factoryFor(f.codexHome, f.marketplace, f.entries),
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.trustedHooks, f.entries.length);
});

test('Codex E2E hook approval fails closed when hooks come from another cache root', async (t) => {
  const f = setup();
  t.after(() => fs.rmSync(f.owner, { recursive: true, force: true }));
  const result = await approveCodexE2EHooks({
    codexBin: 'codex',
    codexHome: f.codexHome,
    marketplace: f.marketplace,
    appServerFactory: factoryFor(
      f.codexHome,
      f.marketplace,
      f.entries,
      path.join(f.codexHome, 'plugins', 'cache', 'stale', 'traffic-one', 'old', 'hooks', 'hooks.json'),
    ),
  });

  assert.equal(result.status, 'blocked-environment');
  assert.match(result.detail, /metadata mismatch/);
  assert.equal(result.trustedHooks, 0);
});
