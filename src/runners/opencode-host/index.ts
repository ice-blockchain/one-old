// src/runners/opencode-host/index.ts
// Install/doctor/uninstall the user-level OpenCode wrapper that bridges
// OpenCode's in-process JS plugin hooks to Traffic One's compiled runtime.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  OPENCODE_HOOK_CHAT_MESSAGE,
  OPENCODE_HOOK_SYSTEM_TRANSFORM,
  OPENCODE_HOOK_TOOL_AFTER,
  OPENCODE_HOOK_TOOL_BEFORE,
  OPENCODE_HOST_GLOBAL_CONFIG_DIR_REL,
  OPENCODE_HOST_GLOBAL_CONFIG_DEFAULT_FILE,
  OPENCODE_HOST_GLOBAL_CONFIG_FILES,
  OPENCODE_HOST_GLOBAL_PLUGIN_FILE,
  OPENCODE_HOST_GLOBAL_PLUGIN_ID,
  OPENCODE_HOST_GLOBAL_PLUGINS_REL,
  OPENCODE_HOST_PACKAGE,
  OPENCODE_HOST_PROJECT_MARKER_REL,
  OPENCODE_HOST_TARGET_VERSION,
} from '../../config/opencode-host';
import { ONE_MCP_MANAGED_TOOLS, ONE_MCP_SERVER_NAME, oneMcpRegistrationEnabled, publicEndpoint } from '../../config/one-mcp';
import { ONE_MCP_AGENT_TOOL_DENY_REASON } from '../../shared/one-mcp-agent-tools';

export interface RunnerOutput { code: number; stdout: string; stderr?: string; }

const OWNER_NAME = 'traffic-one';
const OWNER_RE = /TRAFFIC_ONE_WRAPPER_OWNER\s*=\s*(\{[^\n]+});/;

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'opencode');
  return path.join(homeDir(env), OPENCODE_HOST_GLOBAL_CONFIG_DIR_REL);
}

export function opencodeGlobalPluginPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opencodeConfigDir(env), OPENCODE_HOST_GLOBAL_PLUGINS_REL, OPENCODE_HOST_GLOBAL_PLUGIN_FILE);
}

export function opencodeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = opencodeConfigDir(env);
  for (const file of OPENCODE_HOST_GLOBAL_CONFIG_FILES) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, OPENCODE_HOST_GLOBAL_CONFIG_DEFAULT_FILE);
}

function opencodeGlobalPluginSpecifier(env: NodeJS.ProcessEnv = process.env): string {
  return pathToFileURL(opencodeGlobalPluginPath(env)).href;
}

function runtimePluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..', '..');
}

interface OwnerRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetOpenCode: string;
  packageName: string;
  installedAt?: string;
}

interface ProjectActivationRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetOpenCode: string;
  packageName: string;
  enabled?: boolean;
  enabledAt?: string;
  disabledAt?: string;
}

function ownerRecord(pluginRoot: string): OwnerRecord {
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetOpenCode: OPENCODE_HOST_TARGET_VERSION,
    packageName: OPENCODE_HOST_PACKAGE,
    installedAt: new Date().toISOString(),
  };
}

function projectActivationRecord(pluginRoot: string): ProjectActivationRecord {
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetOpenCode: OPENCODE_HOST_TARGET_VERSION,
    packageName: OPENCODE_HOST_PACKAGE,
    enabled: true,
    enabledAt: new Date().toISOString(),
  };
}

function projectDisabledRecord(pluginRoot: string): ProjectActivationRecord {
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetOpenCode: OPENCODE_HOST_TARGET_VERSION,
    packageName: OPENCODE_HOST_PACKAGE,
    enabled: false,
    disabledAt: new Date().toISOString(),
  };
}

export function readOwner(filePath: string): OwnerRecord | null {
  try {
    const body = fs.readFileSync(filePath, 'utf8');
    const match = body.match(OWNER_RE);
    if (!match || !match[1]) return null;
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.owner !== OWNER_NAME || rec.version !== 1 || typeof rec.pluginRoot !== 'string') return null;
    return {
      owner: OWNER_NAME,
      version: 1,
      pluginRoot: rec.pluginRoot,
      targetOpenCode: typeof rec.targetOpenCode === 'string' ? rec.targetOpenCode : '',
      packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
      ...(typeof rec.installedAt === 'string' ? { installedAt: rec.installedAt } : {}),
    };
  } catch {
    return null;
  }
}

export function readProjectActivation(filePath: string): ProjectActivationRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.owner !== OWNER_NAME || rec.version !== 1 || typeof rec.pluginRoot !== 'string') return null;
    return {
      owner: OWNER_NAME,
      version: 1,
      pluginRoot: rec.pluginRoot,
      targetOpenCode: typeof rec.targetOpenCode === 'string' ? rec.targetOpenCode : '',
      packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
      ...(typeof rec.enabled === 'boolean' ? { enabled: rec.enabled } : {}),
      ...(typeof rec.enabledAt === 'string' ? { enabledAt: rec.enabledAt } : {}),
      ...(typeof rec.disabledAt === 'string' ? { disabledAt: rec.disabledAt } : {}),
    };
  } catch {
    return null;
  }
}

export function opencodeProjectMarkerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), OPENCODE_HOST_PROJECT_MARKER_REL);
}

function explicitCwdArg(args: readonly string[]): string | null {
  const eq = args.find((arg) => arg.startsWith('--cwd='));
  if (eq) return eq.slice('--cwd='.length);
  const index = args.indexOf('--cwd');
  if (index >= 0 && typeof args[index + 1] === 'string') return args[index + 1] as string;
  return null;
}

function projectRootFromArgs(env: NodeJS.ProcessEnv, args: readonly string[]): string {
  return path.resolve(explicitCwdArg(args) || env.PWD || process.cwd());
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

type JsonObject = Record<string, unknown>;
type ConfigUpdate = { ok: true; path: string; spec: string; changed: boolean } | { ok: false; path: string; spec: string; error: string };

function stripJsonc(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] || '';
    const next = input[i + 1] || '';
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function removeTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] || '';
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (/\s/.test(input[j] || '')) j += 1;
      if (input[j] === '}' || input[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseJsoncObject(file: string): JsonObject | null {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(removeTrailingCommas(stripJsonc(raw))) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
}

function normalizePluginSpec(spec: string, configFile: string): string {
  try {
    if (spec.startsWith('file://')) return path.resolve(fileURLToPath(spec));
  } catch {
    return spec;
  }
  if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return path.resolve(spec);
  if (spec.startsWith('./') || spec.startsWith('../')) return path.resolve(path.dirname(configFile), spec);
  return spec;
}

function pluginEntrySpec(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return null;
}

function samePluginEntry(entry: unknown, spec: string, configFile: string): boolean {
  const value = pluginEntrySpec(entry);
  if (!value) return false;
  return normalizePluginSpec(value, configFile) === normalizePluginSpec(spec, configFile);
}

function writeConfig(file: string, config: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function jsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function managedPermissionKey(tool: string): string {
  return `${ONE_MCP_SERVER_NAME}_${tool}`;
}

function ensureOneMcpDisabled(
  config: JsonObject,
  endpoint: string,
): { ok: true; changed: boolean } | { ok: false; error: string } {
  let changed = false;
  if (config.mcp === undefined) {
    config.mcp = {};
    changed = true;
  }
  const mcp = jsonObject(config.mcp);
  if (!mcp) return { ok: false, error: 'OpenCode global config `mcp` must be an object.' };
  // Same-name entries may be user-owned. Never overwrite them; the wrapper's
  // exact pre-tool deny remains authoritative even if a user enables one.
  if (mcp[ONE_MCP_SERVER_NAME] === undefined) {
    mcp[ONE_MCP_SERVER_NAME] = {
      type: 'remote',
      url: endpoint,
      enabled: false,
    };
    changed = true;
  }

  if (config.permission === undefined) {
    config.permission = {};
    changed = true;
  }
  const permission = jsonObject(config.permission);
  if (!permission) return { ok: false, error: 'OpenCode global config `permission` must be an object.' };
  for (const tool of ONE_MCP_MANAGED_TOOLS) {
    const key = managedPermissionKey(tool);
    if (permission[key] === undefined) {
      permission[key] = 'deny';
      changed = true;
    }
  }
  return { ok: true, changed };
}

function oneMcpDisabledStatus(config: JsonObject): string | null {
  const mcp = jsonObject(config.mcp);
  const entry = mcp ? jsonObject(mcp[ONE_MCP_SERVER_NAME]) : null;
  if (!entry) return `OpenCode global config is missing mcp.${ONE_MCP_SERVER_NAME}.`;
  if (entry.enabled !== false) return `OpenCode mcp.${ONE_MCP_SERVER_NAME} is user-owned or enabled; Traffic One leaves it untouched and relies on the universal tool deny.`;
  const permission = jsonObject(config.permission);
  for (const tool of ONE_MCP_MANAGED_TOOLS) {
    if (permission?.[managedPermissionKey(tool)] !== 'deny') {
      return `OpenCode global config is missing deny permission for ${managedPermissionKey(tool)}.`;
    }
  }
  return null;
}

function ensureGlobalConfigPlugin(
  env: NodeJS.ProcessEnv = process.env,
  registrationFeatureEnabled?: boolean,
): ConfigUpdate {
  const file = opencodeGlobalConfigPath(env);
  const spec = opencodeGlobalPluginSpecifier(env);
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, spec, error: `Could not parse OpenCode global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, spec, error: 'OpenCode global config must be a JSON object.' };
  let changed = false;
  if (!('$schema' in config)) { config.$schema = 'https://opencode.ai/config.json'; changed = true; }
  if (config.plugin === undefined) { config.plugin = []; changed = true; }
  if (!Array.isArray(config.plugin)) return { ok: false, path: file, spec, error: 'OpenCode global config `plugin` must be an array.' };
  if (!config.plugin.some((entry) => samePluginEntry(entry, spec, file))) {
    config.plugin.push(spec);
    changed = true;
  }
  if (oneMcpRegistrationEnabled(env, registrationFeatureEnabled)) {
    const oneMcp = ensureOneMcpDisabled(config, publicEndpoint(env));
    if (!oneMcp.ok) return { ok: false, path: file, spec, error: oneMcp.error };
    changed = changed || oneMcp.changed;
  }
  if (changed) writeConfig(file, config);
  return { ok: true, path: file, spec, changed };
}

function removeGlobalConfigPlugin(env: NodeJS.ProcessEnv = process.env): ConfigUpdate {
  const file = opencodeGlobalConfigPath(env);
  const spec = opencodeGlobalPluginSpecifier(env);
  if (!fs.existsSync(file)) return { ok: true, path: file, spec, changed: false };
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, spec, error: `Could not parse OpenCode global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, spec, error: 'OpenCode global config must be a JSON object.' };
  if (config.plugin === undefined) return { ok: true, path: file, spec, changed: false };
  if (!Array.isArray(config.plugin)) return { ok: false, path: file, spec, error: 'OpenCode global config `plugin` must be an array.' };
  const next = config.plugin.filter((entry) => !samePluginEntry(entry, spec, file));
  if (next.length === config.plugin.length) return { ok: true, path: file, spec, changed: false };
  config.plugin = next;
  writeConfig(file, config);
  return { ok: true, path: file, spec, changed: true };
}

function globalConfigHasPlugin(
  env: NodeJS.ProcessEnv = process.env,
  registrationFeatureEnabled?: boolean,
): ConfigUpdate {
  const file = opencodeGlobalConfigPath(env);
  const spec = opencodeGlobalPluginSpecifier(env);
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, spec, error: `Could not parse OpenCode global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, spec, error: 'OpenCode global config must be a JSON object.' };
  if (!Array.isArray(config.plugin)) return { ok: false, path: file, spec, error: 'OpenCode global config is missing a `plugin` array.' };
  if (!config.plugin.some((entry) => samePluginEntry(entry, spec, file))) return { ok: false, path: file, spec, error: 'Traffic One wrapper is not registered in the OpenCode global `plugin` array.' };
  if (oneMcpRegistrationEnabled(env, registrationFeatureEnabled)) {
    const oneMcpError = oneMcpDisabledStatus(config);
    if (oneMcpError) return { ok: false, path: file, spec, error: oneMcpError };
  }
  return { ok: true, path: file, spec, changed: false };
}

export function wrapperSource(pluginRoot: string, installedAt = new Date().toISOString()): string {
  const owner = { ...ownerRecord(pluginRoot), installedAt };
  return `// GENERATED BY traffic-one — OpenCode host wrapper.
// OpenCode target: ${OPENCODE_HOST_PACKAGE}@${OPENCODE_HOST_TARGET_VERSION}
// Installed globally through ~/.config/opencode/opencode.jsonc's "plugin" array.
const TRAFFIC_ONE_WRAPPER_OWNER = ${JSON.stringify(owner)};

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __require = createRequire(import.meta.url);

const TRAFFIC_ONE_PLUGIN_ROOT = ${jsString(pluginRoot)};
const TRAFFIC_ONE_RUNTIME = path.join(TRAFFIC_ONE_PLUGIN_ROOT, 'scripts', 'opencode-hook-runtime.cjs');
const TRAFFIC_ONE_ACTIVATION_REL = ${JSON.stringify(OPENCODE_HOST_PROJECT_MARKER_REL.split('/'))};
const TRAFFIC_ONE_MANAGED_MCP_TOOLS = new Set(${JSON.stringify(
  ONE_MCP_MANAGED_TOOLS.map((tool) => `${ONE_MCP_SERVER_NAME}_${tool}`),
)});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function isManagedOneMcpTool(rawName) {
  return TRAFFIC_ONE_MANAGED_MCP_TOOLS.has(firstString(rawName));
}

function validTrafficOneRoot(dir) {
  const stateFile = path.join(dir, '.traffic-one', '.one.json');
  if (!existsSync(stateFile)) return false;
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    return Boolean(state && typeof state === 'object'
      && typeof state.mode === 'string'
      && state.mode.trim());
  } catch {
    return false;
  }
}

function validTrafficOneActivationRoot(dir) {
  const marker = readTrafficOneMarker(dir);
  return Boolean(marker && marker.enabled !== false);
}

function readTrafficOneMarker(dir) {
  const markerFile = path.join(dir, ...TRAFFIC_ONE_ACTIVATION_REL);
  if (!existsSync(markerFile)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    if (!marker || typeof marker !== 'object'
      || marker.owner !== 'traffic-one'
      || marker.version !== 1) return null;
    return marker;
  } catch {
    return null;
  }
}

function disabledTrafficOneRoot(dir) {
  const marker = readTrafficOneMarker(dir);
  return Boolean(marker && marker.enabled === false);
}

function findTrafficOneRoot(start) {
  let current = path.resolve(start || process.cwd());
  const home = firstString(process.env.HOME, process.env.USERPROFILE);
  const homeRoot = home ? path.resolve(home) : '';
  for (let i = 0; i < 40; i += 1) {
    if (homeRoot && current === homeRoot) return '';
    if (disabledTrafficOneRoot(current)) return '';
    if (validTrafficOneRoot(current) || validTrafficOneActivationRoot(current)) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) return '';
    current = parent;
  }
  return '';
}

function trafficOneDisabledFor(start) {
  let current = path.resolve(start || process.cwd());
  const home = firstString(process.env.HOME, process.env.USERPROFILE);
  const homeRoot = home ? path.resolve(home) : '';
  for (let i = 0; i < 40; i += 1) {
    if (homeRoot && current === homeRoot) return false;
    if (disabledTrafficOneRoot(current)) return true;
    if (validTrafficOneRoot(current) || validTrafficOneActivationRoot(current)) return false;
    const parent = path.dirname(current);
    if (!parent || parent === current) return false;
    current = parent;
  }
  return false;
}

function fallbackWorkspaceRoot(start) {
  const raw = firstString(start);
  if (!raw) return '';
  const current = path.resolve(raw);
  const home = firstString(process.env.HOME, process.env.USERPROFILE);
  const homeRoot = home ? path.resolve(home) : '';
  if (homeRoot && current === homeRoot) return '';
  return current;
}

function trafficOneRootFor(start) {
  if (trafficOneDisabledFor(start)) return '';
  return findTrafficOneRoot(start) || fallbackWorkspaceRoot(start);
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      const rec = asObject(part);
      if (rec.type === 'text') return firstString(rec.text);
      if (rec.type === 'subtask') return firstString(rec.prompt, rec.description);
      return '';
    })
    .filter(Boolean)
    .join('\\n');
}

function cwdFromPayload(pluginCtx, input) {
  const rec = asObject(input);
  const session = asObject(rec.session);
  const workspace = asObject(rec.workspace);
  const project = asObject(pluginCtx.project);
  return firstString(
    rec.cwd, rec.workdir, rec.workingDir,
    session.cwd, session.root,
    workspace.root, workspace.path,
    pluginCtx.directory, pluginCtx.worktree,
    project.directory, project.path,
  ) || process.cwd();
}

function normalizeToolPayload(event, input, output, pluginCtx) {
  const rec = asObject(input);
  const out = asObject(output);
  const tool = asObject(rec.tool);
  const args = asObject(out.args || rec.args || rec.arguments || rec.input || rec.tool_input || rec.toolInput || tool.args || tool.input);
  return {
    event,
    cwd: cwdFromPayload(pluginCtx, rec),
    workspaceRoot: firstString(pluginCtx.directory, pluginCtx.worktree),
    tool_name: firstString(rec.tool_name, rec.toolName, rec.name, rec.tool, tool.name, tool.id, tool.type),
    tool_input: args,
    input: rec,
    output: out,
    session_id: firstString(rec.sessionID, rec.sessionId, rec.session_id),
    call_id: firstString(rec.callID, rec.callId, rec.call_id),
  };
}

function normalizePromptPayload(event, input, output, pluginCtx) {
  const rec = asObject(input);
  const out = asObject(output);
  const message = asObject(out.message);
  const parts = Array.isArray(out.parts) ? out.parts : [];
  return {
    event,
    cwd: cwdFromPayload(pluginCtx, rec),
    workspaceRoot: firstString(pluginCtx.directory, pluginCtx.worktree),
    prompt: firstString(rec.prompt, rec.message, rec.text, message.text, message.prompt, textFromParts(parts)),
    // The session id of THIS message's session. For a spawned role subagent, this
    // is the child session — the run-team binder claims it to the role parsed from
    // the spawn prompt's [t1-role: senior-x] marker (OpenCode has no SubagentStart).
    session_id: firstString(rec.sessionID, rec.sessionId, rec.session_id, message.sessionID),
    input: rec,
    output: out,
  };
}

function trafficOneConfigDir() {
  try { return path.dirname(path.dirname(fileURLToPath(import.meta.url))); } catch { return ''; }
}

// Diagnostics are OFF unless a sentinel file exists next to this wrapper's config
// dir (touch ~/.config/opencode/.traffic-one-debug). When on, every hook invocation
// appends one JSON line to traffic-one-debug.log — the only way to see why a hook
// no-ops, since OpenCode 1.17+ logs nothing on plugin load and swallows hook errors.
function debugLog(event, data) {
  try {
    const dir = trafficOneConfigDir();
    if (!dir || !existsSync(path.join(dir, '.traffic-one-debug'))) return;
    appendFileSync(path.join(dir, 'traffic-one-debug.log'), JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\\n');
  } catch {}
}

function trafficOneHookEnv(projectRoot) {
  const base = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TRAFFIC_ONE_PLUGIN_ROOT,
  };
  try {
    const mod = __require(path.join(TRAFFIC_ONE_PLUGIN_ROOT, 'scripts', 'shared', 'state', 'traffic-one-paths.js'));
    return {
      ...mod.resolveTrafficOneEnv(projectRoot, 'opencode', base),
      ELECTRON_RUN_AS_NODE: '1',
      TRAFFIC_ONE_PLUGIN_ROOT,
    };
  } catch (err) {
    debugLog('hook-env-fallback', { err: String(err && err.message || err) });
    return { ...base, HOME: os.homedir() };
  }
}

function runTrafficOne(subcommand, payload) {
  const projectRoot = trafficOneRootFor(payload.cwd || process.cwd());
  if (!projectRoot) { debugLog('skip-no-root', { subcommand, cwd: payload.cwd || null }); return { kind: 'noop' }; }
  const input = JSON.stringify({ ...payload, cwd: projectRoot, projectRoot, workspaceRoot: projectRoot });
  // ELECTRON_RUN_AS_NODE makes process.execPath behave as node when OpenCode runs
  // the plugin inside an Electron node-service (where execPath is the Electron
  // binary, not node); ignored by plain node/bun, so it is safe everywhere.
  const result = spawnSync(process.execPath, [TRAFFIC_ONE_RUNTIME, subcommand, '--host=opencode'], {
    input,
    encoding: 'utf8',
    timeout: 30000,
    env: trafficOneHookEnv(projectRoot),
  });
  if (result.error || result.status !== 0) {
    debugLog('spawn-fail', { subcommand, projectRoot, execPath: process.execPath, status: result.status, error: result.error ? String(result.error.message || result.error) : null, stderr: String(result.stderr || '').slice(0, 500) });
    return { kind: 'noop' };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || '').trim() || '{"kind":"noop"}');
    debugLog('ok', { subcommand, projectRoot, kind: parsed && parsed.kind });
    return parsed;
  } catch {
    debugLog('parse-fail', { subcommand, projectRoot, stdout: String(result.stdout || '').slice(0, 500) });
    return { kind: 'noop' };
  }
}

function resultText(result) {
  if (!result || result.kind === 'noop') return;
  return firstString(result.context, result.systemMessage, result.reason);
}

function appendSystem(output, result) {
  const text = resultText(result);
  if (!text) return;
  const out = asObject(output);
  if (Array.isArray(out.system)) out.system.push(text);
}

function appendToolWarning(output, result) {
  const text = resultText(result);
  if (!text) return;
  const out = asObject(output);
  out.metadata = { ...asObject(out.metadata), trafficOneWarning: text };
  if (typeof out.output === 'string' && out.output.trim()) out.output = out.output + '\\n\\n[Traffic One]\\n' + text;
  else out.output = '[Traffic One]\\n' + text;
}

function appendPromptContext(output, result) {
  const text = resultText(result);
  if (!text) return;
  const out = asObject(output);
  if (!Array.isArray(out.parts) || !out.parts.length) return;
  // OpenCode validates user-message parts against a strict schema (id/sessionID/
  // messageID required) BEFORE saving; a fresh partial part throws "invalid user
  // part before save" and kills the whole prompt. So append our context to an
  // existing text part, which already carries those ids, rather than push a new one.
  for (let i = out.parts.length - 1; i >= 0; i -= 1) {
    const part = out.parts[i];
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      part.text = part.text + '\\n\\n[Traffic One context]\\n' + text;
      return;
    }
  }
}

async function beforeTool(input, output, pluginCtx) {
  const payload = normalizeToolPayload(${jsString(OPENCODE_HOOK_TOOL_BEFORE)}, input, output, pluginCtx);
  // This guard intentionally runs before project-root lookup and before the
  // child runtime spawn. It therefore survives explicit project opt-out,
  // missing runtime files, parse failures, and OpenCode's legacy fail-open path.
  if (isManagedOneMcpTool(payload.tool_name)) {
    throw new Error(${JSON.stringify(ONE_MCP_AGENT_TOOL_DENY_REASON)});
  }
  const result = runTrafficOne('before-tool-use', payload);
  if (result && result.kind === 'deny') {
    throw new Error(firstString(result.reason, result.context) || 'Traffic One denied this OpenCode tool call.');
  }
}

async function afterTool(input, output, pluginCtx) {
  const result = runTrafficOne('after-tool-use', normalizeToolPayload(${jsString(OPENCODE_HOOK_TOOL_AFTER)}, input, output, pluginCtx));
  appendToolWarning(output, result);
}

async function systemTransform(input, output, pluginCtx) {
  const result = runTrafficOne('session-start', normalizePromptPayload(${jsString(OPENCODE_HOOK_SYSTEM_TRANSFORM)}, input, output, pluginCtx));
  if (result && result.kind === 'deny') throw new Error(firstString(result.reason, result.context) || 'Traffic One denied this OpenCode request.');
  appendSystem(output, result);
}

async function chatMessage(input, output, pluginCtx) {
  const result = runTrafficOne('user-prompt-submit', normalizePromptPayload(${jsString(OPENCODE_HOOK_CHAT_MESSAGE)}, input, output, pluginCtx));
  if (result && result.kind === 'deny') throw new Error(firstString(result.reason, result.context) || 'Traffic One denied this OpenCode message.');
  appendPromptContext(output, result);
}

export const TrafficOne = async (ctx = {}) => {
  const pluginCtx = asObject(ctx);
  return {
    ${jsString(OPENCODE_HOOK_TOOL_BEFORE)}: (input, output) => beforeTool(input, output, pluginCtx),
    ${jsString(OPENCODE_HOOK_TOOL_AFTER)}: (input, output) => afterTool(input, output, pluginCtx),
    ${jsString(OPENCODE_HOOK_SYSTEM_TRANSFORM)}: (input, output) => systemTransform(input, output, pluginCtx),
    ${jsString(OPENCODE_HOOK_CHAT_MESSAGE)}: (input, output) => chatMessage(input, output, pluginCtx),
  };
};

export default {
  id: ${jsString(OPENCODE_HOST_GLOBAL_PLUGIN_ID)},
  server: TrafficOne,
};
`;
}

export function installWrapper(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  registrationFeatureEnabled?: boolean,
): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to install without explicit consent. Re-run with `install --yes` to write the global OpenCode Traffic One wrapper.\n',
      stdout: '',
    };
  }
  const file = opencodeGlobalPluginPath(env);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readOwner(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned OpenCode plugin at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wrapperSource(pluginRoot), 'utf8');
  const config = ensureGlobalConfigPlugin(env, registrationFeatureEnabled);
  if (!config.ok) {
    return { code: 1, stdout: '', stderr: `${config.error}\nwrapper: ${file}\nconfig: ${config.path}\n` };
  }
  return { code: 0, stdout: `Installed Traffic One OpenCode wrapper at ${file}\nRegistered OpenCode global plugin in ${config.path}\nRestart OpenCode to load or refresh global plugins.\n` };
}

export function enableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to enable a project without explicit consent. Re-run with `enable --cwd <project> --yes` to write the project OpenCode activation marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = opencodeProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readProjectActivation(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned OpenCode activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(projectActivationRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Enabled Traffic One for OpenCode project at ${projectRoot}\nmarker: ${file}\nRestart OpenCode to load or refresh global plugins if this is the first enable after wrapper install.\n` };
}

export function disableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to disable a project without explicit consent. Re-run with `disable --cwd <project> --yes` to write the project OpenCode opt-out marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = opencodeProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
    return { code: 0, stdout: `Disabled Traffic One for OpenCode project at ${projectRoot}\nmarker: ${file}\n` };
  }
  const owner = readProjectActivation(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned OpenCode activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Disabled Traffic One for OpenCode project at ${projectRoot}\nmarker: ${file}\n` };
}

export function uninstallWrapper(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  const file = opencodeGlobalPluginPath(env);
  if (!fs.existsSync(file)) return { code: 0, stdout: `No Traffic One OpenCode wrapper installed at ${file}\n` };
  const owner = readOwner(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to remove unowned OpenCode plugin at ${file}. Re-run with --force only if you intend to remove it.\n`,
      stdout: '',
    };
  }
  const config = removeGlobalConfigPlugin(env);
  if (!config.ok && !argv.includes('--force')) {
    return { code: 1, stdout: '', stderr: `${config.error}\nwrapper: ${file}\nconfig: ${config.path}\n` };
  }
  fs.rmSync(file, { force: true });
  return { code: 0, stdout: `Removed Traffic One OpenCode wrapper at ${file}\nRemoved OpenCode global plugin registration from ${config.path}\n` };
}

export function doctorWrapper(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  registrationFeatureEnabled?: boolean,
): RunnerOutput {
  const file = opencodeGlobalPluginPath(env);
  const owner = readOwner(file);
  if (!fs.existsSync(file)) {
    return { code: 1, stdout: `missing: ${file}\n` };
  }
  if (!owner) {
    return { code: 1, stdout: `unowned: ${file}\n` };
  }
  const config = globalConfigHasPlugin(env, registrationFeatureEnabled);
  const currentRoot = runtimePluginRoot(env);
  const current = path.resolve(owner.pluginRoot) === path.resolve(currentRoot);
  const projectArg = explicitCwdArg(argv);
  let projectSection = '';
  let projectOk = true;
  if (projectArg) {
    const projectRoot = path.resolve(projectArg);
    const marker = opencodeProjectMarkerPath(projectRoot);
    const activation = readProjectActivation(marker);
    const markerExists = fs.existsSync(marker);
    projectOk = !activation || activation.enabled !== false;
    const status = activation
      ? (activation.enabled === false ? 'disabled' : 'enabled-marker')
      : (markerExists ? 'unowned' : 'automatic');
    if (markerExists && !activation) projectOk = false;
    projectSection = `projectActivation: ${status}\nprojectRoot: ${projectRoot}\nprojectMarker: ${marker}\n`;
  }
  return {
    code: current && projectOk && config.ok ? 0 : 1,
    stdout: `${current ? 'ok' : 'owned-by-other-install'}: ${file}\npluginRoot: ${owner.pluginRoot}\ntargetOpenCode: ${owner.targetOpenCode || OPENCODE_HOST_TARGET_VERSION}\nconfig: ${config.ok ? 'ok' : `error: ${config.error}`} (${config.path})\npluginSpec: ${config.spec}\nloadModel: registered in OpenCode global plugin array\n${projectSection}`,
  };
}

export function run(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): RunnerOutput {
  const command = args.find((arg) => !arg.startsWith('--')) || 'doctor';
  if (command === 'install') return installWrapper(env, args);
  if (command === 'enable') return enableProject(env, args);
  if (command === 'disable') return disableProject(env, args);
  if (command === 'uninstall') return uninstallWrapper(env, args);
  if (command === 'doctor') return doctorWrapper(env, args);
  return { code: 2, stdout: '', stderr: 'Usage: opencode-host.cjs <install --yes|enable --cwd <project> --yes|disable --cwd <project> --yes|uninstall|doctor [--cwd <project>]> [--force]\n' };
}

export function main(): number {
  const result = run();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (require.main === module) {
  process.exitCode = main();
}
