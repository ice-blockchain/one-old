'use strict';

// scripts/hook-runtime/handlers.cjs
// Five handlers, one per hook subcommand. Each is a pure function:
//   input → { stdout, exitCode } (no side effects on stdin/stdout/stderr).
// The thin entry script (`scripts/hook-runtime.cjs`) wires stdin/stdout
// around them.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const {
  STATE_FILE,
  BUDGET_CHARS,
  RN_STACKS,
  WEB_STACKS,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
  pluginRoot,
} = require('./config.cjs');

const {
  parseJsonText,
  safeReadJson,
  nowIso,
  readState,
  writeState,
  normalizeState,
  initializeToolchainState,
  hasValidTeamState,
  hasValidProjectContext,
  hasValidPerformanceState,
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
} = require('./state.cjs');

const {
  PERFORMANCE_LEVEL_IDS,
  performanceChatFallback,
  modelForRoleHost,
  teamModeForLevel,
} = require('./agents-performance-prompt.cjs');

const { STACKS, stackSpecForState, roleScopedRules } = require('./stacks.cjs');

const {
  listAllSkills,
  pruneSkillsDirective,
  cleanActiveSkills,
  copyActiveSkills,
} = require('./skill-filters.cjs');

const {
  loadPackageJson,
  dependenciesFromPackage,
  detectMode,
  detectStackFromCodebase,
  classifyPromptForStack,
} = require('./detection.cjs');

const { packBundle, packRuleIndex, packFixCycleHeader } = require('./packing.cjs');
const {
  materializeProjectAssets,
  hasMaterializedProjectAssets,
  isPluginAuthoringRoot,
} = require('./materialize.cjs');
const {
  computeProjectFingerprint,
} = require('../security-check-runner.cjs');
const {
  maybeStartOneMcpReport,
} = require('../one-mcp-report.cjs');
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
} = require('../traffic-one-auth.cjs');

const {
  onboardingDirectiveNewProject,
  autoDetectedAnnouncement,
  onboardingReminderShort,
  postWriteIncompleteWarning,
  hostPopupInstruction,
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
} = require('./directives.cjs');
const {
  teamConfirmationChatFallback,
} = require('./agents-team-confirmation-prompt.cjs');

const tokenLogger = require('./token-logger.cjs');

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
  // active one per `.traffic-one.json` is what subagents will read.
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
  // Toolchain drift hints. Walk `.traffic-one.json` → `toolchain.*` and
  // surface a one-line nudge per tool whose installed version sits below
  // the plugin's curated `recommended` (or below `minimum` — louder).
  // The curated spec lives at `scripts/toolchain-versions.json`; bump it
  // there to update what every project sees on its next SessionStart.
  try {
    const stateFile = path.join(cwd, '.traffic-one.json');
    if (fs.existsSync(stateFile)) {
      const state = safeReadJson(stateFile, {});
      const toolchain = (state && state.toolchain) || {};
      if (Object.keys(toolchain).length > 0) {
        const tch = require(path.resolve(__dirname, '..', 'toolchain.cjs'));
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

function authChoicePersistenceDiagnostic(writeResult) {
  if (!writeResult || writeResult.ok !== false) return '';
  const code = writeResult.code ? ` (${writeResult.code})` : '';
  return [
    '',
    `Diagnostic: Traffic One could not persist the auth choice state${code}.`,
    'Keep Traffic One inactive and blocked until the user authenticates or chooses to continue without Traffic One. The prompt may repeat until storage is writable.',
    'Run Traffic One doctor to check hook/auth storage setup if this persists.',
  ].join('\n');
}

function authRequiredHookResult(hookEventName, options = {}) {
  const message = authRequiredMessage();
  const persistenceDiagnostic = authChoicePersistenceDiagnostic(options.authChoiceWrite);
  const inactiveMessage = [
    message,
    '',
    'Traffic One is inactive for this prompt because authentication is missing, expired, or rejected.',
    '',
    'Your next assistant action must present a host modal selector with exactly two choices when a modal/popup tool is available:',
    '',
    'Question: Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?',
    'Choices:',
    '- Authenticate Traffic One (Recommended)',
    '- Continue without Traffic One',
    '',
    'If the user chooses Authenticate Traffic One, ask for the Traffic One API key, then run `traffic-one-auth.cjs login` internally with `TRAFFIC_ONE_AUTH_KEY` and verify `traffic-one-auth.cjs status` yourself. Use your own Bash tool — the pre-tool auth gate explicitly bypasses shell invocations of `scripts/traffic-one-auth.cjs (login|status|logout)`, so they will run even while unauthenticated. Do not Write or Edit `auth.json` directly (Write/Edit are blocked, and only the script can mint a valid session token). Do not ask the user to run bash or shell commands.',
    'If the user chooses Continue without Traffic One, continue the user request with Traffic One disabled and remember that choice for this project so this prompt is not repeated here while it remains active.',
    '',
    'Do not answer pending Traffic One onboarding choices, inspect, scaffold, or build through Traffic One until the user makes this auth choice.',
    persistenceDiagnostic,
  ].join('\n');
  const hookSpecificOutput = {
    hookEventName,
    additionalContext: inactiveMessage,
  };
  const payload = {
    systemMessage: 'traffic-one inactive: authentication choice required',
    promptRequest: authChoicePromptRequest(inactiveMessage),
    hookSpecificOutput,
  };
  return {
    stdout: JSON.stringify(payload),
    exitCode: 0,
  };
}

function extractPromptText(rawInput) {
  const parsed = parseJsonText(rawInput, null);
  if (parsed && typeof parsed === 'object') {
    return String(parsed.prompt || parsed.user_prompt || parsed.text || '');
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

const AUTH_CHOICE_STATE_VERSION = 3;
const AUTH_CHOICE_CONTINUE_TTL_MS = 4 * 60 * 60 * 1000;
const TEAM_MODE_CHANGE_APPROVAL_TTL_MS = 10 * 60 * 1000;

function authChoiceFallbackStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) return null;
  const source = authStatePath(env);
  const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'traffic-one', `auth-choice-${digest}.json`);
}

function authChoiceStatePaths(env = process.env) {
  const primary = authChoiceStatePath(env);
  const fallback = authChoiceFallbackStatePath(env);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

function authChoiceStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) {
    return path.resolve(env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH);
  }
  return path.join(path.dirname(authStatePath(env)), 'auth-choice.json');
}

function normalizeAuthChoiceState(state) {
  if (!state || typeof state !== 'object') {
    return { version: AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} };
  }
  if (state.version === AUTH_CHOICE_STATE_VERSION) {
    return {
      version: AUTH_CHOICE_STATE_VERSION,
      globalChoice: state.globalChoice && typeof state.globalChoice === 'object' ? state.globalChoice : null,
      choices: state.choices && typeof state.choices === 'object' ? state.choices : {},
    };
  }
  if (state.choice && typeof state.choice === 'object') {
    const migrated = { version: AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} };
    if (state.choice.status === 'authenticate') {
      migrated.globalChoice = { ...state.choice, scope: 'global' };
    } else if (typeof state.choice.cwd === 'string' && state.choice.cwd.trim()) {
      migrated.choices[path.resolve(state.choice.cwd)] = {
        ...state.choice,
        scope: 'project',
        cwd: path.resolve(state.choice.cwd),
      };
    }
    return migrated;
  }
  if (state.choices && typeof state.choices === 'object') {
    const choices = {};
    let globalChoice = null;
    for (const [key, record] of Object.entries(state.choices)) {
      if (!record || typeof record !== 'object' || typeof record.status !== 'string') continue;
      const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : key;
      if (record.status === 'authenticate') {
        if (!globalChoice || Date.parse(record.updatedAt || '') > Date.parse(globalChoice.updatedAt || '')) {
          globalChoice = { ...record, scope: 'global' };
        }
        continue;
      }
      choices[path.resolve(cwd)] = { ...record, scope: 'project', cwd: path.resolve(cwd) };
    }
    return { version: AUTH_CHOICE_STATE_VERSION, globalChoice, choices };
  }
  return { version: AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} };
}

function readAuthChoiceState(env = process.env) {
  for (const filePath of authChoiceStatePaths(env)) {
    if (!fs.existsSync(filePath)) continue;
    const state = safeReadJson(filePath, null);
    if (state && typeof state === 'object') return normalizeAuthChoiceState(state);
  }
  return { version: AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} };
}

function writeAuthChoiceState(state, env = process.env) {
  const paths = authChoiceStatePaths(env);
  const errors = [];
  for (const filePath of paths) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // best-effort; some filesystems ignore chmod.
      }
      return { ok: true, filePath, fallback: filePath !== paths[0] };
    } catch (error) {
      errors.push({ filePath, error });
    }
  }
  const first = errors[0] && errors[0].error ? errors[0].error : new Error('auth choice state write failed');
  first.authChoiceWriteErrors = errors;
  throw first;
}

function readAuthChoice(cwd = process.cwd(), env = process.env) {
  const state = readAuthChoiceState(env);
  const key = path.resolve(cwd || process.cwd());
  const projectChoice = state.choices && state.choices[key] && typeof state.choices[key] === 'object'
    ? state.choices[key]
    : null;
  if (projectChoice && projectChoice.status === 'continue-without-traffic-one') {
    const expires = Date.parse(projectChoice.expiresAt || '');
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      return state.globalChoice || projectChoice;
    }
    return projectChoice;
  }
  if (state.globalChoice && state.globalChoice.status === 'authenticate') {
    return state.globalChoice;
  }
  return projectChoice || state.globalChoice || null;
}

function authChoiceStatus(cwd = process.cwd(), env = process.env) {
  const record = readAuthChoice(cwd, env);
  return record && typeof record.status === 'string' ? record.status : null;
}

function writeAuthChoice(status, cwd = process.cwd(), env = process.env) {
  const state = readAuthChoiceState(env);
  const now = Date.now();
  const key = path.resolve(cwd || process.cwd());
  const record = {
    status,
    scope: status === 'authenticate' ? 'global' : 'project',
    ...(status === 'authenticate' ? {} : { cwd: key }),
    updatedAt: nowIso(),
  };
  if (status === 'continue-without-traffic-one') {
    record.expiresAt = new Date(now + AUTH_CHOICE_CONTINUE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  state.choices = state.choices && typeof state.choices === 'object' ? state.choices : {};
  if (status === 'authenticate') {
    state.globalChoice = record;
    delete state.choices[key];
  } else {
    state.choices[key] = record;
  }
  return writeAuthChoiceState(state, env);
}

function tryWriteAuthChoice(status, cwd = process.cwd(), env = process.env) {
  try {
    const result = writeAuthChoice(status, cwd, env);
    return { ok: true, ...(result || {}) };
  } catch (error) {
    return {
      ok: false,
      code: error && error.code ? String(error.code) : null,
      message: error && error.message ? String(error.message) : 'auth choice state write failed',
    };
  }
}

function authChoiceAllowsContinue(cwd = process.cwd(), env = process.env, nowMs = Date.now()) {
  const record = readAuthChoice(cwd, env);
  if (!record || record.status !== 'continue-without-traffic-one') return false;
  const expires = Date.parse(record.expiresAt || '');
  return Number.isFinite(expires) && expires > nowMs;
}

function parseUnauthenticatedAuthChoice(rawInput, options = {}) {
  const prompt = extractPromptText(rawInput).trim().toLowerCase();
  if (!prompt) return null;
  const compact = prompt
    .replace(/[`"'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return null;
  const mentionsTrafficOne = /\btraffic one\b/.test(compact);
  if (options.allowNumeric === true) {
    if (/^(1|one)$/.test(compact)) {
      return 'authenticate';
    }
    if (/^(2|two)$/.test(compact)) {
      return 'continue-without-traffic-one';
    }
  }
  if (
    (mentionsTrafficOne && /\b(authenticate|auth|login|log in|sign in|signin)\b/.test(compact))
    || /^(authenticate|auth|login|log in|sign in|signin|yes)$/.test(compact)
  ) {
    return 'authenticate';
  }
  const continueWithout = [
    /^(continue|proceed|skip|without|no)$/,
    /\bcontinue without\b/,
    /\bwithout traffic one\b/,
    /\bdont use\b/,
    /\bdo not use\b/,
    /\bnot use\b/,
    /\bskip\b/,
    /\bignore\b/,
    /\bdisable\b/,
    /\binactive\b/,
  ];
  if (
    continueWithout.some((pattern) => pattern.test(compact))
    || (mentionsTrafficOne && /\b(continue|proceed|skip|ignore|without|disable|inactive|no)\b/.test(compact))
  ) {
    return 'continue-without-traffic-one';
  }
  return null;
}

function parseTrafficOneApiKey(rawInput) {
  let prompt = extractPromptText(rawInput).trim();
  if (!prompt) return null;
  prompt = prompt
    .replace(/^```[a-zA-Z0-9_-]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  if (/^(cancel|stop|never mind|nevermind)$/i.test(prompt)) return null;
  const assignment = prompt.match(/\bTRAFFIC_ONE_AUTH_KEY\s*=\s*([A-Za-z0-9._:-]{8,})\b/);
  if (assignment) return assignment[1];
  const keyPhrase = prompt.match(/\b(?:use\s+)?(?:the\s+)?(?:api\s+)?key\s+(?:is\s+)?([A-Za-z0-9][A-Za-z0-9._:-]{7,})\b/i);
  if (keyPhrase) return keyPhrase[1];
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/.test(prompt)) return prompt;
  return null;
}

function authChoiceHookResult(choice) {
  if (choice === 'authenticate') {
    const writeResult = tryWriteAuthChoice('authenticate', process.cwd());
    return authApiKeyPromptHookResult({ authChoiceWrite: writeResult });
  }

  const writeResult = tryWriteAuthChoice('continue-without-traffic-one', process.cwd());
  const rememberedLine = writeResult.ok
    ? 'This choice has been remembered for this project so the auth prompt is not repeated here while it remains active.'
    : 'This choice could not be persisted, so the auth prompt may repeat until Traffic One auth-choice storage is writable.';
  const payload = {
    systemMessage: 'traffic-one inactive: user chose to continue without Traffic One',
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        'The user chose to continue without using the Traffic One plugin.',
        'Proceed with the user request using normal non-Traffic-One behavior only.',
        'Do not run Traffic One skills, onboarding, setup, reporting, materialization, agents, or hooks for this request.',
        rememberedLine,
        authChoicePersistenceDiagnostic(writeResult).trim(),
      ].join('\n'),
    },
  };
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

function authChoiceRequiredDenyReason() {
  return [
    'Traffic One authentication choice required before tool use.',
    '',
    'Authentication is missing, expired, or rejected. The assistant must not continue with tools until the user chooses one path.',
    '',
    'Present this as a host modal selector when a modal/popup tool is available:',
    'Question: Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?',
    'Choices: Authenticate Traffic One (Recommended); Continue without Traffic One.',
    '',
    'If Authenticate Traffic One is chosen, ask for the API key, then invoke `scripts/traffic-one-auth.cjs login` via your own Bash tool with `TRAFFIC_ONE_AUTH_KEY=<key>` in env (the pre-tool gate bypasses `scripts/traffic-one-auth.cjs (login|status|logout)` while unauthenticated). Do not Write/Edit `auth.json` directly, and do not ask the user to run bash or shell commands.',
    'If Continue without Traffic One is chosen, remember the choice for this project and continue the request using normal non-Traffic-One behavior only.',
    '',
    'Do not inspect, scaffold, install, edit, or build before the user answers this auth choice.',
  ].join('\n');
}

// True only for a previously-authenticated session that timed out: the stored
// state is structurally valid and points at the right endpoint, just past its
// TTL. That is recoverable with the same key, so we ask for only the key
// instead of the cold "Authenticate / Continue without" first-run modal. A
// missing state, endpoint mismatch, or malformed token is NOT treated as expiry.
function isSessionExpiryReauth(authGate, env = process.env) {
  if (authGate && authGate.priorReason === FRESHNESS_REASON.EXPIRED) return true;
  return authStateFreshness(readTrafficOneAuthState(env), env).reason === FRESHNESS_REASON.EXPIRED;
}

function sessionExpiredReauthContext() {
  return [
    'Your Traffic One session has expired. Do not continue implementation yet.',
    'This is a session refresh, not first-time setup — the user already authenticated, so only a fresh API key is needed. Do not offer "Continue without Traffic One" here.',
    'Ask the user for their Traffic One API key using a secure host input/modal if available.',
    'After the user provides the key, re-authenticate internally with TRAFFIC_ONE_AUTH_KEY and verify status internally.',
    'Internally means: invoke `scripts/traffic-one-auth.cjs login` (then `status`) through your own Bash tool with `TRAFFIC_ONE_AUTH_KEY=<key>` in env. The pre-tool gate explicitly allows these `scripts/traffic-one-auth.cjs (login|refresh|status|logout)` shell invocations while unauthenticated, so the call will go through. Do not Write or Edit `auth.json` directly.',
    'Do not ask the user to run bash or shell commands. Do not echo the key back to the user.',
    'Tip: export TRAFFIC_ONE_AUTH_KEY in the environment so the session refreshes automatically without prompting.',
  ].join('\n');
}

function sessionExpiredReauthPreToolResult() {
  const reason = sessionExpiredReauthContext();
  return denyPreToolUse(reason, sessionExpiredPromptRequest(reason));
}

function sessionExpiredReauthPromptResult() {
  const additionalContext = sessionExpiredReauthContext();
  const payload = {
    systemMessage: 'traffic-one session expired — re-authentication key required',
    promptRequest: sessionExpiredPromptRequest(additionalContext),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

function parseAuthStatusOutput(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function authApiKeyPromptHookResult(options = {}) {
  const additionalContext = [
    'The user chose to authenticate Traffic One. Do not continue implementation yet.',
    'Ask the user for the Traffic One API key using a secure host input/modal if available.',
    'After the user enters the key, run authentication internally with TRAFFIC_ONE_AUTH_KEY and verify status internally.',
    'Internally means: invoke `scripts/traffic-one-auth.cjs login` (then `status`) through your own Bash tool with `TRAFFIC_ONE_AUTH_KEY=<key>` in env. The pre-tool gate explicitly allows these `scripts/traffic-one-auth.cjs (login|status|logout)` shell invocations while unauthenticated, so the call will go through. Do not Write or Edit `auth.json` directly — that path is blocked, and only the script can mint a valid session token.',
    'Do not ask the user to run bash or shell commands. Do not echo the key back to the user.',
    authChoicePersistenceDiagnostic(options.authChoiceWrite).trim(),
  ].join('\n');
  const payload = {
    systemMessage: 'traffic-one authentication key required',
    promptRequest: authApiKeyPromptRequest(additionalContext),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

function runInternalAuthLogin(apiKey) {
  const authScript = path.resolve(__dirname, '..', 'traffic-one-auth.cjs');
  const timeoutMs = Number.parseInt(process.env.TRAFFIC_ONE_AUTH_LOGIN_TIMEOUT_MS || '10000', 10);
  const env = { ...process.env, TRAFFIC_ONE_AUTH_KEY: apiKey };
  const options = {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
    maxBuffer: 64 * 1024,
  };
  const loginResult = spawnSync(process.execPath, [authScript, 'login'], options);
  const loginParsed = parseAuthStatusOutput(loginResult.stdout);
  if (loginResult.status !== 0 || !loginParsed || loginParsed.ok !== true) {
    return {
      ok: false,
      reason: (loginResult.stderr || '').trim() || (loginParsed && loginParsed.reason) || 'login-failed',
    };
  }
  const statusResult = spawnSync(process.execPath, [authScript, 'status'], {
    ...options,
    env: process.env,
  });
  const statusParsed = parseAuthStatusOutput(statusResult.stdout);
  if (statusResult.status === 0 && statusParsed && statusParsed.authenticated === true) {
    return { ok: true, status: statusParsed };
  }
  return {
    ok: false,
    reason: (statusResult.stderr || '').trim() || (statusParsed && statusParsed.reason) || 'status-check-failed',
  };
}

function authLoginFromPromptHookResult(apiKey) {
  const result = runInternalAuthLogin(apiKey);
  if (!result.ok) {
    const payload = {
      systemMessage: 'traffic-one authentication failed',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          'Traffic One authentication failed while running the internal login/status flow.',
          result.reason ? `Reason: ${result.reason}` : 'Reason: unknown failure',
          'Ask the user to re-enter the API key. Do not echo the key and do not ask the user to run shell commands.',
        ].join('\n'),
      },
    };
    return { stdout: JSON.stringify(payload), exitCode: 0 };
  }
  const payload = {
    systemMessage: 'traffic-one authenticated',
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        'Traffic One authentication completed internally and status reports authenticated.',
        'Continue the user request with Traffic One enabled.',
      ].join('\n'),
    },
  };
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

function authGateForHook({ forceRemote = false } = {}) {
  const authScript = path.resolve(__dirname, '..', 'traffic-one-auth.cjs');
  const timeoutMs = Number.parseInt(process.env.TRAFFIC_ONE_AUTH_REMOTE_CHECK_TIMEOUT_MS || '5000', 10);
  const runStatus = (statusArgs) => spawnSync(process.execPath, [authScript, ...statusArgs], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    maxBuffer: 64 * 1024,
  });

  if (!isAuthenticatedLocal()) {
    const refreshResult = runStatus(['status']);
    const refreshParsed = parseAuthStatusOutput(refreshResult.stdout);
    if (refreshResult.status === 0 && refreshParsed && refreshParsed.authenticated === true) {
      return {
        authenticated: true,
        checkedRemote: false,
        reauthenticated: refreshParsed.reauthenticated === true,
      };
    }
    return {
      authenticated: false,
      reason: (refreshParsed && refreshParsed.reason) || (refreshResult.error && refreshResult.error.message) || 'local-auth-required',
      priorReason: (refreshParsed && refreshParsed.priorReason) || null,
    };
  }

  const authState = readTrafficOneAuthState();
  if (!forceRemote && !authRemoteCheckDue(authState)) {
    return { authenticated: true, checkedRemote: false };
  }

  const result = runStatus(['status', '--remote']);
  const parsed = parseAuthStatusOutput(result.stdout);
  if (parsed && parsed.authenticated === false) {
    return {
      authenticated: false,
      reason: parsed.reason || 'remote-auth-required',
      priorReason: parsed.priorReason || null,
    };
  }
  if (!parsed || result.status !== 0 || parsed.remoteChecked === false) {
    // Test-only escape hatch for deterministic stack tests without a live auth server.
    if (process.env.TRAFFIC_ONE_AUTH_ALLOW_REMOTE_CHECK_FAILURE === '1') {
      return {
        authenticated: true,
        checkedRemote: true,
        remoteCheckFailed: true,
      };
    }
    return {
      authenticated: false,
      reason: (parsed && parsed.reason) || (result.error && result.error.message) || 'remote-auth-check-failed',
    };
  }
  return {
    authenticated: true,
    checkedRemote: true,
    remoteCheckFailed: false,
  };
}

function authPreToolGate(toolName, toolInput = {}) {
  if (isPluginAuthoringRoot(process.cwd())) return null;
  const authGate = authGateForHook();
  if (authGate.authenticated) return null;
  const command = commandFromToolInput(toolInput);
  if (isShellToolName(toolName) && (
    isTrafficOneAuthCommand(command) ||
    isTrafficOneDoctorCommand(command)
  )) {
    return { stdout: '', exitCode: 0 };
  }
  if (authChoiceAllowsContinue()) {
    return { stdout: '', exitCode: 0 };
  }
  if (isSessionExpiryReauth(authGate)) {
    return sessionExpiredReauthPreToolResult();
  }
  const reason = authChoiceRequiredDenyReason();
  return denyPreToolUse(reason, authChoicePromptRequest(reason));
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
    if (fs.existsSync(path.join(current, STATE_FILE))) {
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
  return normalized === STATE_FILE || normalized.endsWith(`/${STATE_FILE}`);
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
  const statePath = path.join(cwd, STATE_FILE);
  const currentText = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
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
    + 'Do not add or refresh it in `.traffic-one.json` manually.'
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
    'Traffic One team mode guard: `.traffic-one.json` currently records `team.mode="subagents"`. '
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

  const statePath = path.join(cwd, STATE_FILE);
  const state = safeReadJson(statePath, null);
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
  if (!authGateForHook().authenticated) return;
  if (!isCompletedTrafficOneMaterialization(cwd, state)) return;
  try {
    maybeStartOneMcpReport(cwd, { state, trigger });
  } catch {
    // Anonymous structural reporting must never block or alter the coding flow.
  }
}

const PROJECT_ROOT_HINT_FIELDS = [
  'file_path',
  'path',
  'cwd',
  'workdir',
];
const PROJECT_COMMAND_HINT_FIELDS = [
  'command',
  'cmd',
  'shell_command',
];
const PROJECT_PATH_TOKEN_RE = /(?:^|[\s"'`=])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+(?:[A-Za-z0-9_.@-]+)?)(?=$|[\s"'`,;|&])/g;

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
    if (fs.existsSync(path.join(current, STATE_FILE))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function projectRootsFromToolInputHints(cwd, toolInput) {
  const roots = new Set();
  const addHint = (hint) => {
    const root = projectRootForPathHint(cwd, hint);
    if (root) roots.add(root);
  };

  for (const field of PROJECT_ROOT_HINT_FIELDS) {
    if (typeof toolInput[field] === 'string') {
      addHint(toolInput[field]);
    }
  }

  for (const field of PROJECT_COMMAND_HINT_FIELDS) {
    const command = typeof toolInput[field] === 'string' ? toolInput[field] : '';
    if (!command) continue;
    for (const match of command.matchAll(PROJECT_PATH_TOKEN_RE)) {
      addHint(match[1]);
    }
  }

  return [...roots];
}

function materializeFromToolInputHints(cwd, toolInput, trigger = 'generic post-tool convergence') {
  for (const projectRoot of projectRootsFromToolInputHints(cwd, toolInput)) {
    const relativeRoot = path.relative(cwd, projectRoot).replace(/\\/g, '/') || '.';
    const result = materializeProjectIfNeeded(projectRoot, `${trigger}: ${relativeRoot}`);
    if (result && result.stdout) {
      return result;
    }
    const state = readState(projectRoot);
    startOneMcpReportBestEffort(projectRoot, state, `${trigger}: ${relativeRoot}`);
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

function materializeFromProjectMemoryWrite(cwd, filePath) {
  const projectRoot = findProjectRootForHookFile(cwd, filePath);
  if (isPluginAuthoringRoot(projectRoot)) return null;

  const relativePath = projectRelativeHookPath(cwd, projectRoot, filePath);
  if (!isProjectMemoryWritePath(relativePath)) return null;

  const statePath = path.join(projectRoot, STATE_FILE);
  const state = safeReadJson(statePath, null);
  if (!state || !state.stack || !STACK_IDS.has(state.stack) || state.onboardingComplete !== true) {
    return null;
  }

  try {
    if (normalizeState(state, detectMode(projectRoot))) {
      writeState(projectRoot, state);
    }
    const materialized = materializeProjectAssets(projectRoot, state);
    if (!materialized.skipped) {
      state.materializedStack = stackFingerprint(state);
      state.materializedAt = nowIso();
      state.materializedVersion = getPluginVersion();
      writeState(projectRoot, state);
    }
    startOneMcpReportBestEffort(projectRoot, state, `project-memory write: ${relativePath}`);
    return materializationSuccessResult(materialized, relativePath);
  } catch (error) {
    return materializationFailureResult(error);
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
    return ['`.traffic-one.json` must contain a JSON object.'];
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

  const statePath = path.join(cwd, STATE_FILE);
  const state = safeReadJson(statePath, null);
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];

  if (!state || typeof state !== 'object') {
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one — `.traffic-one.json` is missing or invalid; cannot materialize project rules',
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
        systemMessage: 'traffic-one — `.traffic-one.json` is incomplete; cannot materialize project rules yet',
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
    'Save the answer in `.traffic-one.json` as `projectContext` with `source`, `originalPrompt`, `summary`, `answers`, and `collectedAt` before asking the Mobile App prompt.',
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
    'Re-write `.traffic-one.json` with the full required schema before continuing.',
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
    'The onboarding state remains incomplete until `.traffic-one.json` contains stack, frontend, backend, projectContext, mobile, technologies, codeGraphProvider, performance, team (including `team.approved: true` after Team Confirmation for Balanced/High), toolchain, confirmed, onboardingComplete, and confirmedAt.',
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
    'The user selected a multi-agent performance level, but `.traffic-one.json` does not contain `team.approved: true`.',
    'Do not spawn Task/spawn_agent/background-agent workers, do not write feature source, and do not set `team.source: "unavailable"` as a shortcut. If subagents are unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before any state rewrite.',
    source === 'user-prompt'
      ? 'If the latest user message is an explicit "Approve" answer to this Team Confirmation prompt, first rewrite `.traffic-one.json` with `team.approved: true` (and any collected `team.overrides`), then continue.'
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

function repairedMaterializationDenyReason() {
  return [
    'Traffic One state was repaired/materialized before this tool use.',
    'The attempted mutating tool has been denied once so it cannot run against stale `.traffic-one.json`, rules, skills, or root agent context.',
    'rerun the same tool now; the canonical `.traffic-one.json` and project-local materialization are current.',
  ].join('\n');
}

function agentMaterializationDenyReason() {
  return [
    'Traffic One agent spawn gate: state was repaired/materialized before this agent spawn.',
    'The role agent has been denied once so frontend/backend workers cannot start against stale `.traffic-one.json`, rules, skills, or root agent context.',
    'rerun the same agent spawn now; the canonical `.traffic-one.json` and project-local materialization are current.',
  ].join('\n');
}

function agentMaterializationMissingReason() {
  return [
    'Traffic One agent spawn gate: project-local rules/skills are not materialized yet.',
    'Do not spawn frontend/backend/reviewer/tester workers until `.traffic-one.json` has current `materializedStack`, `materializedAt`, and `materializedVersion`, and `.traffic-one/manifest.json`, `.traffic-one/rules/**`, `.traffic-one/skills/**`, root `AGENTS.md`, and root `CLAUDE.md` exist.',
    'Run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project` from the project root, then retry the agent spawn.',
  ].join('\n');
}

// Digest retention: keep only the N most recent .traffic-one/digests/<runId>/
// directories. Without this, every orchestrator run accumulates ~12KB of
// digests forever — and subagents that read predecessor digests pay for the
// cruft. Runs once at SessionStart for both parent and subagent paths.
function sweepOldDigests(cwd, keepCount = 5) {
  const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
  if (!fs.existsSync(digestsRoot)) return 0;
  let entries;
  try {
    entries = fs.readdirSync(digestsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()      // ISO-timestamp dir names sort chronologically
      .reverse();  // newest first
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries.slice(keepCount)) {
    try {
      fs.rmSync(path.join(digestsRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort; never block SessionStart on retention sweep
    }
  }
  return removed;
}

// Read the compact graph preview (~500 tokens) written by gitnexus/graphify
// runners. Subagents see top-level module names without doing a full Read of
// the graph artefact, so they can scope their work immediately.
function readGraphPreview(cwd) {
  const previewPath = path.join(cwd, '.traffic-one', 'graph-preview.md');
  if (!fs.existsSync(previewPath)) return '';
  try {
    return `\n${fs.readFileSync(previewPath, 'utf8').trimEnd()}\n`;
  } catch {
    return '';
  }
}

function ensureSessionMaterialization(cwd, state) {
  if (isPluginAuthoringRoot(cwd)) return false;
  if (!state || typeof state !== 'object') return false;
  if (state.onboardingComplete !== true) return false;
  if (!state.stack || !STACK_IDS.has(state.stack)) return false;

  const hasFreshStamp = isMaterialized(state);
  const hasAssets = hasMaterializedProjectAssets(cwd, state);
  if (hasFreshStamp && hasAssets) {
    startOneMcpReportBestEffort(cwd, state, 'session materialization already current');
    return false;
  }

  normalizeState(state, state.mode || detectMode(cwd));
  const materialized = materializeProjectAssets(cwd, state);
  if (materialized.skipped) {
    startOneMcpReportBestEffort(cwd, state, 'session materialization skipped');
    return false;
  }
  state.materializedStack = stackFingerprint(state);
  state.materializedAt = nowIso();
  state.materializedVersion = getPluginVersion();
  writeState(cwd, state);
  startOneMcpReportBestEffort(cwd, state, 'session materialization');
  return true;
}

// ── SessionStart ─────────────────────────────────────────────────────────────
function runSessionStart(rawInput = '') {
  const cwd  = process.cwd();
  const root = pluginRoot();

  if (isPluginAuthoringRoot(cwd)) {
    return { stdout: '', exitCode: 0 };
  }

  const authGate = authGateForHook({ forceRemote: true });
  if (!authGate.authenticated) {
    if (authChoiceAllowsContinue(cwd)) return { stdout: '', exitCode: 0 };
    const writeResult = tryWriteAuthChoice('pending-choice', cwd);
    return authRequiredHookResult('SessionStart', { authChoiceWrite: writeResult });
  }

  const state = readState(cwd);

  // MULTI-PROJECT SAFETY: clean non-bootstrap skills left by the previous
  // project's session. The plugin cache is shared across all traffic-one
  // projects on this machine; this ensures each session starts from a clean
  // 3-skill baseline before copying the correct set for THIS project.
  cleanActiveSkills();

  // Digest retention sweep (cheap, idempotent). Keeps the last 5 orchestrator
  // runs and removes older ones from .traffic-one/digests/.
  sweepOldDigests(cwd, 5);

  try {
    ensureSessionMaterialization(cwd, state);
  } catch {
    // Best-effort: if local materialization fails, the normal/full SessionStart
    // branch below still provides rule context instead of trusting a stale stamp.
  }

  // SUBAGENT FAST PATH. Prefer a per-agent run claim resolved from the actual
  // hook session id. Legacy .traffic-one.json activeAgentRole remains a fallback
  // only when no per-run agent state exists yet.
  const agentContext = resolveRunAgentContext(cwd, state, rawInput, { claimPending: true })
    || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
  if (agentContext && hasMaterializedProjectAssets(cwd, state)) {
    const role = agentContext.role;
    const runId = agentContext.runId;
    const spawnIndex = agentContext.spawnIndex || 0;

    // FIX-CYCLE BRANCH. Same role re-spawned in the same run (spawnIndex > 1)
    // = the reviewer found issues and the orchestrator is looping back. The
    // role has its own prior digest + a fix-cycle context file written by the
    // orchestrator with EXACT findings to apply. Emit ~500 bytes of pointers
    // and tell the model not to re-explore. Saves ~25-30K tokens vs the
    // already-slim role-scoped index, ~115KB vs the full bundle.
    if (role && spawnIndex > 1) {
      const { body } = packFixCycleHeader(cwd, role, runId, spawnIndex);
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: body,
          },
        }),
        exitCode: 0,
      };
    }

    // Standard subagent path: role-scoped rule index (~2-5KB).
    const ruleSet = role ? roleScopedRules(role, state) : null;
    const rules = ruleSet || stackSpecForState(state).mandatory;

    copyActiveSkills(state);
    const allSkills = listAllSkills();
    const skillDirective = pruneSkillsDirective(state, allSkills);
    const { body } = packRuleIndex(root, rules);
    const graphPreview = readGraphPreview(cwd);
    const roleLabel = role || 'subagent';

    const header = `═══ traffic-one — ${roleLabel} (run ${runId}) ═══\n`
      + `[subagent] Full rules already loaded by parent session and materialized to `
      + `.traffic-one/rules/. This index lists role-scoped rules; Read them on demand.\n`;
    const context = `${header}${skillDirective}${graphPreview}\n${body}`;
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }),
      exitCode: 0,
    };
  }

  const mode = state.mode || detectMode(cwd);
  state.mode = mode;

  let stackId = state.stack;

  // Tolerate a partial state file (e.g. {stack, backend, realtime, version}
  // without onboardingComplete) — fill in defaults rather than re-running
  // onboarding. The user already picked a stack; we just complete bookkeeping.
  if (stackId && isKnownStack(stackId)) {
    normalizeState(state, mode);
    stackId = state.stack;
  }

  const onboardingComplete = Boolean(state.onboardingComplete);
  const onboardingReady = onboardingComplete
    && STACK_IDS.has(stackId)
    && (mode !== 'new-project' || !isNewProjectOnboardingIncomplete(state));

  // Flow 1 — already onboarded (or partial state with valid stack) → pack bundle
  if (onboardingReady) {
    const spec = stackSpecForState(state);

    // Splice in the mode-specific rule if it exists (e.g. modes/new-project.md
    // contains the Turborepo scaffold checklist that the model needs to see).
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath))
      ? [...spec.mandatory, modeRulePath]
      : spec.mandatory;

    const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

    const copied = copyActiveSkills(state);
    const allSkills = listAllSkills();
    const skillDirective = pruneSkillsDirective(state, allSkills);
    let sessionMaterialized = false;
    try {
      const materialized = materializeProjectAssets(cwd, state);
      sessionMaterialized = !materialized.skipped;
    } catch {
      // Best-effort: SessionStart can still provide the in-memory rule bundle,
      // but it must not stamp .traffic-one.json as materialized unless the
      // project-local rules, skills, manifest, and root context files exist.
    }
    if (sessionMaterialized) {
      state.materializedStack   = stackFingerprint(state);
      state.materializedAt      = nowIso();
      state.materializedVersion = getPluginVersion();
    }

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (copied > 0) {
      header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    }
    if (dropped.length > 0) {
      header += `[${dropped.length} rule file(s) deferred to path-scoped attach]\n`;
    }
    header += tokenEconomyBanner(cwd);
    if (skillDirective) {
      header += skillDirective;
    }
    const graphPreview = readGraphPreview(cwd);
    const context = `${header}${graphPreview}\n${body}`;
    writeState(cwd, state);
    startOneMcpReportBestEffort(cwd, state, 'session-start');
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }),
      exitCode: 0,
    };
  }

  // Flow 2 — existing project with detectable stack → auto-write + prune
  if (mode === 'existing-codebase' || mode === 'existing-with-supabase') {
    const detected = detectStackFromCodebase(cwd);
    if (!detected.stack) {
      detected.stack = 'minimal';
      detected.backend = detected.backend || 'other';
      detected.realtime = detected.realtime || 'none';
      detected.evidence.push('existing codebase detected → apply minimal stack baseline');
    }

    if (detected.stack) {
      Object.assign(state, {
        mode,
        stack:                detected.stack,
        backend:              detected.backend || 'other',
        frontend:             detected.frontend || 'none',
        ...(detected.mobile ? { mobile: detected.mobile } : {}),
        realtime:             detected.realtime || 'none',
        confirmed:            true,
        onboardingComplete:   true,
        confirmedAt:          nowIso(),
        autoDetected:         true,
        evidence:             detected.evidence,
      });

      normalizeState(state, mode);

      const spec = stackSpecForState(state);

      // Splice in the mode-specific rule (e.g. modes/existing-codebase.md)
      const modeRulePath = `rules/modes/${mode}.md`;
      const modeMandatory = fs.existsSync(path.join(root, modeRulePath))
        ? [...spec.mandatory, modeRulePath]
        : spec.mandatory;

      const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

      const copied2 = copyActiveSkills(state);
      const allSkills = listAllSkills();
      let autoMaterialized = false;
      try {
        const materialized = materializeProjectAssets(cwd, state);
        autoMaterialized = !materialized.skipped;
      } catch {
        // Best-effort: auto-detection still succeeds, but do not claim the
        // project-local materialization is present when the copy failed.
      }
      if (autoMaterialized) {
        state.materializedStack   = stackFingerprint(state);
        state.materializedAt      = nowIso();
        state.materializedVersion = getPluginVersion();
      }
      writeState(cwd, state);
      startOneMcpReportBestEffort(cwd, state, 'session-start auto-detect');
      const skillDirective = pruneSkillsDirective(state, allSkills);

      const banner = autoDetectedAnnouncement(detected);
      let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
      if (copied2 > 0) {
        header += `[skills] ${copied2} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
      }
      if (dropped.length > 0) {
        header += `[${dropped.length} rule file(s) deferred]\n`;
      }
      header += tokenEconomyBanner(cwd);
      if (skillDirective) {
        header += skillDirective;
      }
      const graphPreview = readGraphPreview(cwd);
      const context = `${banner}\n\n${header}${graphPreview}\n${body}`;
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: context,
          },
        }),
        exitCode: 0,
      };
    }
  }

  // Flow 3 — new project (or undetectable existing) → onboarding directive
  const directive = onboardingDirectiveNewProject();
  const spec = STACKS.minimal;
  const { body } = packBundle(root, spec.mandatory, spec.optional, Math.floor(BUDGET_CHARS / 2));
  const context = `${directive}\n\n═══ Baseline rules (in effect until onboarding completes) ═══\n${body}`;
  if (!state.toolchain || typeof state.toolchain !== 'object') {
    state.toolchain = initializeToolchainState();
  }
  writeState(cwd, state);
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }),
    exitCode: 0,
  };
}

// ── UserPromptSubmit ─────────────────────────────────────────────────────────
function runUserPromptSubmit(rawInput = '') {
  const cwd = process.cwd();
  if (isPluginAuthoringRoot(cwd)) {
    return { stdout: '', exitCode: 0 };
  }
  const authGate = authGateForHook();
  if (!authGate.authenticated) {
    const choiceStatus = authChoiceStatus(cwd);
    const authChoice = parseUnauthenticatedAuthChoice(rawInput, {
      allowNumeric: choiceStatus === 'pending-choice',
    });
    if (authChoice) {
      return authChoiceHookResult(authChoice);
    }
    if (authChoiceAllowsContinue(cwd)) return { stdout: '', exitCode: 0 };
    if (isSessionExpiryReauth(authGate)) {
      const apiKey = parseTrafficOneApiKey(rawInput);
      if (apiKey) return authLoginFromPromptHookResult(apiKey);
      return sessionExpiredReauthPromptResult();
    }
    if (choiceStatus === 'authenticate') {
      const apiKey = parseTrafficOneApiKey(rawInput);
      if (apiKey) return authLoginFromPromptHookResult(apiKey);
      return authApiKeyPromptHookResult();
    }
    const writeResult = tryWriteAuthChoice('pending-choice', cwd);
    return authRequiredHookResult('UserPromptSubmit', { authChoiceWrite: writeResult });
  }

  const statePath = path.join(process.cwd(), STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return {
      stdout: JSON.stringify({ systemMessage: 'traffic-one active' }),
      exitCode: 0,
    };
  }

  const state = safeReadJson(statePath, null);
  if (!state) {
    return {
      stdout: JSON.stringify({ systemMessage: 'traffic-one active' }),
      exitCode: 0,
    };
  }

  const stack = state.stack || state.mode || 'unknown';
  const normalizedState = JSON.parse(JSON.stringify(state));
  normalizeState(normalizedState, normalizedState.mode || detectMode(process.cwd()));
  const promptText = promptTextFromSubmit(rawInput);
  const teamModeApproval = updateTeamModeChangeApprovalFromPrompt(process.cwd(), normalizedState, promptText);
  if (teamModeApproval.recorded) {
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [team mode switch authorized]',
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: '[ACTIVE STACK: ' + stack + ']\n\n'
            + 'The latest user prompt explicitly requested switching away from subagents to Low/main-agent mode. '
            + 'The next `.traffic-one.json` write may change `performance.level` to "low" and `team.mode` to "main-agent"; '
            + 'this authorization is single-use and expires in 10 minutes.',
        },
      }),
      exitCode: 0,
    };
  }
  if (needsTeamConfirmation(normalizedState)) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${teamConfirmationPromptContext(normalizedState, 'user-prompt')}`;
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [team confirmation required]',
        promptRequest: teamConfirmationPromptRequest(normalizedState, additionalContext),
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      }),
      exitCode: 0,
    };
  }

  const validStack = state.stack && isKnownStack(state.stack);
  const isIncomplete = !validStack || state.onboardingComplete !== true;

  // Re-inject the short onboarding reminder while a new project hasn't yet
  // persisted a valid stack. SessionStart's full directive can scroll out of
  // context across long onboarding turns or compaction; this keeps the model
  // pointed at the schema until `.traffic-one.json` is fully populated.
  if (isIncomplete && state.mode === 'new-project') {
    const reminder = onboardingReminderShort();
    const classification = promptText ? classifyPromptForStack(promptText) : null;
    const promptRequest = nextOnboardingPromptRequest(normalizedState, 'user-prompt');
    const classificationContext = classification
      ? [
        '[FIRST PROMPT STACK CLASSIFICATION]',
        `stack=${classification.stack}`,
        `frontend=${classification.frontend}`,
        `backend=${classification.backend}`,
        `mobile=${classification.mobile.enabled ? classification.mobile.framework : 'none'}`,
        'mode=new-project: complete Traffic One onboarding in the current thread before implementation. If no popup/input tool is available, ask fallback chat questions and stop for typed answers.',
        codexDefaultModeFallbackDirective(),
        `Onboarding choices must be prompt popups. ${hostPopupInstruction()} Do not print numbered option lists in chat when a popup tool is available; never choose a default or continue implementation while an answer is pending.`,
        'Required order: Agent mode (High/Balanced/Low), Team role/model confirmation for High/Balanced, success message, rich MVP-context questionnaire, Mobile App, then Code Graph provider.',
        'Ask only the next unresolved onboarding step below:',
        nextOnboardingStepPrompt(normalizedState, 'user-prompt'),
      ].join('\n')
      : nextOnboardingStepPrompt(normalizedState, 'user-prompt');
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [onboarding incomplete]',
        ...(promptRequest ? { promptRequest } : {}),
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[ACTIVE STACK: ${stack}]\n\n${classificationContext ? `${classificationContext}\n\n` : ''}${reminder}`,
        },
      }),
      exitCode: 0,
    };
  }

  const materialized = materializeProjectIfNeeded(process.cwd(), 'generic user-prompt convergence');
  if (materialized && materialized.stdout) {
    return materialized;
  }

  return {
    stdout: JSON.stringify({
      systemMessage: `traffic-one [${stack}]`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[ACTIVE STACK: ${stack}]`,
      },
    }),
    exitCode: 0,
  };
}

// ── PreToolUse: new-project onboarding gate ──────────────────────────────────
function runCheckOnboardingGate(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const cwd = process.cwd();
  if (isPluginAuthoringRoot(cwd)) return { stdout: '', exitCode: 0 };
  const authGate = authPreToolGate(toolName, toolInput);
  if (authGate) return authGate;

  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  const statePath = path.join(cwd, STATE_FILE);
  const state = safeReadJson(statePath, {});
  const mode = state.mode || detectMode(cwd);
  const effectiveState = {
    ...state,
    mode,
  };
  normalizeState(effectiveState, mode);

  const teamModeApprovalMarkerGuard = teamModeApprovalMarkerWriteGuard(cwd, toolName, toolInput);
  if (teamModeApprovalMarkerGuard) return teamModeApprovalMarkerGuard;

  const teamModeGuard = teamModeDowngradeGuard(cwd, toolName, toolInput, effectiveState);
  if (teamModeGuard) return teamModeGuard;

  if (isStateFilePath(filePath) || isStateFileOnlyPatch(toolName, toolInput)) {
    return { stdout: '', exitCode: 0 };
  }

  if (mode === 'new-project' && isNewProjectOnboardingIncomplete(effectiveState)) {
    const repaired = repairNewProjectOnboardingState(cwd, effectiveState, 'generic pre-tool onboarding repair');
    if (repaired) {
      if (isMutatingPreToolUse(toolName, toolInput)) {
        return denyPreToolUse(repairedMaterializationDenyReason());
      }
      return repaired;
    }
    if (needsTeamConfirmation(effectiveState)) {
      const reason = teamConfirmationGateFallbackReason(effectiveState);
      return denyPreToolUse(reason, teamConfirmationPromptRequest(effectiveState, reason));
    }
    const reason = onboardingGateFallbackReason(effectiveState);
    return denyPreToolUse(reason, nextOnboardingPromptRequest(effectiveState, 'gate'));
  }

  const materialized = materializeProjectIfNeeded(cwd, 'generic pre-tool convergence');
  if (materialized && materialized.stdout) {
    if (isMutatingPreToolUse(toolName, toolInput)) {
      return denyPreToolUse(repairedMaterializationDenyReason());
    }
    return materialized;
  }

  return { stdout: '', exitCode: 0 };
}

// ── PreToolUse(Task): enforce per-agent model for the performance level ──────
// The subagent model is set ONLY by the spawn tool's `model` parameter; the
// model directive in prompt text has no effect, so without this gate Balanced/
// High silently inherit the parent model. We block a Traffic One role spawn
// when the `model` param is missing/wrong for the role's tier.
function detectHookHost() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude';
  if (process.env.CODEX_PLUGIN_ROOT) return 'codex';
  if (process.env.CURSOR_PLUGIN_ROOT) return 'cursor';
  const root = pluginRoot();
  if (root.includes(`${path.sep}.codex${path.sep}`)) return 'codex';
  if (root.includes(`${path.sep}.cursor${path.sep}`)) return 'cursor';
  return 'claude';
}

function normalizeSubagentRole(subagentType) {
  if (typeof subagentType !== 'string' || !subagentType) return null;
  const role = subagentType.includes(':') ? subagentType.split(':').pop() : subagentType;
  return VALID_AGENT_ROLES.has(role) ? role : null;
}

function inferTrafficOneSpawnRole(toolInput) {
  const direct = normalizeSubagentRole(
    toolInput.subagent_type
    || toolInput.subagentType
    || toolInput.agent
    || toolInput.role
    || toolInput.type,
  );
  if (direct) return direct;

  const message = [
    toolInput.message,
    toolInput.prompt,
    toolInput.instructions,
    toolInput.description,
  ].filter((value) => typeof value === 'string').join('\n');
  if (!/\bTraffic One\b/i.test(message)) return null;

  const matches = Array.from(VALID_AGENT_ROLES)
    .filter((role) => new RegExp(`\\b${role}\\b`, 'i').test(message));
  return matches.length === 1 ? matches[0] : null;
}

function runCheckAgentModel(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const authGate = authPreToolGate(toolName, toolInput);
  if (authGate) return authGate;

  if (toolName && !/^(Task|Agent|spawn_agent)$/i.test(String(toolName))) {
    return { stdout: '', exitCode: 0 };
  }

  const role = inferTrafficOneSpawnRole(toolInput);
  if (!role) {
    return { stdout: '', exitCode: 0 }; // not a Traffic One role spawn
  }

  const cwd = process.cwd();
  const state = safeReadJson(path.join(cwd, STATE_FILE), null);
  if (!state || typeof state !== 'object') return { stdout: '', exitCode: 0 };

  // Onboarding-only: enforce the performance-level model just for the first
  // new-project build. Once the project is established, manual agent spawns are
  // never gated.
  if (state.mode !== 'new-project') return { stdout: '', exitCode: 0 };

  if (!isCompletedTrafficOneMaterialization(cwd, state)) {
    materializeProjectIfNeeded(cwd, 'agent spawn preflight convergence');
    const refreshed = readState(cwd);
    if (isCompletedTrafficOneMaterialization(cwd, refreshed)) {
      return denyPreToolUse(agentMaterializationDenyReason());
    }
    return denyPreToolUse(agentMaterializationMissingReason());
  }

  const performance = state.performance && typeof state.performance === 'object' ? state.performance : null;
  const level = performance && PERFORMANCE_LEVEL_IDS.has(performance.level) ? performance.level : null;
  if (!level) return { stdout: '', exitCode: 0 }; // no level recorded → can't enforce

  // Low: the team runs in-thread, not as spawned subagents. Spawning a role
  // subagent contradicts the recorded level — usually the level was mis-recorded
  // (e.g. user picked Balanced but state says low). Block and ask to fix first.
  if (teamModeForLevel(level) === 'main-agent') {
    return denyPreToolUse(
      `Performance gate: \`.traffic-one.json\` records performance.level="${level}" (main-agent only), but you are spawning the \`${role}\` subagent. `
      + 'If the user chose Balanced or High, first correct `.traffic-one.json` (`performance.level` plus matching `team.mode="subagents"`) so the right model tier applies, then re-spawn passing the `model` parameter. '
      + 'If the user really chose Low, do NOT spawn subagents — run the roles in this thread as the role roadmap checklist.',
    );
  }

  // Team Confirmation gate: for balanced/high, the user MUST have
  // explicitly approved the team line-up by clicking Approve in popup 2,
  // which writes `team.approved: true`. This denial is the teeth that
  // prevents the orchestrator from skipping confirmation with "I'll auto-approve
  // the default".
  if (!isTeamApproved(state.team)) {
    return denyPreToolUse(
      `Team Confirmation gate: performance.level="${level}" requires the user to explicitly approve the subagent role/model line-up before ANY subagent can be spawned. `
      + '`.traffic-one.json` currently has `team.approved !== true`, so the user has not yet confirmed. '
      + 'Ask the host popup tool (Codex `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI) with header "Team", question "Here is the subagent team for ' + level + ' mode — approve or change?", body containing the role→tier→model line-up (use `tierModelTable` from `model-tiers.cjs`), and options "Approve" / "Re-pick performance" / "Customise". '
      + 'When the user replies "Approve", re-write `.traffic-one.json` with `team.approved: true` (and any `team.overrides` collected), then re-spawn. '
      + 'If subagents or popup confirmation are genuinely unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting `.traffic-one.json`; do not bypass this gate for `team.mode="subagents"`.',
    );
  }

  // Balanced / High: the spawn MUST pass the model param for the role's tier.
  const host = detectHookHost();
  const overrides = state.team && typeof state.team === 'object' && state.team.overrides && typeof state.team.overrides === 'object'
    ? state.team.overrides
    : null;
  const expected = modelForRoleHost(level, role, host, overrides);
  if (!expected) return { stdout: '', exitCode: 0 };

  const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
  if (passedModel !== expected) {
    return denyPreToolUse(
      `Performance gate (level=${level}, host=${host}): spawning \`${role}\` requires the \`model\` tool parameter set to "${expected}". `
      + (passedModel
        ? `You passed model="${passedModel}". `
        : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ')
      + `Re-issue the spawn with \`model: "${expected}"\`. The model is set ONLY by this parameter — a model name in the prompt text has no effect. `
      + 'Per-role model tiers live in `performance-config.cjs` / `model-tiers.cjs`.',
    );
  }

  ensureRunAgentClaim(cwd, state, role, data, {
    toolName,
    agentType: toolInput.agent_type || toolInput.agentType || toolInput.subagent_type || toolInput.type || null,
    model: passedModel,
  });

  return { stdout: '', exitCode: 0 };
}

// ── PreToolUse: architecture write/edit guard ────────────────────────────────
function readStack() {
  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  return typeof state.stack === 'string' ? state.stack : null;
}

function runCheckArchitectureWrite(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const toolName = data.tool_name || data.toolName || 'Bash';
  const authGate = authPreToolGate(toolName, toolInput);
  if (authGate) return authGate;

  const rawFilePath = (typeof toolInput.file_path === 'string' ? toolInput.file_path : '').replace(/\\/g, '/');
  const rawCommand = commandFromToolInput(toolInput);
  const patchTargetPaths = normalizedToolName(toolName) === 'apply_patch'
    ? applyPatchTargetPaths(rawCommand)
    : [];
  const cwd = process.cwd();
  const projectRoot = findProjectRootForHookFile(cwd, rawFilePath || patchTargetPaths[0] || '');
  const filePath = projectRelativeHookPath(cwd, projectRoot, rawFilePath);
  materializeProjectIfNeeded(projectRoot, 'architecture preflight convergence');
  const content =
    typeof toolInput.content === 'string'
      ? toolInput.content
      : typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : '';
  const stateForArchitecture = safeReadJson(path.join(projectRoot, STATE_FILE), {});
  const isNative = isNativeState(stateForArchitecture);
  const violations = [];

  // Plan gate: on a new project, deny feature-source writes until the architect
  // has produced .traffic-one/plan.md. The plan file itself, .traffic-one/
  // project memory, root docs, ADRs, and legacy docs/ are exempt so the
  // architect can write the plan without self-blocking.
  const FEATURE_SOURCE_RE = /^(apps\/[^/]+\/(src|app)\/|packages\/[^/]+\/src\/|src\/|services\/[^/]+\/src\/)/;
  const PLAN_FILE_RE      = /(^|\/)\.traffic-one\/plan\.md$/;
  const ADR_OR_DOC_RE     = /(^|\/)(docs|architecture|README|ADR)/i;

  const statePath         = path.join(projectRoot, STATE_FILE);
  const stateForPlan      = stateForArchitecture;
  const stateMissing      = !fs.existsSync(statePath);
  const validStateStack   = stateForPlan.stack && isKnownStack(stateForPlan.stack);
  const memoryPresent     = fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'))
    || fs.existsSync(path.join(projectRoot, '.traffic-one', 'stack.md'));
  const detectedModeForState = stateForPlan.mode || (stateMissing ? detectMode(projectRoot) : null);
  const isNewProject      = stateForPlan.mode === 'new-project';
  const planAbsPath       = path.join(projectRoot, '.traffic-one', 'plan.md');
  const planMissing       = !fs.existsSync(planAbsPath);
  const writingPlan       = PLAN_FILE_RE.test(filePath);
  const writingDoc        = ADR_OR_DOC_RE.test(filePath);
  const featureTargetPaths = [];
  if (FEATURE_SOURCE_RE.test(filePath)) {
    featureTargetPaths.push(filePath);
  }
  for (const targetPath of patchTargetPaths) {
    const relativePath = projectRelativeHookPath(cwd, projectRoot, targetPath);
    if (FEATURE_SOURCE_RE.test(relativePath) && !featureTargetPaths.includes(relativePath)) {
      featureTargetPaths.push(relativePath);
    }
  }
  const writingFeatureSourceViaCommand = isShellToolName(toolName) && commandAppearsToWriteFeatureSource(rawCommand);
  const writingFeatureSource = featureTargetPaths.length > 0 || writingFeatureSourceViaCommand;
  const requiresMonorepoScaffold = stateRequiresNewProjectMonorepo(stateForPlan);

  if (
    requiresMonorepoScaffold
    && filePath === 'package.json'
    && !packageJsonDeclaresWorkspace(content)
  ) {
    violations.push(
      'New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: '
      + '`private: true`, `packageManager: pnpm@...`, and workspaces for `apps/*` and `packages/*`. '
      + 'Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.'
    );
  }

  if (
    requiresMonorepoScaffold
    && /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/.test(filePath)
  ) {
    violations.push(
      'New-project monorepo gate: root Vite app files are not allowed for this stack. '
      + 'Use `apps/web/` for the React app and create the required `packages/*` workspaces first; '
      + 'see `rules/modes/new-project.md`.'
    );
  }

  if (
    writingFeatureSource
    && !validStateStack
    && (detectedModeForState === 'new-project' || memoryPresent)
  ) {
    violations.push(
      'State gate: root .traffic-one.json is missing or incomplete. Write the '
      + 'Traffic One state file with mode, stack, backend, realtime, confirmed, '
      + 'onboardingComplete, and confirmedAt before writing feature source. '
      + 'The .traffic-one/ folder is project memory, not the stack-selection '
      + 'state file.'
    );
  }

  // Materialization gate: block feature writes until the SessionStart hook has
  // copied the correct rules and skills to .traffic-one/ for this stack.
  // This ensures the model has full quality/performance context before implementing.
  const hasMaterializedAssets = hasMaterializedProjectAssets(projectRoot, stateForPlan);
  const featureContextMaterialized = isPluginAuthoringRoot(projectRoot)
    || !stateForPlan.onboardingComplete
    || (isMaterialized(stateForPlan) && hasMaterializedAssets);

  if (writingFeatureSource && !featureContextMaterialized) {
    violations.push(
      `Materialization gate: stack context for ${stackFingerprint(stateForPlan)} has not been materialized on disk yet. `
      + 'Run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project` '
      + 'from the project root and verify `.traffic-one/rules/**`, `.traffic-one/skills/**`, '
      + '`.traffic-one/manifest.json`, root `AGENTS.md`, and root `CLAUDE.md` exist before writing feature source.'
    );
  }

  const agentContext = resolveRunAgentContext(projectRoot, stateForPlan, data, { claimPending: true })
    || (!hasRunAgentState(projectRoot, stateForPlan) ? legacyRunAgentContext(stateForPlan) : null);
  const ownershipTargets = featureTargetPaths.length > 0 ? featureTargetPaths : [filePath];
  const useLegacySubagentFallback = !agentContext && !hasRunAgentState(projectRoot, stateForPlan);
  const agentMayWriteFeatureTargets = featureTargetPaths.length > 0
    ? featureTargetPaths.every((targetPath) => (
      agentContext
        ? subagentMayWriteFeatureSource(stateForPlan, targetPath, agentContext)
        : useLegacySubagentFallback && subagentMayWriteFeatureSource(stateForPlan, targetPath, null)
    ))
    : agentContext
      ? subagentMayWriteFeatureSource(stateForPlan, filePath, agentContext)
      : useLegacySubagentFallback && subagentMayWriteFeatureSource(stateForPlan, filePath, null);

  if (
    writingFeatureSource
    && stateForPlan.team
    && stateForPlan.team.mode === 'subagents'
    && (
      !agentMayWriteFeatureTargets
      || writingFeatureSourceViaCommand
    )
  ) {
    const role = (agentContext && agentContext.role) || activeAgentRole(stateForPlan) || 'main agent';
    const inSubagent = Boolean(agentContext) || (!hasRunAgentState(projectRoot, stateForPlan) && isSubagentSession(stateForPlan));
    const ownedBySome = ownershipTargets.every((targetPath) => (
      roleCanWriteFeatureSource('senior-frontend', targetPath)
      || roleCanWriteFeatureSource('senior-backend', targetPath)
    ));
    const ownedByActiveRole = agentContext && ownershipTargets.every((targetPath) => (
      roleCanWriteFeatureSource(agentContext.role, targetPath)
    ));
    let reason;
    if (writingFeatureSourceViaCommand) {
      reason = 'Run-team enforcement gate: feature-source writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python`, `node`, `perl`, `sed -i`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead.';
    } else if (!inSubagent) {
      reason = `Run-team enforcement gate: this project was onboarded with \`team.mode="subagents"\`, so feature-source writes must come from a spawned Traffic One role session with a per-agent run claim, not ${role}. Spawn the appropriate role first; senior-frontend and senior-backend ownership is enforced by \`roleCanWriteFeatureSource\`.`;
    } else if (!ownedBySome) {
      reason = `Run-team enforcement gate: the file \`${filePath}\` is not under any Traffic One role's owned path patterns (senior-frontend: \`apps/*/src|app/\` + \`packages/(ui|i18n|utils)/src/\`; senior-backend: \`packages/(api-client|ws-client|utils)/src/\`, \`services/*/src/\`, \`apps/*/src/(services|store)/\`). If this is a legitimate project layout (e.g. root \`src/\`), the role-pattern definitions in \`roleCanWriteFeatureSource\` need to be extended.`;
    } else if (agentContext && !ownedByActiveRole) {
      reason = `Run-team enforcement gate: the active Traffic One role \`${role}\` does not own \`${ownershipTargets.join(', ')}\`. Use the role that owns the path, or split the patch by role ownership.`;
    } else {
      // Should not reach: subagentMayWriteFeatureSource would have returned true.
      reason = `Run-team enforcement gate: unexpected denial for ${role} writing \`${filePath}\`. This is a gate bug — please report.`;
    }
    reason += ' If subagents are genuinely unavailable or the user changes their mind, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting `.traffic-one.json`; `team.source="unavailable"` does not bypass `team.mode="subagents"`.';
    violations.push(reason);
  }

  if (
    isNewProject
    && planMissing
    && writingFeatureSource
    && !writingPlan
    && !writingDoc
  ) {
    violations.push(
      'Plan gate: .traffic-one/plan.md is missing on a new project. Run the '
      + '`senior-architect` subagent (or the `senior-eng-orchestrator` skill) '
      + 'to produce the plan before writing feature source files. Allowed '
      + 'without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'
    );
  }

  if (/(apps\/[^/]+\/)?src\/pages\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
    violations.push('Service/store/hook/slice files belong in src/services/, src/features/<name>/, or packages/* — not in src/pages/.');
  }

  if (/(apps\/[^/]+\/)?app\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
    violations.push('Expo Router route files must stay thin. Service/store/hook/slice files belong in src/features/, src/services/, or packages/*.');
  }

  if (/(apps\/[^/]+\/)?src\/[A-Z][a-zA-Z]+\.(tsx|ts)$/.test(filePath)) {
    const target = isNative
      ? 'src/components/, src/features/<name>/components/, or packages/ui-native/*'
      : 'src/components/, src/features/<name>/components/, or packages/ui/*';
    violations.push(`Components must live in ${target} — not directly in src/.`);
  }

  const featureMatch = filePath.match(/src\/features\/([^/]+)/);
  if (featureMatch) {
    const current = featureMatch[1];
    const cross = Array.from(content.matchAll(/from ['"]@\/features\/([^/'"]+)/g))
      .map((match) => match[1])
      .filter((feature) => feature !== current);
    if (cross.length > 0) {
      violations.push(`Cross-feature import detected (${current} -> ${cross}). Share via packages/ui, packages/ui-native, packages/utils, or a feature-agnostic store slice.`);
    }
  }

  if (/from ['"]\.\.\/\.\.\/\.\.\/packages\//.test(content)) {
    violations.push('Use the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) instead of a deep relative path across packages.');
  }

  if (
    filePath.endsWith('.tsx') &&
    /(src|packages\/(ui|ui-native))\/(components|features|pages)\//.test(filePath) &&
    /^export default /m.test(content)
  ) {
    violations.push('Use named exports only for reusable components. Expo Router route files under app/ are the default-export exception.');
  }

  if (isNative) {
    if (filePath.endsWith('.tsx') && content.includes('style={{')) {
      violations.push('No inline object styles — use NativeWind `className` for static styles. `StyleSheet.create` is reserved for dynamic/animated values.');
    }
    if (filePath.endsWith('.tsx') && /\b(div|span|button|a|input)\b/.test(content)) {
      violations.push('React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.');
    }
  } else {
    if (filePath.endsWith('.tsx') && content.includes('style={{')) {
      violations.push('No inline styles — use Tailwind utility `className` and shadcn primitives. Inline `style={{}}` is reserved for dynamic/derived values.');
    }
    if (
      (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) &&
      /from ['"]@vanilla-extract\//.test(content)
    ) {
      violations.push('vanilla-extract is no longer in the active stack. Use Tailwind utility classes and shadcn primitives in `packages/ui/src/components/ui/`.');
    }
    if (
      (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) &&
      /from ['"][^'"]+\.css\.ts['"]/.test(content)
    ) {
      violations.push('`.css.ts` (vanilla-extract) imports are no longer permitted. Use Tailwind utility classes; theme via the HSL CSS variables in `globals.css`.');
    }
  }

  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && /:\s*any\b/.test(content)) {
    violations.push('Avoid `any` — use `unknown` and narrow types, or define a discriminated union.');
  }

  const allowedWsPaths = /(packages\/ws-client|src\/services\/ws)/;
  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && content.includes('new WebSocket(') && !allowedWsPaths.test(filePath)) {
    violations.push('Open WebSocket connections only inside packages/ws-client/ or src/services/ws/. Components must subscribe via hooks.');
  }

  if (violations.length === 0) {
    return { stdout: '', exitCode: 0 };
  }

  const reason = `traffic-one — architecture violation(s):\n${violations.map((violation) => `  - ${violation}`).join('\n')}`;
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

// ── PreToolUse: library allowlist (Bash install commands) ────────────────────
const INSTALL_RE = /(npm (install|i|add)|yarn add|pnpm add|bun add)/;

function packageJsonHasNext() {
  const pkg  = loadPackageJson(process.cwd());
  const deps = dependenciesFromPackage(pkg);
  return Boolean(deps.next);
}

function allowsNextjs(state) {
  return state.frontend === 'nextjs' || packageJsonHasNext();
}

function stateFromStackForAllowlist(stackOrState) {
  if (stackOrState && typeof stackOrState === 'object') return stackOrState;
  const stack = typeof stackOrState === 'string' ? stackOrState : null;
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return { stack, frontend: 'none', backend: 'supabase', mobile: { enabled: true, framework: 'react-native-expo' } };
  }
  if (stack === 'react-realtime-monorepo' || stack === 'react-frontend-only' || stack === 'default' || stack === 'custom-backend') {
    return { stack, frontend: 'react-vite', backend: stack === 'react-frontend-only' ? 'none' : 'supabase', mobile: { enabled: false, framework: 'none' } };
  }
  return { stack, frontend: 'none', backend: 'none', mobile: { enabled: false, framework: 'none' } };
}

function forbiddenForStack(stackOrState, allowNextjs) {
  const state = stateFromStackForAllowlist(stackOrState);
  const common = [
    ['mobx', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['recoil', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['jotai', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['swr', 'Use RTK Query for cached server state.'],
    ['(?<!tanstack/)(?<!\\w)react-query(?!-)', 'Use RTK Query for cached server state.'],
  ];
  const web = [
    ['vitest', 'This stack uses Jest for unit/integration tests.'],
    ['@vitest/', 'This stack uses Jest for unit/integration tests.'],
    ['styled-components', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@emotion', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@vanilla-extract/', 'vanilla-extract is no longer in the active stack. Use Tailwind + shadcn (run `npx shadcn@latest add <name>`).'],
    ['nativewind', 'NativeWind is the React Native styling layer; the web stack uses plain Tailwind.'],
    ['@mui/', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['antd', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['material-ui', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['chakra-ui', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['bootstrap', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
  ];

  if (!allowNextjs) {
    web.push([
      '(^|\\s)(next|next-auth)(@[\\w.-]+)?(\\s|$)',
      'Use the React/Vite stack unless the user explicitly chose Next.js; Next.js auth uses NextAuth/Auth.js only in a Next.js project.',
    ]);
  }

  const native = [
    ['vitest', 'This stack uses Jest for unit/integration tests.'],
    ['@vitest/', 'This stack uses Jest for unit/integration tests.'],
    ['styled-components', 'Use NativeWind `className` with React Native Reusables primitives in packages/ui-native.'],
    ['@emotion', 'Use NativeWind `className` with React Native Reusables primitives in packages/ui-native.'],
    ['@vanilla-extract/', 'vanilla-extract is web-only and no longer used. The Expo stack uses NativeWind + React Native Reusables.'],
    ['react-router-dom', 'Use Expo Router for React Native navigation.'],
    ['framer-motion', 'Use react-native-reanimated for React Native animations.'],
    ['@mui/', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['antd', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['material-ui', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['chakra-ui', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['bootstrap', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
  ];

  if (isNativeState(state)) {
    return [...common, ...native];
  }
  if (isWebState(state) || state.stack === null) {
    const webRules = state.frontend === 'nextjs'
      ? web.filter(([pattern]) => pattern !== 'vitest' && pattern !== '@vitest/')
      : web;
    return [...common, ...webRules];
  }
  return common;
}

// Deploy gate: production-publishing commands need a fresh shipper-approval
// stamp in .traffic-one.json (written by the senior-shipper subagent during
// pre-flight). Without the stamp, deny — forces the orchestrator → shipper
// flow rather than ad-hoc deploys.
const DEPLOY_RE = /(^|[\s;&|])(vercel\s+(deploy|--prod)|eas\s+build\s+.*--auto-submit|eas\s+submit|supabase\s+db\s+push\s+--linked|supabase\s+functions\s+deploy\s+\S+\s+--linked|gh\s+release\s+create|fly\s+deploy|wrangler\s+deploy|npm\s+publish|pnpm\s+publish)\b/;
const SHIPPER_APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_CHECK_WINDOW_MS = 10 * 60 * 1000;

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

function checkSecurityDeployStamp(stateForDeploy, cwd) {
  const status = stateForDeploy.lastSecurityCheckStatus;
  const checkedAt = typeof stateForDeploy.lastSecurityCheckAt === 'string'
    ? Date.parse(stateForDeploy.lastSecurityCheckAt)
    : 0;
  const fresh = checkedAt > 0 && (Date.now() - checkedAt) < SECURITY_CHECK_WINDOW_MS;
  if (status !== 'passed' || !fresh) {
    return {
      ok: false,
      reason: 'Deploy gate: the Traffic One pre-deployment security check has not passed in the last 10 minutes. Run '
        + '`node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/security-check-runner.cjs" --strict --stamp` '
        + 'from the project root, address any findings, then deploy through `senior-shipper`.',
    };
  }

  let current;
  try {
    current = computeProjectFingerprint(cwd).fingerprint;
  } catch (error) {
    return {
      ok: false,
      reason: `Deploy gate: could not compute the current security fingerprint: ${error.message}`,
    };
  }

  if (stateForDeploy.lastSecurityCheckFingerprint !== current) {
    return {
      ok: false,
      reason: 'Deploy gate: the worktree changed after the last passing security check. Rerun '
        + '`node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/security-check-runner.cjs" --strict --stamp` '
        + 'so the security fingerprint matches the code being deployed.',
    };
  }

  return { ok: true };
}

function runCheckLibraryAllowlist(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const authGate = authPreToolGate(data.tool_name || data.toolName || 'Bash', toolInput);
  if (authGate) return authGate;

  const command  = commandFromToolInput(toolInput);

  // Deploy gate runs first — production publishes are gated regardless of
  // whether the command also matches an install regex.
  if (DEPLOY_RE.test(command)) {
    const stateForDeploy = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
    const approvedAt = typeof stateForDeploy.lastShipperApprovalAt === 'string'
      ? Date.parse(stateForDeploy.lastShipperApprovalAt)
      : 0;
    const fresh = approvedAt > 0 && (Date.now() - approvedAt) < SHIPPER_APPROVAL_WINDOW_MS;
    if (!fresh) {
      const reason = 'Deploy gate: this command publishes to production. Run '
        + 'the `senior-shipper` subagent first; it stamps `lastShipperApprovalAt` '
        + 'in .traffic-one.json after pre-flight (reviewer APPROVED, tests green, '
        + 'user confirmed). The stamp grants a 10-minute deploy window.';
      return denyPreToolUse(reason);
    }

    const securityCheck = checkSecurityDeployStamp(stateForDeploy, process.cwd());
    if (!securityCheck.ok) {
      return denyPreToolUse(securityCheck.reason);
    }
  }

  if (!INSTALL_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  const stack = typeof state.stack === 'string' ? state.stack : null;
  const hits = forbiddenForStack(state.stack ? state : stack, allowsNextjs(state)).filter(([pattern]) => new RegExp(pattern).test(command));

  if (hits.length === 0) {
    return { stdout: '', exitCode: 0 };
  }

  const lines  = hits.map(([pattern, tip]) => `  - ${pattern}: ${tip}`).join('\n');
  const reason = `Forbidden library:\n${lines}\n\nSee rules/core.md and the active stack core for the approved stack.`;
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

// ── PostToolUse: page-speed gate reminder after production builds ───────────
// Match build commands, including monorepo flag forms:
//   pnpm build · pnpm run build · pnpm -w build · pnpm -F web build
//   pnpm --filter web build · pnpm --filter=web build · pnpm --recursive build
//   turbo build · turbo run build · turbo run build --filter web
//   vite build · vite build --mode production
//   npm/yarn/bun analogues
// The optional `(\s[^;&|]*?)?` group is lazy so a command like
// `pnpm install build-tools` (which lacks a trailing whitespace before `build`)
// stays unmatched. Command separators (;&|) break the run.
const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;

function runPostBuildPageSpeed(rawInput) {
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const data = parseJsonText(rawInput, {});

  // Opt-in per-tool token log (TRAFFIC_ONE_TOKEN_LOG=1). No-op when disabled.
  tokenLogger.logToolUse(process.cwd(), data);

  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command = commandFromToolInput(toolInput);
  if (!BUILD_COMMAND_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  const isWebStack = isWebState(state);
  if (!isWebStack) {
    return { stdout: '', exitCode: 0 };
  }

  return {
    stdout: JSON.stringify({
      systemMessage: 'traffic-one page-speed gate pending after build',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [
          '[traffic-one] A production build just ran for a web stack.',
          'Before final delivery for generated/changed React or Ionic routes, run the Lighthouse mobile gate:',
          '',
          '  node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/lighthouse-runner.mjs" --route /',
          '',
          'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. If the environment blocks Lighthouse, explicitly report page speed as unverified with concrete risks.',
        ].join('\n'),
      },
    }),
    exitCode: 0,
  };
}

// ── PreToolUse(Glob|Grep): hint that the codebase graph exists ──────────────
// Non-blocking. Tells the agent to read the active provider's codebase graph
// first for codebase-structure questions before falling back to grep/glob.
//
// Provider-aware: `state.codeGraphProvider` (gitnexus | graphify) picks the
// artefact path. If the provider's artefact doesn't exist yet, return silent.
//
// THROTTLING: this hook fires on every Glob/Grep tool use. A subagent doing
// 40 searches would accumulate 40 × ~150 bytes = 6KB of identical reminders.
// Use a module-level marker so the hint emits at most once per hook process.
// Each subagent spawns a fresh process, so each subagent gets one hint.
let graphifyHintSentForCwd = null;

function runPreGraphifyHint(_rawInput) {
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const cwd = process.cwd();
  if (graphifyHintSentForCwd === cwd) {
    return { stdout: '', exitCode: 0 };
  }

  const state = safeReadJson(path.join(cwd, STATE_FILE), {});
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;

  // Dispatch by provider. Both branches are silent when the on-disk artefact
  // doesn't exist yet — the post-build hook will produce it after first build.
  let label;
  let artefactPath;
  let exists = false;
  if (provider === 'gitnexus') {
    artefactPath = path.join(cwd, '.gitnexus');
    exists = fs.existsSync(artefactPath);
    label = '[graph: gitnexus] `.gitnexus/` knowledge graph present';
  } else {
    // Default + 'graphify' branch share the same artefact path.
    artefactPath = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
    exists = fs.existsSync(artefactPath);
    label = '[graph: graphify] `graphify-out/GRAPH_REPORT.md` present';
  }
  if (!exists) {
    return { stdout: '', exitCode: 0 };
  }

  graphifyHintSentForCwd = cwd;
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
  const digestHint = runId
    ? ` Predecessor digests (if any) live under \`.traffic-one/digests/${runId}/\`.`
    : '';
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `${label} — read it FIRST for module / file / `
          + 'call-site questions before grep/glob.' + digestHint,
      },
    }),
    exitCode: 0,
  };
}

// ── PostToolUse(Bash): post-build foreground graphify bootstrap ─────────────
// Fires on the first successful build of a new-project (post-onboarding) when
// no fresh graph exists yet. Synchronously installs graphify (pipx | pip
// --user) if missing, then runs `graphify .` so `graphify-out/GRAPH_REPORT.md`
// actually lands. The 1-day cooldown stamp prevents re-entry on subsequent
// builds; opt out by setting `graphifyAutoRun: false` in `.traffic-one.json`.
const GRAPHIFY_FRESH_MS  = 7 * 24 * 60 * 60 * 1000;
const GRAPHIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function runPostBuildGraphifyHint(rawInput) {
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command = commandFromToolInput(toolInput);
  if (!BUILD_COMMAND_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const cwd = process.cwd();
  const state = safeReadJson(path.join(cwd, STATE_FILE), {});
  if (state.mode !== 'new-project' || state.onboardingComplete !== true) {
    return { stdout: '', exitCode: 0 };
  }

  // Dispatch by codeGraphProvider. Without a provider, the
  // postWriteIncompleteWarning surface already nags; this hook stays silent
  // rather than picking a default.
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  if (provider !== 'gitnexus' && provider !== 'graphify') {
    return { stdout: '', exitCode: 0 };
  }

  // Provider-specific artefact path for freshness check.
  const artefactPath = provider === 'gitnexus'
    ? path.join(cwd, '.gitnexus')
    : path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
  const artefactExists = fs.existsSync(artefactPath);
  const artefactFresh = artefactExists
    ? (Date.now() - fs.statSync(artefactPath).mtimeMs) < GRAPHIFY_FRESH_MS
    : false;
  if (artefactFresh) {
    return { stdout: '', exitCode: 0 };
  }

  const lastHinted = typeof state.graphifyLastHintedAt === 'string'
    ? Date.parse(state.graphifyLastHintedAt)
    : 0;
  if (lastHinted > 0 && (Date.now() - lastHinted) < GRAPHIFY_COOLDOWN_MS) {
    return { stdout: '', exitCode: 0 };
  }

  // Stamp the cooldown immediately so a flurry of builds doesn't re-enter
  // the bootstrap (which can take ~30–60s). The runner itself stamps
  // `<provider>LastRunAt` / `<provider>LastErrorAt` separately.
  try {
    state.graphifyLastHintedAt = nowIso();
    writeState(cwd, state);
  } catch {
    // best-effort; the bootstrap still runs even if the stamp can't persist
  }

  // Run the foreground bootstrap. Never throws; returns a structured result.
  const runnerFile = provider === 'gitnexus' ? 'gitnexus-runner.cjs' : 'graphify-runner.cjs';
  let bootstrapResult;
  try {
    const { bootstrap } = require(path.resolve(__dirname, '..', runnerFile));
    bootstrapResult = bootstrap(cwd);
  } catch (err) {
    bootstrapResult = {
      ok: false,
      action: 'install-skipped',
      report: null,
      error: `${provider} runner crashed: ${(err && err.message) || String(err)}`,
      durationMs: 0,
    };
  }

  // Build the context message based on the result + provider. Always non-blocking.
  const seconds = Math.round((bootstrapResult.durationMs || 0) / 100) / 10;
  let additionalContext;
  if (bootstrapResult.ok) {
    if (provider === 'gitnexus') {
      const restored = Array.isArray(bootstrapResult.restored) && bootstrapResult.restored.length > 0
        ? ` Restored traffic-one's ${bootstrapResult.restored.join(', ')} (GitNexus auto-write conflicted).`
        : '';
      additionalContext = `[gitnexus] Codebase graph built (${seconds}s, ${bootstrapResult.action}). `
        + `Index at \`.gitnexus/\`. License reminder: PolyForm Noncommercial — only legal on non-commercial projects.${restored} `
        + 'Subagents and skills will consult `.gitnexus/` before grep/glob for module/structure questions. '
        + 'Add `.gitnexus/` and `.traffic-one/backups/` to .gitignore if not already.';
    } else {
      const actionLabel = bootstrapResult.action === 'used-existing'
        ? 'used existing `graphify` install'
        : (bootstrapResult.action === 'installed-pipx'
          ? 'installed `graphifyy` via pipx'
          : 'installed `graphifyy` via `pip --user`');
      additionalContext = `[graphify] Codebase graph built (${seconds}s, ${actionLabel}). `
        + `Report at \`graphify-out/GRAPH_REPORT.md\`. Subagents and skills will consult it `
        + `before grep/glob for module/structure questions. To auto-rebuild on each git commit: `
        + '`graphify hook install`. Add `graphify-out/` to .gitignore if not already.';
    }
  } else {
    if (provider === 'gitnexus') {
      // Most actionable branch first: nvm is installed but no v22 yet.
      // Hand the agent a single bash command + tell it to run via Bash
      // tool (user's permission prompt becomes the consent gate).
      if (bootstrapResult.action === 'nvm-install-needed') {
        additionalContext = '[gitnexus] Auto-bootstrap blocked — Node 22 not installed yet.\n'
          + `${bootstrapResult.error}\n`
          + 'AGENT: present the bash command above to the user, then run it via '
          + 'your Bash tool. The Bash permission prompt is the consent gate — '
          + 'do NOT install Node without it. After it succeeds, the runner will '
          + 'pick up the new Node 22 binary automatically (no Claude Code '
          + 'relaunch needed; the runner globs `~/.nvm/versions/node/v22.*` '
          + 'directly).';
      } else if (bootstrapResult.action === 'node-version-mismatch') {
        // Beginner-friendly Node-version-mismatch branch: emit the upgrade
        // command verbatim instead of the generic "install + build" hint
        // (the generic hint asks the user to run `npm install -g gitnexus`
        // which would just fail again with the same EBADENGINE error).
        additionalContext = '[gitnexus] Auto-bootstrap blocked — Node version too old + nvm not present.\n'
          + `${bootstrapResult.error}\n`
          + 'Install nvm first (https://github.com/nvm-sh/nvm), then re-invoke '
          + 'the runner. Or pick `codeGraphProvider: "graphify"` (Python; works '
          + 'on any Node) by editing `.traffic-one.json`.';
      } else {
        additionalContext = `[gitnexus] Auto-bootstrap failed (${seconds}s): ${bootstrapResult.error || 'unknown error'}. `
          + 'Falling back to a manual hint — install + build once when convenient:\n'
          + '  npm install -g gitnexus   # or: npx gitnexus@latest analyze .\n'
          + '  gitnexus analyze\n'
          + 'License: PolyForm Noncommercial. Disable auto-bootstrap with `"codeGraphAutoRun": false` in `.traffic-one.json`.';
      }
    } else {
      additionalContext = `[graphify] Auto-bootstrap failed (${seconds}s): ${bootstrapResult.error || 'unknown error'}. `
        + 'Falling back to a manual hint — install + build once when convenient:\n'
        + '  pipx install graphifyy   # or: python3 -m pip install --user graphifyy\n'
        + '  graphify update .\n'
        + '  graphify hook install    # optional: regenerate on every git commit\n'
        + 'To disable auto-bootstrap entirely, set `"codeGraphAutoRun": false` in `.traffic-one.json`.';
    }
  }

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    }),
    exitCode: 0,
  };
}

// ── PostToolUse: stack-rules auto-load on `.traffic-one.json` write ──────────
function runPostStackSetup(rawInput) {
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const payload = parseJsonText(rawInput, null);
  if (!payload) return { stdout: '', exitCode: 0 };

  // Opt-in per-tool token log (TRAFFIC_ONE_TOKEN_LOG=1). No-op when disabled.
  tokenLogger.logToolUse(process.cwd(), payload);

  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

  // PostToolUse may be configured broadly by different host runtimes. Dispatch:
  //   1. supabase/functions/<name>/index.ts            → runPostFunctionEdit (auto-deploy)
  //   2. .traffic-one/digests/<run-id>/<role>.md       → digest-size warning
  //   3. .traffic-one.json                             → existing stack-rules auto-load
  //   4. project-memory writes                         → local materialization
  //   5. anything else                                 → converge from complete state if needed
  if (filePath.replace(/\\/g, '/').match(FUNCTION_PATH_RE)) {
    const result = runPostFunctionEdit(filePath);
    if (result) {
      return { stdout: JSON.stringify(result), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }

  // Soft digest-size warning. Implementer subagents (frontend / backend) tend
  // to bloat their handoff digests with verbose Touched annotations and
  // exhaustive Public-contract surfaces, defeating the token-savings layer.
  // Cap target is 2 KB; we warn over 3 KB. Never blocks the write.
  const digestMatch = filePath.replace(/\\/g, '/').match(DIGEST_PATH_RE);
  if (digestMatch && fs.existsSync(filePath)) {
    let bytes = 0;
    try { bytes = fs.statSync(filePath).size; } catch { bytes = 0; }
    if (bytes > DIGEST_HARD_BYTES) {
      const role = digestMatch[1];
      const kb = Math.round((bytes / 1024) * 10) / 10;
      const reason = `[digest-size] Your \`${role}.md\` digest is ${kb} KB; the spec target is ≤2 KB (`
        + 'see `rules/common/agent-handoff-digests.md`). Re-write before completing your turn:\n'
        + '  1. Use repo-relative paths, never absolute (drop `/Users/.../` prefixes).\n'
        + '  2. Touched: file paths only, no parenthetical annotations.\n'
        + '  3. Public contracts: delta-only — what changed vs the plan, not the full surface.\n'
        + '  4. Open questions: at most 3 bullets; link to plan §, do not inline rationale.\n'
        + 'Reviewer / tester / shipper read this digest INSTEAD of the diff; bloated digests defeat the token-economy layer.';
      return {
        stdout: JSON.stringify({
          systemMessage: `traffic-one — digest ${role}.md is ${kb} KB; trim to ≤2 KB`,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: reason,
          },
        }),
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  }

  if (!filePath.endsWith(STATE_FILE)) {
    const memoryResult = materializeFromProjectMemoryWrite(process.cwd(), filePath);
    if (memoryResult) return memoryResult;
    const hintedResult = materializeFromToolInputHints(process.cwd(), toolInput);
    if (hintedResult) return hintedResult;
    const materializedResult = materializeProjectIfNeeded(process.cwd(), 'generic post-tool convergence');
    if (materializedResult) return materializedResult;
    const currentState = readState(process.cwd());
    startOneMcpReportBestEffort(process.cwd(), currentState, 'generic post-tool convergence');
    return { stdout: '', exitCode: 0 };
  }
  if (!fs.existsSync(filePath))      return { stdout: '', exitCode: 0 };

  const state = safeReadJson(filePath, null);
  // Accept any state that has a valid `stack` AND `codeGraphProvider`. The
  // model sometimes writes a partial file (no `onboardingComplete`, no
  // `codeGraphProvider`). Normalize and treat it as complete only when both
  // required fields are present + valid.
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];
  const stateDirEarly = path.dirname(path.resolve(filePath));
  const normalizedBeforeValidation = state && typeof state === 'object'
    ? normalizeState(state, detectMode(stateDirEarly))
    : false;
  const stackOk = state && state.stack && STACK_IDS.has(state.stack);
  const cgProvider = state && typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const cgOk = cgProvider && validCodeGraphProviders.includes(cgProvider);
  const toolchainOk = state && state.toolchain && typeof state.toolchain === 'object';
  const validationIssues = state ? trafficOneStateValidationIssues(state, validCodeGraphProviders) : [];

  if (!state || validationIssues.length > 0) {
    // Don't fail silently: emit a system message + reminder so the model can
    // self-correct in the same turn. The warning covers both missing/invalid
    // stack AND missing/invalid codeGraphProvider.
    if (!state) {
      return { stdout: '', exitCode: 0 };
    }
    const invalidStack = state.stack && !isKnownStack(state.stack)
      ? state.stack
      : null;
    const additionalContext = postWriteIncompleteWarning({
      stack: state.stack || null,
      validStackIds,
      codeGraphProvider: cgProvider,
      validCodeGraphProviders,
      validationIssues,
    });
    let systemMessage;
    if (invalidStack) {
      systemMessage = `traffic-one — \`.traffic-one.json\` has unknown stack id "${invalidStack}"; please re-write with a valid stack`;
    } else if (!state.stack) {
      systemMessage = 'traffic-one — `.traffic-one.json` write incomplete (no `stack` field); please re-write with all 8 fields';
    } else if (cgProvider && !cgOk) {
      systemMessage = `traffic-one — \`.traffic-one.json\` has unknown codeGraphProvider "${cgProvider}"; valid: gitnexus, graphify`;
    } else if (!toolchainOk) {
      systemMessage = 'traffic-one — `.traffic-one.json` missing required `toolchain` field; re-write with initialized toolchain';
    } else if (!cgProvider) {
      systemMessage = 'traffic-one — `.traffic-one.json` missing required `codeGraphProvider` field; ask the user (gitnexus or graphify) and re-write';
    } else {
      systemMessage = 'traffic-one — `.traffic-one.json` has invalid required fields; see validation issues and re-write';
    }
    return {
      stdout: JSON.stringify({
        systemMessage,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext,
        },
      }),
      exitCode: 0,
    };
  }

  if (normalizedBeforeValidation || normalizeState(state, detectMode(stateDirEarly))) {
    // Write back the completed state so subsequent hooks see a clean file.
    try {
      writeState(stateDirEarly, state);
    } catch {
      // best-effort; even if write fails, still emit the rule bundle below
    }
  }

  let materialized = null;
  try {
    materialized = materializeProjectAssets(stateDirEarly, state);
  } catch (error) {
    return materializationFailureResult(error);
  }

  // Stamp the materialization fields after a successful copy so the PreToolUse
  // implementation gate (isMaterialized) sees a fresh fingerprint.
  try {
    if (materialized && materialized.skipped) {
      startOneMcpReportBestEffort(stateDirEarly, state, 'post-stack-setup skipped materialization');
      return { stdout: '', exitCode: 0 };
    }
    state.materializedStack   = stackFingerprint(state);
    state.materializedAt      = nowIso();
    state.materializedVersion = getPluginVersion();
    writeState(stateDirEarly, state);
  } catch {
    // best-effort; stamp failure should not block the user
  }

  startOneMcpReportBestEffort(stateDirEarly, state, 'post-stack-setup');

  const stack = state.stack || '(unknown)';
  const stateDir = path.dirname(path.resolve(filePath));

  // Seamless gitnexus setup. Two things happen when the user just wrote
  // `codeGraphProvider: "gitnexus"`:
  //
  //   (a) Write `.nvmrc` with `22` at the project root for new-project mode
  //       (don't clobber if it already exists). This locks the project to
  //       Node 22 so `cd`-into-project triggers `nvm use` to the right
  //       version going forward.
  //
  //   (b) Surface the upgrade banner ONLY when there's no path forward:
  //       no `~/.nvm/versions/node/v22.*` install at all AND current hook
  //       process is on Node <22. When an nvm-v22 install exists (even if
  //       it's not the active Node), the runner will use the absolute v22
  //       binary path — no upgrade or relaunch needed.
  let nodeWarning = '';
  if (state.codeGraphProvider === 'gitnexus') {
    try {
      const {
        currentNodeMajor,
        GITNEXUS_MIN_NODE_MAJOR,
        nodeVersionMismatchMessage,
        findNvmNode22,
      } = require(path.resolve(__dirname, '..', 'gitnexus-runner.cjs'));

      // (a) Write `.nvmrc: 22` for new-project mode when it's missing.
      if (state.mode === 'new-project') {
        const nvmrcPath = path.join(stateDir, '.nvmrc');
        if (!fs.existsSync(nvmrcPath)) {
          try {
            fs.writeFileSync(nvmrcPath, '22\n', 'utf8');
          } catch {
            // best-effort; never block stack-rule loading on .nvmrc write.
          }
        }
      }

      // (b) Conditional Node-22 banner.
      const nvm22 = findNvmNode22();
      const major = currentNodeMajor();
      const tooOldAndNoFallback =
        major !== null
        && major < GITNEXUS_MIN_NODE_MAJOR
        && (!nvm22 || (!nvm22.node && !nvm22.npm));
      if (tooOldAndNoFallback) {
        nodeWarning = '\n\n═══ traffic-one — gitnexus needs Node ≥22 ═══\n'
          + nodeVersionMismatchMessage(major)
          + '\n\nAfter the `nvm` commands, fully quit + relaunch Claude Code '
          + 'so the hook process picks up the new default Node binary.\n';
      }
    } catch {
      // best-effort; never block stack-rule loading on a probe failure.
    }
  }

  const materializedLine = materialized
    ? `Project-local rules/skills materialized: ${materialized.rules} rule files, ${materialized.skills} skills. Root AGENTS.md contains the compact active rule kernel/index by default; root CLAUDE.md symlinks to AGENTS.md when safe.`
    : 'Active rules and skills remain loaded from session start.';
  const context = `[traffic-one] stack rules active for ${stack}. ${materializedLine}${nodeWarning}`;

  return {
    stdout: JSON.stringify({
      systemMessage: `traffic-one rules loaded for stack: ${stack} (no restart needed)`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }),
    exitCode: 0,
  };
}

function runMaterializeProject(_rawInput = '') {
  if (isPluginAuthoringRoot(process.cwd())) {
    return { stdout: '', exitCode: 0 };
  }
  const authGate = authGateForHook();
  if (!authGate.authenticated) {
    if (authChoiceAllowsContinue()) return { stdout: '', exitCode: 0 };
    const writeResult = tryWriteAuthChoice('pending-choice', process.cwd());
    return authRequiredHookResult('PostToolUse', { authChoiceWrite: writeResult });
  }
  return materializeProjectFromState(process.cwd(), 'manual materialize-project');
}

// ── Supabase Edge Function auto-deploy ───────────────────────────────────────
// Fires from the same PostToolUse Write|Edit dispatch as runPostStackSetup.
// `runPostFunctionEdit` is delegated from `runPostStackSetup` when the written
// file lives under `supabase/functions/<name>/` — kept in a separate function
// for clarity and testability.
//
// Flow:
//   - state.supabaseFunctionsAutoDeploy === "ask"   → emit one-time prompt
//   - state.supabaseFunctionsAutoDeploy === true    → spawn deploy, detached
//   - state.supabaseFunctionsAutoDeploy === false   → silent no-op
const FUNCTION_PATH_RE = /\/supabase\/functions\/([^/]+)\/(index|deno)\.(ts|tsx|mts|js)$/;

// Per-phase handoff digests written by the senior-* subagents — soft size cap.
// Captures the role name in group 1 for the warning message.
const DIGEST_PATH_RE = /(?:^|\/)\.traffic-one\/digests\/[^/]+\/(architect|frontend|backend|reviewer|tester|shipper)\.md$/;
const DIGEST_HARD_BYTES = 3 * 1024;  // warn over 3 KB; target is ≤2 KB

function findProjectRoot(startDir) {
  // Walk up to find the directory that owns `.traffic-one.json` or `package.json`
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, STATE_FILE)) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

function spawnDeployDetached(projectRoot, functionName) {
  // Spawn `npx supabase functions deploy <name>` detached + unref'd so the
  // hook returns immediately. Stdout/stderr go to a sidecar log the next
  // UserPromptSubmit can surface if it wants to.
  const logPath = path.join(projectRoot, '.traffic-one.deploy.log');
  let logFd;
  try {
    logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `\n--- ${nowIso()} deploy ${functionName} ---\n`);
  } catch {
    logFd = 'ignore';
  }

  try {
    const child = spawn('npx', ['supabase', 'functions', 'deploy', functionName], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, logPath };
  } catch (error) {
    return { ok: false, error: error.message, logPath };
  }
}

function runPostFunctionEdit(filePath) {
  const match = filePath.replace(/\\/g, '/').match(FUNCTION_PATH_RE);
  if (!match) {
    return null;
  }
  const functionName = match[1];

  const projectRoot = findProjectRoot(path.dirname(filePath));
  const statePath = path.join(projectRoot, STATE_FILE);
  const state = safeReadJson(statePath, {});
  if (state.backend !== 'supabase' && state.backend !== 'our-fork') {
    return null; // not a Supabase project
  }

  const flag = state.supabaseFunctionsAutoDeploy;

  if (flag === false || flag === 'never') {
    return null;
  }

  if (flag === true) {
    const result = spawnDeployDetached(projectRoot, functionName);
    if (result.ok) {
      return {
        systemMessage: `deploying Supabase function: ${functionName}`,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `[traffic-one] Edge function "${functionName}" auto-deploy started ` +
            `(\`npx supabase functions deploy ${functionName}\`). Output → ` +
            `\`${path.relative(projectRoot, result.logPath)}\` once complete.`,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[traffic-one] Tried to auto-deploy "${functionName}" but spawn failed: ${result.error}. ` +
          `Run \`pnpm functions:deploy ${functionName}\` manually.`,
      },
    };
  }

  // flag === 'ask' (default for new Supabase projects) → one-time consent prompt
  return {
    systemMessage: `Supabase function edited: ${functionName} (auto-deploy off — choose policy)`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        `[traffic-one] First edit to a Supabase Edge Function (\`${functionName}\`).`,
        '',
        'Choose an auto-deploy policy. Reply with one of:',
        '  • "yes, auto-deploy"   → I update `.traffic-one.json` to set',
        '       `supabaseFunctionsAutoDeploy: true` AND deploy this function once now',
        '       (`pnpm functions:deploy ' + functionName + '`). Future edits deploy silently.',
        '  • "ask each time"      → I leave the flag as "ask"; I\'ll prompt before',
        '       every deploy.',
        '  • "never"              → I set `supabaseFunctionsAutoDeploy: false`. No',
        '       auto-deploys; you run `pnpm functions:deploy <name>` yourself.',
        '',
        'You can change this later by editing `supabaseFunctionsAutoDeploy` in',
        '`.traffic-one.json`.',
      ].join('\n'),
    },
  };
}

module.exports = {
  runSessionStart,
  runUserPromptSubmit,
  runCheckOnboardingGate,
  runCheckAgentModel,        // PreToolUse(Task) → enforce performance-level model
  runCheckArchitectureWrite,
  runCheckLibraryAllowlist,
  runPostBuildPageSpeed,
  runPostStackSetup,
  runMaterializeProject,
  runPostFunctionEdit,      // exported for testing + entrypoint dispatch
  runPreGraphifyHint,        // PreToolUse(Glob|Grep) → graph hint
  runPostBuildGraphifyHint,  // PostToolUse(Bash) → post-build install/build hint
  forbiddenForStack,         // exported for testing
  authRequiredHookResult,    // exported for hook-runtime fail-closed fallback
};
