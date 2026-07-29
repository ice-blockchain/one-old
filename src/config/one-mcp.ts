// Traffic One remote MCP configuration. This is the source of truth for the
// fixed authenticated onboarding mount, anonymous public mount, and host
// registration. Reporting-specific configuration lives in reporting.ts.

import type { HostModelKey } from './model-tiers';

export const DEFAULT_ENDPOINT =
  'https://otxgutlmatdihqkbsvvh.supabase.co/functions/v1/traffic-one-mcp/mcp';
// Direct public endpoint used by read-only get_config sync and anonymous
// reporting.
export const DEFAULT_PUBLIC_ENDPOINT =
  'https://otxgutlmatdihqkbsvvh.supabase.co/functions/v1/traffic-one-mcp/public-mcp';

export const ONE_MCP_SERVER_NAME = 'traffic-one-mcp';
export const ONE_MCP_GET_CONFIG_TOOL = 'get_config';
export const ONE_MCP_REPORT_TOOL = 'report_codebase_metadata';
export const ONE_MCP_MANAGED_TOOLS = [ONE_MCP_GET_CONFIG_TOOL, ONE_MCP_REPORT_TOOL] as const;

export const ONE_MCP_CONFIG_NAME_BY_HOST: Readonly<Record<HostModelKey, string>> = {
  claude: 'traffic_one_claude_code_plugin_ai_model_configuration',
  cursor: 'traffic_one_cursor_plugin_ai_model_configuration',
  opencode: 'traffic_one_opencode_plugin_ai_model_configuration',
  codex: 'traffic_one_codex_plugin_ai_model_configuration',
  copilot: 'traffic_one_copilot_plugin_ai_model_configuration',
  kilo: 'traffic_one_kilo_plugin_ai_model_configuration',
  windsurf: 'traffic_one_windsurf_plugin_ai_model_configuration',
};

export const ONE_MCP_DECODER_VERSION = 2;
// The cache envelope is the durable decoder boundary. Coupling these versions
// ensures an older plugin treats cache data emitted by a newer decoder as
// future state instead of rewriting it through an older schema.
export const ONE_MCP_CACHE_SCHEMA_VERSION = ONE_MCP_DECODER_VERSION;
export const ONE_MCP_CACHE_FILE = 'one-mcp.json';
// The public edge function can take several seconds to answer after a cold
// start. Keep get_config bounded, but leave enough headroom for the observed
// cold path so a healthy config does not spuriously fall back to bundled data.
export const ONE_MCP_TIMEOUT_MS = 10_000;
// A missing/corrupt cache can receive an up-to-date sentinel and must retry
// once with version 0. Keep the synchronous SessionStart bridge alive for both
// bounded HTTP attempts plus a small process-start/flush allowance.
export const ONE_MCP_SESSION_SYNC_TIMEOUT_MS = (ONE_MCP_TIMEOUT_MS * 2) + 1_000;
export const ONE_MCP_MAX_RESPONSE_BYTES = 64 * 1024;
// public.plugin_config versions and the get_config request contract use a
// signed 32-bit positive integer. Cache and diagnostics must enforce the same
// bound or a syntactically valid cache could become impossible to request.
export const ONE_MCP_MAX_CONFIG_VERSION = 2_147_483_647;
// public.plugin_config enforces a stricter DB payload cap than the transport
// envelope. Operator artifacts validate this before a row can be reviewed for
// publication, so an oversized HOST_MODELS edit fails during generation.
export const ONE_MCP_MAX_PUBLISHED_PAYLOAD_BYTES = 32 * 1024;
export const ONE_MCP_MAX_PAYLOAD_DEPTH = 32;
// Keep both the bundled catalog and every accepted remote row deliberately
// small. Ordered fallbacks beyond the first four are not actionable for the
// runtime and would make a published config diverge from the reviewed policy.
export const ONE_MCP_MAX_MODELS_PER_TIER = 4;
export const ONE_MCP_MAX_AVAILABLE_MODELS = 256;
export const ONE_MCP_MAX_MODEL_ID_LENGTH = 256;
// Remote model identifiers are rendered in hook-owned agent context. Keep the
// accepted alphabet deliberately structural: no whitespace, Markdown syntax,
// controls, bidi markers, or other Unicode prose can cross this boundary.
export const ONE_MCP_MODEL_ID_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._:+/@-]+$/;
export const ONE_MCP_WINDSURF_MODEL_ID_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._:+/@ -]+$/;

export function isSafeOneMcpModelId(value: unknown, host?: HostModelKey): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= ONE_MCP_MAX_MODEL_ID_LENGTH
    && value === value.trim()
    && (host === 'windsurf'
      ? ONE_MCP_WINDSURF_MODEL_ID_RE.test(value)
      : ONE_MCP_MODEL_ID_RE.test(value));
}

export const ONE_MCP_CACHE_LOCK_TIMEOUT_MS = 1_000;
export const ONE_MCP_CACHE_LOCK_RETRY_MS = 10;
export const ONE_MCP_CACHE_LOCK_STALE_MS = 10_000;
export const ONE_MCP_CODEX_REGISTRATION_LOCK_TIMEOUT_MS = 1_500;
export const ONE_MCP_CODEX_REGISTRATION_LOCK_RETRY_MS = 20;
export const ONE_MCP_CODEX_REGISTRATION_LOCK_STALE_MS = 30_000;
export const ONE_MCP_CODEX_STARTUP_TIMEOUT_SEC = 30;
export const ONE_MCP_CODEX_TOOL_TIMEOUT_SEC = 60;

export const ONE_MCP_OPERATOR_MANIFEST_FILE = 'operator/one-mcp-model-configs.json';
export const ONE_MCP_OPERATOR_CAS_SQL_FILE = 'operator/one-mcp-publish-cas.sql';

// Remote behavior is controlled only by these compiled switches. Runtime use
// still requires the durable per-project pluginUse.enabled === true choice.
export const ONE_MCP_SYNC = true;
export const ONE_MCP_REGISTRATION = false;
