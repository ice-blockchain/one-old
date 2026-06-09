// src/runners/doctor/findings.ts
// Turns the doctor probes into a flat list of severity-tagged findings. Ported
// 1:1 from scripts/doctor/buildFindings.cjs. Pure: derives messages from probe
// data; never reads the filesystem itself except via the toolchain spec.

import { toolStatus } from '../toolchain';
import { codeGraphProviderFromValue, normalizedProjectState, onboardingStateIssues, rawStateHasLegacyShape } from './lib';
import type {
  CodexHooksProbe,
  GitnexusProbe,
  McpAuthProbe,
  NodeProbe,
  NvmProbe,
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
  mcpAuth?: McpAuthProbe | null;
  sessionDiagnostics?: SessionDiagnosticsResult;
}

export function buildFindings({ node, nvm, gitnexus, project, codexHooks = null, sessionDiagnostics = null }: BuildFindingsInput): Finding[] {
  const findings: Finding[] = [];
  const rawState = project.state && typeof project.state === 'object' ? project.state : null;
  const state = normalizedProjectState(project as unknown as Rec);
  const provider = state && typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;

  if (sessionDiagnostics) {
    if (sessionDiagnostics.found === false) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_SESSION_NOT_FOUND',
        message: `Could not find Codex session ${sessionDiagnostics.id} under ${sessionDiagnostics.sessionsDir}.`,
      });
    } else {
      if (sessionDiagnostics.hookPayloadCount === 0 && sessionDiagnostics.promptRequestCount === 0) {
        findings.push({
          severity: 'fix-needed',
          code: 'CODEX_HOOKS_NOT_INVOKED_FOR_SESSION',
          message: `Codex session ${sessionDiagnostics.id} contains no Traffic One hook payloads or prompt requests. Hooks likely did not run for cwd ${sessionDiagnostics.cwd || '(unknown)'}.`,
        });
      }
      if (sessionDiagnostics.trafficOneInstructionInjected === false) {
        findings.push({
          severity: 'fix-needed',
          code: 'TRAFFIC_ONE_INSTRUCTIONS_NOT_INJECTED',
          message: `Codex session ${sessionDiagnostics.id} did not receive Traffic One root instructions at session start. Skill metadata may still be visible, but plugin instructions were not active.`,
        });
      }
      if (sessionDiagnostics.authState && sessionDiagnostics.authState.expiredAtSessionStart) {
        findings.push({
          severity: 'fix-needed',
          code: 'TRAFFIC_ONE_AUTH_EXPIRED_AT_SESSION_START',
          message: `Traffic One auth state expired at ${sessionDiagnostics.authState.expiresAt} before Codex session ${sessionDiagnostics.id} started. A working hook should have shown the re-auth prompt before Traffic One work.`,
        });
      }
      if (sessionDiagnostics.mutatingToolBeforeAuthGate) {
        findings.push({
          severity: 'fix-needed',
          code: 'SESSION_MUTATED_BEFORE_TRAFFIC_ONE_AUTH_GATE',
          message: `Codex session ${sessionDiagnostics.id} used a mutating tool before any Traffic One auth gate appeared. Treat generated artifacts from that session as untrusted Traffic One output.`,
        });
      }
    }
  }

  if (codexHooks && codexHooks.configExists) {
    if (codexHooks.pluginEnabled !== true) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_TRAFFIC_ONE_PLUGIN_DISABLED',
        message: 'Traffic One is not enabled in Codex config, so Codex will not invoke Traffic One hooks.',
      });
    }
    if (
      codexHooks.hookStateEntryCount === 0
      || codexHooks.hookStateEnabledCount !== codexHooks.hookStateEntryCount
      || codexHooks.hookStateTrustedHashCount !== codexHooks.hookStateEntryCount
      || (Array.isArray(codexHooks.missingHookEvents) && codexHooks.missingHookEvents.length > 0)
    ) {
      const missing = Array.isArray(codexHooks.missingHookEvents) && codexHooks.missingHookEvents.length > 0
        ? ` Missing hook events: ${codexHooks.missingHookEvents.join(', ')}.`
        : '';
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED',
        message: `Traffic One Codex hook trust records are missing, disabled, or missing trusted hashes; hooks can be skipped or withheld.${missing}`,
      });
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

  if (rawState && !provider) {
    findings.push({
      severity: 'fix-needed',
      code: 'MISSING_CODE_GRAPH_PROVIDER',
      message: `No local code graph provider is configured for this user/project. Choose GitNexus or graphify and save it to local preferences${project.localPreferencesPath ? ` (${project.localPreferencesPath})` : ''}; do not commit this choice to \`.traffic-one/.one.json\`.`,
    });
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
