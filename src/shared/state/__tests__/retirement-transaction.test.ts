// src/shared/state/__tests__/retirement-transaction.test.ts
// Retirement as ONE transaction, and the `claim-superseded` verdict that keeps
// it from producing two writers.
//
// `replaced = true` used to be the whole of retirement. Everything else the
// retired agent held outlived its row on a different clock: its identity claim
// resolved (and carried write authority) for SUBAGENT_STALE_MS, its per-file
// fallback locks blocked every other writer for the same 30 minutes, and its
// unconsumed spawn handoff kept reporting a live agent for the role — while the
// row itself dies at CURSOR_RESUME_ID_HARD_MS, 270 seconds. Two failures follow
// from that gap, in opposite directions: the replacement is locked out of every
// file the ghost touched, and the ghost keeps write authority the replacement
// now also has.
//
// Every test here is written so that reverting ONE line of the fix fails it. The
// tests that matter most, though, are the ones that must KEEP passing: a
// released claim whose role nobody else took, and a claim that is itself the
// role's owner, both still resolve. A reject reason that fires on `released`
// alone would deadlock exactly those children, and denying an in-scope write to
// a correctly-claimed child is the failure this whole area exists to remove.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  claimThreadRole,
  ensureRunLedger,
  explainUnresolvedRunAgent,
  hasActiveRunClaims,
  markRunAgentReplaced,
  markRunAgentReplacedIfMatches,
  markRunAgentReplacedIfMatchesResult,
  releaseRunClaims,
  resolveRunAgentContext,
  runRoleHasBoundClaim,
  tryFallbackClaim,
} from '../run-agent';
import { claimRejectReason } from '../run-agent/claims-pending';
import { stackFingerprint } from '../materialization';

const ROLE = 'senior-frontend';
// A rollout-shaped thread id, because one test drives the pending-correlation
// path and the child's key there is the thread id parsed out of transcript_path.
const GHOST = '019e7390-ca45-7e03-84d3-284bda1ba905';
const GHOST_TRANSCRIPT = `/tmp/t1-retire-tx/rollout-2026-05-29T14-48-49-${GHOST}.jsonl`;
const HEIR = 'heir-thread-0002';
const PARENT = 'orchestrator-session';

function project(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1-retire-tx-${name}-`));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  return dir;
}

function withProject<T>(name: string, fn: (dir: string) => T): T {
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const dir = project(name);
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function materializedState(runId: string): Record<string, unknown> {
  const base = {
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { framework: 'none' },
  };
  return { ...base, materializedStack: stackFingerprint(base), currentRunId: runId };
}

function runDir(dir: string, runId: string): string {
  return path.join(dir, '.traffic-one', 'runs', runId);
}

function readJsonFile(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** The registry row, written directly so `recordedAt` is controllable: the
 * pending-handoff rule below is a comparison against it, and a row recorded
 * "now" cannot express a handoff minted after it without a future timestamp. */
function writeRegistryRow(
  dir: string,
  runId: string,
  role: string,
  entry: Record<string, unknown>,
): void {
  fs.mkdirSync(runDir(dir, runId), { recursive: true });
  const file = path.join(runDir(dir, runId), 'agents.json');
  const existing = fs.existsSync(file) ? readJsonFile(file) : { version: 1, agents: {} };
  const agents = (existing.agents || {}) as Record<string, unknown>;
  agents[role] = { role, tasks: 1, replaced: false, ...entry };
  fs.writeFileSync(file, JSON.stringify({ ...existing, version: 1, agents }, null, 2));
}

function writePendingClaim(
  dir: string,
  runId: string,
  role: string,
  claim: Record<string, unknown>,
): string {
  const pending = path.join(runDir(dir, runId), 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const file = path.join(pending, `${role}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    runId,
    role,
    spawnIndex: 1,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...claim,
  }, null, 2));
  return file;
}

/** A bound ghost: claim file, registry row, and one per-file fallback lock. */
function seedGhost(dir: string, runId: string, options: { recordedAt?: string } = {}): void {
  const state = materializedState(runId);
  ensureRunLedger(dir, runId, { status: 'active', kind: 'test' });
  const ctx = claimThreadRole(dir, state, GHOST, ROLE, {
    parentSessionId: PARENT,
    model: 'composer-2.5-fast',
    recordAgent: false,
  });
  assert.ok(ctx, 'the ghost binds before it is retired');
  writeRegistryRow(dir, runId, ROLE, {
    agentId: GHOST,
    resumeId: GHOST,
    parentSessionId: PARENT,
    model: 'composer-2.5-fast',
    recordedAt: options.recordedAt || new Date(Date.now() - 10_000).toISOString(),
  });
  const locked = tryFallbackClaim(dir, ctx!, 'src/app.tsx');
  assert.equal(locked.blocked, false, 'the ghost takes the file lock it is later expected to give up');
}

function heirContext(runId: string): {
  source: string;
  runId: string;
  role: string;
  spawnIndex: number;
  sessionId: string;
  claimId: string;
} {
  return {
    source: 'test',
    runId,
    role: ROLE,
    spawnIndex: 2,
    sessionId: HEIR,
    claimId: `${ROLE}-2-heir`,
  };
}

test('retirement hands the retired agent\'s file locks to the replacement instead of holding them for 30 minutes', () => {
  withProject('fallback', (dir) => {
    const runId = '1790000000001';
    seedGhost(dir, runId);

    // BASELINE first: without it a fixture that stopped writing the lock would
    // make the assertion after retirement pass while measuring nothing.
    assert.deepEqual(tryFallbackClaim(dir, heirContext(runId), 'src/app.tsx'), { blocked: true, holder: GHOST },
      'before retirement the ghost lock is real and blocks the replacement');

    markRunAgentReplaced(dir, runId, ROLE);

    assert.equal(tryFallbackClaim(dir, heirContext(runId), 'src/app.tsx').blocked, false,
      'retirement releases the retired holder\'s per-file locks in the same transaction as the row');
    assert.equal(
      readJsonFile(path.join(runDir(dir, runId), 'claims', 'src_app.tsx.json')).holder,
      HEIR,
      'the freed lock is taken by the replacement, not merely deleted',
    );
  });
});

test('retirement drops the retired spawn\'s pending handoff and never the replacement\'s', () => {
  withProject('pending-mine', (dir) => {
    const runId = '1790000000002';
    const recordedAt = new Date(Date.now() - 10_000).toISOString();
    seedGhost(dir, runId, { recordedAt });
    const handoff = writePendingClaim(dir, runId, ROLE, {
      claimId: `${ROLE}-1-retired-spawn`,
      parentSessionId: PARENT,
      createdAt: new Date(Date.now() - 20_000).toISOString(),
    });
    assert.equal(runRoleHasBoundClaim(dir, runId, ROLE), true, 'the handoff reports a live agent for the role');

    markRunAgentReplaced(dir, runId, ROLE);

    assert.equal(fs.existsSync(handoff), false,
      'the handoff of the spawn that produced the retired row goes with it');
  });

  withProject('pending-heirs', (dir) => {
    const runId = '1790000000003';
    const recordedAt = new Date(Date.now() - 10_000).toISOString();
    seedGhost(dir, runId, { recordedAt });
    // Minted AFTER the retired row was recorded: this is the replacement's
    // handoff, and dropping it is the strictly worse bug — a child that binds no
    // role at all.
    const heirHandoff = writePendingClaim(dir, runId, ROLE, {
      claimId: `${ROLE}-2-replacement-spawn`,
      parentSessionId: PARENT,
      createdAt: new Date().toISOString(),
    });

    markRunAgentReplaced(dir, runId, ROLE);

    assert.equal(fs.existsSync(heirHandoff), true,
      'a handoff minted after the retired row was recorded belongs to the replacement');
    assert.equal(readJsonFile(heirHandoff).claimId, `${ROLE}-2-replacement-spawn`);
  });

  withProject('pending-foreign-parent', (dir) => {
    const runId = '1790000000004';
    seedGhost(dir, runId);
    const foreign = writePendingClaim(dir, runId, ROLE, {
      claimId: `${ROLE}-1-other-parent`,
      parentSessionId: 'a-different-orchestrator',
      createdAt: new Date(Date.now() - 20_000).toISOString(),
    });

    markRunAgentReplaced(dir, runId, ROLE);

    assert.equal(fs.existsSync(foreign), true,
      'another parent\'s handoff for the role is not this row\'s to drop');
  });
});

test('retirement releases only the retired identity, never everything holding the role', () => {
  withProject('keying', (dir) => {
    const runId = '1790000000005';
    const state = materializedState(runId);
    seedGhost(dir, runId);

    // The live replacement: its own claim, its own file lock, and — the case
    // that makes role-keying fatal — a fallback lock whose holder IS the role
    // string, which tryFallbackClaim writes for any agent with neither session
    // nor claim id.
    const heir = claimThreadRole(dir, state, HEIR, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
    });
    assert.ok(heir, 'the replacement binds while the ghost row is still live');
    assert.equal(tryFallbackClaim(dir, heir!, 'src/heir.tsx').blocked, false);
    const anonymous = { source: 'test', runId, role: ROLE, spawnIndex: 3, sessionId: null, claimId: null };
    assert.equal(tryFallbackClaim(dir, anonymous, 'src/anon.tsx').blocked, false);
    assert.equal(readJsonFile(path.join(runDir(dir, runId), 'claims', 'src_anon.tsx.json')).holder, ROLE,
      'an agent with no ids holds its locks under the ROLE — the key retirement must never release by');

    markRunAgentReplaced(dir, runId, ROLE);

    assert.equal(fs.existsSync(path.join(runDir(dir, runId), 'claims', 'src_heir.tsx.json')), true,
      'the live replacement keeps the locks it holds');
    assert.equal(fs.existsSync(path.join(runDir(dir, runId), 'claims', 'src_anon.tsx.json')), true,
      'a role-keyed lock is never released by a retirement keyed to one agent');
    assert.equal(readJsonFile(path.join(runDir(dir, runId), `${HEIR}.json`)).status, 'claimed',
      'the replacement\'s own claim is untouched');
  });
});

test('a retired agent stops resolving identity once another agent owns its role', () => {
  withProject('superseded', (dir) => {
    const runId = '1790000000006';
    const state = materializedState(runId);
    seedGhost(dir, runId);
    const ghostWrite = { session_id: GHOST, agent_id: GHOST, is_subagent: true };

    assert.equal(resolveRunAgentContext(dir, state, ghostWrite, { claimPending: false })?.role, ROLE,
      'before anyone replaces it the ghost resolves its role');

    markRunAgentReplaced(dir, runId, ROLE);
    assert.equal(resolveRunAgentContext(dir, state, ghostWrite, { claimPending: false })?.role, ROLE,
      'retirement alone does NOT strip identity: with no successor this agent is the only one that has the role');

    assert.ok(claimThreadRole(dir, state, HEIR, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
      refuseOccupiedRole: true,
    }), 'the replacement binds');

    const ghostClaim = readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`));
    assert.equal(claimRejectReason(dir, state, ghostClaim), 'claim-superseded',
      'a released claim whose role another live agent holds no longer resolves');
    assert.equal(resolveRunAgentContext(dir, state, ghostWrite, { claimPending: false }), null,
      'two agents cannot both hold write authority for one role');
    assert.equal(resolveRunAgentContext(dir, state, { session_id: HEIR, agent_id: HEIR, is_subagent: true }, {
      claimPending: false,
    })?.role, ROLE, 'the live replacement still resolves');
  });
});

test('a superseded thread cannot bind its way back onto the role it lost', () => {
  withProject('no-steal', (dir) => {
    const runId = '1790000000007';
    const state = materializedState(runId);
    seedGhost(dir, runId);
    markRunAgentReplaced(dir, runId, ROLE);
    assert.ok(claimThreadRole(dir, state, HEIR, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
      refuseOccupiedRole: true,
    }));

    assert.equal(claimThreadRole(dir, state, GHOST, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
    }), null, 'the superseded thread is refused a fresh bind');
    assert.equal(readJsonFile(path.join(runDir(dir, runId), `${HEIR}.json`)).status, 'claimed',
      'and the replacement it would have superseded still holds the role');

    // The correlation path is the other door onto a role: an unconsumed handoff
    // this thread's immutable parent facts match uniquely. It binds under the
    // transcript's thread id, which is why the ghost is rollout-shaped here.
    writePendingClaim(dir, runId, ROLE, {
      claimId: `${ROLE}-3-late`,
      parentSessionId: PARENT,
      createdAt: new Date().toISOString(),
    });
    const correlated = resolveRunAgentContext(dir, state, {
      session_id: PARENT,
      transcript_path: GHOST_TRANSCRIPT,
    }, { claimPending: true });
    assert.equal(correlated, null,
      'the superseded thread cannot correlate itself onto the role either');
    assert.equal(readJsonFile(path.join(runDir(dir, runId), `${HEIR}.json`)).status, 'claimed');
    assert.equal(readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`)).status, 'released',
      'and its own claim was not rewritten as a fresh bind');
  });
});

test('a released claim keeps resolving when nobody took its role', () => {
  withProject('no-successor', (dir) => {
    const runId = '1790000000008';
    const state = materializedState(runId);
    seedGhost(dir, runId);

    // The terminal sweep of a settled run: every claim released, the registry
    // row untouched and still live. claims-store.ts states the property this
    // asserts — released claims keep resolving identity, which corrects liveness
    // accounting and never resolution.
    assert.ok(releaseRunClaims(dir, runId, 'settled') >= 1);
    const claim = readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`));
    assert.equal(claim.status, 'released');
    assert.equal(claimRejectReason(dir, state, claim), null,
      'a settled run\'s released claim still names its agent');
    assert.equal(resolveRunAgentContext(dir, state, { session_id: GHOST, agent_id: GHOST, is_subagent: true }, {
      claimPending: false,
    })?.role, ROLE);
  });
});

test('a released claim keeps resolving when the live registry row names ids no claim carries', () => {
  withProject('unupgraded-row', (dir) => {
    const runId = '1790000000009';
    const state = materializedState(runId);
    seedGhost(dir, runId);
    // An earlier spawn of the same role, so the question actually reaches the
    // registry: with no other same-role claim on disk the check stops before it.
    const earlier = 'first-spawn-thread';
    fs.writeFileSync(path.join(runDir(dir, runId), `${earlier}.json`), JSON.stringify({
      version: 1,
      runId,
      claimId: `${ROLE}-1-first-spawn`,
      role: ROLE,
      spawnIndex: 1,
      status: 'claimed',
      sessionId: earlier,
      createdAt: new Date().toISOString(),
    }));
    // Cursor records the spawn's `tool_*` call id and only upgrades the row to
    // the child's conversation id later. The row is live and names nothing
    // either claim carries — the shape a bare "the row does not name me" test
    // reports as superseded, stripping the role's OWN agents of identity once
    // the sweep has released them.
    writeRegistryRow(dir, runId, ROLE, {
      agentId: 'tool_11112222-3333-4444-5555-666677778888',
      toolCallId: 'tool_11112222-3333-4444-5555-666677778888',
      parentSessionId: PARENT,
      recordedAt: new Date().toISOString(),
    });
    releaseRunClaims(dir, runId, 'settled');

    const claim = readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`));
    assert.equal(claim.status, 'released');
    assert.equal(readJsonFile(path.join(runDir(dir, runId), `${earlier}.json`)).status, 'released',
      'the sweep released both, which is what makes neither of them a live rival');
    assert.equal(claimRejectReason(dir, state, claim), null,
      'an un-upgraded row is not evidence of a second agent, and must not cost this one its role');
  });
});

test('explainUnresolvedRunAgent reports the supersession instead of dropping the claim', () => {
  withProject('explain', (dir) => {
    const runId = '1790000000010';
    const state = materializedState(runId);
    seedGhost(dir, runId);
    markRunAgentReplaced(dir, runId, ROLE);
    assert.ok(claimThreadRole(dir, state, HEIR, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
      refuseOccupiedRole: true,
    }));

    const diagnosis = explainUnresolvedRunAgent(dir, state, { session_id: GHOST, agent_id: GHOST, is_subagent: true });
    assert.equal(diagnosis.reason, 'claim-superseded',
      'an unranked reason would be skipped by the explainer and reported as the default no-claim');
    assert.equal(diagnosis.role, ROLE);
    assert.equal(diagnosis.runId, runId);
  });
});

test('retiring the same row twice finishes the release the first attempt owed', () => {
  withProject('idempotent', (dir) => {
    const runId = '1790000000011';
    const state = materializedState(runId);
    ensureRunLedger(dir, runId, { status: 'active', kind: 'test' });
    const ctx = claimThreadRole(dir, state, GHOST, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
    });
    assert.ok(ctx);
    assert.equal(tryFallbackClaim(dir, ctx!, 'src/app.tsx').blocked, false);
    // A row already retired with its holds still on disk: what a first attempt
    // leaves behind when the marker persisted and the release did not.
    writeRegistryRow(dir, runId, ROLE, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: new Date(Date.now() - 10_000).toISOString(),
      replaced: true,
      replacedAt: new Date(Date.now() - 5_000).toISOString(),
      replacementReason: 'correlated-cursor-transcript-failure',
    });
    assert.deepEqual(tryFallbackClaim(dir, heirContext(runId), 'src/app.tsx'), { blocked: true, holder: GHOST },
      'the half-finished retirement still has the ghost holding the file');

    const retry = markRunAgentReplacedIfMatchesResult(dir, runId, ROLE, GHOST);
    assert.equal(retry.outcome, 'precondition-failed');
    assert.equal(retry.reason, 'already-replaced', 'the row itself is still reported as already retired');
    assert.equal(tryFallbackClaim(dir, heirContext(runId), 'src/app.tsx').blocked, false,
      'but the release half the first attempt owed is completed');
    assert.equal(readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`)).status, 'released');
  });
});

test('a retirement that does not name this row\'s agent releases nothing', () => {
  withProject('cas', (dir) => {
    const runId = '1790000000012';
    seedGhost(dir, runId);

    assert.equal(markRunAgentReplacedIfMatches(dir, runId, ROLE, 'some-other-agent'), false);
    const outcome = markRunAgentReplacedIfMatchesResult(dir, runId, ROLE, 'some-other-agent');
    assert.equal(outcome.outcome, 'precondition-failed');
    assert.equal(outcome.reason, 'expected-id-mismatch');

    assert.equal(readJsonFile(path.join(runDir(dir, runId), 'agents.json')).agents !== undefined, true);
    assert.equal(readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`)).status, 'claimed',
      'a CAS that failed must leave the live agent exactly as it was');
    assert.deepEqual(tryFallbackClaim(dir, heirContext(runId), 'src/app.tsx'), { blocked: true, holder: GHOST });
    assert.equal(hasActiveRunClaims(dir, { currentRunId: runId }), true);
  });
});
