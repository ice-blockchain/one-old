// src/shared/state/__tests__/claims-cas-race.test.ts
// The pending claim's compare-and-swap, asserted by a real race.
//
// `pending/<role>.json` created with O_CREAT|O_EXCL is the only thing that keeps
// a run to one unconsumed spawn handoff per role. It replaced
// `pending/<claimId>.json`, where every writer minted a fresh random id, so no
// two writers ever addressed the same path and an exclusive create there could
// not have failed — rebind-journal-io.ts called that pair "the pending-claim
// CAS", but a compare-and-swap on a name nobody else writes compares nothing.
//
// Sequential calls cannot assert this. They pass identically against an
// implementation whose exclusion comes only from the claims lock, and against one
// with no exclusion at all. So the contenders here are separate PROCESSES,
// released from a barrier together.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { activeRunClaimCount } from '../../run-settlement';
import { ensureRunLedger } from '../run-agent';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const CHILD = path.join(__dirname, 'claims-cas-race-child.ts');
const RUN_ID = 'run-cas-race';
const ROLE = 'senior-backend';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function pendingDir(cwd: string): string {
  return path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'pending');
}

function project(): string {
  const dir = tempDir('t1-cas-race-');
  fs.mkdirSync(pendingDir(dir), { recursive: true });
  return dir;
}

function pendingFiles(cwd: string): string[] {
  return fs.readdirSync(pendingDir(cwd)).filter((name) => name.endsWith('.json')).sort();
}

interface Contended {
  readonly outcome?: string;
  readonly reason?: string;
  readonly claimId?: string | null;
  readonly spawnIndex?: number | null;
  readonly create?: string;
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Start one contender per session id, release them together, return what each
 * one reported. The children are spawned under the suite's own preload so they
 * resolve the same plugin root and consent fence as their parent. */
async function race(mode: 'mint' | 'create', cwd: string, sessionIds: string[]): Promise<Contended[]> {
  const barrier = tempDir('t1-cas-barrier-');
  const children = sessionIds.map((sessionId) => spawn(
    process.execPath,
    [
      '--import', pathToFileURL(PRELOAD).href,
      '--import', 'tsx',
      CHILD,
      JSON.stringify({ mode, cwd, runId: RUN_ID, role: ROLE, sessionId, barrier }),
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  ));
  const reported = children.map((child, index) => new Promise<Contended>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`contender ${index} exited ${code}: ${err || '(no stderr)'}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()) as Contended);
      } catch {
        reject(new Error(`contender ${index} printed no verdict: ${out}${err}`));
      }
    });
  }));
  const readyBy = Date.now() + 60_000;
  while (!sessionIds.every((id) => fs.existsSync(path.join(barrier, `${id}.ready`)))) {
    assert.ok(Date.now() < readyBy, 'contenders never finished loading');
    await settle(20);
  }
  fs.writeFileSync(path.join(barrier, 'go'), '');
  return Promise.all(reported);
}

// The end-to-end property: the mint is the only door to a pending claim, and two
// SubagentStart hooks for one role arriving together must leave ONE handoff. The
// loser is told `precondition-failed`, deliberately not `unavailable` — its rival
// has already put this role's claim on disk and the child this spawn starts binds
// to THAT claim, so there is nothing to retry and nothing to deny.
test('two forked minters racing for one role: exactly one wins, the loser is told someone else holds it', async () => {
  const cwd = project();
  ensureRunLedger(cwd, RUN_ID, { status: 'active', kind: 'cas-race' });

  const results = await race('mint', cwd, ['parent-a', 'parent-b']);
  const detail = JSON.stringify(results);

  assert.deepEqual(results.map((r) => r.outcome).sort(), ['applied', 'precondition-failed'],
    `exactly one minter may win the role slot: ${detail}`);
  const winner = results.find((r) => r.outcome === 'applied');
  const loser = results.find((r) => r.outcome !== 'applied');
  assert.equal(loser?.reason, 'role-pending-claim-held',
    `the loser must read EEXIST as "someone else won", not as a failure to retry: ${detail}`);

  assert.deepEqual(pendingFiles(cwd), [`${ROLE}.json`],
    'one role, one pending file — the filename IS the mutual exclusion');
  const onDisk = JSON.parse(fs.readFileSync(path.join(pendingDir(cwd), `${ROLE}.json`), 'utf8')) as { claimId?: string };
  assert.equal(onDisk.claimId, winner?.claimId,
    'the surviving claim is the winner\'s, so the child that binds gets a claim its parent knows about');

  // The harm the CAS exists to prevent, measured at the place that suffers it:
  // activeRunClaimCount is a terminal-settlement veto (run-settle.ts returns null
  // while it is positive). Two pending claims for one role means two live agents
  // by this count and a run that cannot settle until both expire.
  assert.equal(activeRunClaimCount(cwd, RUN_ID), 1,
    'a raced role must not leave two active claims vetoing settlement');
});

// The same race one layer down, with no lock anywhere near it: whatever the lock
// does or fails to do, the exclusive create admits exactly one writer and tells
// the other the slot is taken.
test('the exclusive create arbitrates the role slot directly: one create, one EEXIST', async () => {
  const cwd = project();

  const results = await race('create', cwd, ['writer-a', 'writer-b']);
  assert.deepEqual(results.map((r) => r.create).sort(), ['created', 'exists'],
    `O_EXCL must admit one writer and report EEXIST to the other: ${JSON.stringify(results)}`);
  assert.deepEqual(pendingFiles(cwd), [`${ROLE}.json`]);
  const onDisk = JSON.parse(fs.readFileSync(path.join(pendingDir(cwd), `${ROLE}.json`), 'utf8')) as { sessionId?: string };
  assert.ok(onDisk.sessionId === 'writer-a' || onDisk.sessionId === 'writer-b');
  // The loser did not overwrite the winner on its way out.
  assert.equal(fs.readFileSync(path.join(pendingDir(cwd), `${ROLE}.json`), 'utf8').match(/writer-/g)?.length, 1);
});
