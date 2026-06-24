// src/runners/token-report/aggregateCursorSqliteEstimate.ts
// Cursor does not expose a stable billed-token transcript like Claude/Codex.
// This module offers an explicitly estimate-only fallback by sampling Cursor's
// SQLite state DB when `sqlite3` is available.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { emptyStats } from './emptyStats';
import type { Stats } from './lib';

type Rec = Record<string, unknown>;

export interface CursorSqliteTarget {
  id: string;
  cwd: string;
  dbPath: string;
  exists: boolean;
  mtimeMs: number;
  sourceType?: 'cursor';
}

export interface CursorEstimate {
  dbPath: string;
  rowsScanned: number;
  matchedRows: number;
  estimatedTextChars: number;
  estimatedTokens: number;
  warnings: string[];
}

export function defaultCursorSqlitePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.TRAFFIC_ONE_CURSOR_STATE_DB) out.push(env.TRAFFIC_ONE_CURSOR_STATE_DB);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    out.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else {
    out.push(path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }
  return [...new Set(out)];
}

export function findCursorSqliteEstimateTargets(cwd: string): CursorSqliteTarget[] {
  const candidates = defaultCursorSqlitePaths();
  const existing = candidates.filter((dbPath) => fs.existsSync(dbPath));
  const paths = existing.length > 0 ? existing : candidates.slice(0, 1);
  return paths.map((dbPath) => {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(dbPath).mtimeMs; } catch { mtimeMs = 0; }
    return {
      id: `cursor-sqlite:${path.basename(dbPath)}`,
      cwd,
      dbPath,
      exists: fs.existsSync(dbPath),
      mtimeMs,
      sourceType: 'cursor' as const,
    };
  });
}

function sqliteRows(dbPath: string): { rows: Rec[]; warning: string | null } {
  const sql = [
    'SELECT key, value FROM ItemTable',
    "WHERE key LIKE '%composer%' OR key LIKE '%chat%' OR key LIKE '%ai%'",
    'ORDER BY rowid DESC LIMIT 500',
  ].join(' ');
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) return { rows: [], warning: `sqlite3 unavailable: ${result.error.message}` };
  if (result.status !== 0) return { rows: [], warning: `sqlite3 failed: ${(result.stderr || '').trim() || `exit ${result.status}`}` };
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return { rows: Array.isArray(parsed) ? parsed.filter((row): row is Rec => row && typeof row === 'object') : [], warning: null };
  } catch (err) {
    return { rows: [], warning: `sqlite3 JSON output could not be parsed: ${(err as Error).message}` };
  }
}

function rowText(row: Rec): string {
  const key = typeof row.key === 'string' ? row.key : '';
  const value = typeof row.value === 'string' ? row.value : '';
  return `${key}\n${value}`;
}

function matchesProject(text: string, cwd: string): boolean {
  const root = path.resolve(cwd);
  const base = path.basename(root);
  return text.includes(root) || (!!base && text.includes(base));
}

export function aggregateCursorSqliteEstimate(target: CursorSqliteTarget): {
  source: 'cursor';
  session: Record<string, unknown>;
  parent: Stats;
  subagents: never[];
  cursorEstimate: CursorEstimate;
} {
  const stats = emptyStats();
  const warnings: string[] = [
    'Cursor SQLite support is estimate-only. Cursor does not expose stable billed-token, cache, or per-model usage in this report.',
  ];
  let rows: Rec[] = [];
  if (!target.exists) {
    warnings.push(`Cursor SQLite DB not found at ${target.dbPath}.`);
  } else {
    const queried = sqliteRows(target.dbPath);
    rows = queried.rows;
    if (queried.warning) warnings.push(queried.warning);
  }
  const matched = rows.map(rowText).filter((text) => matchesProject(text, target.cwd));
  const chars = matched.reduce((acc, text) => acc + Buffer.byteLength(text, 'utf8'), 0);
  const estimatedTokens = Math.ceil(chars / 4);
  stats.messages = matched.length;
  stats.inputTokens = estimatedTokens;
  stats.byModel['cursor-sqlite-estimate'] = {
    messages: matched.length,
    inputTokens: estimatedTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
  if (target.mtimeMs > 0) {
    const iso = new Date(target.mtimeMs).toISOString();
    stats.firstAt = iso;
    stats.lastAt = iso;
  }
  return {
    source: 'cursor',
    session: target as unknown as Record<string, unknown>,
    parent: stats,
    subagents: [],
    cursorEstimate: {
      dbPath: target.dbPath,
      rowsScanned: rows.length,
      matchedRows: matched.length,
      estimatedTextChars: chars,
      estimatedTokens,
      warnings,
    },
  };
}
