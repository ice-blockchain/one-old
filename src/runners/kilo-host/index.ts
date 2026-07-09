// src/runners/kilo-host/index.ts
// Install/doctor/uninstall the user-level Kilo wrapper that bridges Kilo's
// in-process JS server-plugin hooks to Traffic One's compiled runtime.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  KILO_HOOK_CHAT_MESSAGE,
  KILO_HOOK_EVENT,
  KILO_HOOK_PERMISSION_ASK,
  KILO_HOOK_SHELL_ENV,
  KILO_HOOK_SYSTEM_TRANSFORM,
  KILO_HOOK_TOOL_AFTER,
  KILO_HOOK_TOOL_BEFORE,
  KILO_HOST_GLOBAL_CONFIG_DIR_REL,
  KILO_HOST_GLOBAL_PLUGIN_FILE,
  KILO_HOST_GLOBAL_PLUGIN_ID,
  KILO_HOST_GLOBAL_PLUGINS_REL,
  KILO_HOST_PACKAGE,
  KILO_HOST_PROJECT_MARKER_REL,
  KILO_HOST_TARGET_VERSION,
} from '../../config/kilo-host';

export interface RunnerOutput { code: number; stdout: string; stderr?: string; }

const OWNER_NAME = 'traffic-one';
const OWNER_RE = /TRAFFIC_ONE_WRAPPER_OWNER\s*=\s*(\{[^\n]+});/;

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function kiloConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'kilo');
  return path.join(homeDir(env), KILO_HOST_GLOBAL_CONFIG_DIR_REL);
}

export function kiloGlobalPluginPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiloConfigDir(env), KILO_HOST_GLOBAL_PLUGINS_REL, KILO_HOST_GLOBAL_PLUGIN_FILE);
}

function runtimePluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..', '..');
}

interface OwnerRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetKilo: string;
  packageName: string;
  installedAt?: string;
}

interface ProjectActivationRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetKilo: string;
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
    targetKilo: KILO_HOST_TARGET_VERSION,
    packageName: KILO_HOST_PACKAGE,
    installedAt: new Date().toISOString(),
  };
}

function projectActivationRecord(pluginRoot: string): ProjectActivationRecord {
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetKilo: KILO_HOST_TARGET_VERSION,
    packageName: KILO_HOST_PACKAGE,
    enabled: true,
    enabledAt: new Date().toISOString(),
  };
}

function projectDisabledRecord(pluginRoot: string): ProjectActivationRecord {
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetKilo: KILO_HOST_TARGET_VERSION,
    packageName: KILO_HOST_PACKAGE,
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
      targetKilo: typeof rec.targetKilo === 'string' ? rec.targetKilo : '',
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
      targetKilo: typeof rec.targetKilo === 'string' ? rec.targetKilo : '',
      packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
      ...(typeof rec.enabled === 'boolean' ? { enabled: rec.enabled } : {}),
      ...(typeof rec.enabledAt === 'string' ? { enabledAt: rec.enabledAt } : {}),
      ...(typeof rec.disabledAt === 'string' ? { disabledAt: rec.disabledAt } : {}),
    };
  } catch {
    return null;
  }
}

export function kiloProjectMarkerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), KILO_HOST_PROJECT_MARKER_REL);
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

export function wrapperSource(pluginRoot: string, installedAt = new Date().toISOString()): string {
  const owner = { ...ownerRecord(pluginRoot), installedAt };
  return `// GENERATED BY traffic-one - Kilo host wrapper.
// Kilo target: ${KILO_HOST_PACKAGE}@${KILO_HOST_TARGET_VERSION}
// Installed globally at ~/.config/kilo/plugin/traffic-one.js.
const TRAFFIC_ONE_WRAPPER_OWNER = ${JSON.stringify(owner)};

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __require = createRequire(import.meta.url);

const TRAFFIC_ONE_PLUGIN_ROOT = ${jsString(pluginRoot)};
const TRAFFIC_ONE_RUNTIME = path.join(TRAFFIC_ONE_PLUGIN_ROOT, 'scripts', 'kilo-hook-runtime.cjs');
const TRAFFIC_ONE_ACTIVATION_REL = ${JSON.stringify(KILO_HOST_PROJECT_MARKER_REL.split('/'))};
const TRAFFIC_ONE_SESSION_ROOTS = new Map();
let TRAFFIC_ONE_NODE = '';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function rememberSessionRoot(sessionID, ...dirs) {
  const id = firstString(sessionID);
  const dir = firstString(...dirs);
  if (id && dir) TRAFFIC_ONE_SESSION_ROOTS.set(id, path.resolve(dir));
}

function rememberedSessionRoot(sessionID) {
  const id = firstString(sessionID);
  return id ? firstString(TRAFFIC_ONE_SESSION_ROOTS.get(id)) : '';
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

function validTrafficOneActivationRoot(dir) {
  const marker = readTrafficOneMarker(dir);
  return Boolean(marker && marker.enabled !== false);
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
  const sessionID = firstString(rec.sessionID, rec.sessionId, rec.session_id, session.id, session.sessionID);
  return firstString(
    rec.cwd, rec.workdir, rec.workingDir,
    session.cwd, session.root,
    workspace.root, workspace.path,
    rememberedSessionRoot(sessionID),
    pluginCtx.directory, pluginCtx.worktree,
    project.directory, project.path,
  ) || process.cwd();
}

function normalizeToolPayload(event, input, output, pluginCtx) {
  const rec = asObject(input);
  const out = asObject(output);
  const tool = asObject(rec.tool);
  const sessionID = firstString(rec.sessionID, rec.sessionId, rec.session_id);
  const args = asObject(out.args || rec.args || rec.arguments || rec.input || rec.tool_input || rec.toolInput || tool.args || tool.input);
  return {
    event,
    cwd: cwdFromPayload(pluginCtx, rec),
    workspaceRoot: firstString(rec.workspaceRoot, rec.workspace_root, rememberedSessionRoot(sessionID), pluginCtx.directory, pluginCtx.worktree),
    tool_name: firstString(rec.tool_name, rec.toolName, rec.name, rec.tool, tool.name, tool.id, tool.type),
    tool_input: args,
    input: rec,
    output: out,
    session_id: sessionID,
    call_id: firstString(rec.callID, rec.callId, rec.call_id),
  };
}

function normalizePermissionPayload(event, input, output, pluginCtx) {
  const rec = asObject(input);
  const out = asObject(output);
  const metadata = asObject(rec.metadata);
  const patterns = Array.isArray(rec.patterns)
    ? rec.patterns.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const patternText = patterns.join('\\n');
  const permission = firstString(rec.permission, rec.type, metadata.permission);
  const toolInput = permission === 'bash'
    ? { command: firstString(metadata.command, patternText, rec.pattern) }
    : { file_path: firstString(metadata.file, metadata.path, patternText, rec.pattern) };
  const sessionID = firstString(rec.sessionID, rec.sessionId, rec.session_id);
  const tool = asObject(rec.tool);
  return {
    event,
    cwd: cwdFromPayload(pluginCtx, rec),
    workspaceRoot: firstString(rec.workspaceRoot, rec.workspace_root, rememberedSessionRoot(sessionID), pluginCtx.directory, pluginCtx.worktree),
    tool_name: firstString(permission, tool.name, tool.id, tool.type),
    tool_input: toolInput,
    input: rec,
    output: out,
    session_id: sessionID,
    call_id: firstString(rec.callID, rec.callId, rec.call_id, tool.callID, tool.callId),
  };
}

function normalizePromptPayload(event, input, output, pluginCtx) {
  const rec = asObject(input);
  const out = asObject(output);
  const message = asObject(out.message);
  const parts = Array.isArray(out.parts) ? out.parts : [];
  const sessionID = firstString(rec.sessionID, rec.sessionId, rec.session_id, message.sessionID);
  return {
    event,
    cwd: cwdFromPayload(pluginCtx, rec),
    workspaceRoot: firstString(rec.workspaceRoot, rec.workspace_root, rememberedSessionRoot(sessionID), pluginCtx.directory, pluginCtx.worktree),
    prompt: firstString(rec.prompt, rec.message, rec.text, message.text, message.prompt, textFromParts(parts)),
    session_id: sessionID,
    input: rec,
    output: out,
  };
}

function recordSessionEvent(input, pluginCtx) {
  const rec = asObject(input);
  const event = asObject(rec.event || rec);
  const props = asObject(event.properties);
  const info = asObject(props.info || event.info);
  const sessionID = firstString(props.sessionID, event.sessionID, info.id, rec.sessionID);
  rememberSessionRoot(sessionID, info.directory, props.directory, event.directory, pluginCtx.directory, pluginCtx.worktree);
  if (sessionID) debugLog('event', { type: firstString(event.type, rec.type), sessionID, directory: rememberedSessionRoot(sessionID) || null });
}

function permissionRequestFromEvent(input) {
  const rec = asObject(input);
  const event = asObject(rec.event || rec);
  const type = firstString(event.type, rec.type);
  if (type !== 'permission.asked' && type !== 'permission.updated') return null;
  const props = asObject(event.properties);
  if (!props) return null;
  return { event, props };
}

async function maybeThen(value) {
  if (value && typeof value.then === 'function') return value;
  return value;
}

async function rejectPermission(pluginCtx, permission, projectRoot, reason) {
  const client = asObject(pluginCtx.client);
  const requestID = firstString(permission.id, permission.requestID, permission.permissionID);
  const sessionID = firstString(permission.sessionID, permission.sessionId, permission.session_id);
  if (!requestID) return false;
  const message = firstString(reason).slice(0, 4000);
  const permissionClient = asObject(client.permission);
  if (permissionClient && typeof permissionClient.reply === 'function') {
    await maybeThen(permissionClient.reply({
      requestID,
      directory: projectRoot,
      workspace: projectRoot,
      reply: 'reject',
      ...(message ? { message } : {}),
    }));
    return true;
  }
  if (sessionID && typeof client.postSessionIdPermissionsPermissionId === 'function') {
    await maybeThen(client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID: requestID },
      query: { directory: projectRoot },
      body: { response: 'reject' },
    }));
    return true;
  }
  return false;
}

function trafficOneConfigDir() {
  try { return path.dirname(path.dirname(fileURLToPath(import.meta.url))); } catch { return ''; }
}

function debugLog(event, data) {
  try {
    const dir = trafficOneConfigDir();
    if (!dir || !existsSync(path.join(dir, '.traffic-one-debug'))) return;
    appendFileSync(path.join(dir, 'traffic-one-debug.log'), JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\\n');
  } catch {}
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = firstString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function isNodeExecutable(command) {
  if (!command) return false;
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return false;
  const version = firstString(result.stdout, result.stderr).trim();
  return /^v\\d+\\.\\d+\\.\\d+/.test(version);
}

function pathNodeCandidates() {
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  const dirs = firstString(process.env.PATH).split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function nvmNodeCandidates() {
  const home = firstString(process.env.HOME, process.env.USERPROFILE);
  if (!home) return [];
  const versionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    return readdirSync(versionsDir)
      .filter((name) => name && !name.startsWith('.'))
      .sort()
      .reverse()
      .map((name) => path.join(versionsDir, name, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
  } catch {
    return [];
  }
}

function commonNodeCandidates() {
  if (process.platform === 'win32') return [];
  return [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/opt/local/bin/node',
    '/run/current-system/sw/bin/node',
  ];
}

function resolveNodeExecutable() {
  if (TRAFFIC_ONE_NODE) return TRAFFIC_ONE_NODE;
  const candidates = uniqueStrings([
    process.env.TRAFFIC_ONE_NODE,
    process.env.TRAFFIC_ONE_NODE_PATH,
    process.env.NODE,
    process.env.npm_node_execpath,
    process.execPath,
    ...pathNodeCandidates(),
    ...commonNodeCandidates(),
    ...nvmNodeCandidates(),
  ]);
  for (const candidate of candidates) {
    if (!isNodeExecutable(candidate)) continue;
    TRAFFIC_ONE_NODE = candidate;
    debugLog('node-resolved', { nodePath: candidate, execPath: process.execPath });
    return candidate;
  }
  debugLog('node-resolve-failed', { execPath: process.execPath, path: process.env.PATH || null });
  return '';
}

function trafficOneHookEnv(projectRoot) {
  const base = {
    ...process.env,
    TRAFFIC_ONE_HOST: 'kilo',
    TRAFFIC_ONE_PLUGIN_ROOT,
  };
  try {
    const mod = __require(path.join(TRAFFIC_ONE_PLUGIN_ROOT, 'scripts', 'shared', 'state', 'traffic-one-paths.js'));
    return {
      ...mod.resolveTrafficOneEnv(projectRoot, 'kilo', base),
      TRAFFIC_ONE_HOST: 'kilo',
      TRAFFIC_ONE_PLUGIN_ROOT,
    };
  } catch (err) {
    debugLog('hook-env-fallback', { err: String(err && err.message || err) });
    return base;
  }
}

function runTrafficOne(subcommand, payload) {
  const projectRoot = trafficOneRootFor(payload.cwd || process.cwd());
  if (!projectRoot) { debugLog('skip-no-root', { subcommand, cwd: payload.cwd || null }); return { kind: 'noop' }; }
  const nodePath = resolveNodeExecutable();
  if (!nodePath) {
    const reason = 'Traffic One Kilo pre-tool gate could not find a Node.js runtime, so this tool call is blocked fail-closed.';
    return subcommand === 'before-tool-use' ? { kind: 'deny', reason } : { kind: 'noop' };
  }
  const input = JSON.stringify({ ...payload, cwd: projectRoot, projectRoot, workspaceRoot: projectRoot });
  const result = spawnSync(nodePath, [TRAFFIC_ONE_RUNTIME, subcommand, '--host=kilo'], {
    input,
    encoding: 'utf8',
    timeout: 30000,
    env: trafficOneHookEnv(projectRoot),
  });
  if (result.error || result.status !== 0) {
    debugLog('spawn-fail', { subcommand, projectRoot, execPath: process.execPath, nodePath, status: result.status, error: result.error ? String(result.error.message || result.error) : null, stderr: String(result.stderr || '').slice(0, 500) });
    if (subcommand === 'before-tool-use') {
      return { kind: 'deny', reason: 'Traffic One Kilo pre-tool gate failed before it could make a decision, so this tool call is blocked fail-closed.' };
    }
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
  for (let i = out.parts.length - 1; i >= 0; i -= 1) {
    const part = out.parts[i];
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      part.text = part.text + '\\n\\n[Traffic One context]\\n' + text;
      return;
    }
  }
}

async function beforeTool(input, output, pluginCtx) {
  const result = runTrafficOne('before-tool-use', normalizeToolPayload(${jsString(KILO_HOOK_TOOL_BEFORE)}, input, output, pluginCtx));
  if (result && result.kind === 'deny') {
    throw new Error(firstString(result.reason, result.context) || 'Traffic One denied this Kilo tool call.');
  }
}

async function permissionAsk(input, output, pluginCtx) {
  const result = runTrafficOne('before-tool-use', normalizePermissionPayload(${jsString(KILO_HOOK_PERMISSION_ASK)}, input, output, pluginCtx));
  if (result && result.kind === 'deny') {
    const out = asObject(output);
    out.status = 'deny';
    debugLog('permission-deny', { reason: firstString(result.reason, result.context).slice(0, 300) });
  }
}

async function afterTool(input, output, pluginCtx) {
  const result = runTrafficOne('after-tool-use', normalizeToolPayload(${jsString(KILO_HOOK_TOOL_AFTER)}, input, output, pluginCtx));
  appendToolWarning(output, result);
}

async function systemTransform(input, output, pluginCtx) {
  const result = runTrafficOne('session-start', normalizePromptPayload(${jsString(KILO_HOOK_SYSTEM_TRANSFORM)}, input, output, pluginCtx));
  if (result && result.kind === 'deny') throw new Error(firstString(result.reason, result.context) || 'Traffic One denied this Kilo request.');
  appendSystem(output, result);
}

async function chatMessage(input, output, pluginCtx) {
  const result = runTrafficOne('user-prompt-submit', normalizePromptPayload(${jsString(KILO_HOOK_CHAT_MESSAGE)}, input, output, pluginCtx));
  if (result && result.kind === 'deny') throw new Error(firstString(result.reason, result.context) || 'Traffic One denied this Kilo message.');
  appendPromptContext(output, result);
}

async function shellEnv(_input, output) {
  const out = asObject(output);
  out.env = { ...asObject(out.env), TRAFFIC_ONE_PLUGIN_ROOT, TRAFFIC_ONE_HOST: 'kilo' };
}

async function event(input, pluginCtx) {
  recordSessionEvent(input, pluginCtx);
  const permission = permissionRequestFromEvent(input);
  if (!permission) return;
  const payload = normalizePermissionPayload('permission.asked', permission.props, {}, pluginCtx);
  const result = runTrafficOne('before-tool-use', payload);
  if (!result || result.kind !== 'deny') return;
  const reason = firstString(result.reason, result.context) || 'Traffic One denied this Kilo tool call.';
  try {
    const projectRoot = trafficOneRootFor(payload.cwd || process.cwd());
    const rejected = await rejectPermission(pluginCtx, permission.props, projectRoot, reason);
    debugLog(rejected ? 'permission-event-deny' : 'permission-event-deny-unanswered', {
      sessionID: firstString(permission.props.sessionID),
      requestID: firstString(permission.props.id),
      reason: reason.slice(0, 300),
    });
  } catch (err) {
    debugLog('permission-event-deny-failed', { err: String(err && err.message || err), reason: reason.slice(0, 300) });
  }
}

export const TrafficOne = async (ctx = {}) => {
  const pluginCtx = asObject(ctx);
  debugLog('server-init', {
    directory: firstString(pluginCtx.directory),
    worktree: firstString(pluginCtx.worktree),
    projectDirectory: firstString(asObject(pluginCtx.project).directory),
  });
  return {
    ${jsString(KILO_HOOK_TOOL_BEFORE)}: (input, output) => beforeTool(input, output, pluginCtx),
    ${jsString(KILO_HOOK_TOOL_AFTER)}: (input, output) => afterTool(input, output, pluginCtx),
    ${jsString(KILO_HOOK_SYSTEM_TRANSFORM)}: (input, output) => systemTransform(input, output, pluginCtx),
    ${jsString(KILO_HOOK_CHAT_MESSAGE)}: (input, output) => chatMessage(input, output, pluginCtx),
    ${jsString(KILO_HOOK_SHELL_ENV)}: (input, output) => shellEnv(input, output),
    ${jsString(KILO_HOOK_PERMISSION_ASK)}: (input, output) => permissionAsk(input, output, pluginCtx),
    ${jsString(KILO_HOOK_EVENT)}: (input) => event(input, pluginCtx),
  };
};

export default {
  id: ${jsString(KILO_HOST_GLOBAL_PLUGIN_ID)},
  server: TrafficOne,
};
`;
}

export function installWrapper(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to install without explicit consent. Re-run with `install --yes` to write the global Kilo Traffic One wrapper.\n',
      stdout: '',
    };
  }
  const file = kiloGlobalPluginPath(env);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readOwner(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned Kilo plugin at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wrapperSource(pluginRoot), 'utf8');
  return { code: 0, stdout: `Installed Traffic One Kilo wrapper at ${file}\nRestart Kilo to load or refresh global plugins.\n` };
}

export function enableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to enable a project without explicit consent. Re-run with `enable --cwd <project> --yes` to write the project Kilo activation marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = kiloProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readProjectActivation(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned Kilo activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(projectActivationRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Enabled Traffic One for Kilo project at ${projectRoot}\nmarker: ${file}\nRestart Kilo to load or refresh global plugins if this is the first enable after wrapper install.\n` };
}

export function disableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to disable a project without explicit consent. Re-run with `disable --cwd <project> --yes` to write the project Kilo opt-out marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = kiloProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
    return { code: 0, stdout: `Disabled Traffic One for Kilo project at ${projectRoot}\nmarker: ${file}\n` };
  }
  const owner = readProjectActivation(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned Kilo activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Disabled Traffic One for Kilo project at ${projectRoot}\nmarker: ${file}\n` };
}

export function uninstallWrapper(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  const file = kiloGlobalPluginPath(env);
  if (!fs.existsSync(file)) return { code: 0, stdout: `No Traffic One Kilo wrapper installed at ${file}\n` };
  const owner = readOwner(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to remove unowned Kilo plugin at ${file}. Re-run with --force only if you intend to remove it.\n`,
      stdout: '',
    };
  }
  fs.rmSync(file, { force: true });
  return { code: 0, stdout: `Removed Traffic One Kilo wrapper at ${file}\n` };
}

export function doctorWrapper(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  const file = kiloGlobalPluginPath(env);
  const owner = readOwner(file);
  if (!fs.existsSync(file)) {
    return { code: 1, stdout: `missing: ${file}\n` };
  }
  if (!owner) {
    return { code: 1, stdout: `unowned: ${file}\n` };
  }
  const currentRoot = runtimePluginRoot(env);
  const current = path.resolve(owner.pluginRoot) === path.resolve(currentRoot);
  const projectArg = explicitCwdArg(argv);
  let projectSection = '';
  let projectOk = true;
  if (projectArg) {
    const projectRoot = path.resolve(projectArg);
    const marker = kiloProjectMarkerPath(projectRoot);
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
    code: current && projectOk ? 0 : 1,
    stdout: `${current ? 'ok' : 'owned-by-other-install'}: ${file}\npluginRoot: ${owner.pluginRoot}\ntargetKilo: ${owner.targetKilo || KILO_HOST_TARGET_VERSION}\nloadModel: auto-loaded from Kilo global plugin directory\n${projectSection}`,
  };
}

export function run(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): RunnerOutput {
  const command = args.find((arg) => !arg.startsWith('--')) || 'doctor';
  if (command === 'install') return installWrapper(env, args);
  if (command === 'enable') return enableProject(env, args);
  if (command === 'disable') return disableProject(env, args);
  if (command === 'uninstall') return uninstallWrapper(env, args);
  if (command === 'doctor') return doctorWrapper(env, args);
  return { code: 2, stdout: '', stderr: 'Usage: kilo-host.cjs <install --yes|enable --cwd <project> --yes|disable --cwd <project> --yes|uninstall|doctor [--cwd <project>]> [--force]\n' };
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
