// Prove and approve the exact staged Codex hooks before live E2E.
//
// `--dangerously-bypass-hook-trust` is not accepted as prevention evidence:
// current Codex builds can discover untrusted hooks yet omit them from exec.
// The harness therefore verifies the content-addressed source path and ABI
// hashes, persists trust in the disposable CODEX_HOME, re-lists the hooks as
// trusted, and only then permits an LLM case to start.

import * as fs from 'fs';
import * as path from 'path';

import { REPO_ROOT_PATH } from '../config/test-config';
import type { CodexMarketplaceStage } from './current-dist';
import {
  defaultCodexProofAppServerFactory,
  type CodexProofAppServer,
  type CodexProofAppServerFactory,
} from './codex-trust-upgrade-proof';

type Rec = Record<string, unknown>;

interface AbiEntry {
  key: string;
  currentHash: string;
}

interface HookRow {
  key: string;
  currentHash: string;
  sourcePath: string;
  source: string;
  pluginId: string;
  handlerType: string;
  enabled: boolean;
  isManaged: boolean;
  trustStatus: string;
}

export interface CodexE2EHookApprovalOptions {
  codexBin: string;
  codexHome: string;
  marketplace: CodexMarketplaceStage;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  appServerFactory?: CodexProofAppServerFactory;
}

export interface CodexE2EHookApproval {
  status: 'ready' | 'blocked-environment';
  detail: string;
  trustedHooks: number;
}

const ABI_PATH = path.join(REPO_ROOT_PATH, 'tests', 'fixtures', 'codex-hook-abi.v1.json');
const DEFAULT_TIMEOUT_MS = 30_000;

function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Rec
    : null;
}

function normalizedHash(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function loadAbi(): AbiEntry[] {
  const raw = JSON.parse(fs.readFileSync(ABI_PATH, 'utf8')) as unknown;
  const root = record(raw);
  if (root?.version !== 1 || !Array.isArray(root.entries)) {
    throw new Error(`invalid Codex hook ABI fixture: ${ABI_PATH}`);
  }
  return root.entries.map((entry) => {
    const row = record(entry);
    if (!row || typeof row.key !== 'string' || typeof row.currentHash !== 'string') {
      throw new Error(`malformed Codex hook ABI entry: ${JSON.stringify(entry).slice(0, 300)}`);
    }
    return { key: row.key, currentHash: normalizedHash(row.currentHash) };
  });
}

function hooksForCwd(value: unknown, cwd: string): { hooks: HookRow[]; warnings: string[] } {
  const root = record(value);
  if (!root || !Array.isArray(root.data)) throw new Error('hooks/list returned an invalid response');
  const target = root.data
    .map(record)
    .find((entry) => typeof entry?.cwd === 'string' && path.resolve(entry.cwd) === path.resolve(cwd));
  if (!target || !Array.isArray(target.hooks) || !Array.isArray(target.errors) || !Array.isArray(target.warnings)) {
    throw new Error(`hooks/list returned no complete entry for ${cwd}`);
  }
  if (target.errors.length > 0) {
    throw new Error(`hooks/list reported discovery errors: ${JSON.stringify(target.errors).slice(0, 1000)}`);
  }
  const hooks: HookRow[] = target.hooks.map((hook) => {
    const row = record(hook);
    if (
      !row
      || typeof row.key !== 'string'
      || typeof row.currentHash !== 'string'
      || typeof row.sourcePath !== 'string'
      || typeof row.source !== 'string'
      || typeof row.pluginId !== 'string'
      || typeof row.handlerType !== 'string'
      || typeof row.enabled !== 'boolean'
      || typeof row.isManaged !== 'boolean'
      || typeof row.trustStatus !== 'string'
    ) {
      throw new Error(`hooks/list returned a malformed hook row: ${JSON.stringify(hook).slice(0, 1000)}`);
    }
    return row as unknown as HookRow;
  });
  return {
    hooks,
    warnings: target.warnings.filter((item): item is string => typeof item === 'string'),
  };
}

function verifyStagedHooks(
  hooks: HookRow[],
  abi: AbiEntry[],
  options: CodexE2EHookApprovalOptions,
  expectedTrust: 'untrusted' | 'trusted',
): void {
  const prefix = `${options.marketplace.pluginSelector}:hooks/hooks.json:`;
  const selected = hooks.filter((hook) => hook.pluginId === options.marketplace.pluginSelector);
  if (selected.length !== abi.length) {
    throw new Error(`staged Codex plugin exposed ${selected.length}/${abi.length} required hooks`);
  }
  const expectedSource = path.resolve(
    options.codexHome,
    'plugins',
    'cache',
    options.marketplace.name,
    'traffic-one',
    options.marketplace.cacheVersion,
    'hooks',
    'hooks.json',
  );
  const expectedByKey = new Map(abi.map((entry) => [entry.key, entry.currentHash]));
  for (const hook of selected) {
    if (!hook.key.startsWith(prefix)) {
      throw new Error(`staged hook key escaped its selector: ${hook.key}`);
    }
    const relativeKey = hook.key.slice(prefix.length);
    const expectedHash = expectedByKey.get(relativeKey);
    if (!expectedHash || normalizedHash(hook.currentHash) !== expectedHash) {
      throw new Error(`staged hook ABI mismatch for ${relativeKey}: ${hook.currentHash}`);
    }
    if (
      path.resolve(hook.sourcePath) !== expectedSource
      || hook.source !== 'plugin'
      || hook.handlerType !== 'command'
      || !hook.enabled
      || hook.isManaged
      || hook.trustStatus !== expectedTrust
    ) {
      throw new Error(`staged hook metadata mismatch for ${relativeKey}: ${JSON.stringify(hook).slice(0, 1200)}`);
    }
  }
}

async function listHooks(
  factory: CodexProofAppServerFactory,
  options: CodexE2EHookApprovalOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{ client: CodexProofAppServer; hooks: HookRow[]; warnings: string[] }> {
  const client = await factory({
    codexBin: options.codexBin,
    cwd,
    codexHome: options.codexHome,
    env,
    markerPath: path.join(options.codexHome, '.traffic-one-e2e-hook-approval-unused'),
    timeoutMs,
  });
  try {
    const response = await client.request<unknown>('hooks/list', { cwds: [cwd] }, timeoutMs);
    const parsed = hooksForCwd(response, cwd);
    return { client, ...parsed };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function approveCodexE2EHooks(
  options: CodexE2EHookApprovalOptions,
): Promise<CodexE2EHookApproval> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = path.resolve(options.cwd ?? REPO_ROOT_PATH);
  const codexHome = path.resolve(options.codexHome);
  const env = { ...process.env, ...(options.env ?? {}), CODEX_HOME: codexHome };
  const factory = options.appServerFactory ?? defaultCodexProofAppServerFactory;
  let first: CodexProofAppServer | null = null;
  let second: CodexProofAppServer | null = null;
  try {
    const abi = loadAbi();
    const before = await listHooks(factory, { ...options, codexHome }, env, cwd, timeoutMs);
    first = before.client;
    verifyStagedHooks(before.hooks, abi, { ...options, codexHome }, 'untrusted');
    if (before.warnings.length > 0) {
      throw new Error(`hooks/list warnings prevent approval: ${before.warnings.join('; ')}`);
    }

    const selected = before.hooks.filter((hook) => hook.pluginId === options.marketplace.pluginSelector);
    const trustState: Record<string, { trusted_hash: string }> = {};
    for (const hook of selected) {
      trustState[hook.key] = { trusted_hash: normalizedHash(hook.currentHash) };
    }
    const written = await first.request<unknown>('config/batchWrite', {
      edits: [{ keyPath: 'hooks.state', value: trustState, mergeStrategy: 'upsert' }],
      reloadUserConfig: true,
    }, timeoutMs);
    const write = record(written);
    if (!write) throw new Error('config/batchWrite returned an invalid response');
    if (
      typeof write.filePath === 'string'
      && fs.realpathSync(write.filePath) !== fs.realpathSync(path.join(codexHome, 'config.toml'))
    ) {
      throw new Error(`hook approval escaped isolated CODEX_HOME: ${write.filePath}`);
    }
    await first.close();
    first = null;

    const configStat = fs.statSync(path.join(codexHome, 'config.toml'));
    if ((configStat.mode & 0o777) !== 0o600) {
      throw new Error('isolated Codex config.toml is not 0600 after hook approval');
    }

    const after = await listHooks(factory, { ...options, codexHome }, env, cwd, timeoutMs);
    second = after.client;
    verifyStagedHooks(after.hooks, abi, { ...options, codexHome }, 'trusted');
    if (after.warnings.length > 0) {
      throw new Error(`trusted hooks/list warnings prevent E2E: ${after.warnings.join('; ')}`);
    }
    return {
      status: 'ready',
      detail: `Codex approved and re-observed ${abi.length}/${abi.length} exact staged hooks in the isolated home.`,
      trustedHooks: abi.length,
    };
  } catch (error) {
    return {
      status: 'blocked-environment',
      detail: `Codex staged hook approval failed: ${String(error)}`,
      trustedHooks: 0,
    };
  } finally {
    await first?.close();
    await second?.close();
  }
}
