// src/runners/doctor/findings.ts
// Turns the doctor probes into a flat list of severity-tagged findings. Ported
// 1:1 from scripts/doctor/buildFindings.cjs. Pure: derives messages from probe
// data; never reads the filesystem itself except via the toolchain spec.

import { toolStatus } from '../toolchain';
import { codeGraphProviderFromValue, normalizedProjectState, onboardingStateIssues, rawStateHasLegacyShape } from './lib';
import type {
  CodexHooksProbe,
  GitnexusProbe,
  CanonicalAuthProbe,
  NodeProbe,
  NvmProbe,
  OneMcpProbe,
  OpenCodeMcpProbe,
  ProjectProbe,
  SessionDiagnosticsResult,
} from './probes';

type Rec = Record<string, unknown>;

export interface Finding {
  severity: 'fix-needed' | 'info';
  code: string;
  message: string;
  recommendedCommand?: string;
  tool?: string;
}

export interface BuildFindingsInput {
  node: NodeProbe;
  nvm: NvmProbe;
  gitnexus: GitnexusProbe;
  project: ProjectProbe;
  codexHooks?: CodexHooksProbe | null;
  auth?: CanonicalAuthProbe | null;
  oneMcp?: OneMcpProbe | null;
  openCodeMcp?: OpenCodeMcpProbe | null;
  sessionDiagnostics?: SessionDiagnosticsResult;
}

export function buildFindings({ node, nvm, gitnexus, project, codexHooks = null, oneMcp = null, openCodeMcp = null, sessionDiagnostics = null }: BuildFindingsInput): Finding[] {
  const findings: Finding[] = [];
  const rawState = project.state && typeof project.state === 'object' ? project.state : null;
  const state = normalizedProjectState(project as unknown as Rec);
  const provider = state && typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const pluginUse = project.localPreferences?.pluginUse && typeof project.localPreferences.pluginUse === 'object'
    ? project.localPreferences.pluginUse as Rec
    : null;
  const pluginExplicitlyDeclined = pluginUse?.enabled === false;

  if (project.legacyCapabilityMigration.status === 'auto-correctable') {
    findings.push({
      severity: 'info',
      code: 'LEGACY_CUSTOM_BACKEND_SAFE_MIGRATION',
      message: 'Legacy custom-backend + react-vite state has no frontend artifacts. Runtime will safely normalize frontend to none at the next parent SessionStart; Doctor remains read-only.',
    });
  } else if (project.legacyCapabilityMigration.status === 'ambiguous') {
    findings.push({
      severity: 'fix-needed',
      code: 'LEGACY_CUSTOM_BACKEND_AMBIGUOUS',
      message: `Legacy custom-backend + react-vite state was not changed: ${project.legacyCapabilityMigration.message || 'frontend evidence is ambiguous'}. Confirm the intended surface after the active run settles; no mid-run migration is allowed.`,
    });
  }

  if (sessionDiagnostics) {
    if (sessionDiagnostics.found === false) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_SESSION_NOT_FOUND',
        message: `Could not find Codex session ${sessionDiagnostics.id} under ${sessionDiagnostics.sessionsDir}.`,
      });
    } else {
      if (sessionDiagnostics.hookPayloadCount === 0
        && !pluginExplicitlyDeclined
        && codexHooks?.pluginEnabled !== false) {
        findings.push({
          severity: 'info',
          code: 'CODEX_HOOK_OUTPUT_NOT_OBSERVED_FOR_SESSION',
          message: `Codex session ${sessionDiagnostics.id} contains no attributable Traffic One hook-output evidence for cwd ${sessionDiagnostics.cwd || '(unknown)'}. Hooks may have returned only intentional no-ops; use the config and trust findings to determine whether hooks were unavailable.`,
        });
      }
    }
  }

  if (oneMcp) {
    for (const host of oneMcp.hosts) {
      const sync = host.lastSync;
      if (!sync) continue;
      const versions = `requested version ${sync.requestedVersion}, observed version ${sync.observedVersion}`;
      const source = host.catalogSource === 'one-mcp'
        ? 'The current runtime source is the last valid cached One MCP catalog.'
        : 'The current runtime source is the bundled catalog.';
      if (sync.outcome === 'invalid-response') {
        findings.push({
          severity: 'info',
          code: 'ONE_MCP_CONFIG_REJECTED',
          message: `One MCP rejected ${host.host} configuration ${host.configName} (${sync.reason || 'invalid-response'}; ${versions}). ${source}`,
        });
      } else if (sync.outcome === 'config-not-found') {
        findings.push({
          severity: 'info',
          code: 'ONE_MCP_CONFIG_NOT_FOUND',
          message: `One MCP configuration ${host.configName} for ${host.host} was not published (${versions}). ${source}`,
        });
      } else if (sync.outcome === 'temporary-error' || sync.outcome === 'unavailable') {
        findings.push({
          severity: 'info',
          code: 'ONE_MCP_SYNC_UNAVAILABLE',
          message: `One MCP sync for ${host.host} was temporarily unavailable (${sync.reason || sync.outcome}; ${versions}). ${source}`,
        });
      }
    }
  }

  if (codexHooks) {
    const hookTrust = codexHooks.hookTrust;
    if (codexHooks.pluginEnabled !== true) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_TRAFFIC_ONE_HOOKS_DISABLED',
        message: 'Traffic One is not enabled in Codex config, so its hooks are not runnable.',
      });
    }
    if (hookTrust.evaluation === 'indeterminate') {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_HOOK_TRUST_INDETERMINATE',
        message: `Codex hook trust could not be verified through the official hooks/list API (${hookTrust.reason}${hookTrust.detail ? `: ${hookTrust.detail}` : ''}). Structural config alone is not proof that Traffic One hooks are runnable.`,
      });
    } else {
      if (
        hookTrust.counts.discovered !== hookTrust.expectedCount
        || hookTrust.missingKeys.length > 0
        || hookTrust.unexpectedKeys.length > 0
      ) {
        const missing = hookTrust.missingKeys.length > 0 ? ` Missing: ${hookTrust.missingKeys.join(', ')}.` : '';
        const unexpected = hookTrust.unexpectedKeys.length > 0 ? ` Unexpected: ${hookTrust.unexpectedKeys.join(', ')}.` : '';
        findings.push({
          severity: 'fix-needed',
          code: 'CODEX_TRAFFIC_ONE_HOOK_ABI_MISMATCH',
          message: `Codex discovered ${hookTrust.counts.discovered}/${hookTrust.expectedCount} exact Traffic One hook keys.${missing}${unexpected}`,
        });
      }
      if (codexHooks.pluginEnabled === true && hookTrust.counts.disabled > 0) {
        findings.push({
          severity: 'fix-needed',
          code: 'CODEX_TRAFFIC_ONE_HOOKS_DISABLED',
          message: `${hookTrust.counts.disabled} Traffic One Codex hook${hookTrust.counts.disabled === 1 ? ' is' : 's are'} disabled.`,
        });
      }
      if (
        hookTrust.counts.modified > 0
        || hookTrust.counts.untrusted > 0
        || hookTrust.counts.runnable !== hookTrust.expectedCount
      ) {
        findings.push({
          severity: 'fix-needed',
          code: 'CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED',
          message: `Traffic One Codex hooks are not fully trusted (${hookTrust.counts.modified} modified, ${hookTrust.counts.untrusted} untrusted, ${hookTrust.counts.runnable}/${hookTrust.expectedCount} runnable).`,
        });
      }
    }
    if (codexHooks.trustCovered === false) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_WORKSPACE_UNTRUSTED',
        message: `Current workspace (${codexHooks.cwd}) is not covered by a trusted Codex project root. Codex may skip plugin hooks here; trust this workspace or a parent directory before starting Traffic One work.`,
      });
    }
  }

  if (rawStateHasLegacyShape(rawState)) {
    findings.push({
      severity: 'fix-needed',
      code: 'LEGACY_TRAFFIC_ONE_STATE',
      message: '`.traffic-one/.one.json` uses legacy/ad hoc fields such as `projectMode`, `subagentTeam`, root `codeGraph`, or nested `stack`. Rewrite it to the canonical top-level Traffic One schema.',
    });
  }

  const legacyLocalFields = rawState && typeof rawState === 'object'
    ? ['openCode', 'codeGraphProvider', 'performance', 'team', 'toolchain', 'codeGraphAutoRun', 'graphifyAutoRun']
      .filter((field) => Object.prototype.hasOwnProperty.call(rawState, field))
    : [];
  if (legacyLocalFields.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'LOCAL_PREFERENCES_IN_PROJECT_STATE',
      message: `Project state contains local-only Traffic One fields (${legacyLocalFields.join(', ')}). They should live in the per-user preferences file${project.localPreferencesPath ? ` (${project.localPreferencesPath})` : ''}, not in committed \`.traffic-one/.one.json\`.`,
    });
  }

  if (rawState && Object.prototype.hasOwnProperty.call(rawState, 'codeGraphProvider')) {
    const canonicalProvider = codeGraphProviderFromValue(rawState.codeGraphProvider);
    if (canonicalProvider && rawState.codeGraphProvider !== canonicalProvider) {
      findings.push({
        severity: 'fix-needed',
        code: 'NONCANONICAL_CODE_GRAPH_PROVIDER',
        message: `\`codeGraphProvider\` is ${JSON.stringify(rawState.codeGraphProvider)}; write the canonical lower-case value "${canonicalProvider}".`,
      });
    }
  }

  const stateIssues = onboardingStateIssues(rawState, state);
  if (stateIssues.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'INCOMPLETE_ONBOARDING_STATE',
      message: `Traffic One new-project onboarding state is incomplete or noncanonical: missing/invalid ${stateIssues.join(', ')}. Re-run onboarding and do not continue until Agent Mode, Team Confirmation, project context, Mobile, and Code Graph are resolved.`,
    });
  }

  const runState = project.runState;
  if (runState?.currentRunId) {
    if (!runState.runDirExists) {
      findings.push({
        severity: 'fix-needed',
        code: 'GHOST_CURRENT_RUN_ID',
        message: `\`.traffic-one/.one.json\` currentRunId=${JSON.stringify(runState.currentRunId)} points to no \`.traffic-one/runs/${runState.currentRunId}/\` directory. Doctor is report-only: after confirming no live agents are using it, clear or rotate the run id explicitly.`,
      });
    } else if (!runState.hasOrchestratedArtifacts && runState.maintenanceTerminalOrFallbackPending) {
      findings.push({
        severity: 'info',
        code: runState.maintenanceFallbackAllowed ? 'MAINTENANCE_FALLBACK_PENDING' : 'MAINTENANCE_RUN_TERMINAL',
        message: `currentRunId=${JSON.stringify(runState.currentRunId)} has maintenance metadata (${runState.maintenanceOverallOutcome || runState.maintenanceOutcome || runState.maintenanceOpencodeOutcome || 'unknown'}). This is not a ghost run; Doctor will not rewrite it automatically.`,
      });
    } else if (!runState.hasOrchestratedArtifacts && runState.runJsonStatus !== 'planned') {
      findings.push({
        severity: 'fix-needed',
        code: 'GHOST_CURRENT_RUN_ID',
        message: `\`.traffic-one/.one.json\` currentRunId=${JSON.stringify(runState.currentRunId)} has no orchestrated artifacts (no assignments/digests) and is not a planned run ledger. Doctor will not rewrite it automatically; inspect the run directory, then clear or rotate the id if no live work depends on it.`,
      });
    } else if (runState.runJsonStatus === 'planned' && !runState.hasOrchestratedArtifacts) {
      findings.push({
        severity: 'info',
        code: 'PLANNED_RUN_LEDGER_ONLY',
        message: `currentRunId=${JSON.stringify(runState.currentRunId)} is a planned run ledger only. This is valid pre-orchestration state; \`run.json\` alone does not count as assignments or digests.`,
      });
    }
  }

  if (Array.isArray(project.nestedTrafficOneRoots) && project.nestedTrafficOneRoots.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'NESTED_TRAFFIC_ONE_ROOTS',
      message: `Nested Traffic One state roots were found inside this workspace: ${project.nestedTrafficOneRoots.join(', ')}. Hooks will not delete them automatically; inspect them, then use the cleanup runner in apply mode only after confirming the ancestor workspace root is the real project.`,
    });
  }

  if (node.runningMajor !== null && node.runningMajor < node.requiredMajor && provider === 'gitnexus') {
    if (nvm.installed && nvm.hasV22) {
      findings.push({
        severity: 'info',
        code: 'NODE_LT22_BUT_V22_AVAILABLE',
        message: `Hook process is on Node ${node.runningMajor} but nvm v22 (${nvm.v22Paths?.version}) is installed. The runner uses the absolute v22 path; no action required.`,
      });
    } else if (nvm.installed && !nvm.hasV22) {
      findings.push({
        severity: 'fix-needed',
        code: 'NVM_INSTALLED_NO_V22',
        message: `Hook process is on Node ${node.runningMajor} and nvm has no v22 installed. The GitNexus hook will try to prepare Node 22 automatically after provider approval; choose graphify if you need a provider that does not depend on Node 22.`,
      });
    } else {
      findings.push({
        severity: 'fix-needed',
        code: 'NO_NVM_NO_V22',
        message: `Hook process is on Node ${node.runningMajor} and nvm is not installed. Traffic One cannot prepare GitNexus automatically without a compatible Node 22 path; switch \`codeGraphProvider\` to "graphify" for a Python-based graph provider.`,
      });
    }
  }

  if (gitnexus.crashRiskInOldNvm) {
    findings.push({
      severity: 'fix-needed',
      code: 'GITNEXUS_IN_OLD_NVM_NODE',
      message: `\`gitnexus\` on PATH (${gitnexus.onPath}) lives in an old nvm Node folder — will crash with "SyntaxError: Cannot use import statement" when invoked. The onboarding hook will install a managed GitNexus copy when the provider is selected.`,
    });
  }

  if (provider === 'gitnexus' && state?.mode === 'new-project' && project.nvmrc !== null && /^\d+\.\d+\.\d+$/.test(project.nvmrc) && !project.nvmrc.startsWith('22')) {
    findings.push({
      severity: 'fix-needed',
      code: 'NVMRC_PINNED_TO_OLD_NODE',
      message: `Project's .nvmrc pins Node ${project.nvmrc}, but gitnexus needs Node >=22. cd-ing into this project will yank Node down via nvm. Overwrite \`.nvmrc\` with \`22\` to lock the project to a compatible version.`,
    });
  }

  if (provider === 'gitnexus' && !project.hasGit && !project.artefacts.gitnexus) {
    findings.push({
      severity: 'info',
      code: 'NO_GIT_DIR',
      message: 'No `.git/` directory at project root. The runner auto-passes `--skip-git` to gitnexus for non-git folders; no action required unless you want git-aware analysis (then `git init`).',
    });
  }

  if (provider === 'gitnexus' && project.artefacts.gitnexus) {
    const ageDays = (Date.now() - project.artefacts.gitnexus.mtimeMs) / (24 * 60 * 60 * 1000);
    if (ageDays > 7) {
      findings.push({
        severity: 'info',
        code: 'GITNEXUS_STALE',
        message: `\`.traffic-one/.gitnexus/\` is ${Math.round(ageDays)} days old. The next build or session refreshes it automatically (the gitnexus runner rebuilds and relocates it under .traffic-one/).`,
      });
    }
  }

  if (state && typeof state.gitnexusLastError === 'string') {
    findings.push({
      severity: 'fix-needed',
      code: 'LAST_RUN_FAILED',
      message: `Most recent gitnexus runner failed: ${state.gitnexusLastError.split('\n')[0]}`,
    });
  }

  if (state && typeof state.graphifyLastError === 'string') {
    findings.push({
      severity: 'fix-needed',
      code: 'LAST_RUN_FAILED',
      message: `Most recent graphify runner failed: ${state.graphifyLastError.split('\n')[0]}`,
    });
  }

  if (rawState && !provider) {
    findings.push({
      severity: 'fix-needed',
      code: 'MISSING_CODE_GRAPH_PROVIDER',
      message: `No local code graph provider is configured for this user/project. Choose GitNexus or graphify and save it to local preferences${project.localPreferencesPath ? ` (${project.localPreferencesPath})` : ''}; do not commit this choice to \`.traffic-one/.one.json\`.`,
    });
  }

  // OpenCode delegation readiness. Only meaningful when the user enabled it in
  // the wizard; every finding here is self-healing (SessionStart re-registers
  // the Codex MCP server and re-attempts the managed install), so the messages
  // say what will happen automatically and what one-time action remains.
  const openCode = state && state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode?.enabled === true) {
    if (project.openCodeCli === 'missing') {
      findings.push({
        severity: 'fix-needed',
        code: 'OPENCODE_CLI_MISSING',
        tool: 'opencode',
        message: 'OpenCode delegation is enabled but the OpenCode CLI is not installed (managed install absent, nothing on PATH). The next session start auto-installs it in the background — make sure `npm` is on PATH. Until then every delegation falls back to a paid subagent.',
      });
    } else if (project.openCodeCli === 'path') {
      findings.push({
        severity: 'info',
        code: 'OPENCODE_CLI_UNMANAGED',
        tool: 'opencode',
        message: 'OpenCode delegation resolves a PATH-installed `opencode` (no Traffic One managed install), so its version is not pinned by the plugin. Works, but behavior may drift from the tested pinned version.',
      });
    }
    if (codexHooks && codexHooks.configExists && codexHooks.opencodeMcpRegistered === false) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_OPENCODE_MCP_NOT_REGISTERED',
        message: 'The opencode-worker MCP server is not registered in ~/.codex/config.toml, so the opencode_delegate tool is unavailable in Codex. The next session start registers it automatically; restart Codex once afterwards to load it.',
      });
    }
    if (openCodeMcp && !openCodeMcp.binShimExists) {
      findings.push({
        severity: 'fix-needed',
        code: 'CURSOR_OPENCODE_MCP_UNHEALTHY',
        message: `The version-stable opencode-worker MCP shim is missing at ${openCodeMcp.binShimPath}. Cursor launches MCP with CWD=$HOME and no plugin root — without this shim the server dies on startup (toolCount:0). Reload the window after sessionStart or run onboarding so Traffic One writes ~/.traffic-one/bin shims.`,
        recommendedCommand: 'node "${TRAFFIC_ONE_PLUGIN_ROOT:-.}/scripts/hook-runtime.cjs" session-start',
      });
    } else if (openCodeMcp && !openCodeMcp.pluginShimExists && openCodeMcp.pluginShimPath) {
      findings.push({
        severity: 'info',
        code: 'CURSOR_OPENCODE_MCP_UNHEALTHY',
        message: `opencode-worker plugin shim not found at ${openCodeMcp.pluginShimPath}; the bin fallback at ${openCodeMcp.binShimPath} should still work when present.`,
      });
    }
  }

  // Toolchain version drift. Walk `state.toolchain.*` against the toolchain
  // spec and emit one finding per tool below `minimum` (fix-needed) or below
  // `recommended` (info nudge).
  try {
    const stamps = (state && state.toolchain && typeof state.toolchain === 'object' ? state.toolchain : {}) as Rec;
    for (const [name, stampRaw] of Object.entries(stamps)) {
      const stamp = stampRaw && typeof stampRaw === 'object' ? (stampRaw as Rec) : {};
      const status = toolStatus(name, stamp.installedVersion);
      if (status.status === 'too-old' || status.status === 'outdated') {
        const severity: Finding['severity'] = status.status === 'too-old' ? 'fix-needed' : 'info';
        findings.push({
          severity,
          code: 'TOOLCHAIN_OUTDATED',
          tool: name,
          message: `${name} ${status.installed} installed; ${status.status === 'too-old' ? `minimum supported is ${status.minimum}` : `recommended is ${status.recommended}`}. Traffic One hooks install/upgrade selected tools automatically.`,
        });
      }
    }
  } catch {
    // toolchain spec missing or malformed; never block doctor on it.
  }

  return findings;
}
