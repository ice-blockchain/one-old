'use strict';

// scripts/hook-runtime/handlers/auth.cjs
// Auth-gate + auth-choice cluster: reads/writes the auth-choice state, parses
// pasted API keys, runs the internal login/status flow, detects session expiry,
// and produces the hook results that gate Traffic One until the user
// authenticates or chooses to continue without it. Function bodies are moved
// verbatim from the original single-file handlers.cjs.

const {
  fs,
  os,
  path,
  crypto,
  spawnSync,
  nowIso,
  FRESHNESS_REASON,
  authRemoteCheckDue,
  authRequiredMessage,
  authStateFreshness,
  authStatePath,
  isAuthenticatedLocal,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
  readTrafficOneAuthState,
  safeReadJson,
  isPluginAuthoringRoot,
  // low-level shared helpers
  extractPromptText,
  commandFromToolInput,
  isShellToolName,
  denyPreToolUse,
  authChoicePromptRequest,
  authApiKeyPromptRequest,
  sessionExpiredPromptRequest,
} = require('./_helpers.cjs');

// The auth-gate directive WORDING lives in the editable `traffic-one:auth`
// default skill (skills/auth/SKILL.md). This reads the per-branch text blocks
// from it; the deterministic decisions + enforcement below stay in JS.
const { authSkillBlock } = require('./auth-skill.cjs');

// Absolute path to THIS plugin version's auth script. Auth instructions must
// point the agent here (not a cwd-relative `scripts/...` path, which doesn't
// exist in a user's project and forces a filesystem search that can land on a
// stale cached plugin version with an out-of-date endpoint).
const AUTH_SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'traffic-one-auth.cjs');

function authChoicePersistenceDiagnostic(writeResult) {
  if (!writeResult || writeResult.ok !== false) return '';
  const code = writeResult.code ? ` (${writeResult.code})` : '';
  return [
    '',
    authSkillBlock('persistence-diagnostic', { CODE: code },
      `Diagnostic: Traffic One could not persist the auth choice state${code}. The prompt may repeat until storage is writable.`),
  ].join('\n');
}

function authRequiredHookResult(hookEventName, options = {}) {
  const message = authRequiredMessage();
  const persistenceDiagnostic = authChoicePersistenceDiagnostic(options.authChoiceWrite);
  const inactiveMessage = [
    message,
    '',
    authSkillBlock('session-start-gate', {},
      'Traffic One authentication is required. Ask the user to Authenticate Traffic One (Recommended) or Continue without Traffic One; if authenticating, request the API key via a secure input and stop.'),
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

const AUTH_CHOICE_STATE_VERSION = 3;
const AUTH_CHOICE_CONTINUE_TTL_MS = 4 * 60 * 60 * 1000;

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
    ? authSkillBlock('remembered-yes', {},
        'This choice has been remembered for this project so the auth prompt is not repeated here while it remains active.')
    : authSkillBlock('remembered-no', {},
        'This choice could not be persisted, so the auth prompt may repeat until Traffic One auth-choice storage is writable.');
  const payload = {
    systemMessage: 'traffic-one inactive: user chose to continue without Traffic One',
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        authSkillBlock('continue-without', {},
          'The user chose to continue without using the Traffic One plugin. Proceed with the user request using normal non-Traffic-One behavior only.'),
        rememberedLine,
        authChoicePersistenceDiagnostic(writeResult).trim(),
      ].join('\n'),
    },
  };
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

function authChoiceRequiredDenyReason() {
  return authSkillBlock('pre-tool-deny', {},
    'Traffic One authentication choice required before tool use. Ask the user to Authenticate Traffic One (Recommended) or Continue without Traffic One.');
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
  return authSkillBlock('session-expired', {},
    'Your Traffic One session has expired. Ask the user for their Traffic One API key to re-authenticate; do not offer Continue without Traffic One.');
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
    authSkillBlock('api-key-prompt', {},
      'The user chose to authenticate Traffic One. Ask for the Traffic One API key via a secure input and STOP; the hook authenticates it internally.'),
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
  const authScript = AUTH_SCRIPT_PATH;
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
        additionalContext: authSkillBlock('login-failed', { REASON: result.reason || 'unknown failure' },
          `Traffic One authentication failed (reason: ${result.reason || 'unknown failure'}). Ask the user to re-enter the API key.`),
      },
    };
    return { stdout: JSON.stringify(payload), exitCode: 0 };
  }
  const payload = {
    systemMessage: 'traffic-one authenticated',
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: authSkillBlock('login-success', {},
        'Traffic One authentication completed internally and status reports authenticated. Continue the user request with Traffic One enabled.'),
    },
  };
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

function authGateForHook({ forceRemote = false } = {}) {
  const authScript = AUTH_SCRIPT_PATH;
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

module.exports = {
  AUTH_SCRIPT_PATH,
  AUTH_CHOICE_STATE_VERSION,
  AUTH_CHOICE_CONTINUE_TTL_MS,
  authChoicePersistenceDiagnostic,
  authRequiredHookResult,
  authChoiceFallbackStatePath,
  authChoiceStatePaths,
  authChoiceStatePath,
  normalizeAuthChoiceState,
  readAuthChoiceState,
  writeAuthChoiceState,
  readAuthChoice,
  authChoiceStatus,
  writeAuthChoice,
  tryWriteAuthChoice,
  authChoiceAllowsContinue,
  parseUnauthenticatedAuthChoice,
  parseTrafficOneApiKey,
  authChoiceHookResult,
  authChoiceRequiredDenyReason,
  isSessionExpiryReauth,
  sessionExpiredReauthContext,
  sessionExpiredReauthPreToolResult,
  sessionExpiredReauthPromptResult,
  parseAuthStatusOutput,
  authApiKeyPromptHookResult,
  runInternalAuthLogin,
  authLoginFromPromptHookResult,
  authGateForHook,
  authPreToolGate,
};
