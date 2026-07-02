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
// Non-blocking poll of a background run (decoupled from the call so long opencode
// runs survive the host's ~120s tool-call timeout).
export const OPENCODE_MCP_TOOL_STATUS = 'opencode_status';

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

// The `.mcp.json` stdio entry for the opencode-worker server. We launch via `sh -c`
// so the shell can RESOLVE where the server script lives, because hosts disagree:
//   - Claude/Codex set a *_PLUGIN_ROOT env var → `pluginRootExpr` resolves to the
//     real plugin dir, so we exec `<root>/scripts/opencode-mcp.cjs` directly.
//   - Cursor launches plugin MCP servers with a BARE env (no *_PLUGIN_ROOT) and
//     CWD=$HOME, so `pluginRootExpr` collapses to `.` → `$HOME/scripts/...` which
//     does not exist (observed: MODULE_NOT_FOUND → opencode-worker dead → delegation
//     degrades → role-gate "Couldn't start"). When the resolved path isn't a file we
//     fall back to the VERSION-STABLE shim at `<state-home>/bin/opencode-mcp.cjs`
//     (RUNNER_SHIMS); that shim self-locates the live plugin from the host plugin
//     caches/local dirs with no env and no useful CWD — proven to resolve bare.
export function openCodeMcpServerEntry(pluginRootExpr: string): McpStdioServerEntry {
  // JS-interpolated: the host-aware plugin path (Claude/Codex). The other ${…}/$…
  // tokens below are PLAIN string constants → emitted verbatim for the shell to expand
  // at launch (mirrors stableBinDir(): XDG_STATE_HOME/traffic-one, else $HOME/.traffic-one).
  const direct = `${pluginRootExpr}/${OPENCODE_MCP_SHIM_PATH}`;
  const stateHome = '${XDG_STATE_HOME:+$XDG_STATE_HOME/traffic-one}';
  const binFallback = '${S:-$HOME/.traffic-one}/bin/opencode-mcp.cjs';
  return {
    command: 'sh',
    args: ['-c', `P="${direct}"; if [ -f "$P" ]; then exec node "$P"; fi; S="${stateHome}"; B="${binFallback}"; if [ -f "$B" ]; then exec node "$B"; fi; echo "traffic-one opencode-worker MCP: server script not found at $P or $B. Run Traffic One onboarding or reload the window after sessionStart so ~/.traffic-one/bin shims exist." >&2; exit 1`],
  };
}
