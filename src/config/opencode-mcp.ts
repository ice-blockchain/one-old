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

interface McpStdioServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

// The `.mcp.json` stdio entry for the opencode-worker server. A small inline Node
// bootstrap resolves where the server script lives without depending on `sh` or
// POSIX parameter expansion, because hosts disagree:
//   - Claude/Codex set a *_PLUGIN_ROOT env var → the first populated key resolves
//     to the real plugin dir, so we launch `<root>/scripts/opencode-mcp.cjs` directly.
//   - Cursor launches plugin MCP servers with a BARE env (no *_PLUGIN_ROOT) and
//     CWD=$HOME, so the cwd candidate points at `$HOME/scripts/...`, which
//     does not exist (observed: MODULE_NOT_FOUND → opencode-worker dead → delegation
//     degrades → role-gate "Couldn't start"). When the resolved path isn't a file we
//     fall back to the VERSION-STABLE shim at `<state-home>/bin/opencode-mcp.cjs`
//     (RUNNER_SHIMS); that shim self-locates the live plugin from the host plugin
//     caches/local dirs with no env and no useful CWD — proven to resolve bare.
export function openCodeMcpServerEntry(pluginRootEnvKeys: readonly string[]): McpStdioServerEntry {
  if (pluginRootEnvKeys.length === 0 || pluginRootEnvKeys.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key))) {
    throw new Error('opencode MCP bootstrap requires safe plugin-root environment keys');
  }
  const rootKeys = pluginRootEnvKeys.map((key) => `'${key}'`).join(',');
  const launcher = [
    "const fs=require('fs'),os=require('os'),p=require('path'),e=process.env;",
    // Only a HOST-provided root may be used directly. Falling back to process.cwd()
    // let any directory that happens to contain scripts/opencode-mcp.cjs pose as the
    // plugin (Cursor launches MCP servers with no *_PLUGIN_ROOT and PWD=/), which is
    // how a wrong tree got to serve delegation. With no host root we go straight to the
    // stable shim, which resolves the NEWEST installed version across all hosts.
    `const envRoot=[${rootKeys}].map(k=>e[k]).find(Boolean);`,
    'const root=envRoot?p.resolve(envRoot):\'\';',
    `const candidate=root?p.join(root,'${OPENCODE_MCP_SHIM_PATH}'):'';`,
    "const isPlugin=(r)=>{try{return JSON.parse(fs.readFileSync(p.join(r,'package.json'),'utf8')).name==='traffic-one';}catch{return false;}};",
    "const direct=candidate&&fs.existsSync(candidate)&&isPlugin(root)?candidate:'';",
    "const state=e.XDG_STATE_HOME?p.join(e.XDG_STATE_HOME,'traffic-one'):p.join(e.HOME||os.homedir(),'.traffic-one');",
    "const fallback=p.join(state,'bin','opencode-mcp.cjs');",
    "const target=direct||(fs.existsSync(fallback)?fallback:'');",
    "if(!target){console.error('traffic-one opencode-worker MCP: server script not found in plugin roots or stable bin. Run Traffic One onboarding or reload the window after sessionStart so the stable shim exists.');process.exit(1);}",
    "if(direct)e.TRAFFIC_ONE_PLUGIN_ROOT=p.dirname(p.dirname(direct));",
    'require(target);',
  ].join('');
  return {
    command: 'node',
    args: ['-e', launcher],
  };
}
