// src/shared/state/__tests__/identity-drift-race.test.ts
// Two hosts starting a session on one project at the same moment, against the
// most destructive repair in the codebase.
//
// `reconcileRunIdentityDrift` runs on EVERY SessionStart (session-start.ts), and
// once it decides a project holds two live runs it RELEASES every loser's claims
// and transitions the loser's ledger to failed/agent-failed
// (identity-drift.ts:166-176). Two hosts opening a session on one project is an
// ordinary shape, not an exotic one, and nothing serializes the pass: the scan,
// the evidence scoring and the election all happen outside any lock, and only the
// `currentRunId` re-point is taken under the cross-process project-state lock.
//
// WHAT ONLY CONCURRENCY CAN REACH. Sequentially, the second pass never sees the
// condition at all — the first has already released the losers, so
// `live.length < 2` makes it a no-op (identity-drift.ts:131). So the sequential
// tests (run-agent.test.ts's election, minted-over-refused-write.test.ts's
// re-point precondition) can only ever exercise ONE elector. The property this
// file adds is that TWO electors, scoring the same run set at the same instant,
// must reach the SAME verdict: the election has to be a deterministic function of
// what is on disk, because each host acts on its own answer destructively and
// nothing reconciles two different ones afterwards. If they disagree, each fails
// the other's survivor and the project loses BOTH runs and every claim in them.
//
// The fixture therefore gives the two runs EQUAL evidence scores, so the verdict
// rests entirely on the tie-break (`b.val - a.val`, newest wins). That is the
// part of the election with no evidence behind it and the part a future change is
// most likely to make situational — and a tie-break that is not a pure function
// of the id is invisible to every sequential test, which sees only one elector
// and is content with either answer. Mutation-proven below.

import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { effectiveLegacyRunStatus } from '../../run-settlement';
import { ensureRunLedger } from '../run-agent';
import { runAgentFile, runsRoot } from '../run-agent/run-paths';
import { statePath } from '../normalize';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const CHILD = path.join(__dirname, 'identity-drift-race-child.ts');

/** The four artefacts runEvidenceScore reads. Both runs must have NONE of them,
 * or the scores differ and the tie-break stops being what decides. */
const EVIDENCE_ARTEFACTS = ['assignments.json', 'architecture-v1.json', 'bootstrap', 'verification-v2.json'];

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const STRICT_ENV = 'T1_DRIFT_RACE_STRICT';

/** A race that did not race is not evidence, in either direction. Same
 * three-valued treatment as src/test-support/__tests__/latency-budget.ts, and the
 * same mandatory `T1_` prefix: src/build/test-preload.mjs wipes the whole
 * `TRAFFIC_ONE_` namespace bar three allowlisted names. */
function inconclusive(t: TestContext, reason: string): void {
  if (process.env[STRICT_ENV] === '1') {
    throw new Error(`identity-drift race: INCONCLUSIVE under ${STRICT_ENV}=1 — ${reason}`);
  }
  process.stderr.write(
    `\nTRAFFIC ONE · IDENTITY-DRIFT RACE INCONCLUSIVE\n  ${reason}\n`
    + `  THE ELECTION WAS NOT CHECKED UNDER CONTENTION ON THIS RUN. Set ${STRICT_ENV}=1 to make it RED.\n\n`,
  );
  t.diagnostic(`IDENTITY-DRIFT RACE INCONCLUSIVE · ${reason}`);
  t.skip(`INCONCLUSIVE (contention not established) · ${reason}`);
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

interface Fixture {
  readonly cwd: string;
  /** Newest id: the survivor the tie-break must elect, in every host. */
  readonly newer: string;
  readonly older: string;
}

/**
 * Two non-terminal runs, each holding one CLAIMED agent, with no orchestration
 * evidence on either side. `activeRunClaimCount` is positive for both, so both
 * enrol as drift candidates and `live.length < 2` does not short-circuit.
 */
function project(): Fixture {
  const cwd = tempDir('t1-drift-race-');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  const now = Date.now();
  const newer = String(now - 1_000);
  const older = String(now - 2_000);
  assert.match(newer, /^\d{13}$/, 'fixture guard: identity-drift only considers 13-digit run dirs');
  assert.match(older, /^\d{13}$/, 'fixture guard: identity-drift only considers 13-digit run dirs');

  for (const runId of [newer, older]) {
    assert.ok(ensureRunLedger(cwd, runId, { status: 'active', kind: 'agent-claim' }),
      'fixture guard: both ledgers are on disk and non-terminal');
    const claimed = runAgentFile(cwd, runId, `child-${runId}`);
    fs.mkdirSync(path.dirname(claimed), { recursive: true });
    fs.writeFileSync(claimed, JSON.stringify({
      version: 1,
      runId,
      claimId: `senior-frontend-1-${runId}`,
      role: 'senior-frontend',
      spawnIndex: 1,
      status: 'claimed',
      createdAt: new Date().toISOString(),
      sessionId: `child-${runId}`,
    }), 'utf8');
  }

  // The drifted pointer both hosts start from.
  fs.writeFileSync(statePath(cwd), JSON.stringify({
    mode: 'new-project', stack: 'minimal', frontend: 'react-vite', backend: 'none', currentRunId: older,
  }), 'utf8');

  for (const runId of [newer, older]) {
    for (const artefact of EVIDENCE_ARTEFACTS) {
      assert.equal(fs.existsSync(path.join(runsRoot(cwd), runId, artefact)), false,
        `fixture guard: neither run may carry ${artefact}, or the evidence score decides instead of the tie-break`);
    }
  }
  return { cwd, newer, older };
}

interface HostVerdict {
  readonly sessionId: string;
  readonly changed: boolean | null;
  readonly threw: string | null;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly observedClaims: Record<string, number>;
  readonly currentRunIdAfter: unknown;
}

/** Start one host per session id, release them from a barrier together, and
 * return what each reported. */
async function race(fixture: Fixture, sessionIds: readonly string[]): Promise<HostVerdict[]> {
  const barrier = tempDir('t1-drift-barrier-');
  const children = sessionIds.map((sessionId) => spawn(
    process.execPath,
    [
      '--import', pathToFileURL(PRELOAD).href,
      '--import', 'tsx',
      CHILD,
      JSON.stringify({
        cwd: fixture.cwd,
        barrier,
        sessionId,
        pointsAt: fixture.older,
        runIds: [fixture.newer, fixture.older],
      }),
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  ));
  const reported = children.map((child, index) => new Promise<HostVerdict>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`host ${index} exited ${code}: ${err || '(no stderr)'}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()) as HostVerdict);
      } catch {
        reject(new Error(`host ${index} printed no verdict: ${out}${err}`));
      }
    });
  }));
  const readyBy = Date.now() + 60_000;
  while (!sessionIds.every((id) => fs.existsSync(path.join(barrier, `${id}.ready`)))) {
    assert.ok(Date.now() < readyBy, 'hosts never finished loading');
    await settle(20);
  }
  fs.writeFileSync(path.join(barrier, 'go'), '');
  return Promise.all(reported);
}

function ledgerStatus(cwd: string, runId: string): string {
  const raw = JSON.parse(
    fs.readFileSync(path.join(runsRoot(cwd), runId, 'run.json'), 'utf8'),
  ) as Record<string, unknown>;
  return String(effectiveLegacyRunStatus(raw));
}

function claimStatus(cwd: string, runId: string): string {
  const raw = JSON.parse(
    fs.readFileSync(runAgentFile(cwd, runId, `child-${runId}`), 'utf8'),
  ) as Record<string, unknown>;
  return String(raw.status);
}

test('two hosts reconciling identity drift at once elect the same survivor and settle only the loser', async (t) => {
  const fixture = project();
  const hosts = await race(fixture, ['host-a', 'host-b']);
  const detail = JSON.stringify(hosts);

  for (const host of hosts) {
    assert.equal(host.threw, null, `a best-effort repair must not throw out of SessionStart: ${detail}`);
  }

  // CONTENTION, established before anything is concluded from the outcome. Two
  // things have to be true: the passes overlapped in wall-clock time, and both
  // hosts genuinely saw the plurality that arms the destructive branch. Either
  // one missing means this run measured two sequential passes.
  const overlapMs = Math.min(...hosts.map((h) => h.finishedAt))
    - Math.max(...hosts.map((h) => h.startedAt));
  const bothSawPlurality = hosts.every((host) => [fixture.newer, fixture.older]
    .every((runId) => (host.observedClaims[runId] ?? 0) > 0));
  t.diagnostic(`overlap ${overlapMs} ms; observed claims ${JSON.stringify(hosts.map((h) => h.observedClaims))}`);
  if (overlapMs < 0 || !bothSawPlurality) {
    inconclusive(t, `the two passes did not contend (overlap ${overlapMs} ms, `
      + `both saw a plurality: ${bothSawPlurality}): ${detail}`);
    return;
  }

  // THE PROPERTY. Both hosts elected the newest run, so exactly one run is left
  // standing and it is the same one for everybody.
  for (const host of hosts) {
    assert.equal(host.currentRunIdAfter, fixture.newer,
      `every host must come out of the repair pointing at the same survivor, or each one spends the rest of `
      + `its session driving a run the others just failed: ${detail}`);
  }
  assert.equal(
    JSON.parse(fs.readFileSync(statePath(fixture.cwd), 'utf8')).currentRunId,
    fixture.newer,
    `.one.json must name the survivor once the dust settles: ${detail}`,
  );

  assert.equal(ledgerStatus(fixture.cwd, fixture.newer), 'active',
    `the survivor's ledger must still be drivable — a concurrent pass that elected the other run would have `
    + `failed this one: ${detail}`);
  assert.equal(claimStatus(fixture.cwd, fixture.newer), 'claimed',
    `the survivor's live agent must keep its claim: releasing it orphans a working child: ${detail}`);

  assert.equal(ledgerStatus(fixture.cwd, fixture.older), 'failed',
    `the loser must be settled exactly once and stay settled: ${detail}`);
  assert.equal(claimStatus(fixture.cwd, fixture.older), 'released',
    `and the loser's claims released, which is what licenses failing it: ${detail}`);
});
