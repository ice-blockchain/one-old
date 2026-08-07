// src/shared/state/__tests__/liveness-decay.test.ts
// Agent liveness has to DECAY: ignorance about a child must read as ignorance,
// not as life. A live agent is PROTECTED from replacement, so every false
// "alive" is permanent — the orchestrator cannot replace a child that is gone
// and the run wedges.
//
// Three ways a row used to be immortal, all fixed here:
//   - a parent-session match returned the row with NO staleness bound at all,
//     which is the ordinary case (the recorder stamps the row from the session
//     that later reads it), so the bound applied only to rows the host had told
//     us LEAST about;
//   - a stamp in the FUTURE yields a negative age, and `age <= maxAgeMs` reads
//     that as maximally fresh forever (clamping the age to zero fixes nothing —
//     zero age is maximally fresh, so a future stamp has to be classified);
//   - the row's clock was re-stamped on every record, including the same-agent
//     upgrade that only increments `tasks`, so a parent that kept sending Task
//     calls kept its child's row young however long the child had been gone.
//
// The opposite hazard governs the whole area and is asserted here too: making
// agents presumed-dead sooner must never produce TWO writers for one role. The
// bound that decays is the row's, and a row grants no write authority — so the
// tests below walk the ghost/successor sequence and pin the artifact that
// revokes the ghost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  claimThreadRole,
  ensureRunLedger,
  liveRunAgent,
  readRunAgentRegistry,
  recordRunAgent,
  resolveRunAgentContext,
  tryFallbackClaim,
} from '../run-agent';
import { claimRejectReason } from '../run-agent/claims-pending';
import {
  ageAttestsLiveness,
  attestsLiveness,
  isFreshTimestamp,
} from '../run-agent/session-identity';
import { stackFingerprint } from '../materialization';
import {
  STATE_TIMESTAMP_FUTURE_SKEW_MS,
  SUBAGENT_STALE_MS,
} from '../../../config/state';

const ROLE = 'senior-frontend';
const GHOST = 'ghost-thread-0001';
const HEIR = 'heir-thread-0002';
const PARENT = 'orchestrator-session';

function withProject<T>(name: string, fn: (dir: string) => T): T {
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1-liveness-decay-${name}-`));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** claimThreadRole mirrors a bind into the reuse registry only where the host
 * has a continuation primitive — the registry is dead weight without one. */
function withContinuation<T>(fn: () => T): T {
  const prev = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = prev;
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

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** The row, written directly: every test here is about a `recordedAt` the
 * recorder would only ever stamp as "now". */
function writeRegistryRow(
  dir: string,
  runId: string,
  entry: Record<string, unknown>,
): void {
  fs.mkdirSync(runDir(dir, runId), { recursive: true });
  const file = path.join(runDir(dir, runId), 'agents.json');
  const existing = fs.existsSync(file) ? readJsonFile(file) : { version: 1, agents: {} };
  const agents = (existing.agents || {}) as Record<string, unknown>;
  agents[ROLE] = { role: ROLE, tasks: 1, replaced: false, ...entry };
  fs.writeFileSync(file, JSON.stringify({ ...existing, version: 1, agents }, null, 2));
}

function row(dir: string, runId: string): Record<string, unknown> {
  return (readJsonFile(path.join(runDir(dir, runId), 'agents.json')).agents as Record<string, Record<string, unknown>>)[ROLE]!;
}

test('the shared liveness predicate classifies the two ages that are not evidence', () => {
  // Absent and unparseable already failed closed through timestampAgeMs's
  // Infinity; what they lacked was a caller that used it instead of hand-rolling
  // the inverse answer (cursor-liveness.ts did exactly that).
  assert.equal(attestsLiveness(undefined, SUBAGENT_STALE_MS), false, 'no stamp attests nothing');
  assert.equal(attestsLiveness('', SUBAGENT_STALE_MS), false);
  assert.equal(attestsLiveness('not-a-date', SUBAGENT_STALE_MS), false);

  assert.equal(attestsLiveness(ago(60_000), SUBAGENT_STALE_MS), true, 'a recent stamp attests');
  assert.equal(attestsLiveness(ago(SUBAGENT_STALE_MS + 60_000), SUBAGENT_STALE_MS), false, 'an old stamp does not');

  // The future. A negative age passes `<= maxAgeMs`, so this is the input that
  // read as maximally fresh forever.
  const inFuture = (ms: number): string => new Date(Date.now() + ms).toISOString();
  assert.equal(
    isFreshTimestamp(inFuture(48 * 60 * 60 * 1000), SUBAGENT_STALE_MS),
    true,
    'PRECONDITION: the blocking predicate still reads a stamp two days ahead as fresh — otherwise the next assertion measures nothing',
  );
  assert.equal(
    attestsLiveness(inFuture(48 * 60 * 60 * 1000), SUBAGENT_STALE_MS),
    false,
    'a stamp from the future is an untrustworthy clock, not a young agent',
  );
  assert.equal(
    attestsLiveness(inFuture(STATE_TIMESTAMP_FUTURE_SKEW_MS - 60_000), SUBAGENT_STALE_MS),
    true,
    'inside the skew allowance a slightly-ahead stamp is still ordinary jitter',
  );
  assert.equal(
    attestsLiveness(inFuture(STATE_TIMESTAMP_FUTURE_SKEW_MS + 60_000), SUBAGENT_STALE_MS),
    false,
  );

  // The age-taking sibling, which cursor-liveness.ts uses because it owns a
  // `nowMs` seam.
  assert.equal(ageAttestsLiveness(1_000, SUBAGENT_STALE_MS), true);
  assert.equal(ageAttestsLiveness(Number.NaN, SUBAGENT_STALE_MS), false, 'an unusable age is not an attestation');
  assert.equal(ageAttestsLiveness(Infinity, SUBAGENT_STALE_MS), false);
  assert.equal(ageAttestsLiveness(-(STATE_TIMESTAMP_FUTURE_SKEW_MS + 1), SUBAGENT_STALE_MS), false);
});

test('a matching parent session says WHOSE agent a row is, not that the agent still exists', () => {
  withProject('parent-branch', (dir) => {
    const runId = '1790000010001';
    writeRegistryRow(dir, runId, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: ago(SUBAGENT_STALE_MS + 60_000),
    });

    // PRECONDITIONS. Both sides of the parent-session comparison must be present
    // and EQUAL, or this row never reaches the branch under test and the
    // assertion below would pass for the wrong reason.
    assert.equal(row(dir, runId).parentSessionId, PARENT);
    assert.equal(row(dir, runId).replaced, false, 'not retired — retirement is a different, already-working reason to be dead');

    assert.equal(
      liveRunAgent(dir, runId, ROLE, PARENT),
      null,
      'a row whose parent session matches is still subject to the staleness bound',
    );
    // The mismatch arm is unchanged and still decisive: an agent spawned by
    // another session died with it, whatever its stamp says.
    writeRegistryRow(dir, runId, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: ago(1_000),
    });
    assert.equal(liveRunAgent(dir, runId, ROLE, 'a-different-session'), null, 'a parent mismatch is still decisive');
    assert.equal(liveRunAgent(dir, runId, ROLE, PARENT)?.agentId, GHOST, 'and a fresh row with a matching parent is still live');
    assert.equal(liveRunAgent(dir, runId, ROLE, null)?.agentId, GHOST, 'as is a fresh row the caller has no session for');
  });
});

test('a registry row stamped in the future is not a live agent', () => {
  withProject('future-row', (dir) => {
    const runId = '1790000010002';
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    writeRegistryRow(dir, runId, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: future,
    });
    assert.equal(row(dir, runId).recordedAt, future, 'PRECONDITION: the row really carries the future stamp');
    assert.equal(
      liveRunAgent(dir, runId, ROLE, PARENT),
      null,
      'a clock that disagrees with ours proves nothing about the child; it must not make the row immortal',
    );
  });
});

test('a row with no usable recordedAt is not a live agent', () => {
  withProject('stampless-row', (dir) => {
    const runId = '1790000010003';
    writeRegistryRow(dir, runId, { agentId: GHOST, resumeId: GHOST, parentSessionId: PARENT });
    assert.equal(row(dir, runId).recordedAt, undefined, 'PRECONDITION: the row carries no stamp at all');
    assert.equal(liveRunAgent(dir, runId, ROLE, PARENT), null);
  });
});

test('a Task call is the parent acting: re-recording the same agent does not restart its liveness clock', () => {
  withProject('parent-refresh', (dir) => {
    const runId = '1790000010004';
    const born = ago(25 * 60 * 1000);
    // The Cursor shape: SubagentStart recorded only `tool_<uuid>`, 25 minutes ago.
    writeRegistryRow(dir, runId, {
      agentId: 'tool_11112222-3333-4444-8555-666677778888',
      toolCallId: 'tool_11112222-3333-4444-8555-666677778888',
      resumeId: null,
      parentSessionId: PARENT,
      recordedAt: born,
    });

    // PostToolUse(Task) for the same spawn arrives with the real resume UUID —
    // the `sameAgent` upgrade path.
    recordRunAgent(dir, runId, ROLE, {
      agentId: '019e7390-ca45-7e03-84d3-284bda1ba905',
      resumeId: '019e7390-ca45-7e03-84d3-284bda1ba905',
      parentSessionId: PARENT,
    });

    // NON-VACUITY: the record must actually have happened. Without `tasks` the
    // assertion below would also pass for a record that did nothing at all.
    assert.equal(row(dir, runId).tasks, 2, 'PRECONDITION: the same-agent upgrade ran and counted the task');
    assert.equal(row(dir, runId).resumeId, '019e7390-ca45-7e03-84d3-284bda1ba905', 'and it did upgrade the row');
    assert.equal(
      row(dir, runId).recordedAt,
      born,
      'the parent sending more work is not evidence the child is alive, so the clock stays at the spawn',
    );
    assert.equal(
      liveRunAgent(dir, runId, ROLE, PARENT)?.agentId,
      '019e7390-ca45-7e03-84d3-284bda1ba905',
      'PRECONDITION: still inside the window, so this row is protected on its own age and not on the re-record',
    );

    // A further Task for the role, and another: a repeatedly re-recorded row must
    // still age out.
    recordRunAgent(dir, runId, ROLE, {
      agentId: '019e7390-ca45-7e03-84d3-284bda1ba905',
      parentSessionId: PARENT,
    });
    assert.equal(row(dir, runId).tasks, 3);
    assert.equal(row(dir, runId).recordedAt, born, 'however many tasks the parent sends');
  });
});

test('a genuinely new agent for the role does start a new clock', () => {
  withProject('new-agent-clock', (dir) => {
    const runId = '1790000010005';
    writeRegistryRow(dir, runId, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: ago(SUBAGENT_STALE_MS + 60_000),
      replaced: true,
    });
    recordRunAgent(dir, runId, ROLE, { agentId: HEIR, resumeId: HEIR, parentSessionId: PARENT });

    assert.equal(row(dir, runId).agentId, HEIR);
    assert.equal(row(dir, runId).tasks, 1, 'PRECONDITION: a replacement, not an upgrade of the retired row');
    assert.equal(row(dir, runId).replaced, false);
    assert.notEqual(row(dir, runId).recordedAt, ago(SUBAGENT_STALE_MS + 60_000));
    assert.equal(
      liveRunAgent(dir, runId, ROLE, PARENT)?.agentId,
      HEIR,
      'freezing the clock must never make a freshly recorded agent read as dead',
    );
  });
});

test('a child that binds its role for itself does restart the clock', () => {
  withProject('child-bind-clock', (dir) => {
    const runId = '1790000010006';
    const state = materializedState(runId);
    ensureRunLedger(dir, runId, { status: 'active', kind: 'test' });
    const stale = ago(SUBAGENT_STALE_MS + 60_000);
    writeRegistryRow(dir, runId, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: stale,
    });
    assert.equal(liveRunAgent(dir, runId, ROLE, PARENT), null, 'PRECONDITION: the row is presumed dead before the bind');

    // The child re-binds after its claim aged out. This is the CHILD acting, and
    // it is the one observation allowed to advance the row — otherwise a live
    // child would hold a fresh 30-minute claim over a row the reuse gate offers
    // to a replacement.
    withContinuation(() => {
      assert.ok(claimThreadRole(dir, state, GHOST, ROLE, { parentSessionId: PARENT }), 'the child binds');
    });

    assert.equal(row(dir, runId).tasks, 2, 'PRECONDITION: the same agent, upgraded rather than replaced');
    assert.notEqual(row(dir, runId).recordedAt, stale);
    assert.equal(
      liveRunAgent(dir, runId, ROLE, PARENT)?.agentId,
      GHOST,
      'a child observed acting for itself is alive, and its row says so again',
    );
  });
});

test('the successor cannot take write authority without creating the artifact that revokes the ghost', () => {
  // The double-writer construction, built as adversarially as the stores allow:
  // a live agent with FRESH write authority whose row has nonetheless decayed
  // under the new bound. (Reachable: an interrupt/resume re-stamps the claim's
  // createdAt in place — claim-thread-role.ts's `reclaiming` — while the row
  // keeps the stamp it was born with.)
  withProject('double-writer', (dir) => {
    const runId = '1790000010007';
    const state = materializedState(runId);
    ensureRunLedger(dir, runId, { status: 'active', kind: 'test' });
    const ghostCtx = claimThreadRole(dir, state, GHOST, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
    });
    assert.ok(ghostCtx);
    assert.equal(tryFallbackClaim(dir, ghostCtx!, 'src/app.tsx').blocked, false);
    writeRegistryRow(dir, runId, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: ago(SUBAGENT_STALE_MS + 60_000),
    });

    const ghostWrite = { session_id: GHOST, agent_id: GHOST, is_subagent: true };
    // PRECONDITIONS: the ghost is alive by the only measure that grants writes,
    // and dead by the one this lane changed. Without both, nothing below is a
    // double-writer test.
    assert.equal(resolveRunAgentContext(dir, state, ghostWrite, { claimPending: false })?.role, ROLE,
      'PRECONDITION: the ghost still has write authority (its claim is fresh)');
    assert.equal(liveRunAgent(dir, runId, ROLE, PARENT), null,
      'PRECONDITION: and its row is presumed dead, so a replacement is no longer refused as a duplicate');

    // The replacement binds. It cannot obtain the role any other way: every
    // resolution path that grants a role writes a claim file under the binder's
    // own thread id and releases the same-role claims of other threads.
    assert.ok(claimThreadRole(dir, state, HEIR, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
    }), 'the replacement binds');

    const ghostClaim = readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`));
    assert.equal(ghostClaim.status, 'released', 'binding released the ghost claim in the same locked step');
    assert.equal(claimRejectReason(dir, state, ghostClaim), 'claim-superseded');
    assert.equal(resolveRunAgentContext(dir, state, ghostWrite, { claimPending: false }), null,
      'the ghost loses write authority at the instant the successor gains it');
    assert.equal(resolveRunAgentContext(dir, state, { session_id: HEIR, agent_id: HEIR, is_subagent: true }, {
      claimPending: false,
    })?.role, ROLE, 'and the successor has it');
  });
});

test('a decayed row does not by itself strip a live child of write authority', () => {
  // The other direction of the same property, and the one that costs a build:
  // the row's staleness must not leak into claim resolution. Retirement is the
  // only thing allowed to take a child's authority, and it is keyed to the
  // retired agent's own identity.
  withProject('no-strip', (dir) => {
    const runId = '1790000010008';
    const state = materializedState(runId);
    ensureRunLedger(dir, runId, { status: 'active', kind: 'test' });
    assert.ok(claimThreadRole(dir, state, GHOST, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
    }));
    writeRegistryRow(dir, runId, {
      agentId: GHOST,
      resumeId: GHOST,
      parentSessionId: PARENT,
      recordedAt: ago(SUBAGENT_STALE_MS + 60_000),
    });

    assert.equal(liveRunAgent(dir, runId, ROLE, PARENT), null, 'PRECONDITION: the row has decayed');
    assert.equal(
      resolveRunAgentContext(dir, state, { session_id: GHOST, agent_id: GHOST, is_subagent: true }, { claimPending: false })?.role,
      ROLE,
      'with no successor the child keeps writing: a stale reuse row is not a verdict on the child',
    );
  });
});

test('freshness that BLOCKS a rival keeps failing toward the block, however odd its stamp', () => {
  // The predicate split, pinned. `isFreshTimestamp` reads as a reason to block
  // at four of its call sites, and classifying a future stamp there would
  // RELEASE a live holder's lock and let a second writer in — the opposite
  // direction from the staleness sites. A later blanket edit to the shared
  // predicate has to fail here.
  withProject('block-direction', (dir) => {
    const runId = '1790000010009';
    const state = materializedState(runId);
    ensureRunLedger(dir, runId, { status: 'active', kind: 'test' });
    const holder = claimThreadRole(dir, state, GHOST, ROLE, {
      parentSessionId: PARENT,
      model: 'composer-2.5-fast',
      recordAgent: false,
    });
    assert.ok(holder);
    assert.equal(tryFallbackClaim(dir, holder!, 'src/app.tsx').blocked, false);

    // The holder's lock, stamped by a clock that has since stepped backwards.
    const lockFile = path.join(runDir(dir, runId), 'claims', 'src_app.tsx.json');
    const lock = readJsonFile(lockFile);
    assert.equal(lock.holder, GHOST, 'PRECONDITION: the lock is really the holder\'s');
    fs.writeFileSync(lockFile, JSON.stringify({
      ...lock,
      createdAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }));

    const rival = { source: 'test', runId, role: ROLE, spawnIndex: 2, sessionId: HEIR, claimId: `${ROLE}-2-heir` };
    assert.deepEqual(
      tryFallbackClaim(dir, rival, 'src/app.tsx'),
      { blocked: true, holder: GHOST },
      'an unusable stamp on a lock must keep the lock, not hand the file to a second writer',
    );
  });
});

// ── The liveRunAgent decision matrix ─────────────────────────────────────────
// Everything above is an EXAMPLE: one cell each, chosen because a defect was
// found there. The predicate is a product of four independent questions, and
// the cells no example happens to sit on are exactly where the next defect
// lives. So the product itself is enumerated below.
//
//   presence   whether readRunAgentRegistry hands back a row at all
//   replaced   the explicit retirement flag
//   parent     entry.parentSessionId CROSSED with the caller's argument
//   stamp      entry.recordedAt, in every class attestsLiveness distinguishes
//
// The parent dimension is crossed rather than collapsed because the comparison
// fires only when BOTH sides are non-empty. Absent, empty, mine and theirs are
// four different inputs and only ONE of the twelve pairs is a disagreement — an
// example test picks a pair and cannot see the asymmetry.

type EntryParent = 'absent' | 'empty' | 'mine';
type ArgParent = 'absent' | 'empty' | 'mine' | 'theirs';
type Stamp = 'fresh' | 'stale' | 'future-in-skew' | 'future-past-skew' | 'unparseable' | 'no-stamp';

const OTHER_PARENT = 'a-different-orchestrator-session';

const ENTRY_PARENT: Record<EntryParent, string | null> = {
  absent: null,
  empty: '',
  mine: PARENT,
};

const ARG_PARENT: Record<ArgParent, string | null> = {
  absent: null,
  empty: '',
  mine: PARENT,
  theirs: OTHER_PARENT,
};

// Written out as twelve literal rows rather than derived from the predicate, so
// a change to the asymmetry has to be RESTATED here before the table agrees.
const PARENT_PAIRS: { entry: EntryParent; arg: ArgParent; rejects: boolean; why: string }[] = [
  { entry: 'absent', arg: 'absent', rejects: false, why: 'neither side names a session' },
  { entry: 'absent', arg: 'empty', rejects: false, why: 'neither side names a session' },
  { entry: 'absent', arg: 'mine', rejects: false, why: 'the row does not say whose it is' },
  { entry: 'absent', arg: 'theirs', rejects: false, why: 'a row with no owner cannot be someone else\'s' },
  { entry: 'empty', arg: 'absent', rejects: false, why: 'neither side names a session' },
  { entry: 'empty', arg: 'empty', rejects: false, why: 'neither side names a session' },
  { entry: 'empty', arg: 'mine', rejects: false, why: 'an empty owner is silence, not disagreement' },
  { entry: 'empty', arg: 'theirs', rejects: false, why: 'an empty owner is silence, not disagreement' },
  { entry: 'mine', arg: 'absent', rejects: false, why: 'the CALLER has no session to disagree with' },
  { entry: 'mine', arg: 'empty', rejects: false, why: 'the caller\'s empty session is silence, not disagreement' },
  { entry: 'mine', arg: 'mine', rejects: false, why: 'the same session — whose, answered, and nothing else' },
  { entry: 'mine', arg: 'theirs', rejects: true, why: 'the only disagreement: two non-empty ids that differ' },
];

const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

const STAMPS: { kind: Stamp; attests: boolean; why: string; value: string | undefined }[] = [
  { kind: 'fresh', attests: true, why: 'inside the window', value: ago(60_000) },
  { kind: 'stale', attests: false, why: 'older than SUBAGENT_STALE_MS', value: ago(SUBAGENT_STALE_MS + 60_000) },
  { kind: 'future-in-skew', attests: true, why: 'ordinary clock jitter', value: ahead(STATE_TIMESTAMP_FUTURE_SKEW_MS - 60_000) },
  { kind: 'future-past-skew', attests: false, why: 'a clock we cannot trust, not a young agent', value: ahead(STATE_TIMESTAMP_FUTURE_SKEW_MS + 60_000) },
  { kind: 'unparseable', attests: false, why: 'an Infinity age is ignorance, not life', value: 'not-a-date' },
  { kind: 'no-stamp', attests: false, why: 'the row never said when', value: undefined },
];

interface MatrixCell {
  replaced: boolean;
  entry: EntryParent;
  arg: ArgParent;
  stamp: Stamp;
  live: boolean;
}

const MATRIX_DIMENSIONS = ['replaced', 'entry', 'arg', 'stamp'] as const;
type MatrixDimension = (typeof MATRIX_DIMENSIONS)[number];

/** A VALUE earns its place only if some single-dimension neighbour flips the
 * verdict while every other coordinate is held fixed. A value that never does
 * is decoration: no mutation of the predicate can distinguish it from the
 * value beside it. */
function discriminates(cells: MatrixCell[], dimension: MatrixDimension, value: string): boolean {
  return cells.some((a) => String(a[dimension]) === value && cells.some((b) => String(b[dimension]) !== value
    && MATRIX_DIMENSIONS.every((other) => other === dimension || String(a[other]) === String(b[other]))
    && a.live !== b.live));
}

/** A table that throws on its first disagreeing cell reports ONE cell, whichever
 * the loop reached first. That is the wrong answer to "which cells did this
 * change break?" — the question a mutation is run to answer — so each cell is
 * evaluated in full and the disagreements are reported together. The per-cell
 * assertions and their messages are unchanged; only the moment of failure is. */
function collectCells(): { cell: (id: string, body: () => void) => void; settle: (total: number) => void } {
  const failures: string[] = [];
  return {
    cell(id, body) {
      try {
        body();
      } catch (err) {
        failures.push(err instanceof assert.AssertionError ? String(err.message).split('\n')[0]! : `${id}: threw ${String(err)}`);
      }
    },
    settle(total) {
      if (failures.length) {
        assert.fail(`${failures.length} of ${total} cells disagree:\n  ${failures.join('\n  ')}`);
      }
    },
  };
}

test('liveRunAgent: the full product of replaced x parent-pair x stamp on a present row', () => {
  withProject('matrix-present', (dir) => {
    const cells: MatrixCell[] = [];
    const collected = collectCells();
    let index = 0;
    for (const replaced of [false, true]) {
      for (const pair of PARENT_PAIRS) {
        for (const stamp of STAMPS) {
          const runId = `179100${String(index++).padStart(7, '0')}`;
          const cell = `replaced=${replaced} entry=${pair.entry} arg=${pair.arg} stamp=${stamp.kind}`;
          const expectLive = !replaced && !pair.rejects && stamp.attests;
          writeRegistryRow(dir, runId, {
            agentId: GHOST,
            resumeId: GHOST,
            replaced,
            parentSessionId: ENTRY_PARENT[pair.entry],
            recordedAt: stamp.value,
          });
          const live = liveRunAgent(dir, runId, ROLE, ARG_PARENT[pair.arg]);
          cells.push({ replaced, entry: pair.entry, arg: pair.arg, stamp: stamp.kind, live: live !== null });

          collected.cell(cell, () => {
            // The fixture produced the cell this row claims to test. Without
            // this a normalization change in readRunAgentRegistry silently
            // collapses cells onto each other and the table keeps passing.
            const written = readRunAgentRegistry(dir, runId)[ROLE];
            assert.ok(written, `${cell}: PRECONDITION: the row survived readRunAgentRegistry`);
            assert.equal(written!.replaced, replaced, `${cell}: PRECONDITION: replaced fixture`);
            assert.equal(written!.parentSessionId, ENTRY_PARENT[pair.entry], `${cell}: PRECONDITION: entry-parent fixture`);
            assert.equal(written!.recordedAt, stamp.value ?? '', `${cell}: PRECONDITION: stamp fixture`);

            assert.equal(
              live !== null,
              expectLive,
              `${cell}: expected ${expectLive ? 'the row' : 'null'} — ${replaced ? 'retired' : pair.rejects ? pair.why : stamp.why}`,
            );
            if (live) assert.equal(live.agentId, GHOST, `${cell}: the live answer must be THIS row`);
          });
        }
      }
    }
    collected.settle(cells.length);

    assert.equal(cells.length, 2 * 12 * 6, 'the product is covered, not a sample of it');
    assert.equal(
      cells.filter((cell) => cell.live).length,
      11 * 2,
      'exactly the not-retired cells whose parent pair is not a disagreement and whose stamp attests',
    );

    // No value in any dimension is decoration.
    const values: Record<MatrixDimension, string[]> = {
      replaced: ['false', 'true'],
      entry: ['absent', 'empty', 'mine'],
      arg: ['absent', 'empty', 'mine', 'theirs'],
      stamp: STAMPS.map((stamp) => stamp.kind),
    };
    for (const dimension of MATRIX_DIMENSIONS) {
      for (const value of values[dimension]) {
        assert.ok(
          discriminates(cells, dimension, value),
          `${dimension}=${value} never flips the verdict against a single-dimension neighbour, so no mutation can distinguish it — decoration`,
        );
      }
    }
  });
});

// The other half of the presence dimension. Each shape below is written so that
// EVERY other coordinate is live-making — fresh stamp, matching parent, not
// retired — which is what makes the null answer attributable to the absence and
// not to a fixture that quietly stopped producing a row.
const ABSENT_SHAPES: { name: string; write: (dir: string, runId: string) => void }[] = [
  { name: 'no run directory at all', write: () => {} },
  {
    name: 'a registry that holds only ANOTHER role',
    write: (dir, runId) => {
      fs.mkdirSync(runDir(dir, runId), { recursive: true });
      fs.writeFileSync(path.join(runDir(dir, runId), 'agents.json'), JSON.stringify({
        version: 1,
        agents: { 'senior-backend': { agentId: GHOST, role: 'senior-backend', replaced: false, parentSessionId: PARENT, recordedAt: ago(60_000) } },
      }));
    },
  },
  {
    name: 'the role key present but carrying no agentId',
    write: (dir, runId) => writeRegistryRow(dir, runId, { parentSessionId: PARENT, recordedAt: ago(60_000) }),
  },
  {
    name: 'the role key present with an EMPTY agentId',
    write: (dir, runId) => writeRegistryRow(dir, runId, { agentId: '', parentSessionId: PARENT, recordedAt: ago(60_000) }),
  },
  {
    name: 'the role key present with a non-string agentId',
    write: (dir, runId) => writeRegistryRow(dir, runId, { agentId: 12345, parentSessionId: PARENT, recordedAt: ago(60_000) }),
  },
  {
    name: '`agents` is an array, not a map',
    write: (dir, runId) => {
      fs.mkdirSync(runDir(dir, runId), { recursive: true });
      fs.writeFileSync(path.join(runDir(dir, runId), 'agents.json'), JSON.stringify({
        version: 1,
        agents: [{ agentId: GHOST, role: ROLE, replaced: false, parentSessionId: PARENT, recordedAt: ago(60_000) }],
      }));
    },
  },
  {
    // A row's `role` field is not evidence: readRunAgentRegistry SETS it from
    // the map key it found the row under. Reading the role back out of the row
    // is therefore circular, and a registry that did so would hand this run's
    // `senior-frontend` slot to a row filed under another role entirely. Added
    // because it was the one mutation the rest of this file could not kill.
    name: 'another role\'s key holding a row that CLAIMS to be ours',
    write: (dir, runId) => {
      fs.mkdirSync(runDir(dir, runId), { recursive: true });
      fs.writeFileSync(path.join(runDir(dir, runId), 'agents.json'), JSON.stringify({
        version: 1,
        agents: { 'senior-backend': { agentId: GHOST, role: ROLE, replaced: false, parentSessionId: PARENT, recordedAt: ago(60_000) } },
      }));
    },
  },
  {
    name: 'the registry file is not JSON',
    write: (dir, runId) => {
      fs.mkdirSync(runDir(dir, runId), { recursive: true });
      fs.writeFileSync(path.join(runDir(dir, runId), 'agents.json'), '{"version":1,"agents":{"senior-fro');
    },
  },
];

test('liveRunAgent: every shape that yields no row is null for every caller session', () => {
  withProject('matrix-absent', (dir) => {
    // The CONTROL. The same coordinates the shapes below carry, written as a
    // real row, are live — so a null answer there is the absence and not the
    // rest of the fixture having gone inert.
    const collected = collectCells();
    writeRegistryRow(dir, 'control-run', { agentId: GHOST, parentSessionId: PARENT, recordedAt: ago(60_000) });
    for (const arg of Object.keys(ARG_PARENT) as ArgParent[]) {
      collected.cell(`CONTROL arg=${arg}`, () => assert.equal(
        liveRunAgent(dir, 'control-run', ROLE, ARG_PARENT[arg])?.agentId,
        arg === 'theirs' ? undefined : GHOST,
        `CONTROL (arg=${arg}): these coordinates are otherwise live-making`,
      ));
    }

    ABSENT_SHAPES.forEach((shape, shapeIndex) => {
      const runId = `179200000000${shapeIndex}`;
      shape.write(dir, runId);
      collected.cell(shape.name, () => assert.equal(
        readRunAgentRegistry(dir, runId)[ROLE],
        undefined,
        `${shape.name}: PRECONDITION: this shape really yields no row`,
      ));
      for (const arg of Object.keys(ARG_PARENT) as ArgParent[]) {
        collected.cell(`${shape.name} arg=${arg}`, () => assert.equal(
          liveRunAgent(dir, runId, ROLE, ARG_PARENT[arg]),
          null,
          `${shape.name} (arg=${arg}): an absent row is not a live agent, whoever is asking`,
        ));
      }
    });
    collected.settle(4 + ABSENT_SHAPES.length * 5);
  });
});

test('liveRunAgent: the two window bounds are exact', () => {
  // Through the pure predicate rather than a written row: an exact boundary
  // measured across a file write is a clock race, and a cell that flakes is
  // worse than no cell. The matrix above places its cells a minute clear of
  // both bounds for the same reason, so this is the only place the exact
  // comparison operators are pinned.
  assert.equal(ageAttestsLiveness(SUBAGENT_STALE_MS, SUBAGENT_STALE_MS), true, 'the staleness bound is inclusive');
  assert.equal(ageAttestsLiveness(SUBAGENT_STALE_MS + 1, SUBAGENT_STALE_MS), false);
  assert.equal(ageAttestsLiveness(-STATE_TIMESTAMP_FUTURE_SKEW_MS, SUBAGENT_STALE_MS), true, 'the skew allowance is inclusive');
  assert.equal(ageAttestsLiveness(-STATE_TIMESTAMP_FUTURE_SKEW_MS - 1, SUBAGENT_STALE_MS), false);
  assert.equal(ageAttestsLiveness(0, SUBAGENT_STALE_MS), true, 'and the two bounds do not exclude the present');
});

test('a successor whose own claim is oddly stamped still supersedes the ghost', () => {
  // The same asymmetry at the second blocking site: `releasedClaimRoleTakenOver`
  // reads freshness as POSITIVE evidence that a successor exists. Reading a
  // future-stamped successor as absent would leave the ghost resolving beside
  // it — the double writer, arrived at by "fixing" the wrong call site.
  withProject('successor-direction', (dir) => {
    const runId = '1790000010010';
    const state = materializedState(runId);
    ensureRunLedger(dir, runId, { status: 'active', kind: 'test' });
    assert.ok(claimThreadRole(dir, state, GHOST, ROLE, { parentSessionId: PARENT, recordAgent: false }));
    assert.ok(claimThreadRole(dir, state, HEIR, ROLE, { parentSessionId: PARENT, recordAgent: false }));

    const heirFile = path.join(runDir(dir, runId), `${HEIR}.json`);
    const heirClaim = readJsonFile(heirFile);
    assert.equal(heirClaim.status, 'claimed', 'PRECONDITION: the successor is live');
    fs.writeFileSync(heirFile, JSON.stringify({
      ...heirClaim,
      createdAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }));

    const ghostClaim = readJsonFile(path.join(runDir(dir, runId), `${GHOST}.json`));
    assert.equal(ghostClaim.status, 'released', 'PRECONDITION: the ghost was released when the successor bound');
    assert.equal(
      claimRejectReason(dir, state, ghostClaim),
      'claim-superseded',
      'the successor is present on disk; an odd stamp on it must not restore the ghost\'s authority',
    );
  });
});
