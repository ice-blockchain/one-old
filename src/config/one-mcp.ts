// Traffic One remote MCP configuration. This is the only source of truth for
// the authenticated onboarding mount and the anonymous public config/report
// mount. Runtime clients interpret these knobs; host manifests only describe
// deliberately disabled/zero-tool registrations.

import * as path from 'path';

import type { HostModelKey } from './model-tiers';

export const DEFAULT_ENDPOINT =
  'https://nkjomfwbtpvrhdrodmwz.supabase.co/functions/v1/traffic-one-mcp/mcp';
// Direct public endpoint used by read-only, opt-in get_config sync. Before
// registration or reporting is enabled, replace this compiled default with the
// operator-provided custom domain protected by the path-scoped WAF/rate limit.
export const DEFAULT_PUBLIC_ENDPOINT =
  'https://nkjomfwbtpvrhdrodmwz.supabase.co/functions/v1/traffic-one-mcp/public-mcp';

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
export const ONE_MCP_REPORT_TIMEOUT_MS = 15_000;
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
// small. Ordered fallbacks beyond the first three are not actionable for the
// runtime and would make a published config diverge from the reviewed policy.
export const ONE_MCP_MAX_MODELS_PER_TIER = 3;
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

export const ONE_MCP_REPORT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidOneMcpReportId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && ONE_MCP_REPORT_ID_RE.test(value);
}

// Only finite, structural identifiers may be copied from project-owned state
// into the anonymous report. Dependency/file inference adds values from this
// same vocabulary; unknown state prose is ignored instead of transmitted.
export const ONE_MCP_REPORTED_TECHNOLOGY_IDS: ReadonlySet<string> = new Set([
  'alpine', 'angular', 'astro', 'capacitor', 'dart', 'django', 'dotnet', 'ember',
  'expo', 'fastapi', 'firebase', 'gatsby', 'go', 'ionic', 'java', 'javascript',
  'kotlin', 'laravel', 'lit', 'marko', 'mongo', 'nestjs', 'next.js', 'nextjs',
  'node', 'npm', 'php', 'pnpm', 'posthog', 'postgres', 'preact', 'prisma', 'python',
  'qwik', 'react', 'react-native', 'redux', 'remix', 'rust', 'solid', 'stencil',
  'supabase', 'svelte', 'swift', 'tailwindcss', 'tanstack-query', 'turborepo',
  'typescript', 'vite', 'vue', 'yarn', 'zustand',
]);

// Extension labels are project-controlled filenames. A finite vocabulary keeps
// aggregate line counts useful without allowing a crafted suffix to carry an
// email, repository name, Unicode text, or other arbitrary identifier.
export const ONE_MCP_REPORTED_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'astro', 'bash', 'c', 'cc', 'cjs', 'clj', 'cljc', 'cljs', 'cpp', 'cs', 'css',
  'csv', 'cxx', 'dart', 'dockerfile', 'eex', 'ex', 'exs', 'fish', 'fs', 'fsx',
  'go', 'gql', 'gradle', 'graphql', 'groovy', 'h', 'hbs', 'hcl', 'hh', 'hpp',
  'hrl', 'htm', 'html', 'java', 'js', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less',
  'lua', 'm', 'md', 'mdx', 'mjs', 'mm', 'nix', 'php', 'pl', 'pm', 'prisma',
  'proto', 'ps1', 'py', 'r', 'rb', 'rs', 'sass', 'scala', 'scss', 'sh', 'sol',
  'sql', 'svelte', 'swift', 'tf', 'tfvars', 'toml', 'ts', 'tsv', 'tsx', 'txt',
  'vb', 'vue', 'xml', 'yaml', 'yml', 'zig', 'zsh',
]);

export const ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS = 1_000;
export const ONE_MCP_REPORT_ID_LOCK_RETRY_MS = 10;
export const ONE_MCP_REPORT_ID_LOCK_STALE_MS = 10_000;
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
// Registration/reporting releases must consume a fresh bounded evidence bundle
// derived from the live public.plugin_config rows, public transport probes,
// hosted onboarding smoke, and Codex hook observations. Read-only, hook-owned
// model sync is activated independently and remains project opt-in gated.
export const ONE_MCP_LIVE_RELEASE_SNAPSHOT_ENV = 'TRAFFIC_ONE_MCP_LIVE_RELEASE_SNAPSHOT';
export const ONE_MCP_LIVE_RELEASE_SNAPSHOT_SCHEMA_VERSION = 2;
export const ONE_MCP_LIVE_RELEASE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

// Public features are independently kill-switchable. They still require the
// durable per-project pluginUse.enabled === true choice at runtime.
export const ONE_MCP_SYNC_ACTIVE = true;
export const ONE_MCP_REGISTRATION_ACTIVE = false;
export const REPORTING_ACTIVE = false;
export const SAVE_MCP_REPORT = false;

export interface OneMcpPublicFeatureActivation {
  readonly sync: boolean;
  readonly registration: boolean;
  readonly reporting: boolean;
}

export const ONE_UID_FIELD = 'one-uid';
export const STATUS_FILE = path.join('.traffic-one', 'one-mcp-report.json');
export const QUEUED_RETRY_MS = 5 * 60 * 1000;
export const FAILED_RETRY_MS = 60 * 60 * 1000;

export function publicEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT
    || env.TRAFFIC_ONE_ONE_MCP_ENDPOINT
    || DEFAULT_PUBLIC_ENDPOINT;
}

export function authenticatedEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || DEFAULT_ENDPOINT;
}

export function oneMcpSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
  buildActive: boolean = ONE_MCP_SYNC_ACTIVE,
): boolean {
  if (!buildActive) return false;
  return !/^(1|true|on|yes)$/i.test(String(env.TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC || ''));
}

export function oneMcpRegistrationEnabled(
  env: NodeJS.ProcessEnv = process.env,
  buildActive: boolean = ONE_MCP_REGISTRATION_ACTIVE,
): boolean {
  if (!buildActive) return false;
  return !/^(1|true|on|yes)$/i.test(String(env.TRAFFIC_ONE_DISABLE_ONE_MCP_REGISTRATION || ''));
}

export function oneMcpReportingEnabled(
  env: NodeJS.ProcessEnv = process.env,
  buildActive: boolean = REPORTING_ACTIVE,
): boolean {
  if (!buildActive) return false;
  return !/^(1|true|on|yes)$/i.test(String(env.TRAFFIC_ONE_DISABLE_ONE_MCP || ''));
}

export function isDirectSupabaseOneMcpEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'supabase.co' || hostname.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

// Release-time fail-closed gate for registration/reporting. Environment
// overrides remain useful for local development, but cannot make an unsafe
// compiled default releasable: installed clients do not inherit the
// maintainer's shell environment.
export function assertOneMcpPublicReleaseReady(
  activation: OneMcpPublicFeatureActivation = {
    sync: ONE_MCP_SYNC_ACTIVE,
    registration: ONE_MCP_REGISTRATION_ACTIVE,
    reporting: REPORTING_ACTIVE,
  },
  endpoint: string = DEFAULT_PUBLIC_ENDPOINT,
  liveManifestVerified = false,
): void {
  const enabled = Object.entries(activation)
    // Anonymous get_config is a read-only client pull and is intentionally
    // available through the direct recovery endpoint. Machine-global MCP
    // registration and reporting still require the protected release surface.
    .filter(([feature, active]) => feature !== 'sync' && active)
    .map(([feature]) => feature);
  if (enabled.length === 0) return;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`One MCP public release blocked: invalid public endpoint for ${enabled.join(', ')}`);
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || isDirectSupabaseOneMcpEndpoint(endpoint)) {
    throw new Error(
      `One MCP public release blocked for ${enabled.join(', ')}: configure the compiled HTTPS WAF/rate-limit domain instead of ${endpoint}`,
    );
  }
  if (!liveManifestVerified) {
    throw new Error(
      `One MCP public release blocked for ${enabled.join(', ')}: verify all seven live rows against the generated operator manifest`,
    );
  }
}
