// src/modules/session/auth-gate.ts
// Deterministic auth gate + canonical HookResult builders. Ported 1:1 from
// scripts/hook-runtime/handlers/auth.cjs. Directive PROSE comes from the session
// skill (skillBlock); enforcement (deny / allow) lives here. authGateForHook
// spawns the auth CLI at scripts/traffic-one-auth.cjs (present in both the
// alongside phase and post-cutover).

import { spawnSync } from 'child_process';
import * as path from 'path';

import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import {
  authRemoteCheckDue,
  authRequiredMessage,
  authStateFreshness,
  FRESHNESS_REASON,
  isAuthenticatedLocal,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
  readAuthState,
  refreshAttemptsExhausted,
} from '../../shared/auth';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { pluginRoot } from '../../shared/paths';
import { authApiKeyPromptRequest, authChoicePromptRequest, sessionExpiredPromptRequest } from '../../shared/prompt-request';
import { makeSkillBlock } from '../../shared/skill-block';
import { authChoiceAllowsContinue, tryWriteAuthChoice, type WriteResult } from './auth-choice';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string => skillBlock('session', name, { MCP_TOOL_WARNING: skillBlock('session', 'common-mcp-tool-warning', {}), ...vars });

function authScriptPath(): string {
  return path.resolve(pluginRoot(), 'scripts', 'traffic-one-auth.cjs');
}

export function parseAuthStatusOutput(stdout: unknown): Rec | null {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    return parsed && typeof parsed === 'object' ? (parsed as Rec) : null;
  } catch {
    return null;
  }
}

export interface AuthGate {
  authenticated: boolean;
  checkedRemote?: boolean;
  reauthenticated?: boolean;
  remoteCheckFailed?: boolean;
  reason?: string;
  priorReason?: string | null;
}

export function authGateForHook({ forceRemote = false }: { forceRemote?: boolean } = {}): AuthGate {
  const authScript = authScriptPath();
  const timeoutMs = Number.parseInt(process.env.TRAFFIC_ONE_AUTH_REMOTE_CHECK_TIMEOUT_MS || '5000', 10);
  const runStatus = (args: string[]) => spawnSync(process.execPath, [authScript, ...args], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8',
    timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000, maxBuffer: 64 * 1024,
  });

  if (!isAuthenticatedLocal()) {
    const refreshResult = runStatus(['status']);
    const refreshParsed = parseAuthStatusOutput(refreshResult.stdout);
    if (refreshResult.status === 0 && refreshParsed && refreshParsed.authenticated === true) {
      return { authenticated: true, checkedRemote: false, reauthenticated: refreshParsed.reauthenticated === true };
    }
    return {
      authenticated: false,
      reason: (refreshParsed && (refreshParsed.reason as string)) || (refreshResult.error && refreshResult.error.message) || 'local-auth-required',
      priorReason: (refreshParsed && (refreshParsed.priorReason as string)) || null,
    };
  }

  const authState = readAuthState();
  if (!forceRemote && !authRemoteCheckDue(authState)) return { authenticated: true, checkedRemote: false };

  const result = runStatus(['status', '--remote']);
  const parsed = parseAuthStatusOutput(result.stdout);
  if (parsed && parsed.authenticated === false) {
    return { authenticated: false, reason: (parsed.reason as string) || 'remote-auth-required', priorReason: (parsed.priorReason as string) || null };
  }
  if (!parsed || result.status !== 0 || parsed.remoteChecked === false) {
    if (process.env.TRAFFIC_ONE_AUTH_ALLOW_REMOTE_CHECK_FAILURE === '1') {
      return { authenticated: true, checkedRemote: true, remoteCheckFailed: true };
    }
    return { authenticated: false, reason: (parsed && (parsed.reason as string)) || (result.error && result.error.message) || 'remote-auth-check-failed' };
  }
  return { authenticated: true, checkedRemote: true, remoteCheckFailed: false };
}

export interface LoginResult {
  ok: boolean;
  status?: Rec;
  reason?: string;
}

export function runInternalAuthLogin(apiKey: string): LoginResult {
  const authScript = authScriptPath();
  const timeoutMs = Number.parseInt(process.env.TRAFFIC_ONE_AUTH_LOGIN_TIMEOUT_MS || '10000', 10);
  const options = { cwd: process.cwd(), env: process.env, encoding: 'utf8' as const, timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000, maxBuffer: 64 * 1024 };
  const loginResult = spawnSync(process.execPath, [authScript, 'login', '--stdin'], { ...options, input: apiKey });
  const loginParsed = parseAuthStatusOutput(loginResult.stdout);
  if (loginResult.status !== 0 || !loginParsed || loginParsed.ok !== true) {
    return { ok: false, reason: (loginResult.stderr || '').trim() || (loginParsed && (loginParsed.reason as string)) || 'login-failed' };
  }
  const statusResult = spawnSync(process.execPath, [authScript, 'status'], { ...options });
  const statusParsed = parseAuthStatusOutput(statusResult.stdout);
  if (statusResult.status === 0 && statusParsed && statusParsed.authenticated === true) {
    return { ok: true, status: statusParsed };
  }
  return { ok: false, reason: (statusResult.stderr || '').trim() || (statusParsed && (statusParsed.reason as string)) || 'status-check-failed' };
}

export function isSessionExpiryReauth(authGate: AuthGate, env: NodeJS.ProcessEnv = process.env): boolean {
  if (authGate && authGate.priorReason === FRESHNESS_REASON.EXPIRED) return true;
  if (authGate && authGate.reason === 'reauthentication-required') return true;
  const state = readAuthState(env);
  // Silent refresh gave up after the threshold → this is a re-auth, not first-time.
  if (refreshAttemptsExhausted(state)) return true;
  return authStateFreshness(state, env).reason === FRESHNESS_REASON.EXPIRED;
}

export function parseUnauthenticatedAuthChoice(prompt: string, options: { allowNumeric?: boolean } = {}): string | null {
  const text = String(prompt || '').trim().toLowerCase();
  if (!text) return null;
  const compact = text.replace(/[`"'’]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const mentionsTrafficOne = /\btraffic one\b/.test(compact);
  if (options.allowNumeric === true) {
    if (/^(1|one)$/.test(compact)) return 'authenticate';
    if (/^(2|two)$/.test(compact)) return 'continue-without-traffic-one';
  }
  if (
    (mentionsTrafficOne && /\b(authenticate|auth|login|log in|sign in|signin)\b/.test(compact))
    || /^(authenticate|auth|login|log in|sign in|signin|yes)$/.test(compact)
  ) {
    return 'authenticate';
  }
  const continueWithout = [
    /^(continue|proceed|skip|without|no)$/, /\bcontinue without\b/, /\bwithout traffic one\b/,
    /\bdont use\b/, /\bdo not use\b/, /\bnot use\b/, /\bskip\b/, /\bignore\b/, /\bdisable\b/, /\binactive\b/,
  ];
  if (continueWithout.some((p) => p.test(compact)) || (mentionsTrafficOne && /\b(continue|proceed|skip|ignore|without|disable|inactive|no)\b/.test(compact))) {
    return 'continue-without-traffic-one';
  }
  return null;
}

export function parseTrafficOneApiKey(prompt: string): string | null {
  let text = String(prompt || '').trim();
  if (!text) return null;
  text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
  if (/^(cancel|stop|never mind|nevermind)$/i.test(text)) return null;
  const keyPhrase = text.match(/\b(?:use\s+)?(?:the\s+)?(?:api\s+)?key\s+(?:is\s+)?([A-Za-z0-9][A-Za-z0-9._:-]{7,})\b/i);
  if (keyPhrase) return keyPhrase[1] ?? null;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/.test(text)) return text;
  return null;
}

// ── Canonical HookResult builders ────────────────────────────────────────────
function persistenceDiagnostic(writeResult?: WriteResult): string {
  if (!writeResult || writeResult.ok !== false) return '';
  const code = writeResult.code ? ` (${writeResult.code})` : '';
  return ['', block('persistence-diagnostic', { CODE: code })].join('\n');
}

export function authChoiceRequiredDenyReason(): string {
  return block('pre-tool-deny');
}

export function sessionExpiredReauthContext(): string {
  return block('session-expired');
}

export function authRequiredHookResult(_event: string, options: { authChoiceWrite?: WriteResult } = {}): HookResult {
  const inactiveMessage = [
    authRequiredMessage(),
    '',
    block('session-start-gate'),
    persistenceDiagnostic(options.authChoiceWrite),
  ].join('\n');
  return context(inactiveMessage, {
    systemMessage: 'traffic-one inactive: authentication choice required',
    promptRequest: authChoicePromptRequest(inactiveMessage),
  });
}

export function authApiKeyPromptHookResult(options: { authChoiceWrite?: WriteResult } = {}): HookResult {
  const additionalContext = [block('api-key-prompt'), persistenceDiagnostic(options.authChoiceWrite).trim()].join('\n');
  return context(additionalContext, {
    systemMessage: 'traffic-one authentication key required',
    promptRequest: authApiKeyPromptRequest(additionalContext),
  });
}

export function authChoiceHookResult(choice: string, cwd: string = process.cwd()): HookResult {
  if (choice === 'authenticate') {
    return authApiKeyPromptHookResult({ authChoiceWrite: tryWriteAuthChoice('authenticate', cwd) });
  }
  const writeResult = tryWriteAuthChoice('continue-without-traffic-one', cwd);
  const rememberedLine = writeResult.ok ? block('remembered-yes') : block('remembered-no');
  const additionalContext = [block('continue-without'), rememberedLine, persistenceDiagnostic(writeResult).trim()].join('\n');
  return context(additionalContext, { systemMessage: 'traffic-one inactive: user chose to continue without Traffic One' });
}

export function sessionExpiredReauthPromptResult(): HookResult {
  const additionalContext = sessionExpiredReauthContext();
  return context(additionalContext, {
    systemMessage: 'traffic-one session expired — re-authentication key required',
    promptRequest: sessionExpiredPromptRequest(additionalContext),
  });
}

export function authLoginFromPromptHookResult(apiKey: string): HookResult {
  const result = runInternalAuthLogin(apiKey);
  if (!result.ok) {
    return context(block('login-failed', { REASON: result.reason || 'unknown failure' }), { systemMessage: 'traffic-one authentication failed' });
  }
  return context(block('login-success'), { systemMessage: 'traffic-one authenticated' });
}

// PreToolUse gate: returns deny (block) or noop (allow).
export function authPreToolGate(ctx: Ctx): HookResult {
  if (isPluginAuthoringRoot(ctx.cwd)) return noop();
  const gate = authGateForHook();
  if (gate.authenticated) return noop();
  const command = ctx.input.tool?.command ?? '';
  if (ctx.input.tool?.class === 'shell' && (isTrafficOneAuthCommand(command) || isTrafficOneDoctorCommand(command))) {
    return noop();
  }
  if (authChoiceAllowsContinue(ctx.cwd)) return noop();
  if (isSessionExpiryReauth(gate)) {
    const reason = sessionExpiredReauthContext();
    return deny(reason, { promptRequest: sessionExpiredPromptRequest(reason) });
  }
  const reason = authChoiceRequiredDenyReason();
  return deny(reason, { promptRequest: authChoicePromptRequest(reason) });
}
