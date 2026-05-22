#!/usr/bin/env node
'use strict';

// scripts/doctor.cjs
// Proactive diagnostic for traffic-one. Inspects the environment for the
// known-fragile spots (Node version, nvm default, gitnexus binary
// location, project `.nvmrc`, `.git/`, traffic-one state file) and
// produces a structured JSON report. The `traffic-one-doctor` skill
// runs this and surfaces the findings to the user with recommendations.
//
// Output: JSON to stdout. The report is purely informational — doctor.cjs
// never writes to the project, never installs anything, never modifies the
// state file. The skill (or user) decides what to do with the findings.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = require('./gitnexus-runner.cjs');
const {
  STACK_IDS,
} = require('./hook-runtime/config.cjs');
const {
  normalizeState,
  hasValidTeamState,
  hasValidProjectContext,
  hasValidPerformanceState,
  isTeamApproved,
  codeGraphProviderFromValue,
} = require('./hook-runtime/state.cjs');
const {
  teamModeForLevel,
} = require('./hook-runtime/agents-performance-prompt.cjs');

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf8' });
  if (r.status === 0 && typeof r.stdout === 'string') {
    const out = r.stdout.trim();
    return out.length > 0 ? out : null;
  }
  return null;
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function probeNode() {
  return {
    runningMajor: runner.currentNodeMajor(),
    runningVersion: process.versions.node,
    onPath: which('node'),
    requiredMajor: runner.GITNEXUS_MIN_NODE_MAJOR,
  };
}

function probeNvm() {
  const home = process.env.HOME || '';
  const installed = runner.nvmPresent();
  if (!installed) return { installed: false };
  const nvmRoot = path.join(home, '.nvm');
  const defaultAlias = (safeRead(path.join(nvmRoot, 'alias', 'default')) || '').trim();
  let versions = [];
  try {
    versions = fs.readdirSync(path.join(nvmRoot, 'versions', 'node'))
      .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
      .sort();
  } catch { /* empty */ }
  const nvm22 = runner.findNvmNode22();
  return {
    installed: true,
    root: nvmRoot,
    defaultAlias,
    installedVersions: versions,
    hasV22: !!nvm22,
    v22Paths: nvm22,
    installCommand: nvm22 ? null : runner.nvmInstallCommand(),
  };
}

function probeGitnexus() {
  const fromPath = which('gitnexus');
  const nvm22 = runner.findNvmNode22();
  return {
    onPath: fromPath,
    absoluteV22: nvm22 ? nvm22.gitnexus : null,
    // A pre-existing gitnexus living inside an OLDER nvm Node folder is
    // the "installed via --force, will crash" landmine. Flag it.
    crashRiskInOldNvm: !!(fromPath && /\/\.nvm\/versions\/node\/v(?!22)[\d.]+\/bin\/gitnexus$/.test(fromPath)),
  };
}

function probeProject(cwd) {
  const trafficOne = safeRead(path.join(cwd, '.traffic-one.json'));
  let state = null;
  if (trafficOne) { try { state = JSON.parse(trafficOne); } catch { state = null; } }
  let normalizedState = null;
  if (state && typeof state === 'object') {
    normalizedState = JSON.parse(JSON.stringify(state));
    normalizeState(normalizedState, normalizedState.mode || normalizedState.projectMode || 'new-project');
  }
  const nvmrcRaw = safeRead(path.join(cwd, '.nvmrc'));
  const gitDir = safeStat(path.join(cwd, '.git'));
  const gitnexusOut = safeStat(path.join(cwd, '.gitnexus'));
  const graphifyOut = safeStat(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'));
  return {
    cwd,
    hasState: !!state,
    state,
    normalizedState,
    nvmrc: nvmrcRaw === null ? null : nvmrcRaw.trim(),
    hasGit: !!gitDir && gitDir.isDirectory(),
    artefacts: {
      gitnexus: gitnexusOut ? { mtimeMs: gitnexusOut.mtimeMs } : null,
      graphify: graphifyOut ? { mtimeMs: graphifyOut.mtimeMs } : null,
    },
  };
}

function normalizedProjectState(project) {
  if (project.normalizedState && typeof project.normalizedState === 'object') {
    return project.normalizedState;
  }
  if (!project.state || typeof project.state !== 'object') return null;
  const cloned = JSON.parse(JSON.stringify(project.state));
  normalizeState(cloned, cloned.mode || cloned.projectMode || 'new-project');
  return cloned;
}

function rawStateHasLegacyShape(state) {
  if (!state || typeof state !== 'object') return false;
  return Boolean(
    Object.prototype.hasOwnProperty.call(state, 'projectMode')
    || Object.prototype.hasOwnProperty.call(state, 'subagentTeam')
    || Object.prototype.hasOwnProperty.call(state, 'codeGraph')
    || (state.stack && typeof state.stack === 'object' && !Array.isArray(state.stack)),
  );
}

function onboardingStateIssues(rawState, state) {
  const issues = [];
  if (!state || typeof state !== 'object') return ['state file is not a JSON object'];
  const mode = state.mode || rawState?.projectMode;
  if (mode !== 'new-project') return issues;
  const persistedState = rawState && typeof rawState === 'object' ? rawState : state;

  if (state.mode !== 'new-project') issues.push('mode');
  if (typeof state.stack !== 'string' || !STACK_IDS.has(state.stack)) issues.push('stack');
  if (state.codeGraphProvider !== 'gitnexus' && state.codeGraphProvider !== 'graphify') {
    issues.push('codeGraphProvider');
  }
  if (!hasValidPerformanceState(state.performance)) issues.push('performance');
  if (!hasValidProjectContext(state.projectContext)) issues.push('projectContext');
  if (!hasValidTeamState(state.team)) {
    issues.push('team');
  } else if (hasValidPerformanceState(state.performance)) {
    const expectedTeamMode = teamModeForLevel(state.performance.level);
    if (state.team.mode !== expectedTeamMode) {
      issues.push('team.mode');
    }
    if (
      expectedTeamMode === 'subagents'
      && state.team.source !== 'unavailable'
      && !isTeamApproved(state.team)
    ) {
      issues.push('team.approved (Team Confirmation)');
    }
  }
  if (persistedState.confirmed !== true) issues.push('confirmed');
  if (persistedState.onboardingComplete !== true) issues.push('onboardingComplete');
  if (typeof persistedState.confirmedAt !== 'string' || persistedState.confirmedAt.trim() === '') issues.push('confirmedAt');
  return [...new Set(issues)];
}

function buildFindings({ node, nvm, gitnexus, project }) {
  const findings = [];
  const rawState = project.state && typeof project.state === 'object' ? project.state : null;
  const state = normalizedProjectState(project);
  const provider = state && typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;

  if (rawStateHasLegacyShape(rawState)) {
    findings.push({
      severity: 'fix-needed',
      code: 'LEGACY_TRAFFIC_ONE_STATE',
      message: '`.traffic-one.json` uses legacy/ad hoc fields such as `projectMode`, `subagentTeam`, root `codeGraph`, or nested `stack`. Rewrite it to the canonical top-level Traffic One schema.',
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
        message: `Hook process is on Node ${node.runningMajor} but nvm v22 (${nvm.v22Paths.version}) is installed. The runner uses the absolute v22 path; no action required.`,
      });
    } else if (nvm.installed && !nvm.hasV22) {
      findings.push({
        severity: 'fix-needed',
        code: 'NVM_INSTALLED_NO_V22',
        message: `Hook process is on Node ${node.runningMajor} and nvm has no v22 installed. Run the install command below.`,
        recommendedCommand: nvm.installCommand,
      });
    } else {
      findings.push({
        severity: 'fix-needed',
        code: 'NO_NVM_NO_V22',
        message: `Hook process is on Node ${node.runningMajor} and nvm is not installed. Install nvm (https://github.com/nvm-sh/nvm) then run \`nvm install 22 && nvm alias default 22\`. Or switch \`codeGraphProvider\` to "graphify" (Python; any Node).`,
      });
    }
  }

  if (gitnexus.crashRiskInOldNvm) {
    findings.push({
      severity: 'fix-needed',
      code: 'GITNEXUS_IN_OLD_NVM_NODE',
      message: `\`gitnexus\` on PATH (${gitnexus.onPath}) lives in an old nvm Node folder — will crash with "SyntaxError: Cannot use import statement" when invoked. Reinstall against Node 22: \`npm install -g gitnexus\` from a shell with Node 22 active.`,
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
        message: `\`.gitnexus/\` is ${Math.round(ageDays)} days old. The next build will refresh it; or manually run \`gitnexus analyze .\` to update now.`,
      });
    }
  }

  if (state?.gitnexusLastError) {
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
      message: 'State file has no `codeGraphProvider` field. Re-run onboarding to add it (gitnexus or graphify).',
    });
  }

  // Toolchain version drift. Walk `state.toolchain.*` against
  // `scripts/toolchain-versions.json` and emit one finding per tool whose
  // installed version sits below `minimum` (fix-needed) or below
  // `recommended` (info nudge).
  try {
    const toolchain = require('./toolchain.cjs');
    const stamps = (state && state.toolchain) || {};
    for (const [name, stamp] of Object.entries(stamps)) {
      const status = toolchain.toolStatus(name, stamp && stamp.installedVersion);
      if (status.status === 'too-old' || status.status === 'outdated') {
        const spec = toolchain.getToolSpec(name) || {};
        const severity = status.status === 'too-old' ? 'fix-needed' : 'info';
        const upgrade = spec.installCommand || `<upgrade ${name}>`;
        findings.push({
          severity,
          code: 'TOOLCHAIN_OUTDATED',
          tool: name,
          message: `${name} ${status.installed} installed; ${status.status === 'too-old' ? `minimum supported is ${status.minimum}` : `recommended is ${status.recommended}`}. Upgrade: \`${upgrade}\`.`,
          recommendedCommand: upgrade,
        });
      }
    }
  } catch {
    // toolchain module missing or malformed; never block doctor on it.
  }

  return findings;
}

function main() {
  const cwd = process.cwd();
  const node = probeNode();
  const nvm = probeNvm();
  const gitnexus = probeGitnexus();
  const project = probeProject(cwd);
  const findings = buildFindings({ node, nvm, gitnexus, project });
  const summary = findings.some((f) => f.severity === 'fix-needed')
    ? 'ACTION_NEEDED'
    : (findings.length > 0 ? 'INFO_ONLY' : 'HEALTHY');

  process.stdout.write(JSON.stringify({
    summary,
    findings,
    probes: { node, nvm, gitnexus, project },
    version: typeof project.state?.version === 'string' ? project.state.version : null,
  }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { probeNode, probeNvm, probeGitnexus, probeProject, buildFindings };
