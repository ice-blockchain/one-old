// src/runners/doctor/probes-toolchain.ts
// Toolchain/host probes: node, nvm, gitnexus, codex hooks.

import * as fs from 'fs';
import * as path from 'path';
import { isMaintenanceTerminal } from '../../shared/maintenance/terminal';
import { effectiveLegacyRunStatus } from '../../shared/run-settlement';
import { legacyCustomBackendMigration } from '../../shared/architecture-contract';
import { GITNEXUS_REL, GRAPHIFY_REPORT_REL } from '../../shared/codegraph';
import { OPENCODE_MCP_SERVER_KEY, OPENCODE_MCP_SHIM_PATH } from '../../config/opencode-mcp';
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
import {
  probeCodexHookTrust,
  type CodexHookTrustProbe,
  type CodexHookTrustProbeOptions,
} from './codex-hook-trust';
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
      status = effectiveLegacyRunStatus(parsed) || null;
    } catch {
      status = null;
    }
  }
  let maintenanceOutcome: string | null = null;
  let maintenanceOverallOutcome: string | null = null;
  let maintenanceOpencodeOutcome: string | null = null;
  let maintenanceFallbackAllowed = false;
  let maintenanceRecord: Rec | null = null;
  if (fs.existsSync(maintenanceJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(maintenanceJson, 'utf8')) as Rec;
      maintenanceRecord = parsed;
      maintenanceOutcome = typeof parsed.outcome === 'string' ? parsed.outcome : null;
      maintenanceOverallOutcome = typeof parsed.overallOutcome === 'string' ? parsed.overallOutcome : null;
      maintenanceOpencodeOutcome = typeof parsed.opencodeOutcome === 'string' ? parsed.opencodeOutcome : null;
      maintenanceFallbackAllowed = parsed.fallbackAllowed === true;
    } catch {
      maintenanceOutcome = null;
    }
  }
  const maintenanceTerminalOrFallbackPending = fs.existsSync(maintenanceJson)
    && (
      maintenanceOverallOutcome === 'fallback-pending'
      || isMaintenanceTerminal(maintenanceRecord)
    );
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
  legacyCapabilityMigration: {
    status: 'not-applicable' | 'auto-correctable' | 'ambiguous';
    message: string | null;
  };
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
  const runState = probeRunId(cwd, normalizedState || state);
  const migration = legacyCustomBackendMigration(cwd, state || {});
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
    runState,
    nestedTrafficOneRoots: listNestedTrafficOneRoots(cwd),
    openCodeCli: fs.existsSync(managedNpmBin('opencode', 'opencode'))
      ? 'managed'
      : (which('opencode') ? 'path' : 'missing'),
    legacyCapabilityMigration: migration.changed
      ? { status: 'auto-correctable', message: 'no frontend artifacts were detected' }
      : migration.ambiguous
        ? { status: 'ambiguous', message: migration.message || null }
        : { status: 'not-applicable', message: null },
  };
}

export interface CodexHooksProbe {
  host: 'codex';
  configPath: string | null;
  configExists: boolean;
  cwd: string;
  pluginEnabled?: boolean | null;
  hookTrust: CodexHookTrustProbe;
  trustCovered?: boolean;
  trustedProject?: string | null;
  // Whether [mcp_servers.opencode-worker] is present in config.toml — Codex
  // only launches MCP servers from there, so without it the delegation tool
  // never appears (a Codex restart is needed after it is written).
  opencodeMcpRegistered?: boolean;
}
export async function probeCodexHooks(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CodexHookTrustProbeOptions = {},
): Promise<CodexHooksProbe> {
  const configPath = codexConfigPath(env);
  const text = configPath ? safeRead(configPath) : null;
  const sections = parseCodexConfigToml(text || '');
  const pluginSection = sections['plugins."traffic-one@traffic-one-local"'] || null;
  const trustedProject = trustedProjectForCwd(cwd, sections);
  const hookTrust = await probeCodexHookTrust(cwd, env, options);

  return {
    host: 'codex',
    configPath,
    configExists: text !== null,
    cwd: path.resolve(cwd),
    pluginEnabled: pluginSection ? pluginSection.enabled === true : null,
    hookTrust,
    trustCovered: Boolean(trustedProject),
    trustedProject,
    opencodeMcpRegistered: Object.prototype.hasOwnProperty.call(sections, `mcp_servers.${OPENCODE_MCP_SERVER_KEY}`),
  };
}

