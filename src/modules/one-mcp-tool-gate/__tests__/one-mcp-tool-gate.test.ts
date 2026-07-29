import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeClaudeAdapter } from '../../../adapters/claude';
import { makeCopilotAdapter } from '../../../adapters/copilot';
import { makeCursorAdapter } from '../../../adapters/cursor';
import { makeKiloAdapter } from '../../../adapters/kilo';
import { makeOpenCodeAdapter } from '../../../adapters/opencode';
import { makeWindsurfAdapter } from '../../../adapters/windsurf';
import type { HostAdapter, RawInvocation } from '../../../adapters/types';
import { ONE_MCP_MANAGED_TOOLS } from '../../../config/one-mcp';
import { dispatch } from '../../../core/dispatch';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { isManagedOneMcpAgentTool } from '../../../shared/one-mcp/agent-tools';
import { handlers } from '../index';

interface Fixture {
  host: string;
  adapter: HostAdapter;
  invocation(tool: string, cwd: string): RawInvocation;
  denied(stdout: string): boolean;
}

const fixtures: Fixture[] = [
  {
    host: 'claude',
    adapter: makeClaudeAdapter('claude'),
    invocation: (tool, cwd) => ({
      argv: ['check-one-mcp-tool'],
      stdin: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: `mcp__traffic-one-mcp__${tool}`, tool_input: {} }),
    }),
    denied: (stdout) => JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny',
  },
  {
    host: 'codex',
    adapter: makeClaudeAdapter('codex'),
    invocation: (tool, cwd) => ({
      argv: ['check-one-mcp-tool'],
      stdin: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: `mcp__traffic-one-mcp__${tool}`, tool_input: {} }),
    }),
    denied: (stdout) => JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny',
  },
  {
    host: 'cursor',
    adapter: makeCursorAdapter(),
    invocation: (tool, cwd) => ({
      argv: ['before-mcp-execution'],
      stdin: JSON.stringify({ workspace_roots: [cwd], command: 'traffic-one-mcp', tool_name: tool, tool_input: {} }),
    }),
    denied: (stdout) => JSON.parse(stdout).permission === 'deny',
  },
  {
    host: 'copilot',
    adapter: makeCopilotAdapter('cli'),
    invocation: (tool, cwd) => ({
      argv: ['before-tool-use'],
      stdin: JSON.stringify({ cwd, tool_name: `traffic-one-mcp/${tool}`, tool_args: '{}' }),
    }),
    denied: (stdout) => JSON.parse(stdout).permissionDecision === 'deny',
  },
  {
    host: 'opencode',
    adapter: makeOpenCodeAdapter(),
    invocation: (tool, cwd) => ({
      argv: ['before-tool-use'],
      stdin: JSON.stringify({ cwd, event: 'tool.execute.before', tool_name: `traffic-one-mcp_${tool}`, tool_input: {} }),
    }),
    denied: (stdout) => JSON.parse(stdout).kind === 'deny',
  },
  {
    host: 'kilo',
    adapter: makeKiloAdapter(),
    invocation: (tool, cwd) => ({
      argv: ['before-tool-use'],
      stdin: JSON.stringify({ cwd, event: 'tool.execute.before', tool_name: `traffic-one-mcp_${tool}`, tool_input: {} }),
    }),
    denied: (stdout) => JSON.parse(stdout).kind === 'deny',
  },
  {
    host: 'windsurf',
    adapter: makeWindsurfAdapter(),
    invocation: (tool, cwd) => ({
      argv: ['pre_mcp_tool_use'],
      stdin: JSON.stringify({
        agent_action_name: 'pre_mcp_tool_use',
        workspace_root: cwd,
        tool_info: { cwd, mcp_server_name: 'traffic-one-mcp', mcp_tool_name: tool },
      }),
    }),
    denied: (stdout) => JSON.parse(stdout).kind === 'deny',
  },
];

test('the exact managed pair is denied on all seven hosts for true, false, and missing pluginUse', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-gate-'));
  const prefs = path.join(cwd, 'preferences.json');
  const prior = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
  try {
    for (const choice of [true, false, null] as const) {
      fs.rmSync(prefs, { force: true });
      if (choice !== null) recordPluginUseChoice(cwd, choice, 'test', process.env);
      for (const fixture of fixtures) {
        for (const tool of ONE_MCP_MANAGED_TOOLS) {
          const stdout = await dispatch(fixture.adapter, handlers, fixture.invocation(tool, cwd));
          assert.equal(
            fixture.denied(stdout),
            true,
            `${fixture.host}/${tool} must deny when pluginUse is ${String(choice)}`,
          );
        }
      }
    }
  } finally {
    if (prior === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prior;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('near-collision server and tool names are not denied', () => {
  assert.equal(isManagedOneMcpAgentTool('claude', 'mcp__traffic-one-mcp-copy__get_config'), false);
  assert.equal(isManagedOneMcpAgentTool('cursor', 'traffic-one-mcp.get_config_copy'), false);
  assert.equal(isManagedOneMcpAgentTool('copilot', 'other/get_config'), false);
  assert.equal(isManagedOneMcpAgentTool('opencode', 'traffic-one-mcp-copy_get_config'), false);
  assert.equal(isManagedOneMcpAgentTool('kilo', 'traffic-one-mcp_report_codebase_metadata_copy'), false);
  assert.equal(isManagedOneMcpAgentTool('windsurf', 'traffic-one-mcp-copy.report_codebase_metadata'), false);
});
