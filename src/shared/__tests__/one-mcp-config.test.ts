import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ENDPOINT,
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_MANAGED_TOOLS,
  ONE_MCP_REGISTRATION,
  ONE_MCP_SESSION_SYNC_TIMEOUT_MS,
  ONE_MCP_SYNC,
  ONE_MCP_TIMEOUT_MS,
  isSafeOneMcpModelId,
} from '../../config/one-mcp';
import { ONE_MCP_REPORT_TIMEOUT_MS } from '../../config/reporting';

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

test('one-mcp runtime behavior uses only compiled feature switches and fixed endpoints', () => {
  assert.equal(ONE_MCP_SYNC, true);
  assert.equal(ONE_MCP_REGISTRATION, false);
  assert.match(DEFAULT_ENDPOINT, /^https:\/\/.+\/traffic-one-mcp\/mcp$/);
  assert.match(DEFAULT_PUBLIC_ENDPOINT, /^https:\/\/.+\/traffic-one-mcp\/public-mcp$/);
});
