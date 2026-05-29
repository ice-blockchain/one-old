// src/runners/doctor/probes.ts
// Environment + project + Codex-session probes for the traffic-one doctor.
// Ported 1:1 from scripts/doctor/{probeNode,probeNvm,probeGitnexus,probeProject,
// probeCodexHooks,probeMcpAuth,probeSessionDiagnostics,analyzeCodexSessionFile,
// resolveCodexSession}.cjs. All reads; no writes.

import * as fs from 'fs';
import * as path from 'path';

import { effectiveState, normalizeState, projectPrefsPath, readProjectPrefs, stripLocalPreferenceFields } from '../../shared/state';
import {
  GITNEXUS_MIN_NODE_MAJOR,
  currentNodeMajor,
  findNvmNode22,
  nvmInstallCommand,
  nvmPresent,
  type NvmNode22,
} from '../gitnexus';
import {
  authProbeForSession,
  type AuthProbe,
  codexConfigPath,
  codexSessionsDir,
  commandLooksMutating,
  getPayloadText,
  mcpConfigPath,
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
    installCommand: nvm22 ? null : nvmInstallCommand(),
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
}
export function probeProject(cwd: string): ProjectProbe {
  const trafficOne = safeRead(path.join(cwd, '.traffic-one', '.one.json'));
  let state: Rec | null = null;
  if (trafficOne) { try { state = JSON.parse(trafficOne) as Rec; } catch { state = null; } }
  let normalizedState: Rec | null = null;
  let localPreferences: Rec = {};
  let localPreferencesPath: string | null = null;
  if (state && typeof state === 'object') {
    localPreferencesPath = projectPrefsPath(cwd);
    localPreferences = readProjectPrefs(cwd);
    normalizedState = effectiveState(stripLocalPreferenceFields(state), localPreferences);
    normalizeState(normalizedState, (typeof normalizedState.mode === 'string' && normalizedState.mode)
      || (typeof normalizedState.projectMode === 'string' && normalizedState.projectMode)
      || 'new-project');
  }
  const nvmrcRaw = safeRead(path.join(cwd, '.nvmrc'));
  const gitDir = safeStat(path.join(cwd, '.git'));
  const gitnexusOut = safeStat(path.join(cwd, '.gitnexus'));
  const graphifyOut = safeStat(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'));
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
  };
}

export interface McpAuthProbe {
  configPath: string;
  configExists: boolean;
  configured: boolean;
  type: string | null;
  url: string | null;
  credentialPath: string | null;
}
export function probeMcpAuth(env: NodeJS.ProcessEnv = process.env): McpAuthProbe {
  const configPath = mcpConfigPath();
  const raw = safeRead(configPath);
  const config = raw ? safeJsonParse(raw, null) : null;
  const servers = config && config.mcpServers && typeof config.mcpServers === 'object'
    ? (config.mcpServers as Rec)
    : null;
  const server = servers && servers['mcp-auth'] && typeof servers['mcp-auth'] === 'object'
    ? (servers['mcp-auth'] as Rec)
    : null;
  return {
    configPath,
    configExists: Boolean(raw),
    configured: Boolean(server),
    type: server && typeof server.type === 'string' ? server.type : null,
    url: server && typeof server.url === 'string' ? server.url : null,
    credentialPath: env.TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH || null,
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
  trafficOneAuthPromptCount: number;
  trafficOneInstructionInjected: boolean;
  baseInstructionsMentionTrafficOne: boolean;
  toolCallCount: number;
  mutatingToolCallCount: number;
  firstAuthGateAt: string | null;
  firstMutatingToolAt: string | null;
  mutatingToolBeforeAuthGate: boolean;
  authState: AuthProbe | null;
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
    trafficOneAuthPromptCount: 0,
    trafficOneInstructionInjected: false,
    baseInstructionsMentionTrafficOne: false,
    toolCallCount: 0,
    mutatingToolCallCount: 0,
    firstAuthGateAt: null,
    firstMutatingToolAt: null,
    mutatingToolBeforeAuthGate: false,
    authState: null,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = safeJsonParse(line, null);
    if (!parsed) continue;
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
    const serialized = JSON.stringify(parsed);
    if (serialized.includes('hookSpecificOutput')) diagnostics.hookPayloadCount += 1;
    if (serialized.includes('promptRequest')) diagnostics.promptRequestCount += 1;
    if (serialized.includes('permissionDecision')) diagnostics.permissionDecisionCount += 1;
    if (serialized.includes('traffic-one.auth.choice')) {
      diagnostics.trafficOneAuthPromptCount += 1;
      if (!diagnostics.firstAuthGateAt) diagnostics.firstAuthGateAt = timestamp;
    }

    if (parsed.type === 'session_meta') {
      const payload = parsed.payload && typeof parsed.payload === 'object' ? (parsed.payload as Rec) : {};
      diagnostics.id = typeof payload.id === 'string' ? payload.id : diagnostics.id;
      diagnostics.cwd = typeof payload.cwd === 'string' ? payload.cwd : diagnostics.cwd;
      diagnostics.startedAt = (typeof payload.timestamp === 'string' ? payload.timestamp : null) || timestamp || diagnostics.startedAt;
      const instructionText = getPayloadText(payload);
      diagnostics.baseInstructionsMentionTrafficOne = /Traffic One|traffic-one|\.traffic-one/.test(instructionText);
      diagnostics.trafficOneInstructionInjected = /Traffic One Codex Instructions|\.traffic-one\/rules\/common\/auth-gate\.md|Authenticate with the `mcp-auth` server/.test(instructionText);
      continue;
    }

    if (parsed.type !== 'response_item') continue;
    const payload = parsed.payload && typeof parsed.payload === 'object' ? (parsed.payload as Rec) : {};
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue;
    const name = typeof payload.name === 'string' ? payload.name : '';
    diagnostics.toolCallCount += 1;
    const rawArgs = payload.arguments || payload.input || '';
    if (commandLooksMutating(name, rawArgs)) {
      diagnostics.mutatingToolCallCount += 1;
      if (!diagnostics.firstMutatingToolAt) diagnostics.firstMutatingToolAt = timestamp;
    }
  }

  diagnostics.authState = authProbeForSession(diagnostics.startedAt, env);
  diagnostics.mutatingToolBeforeAuthGate = Boolean(
    diagnostics.firstMutatingToolAt
    && (
      !diagnostics.firstAuthGateAt
      || diagnostics.firstMutatingToolAt < diagnostics.firstAuthGateAt
    ),
  );
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
