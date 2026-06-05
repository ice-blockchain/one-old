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
  // max isn't a cursor plan → cursor default
  assert.equal(detectHostPlan('cursor', env({ TRAFFIC_ONE_USER_PLAN: 'max' })), 'free');
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

test('detectHostPlan claude: missing/garbage file → default (free)', () => {
  assert.equal(detectHostPlan('claude', env({ HOME: tmpHome() })), 'free');
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
