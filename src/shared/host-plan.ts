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
//   - copilot: ~/.copilot/settings.json plan-like fields when present; otherwise
//             ~/.copilot/data.db app_state['copilot-available-models'] as a capability
//             fallback (enabled medium/powerful models imply at least Pro capability).
//   - windsurf: Devin Desktop's VS Code-style global-storage SQLite
//             (state.vscdb) -> ItemTable['windsurf.reactSettings.cachedPlanInfoData:*']
//             -> planName (Free / Pro / Max / Team / Enterprise). This is a cached
//             Plan Info view, so the in-app model selector remains authoritative for
//             specific paid models.
//   - kilo: no stable documented local plan store for CLI plugins yet, so v1 defaults
//           to Free unless TRAFFIC_ONE_USER_PLAN resolves to a Kilo-supported plan.
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
import { canonicalHost, canonicalPlan, planIsRecognized } from './model-tiers';
import { obj } from './obj';

const cache = new Map<string, UserPlan>();

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function fileMtimeKey(file: string): string {
  try {
    return String(fs.statSync(file).mtimeMs);
  } catch {
    return '';
  }
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

function codexTokenClaims(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const home = env.CODEX_HOME || path.join(homeDir(env), '.codex');
  const tokens = obj(obj(readJson<unknown>(path.join(home, 'auth.json'), null))?.tokens);
  if (!tokens) return null;
  return decodeJwtClaims(tokens.id_token) ?? decodeJwtClaims(tokens.access_token);
}

// Newest-first bounded scan of Codex session rollouts. Every session writes
// server-reported rate-limit snapshots that carry the account's CURRENT
// `plan_type` — this tracks a plan change automatically (verified live: the
// telemetry flipped the same day the user changed plans), whereas the
// auth.json JWT claim is only re-minted at `codex login` and lags for weeks
// (the CLI refreshes tokens on a ~28-day window; `login status` does not).
const CODEX_SESSION_SCAN_FILES = 8;
const CODEX_SESSION_SCAN_DAYS = 3;
const CODEX_SESSION_TAIL_BYTES = 128 * 1024;
const CODEX_PLAN_TYPE_RE = /"plan_type"\s*:\s*"([a-z][a-z0-9_-]{0,31})"/g;

function newestDirEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort().reverse();
  } catch {
    return [];
  }
}

function lastPlanTypeInTail(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, CODEX_SESSION_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const text = buf.toString('utf8');
      let last: string | null = null;
      for (const match of text.matchAll(CODEX_PLAN_TYPE_RE)) last = match[1] ?? last;
      return last;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function detectCodexSessionPlan(env: NodeJS.ProcessEnv): string | null {
  const sessions = path.join(env.CODEX_HOME || path.join(homeDir(env), '.codex'), 'sessions');
  let scanned = 0;
  let daysSeen = 0;
  for (const year of newestDirEntries(sessions)) {
    for (const month of newestDirEntries(path.join(sessions, year))) {
      for (const day of newestDirEntries(path.join(sessions, year, month))) {
        if (daysSeen >= CODEX_SESSION_SCAN_DAYS) return null;
        daysSeen += 1;
        const dayDir = path.join(sessions, year, month, day);
        for (const file of newestDirEntries(dayDir)) {
          if (!file.endsWith('.jsonl')) continue;
          if (scanned >= CODEX_SESSION_SCAN_FILES) return null;
          scanned += 1;
          const plan = lastPlanTypeInTail(path.join(dayDir, file));
          if (plan) return plan;
        }
      }
    }
  }
  return null;
}

function detectCodexPlan(env: NodeJS.ProcessEnv): string | null {
  const fromSessions = detectCodexSessionPlan(env);
  if (fromSessions) return fromSessions;
  const auth = obj(codexTokenClaims(env)?.['https://api.openai.com/auth']);
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

// Windsurf/Devin Desktop uses the VS Code global-storage layout too, but persists
// plan metadata as a JSON object keyed by the signed-in user id. The key suffix is
// deliberately opaque; the value's planName is the stable capability signal.
function windsurfStateDb(env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Devin', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Devin', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Devin', 'User', 'globalStorage', 'state.vscdb');
}

const WINDSURF_PLAN_SQL = "SELECT value FROM ItemTable WHERE key LIKE 'windsurf.reactSettings.cachedPlanInfoData:%' LIMIT 1";

function windsurfPlanViaCli(db: string): string | null {
  try {
    const out = spawnSync('sqlite3', ['-readonly', db, `${WINDSURF_PLAN_SQL};`], { encoding: 'utf8', timeout: 2000 });
    if (out.status === 0 && typeof out.stdout === 'string' && out.stdout.trim()) return out.stdout.trim();
  } catch {
    /* binary missing / spawn error */
  }
  return null;
}

function windsurfPlanViaNodeSqlite(db: string): string | null {
  try {
    const sqlite = require('node:sqlite') as SqliteModule;
    const handle = new sqlite.DatabaseSync(db, { readOnly: true });
    try {
      const row = handle.prepare(WINDSURF_PLAN_SQL).get() as { value?: unknown } | undefined;
      const value = row?.value;
      if (typeof value === 'string') return value;
      if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    } finally {
      handle.close();
    }
  } catch {
    /* module unavailable (old/flagless node), locked db, etc. */
  }
  return null;
}

function windsurfPlanFromCachedInfo(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const info = obj(JSON.parse(raw));
    if (!info) return null;
    const named = planFromTierString(info.planName ?? info.plan ?? info.subscription ?? info.tier);
    if (named) return named;
    return info.isFreeOrTrial === true || info.isDevinFree === true ? 'free' : null;
  } catch {
    return null;
  }
}

function detectWindsurfPlan(env: NodeJS.ProcessEnv): string | null {
  const db = windsurfStateDb(env);
  if (!fs.existsSync(db)) return null;
  return windsurfPlanFromCachedInfo(windsurfPlanViaCli(db) ?? windsurfPlanViaNodeSqlite(db));
}

// OpenCode persists provider auth at $XDG_DATA_HOME|~/.local/share/opencode/auth.json.
// A PAID subscription appears as a provider key like "opencode-go" (the free zero-auth
// gateway is the keyless "opencode" provider, or no key at all). Any "opencode-<tier>"
// key ⇒ paid; we return "go" → canonicalPlan maps it to `plus` (the only paid plan
// HOST_PLAN_IDS.opencode exposes). Best-effort; never throws (absent/unreadable → free).
function detectOpenCodePlan(env: NodeJS.ProcessEnv): string | null {
  const authPath = openCodeAuthPath(env);
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (auth && typeof auth === 'object' && Object.keys(auth).some((k) => /^opencode-\w/.test(k))) return 'go';
  } catch {
    // auth.json absent / unreadable / not JSON → no detectable paid plan
  }
  return null;
}

function openCodeAuthPath(env: NodeJS.ProcessEnv): string {
  const dataHome = env.XDG_DATA_HOME || path.join(homeDir(env), '.local', 'share');
  return path.join(dataHome, 'opencode', 'auth.json');
}

function copilotSettingsPath(env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  const copilotHome = env.COPILOT_HOME || path.join(home, '.copilot');
  return path.join(copilotHome, 'settings.json');
}

function copilotDataDbPath(env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  const copilotHome = env.COPILOT_HOME || path.join(home, '.copilot');
  return path.join(copilotHome, 'data.db');
}

const COPILOT_MODELS_SQL = "SELECT value FROM app_state WHERE key='copilot-available-models' LIMIT 1";

function copilotModelsViaCli(db: string): string | null {
  try {
    const out = spawnSync('sqlite3', ['-readonly', db, `${COPILOT_MODELS_SQL};`], { encoding: 'utf8', timeout: 2000 });
    if (out.status === 0 && typeof out.stdout === 'string' && out.stdout.trim()) return out.stdout.trim();
  } catch {
    /* binary missing / spawn error */
  }
  return null;
}

function copilotModelsViaNodeSqlite(db: string): string | null {
  try {
    const sqlite = require('node:sqlite') as SqliteModule;
    const handle = new sqlite.DatabaseSync(db, { readOnly: true });
    try {
      const row = handle.prepare(COPILOT_MODELS_SQL).get() as { value?: unknown } | undefined;
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

function copilotPlanFromModelCatalog(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const models = JSON.parse(raw);
    if (!Array.isArray(models)) return null;
    for (const entry of models) {
      const model = obj(entry);
      if (!model) continue;
      const id = typeof model.id === 'string' ? model.id.trim() : '';
      if (!id || id === 'auto') continue;
      const policy = obj(model.policy);
      if (policy && policy.state === 'disabled') continue;
      const category = typeof model.modelPickerCategory === 'string' ? model.modelPickerCategory : '';
      const price = typeof model.modelPickerPriceCategory === 'string' ? model.modelPickerPriceCategory : '';
      if (category === 'powerful') return 'pro';
      if (category === 'versatile' && price !== 'low') return 'pro';
    }
  } catch {
    return null;
  }
  return null;
}

function detectCopilotPlanViaModels(env: NodeJS.ProcessEnv): string | null {
  const db = copilotDataDbPath(env);
  if (!fs.existsSync(db)) return null;
  return copilotPlanFromModelCatalog(copilotModelsViaCli(db) ?? copilotModelsViaNodeSqlite(db));
}

function detectCopilotPlan(env: NodeJS.ProcessEnv): string | null {
  const settings = obj(readJson<unknown>(copilotSettingsPath(env), null));
  if (settings) {
    const candidates = [
      settings.plan,
      settings.subscription,
      settings.subscriptionType,
      settings.copilotPlan,
      settings.accountType,
      obj(settings.account)?.plan,
      obj(settings.account)?.type,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return detectCopilotPlanViaModels(env);
}

function computePlan(host: HostModelKey, env: NodeJS.ProcessEnv): UserPlan {
  const override = env.TRAFFIC_ONE_USER_PLAN;
  if (typeof override === 'string' && override.trim()) return canonicalPlan(host, override);
  let raw: string | null = null;
  try {
    if (host === 'claude') raw = detectClaudePlan(env);
    else if (host === 'codex') raw = detectCodexPlan(env);
    else if (host === 'cursor') raw = detectCursorPlan(env);
    else if (host === 'opencode') raw = detectOpenCodePlan(env);
    else if (host === 'copilot') raw = detectCopilotPlan(env);
    else if (host === 'windsurf') raw = detectWindsurfPlan(env);
    else if (host === 'kilo') raw = null;
  } catch {
    raw = null;
  }
  // Some host plan strings are app-specific (Cursor stripeMembershipType, Copilot's
  // product-label strings). An unrecognized value silently collapses to DEFAULT_HOST_PLAN
  // (usually free). Flag it opt-in so a real install's string can be added to PLAN_ALIASES.
  if ((host === 'cursor' || host === 'copilot' || host === 'windsurf') && raw && !planIsRecognized(raw) && env.TRAFFIC_ONE_DEBUG) {
    try {
      process.stderr.write(`[traffic-one] ${host}: unrecognized plan string ${JSON.stringify(raw)} → treated as "${DEFAULT_HOST_PLAN[host]}". Add an alias in config/model-tiers.ts PLAN_ALIASES.\n`);
    } catch {
      /* stderr unavailable; diagnostic is best-effort */
    }
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
    env.COPILOT_HOME ?? '',
    env.APPDATA ?? '',
    env.XDG_CONFIG_HOME ?? '',
    env.XDG_DATA_HOME ?? '',
    ...(h === 'opencode' ? [fileMtimeKey(openCodeAuthPath(env))] : []),
    ...(h === 'windsurf' ? [fileMtimeKey(windsurfStateDb(env))] : []),
    ...(h === 'copilot' ? [fileMtimeKey(copilotSettingsPath(env)), fileMtimeKey(copilotDataDbPath(env))] : []),
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
