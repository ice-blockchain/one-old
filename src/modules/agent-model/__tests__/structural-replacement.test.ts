// The `[t1-replace-agent]` replacement predicate.
//
// The authority to retire a live agent used to come from a regex over the
// SPAWN PROMPT — text the orchestrator wrote about itself. These suites pin the
// structural predicate that now carries that authority (facts the runtime
// recorded: the role's claim, the run ledger, the exhaustion ledger) and the
// measured defects in the prose backstop that survives it for the one failure
// nothing on disk can witness, context exhaustion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { recordSpawnedAgent } from '../record-agent';
import { recordExhaustedModel } from '../exhausted-models';
import {
  replacementJustified,
  structuralReplacementGround,
  type StructuralReplacementGround,
} from '../model-rotation';
import {
  claimThreadRole,
  liveRunAgent,
  readEffectiveState,
  readRunAgentRegistry,
  type RunAgentEntry,
  runLedgerAdmitsClaims,
  runRoleHasBoundClaim,
  transitionRunStatus,
} from '../../../shared/state';
import {
  STATE_TIMESTAMP_FUTURE_SKEW_MS,
  SUBAGENT_STALE_MS,
} from '../../../config/state';
import { writeArchitectPhaseComplete } from '../../plan-guard/__tests__/architect-phase-fixtures';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { withMaterialized } from './agent-model-fixtures';

// The model this project's frozen policy prescribes for a senior role on
// claude/high. A spawn that passes anything else is refused by the performance
// gate BEFORE the reuse gate is reached, which would make every gate-level row
// below pass for the wrong reason.
const MODEL = 'opus';
const OTHER_MODEL = 'claude-sonnet-5-thinking-high';

function withTeamsEnv(fn: () => void): void {
  const prev = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = prev;
  }
}

function setCurrentRunId(cwd: string, runId: string): void {
  const file = path.join(cwd, '.traffic-one', '.one.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  state.currentRunId = runId;
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  writeArchitectPhaseComplete(cwd, runId, state);
}

function spawnCtx(cwd: string, toolInput: Record<string, unknown>, sessionId: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: { tool_name: 'Task', tool_input: toolInput, session_id: sessionId },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function postSpawnCtx(cwd: string, toolInput: Record<string, unknown>, response: unknown, sessionId: string): Ctx {
  const input: HookInput = {
    event: 'PostToolUse',
    host: 'claude',
    cwd,
    raw: { tool_name: 'Task', tool_input: toolInput, tool_response: response, session_id: sessionId },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function liveEntry(agentId: string, model: string | null = MODEL): RunAgentEntry {
  return {
    agentId,
    resumeId: agentId,
    toolCallId: null,
    role: 'senior-backend',
    model,
    agentType: 'senior-backend',
    parentSessionId: 'parent-1',
    recordedAt: new Date().toISOString(),
    tasks: 1,
    replaced: false,
  };
}

// ── The verdict table ────────────────────────────────────────────────────────
// Every reachable combination of the three structural inputs the predicate
// reads. `bound` is the role's live-or-pending claim, `admits` is whether the
// run ledger would still accept a claim, `condemned` is whether the exhaustion
// ledger names THIS agent's model for THIS role.

interface Cell {
  bound: boolean;
  admits: boolean;
  condemned: boolean;
  expect: StructuralReplacementGround | null;
  why: string;
}

const TABLE: Cell[] = [
  { bound: false, admits: false, condemned: false, expect: 'unbindable-agent', why: 'holds nothing and can never hold anything' },
  { bound: false, admits: false, condemned: true, expect: 'unbindable-agent', why: 'unbindable is reported ahead of the condemned model' },
  { bound: false, admits: true, condemned: false, expect: null, why: 'claimless in an OPEN run may simply be mid-startup' },
  { bound: false, admits: true, condemned: true, expect: 'condemned-model', why: 'continuing it would re-hit the recorded limit' },
  { bound: true, admits: false, condemned: false, expect: null, why: 'a bound agent still owns the role slot in a closed run' },
  { bound: true, admits: false, condemned: true, expect: 'condemned-model', why: 'a condemned model is unusable even while bound' },
  { bound: true, admits: true, condemned: false, expect: null, why: 'a healthy bound agent is protected — this is the deny case' },
  { bound: true, admits: true, condemned: true, expect: 'condemned-model', why: 'the model, not the claim, is what is dead' },
];

test('structuralReplacementGround: every reachable combination of the structural inputs', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const seen: (StructuralReplacementGround | null)[] = [];
    TABLE.forEach((cell, index) => {
      const runId = `run-cell-${index}`;
      const role = 'senior-backend';
      const agentId = `agent-cell-${index}`;
      setCurrentRunId(cwd, runId);
      assert.ok(transitionRunStatus(cwd, runId, { status: 'active' }));
      if (cell.bound) {
        assert.ok(
          claimThreadRole(cwd, readEffectiveState(cwd), agentId, role, { parentSessionId: 'parent-1' }),
          `cell ${index}: fixture must bind the role`,
        );
      }
      if (!cell.admits) {
        assert.ok(transitionRunStatus(cwd, runId, { status: 'failed', outcome: 'agent-failed' }));
      }
      if (cell.condemned) recordExhaustedModel(cwd, runId, role, MODEL);

      // The fixture actually produced the state the row claims to test — without
      // this a row asserts against a cell it never reached.
      assert.equal(runRoleHasBoundClaim(cwd, runId, role), cell.bound, `cell ${index}: bound fixture`);
      assert.equal(runLedgerAdmitsClaims(cwd, runId), cell.admits, `cell ${index}: ledger fixture`);

      const ground = structuralReplacementGround(cwd, runId, role, liveEntry(agentId));
      assert.equal(ground, cell.expect, `cell ${index} (bound=${cell.bound} admits=${cell.admits} condemned=${cell.condemned}): ${cell.why}`);
      seen.push(ground);
    });

    // Each input is load-bearing: flipping it alone changes the verdict
    // somewhere, so no row passes regardless of what the predicate returns.
    assert.notEqual(seen[0], seen[4], 'the bound claim discriminates (row 0 vs row 4)');
    assert.notEqual(seen[0], seen[2], 'the ledger status discriminates (row 0 vs row 2)');
    assert.notEqual(seen[6], seen[7], 'the condemned model discriminates (row 6 vs row 7)');
    assert.equal(new Set(seen.map(String)).size, 3, 'all three verdicts are reachable');
  });
});

test('structuralReplacementGround: no live agent, no run, and no model are all "no ground"', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-nulls');
    assert.ok(transitionRunStatus(cwd, 'run-nulls', { status: 'active' }));
    assert.ok(transitionRunStatus(cwd, 'run-nulls', { status: 'failed', outcome: 'agent-failed' }));
    // The closed-run arm would fire for a live row, so these prove the guards
    // and not merely an absent ground.
    assert.equal(structuralReplacementGround(cwd, 'run-nulls', 'senior-backend', liveEntry('a')), 'unbindable-agent');
    assert.equal(structuralReplacementGround(cwd, 'run-nulls', 'senior-backend', null), null, 'no live agent');
    assert.equal(structuralReplacementGround(cwd, '', 'senior-backend', liveEntry('a')), null, 'no run id');
    assert.equal(structuralReplacementGround(cwd, 'run-nulls', '', liveEntry('a')), null, 'no role');
  });
});

test('structuralReplacementGround: another model condemned for the same role is not this agent\'s problem', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const runId = 'run-other-model';
    setCurrentRunId(cwd, runId);
    assert.ok(transitionRunStatus(cwd, runId, { status: 'active' }));
    assert.ok(claimThreadRole(cwd, readEffectiveState(cwd), 'a1', 'senior-backend', { parentSessionId: 'parent-1' }));
    recordExhaustedModel(cwd, runId, 'senior-backend', OTHER_MODEL);
    assert.equal(structuralReplacementGround(cwd, runId, 'senior-backend', liveEntry('a1', MODEL)), null,
      'the ledger names a DIFFERENT model; this child is still usable');
    assert.equal(
      structuralReplacementGround(cwd, runId, 'senior-backend', liveEntry('a1', OTHER_MODEL)),
      'condemned-model',
      'the same fixture DOES fire for the condemned model — the row above is not vacuous',
    );
  });
});

// ── The composition: liveRunAgent × structuralReplacementGround ──────────────
// The table above holds `live` fixed at a synthesized fresh entry, so it
// measures the replacement predicate alone. In the gate the two run in series —
// `structuralReplacementGround(cwd, runId, role, liveRunAgent(...))` — and the
// interesting claim is about the JOIN: the replacement predicate must never
// report a ground for a row liveness refused, and liveness must never change
// which ground a row it accepted gets. Neither table can see that on its own.

const PARENT = 'parent-1';
const OTHER_PARENT = 'a-different-orchestrator-session';

/** Every distinct reason liveRunAgent answers null, and both shapes in which it
 * answers with the row. Kept as reasons rather than examples: the exhaustive
 * product over these coordinates lives in state/__tests__/liveness-decay.test.ts,
 * and this file crosses one representative of each branch with the eight
 * structural states. */
const LIVENESS_ROWS: {
  name: string;
  live: boolean;
  arg: string | null;
  row: Record<string, unknown> | null;
}[] = [
  { name: 'no registry row at all', live: false, arg: PARENT, row: null },
  { name: 'the row is explicitly retired', live: false, arg: PARENT, row: { replaced: true, parentSessionId: PARENT, recordedAt: 'now' } },
  { name: 'the row belongs to another parent session', live: false, arg: OTHER_PARENT, row: { parentSessionId: PARENT, recordedAt: 'now' } },
  { name: 'the stamp is older than the staleness window', live: false, arg: PARENT, row: { parentSessionId: PARENT, recordedAt: 'stale' } },
  { name: 'the stamp is ahead of us past the skew allowance', live: false, arg: PARENT, row: { parentSessionId: PARENT, recordedAt: 'future' } },
  { name: 'the row carries no stamp', live: false, arg: PARENT, row: { parentSessionId: PARENT } },
  { name: 'fresh, and the caller has no session of its own', live: true, arg: null, row: { parentSessionId: PARENT, recordedAt: 'now' } },
  { name: 'fresh, and the parent sessions match', live: true, arg: PARENT, row: { parentSessionId: PARENT, recordedAt: 'now' } },
];

function stampValue(kind: unknown): string | undefined {
  if (kind === 'now') return new Date().toISOString();
  if (kind === 'stale') return new Date(Date.now() - (SUBAGENT_STALE_MS + 60_000)).toISOString();
  if (kind === 'future') return new Date(Date.now() + (STATE_TIMESTAMP_FUTURE_SKEW_MS + 60_000)).toISOString();
  return undefined;
}

function writeRegistryRow(cwd: string, runId: string, role: string, row: Record<string, unknown> | null, agentId: string): void {
  const dir = path.join(cwd, '.traffic-one', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agents.json');
  if (!row) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    agents: {
      [role]: {
        role,
        tasks: 1,
        replaced: false,
        agentId,
        resumeId: agentId,
        model: MODEL,
        ...row,
        recordedAt: stampValue(row.recordedAt),
      },
    },
  }), 'utf8');
}

/** The eight structural states of the table above, applied to a real run. */
function applyStructuralCell(cwd: string, runId: string, role: string, agentId: string, cell: Cell): void {
  setCurrentRunId(cwd, runId);
  assert.ok(transitionRunStatus(cwd, runId, { status: 'active' }));
  if (cell.bound) {
    assert.ok(
      claimThreadRole(cwd, readEffectiveState(cwd), agentId, role, { parentSessionId: PARENT }),
      `${runId}: fixture must bind the role`,
    );
  }
  if (!cell.admits) assert.ok(transitionRunStatus(cwd, runId, { status: 'failed', outcome: 'agent-failed' }));
  if (cell.condemned) recordExhaustedModel(cwd, runId, role, MODEL);
  assert.equal(runRoleHasBoundClaim(cwd, runId, role), cell.bound, `${runId}: bound fixture`);
  assert.equal(runLedgerAdmitsClaims(cwd, runId), cell.admits, `${runId}: ledger fixture`);
}

test('composition: no structural ground is ever reported for a row liveness refused', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const role = 'senior-backend';
    const verdicts: (StructuralReplacementGround | null)[][] = [];
    // Collected rather than thrown at the first disagreement: a table that
    // reports one cell cannot answer "which cells did this change break?", which
    // is the only question a mutation is run to answer.
    const failures: string[] = [];
    LIVENESS_ROWS.forEach((liveness, livenessIndex) => {
      const perLiveness: (StructuralReplacementGround | null)[] = [];
      TABLE.forEach((cell, cellIndex) => {
        const runId = `run-join-${livenessIndex}-${cellIndex}`;
        const agentId = `agent-join-${livenessIndex}-${cellIndex}`;
        const where = `[${liveness.name}] x [bound=${cell.bound} admits=${cell.admits} condemned=${cell.condemned}]`;
        applyStructuralCell(cwd, runId, role, agentId, cell);
        // AFTER the claim, so a claim that mirrors itself into the registry
        // cannot decide this row's liveness coordinates for us.
        writeRegistryRow(cwd, runId, role, liveness.row, agentId);

        const live = liveRunAgent(cwd, runId, role, liveness.arg);
        const ground = structuralReplacementGround(cwd, runId, role, live);
        perLiveness.push(ground);
        try {
          assert.equal(live !== null, liveness.live, `${where}: PRECONDITION: the liveness fixture produced the branch it names`);
          if (live) assert.equal(live.model, MODEL, `${where}: PRECONDITION: the live row carries the model the ledger can condemn`);
          assert.equal(
            ground,
            liveness.live ? cell.expect : null,
            `${where}: ${liveness.live ? cell.why : 'liveness refused this row, so there is nothing to find grounds against'}`,
          );
        } catch (err) {
          failures.push(err instanceof assert.AssertionError ? String(err.message).split('\n')[0]! : `${where}: threw ${String(err)}`);
        }
      });
      verdicts.push(perLiveness);
    });
    if (failures.length) {
      assert.fail(`${failures.length} of ${LIVENESS_ROWS.length * TABLE.length} cells disagree:\n  ${failures.join('\n  ')}`);
    }

    // NON-VACUITY. The forty-eight nulls above prove something about liveness
    // only because the SAME structural fixtures do produce grounds once the row
    // is live: five of the eight states are non-null, twice.
    assert.equal(
      verdicts.flat().filter((ground) => ground !== null).length,
      2 * TABLE.filter((cell) => cell.expect !== null).length,
      'the structural states are still live-firing; without this the null column could be an inert fixture',
    );
    // And liveness decides WHETHER, never WHICH: the two live shapes agree with
    // each other and with the isolated table.
    const [freshNoSession, freshMatched] = [verdicts[6]!, verdicts[7]!];
    assert.deepEqual(freshNoSession, TABLE.map((cell) => cell.expect), 'an accepted row gets the isolated table\'s verdicts');
    assert.deepEqual(freshMatched, freshNoSession, 'and which liveness branch accepted it changes nothing');
  });
});

// ── Gate-level: what the structural ground actually buys ─────────────────────

// MUTATION PROOF for the `condemned-model` ground. Delete that arm from
// structuralReplacementGround and this fails: the gate denies with
// `agent-reuse-continue`, telling the orchestrator to keep talking to an agent
// whose model the run has already recorded as out of budget.
test('reuse: a live agent whose model is durably condemned may be replaced without failure vocabulary', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      const runId = 'run-condemned-model';
      setCurrentRunId(cwd, runId);
      assert.ok(transitionRunStatus(cwd, runId, { status: 'active' }));
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: MODEL, prompt: 'build the API' },
        'agentId: backend11aa22bb33',
        'parent-1',
      ));
      assert.ok(claimThreadRole(cwd, readEffectiveState(cwd), 'backend11aa22bb33', 'senior-backend', {
        parentSessionId: 'parent-1',
      }));
      // Durable evidence, written by the recorder — not by this prompt.
      recordExhaustedModel(cwd, runId, 'senior-backend', MODEL);

      const replacement = agentModelGate(spawnCtx(
        cwd,
        // No failure vocabulary at all: the prose predicate answers false here.
        { subagent_type: 'senior-backend', model: MODEL, prompt: 'respawn the backend [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(replacementJustified('respawn the backend [t1-replace-agent]', 'claude'), false,
        'the prose predicate does NOT carry this case — the structural ground does');
      assert.notEqual(replacement.kind, 'deny',
        'an agent on a condemned model must not be protected by the reuse gate');
      assert.equal(readRunAgentRegistry(cwd, runId)['senior-backend']?.replaced, true);
    });
  });
});

// The other side of the same fixture: without the condemnation the identical
// prompt is refused, so the row above is not passing for an unrelated reason.
test('reuse: the same claimless-free healthy agent IS protected when no model is condemned', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      const runId = 'run-condemned-control';
      setCurrentRunId(cwd, runId);
      assert.ok(transitionRunStatus(cwd, runId, { status: 'active' }));
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: MODEL, prompt: 'build the API' },
        'agentId: backend44cc55dd66',
        'parent-1',
      ));
      assert.ok(claimThreadRole(cwd, readEffectiveState(cwd), 'backend44cc55dd66', 'senior-backend', {
        parentSessionId: 'parent-1',
      }));

      const denied = agentModelGate(spawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: MODEL, prompt: 'respawn the backend [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(denied.kind, 'deny');
      if (denied.kind === 'deny') assert.ok(denied.reason.includes('backend44cc55dd66'), 'denied BY THE REUSE GATE');
      assert.equal(readRunAgentRegistry(cwd, runId)['senior-backend']?.replaced, false);
    });
  });
});

// MUTATION PROOF for the SKILL.md/predicate vocabulary mismatch. Restore
// `context exhausted` as the only accepted spelling and this fails: the gate
// prescribes replacing an agent whose "replies show context exhaustion"
// (skill/SKILL.md agent-reuse-continue, step 4) and then refuses that exact
// phrase.
test('reuse: the phrase SKILL.md prescribes — "context exhaustion" — is accepted', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      const runId = 'run-context-exhaustion';
      setCurrentRunId(cwd, runId);
      assert.ok(transitionRunStatus(cwd, runId, { status: 'active' }));
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: MODEL, prompt: 'build the UI' },
        'agentId: frontend77ee88ff99',
        'parent-1',
      ));
      assert.ok(claimThreadRole(cwd, readEffectiveState(cwd), 'frontend77ee88ff99', 'senior-frontend', {
        parentSessionId: 'parent-1',
      }));
      // Healthy, bound, open run, uncondemned model: no structural ground exists,
      // so this row measures the prose backstop and nothing else.
      assert.equal(
        structuralReplacementGround(cwd, runId, 'senior-frontend', liveEntry('frontend77ee88ff99')),
        null,
        'no structural ground here — the assertion below is about the prose arm',
      );

      const prompt = '[t1-replace-agent]\nIts replies show context exhaustion; re-spawn the frontend.';
      const replacement = agentModelGate(spawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: MODEL, prompt },
        'parent-1',
      ));
      assert.notEqual(replacement.kind, 'deny', 'the gate must accept the wording its own skill prescribes');
      assert.equal(readRunAgentRegistry(cwd, runId)['senior-frontend']?.replaced, true);
    });
  });
});

// ── The prose backstop, measured in both directions ──────────────────────────

const ACCEPTED: [string, string][] = [
  ['the SKILL.md-prescribed phrase', 'its replies show context exhaustion'],
  ['the older spelling still works', 'the previous agent context exhausted'],
  ['exhausted its context', 'the child exhausted its context'],
  ['out of context', 'the subagent is out of context'],
  ['context limit', 'the agent hit its context limit'],
  ['the SKILL.md-quoted continuation error', 'agent not found'],
  ['a REAL continuation error, with the id interpolated', 'Agent 019f8fa1-4444-7000-8000-0000000000aa not found'],
  ['no agent found with that id', 'No agent found with id 019f8fa1'],
  ['could not find the agent', 'Could not find the agent with the provided id'],
  ['the agent does not exist', 'The specified subagent does not exist'],
  ['the agent is no longer available', 'That agent is no longer available'],
  ['resume failed', 'resume failed for the recorded id'],
  ['unable to continue', 'unable to continue the previous agent'],
  ['a death word predicated of the agent', 'the previous agent is dead'],
  ['a stopped subagent', 'Previous architect subagent stopped (API usage limit).'],
  ['an unresponsive agent, no subject needed', 'unresponsive'],
  ['api usage limit', 'API usage limit reached'],
];

const REFUSED: [string, string][] = [
  ['a plain continuation request', 'Continue the remaining backend scope.'],
  ['a bare replacement request', 'fresh copy'],
  ['"dead" about SOURCE CODE, not the agent', 'Remove the dead code in utils.ts'],
  ['"closed" about an ISSUE, not the agent', 'The GitHub issue was closed'],
  ['"stale" about a CACHE, not the agent', 'The cache is stale, please refresh it'],
  ['"stopped" about the BUILD, not the agent', 'The build stopped at the review step, so respawn'],
  ['"aborted" about a MIGRATION, not the agent', 'The migration was aborted; re-run it'],
  ['a negated limit report', 'No API limit was reached; continue.'],
];

test('replacementJustified: accepts every failure an orchestrator can actually describe', () => {
  for (const [name, prompt] of ACCEPTED) {
    assert.equal(replacementJustified(prompt, 'cursor'), true, `must accept — ${name}: ${JSON.stringify(prompt)}`);
  }
});

// MUTATION PROOF for the bare-word narrowing. Restore the old alternation
// (`…|unresponsive|dead|stale|closed|stopped|aborted|interrupted`) and the four
// middle rows fail: a death word with no subject made `[t1-replace-agent]`
// satisfiable by prose about source code, issues, caches and builds, which is
// what "the marker is an unconditional bypass" looks like in practice.
test('replacementJustified: a death word about something OTHER than the agent is not evidence', () => {
  for (const [name, prompt] of REFUSED) {
    assert.equal(replacementJustified(prompt, 'cursor'), false, `must refuse — ${name}: ${JSON.stringify(prompt)}`);
  }
});

test('replacementJustified: the opencode/kilo/windsurf arm stays host-scoped', () => {
  const prompt = 'Previous OpenCode agent completed. Follow-up fix cycle: fix build errors only.';
  assert.equal(replacementJustified(prompt, 'opencode'), true);
  assert.equal(replacementJustified(prompt, 'kilo'), true);
  assert.equal(replacementJustified(prompt, 'windsurf'), true);
  // On a continuation-capable host the same text must not retire an agent: the
  // host-scoped arm is the only thing that accepts it.
  assert.equal(replacementJustified(prompt, 'cursor'), false);
  assert.equal(replacementJustified(prompt, 'claude'), false);
});
