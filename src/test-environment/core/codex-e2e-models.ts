// Codex release E2E must test Traffic One's behavior, not whether the newest
// production model catalog has reached an older installed CLI. Keep the
// compatibility catalog entirely inside each case's isolated One MCP cache and
// verify every configured slug against the live Codex model/list response
// before spending a host turn. Production runtime selection is untouched.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  publicEndpoint,
} from '../../config/one-mcp';
import type { HostCommandConfig } from './types';
import {
  writeOneMcpConfigCacheEntry,
} from '../../shared/one-mcp-cache';
import {
  oneMcpPayloadFingerprint,
} from '../../shared/one-mcp';
import type {
  OneMcpModelConfigPayload,
} from '../../shared/one-mcp/types';
import {
  defaultCodexProofAppServerFactory,
  type CodexProofAppServerFactory,
} from './codex-trust-upgrade-proof';

type Rec = Record<string, unknown>;
export type E2eModelTier = 'highest' | 'balanced' | 'cheapest';
export type E2eModelCatalog = Readonly<Record<E2eModelTier, string>>;

export interface CodexE2eModelPreflight {
  status: 'ready' | 'blocked-environment';
  detail: string;
  availableModels: string[];
  requiredModels: string[];
}

export interface CodexE2eModelPreflightOptions {
  appServerFactory?: CodexProofAppServerFactory;
  codexHome?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 8;
const MAX_MODELS = 512;

function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Rec
    : null;
}

function configuredModels(config: HostCommandConfig): string[] {
  const catalog = config.testModelByTier;
  return [...new Set([
    config.testModel,
    catalog?.highest,
    catalog?.balanced,
    catalog?.cheapest,
  ].filter((model): model is string => typeof model === 'string' && model.length > 0))];
}

function parseModelListPage(value: unknown): { models: string[]; nextCursor: string | null } | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.data)) return null;
  const models: string[] = [];
  for (const item of raw.data) {
    const row = record(item);
    if (!row || typeof row.model !== 'string' || !row.model.trim()) return null;
    models.push(row.model.trim());
  }
  if (raw.nextCursor !== undefined && raw.nextCursor !== null && typeof raw.nextCursor !== 'string') {
    return null;
  }
  return {
    models,
    nextCursor: typeof raw.nextCursor === 'string' && raw.nextCursor
      ? raw.nextCursor
      : null,
  };
}

export async function preflightCodexE2eModels(
  config: HostCommandConfig,
  options: CodexE2eModelPreflightOptions = {},
): Promise<CodexE2eModelPreflight> {
  const requiredModels = configuredModels(config);
  if (!config.testModelByTier || requiredModels.length < 3) {
    return {
      status: 'blocked-environment',
      detail: 'Codex E2E has no complete isolated highest/balanced/cheapest test catalog.',
      availableModels: [],
      requiredModels,
    };
  }

  const env = { ...process.env, ...(options.env ?? {}) };
  const codexHome = path.resolve(
    options.codexHome
      ?? env.CODEX_HOME
      ?? path.join(os.homedir(), '.codex'),
  );
  env.CODEX_HOME = codexHome;
  if (!fs.existsSync(codexHome)) {
    return {
      status: 'blocked-environment',
      detail: `Codex E2E cannot inspect model availability because CODEX_HOME is missing: ${codexHome}`,
      availableModels: [],
      requiredModels,
    };
  }

  const factory = options.appServerFactory ?? defaultCodexProofAppServerFactory;
  let client: Awaited<ReturnType<CodexProofAppServerFactory>> | null = null;
  try {
    client = await factory({
      codexBin: config.bin,
      cwd: path.resolve(options.cwd ?? process.cwd()),
      codexHome,
      env,
      markerPath: path.join(os.tmpdir(), 'traffic-one-codex-e2e-model-list-unused'),
      // `app-server` does not accept --profile-v2. Model availability is
      // account/CLI state, independent from the plugin profile used by exec.
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const found: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const response = await client.request<unknown>('model/list', {
        cursor,
        includeHidden: true,
        limit: 128,
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const page = parseModelListPage(response);
      if (!page) {
        return {
          status: 'blocked-environment',
          detail: 'Codex model/list returned an invalid response; the E2E model contract cannot be proven.',
          availableModels: [...new Set(found)],
          requiredModels,
        };
      }
      found.push(...page.models);
      if (found.length > MAX_MODELS) {
        return {
          status: 'blocked-environment',
          detail: `Codex model/list exceeded the ${MAX_MODELS}-model E2E safety bound.`,
          availableModels: [...new Set(found.slice(0, MAX_MODELS))],
          requiredModels,
        };
      }
      cursor = page.nextCursor;
      if (!cursor) break;
      if (pageIndex === MAX_PAGES - 1) {
        return {
          status: 'blocked-environment',
          detail: `Codex model/list exceeded the ${MAX_PAGES}-page E2E safety bound.`,
          availableModels: [...new Set(found)],
          requiredModels,
        };
      }
    }
    const availableModels = [...new Set(found)];
    const missing = requiredModels.filter((model) => !availableModels.includes(model));
    return missing.length === 0
      ? {
        status: 'ready',
        detail: `Codex exposes every isolated E2E model (${requiredModels.join(', ')}).`,
        availableModels,
        requiredModels,
      }
      : {
        status: 'blocked-environment',
        detail: `Codex does not expose required isolated E2E model(s): ${missing.join(', ')}.`,
        availableModels,
        requiredModels,
      };
  } catch (error) {
    return {
      status: 'blocked-environment',
      detail: `Codex model availability preflight failed: ${String(error)}`,
      availableModels: [],
      requiredModels,
    };
  } finally {
    await client?.close();
  }
}

export function seedCodexE2eModelCatalog(
  config: HostCommandConfig,
  env: NodeJS.ProcessEnv,
): E2eModelCatalog | null {
  const catalog = config.testModelByTier;
  if (!catalog) return null;
  const payload: OneMcpModelConfigPayload = {
    tiers: {
      high: [catalog.highest],
      balanced: [catalog.balanced],
      low: [catalog.cheapest],
      auto: [catalog.balanced],
    },
  };
  const now = new Date().toISOString();
  writeOneMcpConfigCacheEntry('codex', {
    endpoint: publicEndpoint(env),
    configName: ONE_MCP_CONFIG_NAME_BY_HOST.codex,
    decoderVersion: ONE_MCP_DECODER_VERSION,
    version: 1,
    createdAt: now,
    updatedAt: now,
    payload,
    payloadFingerprint: oneMcpPayloadFingerprint(payload),
  }, env);
  return { ...catalog };
}
