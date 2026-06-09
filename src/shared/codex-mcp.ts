// src/shared/codex-mcp.ts
// Codex-only: register the bundled `opencode-worker` MCP server in the user's
// ~/.codex/config.toml. Codex does NOT expose MCP servers declared in a plugin's
// bundled .mcp.json (Claude Code does) — it only launches servers from its own
// config.toml [mcp_servers]. So on Codex we self-register, from the unsandboxed
// onboarding-toolchain runner (the same context that npm-installs tools to
// ~/.traffic-one — i.e. it can write outside the workspace + use the network).
// Idempotent + best-effort; never throws.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectHost } from './host';
import { OPENCODE_MCP_SERVER_KEY, OPENCODE_MCP_SHIM_PATH } from '../config/opencode-mcp';

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

// CODEX_PLUGIN_ROOT is the per-version cache (…/plugins/cache/<mkt>/<plugin>/<ver>),
// which 404s after the next plugin update. The local-marketplace SOURCE
// (…/local-marketplaces/<mkt>/plugins/<plugin>) is rewritten in place on every
// publish, so an entry pointing there survives version bumps. Derive it from the
// cache path; fall back to the cache root if the layout doesn't match.
export function codexStablePluginRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = (env.CODEX_PLUGIN_ROOT || env.TRAFFIC_ONE_PLUGIN_ROOT || '').trim();
  if (!root) return null;
  const m = /^(.*)[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\][^/\\]+$/.exec(root);
  if (m && m[1] && m[2] && m[3]) return path.join(m[1], 'local-marketplaces', m[2], 'plugins', m[3]);
  return root;
}

// The config.toml block. `sh -lc … exec node` gives the server (and its git/
// opencode child processes) the login-shell PATH; `exec` keeps stdio = the server.
export function codexMcpServerBlock(serverPath: string): string {
  return [
    '',
    `[mcp_servers.${OPENCODE_MCP_SERVER_KEY}]`,
    'command = "sh"',
    `args = ["-lc", "exec node \\"${serverPath}\\""]`,
    'startup_timeout_sec = 120',
    '',
  ].join('\n');
}

export type CodexMcpRegistration =
  | 'registered'
  | 'already-present'
  | 'skipped-not-codex'
  | 'skipped-no-root'
  | 'failed';

export function ensureCodexMcpServerRegistered(env: NodeJS.ProcessEnv = process.env): CodexMcpRegistration {
  try {
    if (detectHost(env) !== 'codex') return 'skipped-not-codex';
    const root = codexStablePluginRoot(env);
    if (!root) return 'skipped-no-root';
    const cfgPath = codexConfigPath(env);
    const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
    // Idempotent: any existing [mcp_servers.opencode-worker] section → leave it.
    if (existing.includes(`[mcp_servers.${OPENCODE_MCP_SERVER_KEY}]`)) return 'already-present';
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.appendFileSync(cfgPath, codexMcpServerBlock(path.join(root, OPENCODE_MCP_SHIM_PATH)));
    return 'registered';
  } catch {
    return 'failed';
  }
}
