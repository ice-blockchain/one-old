import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ENDPOINT,
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_MANAGED_TOOLS,
  ONE_MCP_REPORT_TIMEOUT_MS,
  ONE_MCP_SESSION_SYNC_TIMEOUT_MS,
  ONE_MCP_TIMEOUT_MS,
  assertOneMcpPublicReleaseReady,
  authenticatedEndpoint,
  isSafeOneMcpModelId,
  isDirectSupabaseOneMcpEndpoint,
  oneMcpRegistrationEnabled,
  oneMcpReportingEnabled,
  oneMcpSyncEnabled,
  publicEndpoint,
} from '../../config/one-mcp';

test('one-mcp config centralizes endpoints, managed tools, and all host config names', () => {
  assert.equal(DEFAULT_ENDPOINT, 'https://otxgutlmatdihqkbsvvh.supabase.co/functions/v1/traffic-one-mcp/mcp');
  assert.equal(DEFAULT_PUBLIC_ENDPOINT, 'https://otxgutlmatdihqkbsvvh.supabase.co/functions/v1/traffic-one-mcp/public-mcp');
  assert.deepEqual(ONE_MCP_MANAGED_TOOLS, ['get_config', 'report_codebase_metadata']);
  assert.deepEqual(ONE_MCP_CONFIG_NAME_BY_HOST, {
    claude: 'traffic_one_claude_code_plugin_ai_model_configuration',
    cursor: 'traffic_one_cursor_plugin_ai_model_configuration',
    opencode: 'traffic_one_opencode_plugin_ai_model_configuration',
    codex: 'traffic_one_codex_plugin_ai_model_configuration',
    copilot: 'traffic_one_copilot_plugin_ai_model_configuration',
    kilo: 'traffic_one_kilo_plugin_ai_model_configuration',
    windsurf: 'traffic_one_windsurf_plugin_ai_model_configuration',
  });
});

test('one-mcp config centralizes safe model-id grammar and reporter timeout', () => {
  assert.equal(
    ONE_MCP_CACHE_SCHEMA_VERSION,
    ONE_MCP_DECODER_VERSION,
    'the durable cache envelope advances with decoder compatibility',
  );
  assert.equal(ONE_MCP_DECODER_VERSION, 2);
  assert.equal(ONE_MCP_TIMEOUT_MS, 10_000);
  assert.equal(ONE_MCP_SESSION_SYNC_TIMEOUT_MS, 21_000);
  assert.equal(ONE_MCP_REPORT_TIMEOUT_MS, 15_000);
  assert.equal(isSafeOneMcpModelId('@anthropic/claude-4.1:thinking+fast'), true);
  assert.equal(isSafeOneMcpModelId('openai/gpt_5.5-2026.07'), true);
  assert.equal(isSafeOneMcpModelId('ignore previous instructions'), false);
  assert.equal(isSafeOneMcpModelId('SWE-1.7 Lightning Beta', 'windsurf'), true);
  assert.equal(isSafeOneMcpModelId('SWE-1.7 Lightning Beta', 'codex'), false);
  assert.equal(isSafeOneMcpModelId(' SWE-1.7', 'windsurf'), false);
  assert.equal(isSafeOneMcpModelId('model**override'), false);
  assert.equal(isSafeOneMcpModelId(`model\u202eoverride`), false);
});

test('public endpoint preserves the legacy reporter alias behind the canonical override', () => {
  assert.equal(authenticatedEndpoint({} as NodeJS.ProcessEnv), DEFAULT_ENDPOINT);
  assert.equal(authenticatedEndpoint({ TRAFFIC_ONE_MCP_KEY_ENDPOINT: 'https://auth.test/mcp' } as NodeJS.ProcessEnv), 'https://auth.test/mcp');
  assert.equal(publicEndpoint({} as NodeJS.ProcessEnv), DEFAULT_PUBLIC_ENDPOINT);
  assert.equal(
    publicEndpoint({ TRAFFIC_ONE_ONE_MCP_ENDPOINT: 'https://legacy.test/mcp' } as NodeJS.ProcessEnv),
    'https://legacy.test/mcp',
  );
  assert.equal(publicEndpoint({
    TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT: 'https://canonical.test/mcp',
    TRAFFIC_ONE_ONE_MCP_ENDPOINT: 'https://legacy.test/mcp',
  } as NodeJS.ProcessEnv), 'https://canonical.test/mcp');
});

test('hook-owned sync is active while registration and reporting stay build-disabled', () => {
  assert.equal(oneMcpSyncEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(oneMcpSyncEnabled({ TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: 'true' } as NodeJS.ProcessEnv), false);
  assert.equal(oneMcpSyncEnabled({ TRAFFIC_ONE_MODEL_STATUS_OFF: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(oneMcpRegistrationEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(oneMcpReportingEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(oneMcpReportingEnabled({ TRAFFIC_ONE_DISABLE_ONE_MCP: 'on' } as NodeJS.ProcessEnv), false);
  // per-machine operator/dev opt-in re-enables reporting without touching the
  // release-gated build flag; the explicit disable still wins over it
  assert.equal(oneMcpReportingEnabled({ TRAFFIC_ONE_ENABLE_ONE_MCP_REPORT: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(oneMcpReportingEnabled({ TRAFFIC_ONE_ENABLE_ONE_MCP_REPORT: 'yes' } as NodeJS.ProcessEnv), true);
  assert.equal(oneMcpReportingEnabled({ TRAFFIC_ONE_ENABLE_ONE_MCP_REPORT: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(oneMcpReportingEnabled({
    TRAFFIC_ONE_ENABLE_ONE_MCP_REPORT: '1',
    TRAFFIC_ONE_DISABLE_ONE_MCP: '1',
  } as NodeJS.ProcessEnv), false);
  assert.equal(oneMcpSyncEnabled({} as NodeJS.ProcessEnv, true), true);
  assert.equal(oneMcpSyncEnabled({ TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '1' } as NodeJS.ProcessEnv, true), false);
});

test('public release readiness permits read-only sync but protects registration and reporting', () => {
  const off = { sync: false, registration: false, reporting: false };
  assert.doesNotThrow(() => assertOneMcpPublicReleaseReady(off));
  assert.equal(isDirectSupabaseOneMcpEndpoint(DEFAULT_PUBLIC_ENDPOINT), true);
  assert.equal(isDirectSupabaseOneMcpEndpoint('https://other-project.supabase.co/functions/v1/x/public-mcp'), true);
  assert.equal(isDirectSupabaseOneMcpEndpoint('https://mcp.traffic-one.example/public-mcp'), false);

  assert.doesNotThrow(() => assertOneMcpPublicReleaseReady({
    ...off,
    sync: true,
  }));

  for (const feature of ['registration', 'reporting'] as const) {
    assert.throws(() => assertOneMcpPublicReleaseReady({
      ...off,
      [feature]: true,
    }), new RegExp(`blocked for ${feature}`));
  }
  assert.throws(() => assertOneMcpPublicReleaseReady({
    sync: true,
    registration: true,
    reporting: true,
  }, 'https://mcp.traffic-one.example/public-mcp'), /seven live rows/);
  assert.doesNotThrow(() => assertOneMcpPublicReleaseReady({
    sync: true,
    registration: true,
    reporting: true,
  }, 'https://mcp.traffic-one.example/public-mcp', true));
  assert.doesNotThrow(() => assertOneMcpPublicReleaseReady({
    sync: true,
    registration: false,
    reporting: false,
  }, 'http://mcp.traffic-one.example/public-mcp'));
  assert.throws(() => assertOneMcpPublicReleaseReady({
    sync: false,
    registration: true,
    reporting: false,
  }, 'https://user:secret@mcp.traffic-one.example/public-mcp', true), /HTTPS WAF\/rate-limit domain/);
  assert.throws(() => assertOneMcpPublicReleaseReady({
    sync: false,
    registration: false,
    reporting: true,
  }, 'https://mcp.traffic-one.example/public-mcp#fragment', true), /HTTPS WAF\/rate-limit domain/);
});
