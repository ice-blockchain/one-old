// Exact model-facing identities for the two public traffic-one-mcp tools.
//
// Runtime sync/report code calls the public endpoint directly and never passes
// through a host tool hook. Any matching hook invocation is therefore
// agent-originated and must be denied, independent of project opt-in state.

import {
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_MANAGED_TOOLS,
  ONE_MCP_SERVER_NAME,
} from '../config/one-mcp';
import type { HostId } from '../core/types';

const MANAGED_TOOLS = new Set<string>(ONE_MCP_MANAGED_TOOLS);

export const ONE_MCP_AGENT_TOOL_DENY_REASON =
  `Traffic One manages ${ONE_MCP_SERVER_NAME} configuration sync and anonymous reporting in its validated hook runtime. `
  + `Direct AI-agent calls to ${ONE_MCP_MANAGED_TOOLS.join(' and ')} are blocked.`;

export function isManagedOneMcpPair(serverName: string, toolName: string): boolean {
  return canonicalOneMcpServerHint(serverName) === ONE_MCP_SERVER_NAME && MANAGED_TOOLS.has(toolName.trim());
}

export function canonicalOneMcpServerHint(value: string): string {
  const hint = value.trim();
  if (hint === ONE_MCP_SERVER_NAME) return ONE_MCP_SERVER_NAME;
  if (hint.replace(/\/$/, '') === DEFAULT_PUBLIC_ENDPOINT.replace(/\/$/, '')) return ONE_MCP_SERVER_NAME;
  return hint;
}

export function isManagedOneMcpAgentTool(host: HostId, rawName: string): boolean {
  const name = rawName.trim();
  if (!name) return false;

  for (const tool of ONE_MCP_MANAGED_TOOLS) {
    switch (host) {
      case 'claude':
      case 'codex':
        if (name === `mcp__${ONE_MCP_SERVER_NAME}__${tool}`) return true;
        break;
      case 'cursor':
      case 'windsurf':
        if (name === `${ONE_MCP_SERVER_NAME}.${tool}`) return true;
        break;
      case 'copilot':
        if (name === `${ONE_MCP_SERVER_NAME}/${tool}`) return true;
        break;
      case 'opencode':
      case 'kilo':
        if (name === `${ONE_MCP_SERVER_NAME}_${tool}`) return true;
        break;
      default:
        break;
    }
  }
  return false;
}
