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
import {
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_CODEX_REGISTRATION_LOCK_RETRY_MS,
  ONE_MCP_CODEX_REGISTRATION_LOCK_STALE_MS,
  ONE_MCP_CODEX_REGISTRATION_LOCK_TIMEOUT_MS,
  ONE_MCP_CODEX_STARTUP_TIMEOUT_SEC,
  ONE_MCP_CODEX_TOOL_TIMEOUT_SEC,
  ONE_MCP_MANAGED_TOOLS,
  ONE_MCP_SERVER_NAME,
} from '../config/one-mcp';

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
  if (!root) return discoverCodexPluginRoot(env);
  const m = /^(.*)[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\][^/\\]+$/.exec(root);
  if (m && m[1] && m[2] && m[3]) return path.join(m[1], 'local-marketplaces', m[2], 'plugins', m[3]);
  return root;
}

function hasOpenCodeMcpShim(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, OPENCODE_MCP_SHIM_PATH));
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function discoverCodexPluginRoot(env: NodeJS.ProcessEnv): string | null {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(os.homedir(), '.codex');
  const marketplaces = path.join(home, 'local-marketplaces');
  for (const marketplace of listDirs(marketplaces)) {
    const candidate = path.join(marketplaces, marketplace, 'plugins', 'traffic-one');
    if (hasOpenCodeMcpShim(candidate)) return candidate;
  }

  const cacheRoot = path.join(home, 'plugins', 'cache');
  for (const marketplace of listDirs(cacheRoot)) {
    const pluginCache = path.join(cacheRoot, marketplace, 'traffic-one');
    const versions = listDirs(pluginCache).reverse();
    for (const version of versions) {
      const cacheCandidate = path.join(pluginCache, version);
      const stableCandidate = path.join(home, 'local-marketplaces', marketplace, 'plugins', 'traffic-one');
      if (hasOpenCodeMcpShim(stableCandidate)) return stableCandidate;
      if (hasOpenCodeMcpShim(cacheCandidate)) return cacheCandidate;
    }
  }
  return null;
}

const CODEX_MCP_MANAGED_BEGIN = '# >>> traffic-one managed opencode-worker MCP';
const CODEX_MCP_MANAGED_END = '# <<< traffic-one managed opencode-worker MCP';

// Launch through the exact Node executable already running Traffic One. Codex
// Desktop does not necessarily inherit a login-shell PATH, while process.execPath
// is absolute and works on Windows without a POSIX shell. JSON string encoding is
// valid TOML basic-string encoding for paths, backslashes, spaces, and quotes.
export function codexMcpServerBlock(
  serverPath: string,
  nodePath: string = process.execPath,
): string {
  return [
    '',
    CODEX_MCP_MANAGED_BEGIN,
    `[mcp_servers.${OPENCODE_MCP_SERVER_KEY}]`,
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(serverPath)}]`,
    'startup_timeout_sec = 120',
    CODEX_MCP_MANAGED_END,
    '',
  ].join('\n');
}

// Exact unmarked block emitted by the first cross-platform cutover. It is kept
// only as an ownership-safe migration fingerprint.
function bareNodeCodexMcpServerBlock(serverPath: string): string {
  return [
    '',
    `[mcp_servers.${OPENCODE_MCP_SERVER_KEY}]`,
    'command = "node"',
    `args = [${JSON.stringify(serverPath)}]`,
    'startup_timeout_sec = 120',
    '',
  ].join('\n');
}

// Exact block emitted before the cross-platform Node cutover. It is never used
// for new configuration; matching the whole byte sequence lets us migrate our
// own old entry without rewriting a same-name user-owned MCP declaration.
function legacyCodexMcpServerBlock(serverPath: string): string {
  const shellQuoted = `'${serverPath.replace(/'/g, `'\\''`)}'`;
  const tomlEscaped = `exec node ${shellQuoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '',
    `[mcp_servers.${OPENCODE_MCP_SERVER_KEY}]`,
    'command = "sh"',
    `args = ["-lc", "${tomlEscaped}"]`,
    'startup_timeout_sec = 120',
    '',
  ].join('\n');
}

interface ManagedCodexMcpBlock {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function managedCodexMcpBlock(config: string): ManagedCodexMcpBlock | null {
  const startNeedle = `\n${CODEX_MCP_MANAGED_BEGIN}\n`;
  const endNeedle = `${CODEX_MCP_MANAGED_END}\n`;
  const start = config.indexOf(startNeedle);
  if (start < 0 || config.indexOf(startNeedle, start + startNeedle.length) >= 0) return null;
  const endMarker = config.indexOf(endNeedle, start + startNeedle.length);
  if (endMarker < 0 || config.indexOf(endNeedle, endMarker + endNeedle.length) >= 0) return null;
  const end = endMarker + endNeedle.length;
  return { start, end, content: config.slice(start, end) };
}

// Public traffic-one-mcp registration is deliberately inert: hook-owned HTTP
// clients perform sync/reporting, while Codex sees neither public tool. Keep the
// block append-only and byte-preserving like the proven opencode-worker path.
export function codexOneMcpServerBlock(endpoint: string = DEFAULT_PUBLIC_ENDPOINT): string {
  return [
    '',
    '# >>> traffic-one managed public MCP (disabled)',
    `[mcp_servers.${ONE_MCP_SERVER_NAME}]`,
    `url = ${JSON.stringify(endpoint)}`,
    'enabled = false',
    `disabled_tools = ${JSON.stringify([...ONE_MCP_MANAGED_TOOLS])}`,
    `startup_timeout_sec = ${ONE_MCP_CODEX_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${ONE_MCP_CODEX_TOOL_TIMEOUT_SEC}`,
    '# <<< traffic-one managed public MCP (disabled)',
    '',
  ].join('\n');
}

function stripTomlComment(line: string): string {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] || '';
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, index);
  }
  return line;
}

function tomlKeySegment(value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?:${escaped}|"${escaped}"|'${escaped}')`;
}

// Preserve any valid same-name user declaration, not only the common child
// table. Codex accepts parent-table assignments, root dotted assignments,
// inline tables, and quoted key segments; appending our child table over any of
// those would redefine the key and invalidate the entire config.
function hasCodexMcpServerConfig(config: string, serverName: string): boolean {
  const namespace = tomlKeySegment('mcp_servers');
  const server = tomlKeySegment(serverName);
  const exactParentTable = new RegExp(`^\\[\\s*${namespace}\\s*\\]$`);
  const anyTable = /^\[\[?.*\]\]?$/;
  const serverTable = new RegExp(`^\\[\\[?\\s*${namespace}\\s*\\.\\s*${server}(?:\\s*\\.|\\s*\\]\\]?)`);
  const dottedAssignment = new RegExp(`^${namespace}\\s*\\.\\s*${server}(?:\\s*\\.|\\s*=)`);
  const inlineNamespace = new RegExp(`^${namespace}\\s*=\\s*\\{[^}]*${server}\\s*=`);
  const parentAssignment = new RegExp(`^${server}(?:\\s*\\.|\\s*=)`);
  let insideParent = false;

  for (const rawLine of config.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (serverTable.test(line) || dottedAssignment.test(line) || inlineNamespace.test(line)) return true;
    if (exactParentTable.test(line)) {
      insideParent = true;
      continue;
    }
    if (anyTable.test(line)) insideParent = false;
    if (insideParent && parentAssignment.test(line)) return true;
    // Deliberately conservative for uncommon quoted/escaped layouts: skipping
    // our append is safer than risking a duplicate TOML definition.
    if (line.includes('mcp_servers') && line.includes(serverName)
      && (line.startsWith('[') || line.includes('='))) return true;
  }
  return false;
}

interface CodexMcpLock {
  readonly dirPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

interface CodexMcpLockOwner extends CodexMcpLock {
  readonly pid: number;
  readonly createdAt: number;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // The deadline still bounds retries if SharedArrayBuffer is unavailable.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function observedCodexMcpLock(lockPath: string): CodexMcpLockOwner | null {
  try {
    const entries = fs.readdirSync(lockPath).filter((name) => /^owner-[a-f0-9]+\.json$/.test(name));
    if (entries.length !== 1) return null;
    const ownerName = entries[0] as string;
    const ownerPath = path.join(lockPath, ownerName);
    const raw = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    const token = typeof raw.token === 'string' ? raw.token : '';
    const pid = typeof raw.pid === 'number' ? raw.pid : Number.NaN;
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Number.NaN;
    if (!token || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAt)
      || ownerName !== `owner-${token}.json`) return null;
    return { dirPath: lockPath, ownerPath, token, pid, createdAt };
  } catch {
    return null;
  }
}

// Remove only the exact owner file observed. A replacement lock has a distinct
// token, so stale recovery cannot unlink a fresh owner's directory.
function reapObservedCodexMcpLock(lock: CodexMcpLockOwner): boolean {
  try { fs.unlinkSync(lock.ownerPath); } catch { return false; }
  try {
    fs.rmdirSync(lock.dirPath);
    return true;
  } catch {
    return false;
  }
}

function reapAbandonedEmptyCodexMcpLock(lockPath: string, now: number): boolean {
  try {
    if (fs.readdirSync(lockPath).length !== 0) return false;
    if (now - fs.statSync(lockPath).mtimeMs <= ONE_MCP_CODEX_REGISTRATION_LOCK_STALE_MS) return false;
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    // A legacy publisher or another recovery contender won the race.
    return false;
  }
}

function acquireCodexMcpLock(configPath: string): CodexMcpLock {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${configPath}.traffic-one-mcp.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + ONE_MCP_CODEX_REGISTRATION_LOCK_TIMEOUT_MS;
  fs.mkdirSync(pendingPath, { mode: 0o700 });
  try {
    fs.writeFileSync(
      path.join(pendingPath, ownerName),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  let acquired = false;
  try {
    while (true) {
      try {
        fs.renameSync(pendingPath, lockPath);
        acquired = true;
        return { dirPath: lockPath, ownerPath: path.join(lockPath, ownerName), token };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const contended = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR'
          || (code === 'EPERM' && fs.existsSync(lockPath));
        if (!contended) throw error;
        const now = Date.now();
        const owner = observedCodexMcpLock(lockPath);
        if (owner && now - owner.createdAt > ONE_MCP_CODEX_REGISTRATION_LOCK_STALE_MS
          && !processAlive(owner.pid) && reapObservedCodexMcpLock(owner)) continue;
        if (!owner && reapAbandonedEmptyCodexMcpLock(lockPath, now)) continue;
        if (now >= deadline) throw new Error('Traffic One Codex MCP registration lock timed out.');
        sleepSync(Math.min(ONE_MCP_CODEX_REGISTRATION_LOCK_RETRY_MS, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function releaseCodexMcpLock(lock: CodexMcpLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    const raw = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8')) as Record<string, unknown>;
    if (raw.token !== lock.token) return;
    // Vacate the canonical pathname atomically. A crash during best-effort
    // cleanup can strand only this token-addressed tombstone, never a lock that
    // blocks future registration or uninstall attempts.
    fs.renameSync(lock.dirPath, releasedPath);
  } catch {
    // Never remove a lock whose ownership cannot be proven.
    return;
  }
  try { fs.rmSync(releasedPath, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function withCodexMcpLock<T>(configPath: string, body: () => T): T {
  const lock = acquireCodexMcpLock(configPath);
  try {
    return body();
  } finally {
    releaseCodexMcpLock(lock);
  }
}

export type CodexMcpRegistration =
  | 'registered'
  | 'already-present'
  | 'skipped-not-codex'
  | 'skipped-no-root'
  | 'failed';

export type CodexOneMcpRemoval = 'removed' | 'absent' | 'modified' | 'failed';

export function ensureCodexMcpServerRegistered(
  env: NodeJS.ProcessEnv = process.env,
  nodePath: string = process.execPath,
): CodexMcpRegistration {
  try {
    if (detectHost(env) !== 'codex') return 'skipped-not-codex';
    const root = codexStablePluginRoot(env);
    if (!root) return 'skipped-no-root';
    const cfgPath = codexConfigPath(env);
    const serverPath = path.join(root, OPENCODE_MCP_SHIM_PATH);
    return withCodexMcpLock(cfgPath, () => {
      // Read only after acquiring the shared config lock. The public MCP
      // registration uses the same lock, so a cold append cannot be lost when
      // this transaction migrates an older whole-file snapshot.
      const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
      const expectedBlock = codexMcpServerBlock(serverPath, nodePath);
      const managedBlock = managedCodexMcpBlock(existing);
      if (managedBlock) {
        if (managedBlock.content === expectedBlock) return 'already-present';
        fs.writeFileSync(
          cfgPath,
          `${existing.slice(0, managedBlock.start)}${expectedBlock}${existing.slice(managedBlock.end)}`,
          'utf8',
        );
        return 'registered';
      }
      // Migrate only byte-exact blocks Traffic One emitted before ownership
      // markers. An arbitrary same-name declaration remains user-owned.
      for (const priorBlock of [
        legacyCodexMcpServerBlock(serverPath),
        bareNodeCodexMcpServerBlock(serverPath),
      ]) {
        if (!existing.includes(priorBlock)) continue;
        fs.writeFileSync(cfgPath, existing.replace(priorBlock, expectedBlock), 'utf8');
        return 'registered';
      }
      if (hasCodexMcpServerConfig(existing, OPENCODE_MCP_SERVER_KEY)) return 'already-present';
      fs.appendFileSync(cfgPath, expectedBlock);
      return 'registered';
    });
  } catch {
    return 'failed';
  }
}

export function ensureCodexOneMcpServerRegistered(env: NodeJS.ProcessEnv = process.env): CodexMcpRegistration {
  try {
    if (detectHost(env) !== 'codex') return 'skipped-not-codex';
    const cfgPath = codexConfigPath(env);
    return withCodexMcpLock(cfgPath, () => {
      // Re-read after acquiring the cross-process lock. Concurrent parent and
      // subagent SessionStart hooks must never both append the same TOML table.
      const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
      // Any same-name declaration is user-owned unless it is our own appended
      // block. In both cases, leave every byte untouched and rely on the
      // universal hook deny if the user independently enabled that server.
      if (hasCodexMcpServerConfig(existing, ONE_MCP_SERVER_NAME)) return 'already-present';
      fs.appendFileSync(cfgPath, codexOneMcpServerBlock(DEFAULT_PUBLIC_ENDPOINT));
      return 'registered';
    });
  } catch {
    return 'failed';
  }
}

// Codex currently removes the plugin bundle itself but exposes no plugin
// uninstall lifecycle hook for cleaning machine-global config. The explicit
// host runner calls this conservative remover: only the byte-exact block this
// plugin would generate for the configured endpoint is removed. A user edit,
// duplicate block, or same-name unmarked table is left untouched.
export function removeCodexOneMcpServerRegistration(
  env: NodeJS.ProcessEnv = process.env,
): CodexOneMcpRemoval {
  try {
    const cfgPath = codexConfigPath(env);
    return withCodexMcpLock(cfgPath, () => {
      if (!fs.existsSync(cfgPath)) return 'absent';
      const existing = fs.readFileSync(cfgPath, 'utf8');
      const block = codexOneMcpServerBlock(DEFAULT_PUBLIC_ENDPOINT);
      const first = existing.indexOf(block);
      if (first < 0) {
        return existing.includes('# >>> traffic-one managed public MCP (disabled)')
          || existing.includes('# <<< traffic-one managed public MCP (disabled)')
          ? 'modified'
          : 'absent';
      }
      if (existing.indexOf(block, first + block.length) >= 0) return 'modified';
      const next = `${existing.slice(0, first)}${existing.slice(first + block.length)}`;
      const stat = fs.statSync(cfgPath);
      const tmp = `${cfgPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: stat.mode & 0o777 });
        // Do not overwrite a user/Codex edit that landed after our snapshot.
        if (fs.readFileSync(cfgPath, 'utf8') !== existing) return 'modified';
        fs.renameSync(tmp, cfgPath);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      }
      return 'removed';
    });
  } catch {
    return 'failed';
  }
}
