'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  STACK_IDS,
} = require('../hook-runtime/config.cjs');
const {
  normalizeState,
  hasValidTeamState,
  hasValidProjectContext,
  hasValidPerformanceState,
  isTeamApproved,
  codeGraphProviderFromValue,
} = require('../hook-runtime/state/state.cjs');
const {
  teamModeForLevel,
} = require('../hook-runtime/agents-performance-prompt.cjs');
const auth = require('../traffic-one-auth.cjs');

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

function mcpConfigPath() {
  return path.join(path.resolve(__dirname, '..', '..'), '.mcp.json');
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

module.exports = {
  STACK_IDS,
  normalizeState,
  hasValidTeamState,
  hasValidProjectContext,
  hasValidPerformanceState,
  isTeamApproved,
  codeGraphProviderFromValue,
  teamModeForLevel,
  auth,
  which,
  safeRead,
  safeStat,
  safeJsonParse,
  parseArgs,
  codexConfigPath,
  parseTomlScalar,
  parseCodexConfigToml,
  trustedProjectForCwd,
  mcpConfigPath,
  codexSessionsDir,
  walkJsonlFiles,
  readFirstJsonlObject,
  sessionIdFromFile,
  getPayloadText,
  commandLooksMutating,
  authProbeForSession,
  normalizedProjectState,
  rawStateHasLegacyShape,
  onboardingStateIssues,
};
