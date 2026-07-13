import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { detectHostPlan } from '../host-plan';

const hasSqlite3 = (() => { try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; } })();
const hasNodeSqlite = (() => { try { require('node:sqlite'); return true; } catch { return false; } })();

function cursorGlobalStorage(home: string): string {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage');
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage');
}

function windsurfGlobalStorage(home: string): string {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Devin', 'User', 'globalStorage');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage');
  return path.join(home, '.config', 'Devin', 'User', 'globalStorage');
}

// Build a minimal Cursor state.vscdb fixture with whatever SQLite is available —
// node:sqlite is cross-OS (incl. Windows); the sqlite3 CLI is the macOS/Linux fallback.
function writeCursorMembershipDb(db: string, membership: string): boolean {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (f: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown }; close(): void } };
    const h = new sqlite.DatabaseSync(db);
    h.exec('CREATE TABLE IF NOT EXISTS ItemTable(key TEXT PRIMARY KEY, value BLOB)');
    h.prepare("INSERT OR REPLACE INTO ItemTable(key, value) VALUES('cursorAuth/stripeMembershipType', ?)").run(membership);
    h.close();
    return true;
  } catch { /* fall through to CLI */ }
  try {
    return spawnSync('sqlite3', [db, `CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB); INSERT INTO ItemTable VALUES('cursorAuth/stripeMembershipType','${membership}');`]).status === 0;
  } catch { return false; }
}

function writeWindsurfPlanDb(db: string, planName: string): boolean {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const key = 'windsurf.reactSettings.cachedPlanInfoData:user-test';
  const value = JSON.stringify({ planName, isFreeOrTrial: planName.toLowerCase() === 'free' });
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (f: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown }; close(): void } };
    const h = new sqlite.DatabaseSync(db);
    h.exec('CREATE TABLE IF NOT EXISTS ItemTable(key TEXT PRIMARY KEY, value BLOB)');
    h.prepare('INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)').run(key, value);
    h.close();
    return true;
  } catch { /* fall through to CLI */ }
  try {
    const escapedKey = key.replace(/'/g, "''");
    const escapedValue = value.replace(/'/g, "''");
    return spawnSync('sqlite3', [db, `CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB); INSERT INTO ItemTable VALUES('${escapedKey}','${escapedValue}');`]).status === 0;
  } catch { return false; }
}

function writeCopilotAppStateDb(db: string, key: string, value: string): boolean {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (f: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown }; close(): void } };
    const h = new sqlite.DatabaseSync(db);
    h.exec('CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    h.prepare('INSERT OR REPLACE INTO app_state(key, value) VALUES(?, ?)').run(key, value);
    h.close();
    return true;
  } catch { /* fall through to CLI */ }
  try {
    const escapedKey = key.replace(/'/g, "''");
    const escapedValue = value.replace(/'/g, "''");
    return spawnSync('sqlite3', [db, `CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); INSERT OR REPLACE INTO app_state(key, value) VALUES('${escapedKey}','${escapedValue}');`]).status === 0;
  } catch { return false; }
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-plan-'));
}

function jwt(payload: unknown): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg(payload)}.sig`;
}

const env = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

test('detectHostPlan: TRAFFIC_ONE_USER_PLAN overrides every host (canonicalized per host)', () => {
  assert.equal(detectHostPlan('claude', env({ TRAFFIC_ONE_USER_PLAN: 'pro' })), 'pro');
  assert.equal(detectHostPlan('codex', env({ TRAFFIC_ONE_USER_PLAN: 'plus' })), 'plus');
  assert.equal(detectHostPlan('cursor', env({ TRAFFIC_ONE_USER_PLAN: 'business' })), 'business');
  // Cursor now recognizes its 2026 individual tiers: Ultra → max, Pro+ → plus.
  assert.equal(detectHostPlan('cursor', env({ TRAFFIC_ONE_USER_PLAN: 'max' })), 'max');
  assert.equal(detectHostPlan('cursor', env({ TRAFFIC_ONE_USER_PLAN: 'ultra' })), 'max');
  assert.equal(detectHostPlan('cursor', env({ TRAFFIC_ONE_USER_PLAN: 'pro+' })), 'plus');
  assert.equal(detectHostPlan('cursor', env({ TRAFFIC_ONE_USER_PLAN: 'pro_plus' })), 'plus');
  // A genuinely unknown string still collapses to the conservative cursor default.
  assert.equal(detectHostPlan('cursor', env({ TRAFFIC_ONE_USER_PLAN: 'wat' })), 'free');
  assert.equal(detectHostPlan('windsurf', env({ TRAFFIC_ONE_USER_PLAN: 'pro' })), 'pro');
  assert.equal(detectHostPlan('windsurf', env({ TRAFFIC_ONE_USER_PLAN: 'max' })), 'max');
  assert.equal(detectHostPlan('windsurf', env({ TRAFFIC_ONE_USER_PLAN: 'business' })), 'free');
  assert.equal(detectHostPlan('kilo', env({ TRAFFIC_ONE_USER_PLAN: 'free' })), 'free');
  assert.equal(detectHostPlan('kilo', env({ TRAFFIC_ONE_USER_PLAN: 'pro' })), 'free');
});

test('detectHostPlan claude: reads ~/.claude.json oauthAccount (rate-limit tier / org type)', () => {
  const h1 = tmpHome();
  fs.writeFileSync(path.join(h1, '.claude.json'), JSON.stringify({ oauthAccount: { userRateLimitTier: 'default_claude_max_5x' } }), 'utf8');
  assert.equal(detectHostPlan('claude', env({ HOME: h1 })), 'max');

  const h2 = tmpHome();
  fs.writeFileSync(path.join(h2, '.claude.json'), JSON.stringify({ oauthAccount: { userRateLimitTier: 'default_claude_pro' } }), 'utf8');
  assert.equal(detectHostPlan('claude', env({ HOME: h2 })), 'pro');

  const h3 = tmpHome();
  fs.writeFileSync(path.join(h3, '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_enterprise' } }), 'utf8');
  assert.equal(detectHostPlan('claude', env({ HOME: h3 })), 'enterprise');
});

test('detectHostPlan claude: personal Max account — plan only in organizationType/organizationRateLimitTier (null personal tiers)', () => {
  // Real-world shape of an individual Max subscriber: userRateLimitTier and
  // seatTier are null, subscriptionType absent; the Max signal lives only in
  // organizationType ("claude_max") and organizationRateLimitTier
  // ("default_claude_max_5x"). Before the fix this fell through to free, so the
  // onboarding wizard recommended Low to a Max user.
  const hMax = tmpHome();
  fs.writeFileSync(path.join(hMax, '.claude.json'), JSON.stringify({
    oauthAccount: {
      userRateLimitTier: null,
      seatTier: null,
      organizationType: 'claude_max',
      organizationRateLimitTier: 'default_claude_max_5x',
    },
  }), 'utf8');
  assert.equal(detectHostPlan('claude', env({ HOME: hMax })), 'max');

  // organizationRateLimitTier alone (organizationType generic) also resolves.
  const hMax2 = tmpHome();
  fs.writeFileSync(path.join(hMax2, '.claude.json'), JSON.stringify({
    oauthAccount: { userRateLimitTier: null, organizationRateLimitTier: 'default_claude_max_20x' },
  }), 'utf8');
  assert.equal(detectHostPlan('claude', env({ HOME: hMax2 })), 'max');

  // A personal Pro account expressed only via organizationType resolves to pro.
  const hPro = tmpHome();
  fs.writeFileSync(path.join(hPro, '.claude.json'), JSON.stringify({
    oauthAccount: { userRateLimitTier: null, organizationType: 'claude_pro' },
  }), 'utf8');
  assert.equal(detectHostPlan('claude', env({ HOME: hPro })), 'pro');
});

test('detectHostPlan claude: missing/garbage file → conservative Claude Code default (pro)', () => {
  assert.equal(detectHostPlan('claude', env({ HOME: tmpHome() })), 'pro');
});

test('detectHostPlan codex: decodes chatgpt_plan_type from the id_token JWT', () => {
  const home = tmpHome();
  const token = jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: token } }), 'utf8');
  assert.equal(detectHostPlan('codex', env({ CODEX_HOME: home })), 'pro');
});

test('detectHostPlan codex: prolite (ChatGPT Go / Pro-Lite) maps to plus', () => {
  const home = tmpHome();
  const token = jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'prolite' } });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: token } }), 'utf8');
  assert.equal(detectHostPlan('codex', env({ CODEX_HOME: home })), 'plus');
});

test('detectHostPlan codex: malformed token / no file → default free', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: 'not-a-jwt' } }), 'utf8');
  assert.equal(detectHostPlan('codex', env({ CODEX_HOME: home })), 'free');
  assert.equal(detectHostPlan('codex', env({ CODEX_HOME: tmpHome() })), 'free');
});

test('detectHostPlan cursor: reads cursorAuth/stripeMembershipType from state.vscdb (cross-OS)', { skip: !(hasSqlite3 || hasNodeSqlite) }, () => {
  const home = tmpHome();
  const dir = cursorGlobalStorage(home);
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, 'state.vscdb');
  assert.ok(writeCursorMembershipDb(db, 'pro'), 'could not create fixture state.vscdb');
  assert.equal(detectHostPlan('cursor', env({ HOME: home })), 'pro');
});

test('detectHostPlan cursor: no DB and no override → default (free)', () => {
  assert.equal(detectHostPlan('cursor', env({ HOME: tmpHome() })), 'free');
});

test('detectHostPlan windsurf: no local plan source → default Free, never Claude fallback', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' },
  }), 'utf8');
  assert.equal(detectHostPlan('windsurf', env({ HOME: home })), 'free');
});

test('detectHostPlan windsurf: reads cached Devin Plan Info from state.vscdb', { skip: !(hasSqlite3 || hasNodeSqlite) }, () => {
  const home = tmpHome();
  const dir = windsurfGlobalStorage(home);
  const db = path.join(dir, 'state.vscdb');
  assert.ok(writeWindsurfPlanDb(db, 'Max'), 'could not create fixture state.vscdb');
  assert.equal(detectHostPlan('windsurf', env({ HOME: home })), 'max');
});

test('detectHostPlan windsurf: cache notices the cached Plan Info appearing after a Free fallback', { skip: !(hasSqlite3 || hasNodeSqlite) }, () => {
  const home = tmpHome();
  const e = env({ HOME: home });
  assert.equal(detectHostPlan('windsurf', e), 'free');
  const db = path.join(windsurfGlobalStorage(home), 'state.vscdb');
  assert.ok(writeWindsurfPlanDb(db, 'Pro'), 'could not create fixture state.vscdb');
  assert.equal(detectHostPlan('windsurf', e), 'pro');
});

test('detectHostPlan kilo: no local plan source → default Free, never Claude fallback', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' },
  }), 'utf8');
  assert.equal(detectHostPlan('kilo', env({ HOME: home })), 'free');
});

test('detectHostPlan opencode: auth.json provider key → plus (opencode-go) / free (none)', () => {
  const go = tmpHome();
  const dir = path.join(go, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'x' } }), 'utf8');
  assert.equal(detectHostPlan('opencode', env({ HOME: go })), 'plus');
  // no auth file (a fresh home) → the free zero-auth gateway
  assert.equal(detectHostPlan('opencode', env({ HOME: tmpHome() })), 'free');
});

test('detectHostPlan opencode: honors XDG_DATA_HOME and does not reuse a different auth location cache entry', () => {
  const home = tmpHome();
  const dataHome = path.join(tmpHome(), 'data');
  const dir = path.join(dataHome, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'x' } }), 'utf8');
  assert.equal(detectHostPlan('opencode', env({ HOME: home, XDG_DATA_HOME: dataHome })), 'plus');
  assert.equal(detectHostPlan('opencode', env({ HOME: home, XDG_DATA_HOME: path.join(tmpHome(), 'empty') })), 'free');
});

test('detectHostPlan copilot: product-label settings strings resolve to Pro', () => {
  const home = tmpHome();
  const copilotHome = path.join(home, '.copilot');
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.writeFileSync(path.join(copilotHome, 'settings.json'), JSON.stringify({ plan: 'Copilot Pro' }), 'utf8');
  assert.equal(detectHostPlan('copilot', env({ HOME: home })), 'pro');
});

test('detectHostPlan copilot: enabled premium model catalog gives a Pro capability floor', { skip: !(hasSqlite3 || hasNodeSqlite) }, () => {
  const home = tmpHome();
  const db = path.join(home, '.copilot', 'data.db');
  const catalog = JSON.stringify([
    { id: 'auto', name: 'Auto' },
    { id: 'gpt-5.4-mini', modelPickerCategory: 'lightweight', modelPickerPriceCategory: 'low', policy: { state: 'enabled' } },
    { id: 'gpt-5.3-codex', modelPickerCategory: 'powerful', modelPickerPriceCategory: 'medium', policy: { state: 'enabled' } },
  ]);
  assert.ok(writeCopilotAppStateDb(db, 'copilot-available-models', catalog), 'could not create fixture data.db');
  assert.equal(detectHostPlan('copilot', env({ HOME: home })), 'pro');
});

test('detectHostPlan copilot: only lightweight catalog falls back to Free', { skip: !(hasSqlite3 || hasNodeSqlite) }, () => {
  const home = tmpHome();
  const db = path.join(home, '.copilot', 'data.db');
  const catalog = JSON.stringify([
    { id: 'auto', name: 'Auto' },
    { id: 'gpt-5.4-mini', modelPickerCategory: 'lightweight', modelPickerPriceCategory: 'low', policy: { state: 'enabled' } },
  ]);
  assert.ok(writeCopilotAppStateDb(db, 'copilot-available-models', catalog), 'could not create fixture data.db');
  assert.equal(detectHostPlan('copilot', env({ HOME: home })), 'free');
});

test('detectHostPlan copilot: cache notices the model catalog appearing after a Free fallback', { skip: !(hasSqlite3 || hasNodeSqlite) }, () => {
  const home = tmpHome();
  const e = env({ HOME: home });
  assert.equal(detectHostPlan('copilot', e), 'free');
  const db = path.join(home, '.copilot', 'data.db');
  const catalog = JSON.stringify([
    { id: 'auto', name: 'Auto' },
    { id: 'gpt-5.3-codex', modelPickerCategory: 'powerful', modelPickerPriceCategory: 'medium', policy: { state: 'enabled' } },
  ]);
  assert.ok(writeCopilotAppStateDb(db, 'copilot-available-models', catalog), 'could not create fixture data.db');
  assert.equal(detectHostPlan('copilot', e), 'pro');
});
