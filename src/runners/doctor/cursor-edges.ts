// Read-only Cursor install-edge probe. Names two silent breaks: hooks dead
// because third-party extensibility is off (or never written), and every hook
// firing twice because Local and the imported Claude bundle are both present.
// Never writes sqlite, never deletes Local, never copies a bundle.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cursorStateDb } from '../../shared/host/plan';

export interface CursorEdgesProbe {
  cursorPresent: boolean;
  stateDbPath: string | null;
  stateDbReadable: boolean;
  thirdPartyExtensibilityEnabled: true | false | null;
  localInstallPresent: boolean;
  localInstallPath: string | null;
  claudeCachePresent: boolean;
  claudeCachePath: string | null;
}

const ABSENT: CursorEdgesProbe = {
  cursorPresent: false,
  stateDbPath: null,
  stateDbReadable: false,
  thirdPartyExtensibilityEnabled: null,
  localInstallPresent: false,
  localInstallPath: null,
  claudeCachePresent: false,
  claudeCachePath: null,
};

const EXTENSIBILITY_SQL = "SELECT value FROM ItemTable WHERE key='thirdPartyExtensibilityEnabled' LIMIT 1";

type SqliteModule = {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(): unknown };
    close(): void;
  };
};

type ItemTableRead = { ok: true; value: string | null } | { ok: false };

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function stripOptionalQuotes(raw: string): string {
  return raw.replace(/^"|"$/g, '');
}

function interpretFlag(value: string | null): true | false | null {
  if (value === null || value === '') return null;
  return value === 'true';
}

function extensibilityViaCli(db: string): ItemTableRead {
  try {
    const out = spawnSync('sqlite3', ['-readonly', db, `${EXTENSIBILITY_SQL};`], { encoding: 'utf8', timeout: 2000 });
    if (out.status === 0 && typeof out.stdout === 'string') {
      const raw = out.stdout.trim();
      return { ok: true, value: raw ? stripOptionalQuotes(raw) : null };
    }
  } catch {
    /* binary missing / spawn error */
  }
  return { ok: false };
}

function extensibilityViaNodeSqlite(db: string): ItemTableRead {
  try {
    const sqlite = require('node:sqlite') as SqliteModule;
    const handle = new sqlite.DatabaseSync(db, { readOnly: true });
    try {
      const row = handle.prepare(EXTENSIBILITY_SQL).get() as { value?: unknown } | undefined;
      const v = row?.value;
      if (typeof v === 'string') return { ok: true, value: stripOptionalQuotes(v) };
      if (v instanceof Uint8Array) return { ok: true, value: stripOptionalQuotes(Buffer.from(v).toString('utf8')) };
      return { ok: true, value: null };
    } finally {
      handle.close();
    }
  } catch {
    /* module unavailable (old/flagless node), locked db, etc. */
  }
  return { ok: false };
}

function readExtensibility(db: string): ItemTableRead {
  const viaCli = extensibilityViaCli(db);
  if (viaCli.ok) return viaCli;
  return extensibilityViaNodeSqlite(db);
}

export function probeCursorEdges(env: NodeJS.ProcessEnv = process.env): CursorEdgesProbe {
  const home = homeDir(env);
  const stateDbPath = cursorStateDb(env);
  const cursorDir = path.join(home, '.cursor');
  const dbExists = fs.existsSync(stateDbPath);
  const cursorPresent = dbExists || fs.existsSync(cursorDir);
  if (!cursorPresent) return { ...ABSENT };

  const localInstallPath = path.join(home, '.cursor', 'plugins', 'local', 'traffic-one');
  const claudeCachePath = path.join(home, '.claude', 'plugins', 'cache', 'traffic-one', 'traffic-one');

  let stateDbReadable = false;
  let thirdPartyExtensibilityEnabled: true | false | null = null;
  if (dbExists) {
    const read = readExtensibility(stateDbPath);
    if (read.ok) {
      stateDbReadable = true;
      thirdPartyExtensibilityEnabled = interpretFlag(read.value);
    }
  }

  return {
    cursorPresent: true,
    stateDbPath,
    stateDbReadable,
    thirdPartyExtensibilityEnabled,
    localInstallPresent: fs.existsSync(localInstallPath),
    localInstallPath,
    claudeCachePresent: fs.existsSync(claudeCachePath),
    claudeCachePath,
  };
}
