// Universal deny for model-originated calls to the managed public MCP tools.
// Hook-owned sync/report calls use the HTTP client directly, so they never
// enter this PreToolUse pipeline.

import { deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';
import {
  isManagedOneMcpAgentTool,
  ONE_MCP_AGENT_TOOL_DENY_REASON,
} from '../../shared/one-mcp/agent-tools';

export const handlers: Handler[] = [
  {
    id: 'one-mcp-tool-gate.agent-call',
    event: 'PreToolUse',
    tools: ['other'],
    subcommands: [
      'check-one-mcp-tool',
      'before-mcp-execution',
      'before-tool-use',
      'pre_mcp_tool_use',
    ],
    // Run before auth/onboarding. This protection is machine-global and must
    // not vary with pluginUse, authentication, or project materialization.
    priority: -100,
    run: (ctx) => (
      ctx.input.tool && isManagedOneMcpAgentTool(ctx.host, ctx.input.tool.rawName)
        ? deny(ONE_MCP_AGENT_TOOL_DENY_REASON, { denyId: 'one-mcp-tool-gate', denyTarget: ctx.input.tool.rawName })
        : noop()
    ),
  },
];
