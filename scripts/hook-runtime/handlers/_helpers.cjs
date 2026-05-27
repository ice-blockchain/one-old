'use strict';

// scripts/hook-runtime/handlers/_helpers.cjs
// Shared private utilities + constants used across the handler clusters
// (auth, session-start, prompt-submit, gates, post). Function bodies are moved
// verbatim from the original single-file handlers.cjs; only require paths were
// rewritten for the new folder depth.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const {
  STATE_FILE,
  LEGACY_STATE_FILE,
  BUDGET_CHARS,
  RN_STACKS,
  WEB_STACKS,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
  pluginRoot,
} = require('../config.cjs');

const {
  parseJsonText,
  safeReadJson,
  nowIso,
  readState,
  writeState,
  statePath,
  legacyStatePath,
  normalizeState,
  initializeToolchainState,
  hasValidTeamState,
  hasValidProjectContext,
  hasValidPerformanceState,
  hasResolvedOpenCodeState,
  isTeamApproved,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  stackFingerprint,
  getPluginVersion,
  isMaterialized,
  isSubagentSession,
  activeAgentRole,
  ensureRunAgentClaim,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
  isFixCycleSession,
  getSpawnIndex,
  VALID_AGENT_ROLES,
} = require('../state/state.cjs');

const {
  PERFORMANCE_LEVEL_IDS,
  performanceChatFallback,
  modelForRoleHost,
  teamModeForLevel,
} = require('../agents-performance-prompt.cjs');

const { openCodeChatFallback, openCodeOptInDirective } = require('../opencode-prompt.cjs');

const { STACKS, stackSpecForState, roleScopedRules } = require('../stacks/stacks.cjs');

const {
  listAllSkills,
  pruneSkillsDirective,
  cleanActiveSkills,
  copyActiveSkills,
} = require('../skill-filters/skill-filters.cjs');

const {
  loadPackageJson,
  dependenciesFromPackage,
  detectMode,
  detectStackFromCodebase,
  classifyPromptForStack,
} = require('../detection/detection.cjs');

const { packBundle, packRuleIndex, packFixCycleHeader } = require('../packing.cjs');
const {
  materializeProjectAssets,
  hasMaterializedProjectAssets,
  isPluginAuthoringRoot,
} = require('../materialize/materialize.cjs');
const {
  computeProjectFingerprint,
} = require('../../security-check-runner.cjs');
const {
  maybeStartOneMcpReport,
} = require('../../one-mcp-report.cjs');
const {
  FRESHNESS_REASON,
  authRemoteCheckDue,
  authRequiredMessage,
  authStateFreshness,
  authStatePath,
  isAuthenticatedLocal,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
  readAuthState: readTrafficOneAuthState,
} = require('../../traffic-one-auth.cjs');

const {
  onboardingDirectiveNewProject,
  autoDetectedAnnouncement,
  onboardingReminderShort,
  postWriteIncompleteWarning,
  hostPopupInstruction,
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
} = require('../directives/directives.cjs');
const {
  teamConfirmationChatFallback,
} = require('../agents-team-confirmation-prompt.cjs');

const tokenLogger = require('../token-logger.cjs');

// authGateForHook lives in the auth cluster. To avoid a load-time circular
// require (auth.cjs destructures from this file at its top), resolve it lazily
// inside startOneMcpReportBestEffort at call time rather than at module scope.

// ── Token-economy banner: surface graphify report + recent digests ─────────
// Single-line hints appended to the SessionStart header when these on-disk
// artefacts exist. They tell the agent "you have a cache; consult it before
// grep/glob" without inflating the bundle.
function tokenEconomyBanner(cwd) {
  const lines = [];
  const memoryPaths = [
    '.traffic-one/product.md',
    '.traffic-one/stack.md',
    '.traffic-one/coding.md',
    '.traffic-one/security.md',
    '.traffic-one/known-issues.md',
    '.traffic-one/agent-log.md',
  ];
  if (memoryPaths.some((relPath) => fs.existsSync(path.join(cwd, relPath)))) {
    lines.push('[memory] .traffic-one/ project memory present — read product/stack/rules/known-issues before broad source reads.');
  }
  // Codebase-graph banner. Both providers can show simultaneously if both
  // artefacts exist on disk (e.g. user switched provider mid-project); the
  // active one per `.traffic-one/.one.json` is what subagents will read.
  const graphifyPath = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
  if (fs.existsSync(graphifyPath)) {
    lines.push('[graph: graphify] graphify-out/GRAPH_REPORT.md present — consult before grep/glob for module/structure questions.');
  }
  const gitnexusPath = path.join(cwd, '.gitnexus');
  if (fs.existsSync(gitnexusPath)) {
    lines.push('[graph: gitnexus] .gitnexus/ present — consult before grep/glob for module/structure questions.');
  }
  try {
    const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
    if (fs.existsSync(digestsRoot)) {
      const runs = fs.readdirSync(digestsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      if (runs.length > 0) {
        lines.push(`[digests] Latest orchestrator run: .traffic-one/digests/${runs[0]}/ — read predecessor digests before re-reading the diff.`);
      }
    }
  } catch {
    // best-effort; banner is informational
  }
  // Toolchain drift hints. Walk `.traffic-one/.one.json` → `toolchain.*` and
  // surface a one-line nudge per tool whose installed version sits below
  // the plugin's curated `recommended` (or below `minimum` — louder).
  // The curated spec lives at `scripts/toolchain-versions.json`; bump it
  // there to update what every project sees on its next SessionStart.
  try {
    const stateFile = existingStateFilePath(cwd);
    if (fs.existsSync(stateFile)) {
      const state = safeReadJson(stateFile, {});
      const toolchain = (state && state.toolchain) || {};
      if (Object.keys(toolchain).length > 0) {
        const tch = require(path.resolve(__dirname, '..', '..', 'toolchain.cjs'));
        for (const [name, stamp] of Object.entries(toolchain)) {
          const status = tch.toolStatus(name, stamp && stamp.installedVersion);
          if (status.status === 'too-old') {
            const spec = tch.getToolSpec(name) || {};
            lines.push(`[toolchain] ${name} ${status.installed} is below the minimum supported (${status.minimum}). Upgrade: \`${spec.installCommand || `<upgrade ${name}>`}\`.`);
          } else if (status.status === 'outdated') {
            lines.push(`[toolchain] ${name} ${status.installed} installed; recommended is ${status.recommended}.`);
          }
        }
      }
    }
  } catch {
    // best-effort; banner is informational
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function isKnownStack(stack) {
  return STACK_IDS.has(stack) || Object.prototype.hasOwnProperty.call(LEGACY_STACK_ALIASES, stack);
}

function extractPromptText(rawInput) {
  const parsed = parseJsonText(rawInput, null);
  if (parsed && typeof parsed === 'object') {
    return String(parsed.prompt || parsed.user_prompt || parsed.userPrompt || parsed.message || parsed.text || '');
  }
  return String(rawInput || '');
}

function normalizedToolName(toolName = '') {
  const raw = String(toolName || '');
  return raw.includes('.') ? raw.split('.').pop() : raw;
}

function isShellToolName(toolName = '') {
  return /^(Bash|exec_command)$/i.test(normalizedToolName(toolName));
}

function isWriteLikeToolName(toolName = '') {
  return /^(Write|Edit|MultiEdit|apply_patch)$/i.test(normalizedToolName(toolName));
}

function commandFromToolInput(toolInput = {}) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (typeof toolInput.command === 'string') return toolInput.command;
  if (typeof toolInput.cmd === 'string') return toolInput.cmd;
  return '';
}

function isNativeState(state) {
  return Boolean(
    state
    && (
      (state.mobile && state.mobile.framework === 'react-native-expo')
      || RN_STACKS.has(state.stack)
    ),
  );
}

function isWebState(state) {
  if (!state) return false;
  if (WEB_STACKS.has(state.stack) && (!state.mobile || state.mobile.framework !== 'react-native-expo')) {
    return true;
  }
  return Boolean(state.frontend && state.frontend !== 'none');
}

function stateRequiresNewProjectMonorepo(state) {
  if (!state || state.mode !== 'new-project' || isNativeState(state)) return false;
  if (state.stack === 'default' || state.stack === 'react-realtime-monorepo') return true;
  return state.frontend === 'react-vite' && state.backend !== 'none';
}

function findProjectRootForHookFile(cwd, filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return cwd;

  const absPath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(cwd, normalized);
  const cwdAbs = path.resolve(cwd);
  let current = path.dirname(absPath);

  while (current.startsWith(cwdAbs)) {
    if (hasStateFile(current)) {
      return current;
    }
    if (current === cwdAbs) break;
    current = path.dirname(current);
  }

  return cwd;
}

function projectRelativeHookPath(cwd, projectRoot, filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return '';
  const absPath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(cwd, normalized);
  const relative = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && relative !== '.') {
    return relative;
  }
  return normalized;
}

function packageJsonDeclaresWorkspace(content) {
  if (!content || !content.trim()) return true;
  try {
    const pkg = JSON.parse(content);
    const workspaces = pkg && pkg.workspaces;
    const hasWorkspaces = Array.isArray(workspaces)
      || Boolean(workspaces && Array.isArray(workspaces.packages));
    const hasPnpmPackageManager = typeof pkg.packageManager === 'string'
      && /^pnpm@\d/.test(pkg.packageManager);
    return pkg.private === true && hasWorkspaces && hasPnpmPackageManager;
  } catch {
    return true;
  }
}

function promptTextFromSubmit(rawInput) {
  const payload = parseJsonText(rawInput, {});
  const candidates = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.message,
    payload.text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return '';
}

function isStateFilePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === STATE_FILE
    || normalized.endsWith(`/${STATE_FILE}`)
    || normalized === LEGACY_STATE_FILE
    || normalized.endsWith(`/${LEGACY_STATE_FILE}`);
}

function hasStateFile(cwd) {
  return fs.existsSync(path.join(cwd, STATE_FILE))
    || fs.existsSync(path.join(cwd, LEGACY_STATE_FILE));
}

function existingStateFilePath(cwd) {
  const nextPath = statePath(cwd);
  if (fs.existsSync(nextPath)) return nextPath;
  return legacyStatePath(cwd);
}

function patchTextFromToolInput(toolInput = {}) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  for (const key of ['patch', 'input', 'content', 'text']) {
    if (typeof toolInput[key] === 'string') return toolInput[key];
  }
  return '';
}

function patchTouchedFiles(patchText) {
  const files = [];
  for (const line of String(patchText || '').split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      || line.match(/^\*\*\* Move to: (.+)$/);
    if (match) files.push(match[1].trim());
  }
  return files;
}

function isStateFileOnlyPatch(toolName, toolInput) {
  if (!/^apply_patch$/i.test(normalizedToolName(toolName))) return false;
  const files = patchTouchedFiles(patchTextFromToolInput(toolInput));
  return files.length > 0 && files.every(isStateFilePath);
}

function hashPromptText(promptText) {
  return crypto.createHash('sha256').update(String(promptText || '').trim()).digest('hex');
}

function isExplicitSubagentsToMainAgentIntent(promptText) {
  const prompt = String(promptText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!prompt) return false;
  const rejectsAsVague = /\b(subagents?\s+(are|is)\s+unavailable|subagents?\s+(are|is)\s+blocked|subagents?\s+(do|does)\s+not\s+work)\b/.test(prompt);
  const rejectsWithoutChoice = rejectsAsVague && !/\b(i|we)\b/.test(prompt);
  if (rejectsWithoutChoice) return false;
  const stopsSubagents = /\b(i|we)\s+(do not|don't|dont|no longer|won't|will not)\s+(want(?:\s+to)?\s+)?(use\s+)?subagents?\b/.test(prompt)
    || /\b(stop|disable|turn off|drop|remove|skip)\s+(the\s+)?subagents?\b/.test(prompt)
    || /\b(no more|without)\s+subagents?\b/.test(prompt)
    || /\b(no longer|do not|don't|dont)\s+use\s+(the\s+)?subagents?\b/.test(prompt);
  const choosesMainAgent = /\b(switch|change|move|go|fall back|fallback|use)\s+(to\s+)?(low|main[- ]agent|main agent only|main thread|same thread|manual)\b/.test(prompt)
    || /\b(low|main[- ]agent|main agent only|main thread|same thread|manual)\s+(mode|only)\b/.test(prompt);
  return stopsSubagents && choosesMainAgent;
}

const TEAM_MODE_CHANGE_APPROVAL_TTL_MS = 10 * 60 * 1000;

function hasFreshTeamModeChangeApproval(state, nowMs = Date.now()) {
  const approval = state && state.team && typeof state.team === 'object'
    ? state.team.modeChangeApproval
    : null;
  if (!approval || typeof approval !== 'object') return false;
  if (approval.from !== 'subagents' || approval.to !== 'main-agent') return false;
  if (approval.source !== 'user-prompt') return false;
  if (typeof approval.promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(approval.promptHash)) return false;
  const requestedAt = typeof approval.requestedAt === 'string' ? Date.parse(approval.requestedAt) : NaN;
  return Number.isFinite(requestedAt)
    && requestedAt <= nowMs
    && nowMs - requestedAt <= TEAM_MODE_CHANGE_APPROVAL_TTL_MS;
}

function setTeamModeChangeApproval(cwd, state, promptText) {
  if (!state || typeof state !== 'object') return false;
  if (!state.team || typeof state.team !== 'object') return false;
  state.team.modeChangeApproval = {
    from: 'subagents',
    to: 'main-agent',
    source: 'user-prompt',
    requestedAt: nowIso(),
    promptHash: hashPromptText(promptText),
  };
  writeState(cwd, state);
  return true;
}

function clearTeamModeChangeApproval(cwd, state) {
  if (!state || typeof state !== 'object') return false;
  if (!state.team || typeof state.team !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(state.team, 'modeChangeApproval')) return false;
  delete state.team.modeChangeApproval;
  writeState(cwd, state);
  return true;
}

function updateTeamModeChangeApprovalFromPrompt(cwd, state, promptText) {
  if (!promptText || !promptText.trim()) return { recorded: false, cleared: false };
  if (!state || typeof state !== 'object') return { recorded: false, cleared: false };
  if (state.onboardingComplete !== true) return { recorded: false, cleared: false };
  if (!state.team || state.team.mode !== 'subagents') return { recorded: false, cleared: false };
  if (isExplicitSubagentsToMainAgentIntent(promptText)) {
    setTeamModeChangeApproval(cwd, state, promptText);
    return { recorded: true, cleared: false };
  }
  return { recorded: false, cleared: clearTeamModeChangeApproval(cwd, state) };
}

function writeLikeStateFileTarget(toolName, toolInput) {
  if (!isWriteLikeToolName(toolName)) return false;
  const filePath = toolInput && typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  return isStateFilePath(filePath) || isStateFileOnlyPatch(toolName, toolInput);
}

function replaceOneOrAll(text, oldText, newText, replaceAll = false) {
  if (typeof oldText !== 'string' || oldText === '') return text;
  if (typeof newText !== 'string') return text;
  if (replaceAll) return text.split(oldText).join(newText);
  const index = text.indexOf(oldText);
  if (index === -1) return text;
  return `${text.slice(0, index)}${newText}${text.slice(index + oldText.length)}`;
}

function proposedStateTextFromToolInput(cwd, toolName, toolInput) {
  const normalized = normalizedToolName(toolName);
  const currentStatePath = existingStateFilePath(cwd);
  const currentText = fs.existsSync(currentStatePath) ? fs.readFileSync(currentStatePath, 'utf8') : '';
  if (/^Write$/i.test(normalized)) {
    return typeof toolInput.content === 'string' ? toolInput.content : null;
  }
  if (/^Edit$/i.test(normalized)) {
    return replaceOneOrAll(currentText, toolInput.old_string, toolInput.new_string, toolInput.replace_all === true);
  }
  if (/^MultiEdit$/i.test(normalized)) {
    let nextText = currentText;
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    for (const edit of edits) {
      nextText = replaceOneOrAll(nextText, edit.old_string, edit.new_string, edit.replace_all === true);
    }
    return nextText;
  }
  return null;
}

function proposedStateFromStateWrite(cwd, toolName, toolInput) {
  const text = proposedStateTextFromToolInput(cwd, toolName, toolInput);
  if (typeof text !== 'string') return null;
  const proposed = parseJsonText(text, null);
  if (!proposed || typeof proposed !== 'object') return null;
  const normalized = JSON.parse(JSON.stringify(proposed));
  normalizeState(normalized, normalized.mode || detectMode(cwd));
  return normalized;
}

function proposedTeamModeFromStateWrite(cwd, toolName, toolInput) {
  const proposed = proposedStateFromStateWrite(cwd, toolName, toolInput);
  if (proposed) {
    return proposed.team && typeof proposed.team === 'object' ? proposed.team.mode : null;
  }
  if (/^apply_patch$/i.test(normalizedToolName(toolName))) {
    const patchText = patchTextFromToolInput(toolInput);
    const addedMainAgent = /^\+\s*"mode"\s*:\s*"main-agent"\s*,?\s*$/m.test(patchText);
    return addedMainAgent ? 'main-agent' : null;
  }
  return null;
}

function proposedStateWritesModeChangeApproval(cwd, toolName, toolInput) {
  const proposed = proposedStateFromStateWrite(cwd, toolName, toolInput);
  if (proposed && proposed.team && typeof proposed.team === 'object') {
    return Object.prototype.hasOwnProperty.call(proposed.team, 'modeChangeApproval');
  }
  if (/^apply_patch$/i.test(normalizedToolName(toolName))) {
    return /^\+.*"modeChangeApproval"\s*:/m.test(patchTextFromToolInput(toolInput));
  }
  return false;
}

function teamModeApprovalMarkerWriteGuard(cwd, toolName, toolInput) {
  if (!writeLikeStateFileTarget(toolName, toolInput)) return null;
  if (!proposedStateWritesModeChangeApproval(cwd, toolName, toolInput)) return null;
  return denyPreToolUse(
    'Traffic One team mode guard: `team.modeChangeApproval` is an internal, single-use marker that can only be written by the UserPromptSubmit hook after an explicit user request. '
    + 'Do not add or refresh it in `.traffic-one/.one.json` manually.'
  );
}

function teamModeDowngradeGuard(cwd, toolName, toolInput, currentState) {
  if (!writeLikeStateFileTarget(toolName, toolInput)) return null;
  if (!currentState || typeof currentState !== 'object') return null;
  if (currentState.onboardingComplete !== true) return null;
  if (!currentState.team || currentState.team.mode !== 'subagents') return null;
  if (proposedTeamModeFromStateWrite(cwd, toolName, toolInput) !== 'main-agent') return null;
  if (hasFreshTeamModeChangeApproval(currentState)) {
    clearTeamModeChangeApproval(cwd, currentState);
    return null;
  }
  return denyPreToolUse(
    'Traffic One team mode guard: `.traffic-one/.one.json` currently records `team.mode="subagents"`. '
    + 'This write would switch the project to `team.mode="main-agent"`, but the latest user prompt did not explicitly say they no longer want subagents and want Low/main-agent mode. '
    + 'Ask the user to say that explicitly before rewriting `performance.level="low"` and `team.mode="main-agent"`. '
    + 'Do not use `team.source="unavailable"` or a state rewrite as a workaround.'
  );
}

function isProjectMemoryWritePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('.traffic-one/')) return false;
  if (normalized.startsWith('.traffic-one/digests/')) return false;
  if (normalized.startsWith('.traffic-one/reports/')) return false;
  if (normalized.startsWith('.traffic-one/backups/')) return false;
  if (normalized.startsWith('.traffic-one/rules/')) return false;
  if (normalized.startsWith('.traffic-one/skills/')) return false;
  return normalized !== '.traffic-one/manifest.json';
}

function materializationFailureResult(error) {
  const detail = error && error.message ? error.message : String(error || 'unknown error');
  return {
    stdout: JSON.stringify({
      systemMessage: 'traffic-one — project-local materialization failed',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
      },
    }),
    exitCode: 0,
  };
}

function materializationSuccessResult(materialized, triggerPath) {
  if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
    return { stdout: '', exitCode: 0 };
  }
  return {
    stdout: JSON.stringify({
      systemMessage: 'traffic-one — project-local rules/skills materialized',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `Project-local rules/skills materialized after ${triggerPath}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/manifest.json. Root AGENTS.md contains the compact active rule kernel/index by default; root CLAUDE.md symlinks to AGENTS.md when safe.`,
      },
    }),
    exitCode: 0,
  };
}

function materializeProjectIfNeeded(cwd, trigger = 'generic hook convergence') {
  if (isPluginAuthoringRoot(cwd)) return null;

  const state = readState(cwd);
  if (!state || typeof state !== 'object') return null;
  const normalized = normalizeState(state, state.mode || detectMode(cwd));
  if (normalized) {
    try {
      writeState(cwd, state);
    } catch {
      // Let the materializer surface a validation or write failure below.
    }
  }
  if (!state.stack || !isKnownStack(state.stack)) {
    if (state.mode === 'new-project' || state.onboardingComplete === true) {
      return materializeProjectFromState(cwd, trigger);
    }
    return null;
  }
  if (state.onboardingComplete !== true) return null;

  if (isMaterialized(state) && hasMaterializedProjectAssets(cwd, state)) {
    startOneMcpReportBestEffort(cwd, state, trigger);
    return null;
  }

  return materializeProjectFromState(cwd, trigger);
}

function isCompletedTrafficOneState(state) {
  return state
    && typeof state === 'object'
    && state.onboardingComplete === true
    && typeof state.stack === 'string'
    && isKnownStack(state.stack);
}

function isCompletedTrafficOneMaterialization(cwd, state) {
  return isCompletedTrafficOneState(state)
    && isMaterialized(state)
    && hasMaterializedProjectAssets(cwd, state);
}

function startOneMcpReportBestEffort(cwd, state, trigger) {
  const { authGateForHook } = require('./auth.cjs');
  if (!authGateForHook().authenticated) return;
  if (!isCompletedTrafficOneMaterialization(cwd, state)) return;
  try {
    maybeStartOneMcpReport(cwd, { state, trigger });
  } catch {
    // Anonymous structural reporting must never block or alter the coding flow.
  }
}

function projectRootForPathHint(cwd, hintPath) {
  const raw = String(hintPath || '').trim();
  if (!raw || raw.startsWith('-') || raw.includes('://')) return null;

  const cleaned = raw
    .replace(/^["'`]+|["'`,;]+$/g, '')
    .replace(/\\ /g, ' ');
  if (!cleaned || cleaned.startsWith('-') || cleaned.includes('$')) return null;

  const absPath = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(cwd, cleaned);

  let current = absPath;
  if (!fs.existsSync(current) || !fs.lstatSync(current).isDirectory()) {
    current = path.dirname(current);
  }

  while (true) {
    if (hasStateFile(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function ensureGitnexusNvmrc(cwd, state) {
  if (!state || state.codeGraphProvider !== 'gitnexus' || state.mode !== 'new-project') {
    return false;
  }
  const nvmrcPath = path.join(cwd, '.nvmrc');
  if (fs.existsSync(nvmrcPath)) {
    return false;
  }
  try {
    fs.writeFileSync(nvmrcPath, '22\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

const FRONTEND_IDS = new Set(['none', 'react-vite', 'nextjs', 'vue', 'svelte', 'angular', 'astro', 'solid', 'remix', 'other']);
const BACKEND_IDS = new Set([
  'none',
  'supabase',
  'external-api',
  'node',
  'nestjs',
  'python',
  'django',
  'fastapi',
  'go',
  'rust',
  'java',
  'kotlin',
  'php',
  'laravel',
  'dotnet',
  'firebase',
  'mongo',
  'other',
]);
const MOBILE_FRAMEWORK_IDS = new Set(['ionic-capacitor', 'react-native-expo', 'none']);
const MOBILE_SOURCE_IDS = new Set(['explicit', 'prompted', 'none']);

function hasInitializedToolchain(toolchain) {
  if (!toolchain || typeof toolchain !== 'object') return false;
  const expected = initializeToolchainState({});
  return Object.keys(expected).every((toolName) => {
    const entry = toolchain[toolName];
    return entry
      && typeof entry === 'object'
      && Object.prototype.hasOwnProperty.call(entry, 'installedVersion')
      && Object.prototype.hasOwnProperty.call(entry, 'installedAt');
  });
}

function hasTechnologyArrays(technologies) {
  return technologies
    && typeof technologies === 'object'
    && Array.isArray(technologies.frontend)
    && Array.isArray(technologies.backend)
    && Array.isArray(technologies.mobile);
}

function hasValidMobileState(mobile) {
  if (!mobile || typeof mobile !== 'object') return false;
  return typeof mobile.enabled === 'boolean'
    && MOBILE_FRAMEWORK_IDS.has(mobile.framework)
    && MOBILE_SOURCE_IDS.has(mobile.source);
}

function hasResolvedNewProjectMobileState(mobile) {
  return hasValidMobileState(mobile) && mobile.source !== 'none';
}

function roleCanWriteFeatureSource(role, filePath) {
  if (role === 'senior-frontend') {
    return /^(apps\/[^/]+\/(src|app)\/|packages\/(ui|i18n|utils)\/src\/)/.test(filePath);
  }
  if (role === 'senior-backend') {
    return /^(packages\/(api-client|ws-client|utils)\/src\/|services\/[^/]+\/src\/|apps\/[^/]+\/src\/(services|store)\/)/.test(filePath);
  }
  return false;
}

// Role ownership check. Prefer the per-agent run claim resolved from the
// current hook session id; fall back to the legacy shared activeAgentRole only
// for older projects that do not have .traffic-one/runs/<runId>/ state yet.
function subagentMayWriteFeatureSource(state, filePath, agentContext = null) {
  if (agentContext && agentContext.role) {
    return roleCanWriteFeatureSource(agentContext.role, filePath);
  }
  if (!isSubagentSession(state)) return false;
  const role = activeAgentRole(state);
  if (role && roleCanWriteFeatureSource(role, filePath)) return true;
  return roleCanWriteFeatureSource('senior-frontend', filePath)
      || roleCanWriteFeatureSource('senior-backend', filePath);
}

function commandAppearsToWriteFeatureSource(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const hasWritePrimitive = /(?:>|>>|\btee\b|\bcat\b[\s\S]*<<|\bpython3?\b|\bnode\b|\bperl\b|\bsed\b[\s\S]*-i)/.test(command);
  const mentionsFeaturePath = /(?:^|[\s'"`])(?:apps\/[^/\s'"`]+\/(?:src|app)\/|packages\/[^/\s'"`]+\/src\/|src\/|services\/[^/\s'"`]+\/src\/)/.test(command);
  return hasWritePrimitive && mentionsFeaturePath;
}

function applyPatchTargetPaths(patchText) {
  if (typeof patchText !== 'string' || !patchText.trim()) return [];
  const paths = [];
  for (const line of patchText.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      || line.match(/^\*\*\* Move to: (.+)$/);
    if (match && match[1]) {
      paths.push(match[1].trim().replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }
  return paths;
}

function formatStateValue(value) {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

function trafficOneStateValidationIssues(state, validCodeGraphProviders = ['gitnexus', 'graphify']) {
  const issues = [];
  if (!state || typeof state !== 'object') {
    return ['`.traffic-one/.one.json` must contain a JSON object.'];
  }

  if (!state.stack) {
    issues.push('`stack` is missing.');
  } else if (!STACK_IDS.has(state.stack)) {
    issues.push(`\`stack\` is ${formatStateValue(state.stack)}; valid values: ${[...STACK_IDS].map((id) => `\`${id}\``).join(' · ')}.`);
  }

  if (!state.frontend) {
    issues.push('`frontend` is missing.');
  } else if (!FRONTEND_IDS.has(state.frontend)) {
    issues.push(`\`frontend\` is ${formatStateValue(state.frontend)}; valid values: ${[...FRONTEND_IDS].map((id) => `\`${id}\``).join(' · ')}.`);
  }

  if (!state.backend) {
    issues.push('`backend` is missing.');
  } else if (!BACKEND_IDS.has(state.backend)) {
    issues.push(`\`backend\` is ${formatStateValue(state.backend)}; valid values: ${[...BACKEND_IDS].map((id) => `\`${id}\``).join(' · ')}.`);
  }

  if (!state.mobile || typeof state.mobile !== 'object') {
    issues.push('`mobile` must be an object with `enabled`, `framework`, and `source`.');
  } else {
    if (typeof state.mobile.enabled !== 'boolean') {
      issues.push(`\`mobile.enabled\` is ${formatStateValue(state.mobile.enabled)}; expected boolean.`);
    }
    if (!MOBILE_FRAMEWORK_IDS.has(state.mobile.framework)) {
      issues.push(`\`mobile.framework\` is ${formatStateValue(state.mobile.framework)}; valid values: ${[...MOBILE_FRAMEWORK_IDS].map((id) => `\`${id}\``).join(' · ')}.`);
    }
    if (!MOBILE_SOURCE_IDS.has(state.mobile.source)) {
      issues.push(`\`mobile.source\` is ${formatStateValue(state.mobile.source)}; valid values: ${[...MOBILE_SOURCE_IDS].map((id) => `\`${id}\``).join(' · ')}.`);
    } else if (state.mode === 'new-project' && state.mobile.source === 'none') {
      issues.push('`mobile.source` must be `prompted` or `explicit` after the Mobile App prompt for new-project onboarding.');
    }
  }

  if (!hasTechnologyArrays(state.technologies)) {
    issues.push('`technologies` must contain `frontend`, `backend`, and `mobile` arrays.');
  }

  if (state.mode === 'new-project' && !hasValidProjectContext(state.projectContext)) {
    issues.push('`projectContext` must be an object with `source`, `originalPrompt`, `summary`, `answers`, and `collectedAt`.');
  }

  if (state.mode === 'new-project' && !hasValidTeamState(state.team)) {
    issues.push(`\`team\` must be an object with valid \`mode\` (${[...TEAM_MODE_IDS].map((id) => `\`${id}\``).join(' · ')}) and \`source\` (${[...TEAM_SOURCE_IDS].map((id) => `\`${id}\``).join(' · ')}).`);
  }

  if (state.mode === 'new-project' && !hasValidPerformanceState(state.performance)) {
    issues.push(`\`performance\` must be an object with valid \`level\` (${[...PERFORMANCE_LEVEL_IDS].map((id) => `\`${id}\``).join(' · ')}) and \`source\` (\`prompted\` · \`explicit\`).`);
  }

  if (
    state.mode === 'new-project'
    && hasValidPerformanceState(state.performance)
    && hasValidTeamState(state.team)
  ) {
    const expectedTeamMode = teamModeForLevel(state.performance.level);
    if (state.team.mode !== expectedTeamMode) {
      issues.push(`\`team.mode\` is ${formatStateValue(state.team.mode)} but performance.level=${formatStateValue(state.performance.level)} requires ${formatStateValue(expectedTeamMode)}.`);
    }
    if (
      expectedTeamMode === 'subagents'
      && !isTeamApproved(state.team)
    ) {
      issues.push('`team.approved` must be true after Team Confirmation before balanced/high subagents can run.');
    }
  }

  const cgProvider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : '';
  if (!cgProvider) {
    issues.push('`codeGraphProvider` is missing.');
  } else if (!validCodeGraphProviders.includes(cgProvider)) {
    issues.push(`\`codeGraphProvider\` is ${formatStateValue(cgProvider)}; valid values: ${validCodeGraphProviders.map((id) => `\`${id}\``).join(' · ')}.`);
  }

  if (!hasInitializedToolchain(state.toolchain)) {
    issues.push('`toolchain` must include initialized entries for every tracked tool.');
  }
  if (state.confirmed !== true) {
    issues.push('`confirmed` must be true.');
  }
  if (state.onboardingComplete !== true) {
    issues.push('`onboardingComplete` must be true.');
  }
  if (typeof state.confirmedAt !== 'string' || state.confirmedAt.trim() === '') {
    issues.push('`confirmedAt` must be a non-empty ISO-8601 string.');
  }

  return issues;
}

function materializeProjectFromState(cwd, trigger = 'manual materialize-project') {
  if (isPluginAuthoringRoot(cwd)) {
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one — plugin authoring root detected; project materialization skipped',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'This directory is the Traffic One plugin source, not a generated Traffic One project. `materialize-project` only rewrites `.traffic-one/**`, root `AGENTS.md`, and root `CLAUDE.md` inside projects created with the plugin.',
        },
      }),
      exitCode: 0,
    };
  }

  const state = readState(cwd);
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];

  if (!state || typeof state !== 'object') {
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one — `.traffic-one/.one.json` is missing or invalid; cannot materialize project rules',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'Write the complete Traffic One state file first, then run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project` from the project root.',
        },
      }),
      exitCode: 0,
    };
  }

  const normalizedBeforeValidation = normalizeState(state, state.mode || detectMode(cwd));

  const cgProvider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const validationIssues = trafficOneStateValidationIssues(state, validCodeGraphProviders);
  const ready = validationIssues.length === 0;

  if (!ready) {
    const additionalContext = postWriteIncompleteWarning({
      stack: state.stack || null,
      validStackIds,
      codeGraphProvider: cgProvider,
      validCodeGraphProviders,
      validationIssues,
    });
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one — `.traffic-one/.one.json` is incomplete; cannot materialize project rules yet',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext,
        },
      }),
      exitCode: 0,
    };
  }

  if (normalizedBeforeValidation) {
    try {
      writeState(cwd, state);
    } catch {
      // best-effort; materialization can still proceed with the normalized object.
    }
  }

  ensureGitnexusNvmrc(cwd, state);

  let materialized = null;
  try {
    materialized = materializeProjectAssets(cwd, state);
  } catch (error) {
    return materializationFailureResult(error);
  }

  try {
    state.materializedStack   = stackFingerprint(state);
    state.materializedAt      = nowIso();
    state.materializedVersion = getPluginVersion();
    writeState(cwd, state);
  } catch {
    // best-effort; the copied local assets are still usable.
  }

  startOneMcpReportBestEffort(cwd, state, trigger);

  const result = materializationSuccessResult(materialized, trigger);
  if (result.stdout) return result;
  return {
    stdout: JSON.stringify({
      systemMessage: 'traffic-one — project-local rules/skills already materialized',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `Project-local rules/skills are current for ${stackFingerprint(state)}. Root AGENTS.md contains the compact active rule kernel/index by default; root CLAUDE.md symlinks to AGENTS.md when safe.`,
      },
    }),
    exitCode: 0,
  };
}

function isNewProjectOnboardingIncomplete(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.mode !== 'new-project') return false;
  const hasValidStack = typeof state.stack === 'string' && isKnownStack(state.stack);
  const hasOpenCode = hasResolvedOpenCodeState(state.openCode);
  const hasGraphProvider = state.codeGraphProvider === 'gitnexus' || state.codeGraphProvider === 'graphify';
  const hasFrontend = typeof state.frontend === 'string' && FRONTEND_IDS.has(state.frontend);
  const hasBackend = typeof state.backend === 'string' && BACKEND_IDS.has(state.backend);
  const hasTeam = hasValidTeamState(state.team);
  const hasPerformance = hasValidPerformanceState(state.performance);
  const hasProjectContext = hasValidProjectContext(state.projectContext);
  const teamMatchesPerformance = hasTeam && hasPerformance && state.team.mode === teamModeForLevel(state.performance.level);
  const hasRequiredTeamApproval = hasTeam
    && hasPerformance
    && (
      teamModeForLevel(state.performance.level) !== 'subagents'
      || isTeamApproved(state.team)
    );
  return !hasValidStack
    || !hasOpenCode
    || !hasFrontend
    || !hasBackend
    || !hasProjectContext
    || !hasResolvedNewProjectMobileState(state.mobile)
    || !hasTechnologyArrays(state.technologies)
    || !hasGraphProvider
    || !hasTeam
    || !hasPerformance
    || !teamMatchesPerformance
    || !hasRequiredTeamApproval
    || !hasInitializedToolchain(state.toolchain)
    || state.confirmed !== true
    || state.onboardingComplete !== true
    || typeof state.confirmedAt !== 'string'
    || state.confirmedAt.trim() === '';
}

function canRepairNewProjectOnboardingState(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.onboardingComplete !== true) return false;
  if (state.confirmed === false) return false;
  const candidate = JSON.parse(JSON.stringify(state));
  normalizeState(candidate, candidate.mode || 'new-project');
  if (candidate.mode !== 'new-project') return false;
  if (typeof candidate.stack !== 'string' || !isKnownStack(candidate.stack)) return false;
  if (typeof candidate.frontend !== 'string' || !FRONTEND_IDS.has(candidate.frontend)) return false;
  if (typeof candidate.backend !== 'string' || !BACKEND_IDS.has(candidate.backend)) return false;
  if (!hasValidProjectContext(candidate.projectContext)) return false;
  if (candidate.mobile === undefined || candidate.mobile === null) return false;
  if (!hasResolvedNewProjectMobileState(candidate.mobile)) return false;
  if (!hasValidTeamState(candidate.team)) return false;
  if (!hasValidPerformanceState(candidate.performance)) return false;
  if (candidate.team.mode !== teamModeForLevel(candidate.performance.level)) return false;
  if (
    teamModeForLevel(candidate.performance.level) === 'subagents'
    && !isTeamApproved(candidate.team)
  ) return false;
  if (candidate.codeGraphProvider !== 'gitnexus' && candidate.codeGraphProvider !== 'graphify') return false;

  normalizeState(candidate, candidate.mode || 'new-project');
  return !isNewProjectOnboardingIncomplete(candidate);
}

function repairNewProjectOnboardingState(cwd, state, trigger) {
  if (!canRepairNewProjectOnboardingState(state)) return null;
  try {
    const repaired = JSON.parse(JSON.stringify(state));
    normalizeState(repaired, repaired.mode || detectMode(cwd));
    writeState(cwd, repaired);
    return materializeProjectFromState(cwd, trigger);
  } catch (error) {
    return materializationFailureResult(error);
  }
}

const PROJECT_CONTEXT_ANSWER_KEYS = [
  'audience',
  'coreFlows',
  'v1Features',
  'rolesAuth',
  'businessModel',
  'payments',
  'admin',
  'dataModel',
  'contentSource',
  'integrations',
  'engagement',
  'successMetrics',
  'constraints',
  'domainSpecific',
];

function projectContextOriginalPrompt(state = {}) {
  const candidates = [
    state && state.projectContext && state.projectContext.originalPrompt,
    state && state.originalPrompt,
    state && state.initialPrompt,
    state && state.firstPrompt,
    state && state.userPrompt,
    state && state.prompt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function promptMatches(prompt, pattern) {
  return pattern.test(String(prompt || '').toLowerCase());
}

function projectContextDomainQuestionLines(originalPrompt = '') {
  const lines = [];
  const prompt = String(originalPrompt || '').toLowerCase();
  const isLearning = promptMatches(prompt, /\b(course|courses|lesson|lessons|learn|learning|academy|education|student|students|instructor|teacher|lms|curriculum|cohort|cohorts)\b/);
  const isMarketplace = promptMatches(prompt, /\b(marketplace|buyer|seller|vendor|provider|providers|freelancer|freelancers|employer|employers|candidate|candidates|job|jobs|listing|listings|commission|payout|payouts)\b/);
  const isEcommerce = promptMatches(prompt, /\b(ecommerce|e-commerce|shop|store|cart|checkout|product|products|order|orders|inventory|sku|subscription|subscriptions|billing|pricing|paid|payment|payments)\b/);
  const isBooking = promptMatches(prompt, /\b(booking|bookings|reservation|reservations|appointment|appointments|calendar|availability|schedule|scheduling|slot|slots)\b/);
  const isSaasAdmin = promptMatches(prompt, /\b(saas|dashboard|crm|erp|admin|administrator|manage|management|analytics|reporting|workflow|workflows|approval|approvals)\b/);
  const isCommunity = promptMatches(prompt, /\b(community|social|forum|forums|chat|message|messages|member|members|group|groups|moderation|moderator|comments)\b/);
  const isContent = promptMatches(prompt, /\b(content|cms|blog|article|articles|media|video|videos|audio|podcast|gallery|upload|uploads|asset|assets|newsletter)\b/);
  const isPortfolio = promptMatches(prompt, /\b(portfolio|personal site|case study|case studies|resume|cv|showcase|gallery|testimonials?)\b/);
  const isInternal = promptMatches(prompt, /\b(internal|backoffice|back office|operations|ops|employee|employees|staff|team tool|admin tool|intranet)\b/);
  const mightCharge = isMarketplace
    || isEcommerce
    || promptMatches(prompt, /\b(paid|payment|payments|stripe|checkout|subscription|subscriptions|billing|pricing|plan|plans|invoice|invoices|refund|refunds|coupon|coupons|commission|payout|payouts|membership|memberships)\b/);

  if (isLearning) {
    lines.push('Learning platform specifics: course/module/lesson structure, lesson types, progress/completion rules, enrollment model, free vs paid courses, learner/instructor/admin roles, admin CRUD scope, seeded demo content, analytics, and whether payments are in or out for v1.');
  }
  if (isMarketplace) {
    lines.push('Marketplace specifics: supply/demand sides, listing workflow, matching/search filters, applications/bookings/orders, messaging, reviews, moderation, commission/payout model, disputes, and admin controls.');
  }
  if (isEcommerce) {
    lines.push('Ecommerce specifics: product/catalog structure, inventory, cart/checkout, order statuses, fulfillment, coupons, taxes, refunds, customer accounts, and admin order/product management.');
  }
  if (isBooking) {
    lines.push('Booking specifics: bookable resources, availability rules, calendar sync, deposits/cancellations, reminders, rescheduling, provider/customer roles, and admin scheduling overrides.');
  }
  if (isSaasAdmin) {
    lines.push('SaaS/admin specifics: tenants/workspaces, dashboards, reports, role permissions, audit trail, import/export, approvals, operational queues, and admin analytics.');
  }
  if (isCommunity) {
    lines.push('Community specifics: profiles, posting/commenting, groups, messaging, moderation queues, reporting, notifications, reputation, and admin safety tools.');
  }
  if (isContent) {
    lines.push('Content/media specifics: content types, editorial workflow, uploads/storage, publishing states, tags/search, SEO needs, moderation, and admin CMS controls.');
  }
  if (isPortfolio) {
    lines.push('Portfolio specifics: primary audience, featured work, case-study structure, contact/lead capture, testimonials, CMS needs, analytics, and launch content.');
  }
  if (isInternal) {
    lines.push('Internal-tool specifics: operator roles, approval workflows, data import/export, reporting, audit/history needs, permission boundaries, and admin/support workflows.');
  }
  if (mightCharge) {
    lines.push('Payment integration, if money is in scope: Stripe or other provider, subscriptions vs one-time checkout, webhooks, refunds, invoices, taxes, coupons, and marketplace payouts/commissions if relevant.');
  }
  if (lines.length === 0) {
    lines.push('Domain specifics: based on the product category, name the entities, workflows, admin surfaces, integrations, and edge cases that must exist for a complete MVP.');
  }
  return lines;
}

function projectContextChatFallback(state = {}) {
  const originalPrompt = projectContextOriginalPrompt(state);
  const promptIntro = originalPrompt
    ? [`Original request I should tailor this to: "${originalPrompt}"`, '']
    : [];
  return [
    'Traffic One was successfully set up. Let\'s collect the project details next.',
    '',
    ...promptIntro,
    'Answer these MVP-context questions in one reply so the build plan is complete:',
    '',
    '1. Audience and jobs: who uses it, what problem they solve, and the top 2-3 user journeys.',
    '2. V1 scope: must-have features, nice-to-haves to defer, and any launch deadline or demo expectation.',
    '3. Roles and auth: anonymous, user, customer, creator/provider, staff/admin, permissions, and profile data.',
    '4. Data model: core entities and relationships the MVP must store or seed.',
    '5. Admin and operations: dashboards, CRUD, moderation, user/content/transaction management, analytics, support, and audit needs. Include this when the app has managed content, users, transactions, or operational workflows, even if the first request did not mention admin.',
    '6. Business model and payments: free, paid, freemium, lead-gen, subscription, one-time purchase, marketplace commission, or internal tool? Are payments in or out for v1?',
    '7. Content and integrations: source of seed/real data, uploads/files, search, notifications/email, realtime, maps/calendar/AI/external APIs, import/export.',
    '8. Success criteria and product tone: what makes the MVP feel complete, what metrics matter, and what visual/brand direction should guide the UI.',
    '',
    'Use these answer keys where possible: ' + PROJECT_CONTEXT_ANSWER_KEYS.join(', ') + '.',
    '',
    'Dynamic questions for this request:',
    ...projectContextDomainQuestionLines(originalPrompt).map((line) => `- ${line}`),
    '',
    'Save the answer in `.traffic-one/.one.json` as `projectContext` with `source`, `originalPrompt`, `summary`, `answers`, and `collectedAt` before asking the Mobile App prompt.',
  ].join('\n');
}

function mobileChatFallback() {
  return [
    'Traffic One needs the mobile app decision for this project.',
    '',
    'Do you want a mobile app too?',
    '',
    '1. Web only (Recommended)',
    '2. Ionic + Capacitor',
    '3. React Native / Expo',
    '',
    'Reply with the option number or label.',
  ].join('\n');
}

function codeGraphChatFallback() {
  return [
    'Traffic One needs the code graph provider for this project.',
    '',
    'Which provider should we use for the codebase graph?',
    '',
    '1. GitNexus',
    '2. graphify',
    '',
    'Reply with the option number or label.',
  ].join('\n');
}

function singleSelectPromptRequest({ id, title, question, options, fallbackText }) {
  return {
    id,
    kind: 'single_select',
    title,
    question,
    options,
    blocking: true,
    ...(fallbackText ? { fallbackText } : {}),
  };
}

function secureTextPromptRequest({ id, title, question, fallbackText }) {
  return {
    id,
    kind: 'secure_text',
    title,
    question,
    blocking: true,
    sensitive: true,
    ...(fallbackText ? { fallbackText } : {}),
  };
}

function authChoicePromptRequest(fallbackText) {
  return singleSelectPromptRequest({
    id: 'traffic-one.auth.choice',
    title: 'Traffic One',
    question: 'Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?',
    options: [
      { id: 'authenticate', label: 'Authenticate Traffic One (Recommended)' },
      { id: 'continue_without', label: 'Continue without Traffic One' },
    ],
    fallbackText,
  });
}

function authApiKeyPromptRequest(fallbackText) {
  return secureTextPromptRequest({
    id: 'traffic-one.auth.api-key',
    title: 'Traffic One API Key',
    question: 'Enter your Traffic One API key.',
    fallbackText,
  });
}

function sessionExpiredPromptRequest(fallbackText) {
  return secureTextPromptRequest({
    id: 'traffic-one.auth.session-expired',
    title: 'Traffic One Session Expired',
    question: 'Your Traffic One session expired. Enter your Traffic One API key to re-authenticate.',
    fallbackText,
  });
}

function performancePromptRequest(fallbackText) {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.performance',
    title: 'Performance',
    question: 'How do you want to run agents for this build?',
    options: [
      { id: 'high', label: 'High (Recommended)' },
      { id: 'balanced', label: 'Balanced' },
      { id: 'low', label: 'Low' },
    ],
    fallbackText,
  });
}

function openCodePromptRequest(fallbackText) {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.open-code',
    title: 'OpenCode',
    question: 'Save tokens by delegating coding tasks to OpenCode (a free local agent)?',
    options: [
      { id: 'enable', label: 'Enable OpenCode delegation' },
      { id: 'not_now', label: 'Not now' },
    ],
    fallbackText,
  });
}

function teamConfirmationPromptRequest(state, fallbackText) {
  const level = state && state.performance && state.performance.level
    ? state.performance.level
    : 'selected';
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.team-confirmation',
    title: 'Team',
    question: `Approve the ${level} team line-up above?`,
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'repick_performance', label: 'Re-pick performance' },
      { id: 'customise', label: 'Customise' },
    ],
    fallbackText,
  });
}

function projectContextPromptRequest(fallbackText) {
  return {
    id: 'traffic-one.onboarding.project-context',
    kind: 'text',
    title: 'Project Context',
    question: 'Answer the MVP-context questions in one reply so the build plan is complete.',
    blocking: true,
    fallbackText,
  };
}

function mobilePromptRequest(fallbackText) {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.mobile',
    title: 'Mobile App',
    question: 'Do you want a mobile app too?',
    options: [
      { id: 'web_only', label: 'Web only (Recommended)' },
      { id: 'ionic_capacitor', label: 'Ionic + Capacitor' },
      { id: 'react_native_expo', label: 'React Native / Expo' },
    ],
    fallbackText,
  });
}

function codeGraphPromptRequest(fallbackText) {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.code-graph',
    title: 'Code Graph',
    question: 'Which provider should we use for the codebase graph?',
    options: [
      { id: 'gitnexus', label: 'GitNexus' },
      { id: 'graphify', label: 'graphify' },
    ],
    fallbackText,
  });
}

function nextOnboardingStep(state) {
  if (!state || typeof state !== 'object' || state.mode !== 'new-project') return null;
  if (!hasResolvedOpenCodeState(state.openCode)) return 'open-code';
  if (!hasValidPerformanceState(state.performance)) return 'performance';
  if (needsTeamConfirmation(state)) return 'team-confirmation';
  if (!hasValidTeamState(state.team)) return 'team';
  if (!hasValidProjectContext(state.projectContext)) return 'project-context';
  if (!hasResolvedNewProjectMobileState(state.mobile)) return 'mobile';
  if (state.codeGraphProvider !== 'gitnexus' && state.codeGraphProvider !== 'graphify') return 'code-graph';
  return 'state';
}

function nextOnboardingStepPromptAndRequest(state, source = 'gate') {
  const step = nextOnboardingStep(state);
  if (step === 'open-code') {
    const fallbackText = [
      'Next unresolved Traffic One onboarding step: OpenCode delegation opt-in.',
      '',
      openCodeChatFallback(),
    ].join('\n');
    return {
      fallbackText,
      promptRequest: openCodePromptRequest(fallbackText),
    };
  }
  if (step === 'performance') {
    const fallbackText = [
      'Next unresolved Traffic One onboarding step: Agent mode.',
      '',
      performanceChatFallback(),
    ].join('\n');
    return {
      fallbackText,
      promptRequest: performancePromptRequest(fallbackText),
    };
  }
  if (step === 'team-confirmation' || step === 'team') {
    const fallbackText = teamConfirmationPromptContext(state, source === 'user-prompt' ? 'user-prompt' : 'gate');
    return {
      fallbackText,
      promptRequest: teamConfirmationPromptRequest(state, fallbackText),
    };
  }
  if (step === 'project-context') {
    const fallbackText = projectContextChatFallback(state);
    return {
      fallbackText,
      promptRequest: projectContextPromptRequest(fallbackText),
    };
  }
  if (step === 'mobile') {
    const fallbackText = mobileChatFallback();
    return {
      fallbackText,
      promptRequest: mobilePromptRequest(fallbackText),
    };
  }
  if (step === 'code-graph') {
    const fallbackText = codeGraphChatFallback();
    return {
      fallbackText,
      promptRequest: codeGraphPromptRequest(fallbackText),
    };
  }
  const fallbackText = [
    'Traffic One onboarding state is still incomplete or noncanonical.',
    'Re-write `.traffic-one/.one.json` with the full required schema before continuing.',
  ].join('\n');
  return { fallbackText, promptRequest: null };
}

function nextOnboardingStepPrompt(state, source = 'gate') {
  return nextOnboardingStepPromptAndRequest(state, source).fallbackText;
}

function nextOnboardingPromptRequest(state, source = 'gate') {
  return nextOnboardingStepPromptAndRequest(state, source).promptRequest;
}

function onboardingGateFallbackReason(state = {}) {
  return [
    'Traffic One onboarding gate: mode=new-project and onboarding is not complete.',
    'Complete Traffic One onboarding in the current thread before using tools. If the popup tool is unavailable, the next unresolved fallback prompt must be displayed as the next visible assistant message.',
    '',
    'The previous assistant turn tried to use tools before completing onboarding. Stop tool use now. Your next visible assistant message must ask only this unresolved step:',
    '',
    nextOnboardingStepPrompt(state, 'gate'),
    '',
    'The onboarding state remains incomplete until `.traffic-one/.one.json` contains stack, frontend, backend, projectContext, mobile, technologies, codeGraphProvider, performance, team (including `team.approved: true` after Team Confirmation for Balanced/High), toolchain, confirmed, onboardingComplete, and confirmedAt.',
    'After sending that prompt, stop. Do not choose defaults, inspect package versions, scaffold, install, edit files, spawn helper agents, or continue implementation until the typed answer is received and the remaining onboarding prompts are resolved.',
  ].join('\n');
}

function needsTeamConfirmation(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.mode !== 'new-project') return false;
  if (!hasValidPerformanceState(state.performance)) return false;
  if (!hasValidTeamState(state.team)) return false;
  if (teamModeForLevel(state.performance.level) !== 'subagents') return false;
  if (state.team.mode !== 'subagents') return false;
  return !isTeamApproved(state.team);
}

function teamConfirmationPromptContext(state, source = 'gate') {
  const level = state && state.performance && state.performance.level;
  const overrides = state && state.team && state.team.overrides && typeof state.team.overrides === 'object'
    ? state.team.overrides
    : null;
  return [
    `Traffic One Team Confirmation is still required before the ${level} subagent run can start.`,
    'The user selected a multi-agent performance level, but `.traffic-one/.one.json` does not contain `team.approved: true`.',
    'Do not spawn Task/spawn_agent/background-agent workers, do not write feature source, and do not set `team.source: "unavailable"` as a shortcut. If subagents are unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before any state rewrite.',
    source === 'user-prompt'
      ? 'If the latest user message is an explicit "Approve" answer to this Team Confirmation prompt, first rewrite `.traffic-one/.one.json` with `team.approved: true` (and any collected `team.overrides`), then continue.'
      : 'Your next visible assistant message must ask this approval question and then stop for the user answer.',
    'Use the host popup tool when available (Codex `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI). This is onboarding popup 2. If no popup tool is exposed, show this plain-chat fallback verbatim:',
    '',
    teamConfirmationChatFallback(level, overrides),
  ].join('\n');
}

function teamConfirmationGateFallbackReason(state) {
  return [
    'Traffic One Team Confirmation gate: the role/model lineup has not been approved.',
    '',
    teamConfirmationPromptContext(state, 'gate'),
  ].join('\n');
}

function isMutatingPreToolUse(toolName, toolInput) {
  const name = String(
    toolName
    || (toolInput && (toolInput.tool_name || toolInput.toolName))
    || '',
  );
  if (isWriteLikeToolName(name)) return true;
  if (toolInput && typeof toolInput === 'object') {
    if (
      Object.prototype.hasOwnProperty.call(toolInput, 'content')
      || Object.prototype.hasOwnProperty.call(toolInput, 'new_string')
      || Object.prototype.hasOwnProperty.call(toolInput, 'old_string')
      || Object.prototype.hasOwnProperty.call(toolInput, 'edits')
    ) {
      return true;
    }
  }
  if (!isShellToolName(name)) return false;
  const command = commandFromToolInput(toolInput);
  return /(^|[\s;&|])(mkdir|touch|rm|mv|cp|tee|npm\s+(install|i|add|create)|pnpm\s+(install|add|create)|yarn\s+(install|add|create)|bun\s+(install|add|create)|npx|git\s+(init|add|commit)|sed\s+-i)\b/.test(command)
    || />{1,2}/.test(command);
}

// Read-only orientation tools the onboarding gate allows even while onboarding
// is incomplete, so the agent can locate its working directory and read context
// BEFORE writing `.traffic-one/.one.json`. Without this, the gate denied `pwd`/`Read`
// — leaving the agent unable to discover where to write the very file that
// satisfies the gate (a deadlock). Mutating tools, agent spawns (Task/
// spawn_agent), installs, and scaffolding are NOT orientation and stay gated.
function isReadOnlyOrientationToolUse(toolName, toolInput) {
  const name = String(
    toolName
    || (toolInput && (toolInput.tool_name || toolInput.toolName))
    || '',
  );
  if (!name) return false;
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/i.test(normalizedToolName(name))) return true;
  // Read-only shell (pwd, ls, cat, find, …): a shell tool whose command is not
  // classified as mutating by isMutatingPreToolUse.
  if (isShellToolName(name) && !isMutatingPreToolUse(name, toolInput)) return true;
  return false;
}

function repairedMaterializationDenyReason() {
  return [
    'Traffic One state was repaired/materialized before this tool use.',
    'The attempted mutating tool has been denied once so it cannot run against stale `.traffic-one/.one.json`, rules, skills, or root agent context.',
    'rerun the same tool now; the canonical `.traffic-one/.one.json` and project-local materialization are current.',
  ].join('\n');
}

function agentMaterializationDenyReason() {
  return [
    'Traffic One agent spawn gate: state was repaired/materialized before this agent spawn.',
    'The role agent has been denied once so frontend/backend workers cannot start against stale `.traffic-one/.one.json`, rules, skills, or root agent context.',
    'rerun the same agent spawn now; the canonical `.traffic-one/.one.json` and project-local materialization are current.',
  ].join('\n');
}

function agentMaterializationMissingReason() {
  return [
    'Traffic One agent spawn gate: project-local rules/skills are not materialized yet.',
    'Do not spawn frontend/backend/reviewer/tester workers until `.traffic-one/.one.json` has current `materializedStack`, `materializedAt`, and `materializedVersion`, and `.traffic-one/manifest.json`, `.traffic-one/rules/**`, `.traffic-one/skills/**`, root `AGENTS.md`, and root `CLAUDE.md` exist.',
    'Run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project` from the project root, then retry the agent spawn.',
  ].join('\n');
}

function denyPreToolUse(reason, promptRequest = null) {
  const payload = {
    ...(promptRequest ? { promptRequest } : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  return {
    stdout: JSON.stringify(payload),
    exitCode: 0,
  };
}

module.exports = {
  // external modules + plugin libs re-exported for cluster files
  fs,
  os,
  path,
  crypto,
  spawn,
  spawnSync,
  STATE_FILE,
  LEGACY_STATE_FILE,
  BUDGET_CHARS,
  RN_STACKS,
  WEB_STACKS,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
  pluginRoot,
  parseJsonText,
  safeReadJson,
  nowIso,
  readState,
  writeState,
  statePath,
  legacyStatePath,
  normalizeState,
  initializeToolchainState,
  hasValidTeamState,
  hasValidProjectContext,
  hasValidPerformanceState,
  hasResolvedOpenCodeState,
  isTeamApproved,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  stackFingerprint,
  getPluginVersion,
  isMaterialized,
  isSubagentSession,
  activeAgentRole,
  ensureRunAgentClaim,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
  isFixCycleSession,
  getSpawnIndex,
  VALID_AGENT_ROLES,
  PERFORMANCE_LEVEL_IDS,
  performanceChatFallback,
  modelForRoleHost,
  teamModeForLevel,
  openCodeChatFallback,
  openCodeOptInDirective,
  STACKS,
  stackSpecForState,
  roleScopedRules,
  listAllSkills,
  pruneSkillsDirective,
  cleanActiveSkills,
  copyActiveSkills,
  loadPackageJson,
  dependenciesFromPackage,
  detectMode,
  detectStackFromCodebase,
  classifyPromptForStack,
  packBundle,
  packRuleIndex,
  packFixCycleHeader,
  materializeProjectAssets,
  hasMaterializedProjectAssets,
  isPluginAuthoringRoot,
  computeProjectFingerprint,
  maybeStartOneMcpReport,
  FRESHNESS_REASON,
  authRemoteCheckDue,
  authRequiredMessage,
  authStateFreshness,
  authStatePath,
  isAuthenticatedLocal,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
  readTrafficOneAuthState,
  onboardingDirectiveNewProject,
  autoDetectedAnnouncement,
  onboardingReminderShort,
  postWriteIncompleteWarning,
  hostPopupInstruction,
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
  teamConfirmationChatFallback,
  tokenLogger,
  // shared private helpers / constants
  tokenEconomyBanner,
  isKnownStack,
  extractPromptText,
  normalizedToolName,
  isShellToolName,
  isWriteLikeToolName,
  commandFromToolInput,
  isNativeState,
  isWebState,
  stateRequiresNewProjectMonorepo,
  findProjectRootForHookFile,
  projectRelativeHookPath,
  packageJsonDeclaresWorkspace,
  promptTextFromSubmit,
  isStateFilePath,
  patchTextFromToolInput,
  patchTouchedFiles,
  isStateFileOnlyPatch,
  hashPromptText,
  isExplicitSubagentsToMainAgentIntent,
  hasFreshTeamModeChangeApproval,
  setTeamModeChangeApproval,
  clearTeamModeChangeApproval,
  updateTeamModeChangeApprovalFromPrompt,
  writeLikeStateFileTarget,
  replaceOneOrAll,
  proposedStateTextFromToolInput,
  proposedStateFromStateWrite,
  proposedTeamModeFromStateWrite,
  proposedStateWritesModeChangeApproval,
  teamModeApprovalMarkerWriteGuard,
  teamModeDowngradeGuard,
  isProjectMemoryWritePath,
  materializationFailureResult,
  materializationSuccessResult,
  materializeProjectIfNeeded,
  isCompletedTrafficOneState,
  isCompletedTrafficOneMaterialization,
  startOneMcpReportBestEffort,
  projectRootForPathHint,
  ensureGitnexusNvmrc,
  FRONTEND_IDS,
  BACKEND_IDS,
  MOBILE_FRAMEWORK_IDS,
  MOBILE_SOURCE_IDS,
  hasInitializedToolchain,
  hasTechnologyArrays,
  hasValidMobileState,
  hasResolvedNewProjectMobileState,
  roleCanWriteFeatureSource,
  subagentMayWriteFeatureSource,
  commandAppearsToWriteFeatureSource,
  applyPatchTargetPaths,
  formatStateValue,
  trafficOneStateValidationIssues,
  materializeProjectFromState,
  isNewProjectOnboardingIncomplete,
  canRepairNewProjectOnboardingState,
  repairNewProjectOnboardingState,
  PROJECT_CONTEXT_ANSWER_KEYS,
  projectContextOriginalPrompt,
  promptMatches,
  projectContextDomainQuestionLines,
  projectContextChatFallback,
  mobileChatFallback,
  codeGraphChatFallback,
  singleSelectPromptRequest,
  secureTextPromptRequest,
  authChoicePromptRequest,
  authApiKeyPromptRequest,
  sessionExpiredPromptRequest,
  performancePromptRequest,
  openCodePromptRequest,
  teamConfirmationPromptRequest,
  projectContextPromptRequest,
  mobilePromptRequest,
  codeGraphPromptRequest,
  nextOnboardingStep,
  nextOnboardingStepPromptAndRequest,
  nextOnboardingStepPrompt,
  nextOnboardingPromptRequest,
  onboardingGateFallbackReason,
  needsTeamConfirmation,
  teamConfirmationPromptContext,
  teamConfirmationGateFallbackReason,
  isMutatingPreToolUse,
  isReadOnlyOrientationToolUse,
  repairedMaterializationDenyReason,
  agentMaterializationDenyReason,
  agentMaterializationMissingReason,
  denyPreToolUse,
};
