// src/runners/doctor/probes.ts
// Doctor probes: auth, one-mcp, session diagnostics, opencode MCP.
// Toolchain/host probes live in probes-toolchain.ts and are re-exported.

import * as fs from 'fs';
import * as path from 'path';
import { HOST_IDS, type HostModelKey } from '../../config/model-tiers';
import { DEFAULT_PUBLIC_ENDPOINT, ONE_MCP_CONFIG_NAME_BY_HOST } from '../../config/one-mcp';
import { OPENCODE_MCP_SERVER_KEY, OPENCODE_MCP_SHIM_PATH } from '../../config/opencode-mcp';
import { readSimpleAuth } from '../../shared/auth';
import { codexHookEvidenceEvent, hasCodexHookEvidenceMarker, isCodexHookEvent } from '../../shared/codex-hook-evidence';
import { readOneMcpCache, type OneMcpLastSync } from '../../shared/one-mcp/cache';
import { usableOneMcpConfigCacheEntry } from '../../shared/current-model-tiers';
import { oneSettingsPath } from '../../shared/one-settings';
import { stableBinDir } from '../../shared/runner-shims';
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
import {
  probeCodexHookTrust,
  type CodexHookTrustProbe,
  type CodexHookTrustProbeOptions,
} from './codex-hook-trust';
type Rec = Record<string, unknown>;

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
      const config = usableOneMcpConfigCacheEntry(host, state?.config ?? null, DEFAULT_PUBLIC_ENDPOINT);
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
export {
  type CodexHooksProbe,
  type GitnexusProbe,
  type NodeProbe,
  type NvmProbe,
  type ProjectProbe,
  type RunIdProbe,
  probeCodexHooks,
  probeGitnexus,
  probeNode,
  probeNvm,
  probeProject,
} from './probes-toolchain';
