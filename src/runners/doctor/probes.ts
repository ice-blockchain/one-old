// src/runners/doctor/probes.ts
// Environment + project + Codex-session probes for the traffic-one doctor.
// Ported 1:1 from scripts/doctor/{probeNode,probeNvm,probeGitnexus,probeProject,
// probeCodexHooks,probeCanonicalAuth,probeSessionDiagnostics,analyzeCodexSessionFile,
// resolveCodexSession}.cjs. All reads; no writes.

import * as fs from 'fs';
import * as path from 'path';

import { GITNEXUS_REL, GRAPHIFY_REPORT_REL } from '../../shared/codegraph';
import { HOST_IDS, type HostModelKey } from '../../config/model-tiers';
import { ONE_MCP_CONFIG_NAME_BY_HOST } from '../../config/one-mcp';
import { OPENCODE_MCP_SERVER_KEY, OPENCODE_MCP_SHIM_PATH } from '../../config/opencode-mcp';
import { readSimpleAuth } from '../../shared/auth';
import { codexHookEvidenceEvent, hasCodexHookEvidenceMarker, isCodexHookEvent } from '../../shared/codex-hook-evidence';
import { readOneMcpCache, type OneMcpLastSync } from '../../shared/one-mcp-cache';
import { usableOneMcpConfigCacheEntry } from '../../shared/current-model-tiers';
import { oneSettingsPath } from '../../shared/one-settings';
import { stableBinDir } from '../../shared/runner-shims';
import { applyGlobalCodeGraphProvider, effectiveState, normalizeState, projectPrefsPath, readProjectPrefs, stripLocalPreferenceFields } from '../../shared/state';
import { managedNpmBin } from '../../shared/toolchain-paths';
import {
  GITNEXUS_MIN_NODE_MAJOR,
  currentNodeMajor,
  findNvmNode22,
  nvmPresent,
  type NvmNode22,
} from '../gitnexus';
import {
  codexConfigPath,
  codexSessionsDir,
  commandLooksMutating,
  parseCodexConfigToml,
  readFirstJsonlObject,
  safeJsonParse,
  safeRead,
  safeStat,
  sessionIdFromFile,
  trustedProjectForCwd,
  walkJsonlFiles,
  which,
} from './lib';

type Rec = Record<string, unknown>;

export interface NodeProbe { runningMajor: number | null; runningVersion: string; onPath: string | null; requiredMajor: number; }
export function probeNode(): NodeProbe {
  return {
    runningMajor: currentNodeMajor(),
    runningVersion: process.versions.node,
    onPath: which('node'),
    requiredMajor: GITNEXUS_MIN_NODE_MAJOR,
  };
}

export interface NvmProbe {
  installed: boolean;
  root?: string;
  defaultAlias?: string;
  installedVersions?: string[];
  hasV22?: boolean;
  v22Paths?: NvmNode22 | null;
  installCommand?: string | null;
}
export function probeNvm(): NvmProbe {
  const home = process.env.HOME || '';
  const installed = nvmPresent();
  if (!installed) return { installed: false };
  const nvmRoot = path.join(home, '.nvm');
  const defaultAlias = (safeRead(path.join(nvmRoot, 'alias', 'default')) || '').trim();
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(path.join(nvmRoot, 'versions', 'node'))
      .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
      .sort();
  } catch { /* empty */ }
  const nvm22 = findNvmNode22();
  return {
    installed: true,
    root: nvmRoot,
    defaultAlias,
    installedVersions: versions,
    hasV22: !!nvm22,
    v22Paths: nvm22,
    installCommand: null,
  };
}

export interface GitnexusProbe { onPath: string | null; absoluteV22: string | null; crashRiskInOldNvm: boolean; }
export function probeGitnexus(): GitnexusProbe {
  const fromPath = which('gitnexus');
  const nvm22 = findNvmNode22();
  return {
    onPath: fromPath,
    absoluteV22: nvm22 ? nvm22.gitnexus : null,
    // A pre-existing gitnexus living inside an OLDER nvm Node folder is the
    // "installed via --force, will crash" landmine. Flag it.
    crashRiskInOldNvm: !!(fromPath && /\/\.nvm\/versions\/node\/v(?!22)[\d.]+\/bin\/gitnexus$/.test(fromPath)),
  };
}

export interface RunIdProbe {
  currentRunId: string | null;
  runDirExists: boolean;
  runJsonExists: boolean;
  runJsonStatus: string | null;
  hasOrchestratedArtifacts: boolean;
  maintenanceJsonExists: boolean;
  maintenanceOutcome: string | null;
  maintenanceOverallOutcome: string | null;
  maintenanceOpencodeOutcome: string | null;
  maintenanceFallbackAllowed: boolean;
  maintenanceTerminalOrFallbackPending: boolean;
}

function runHasArtifacts(cwd: string, runId: string): boolean {
  if (!runId) return false;
  if (fs.existsSync(path.join(cwd, '.traffic-one', 'runs', runId, 'assignments.json'))) return true;
  const digestDir = path.join(cwd, '.traffic-one', 'digests', runId);
  try {
    return fs.readdirSync(digestDir).some((name) => name.endsWith('.md') || name.endsWith('.json'));
  } catch {
    return false;
  }
}

function probeRunId(cwd: string, state: Rec | null): RunIdProbe {
  const raw = state && typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!raw) {
    return {
      currentRunId: null,
      runDirExists: false,
      runJsonExists: false,
      runJsonStatus: null,
      hasOrchestratedArtifacts: false,
      maintenanceJsonExists: false,
      maintenanceOutcome: null,
      maintenanceOverallOutcome: null,
      maintenanceOpencodeOutcome: null,
      maintenanceFallbackAllowed: false,
      maintenanceTerminalOrFallbackPending: false,
    };
  }
  const runDir = path.join(cwd, '.traffic-one', 'runs', raw);
  const runJson = path.join(runDir, 'run.json');
  const maintenanceJson = path.join(runDir, 'maintenance.json');
  let status: string | null = null;
  if (fs.existsSync(runJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(runJson, 'utf8')) as Rec;
      status = typeof parsed.status === 'string' ? parsed.status : null;
    } catch {
      status = null;
    }
  }
  let maintenanceOutcome: string | null = null;
  let maintenanceOverallOutcome: string | null = null;
  let maintenanceOpencodeOutcome: string | null = null;
  let maintenanceFallbackAllowed = false;
  if (fs.existsSync(maintenanceJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(maintenanceJson, 'utf8')) as Rec;
      maintenanceOutcome = typeof parsed.outcome === 'string' ? parsed.outcome : null;
      maintenanceOverallOutcome = typeof parsed.overallOutcome === 'string' ? parsed.overallOutcome : null;
      maintenanceOpencodeOutcome = typeof parsed.opencodeOutcome === 'string' ? parsed.opencodeOutcome : null;
      maintenanceFallbackAllowed = parsed.fallbackAllowed === true;
    } catch {
      maintenanceOutcome = null;
    }
  }
  const terminalMaintenance = new Set(['success', 'completed', 'failed', 'blocked', 'skipped', 'fallback-paid']);
  const maintenanceTerminalOrFallbackPending = fs.existsSync(maintenanceJson)
    && (maintenanceFallbackAllowed || terminalMaintenance.has(maintenanceOverallOutcome || maintenanceOutcome || ''));
  return {
    currentRunId: raw,
    runDirExists: fs.existsSync(runDir),
    runJsonExists: fs.existsSync(runJson),
    runJsonStatus: status,
    hasOrchestratedArtifacts: runHasArtifacts(cwd, raw),
    maintenanceJsonExists: fs.existsSync(maintenanceJson),
    maintenanceOutcome,
    maintenanceOverallOutcome,
    maintenanceOpencodeOutcome,
    maintenanceFallbackAllowed,
    maintenanceTerminalOrFallbackPending,
  };
}

export interface ProjectProbe {
  cwd: string;
  hasState: boolean;
  state: Rec | null;
  localPreferences: Rec;
  localPreferencesPath: string | null;
  hasLocalPreferences: boolean;
  normalizedState: Rec | null;
  nvmrc: string | null;
  hasGit: boolean;
  artefacts: { gitnexus: { mtimeMs: number } | null; graphify: { mtimeMs: number } | null };
  runState: RunIdProbe;
  nestedTrafficOneRoots: string[];
  // How a delegation run would resolve the OpenCode CLI right now: the managed
  // install, a PATH binary (unpinned version), or nothing.
  openCodeCli: 'managed' | 'path' | 'missing';
}

function listNestedTrafficOneRoots(cwd: string): string[] {
  const out: string[] = [];
  const root = path.resolve(cwd);
  const trafficDir = '.traffic' + '-one';
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.pnpm-store']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= 50) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.name === trafficDir) {
        const owner = path.dirname(abs);
        if (owner !== root && fs.existsSync(path.join(abs, '.one.json'))) out.push(owner);
        continue;
      }
      walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export function probeProject(cwd: string): ProjectProbe {
  const trafficOne = safeRead(path.join(cwd, '.traffic-one', '.one.json'));
  let state: Rec | null = null;
  if (trafficOne) { try { state = JSON.parse(trafficOne) as Rec; } catch { state = null; } }
  let normalizedState: Rec | null = null;
  const localPreferencesPath = projectPrefsPath(cwd);
  const localPreferences = readProjectPrefs(cwd);
  if (state && typeof state === 'object') {
    normalizedState = applyGlobalCodeGraphProvider(effectiveState(stripLocalPreferenceFields(state), localPreferences));
    normalizeState(normalizedState, (typeof normalizedState.mode === 'string' && normalizedState.mode)
      || (typeof normalizedState.projectMode === 'string' && normalizedState.projectMode)
      || 'new-project');
  }
  const nvmrcRaw = safeRead(path.join(cwd, '.nvmrc'));
  const gitDir = safeStat(path.join(cwd, '.git'));
  const gitnexusOut = safeStat(path.join(cwd, GITNEXUS_REL));
  const graphifyOut = safeStat(path.join(cwd, GRAPHIFY_REPORT_REL));
  return {
    cwd,
    hasState: !!state,
    state,
    localPreferences,
    localPreferencesPath,
    hasLocalPreferences: Object.keys(localPreferences || {}).length > 0,
    normalizedState,
    nvmrc: nvmrcRaw === null ? null : nvmrcRaw.trim(),
    hasGit: !!gitDir && gitDir.isDirectory(),
    artefacts: {
      gitnexus: gitnexusOut ? { mtimeMs: gitnexusOut.mtimeMs } : null,
      graphify: graphifyOut ? { mtimeMs: graphifyOut.mtimeMs } : null,
    },
    runState: probeRunId(cwd, normalizedState || state),
    nestedTrafficOneRoots: listNestedTrafficOneRoots(cwd),
    openCodeCli: fs.existsSync(managedNpmBin('opencode', 'opencode'))
      ? 'managed'
      : (which('opencode') ? 'path' : 'missing'),
  };
}

export interface CodexHooksProbe {
  host: 'codex';
  configPath: string | null;
  configExists: boolean;
  cwd: string;
  pluginEnabled?: boolean | null;
  hookStateEntryCount?: number;
  hookStateEnabledCount?: number;
  hookStateTrustedHashCount?: number;
  hookEvents?: string[];
  missingHookEvents?: string[];
  trustCovered?: boolean;
  trustedProject?: string | null;
  // Whether [mcp_servers.opencode-worker] is present in config.toml — Codex
  // only launches MCP servers from there, so without it the delegation tool
  // never appears (a Codex restart is needed after it is written).
  opencodeMcpRegistered?: boolean;
}
export function probeCodexHooks(cwd: string, env: NodeJS.ProcessEnv = process.env): CodexHooksProbe {
  const configPath = codexConfigPath(env);
  const text = configPath ? safeRead(configPath) : null;
  if (!text) {
    return { host: 'codex', configPath, configExists: false, cwd: path.resolve(cwd) };
  }

  const sections = parseCodexConfigToml(text);
  const pluginSection = sections['plugins."traffic-one@traffic-one-local"'] || null;
  const hookSections = Object.entries(sections)
    .filter(([section]) => section.startsWith('hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:'));
  const hookEvents = new Set<string>();
  let hookStateEnabledCount = 0;
  let hookStateTrustedHashCount = 0;
  for (const [section, values] of hookSections) {
    const eventMatch = section.match(/hooks\/hooks\.json:([^:]+):/);
    if (eventMatch && eventMatch[1] !== undefined) hookEvents.add(eventMatch[1]);
    if (values && values.enabled === true) hookStateEnabledCount += 1;
    if (values && typeof values.trusted_hash === 'string' && values.trusted_hash.startsWith('sha256:')) {
      hookStateTrustedHashCount += 1;
    }
  }
  const requiredHookEvents = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use'];
  const missingHookEvents = requiredHookEvents.filter((event) => !hookEvents.has(event));
  const trustedProject = trustedProjectForCwd(cwd, sections);

  return {
    host: 'codex',
    configPath,
    configExists: true,
    cwd: path.resolve(cwd),
    pluginEnabled: pluginSection ? pluginSection.enabled === true : null,
    hookStateEntryCount: hookSections.length,
    hookStateEnabledCount,
    hookStateTrustedHashCount,
    hookEvents: [...hookEvents].sort(),
    missingHookEvents,
    trustCovered: Boolean(trustedProject),
    trustedProject,
    opencodeMcpRegistered: Object.prototype.hasOwnProperty.call(sections, `mcp_servers.${OPENCODE_MCP_SERVER_KEY}`),
  };
}

export interface CanonicalAuthProbe {
  filePath: string;
  present: boolean;
  valid: boolean;
  updatedAt: string | null;
}

// Redacted by construction: the stored API key never enters the probe output.
export function probeCanonicalAuth(env: NodeJS.ProcessEnv = process.env): CanonicalAuthProbe {
  const state = readSimpleAuth(env);
  return {
    filePath: oneSettingsPath(env),
    present: state !== null,
    valid: Boolean(state && state.authenticated === true && state.apiKey.trim()),
    updatedAt: state && state.updatedAt ? state.updatedAt : null,
  };
}

export interface OneMcpHostProbe {
  host: HostModelKey;
  configName: string;
  catalogSource: 'one-mcp' | 'bundled';
  configVersion: number;
  configUpdatedAt: string | null;
  lastSync: OneMcpLastSync | null;
}

export interface OneMcpProbe {
  hosts: OneMcpHostProbe[];
}

// Read-only and redacted by construction. The doctor exposes a fixed structural
// lastSync record for every supported host, never cached payloads, model ids,
// endpoints, or remote error text. Network probing remains build-disabled.
export function probeOneMcp(env: NodeJS.ProcessEnv = process.env): OneMcpProbe {
  let states: ReturnType<typeof readOneMcpCache>['hosts'] = {};
  try {
    states = readOneMcpCache(env).hosts;
  } catch {
    // An unreadable/future cache is represented as bundled/no diagnostic for all
    // hosts. Doctor remains report-only and never rewrites it.
  }
  return {
    hosts: HOST_IDS.map((host): OneMcpHostProbe => {
      const state = states[host];
      // Keep the doctor's source verdict identical to runtime. A structurally
      // parseable cache entry can still be unusable for this build (most notably
      // when it belongs to another endpoint); runtime falls back to bundled and
      // doctor must report that same source.
      const config = usableOneMcpConfigCacheEntry(host, state?.config ?? null, env);
      const lastSync = state?.lastSync ?? null;
      return {
        host,
        configName: ONE_MCP_CONFIG_NAME_BY_HOST[host],
        catalogSource: config ? 'one-mcp' : 'bundled',
        configVersion: config?.version ?? 0,
        configUpdatedAt: config?.updatedAt ?? null,
        lastSync: lastSync ? {
          attemptedAt: lastSync.attemptedAt,
          outcome: lastSync.outcome,
          source: lastSync.source,
          requestedVersion: lastSync.requestedVersion,
          observedVersion: lastSync.observedVersion,
          ...(lastSync.reason ? { reason: lastSync.reason } : {}),
        } : null,
      };
    }),
  };
}

export interface SessionDiagnostics {
  id: string;
  jsonl?: string;
  cwd: string | null;
  startedAt: string | null;
  hookPayloadCount: number;
  promptRequestCount: number;
  permissionDecisionCount: number;
  toolCallCount: number;
  mutatingToolCallCount: number;
}

function responseMessageText(payload: Rec): string {
  if (typeof payload.content === 'string') return payload.content;
  if (!Array.isArray(payload.content)) return '';
  return payload.content.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    const text = (block as Rec).text;
    return typeof text === 'string' ? text : '';
  }).filter(Boolean).join('\n');
}

function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
}

function hasOwn(value: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isProjectInstructionText(text: string): boolean {
  const trimmed = text.trimStart();
  return /^(?:# AGENTS\.md instructions|# Traffic One Codex Instructions|# Traffic One Local Agent Context)\b/.test(trimmed)
    || trimmed.startsWith('<INSTRUCTIONS>')
    || text.includes('<!-- GENERATED BY traffic-one: project-local active rules -->');
}

function trafficOneHookTextStart(text: string): string {
  let trimmed = text.trimStart();
  // Project/bootstrap instructions can quote hook output examples. They prove
  // instructions were loaded, not that a hook emitted anything in this session.
  if (isProjectInstructionText(trimmed)) return '';
  // Codex can prepend this bounded truncation notice to a hook message.
  trimmed = trimmed.replace(/^Total output lines:[ \t]*\d+[ \t]*\r?\n(?:[ \t]*\r?\n)?/, '').trimStart();
  if (isProjectInstructionText(trimmed)) return '';
  return trimmed;
}

function isTrafficOneHookText(text: string): boolean {
  const start = trafficOneHookTextStart(text);
  if (!start) return false;
  if (hasCodexHookEvidenceMarker(start)) return true;
  return /^(?:(?:═{3}[ \t]*)?traffic-one(?:[ \t]+—|[ \t]*[:\[])|\[traffic-one\]|\[ACTIVE STACK:[^\]\r\n]+\]|\[(?:UNRESOLVED TRAFFIC ONE RUN|MAINTENANCE PHASE)\b|\[(?:graphify|gitnexus)\][ \t]+(?:Codebase graph|Auto-bootstrap)\b)/.test(start);
}

interface CodexHookCausalState {
  promptWindow: boolean;
  startupWindow: boolean;
  pendingToolCallIds: Set<string>;
  postToolWindow: boolean;
}

function isTrafficOneHookDeveloperMessage(payload: Rec, state: CodexHookCausalState): boolean {
  if (payload.type !== 'message' || payload.role !== 'developer') return false;
  const start = trafficOneHookTextStart(responseMessageText(payload));
  if (!start) return false;
  const markedEvent = codexHookEvidenceEvent(start);
  if (markedEvent === 'SessionStart' || markedEvent === 'SubagentStart') return state.startupWindow;
  if (markedEvent === 'UserPromptSubmit') return state.promptWindow;
  if (markedEvent === 'PreToolUse') return state.pendingToolCallIds.size > 0;
  if (markedEvent === 'PostToolUse') return state.postToolWindow;
  const historicalWindow = state.promptWindow || state.pendingToolCallIds.size > 0 || state.postToolWindow;
  return historicalWindow && isTrafficOneHookText(start);
}

interface StructuredHookSignals {
  trafficOneEvidence: boolean;
  promptRequest: boolean;
  permissionDecision: boolean;
}

function structuredHookSignals(parsed: Rec): StructuredHookSignals {
  // Inspect only known object envelopes. Never search serialized text: source
  // inspection and tool output routinely contain these field names as prose.
  const payload = record(parsed.payload);
  const envelopes = payload ? [parsed, payload] : [parsed];
  const evidenceTexts: string[] = [];
  let promptRequest = false;
  let permissionDecision = false;
  for (const envelope of envelopes) {
    const hookOutput = record(envelope.hookSpecificOutput);
    if (!hookOutput || !isCodexHookEvent(hookOutput.hookEventName)) continue;
    if (hasOwn(envelope, 'promptRequest')) promptRequest = true;
    if (hasOwn(hookOutput, 'permissionDecision')) permissionDecision = true;
    if (typeof envelope.systemMessage === 'string') evidenceTexts.push(envelope.systemMessage);
    if (typeof hookOutput.additionalContext === 'string') evidenceTexts.push(hookOutput.additionalContext);
    if (typeof hookOutput.permissionDecisionReason === 'string') evidenceTexts.push(hookOutput.permissionDecisionReason);
  }
  return {
    trafficOneEvidence: evidenceTexts.some(isTrafficOneHookText),
    promptRequest,
    permissionDecision,
  };
}

function clearCodexHookCausalState(state: CodexHookCausalState): void {
  state.promptWindow = false;
  state.startupWindow = false;
  state.pendingToolCallIds.clear();
  state.postToolWindow = false;
}

function advanceCodexHookCausalState(parsed: Rec, state: CodexHookCausalState): void {
  const payload = record(parsed.payload) || {};
  if (parsed.type === 'event_msg') {
    if (payload.type === 'task_started') {
      clearCodexHookCausalState(state);
      state.startupWindow = true;
      return;
    }
    if (payload.type === 'user_message') {
      clearCodexHookCausalState(state);
      state.promptWindow = true;
      return;
    }
    if (payload.type === 'agent_reasoning' || payload.type === 'agent_message'
      || payload.type === 'task_complete') clearCodexHookCausalState(state);
    return;
  }
  if (parsed.type !== 'response_item') return;
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    state.promptWindow = false;
    state.startupWindow = false;
    state.postToolWindow = false;
    const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
    if (callId) state.pendingToolCallIds.add(callId);
    return;
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
    if (callId && state.pendingToolCallIds.delete(callId)) state.postToolWindow = true;
    return;
  }
  if (payload.type === 'message' && payload.role === 'developer') {
    if (isProjectInstructionText(responseMessageText(payload))) clearCodexHookCausalState(state);
    return;
  }
  if (payload.type === 'reasoning' || payload.type === 'message') clearCodexHookCausalState(state);
}

export function analyzeCodexSessionFile(filePath: string, env: NodeJS.ProcessEnv = process.env): SessionDiagnostics | null {
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  const diagnostics: SessionDiagnostics = {
    id: sessionIdFromFile(filePath),
    jsonl: filePath,
    cwd: null,
    startedAt: null,
    hookPayloadCount: 0,
    promptRequestCount: 0,
    permissionDecisionCount: 0,
    toolCallCount: 0,
    mutatingToolCallCount: 0,
  };
  const hookCausalState: CodexHookCausalState = {
    promptWindow: false,
    startupWindow: false,
    pendingToolCallIds: new Set<string>(),
    postToolWindow: false,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = safeJsonParse(line, null);
    if (!parsed) continue;
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
    const signals = structuredHookSignals(parsed);
    if (signals.promptRequest) diagnostics.promptRequestCount += 1;
    if (signals.permissionDecision) diagnostics.permissionDecisionCount += 1;

    const responsePayload = parsed.type === 'response_item'
      ? record(parsed.payload)
      : null;
    if (signals.trafficOneEvidence || (responsePayload && isTrafficOneHookDeveloperMessage(responsePayload, hookCausalState))) {
      diagnostics.hookPayloadCount += 1;
    }
    advanceCodexHookCausalState(parsed, hookCausalState);

    if (parsed.type === 'session_meta') {
      const payload = parsed.payload && typeof parsed.payload === 'object' ? (parsed.payload as Rec) : {};
      diagnostics.id = typeof payload.id === 'string' ? payload.id : diagnostics.id;
      diagnostics.cwd = typeof payload.cwd === 'string' ? payload.cwd : diagnostics.cwd;
      diagnostics.startedAt = (typeof payload.timestamp === 'string' ? payload.timestamp : null) || timestamp || diagnostics.startedAt;
      continue;
    }

    if (parsed.type !== 'response_item') continue;
    const payload = responsePayload ?? {};
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue;
    const name = typeof payload.name === 'string' ? payload.name : '';
    diagnostics.toolCallCount += 1;
    const rawArgs = payload.arguments || payload.input || '';
    if (commandLooksMutating(name, rawArgs)) {
      diagnostics.mutatingToolCallCount += 1;
    }
  }
  return diagnostics;
}

export function resolveCodexSession(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = codexSessionsDir(env);
  const files = walkJsonlFiles(root);
  const direct = files.find((filePath) => path.basename(filePath).includes(sessionId));
  if (direct) return direct;
  for (const filePath of files) {
    const first = readFirstJsonlObject(filePath);
    const payload = first && first.payload && typeof first.payload === 'object' ? (first.payload as Rec) : {};
    if (payload.id === sessionId) return filePath;
  }
  return null;
}

export type SessionDiagnosticsResult =
  | { id: string; found: false; sessionsDir: string }
  | ({ found: true } & SessionDiagnostics)
  | null;

export function probeSessionDiagnostics(sessionId: string | null, env: NodeJS.ProcessEnv = process.env): SessionDiagnosticsResult {
  if (!sessionId) return null;
  const filePath = resolveCodexSession(sessionId, env);
  if (!filePath) {
    return { id: sessionId, found: false, sessionsDir: codexSessionsDir(env) };
  }
  const analyzed = analyzeCodexSessionFile(filePath, env);
  if (!analyzed) return { id: sessionId, found: false, sessionsDir: codexSessionsDir(env) };
  return { found: true, ...analyzed };
}

export interface OpenCodeMcpProbe {
  binShimPath: string;
  binShimExists: boolean;
  pluginShimPath: string | null;
  pluginShimExists: boolean;
}

export function probeOpenCodeMcp(env: NodeJS.ProcessEnv = process.env): OpenCodeMcpProbe {
  const binShimPath = path.join(stableBinDir(), 'opencode-mcp.cjs');
  const pluginRoot = [
    env.TRAFFIC_ONE_PLUGIN_ROOT,
    env.CURSOR_PLUGIN_ROOT,
    env.CODEX_PLUGIN_ROOT,
    env.CLAUDE_PLUGIN_ROOT,
  ].map((v) => (v || '').trim()).find(Boolean) || null;
  const pluginShimPath = pluginRoot ? path.join(pluginRoot, OPENCODE_MCP_SHIM_PATH) : null;
  return {
    binShimPath,
    binShimExists: fs.existsSync(binShimPath),
    pluginShimPath,
    pluginShimExists: pluginShimPath ? fs.existsSync(pluginShimPath) : false,
  };
}
