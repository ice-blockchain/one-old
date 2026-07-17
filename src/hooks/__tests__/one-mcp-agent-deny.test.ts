import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runClaudeHook } from '../claude-entry';
import { runCopilotHook } from '../copilot-entry';
import { runCursorHook } from '../cursor-entry';
import { runKiloHook } from '../kilo-entry';
import { runOpenCodeHook } from '../opencode-entry';
import { runWindsurfHook } from '../windsurf-entry';
import { recordPluginUseChoice } from '../../shared/state/plugin-use';

test('host entrypoints deny managed MCP calls even for an explicitly declined project', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-entry-'));
  const prefs = path.join(cwd, 'preferences.json');
  const env = {
    ...process.env,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: prefs,
    TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1',
  } as NodeJS.ProcessEnv;
  recordPluginUseChoice(cwd, false, 'test', env);
  try {
    const claude = await runClaudeHook('check-one-mcp-tool', JSON.stringify({
      hook_event_name: 'PreToolUse', cwd, tool_name: 'mcp__traffic-one-mcp__get_config', tool_input: {},
    }), { ...env, CLAUDE_PLUGIN_ROOT: '/plugin' });
    assert.equal(JSON.parse(claude.stdout).hookSpecificOutput?.permissionDecision, 'deny');

    const codex = await runClaudeHook('check-one-mcp-tool', JSON.stringify({
      hook_event_name: 'PreToolUse', cwd, tool_name: 'mcp__traffic-one-mcp__report_codebase_metadata', tool_input: {},
    }), { ...env, CODEX_PLUGIN_ROOT: '/plugin' });
    assert.equal(JSON.parse(codex.stdout).hookSpecificOutput?.permissionDecision, 'deny');

    const cursor = await runCursorHook('before-mcp-execution', JSON.stringify({
      workspace_roots: [cwd], command: 'traffic-one-mcp', tool_name: 'get_config',
    }), env);
    assert.equal(JSON.parse(cursor.stdout).permission, 'deny');

    const copilot = await runCopilotHook('before-tool-use', JSON.stringify({
      cwd, tool_name: 'traffic-one-mcp/report_codebase_metadata', tool_args: '{}',
    }), { ...env, TRAFFIC_ONE_COPILOT_WIRE: 'cli' });
    assert.equal(JSON.parse(copilot.stdout).permissionDecision, 'deny');

    const opencode = await runOpenCodeHook('before-tool-use', JSON.stringify({
      cwd, event: 'tool.execute.before', tool_name: 'traffic-one-mcp_get_config', tool_input: {},
    }), env);
    assert.equal(JSON.parse(opencode.stdout).kind, 'deny');

    const kilo = await runKiloHook('before-tool-use', JSON.stringify({
      cwd, event: 'tool.execute.before', tool_name: 'traffic-one-mcp_report_codebase_metadata', tool_input: {},
    }), env);
    assert.equal(JSON.parse(kilo.stdout).kind, 'deny');

    const windsurf = await runWindsurfHook('pre_mcp_tool_use', JSON.stringify({
      agent_action_name: 'pre_mcp_tool_use',
      workspace_root: cwd,
      tool_info: { cwd, mcp_server_name: 'traffic-one-mcp', mcp_tool_name: 'get_config' },
    }), env);
    assert.equal(windsurf.exitCode, 2);

    const syntheticDevin = await runWindsurfHook('pre_mcp_tool_use', JSON.stringify({
      agent_action_name: 'pre_mcp_tool_use',
      trajectory_id: '',
      workspace_root: cwd,
      tool_info: { cwd, mcp_server_name: 'traffic-one-mcp', mcp_tool_name: 'report_codebase_metadata' },
    }), env);
    assert.equal(syntheticDevin.exitCode, 2, 'managed denial precedes Devin duplicate suppression');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('malformed pre-tool payloads fail closed while post-tool lifecycle payloads remain non-blocking', async () => {
  const malformed = '{';

  const cursorPre = await runCursorHook('before-mcp-execution', malformed);
  assert.equal(JSON.parse(cursorPre.stdout).permission, 'deny');
  const cursorPost = await runCursorHook('after-shell-execution', malformed);
  assert.notEqual(JSON.parse(cursorPost.stdout).permission, 'deny');

  const copilotPre = await runCopilotHook('before-tool-use', malformed, { TRAFFIC_ONE_COPILOT_WIRE: 'cli' });
  assert.equal(JSON.parse(copilotPre.stdout).permissionDecision, 'deny');
  const copilotPost = await runCopilotHook('after-tool-use', malformed, { TRAFFIC_ONE_COPILOT_WIRE: 'cli' });
  assert.equal(copilotPost.stdout, '');

  const windsurfPre = await runWindsurfHook('pre_mcp_tool_use', malformed);
  assert.equal(windsurfPre.exitCode, 2);
  assert.match(windsurfPre.stderr, /fail-closed/);
  const windsurfPost = await runWindsurfHook('post_mcp_tool_use', malformed);
  assert.equal(windsurfPost.exitCode, 0);
});
