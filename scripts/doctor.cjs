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
const os = require('os');
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
const auth = require('./traffic-one-auth.cjs');

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

function safeJsonParse(text, fallback = null) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { session: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--session' && argv[index + 1]) {
      out.session = argv[index + 1];
      index += 1;
    }
  }
  return out;
}

function codexConfigPath(env = process.env) {
  const codexHome = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : '');
  return codexHome ? path.join(codexHome, 'config.toml') : null;
}

function parseTomlScalar(value) {
  const trimmed = String(value || '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const quoted = trimmed.match(/^"((?:\\"|[^"])*)"$/);
  if (quoted) return quoted[1].replace(/\\"/g, '"');
  return trimmed;
}

function parseCodexConfigToml(text) {
  const sections = {};
  let current = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections[current] = sections[current] || {};
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/);
    if (!keyMatch || !current) continue;
    const key = keyMatch[1].replace(/^"|"$/g, '');
    sections[current][key] = parseTomlScalar(keyMatch[2]);
  }
  return sections;
}

function trustedProjectForCwd(cwd, sections) {
  const resolvedCwd = path.resolve(cwd);
  let best = null;
  for (const [section, values] of Object.entries(sections || {})) {
    const match = section.match(/^projects\."(.+)"$/);
    if (!match) continue;
    if (!values || values.trust_level !== 'trusted') continue;
    const projectRoot = path.resolve(match[1]);
    const covered = resolvedCwd === projectRoot || resolvedCwd.startsWith(`${projectRoot}${path.sep}`);
    if (!covered) continue;
    if (!best || projectRoot.length > best.length) best = projectRoot;
  }
  return best;
}

function probeCodexHooks(cwd, env = process.env) {
  const configPath = codexConfigPath(env);
  const text = configPath ? safeRead(configPath) : null;
  if (!text) {
    return {
      host: 'codex',
      configPath,
      configExists: false,
      cwd: path.resolve(cwd),
    };
  }

  const sections = parseCodexConfigToml(text);
  const pluginSection = sections['plugins."traffic-one@traffic-one-local"'] || null;
  const hookSections = Object.entries(sections)
    .filter(([section]) => section.startsWith('hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:'));
  const hookEvents = new Set();
  let hookStateEnabledCount = 0;
  let hookStateTrustedHashCount = 0;
  for (const [section, values] of hookSections) {
    const eventMatch = section.match(/hooks\/hooks\.json:([^:]+):/);
    if (eventMatch) hookEvents.add(eventMatch[1]);
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

function mcpConfigPath() {
  return path.join(path.resolve(__dirname, '..'), '.mcp.json');
}

function probeMcpAuth(env = process.env) {
  const configPath = mcpConfigPath();
  const raw = safeRead(configPath);
  const config = raw ? safeJsonParse(raw, null) : null;
  const server = config
    && config.mcpServers
    && typeof config.mcpServers === 'object'
    ? config.mcpServers['mcp-auth']
    : null;
  const bearerTokenEnvVar = server && typeof server.bearer_token_env_var === 'string'
    ? server.bearer_token_env_var
    : null;
  const envPresent = bearerTokenEnvVar
    ? typeof env[bearerTokenEnvVar] === 'string' && env[bearerTokenEnvVar].trim() !== ''
    : false;
  return {
    configPath,
    configExists: Boolean(raw),
    configured: Boolean(server),
    type: server && typeof server.type === 'string' ? server.type : null,
    url: server && typeof server.url === 'string' ? server.url : null,
    bearerTokenEnvVar,
    envPresent,
  };
}

function codexSessionsDir(env = process.env) {
  const codexHome = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : path.join(os.homedir(), '.codex'));
  return path.join(codexHome, 'sessions');
}

function walkJsonlFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(fullPath);
    }
  }
  return out;
}

function readFirstJsonlObject(filePath) {
  let text = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytes).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/, 1)[0];
  return safeJsonParse(line, null);
}

function sessionIdFromFile(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : path.basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}

function resolveCodexSession(sessionId, env = process.env) {
  const root = codexSessionsDir(env);
  const files = walkJsonlFiles(root);
  const direct = files.find((filePath) => path.basename(filePath).includes(sessionId));
  if (direct) return direct;
  for (const filePath of files) {
    const first = readFirstJsonlObject(filePath);
    const payload = first && first.payload && typeof first.payload === 'object' ? first.payload : {};
    if (payload.id === sessionId) return filePath;
  }
  return null;
}

function getPayloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return [
    payload.base_instructions && payload.base_instructions.text,
    payload.instructions && payload.instructions.text,
    payload.user_instructions && payload.user_instructions.text,
  ].filter((value) => typeof value === 'string').join('\n');
}

function commandLooksMutating(name, rawArgs) {
  if (name === 'apply_patch') return true;
  if (name === 'request_plugin_install' || name === 'automation_update') return true;
  if (name !== 'exec_command') return false;
  const args = safeJsonParse(rawArgs, {});
  const command = typeof args.cmd === 'string' ? args.cmd : String(rawArgs || '');
  return /\b(apply_patch|npm\s+install|pnpm\s+(install|add|approve-builds|rebuild)|yarn\s+(install|add)|bun\s+(install|add)|npx\s+create-|mkdir\b|touch\b|rm\b|mv\b|cp\b|rsync\b|git\s+(init|checkout|reset|clean)|tee\b|cat\s*>|>\s*[^&])/.test(command);
}

function authProbeForSession(sessionStartedAt, env = process.env) {
  const filePath = auth.authStatePath(env);
  const state = auth.readAuthState(env);
  const startedMs = Date.parse(sessionStartedAt || '');
  const expiresMs = Date.parse(state && state.expiresAt ? state.expiresAt : '');
  const expiredAtSessionStart = Boolean(
    state
    && Number.isFinite(startedMs)
    && Number.isFinite(expiresMs)
    && expiresMs <= startedMs
  );
  return {
    filePath,
    present: Boolean(state),
    expiresAt: state && typeof state.expiresAt === 'string' ? state.expiresAt : null,
    expiredAtSessionStart,
  };
}

function analyzeCodexSessionFile(filePath, env = process.env) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  const diagnostics = {
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
    const timestamp = parsed.timestamp || null;
    const serialized = JSON.stringify(parsed);
    if (serialized.includes('hookSpecificOutput')) diagnostics.hookPayloadCount += 1;
    if (serialized.includes('promptRequest')) diagnostics.promptRequestCount += 1;
    if (serialized.includes('permissionDecision')) diagnostics.permissionDecisionCount += 1;
    if (serialized.includes('traffic-one.auth.choice')) {
      diagnostics.trafficOneAuthPromptCount += 1;
      if (!diagnostics.firstAuthGateAt) diagnostics.firstAuthGateAt = timestamp;
    }

    if (parsed.type === 'session_meta') {
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      diagnostics.id = typeof payload.id === 'string' ? payload.id : diagnostics.id;
      diagnostics.cwd = typeof payload.cwd === 'string' ? payload.cwd : diagnostics.cwd;
      diagnostics.startedAt = payload.timestamp || timestamp || diagnostics.startedAt;
      const instructionText = getPayloadText(payload);
      diagnostics.baseInstructionsMentionTrafficOne = /Traffic One|traffic-one|\.traffic-one/.test(instructionText);
      diagnostics.trafficOneInstructionInjected = /Traffic One Codex Instructions|\.traffic-one\/rules\/common\/auth-gate\.md|Authenticate with the `mcp-auth` server/.test(instructionText);
      continue;
    }

    if (parsed.type !== 'response_item') continue;
    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
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
    )
  );
  return diagnostics;
}

function probeSessionDiagnostics(sessionId, env = process.env) {
  if (!sessionId) return null;
  const filePath = resolveCodexSession(sessionId, env);
  if (!filePath) {
    return {
      id: sessionId,
      found: false,
      sessionsDir: codexSessionsDir(env),
    };
  }
  return {
    found: true,
    ...analyzeCodexSessionFile(filePath, env),
  };
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

function buildFindings({ node, nvm, gitnexus, project, codexHooks = null, mcpAuth = null, sessionDiagnostics = null }) {
  const findings = [];
  const rawState = project.state && typeof project.state === 'object' ? project.state : null;
  const state = normalizedProjectState(project);
  const provider = state && typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;

  if (mcpAuth && mcpAuth.configured && mcpAuth.bearerTokenEnvVar && mcpAuth.envPresent === false) {
    findings.push({
      severity: 'fix-needed',
      code: 'MCP_AUTH_ENV_MISSING',
      message: `The mcp-auth MCP server is configured but ${mcpAuth.bearerTokenEnvVar} is not set for this process. Codex can still run, but Traffic One MCP auth startup is incomplete and Traffic One features must stay gated until authentication is resolved.`,
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
  const args = parseArgs();
  const cwd = process.cwd();
  const node = probeNode();
  const nvm = probeNvm();
  const gitnexus = probeGitnexus();
  const project = probeProject(cwd);
  const codexHooks = probeCodexHooks(cwd);
  const mcpAuth = probeMcpAuth();
  const sessionDiagnostics = probeSessionDiagnostics(args.session);
  const findings = buildFindings({ node, nvm, gitnexus, project, codexHooks, mcpAuth, sessionDiagnostics });
  const summary = findings.some((f) => f.severity === 'fix-needed')
    ? 'ACTION_NEEDED'
    : (findings.length > 0 ? 'INFO_ONLY' : 'HEALTHY');

  process.stdout.write(JSON.stringify({
    summary,
    findings,
    probes: { node, nvm, gitnexus, project, codexHooks, mcpAuth, sessionDiagnostics },
    version: typeof project.state?.version === 'string' ? project.state.version : null,
  }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  probeNode,
  probeNvm,
  probeGitnexus,
  probeProject,
  probeCodexHooks,
  probeMcpAuth,
  probeSessionDiagnostics,
  analyzeCodexSessionFile,
  resolveCodexSession,
  buildFindings,
};
