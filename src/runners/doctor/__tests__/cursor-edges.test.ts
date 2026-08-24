// src/runners/doctor/__tests__/cursor-edges.test.ts
// Fixture HOME under /.tmp/doctor-cursor-edges/ — never the real ~/.cursor.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { NODE_FLOOR_MAJOR } from '../../../shared/node-floor';
import { cursorStateDb } from '../../../shared/host/plan';
import { probeCursorEdges } from '../cursor-edges';
import { buildFindings } from '../findings';
import type { CursorEdgesProbe, GitnexusProbe, NodeProbe, NvmProbe, ProjectProbe } from '../probes';

const SCRATCH = path.join(process.cwd(), '.tmp', 'doctor-cursor-edges');
const hasSqlite3 = (() => { try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; } })();
const hasNodeSqlite = (() => { try { require('node:sqlite'); return true; } catch { return false; } })();
const canWriteSqliteFixture = hasSqlite3 || hasNodeSqlite;

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home };
}

function fixtureHome(): string {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, 'home-'));
}

after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function writeCursorItemTable(db: string, rows: ReadonlyArray<{ key: string; value: string }>): boolean {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  try {
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (f: string) => {
        exec(s: string): void;
        prepare(s: string): { run(...a: unknown[]): unknown };
        close(): void;
      };
    };
    const h = new sqlite.DatabaseSync(db);
    h.exec('CREATE TABLE IF NOT EXISTS ItemTable(key TEXT PRIMARY KEY, value BLOB)');
    for (const row of rows) {
      h.prepare('INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)').run(row.key, row.value);
    }
    h.close();
    return true;
  } catch { /* fall through to CLI */ }
  try {
    const inserts = rows.map((row) => {
      const key = row.key.replace(/'/g, "''");
      const value = row.value.replace(/'/g, "''");
      return `INSERT INTO ItemTable VALUES('${key}','${value}');`;
    }).join(' ');
    return spawnSync('sqlite3', [db, `CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB); ${inserts}`]).status === 0;
  } catch {
    return false;
  }
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function localInstall(home: string): string {
  return path.join(home, '.cursor', 'plugins', 'local', 'traffic-one');
}

function claudeCache(home: string): string {
  return path.join(home, '.claude', 'plugins', 'cache', 'traffic-one', 'traffic-one');
}

function node(): NodeProbe {
  return { runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node', requiredMajor: 22, pluginRequiredMajor: NODE_FLOOR_MAJOR };
}
function nvm(): NvmProbe {
  return { installed: false };
}
function gn(): GitnexusProbe {
  return { onPath: null, absoluteV22: null, crashRiskInOldNvm: false };
}
function project(): ProjectProbe {
  return {
    cwd: '/repo', hasState: false, state: null, localPreferences: {}, localPreferencesPath: null,
    hasLocalPreferences: false, normalizedState: null, nvmrc: null, hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
    runState: {
      currentRunId: null, runDirExists: false, runJsonExists: false, runJsonStatus: null,
      hasOrchestratedArtifacts: false, maintenanceJsonExists: false, maintenanceOutcome: null,
      maintenanceOverallOutcome: null, maintenanceOpencodeOutcome: null,
      maintenanceFallbackAllowed: false, maintenanceTerminalOrFallbackPending: false,
    },
    nestedTrafficOneRoots: [],
    openCodeCli: 'managed',
    legacyCapabilityMigration: { status: 'not-applicable', message: null },
  };
}

function findingsFor(probe: CursorEdgesProbe): string[] {
  return buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: project(), cursorEdges: probe })
    .map((f) => f.code);
}

function probeHome(home: string): CursorEdgesProbe {
  return probeCursorEdges(isolatedEnv(home));
}

test('probeCursorEdges: no Cursor markers → absent probe and no findings', () => {
  const home = fixtureHome();
  const probe = probeHome(home);
  assert.deepEqual(probe, {
    cursorPresent: false,
    stateDbPath: null,
    stateDbReadable: false,
    thirdPartyExtensibilityEnabled: null,
    localInstallPresent: false,
    localInstallPath: null,
    claudeCachePresent: false,
    claudeCachePath: null,
  });
  const codes = findingsFor(probe);
  assert.ok(!codes.includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
  assert.ok(!codes.includes('CURSOR_LOCAL_AND_IMPORTED'));
});

test('probeCursorEdges: Claude cache without Cursor markers is still absent', () => {
  const home = fixtureHome();
  mkdirp(claudeCache(home));
  const probe = probeHome(home);
  assert.equal(probe.cursorPresent, false);
  assert.equal(probe.claudeCachePresent, false);
  assert.ok(!findingsFor(probe).includes('CURSOR_LOCAL_AND_IMPORTED'));
});

test('probeCursorEdges: Local only (no Claude cache) is valid — no CURSOR_LOCAL_AND_IMPORTED', () => {
  const home = fixtureHome();
  mkdirp(localInstall(home));
  const probe = probeHome(home);
  assert.equal(probe.cursorPresent, true);
  assert.equal(probe.localInstallPresent, true);
  assert.equal(probe.claudeCachePresent, false);
  assert.ok(!findingsFor(probe).includes('CURSOR_LOCAL_AND_IMPORTED'));
  assert.ok(!findingsFor(probe).includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
});

test('probeCursorEdges: imported Claude cache only (Cursor present, no Local) is healthy', () => {
  const home = fixtureHome();
  mkdirp(path.join(home, '.cursor'));
  mkdirp(claudeCache(home));
  const probe = probeHome(home);
  assert.equal(probe.cursorPresent, true);
  assert.equal(probe.localInstallPresent, false);
  assert.equal(probe.claudeCachePresent, true);
  assert.ok(!findingsFor(probe).includes('CURSOR_LOCAL_AND_IMPORTED'));
});

test('probeCursorEdges: Local + Claude cache → CURSOR_LOCAL_AND_IMPORTED', () => {
  const home = fixtureHome();
  mkdirp(localInstall(home));
  mkdirp(claudeCache(home));
  const probe = probeHome(home);
  assert.equal(probe.localInstallPresent, true);
  assert.equal(probe.claudeCachePresent, true);
  assert.ok(findingsFor(probe).includes('CURSOR_LOCAL_AND_IMPORTED'));
  assert.ok(!findingsFor(probe).includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
});

test('probeCursorEdges: unreadable state.vscdb does not invent an extensibility finding', () => {
  const home = fixtureHome();
  const db = cursorStateDb(isolatedEnv(home));
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, 'not-a-sqlite-database', 'utf8');
  const probe = probeHome(home);
  assert.equal(probe.cursorPresent, true);
  assert.equal(probe.stateDbReadable, false);
  assert.equal(probe.thirdPartyExtensibilityEnabled, null);
  assert.ok(!findingsFor(probe).includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
});

test('probeCursorEdges: thirdPartyExtensibilityEnabled=true → no extensibility finding', {
  skip: !canWriteSqliteFixture,
}, () => {
  const home = fixtureHome();
  const db = cursorStateDb(isolatedEnv(home));
  assert.ok(writeCursorItemTable(db, [{ key: 'thirdPartyExtensibilityEnabled', value: 'true' }]), 'could not create fixture state.vscdb');
  const probe = probeHome(home);
  assert.equal(probe.stateDbReadable, true);
  assert.equal(probe.thirdPartyExtensibilityEnabled, true);
  assert.ok(!findingsFor(probe).includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
});

test('probeCursorEdges: thirdPartyExtensibilityEnabled=false → CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF', {
  skip: !canWriteSqliteFixture,
}, () => {
  const home = fixtureHome();
  const db = cursorStateDb(isolatedEnv(home));
  assert.ok(writeCursorItemTable(db, [{ key: 'thirdPartyExtensibilityEnabled', value: 'false' }]), 'could not create fixture state.vscdb');
  const probe = probeHome(home);
  assert.equal(probe.stateDbReadable, true);
  assert.equal(probe.thirdPartyExtensibilityEnabled, false);
  assert.ok(findingsFor(probe).includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
});

test('probeCursorEdges: readable db with key missing → CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF', {
  skip: !canWriteSqliteFixture,
}, () => {
  const home = fixtureHome();
  const db = cursorStateDb(isolatedEnv(home));
  assert.ok(writeCursorItemTable(db, []), 'could not create fixture state.vscdb');
  const probe = probeHome(home);
  assert.equal(probe.stateDbReadable, true);
  assert.equal(probe.thirdPartyExtensibilityEnabled, null);
  assert.ok(findingsFor(probe).includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
});

test('probeCursorEdges: both silent-break edges at once → both findings', {
  skip: !canWriteSqliteFixture,
}, () => {
  const home = fixtureHome();
  const db = cursorStateDb(isolatedEnv(home));
  assert.ok(writeCursorItemTable(db, []), 'could not create fixture state.vscdb');
  mkdirp(localInstall(home));
  mkdirp(path.join(claudeCache(home), '1.2.3'));
  const probe = probeHome(home);
  const codes = findingsFor(probe);
  assert.ok(codes.includes('CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF'));
  assert.ok(codes.includes('CURSOR_LOCAL_AND_IMPORTED'));
});
