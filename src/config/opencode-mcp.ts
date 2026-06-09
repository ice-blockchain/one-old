// src/config/opencode-mcp.ts
// THE single source for the bundled `opencode-worker` MCP server: its registry
// key/name, the tool names it exposes, the MCP protocol version it speaks, and
// the SHAPE of its `.mcp.json` stdio entry. Kept dependency-free (pure constants
// + one factory) so both the runtime server (src/runners/opencode-mcp/**) and
// the manifest generator (gen/emit/manifests → emitMcp) read the same names.
//
// Why stdio + a host-launched subprocess: the server runs OUTSIDE the per-tool
// sandbox (full network + git), so it can run OpenCode where the orchestrator's
// own shell cannot (notably Codex's network-off, .git-locked sandbox). It is a
// thin shim that spawns the shipped scripts/opencode-runner.cjs — all delegation
// logic (worktree isolation, digests, attempt markers) stays in that one runner.

// Registry key in `.mcp.json` AND the serverInfo.name reported on `initialize`.
export const OPENCODE_MCP_SERVER_KEY = 'opencode-worker';

// serverInfo.version — informational; bumped independently of the plugin.
export const OPENCODE_MCP_SERVER_VERSION = '1.0.0';

// Default MCP protocol version. The server echoes the client's requested version
// when present (max compatibility) and falls back to this otherwise.
export const OPENCODE_MCP_PROTOCOL_VERSION = '2025-06-18';

// Tool names exposed over MCP. They mirror the runner's two CLI modes:
//   opencode_delegate            → opencode-runner.cjs --role <r> --task-file <f>
//   opencode_delegate_from_plan  → opencode-runner.cjs --from-plan
export const OPENCODE_MCP_TOOL_DELEGATE = 'opencode_delegate';
export const OPENCODE_MCP_TOOL_DELEGATE_FROM_PLAN = 'opencode_delegate_from_plan';

// The server shim the host launches (relative to the resolved plugin root). The
// build writes this shim (see SHIMS in build-runtime.ts); it forwards to the
// compiled runners/opencode-mcp/index.js entry.
export const OPENCODE_MCP_SHIM_PATH = 'scripts/opencode-mcp.cjs';

// Env var that overrides where the server finds opencode-runner.cjs. Defaults to
// a __dirname-relative resolution at runtime; tests point it at a stub runner.
export const OPENCODE_RUNNER_OVERRIDE_ENV = 'TRAFFIC_ONE_OPENCODE_RUNNER';

export interface McpStdioServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

// The `.mcp.json` stdio entry for the opencode-worker server. `pluginRootExpr` is
// injected by the generator (the same `${TRAFFIC_ONE_PLUGIN_ROOT:-…}` shell chain
// the hooks use) so a SINGLE shared `.mcp.json` resolves on Claude/Codex/Cursor.
// We launch via `sh -c` precisely so that shell chain expands — a bare
// command/args pair is exec'd without a shell and would not expand `${…}`.
export function openCodeMcpServerEntry(pluginRootExpr: string): McpStdioServerEntry {
  return {
    command: 'sh',
    args: ['-c', `exec node "${pluginRootExpr}/${OPENCODE_MCP_SHIM_PATH}"`],
  };
}
