// src/shared/host-plan.ts
// Best-effort, never-throwing detection of the host user's subscription plan. We
// read the plan the host already persists locally — we do NOT infer it from token
// usage (usage can't reveal the cap; a light Max user looks like a heavy Pro user).
// Plans differ per host:
//   - claude: ~/.claude.json → oauthAccount (userRateLimitTier / organizationType /
//             seatTier); Linux+Windows also ~/.claude/.credentials.json →
//             claudeAiOauth.subscriptionType (macOS keeps that blob in the Keychain).
//   - codex:  ~/.codex/auth.json → tokens.id_token JWT → chatgpt_plan_type claim
//             (namespace https://api.openai.com/auth).
//   - cursor: the VS Code-fork global-storage SQLite (state.vscdb) →
//             ItemTable['cursorAuth/stripeMembershipType'] (free / pro / business / …),
//             read via the sqlite3 CLI (macOS/Linux) OR the built-in node:sqlite module
//             (every OS incl. Windows, Node >=22.5) — whichever is available.
// Home/config dirs resolve cross-OS (HOME → USERPROFILE → os.homedir(); APPDATA /
// XDG_CONFIG_HOME for Cursor). TRAFFIC_ONE_USER_PLAN overrides every host (and is the
// test seam). Result is memoized per (host + the env vars that affect detection) so
// the possibly-large ~/.claude.json (and the Cursor DB query) run at most once.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_HOST_PLAN, type HostModelKey, type UserPlan } from '../config/model-tiers';
import { readJson } from './fsjson';
import { canonicalHost, canonicalPlan } from './model-tiers';
import { obj } from './obj';

const cache = new Map<string, UserPlan>();

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

// Pull a plan keyword out of a Claude rate-limit / subscription string, e.g.
// "default_claude_max_5x" → max, "default_claude_pro" → pro, free/build → free.
function planFromTierString(value: unknown): UserPlan | null {
  if (typeof value !== 'string') return null;
  const s = value.toLowerCase();
  if (s.includes('enterprise')) return 'enterprise';
  if (s.includes('team')) return 'team';
  if (s.includes('max')) return 'max';
  if (s.includes('pro')) return 'pro';
  if (s.includes('free') || s.includes('build')) return 'free';
  return null;
}

// Decode the (unverified — it's the user's own token) JSON claims from a JWT's
// payload segment. Best-effort: returns null on any malformed input.
function decodeJwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const seg = token.split('.')[1];
  if (!seg) return null;
  try {
    return obj(JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function detectClaudePlan(env: NodeJS.ProcessEnv): string | null {
  const acct = obj(obj(readJson<unknown>(path.join(homeDir(env), '.claude.json'), null))?.oauthAccount);
  if (acct) {
    const orgType = typeof acct.organizationType === 'string' ? acct.organizationType.toLowerCase() : '';
    if (orgType.includes('enterprise')) return 'enterprise';
    if (orgType.includes('team')) return 'team';
    // Personal Max/Pro accounts carry the plan in DIFFERENT fields depending on how
    // the account is provisioned: individual subscribers often have null
    // `userRateLimitTier`/`seatTier`, with the only signal in `organizationType`
    // (e.g. "claude_max") or `organizationRateLimitTier` (e.g. "default_claude_max_5x").
    // Reading only the personal-tier fields mis-detected those as free → the wizard
    // recommended Low to a Max user. Fall through ALL known plan-bearing fields; the
    // enterprise/team early-returns above keep org plans taking precedence.
    const fromTier = planFromTierString(acct.userRateLimitTier)
      ?? planFromTierString(acct.subscriptionType)
      ?? planFromTierString(acct.seatTier)
      ?? planFromTierString(acct.organizationRateLimitTier)
      ?? planFromTierString(acct.organizationType);
    if (fromTier) return fromTier;
  }
  // Linux/Windows persist the OAuth blob to a file; macOS uses the Keychain.
  const oauth = obj(obj(readJson<unknown>(path.join(homeDir(env), '.claude', '.credentials.json'), null))?.claudeAiOauth);
  if (oauth) return planFromTierString(oauth.subscriptionType) ?? planFromTierString(oauth.rateLimitTier);
  return null;
}

function detectCodexPlan(env: NodeJS.ProcessEnv): string | null {
  const home = env.CODEX_HOME || path.join(homeDir(env), '.codex');
  const tokens = obj(obj(readJson<unknown>(path.join(home, 'auth.json'), null))?.tokens);
  if (!tokens) return null;
  const claims = decodeJwtClaims(tokens.id_token) ?? decodeJwtClaims(tokens.access_token);
  const auth = obj(claims?.['https://api.openai.com/auth']);
  return typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null;
}

// Cursor's global-storage SQLite path per OS (it's a VS Code fork).
function cursorStateDb(env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

const CURSOR_PLAN_SQL = "SELECT value FROM ItemTable WHERE key='cursorAuth/stripeMembershipType' LIMIT 1";

// Minimal structural type so we don't depend on @types/node shipping node:sqlite.
type SqliteModule = {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(): unknown };
    close(): void;
  };
};

// macOS + most Linux ship the sqlite3 CLI. Quiet (no experimental warning), so try it
// first on those platforms; returns null when the binary is absent (e.g. Windows).
function cursorPlanViaCli(db: string): string | null {
  try {
    const out = spawnSync('sqlite3', ['-readonly', db, `${CURSOR_PLAN_SQL};`], { encoding: 'utf8', timeout: 2000 });
    if (out.status === 0 && typeof out.stdout === 'string' && out.stdout.trim()) return out.stdout.trim();
  } catch {
    /* binary missing / spawn error */
  }
  return null;
}

// Built-in node:sqlite (Node >=22.5) — the cross-OS path, notably Windows where the CLI
// is absent. require() (CJS) keeps it optional so an older runtime just falls through.
function cursorPlanViaNodeSqlite(db: string): string | null {
  try {
    const sqlite = require('node:sqlite') as SqliteModule;
    const handle = new sqlite.DatabaseSync(db, { readOnly: true });
    try {
      const row = handle.prepare(CURSOR_PLAN_SQL).get() as { value?: unknown } | undefined;
      const v = row?.value;
      if (typeof v === 'string') return v;
      if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
    } finally {
      handle.close();
    }
  } catch {
    /* module unavailable (old/flagless node), locked db, etc. */
  }
  return null;
}

function detectCursorPlan(env: NodeJS.ProcessEnv): string | null {
  const db = cursorStateDb(env);
  if (!fs.existsSync(db)) return null;
  const raw = cursorPlanViaCli(db) ?? cursorPlanViaNodeSqlite(db);
  return raw ? raw.replace(/^"|"$/g, '') : null; // strip optional JSON quotes
}

function computePlan(host: HostModelKey, env: NodeJS.ProcessEnv): UserPlan {
  const override = env.TRAFFIC_ONE_USER_PLAN;
  if (typeof override === 'string' && override.trim()) return canonicalPlan(host, override);
  let raw: string | null = null;
  try {
    if (host === 'claude') raw = detectClaudePlan(env);
    else if (host === 'codex') raw = detectCodexPlan(env);
    else if (host === 'cursor') raw = detectCursorPlan(env);
  } catch {
    raw = null;
  }
  return raw ? canonicalPlan(host, raw) : DEFAULT_HOST_PLAN[host];
}

// The host user's current plan. Never throws; falls back to DEFAULT_HOST_PLAN.
export function detectHostPlan(host: unknown, env: NodeJS.ProcessEnv = process.env): UserPlan {
  const h = canonicalHost(host);
  const key = [
    h,
    env.TRAFFIC_ONE_USER_PLAN ?? '',
    env.HOME ?? env.USERPROFILE ?? '',
    env.CODEX_HOME ?? '',
    env.APPDATA ?? '',
    env.XDG_CONFIG_HOME ?? '',
  ].join('\u0000');
  const hit = cache.get(key);
  if (hit) return hit;
  let plan: UserPlan;
  try {
    plan = computePlan(h, env);
  } catch {
    plan = DEFAULT_HOST_PLAN[h];
  }
  cache.set(key, plan);
  return plan;
}
