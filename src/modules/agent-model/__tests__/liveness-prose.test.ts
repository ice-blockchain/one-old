// The prose the liveness decision RENDERS.
//
// state/__tests__/liveness-decay.test.ts enumerates what `liveRunAgent`
// answers, and structural-replacement.test.ts joins that answer to the
// replacement predicate. Neither reaches the text the orchestrator actually
// receives, and that text is the whole product of the gate: a deny whose reason
// is empty still blocks the spawn (kind stays `deny`) while telling the model
// nothing about what to do instead, which is indistinguishable from a hang.
//
// Two things make that reachable rather than theoretical. `block('agent-reuse-
// continue', …)` in gate-reuse.ts is called with NO verbatim TypeScript
// fallback — unlike the cursor-failure blocks, which cursor-prose.test.ts pins
// byte-for-byte against `CURSOR_FAILURE_BLOCK_FALLBACKS` — and the SKILL.md
// block-existence guard in shared/__tests__/skill-block-coverage.test.ts covers
// `onboarding-gate` only. So a renamed or deleted `T1BLOCK` in this module's
// SKILL.md degrades every reuse deny to `''` with nothing failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import {
  liveRunAgent,
  observeCodexChildModel,
  readRunAgentRegistry,
  recordRunAgent,
  transitionRunStatus,
} from '../../../shared/state';
import { extractBlock } from '../../../shared/skill-block';
import { holdRunLock, runLockDir } from '../../../shared/state/__tests__/owned-lock-fixture';
import {
  STATE_TIMESTAMP_FUTURE_SKEW_MS,
  SUBAGENT_STALE_MS,
} from '../../../config/state';
import { writeArchitectPhaseComplete } from '../../plan-guard/__tests__/architect-phase-fixtures';
import type { Ctx, HookInput, HookResult, ToolClass } from '../../../core/types';
import { freezeRunPolicy, withMaterialized } from './agent-model-fixtures';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MODULE_SKILL = path.join(REPO_ROOT, 'src', 'modules', 'agent-model', 'skill', 'SKILL.md');

const ROLE = 'senior-backend';
const MODEL = 'opus';
const PARENT = 'parent-1';
const OTHER_PARENT = 'a-different-orchestrator-session';
const MARKER = '[t1-replace-agent]';

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

function spawnCtx(cwd: string, toolInput: Record<string, unknown>, host: 'claude' | 'codex' = 'claude'): Ctx {
  const rawName = host === 'codex' ? 'multi_agent_v1.spawn_agent' : 'Task';
  const input: HookInput = {
    event: 'PreToolUse',
    host,
    cwd,
    raw: { tool_name: rawName, tool_input: toolInput, session_id: host === 'codex' ? 'parent-thread-1' : PARENT },
    tool: { class: 'spawn-agent' as ToolClass, rawName },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

function registryRow(cwd: string, runId: string, role: string, row: Record<string, unknown> | null, agentId: string): void {
  const dir = path.join(cwd, '.traffic-one', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agents.json');
  if (!row) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    agents: { [role]: { role, tasks: 1, replaced: false, agentId, resumeId: agentId, model: MODEL, ...row } },
  }), 'utf8');
}

const now = (): string => new Date().toISOString();
const stale = (): string => new Date(Date.now() - (SUBAGENT_STALE_MS + 60_000)).toISOString();
const future = (): string => new Date(Date.now() + (STATE_TIMESTAMP_FUTURE_SKEW_MS + 60_000)).toISOString();

// ── The matrix, at the surface the orchestrator sees ─────────────────────────
// The same eight liveness branches the join table crosses, now driven through
// agentModelGate so the assertion is about rendered text rather than a return
// value. `arg` is fixed by the hook payload's session id, so the two live rows
// differ in whether the ROW names a parent at all.

const LIVENESS_ROWS: { name: string; live: boolean; row: Record<string, unknown> | null }[] = [
  { name: 'no registry row at all', live: false, row: null },
  { name: 'the row is explicitly retired', live: false, row: { replaced: true, parentSessionId: PARENT, recordedAt: now() } },
  { name: 'the row belongs to another parent session', live: false, row: { parentSessionId: OTHER_PARENT, recordedAt: now() } },
  { name: 'the stamp is older than the staleness window', live: false, row: { parentSessionId: PARENT, recordedAt: stale() } },
  { name: 'the stamp is ahead of us past the skew allowance', live: false, row: { parentSessionId: PARENT, recordedAt: future() } },
  { name: 'the row carries no stamp', live: false, row: { parentSessionId: PARENT } },
  { name: 'fresh, and the row names no parent session', live: true, row: { parentSessionId: null, recordedAt: now() } },
  { name: 'fresh, and the parent sessions match', live: true, row: { parentSessionId: PARENT, recordedAt: now() } },
];

// The three ways a spawn arrives at the reuse gate. `ground` closes the run's
// ledger before the row exists, which is the `unbindable-agent` ground — the one
// structural ground reachable without any orchestrator prose at all.
const MODES: { name: string; marker: boolean; ground: boolean; denyWhenLive: boolean }[] = [
  { name: 'a duplicate spawn with no marker', marker: false, ground: false, denyWhenLive: true },
  { name: 'the marker with no failure vocabulary and no structural ground', marker: true, ground: false, denyWhenLive: true },
  { name: 'the marker over an unbindable agent in a closed run', marker: true, ground: true, denyWhenLive: false },
];

test('the liveness matrix renders exactly one deny, and it is fully interpolated', () => {
  const skill = fs.readFileSync(MODULE_SKILL, 'utf8');
  const template = extractBlock(skill, 'agent-reuse-continue');
  assert.notEqual(template, null, 'PRECONDITION: the block this gate renders exists — every assertion below is vacuous without it');

  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      const observed: { cell: string; denied: boolean }[] = [];
      // Collected rather than thrown at the first disagreement, so a mutation
      // reports every cell it broke instead of whichever the loop reached first.
      const failures: string[] = [];
      const record = (cell: string, body: () => void): void => {
        try {
          body();
        } catch (err) {
          failures.push(err instanceof assert.AssertionError ? String(err.message).split('\n')[0]! : `${cell}: threw ${String(err)}`);
        }
      };
      LIVENESS_ROWS.forEach((liveness, livenessIndex) => {
        MODES.forEach((mode, modeIndex) => {
          const runId = `run-prose-${livenessIndex}-${modeIndex}`;
          const agentId = `agent-prose-${livenessIndex}-${modeIndex}`;
          const cell = `[${liveness.name}] x [${mode.name}]`;
          setCurrentRunId(cwd, runId);
          assert.ok(transitionRunStatus(cwd, runId, { status: 'active' }));
          if (mode.ground) assert.ok(transitionRunStatus(cwd, runId, { status: 'failed', outcome: 'agent-failed' }));
          registryRow(cwd, runId, ROLE, liveness.row, agentId);

          const wasLive = liveRunAgent(cwd, runId, ROLE, PARENT) !== null;
          const result: HookResult = agentModelGate(spawnCtx(cwd, {
            subagent_type: ROLE,
            model: MODEL,
            prompt: mode.marker ? `respawn the backend ${MARKER}` : 'build the rest of the API',
          }));
          const expectDeny = liveness.live && mode.denyWhenLive;
          observed.push({ cell, denied: result.kind === 'deny' });

          record(cell, () => {
            assert.equal(wasLive, liveness.live, `${cell}: PRECONDITION: the fixture reached the liveness branch it names`);

            if (!expectDeny) {
              assert.notEqual(result.kind, 'deny', `${cell}: nothing here justifies refusing the spawn`);
              if (mode.marker && liveness.row) {
                // POSITIVE ARTIFACT. `kind !== 'deny'` is also what an unrelated
                // gate returning noop looks like; the retirement proves the reuse
                // phase ran to its end.
                assert.equal(
                  readRunAgentRegistry(cwd, runId)[ROLE]?.replaced,
                  true,
                  `${cell}: the marker path retired the row, so the gate really reached the reuse phase`,
                );
              }
              return;
            }

            assert.equal(result.kind, 'deny', `${cell}: a live agent must not be duplicated`);
            if (result.kind !== 'deny') return;
            assert.equal(result.denyId, 'agent-reuse-continue', `${cell}: denied by the REUSE gate, not another one`);
            assert.equal(result.denyTarget, ROLE, `${cell}: the deny names the role it is about`);
            assert.ok(result.reason.trim().length > 0, `${cell}: an empty deny reason blocks the spawn and instructs nothing`);
            assert.doesNotMatch(result.reason, /\{\{[A-Z_]+\}\}/, `${cell}: every template variable was supplied`);
            assert.ok(
              result.reason.includes(`run ${runId} already has a LIVE \`${ROLE}\` agent — id \`${agentId}\``),
              `${cell}: the deny names the run, the role and the agent to continue`,
            );
            assert.ok(
              result.reason.includes(`Call \`SendMessage\` with \`to: "${agentId}"\``),
              `${cell}: and the host-correct continuation call, with the id interpolated`,
            );
            assert.ok(result.reason.includes(MARKER), `${cell}: and the escape hatch, so the deny is not a dead end`);
            assert.equal(
              readRunAgentRegistry(cwd, runId)[ROLE]?.replaced,
              false,
              `${cell}: a protected row is not retired on the way out`,
            );
          });
        });
      });
      if (failures.length) {
        assert.fail(`${failures.length} of ${LIVENESS_ROWS.length * MODES.length} cells disagree:\n  ${failures.join('\n  ')}`);
      }

      // NON-VACUITY across the table. Each mode column must contain BOTH
      // outcomes, keyed only by liveness — otherwise a column that never denies
      // (or always denies) is measuring the mode, not the liveness decision.
      MODES.forEach((mode, modeIndex) => {
        const column = observed.filter((_, index) => index % MODES.length === modeIndex);
        assert.equal(column.length, LIVENESS_ROWS.length, `${mode.name}: the column is complete`);
        assert.equal(
          column.filter((entry) => entry.denied).length,
          mode.denyWhenLive ? LIVENESS_ROWS.filter((row) => row.live).length : 0,
          `${mode.name}: liveness alone decides this column`,
        );
      });
    });
  });
});

// ── Block-existence conformance ──────────────────────────────────────────────

test('every agent-model block the gate renders exists in the module SKILL.md', () => {
  // The onboarding-gate equivalent of this guard lives in
  // shared/__tests__/skill-block-coverage.test.ts and covers three files there.
  // This module's reuse denies pass no verbatim fallback, so a missing block
  // here is silent at runtime: `deny('')` is still a deny.
  const skill = fs.readFileSync(MODULE_SKILL, 'utf8');
  const sources = fs.readdirSync(path.join(REPO_ROOT, 'src', 'modules', 'agent-model'))
    .filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length >= 10, `expected the module's TypeScript sources, found ${sources.length}`);

  const referenced = new Set<string>();
  const re = /(?<![A-Za-z0-9_])block\(\s*'([a-z0-9-]+)'/g;
  for (const name of sources) {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'modules', 'agent-model', name), 'utf8');
    for (const match of text.matchAll(re)) referenced.add(match[1]!);
  }
  assert.ok(referenced.has('agent-reuse-continue'), 'PRECONDITION: the scan found the reuse deny this file is about');
  assert.ok(referenced.size >= 5, `expected to discover the module's block refs, found ${referenced.size}`);

  const missing = [...referenced].filter((name) => extractBlock(skill, name) === null).sort();
  assert.deepEqual(missing, [], `agent-model SKILL.md is missing referenced blocks:\n${missing.join('\n')}`);
});

// ── The inherited codex-lock prose gap ───────────────────────────────────────
// A held registry lock is a TRANSIENT contention, and the gate says so in prose:
// `agent-reuse-await-codex-meta` offers two causes ("a child rollout that has
// not flushed yet, or a registry row another process held while this hook ran")
// and prescribes waiting for neither specifically. Only the first cause has ever
// been driven end to end; the second was asserted at the store
// (state/__tests__/run-agent.test.ts) and the interpolation asserted separately
// from a run whose reason was `codex-observed-model-missing`. The two halves
// never met, so nothing pinned that a contended lock reaches this deny AT ALL —
// and it reaches it through a different status (`conflict`, not `unverified`),
// down a branch the interpolation test never exercised.

const CODEX_CHILD = '019f69fe-e335-7de0-be43-1ee45e3535c7';
const CODEX_MODEL = 'gpt-5.6-sol';
const CODEX_ROLE = 'senior-architect';

function codexSessionMeta(childThread: string, parentThread: string, agentPath: string): Record<string, unknown> {
  return {
    timestamp: '2026-07-16T08:15:39.909Z',
    type: 'session_meta',
    payload: {
      id: childThread,
      parent_thread_id: parentThread,
      thread_source: 'subagent',
      agent_path: agentPath,
      source: { subagent: { thread_spawn: { parent_thread_id: parentThread, agent_path: agentPath } } },
    },
  };
}

test('a contended registry lock reaches the await-codex-meta deny and names itself in the prose', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const runId = 'run-codex-lock-prose';
    const parentThread = 'parent-thread-1';
    // The child rollout lives in the project dir and is named on the registry
    // row, which is the path findCodexTranscriptForEntry takes FIRST — so this
    // needs no isolated CODEX_HOME and never reads the developer's own
    // ~/.codex/sessions.
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${CODEX_CHILD}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify(codexSessionMeta(CODEX_CHILD, parentThread, '/root/senior_architect'))}\n`, 'utf8');
    setCurrentRunId(cwd, runId);
    freezeRunPolicy(cwd, 'codex', runId);
    assert.equal(observeCodexChildModel(cwd, runId, {
      childId: CODEX_CHILD,
      parentSessionId: parentThread,
      actualModel: CODEX_MODEL,
      role: CODEX_ROLE,
      source: 'SubagentStart',
    })?.status, 'verified');
    recordRunAgent(cwd, runId, CODEX_ROLE, {
      agentId: CODEX_CHILD,
      parentSessionId: parentThread,
      transcriptPath: transcript,
      model: CODEX_MODEL,
    });

    const spawn = (): HookResult => agentModelGate(spawnCtx(cwd, {
      task_name: 'senior_architect',
      message: '[t1-role: senior-architect]\nContinue the bounded architecture task.',
      model: CODEX_MODEL,
      fork_turns: 'none',
    }, 'codex'));

    // THE FREE HALF, and it is not optional: with the lock free this row
    // verifies and routes to continuation. Without it the contended half below
    // could be measuring a fixture that never verified the child in the first
    // place, which produces the SAME deny under a different reason.
    const free = spawn();
    assert.equal(free.kind, 'deny');
    if (free.kind === 'deny') {
      assert.equal(free.denyId, 'agent-reuse-continue', 'with the lock free this is a verified reuse');
      assert.doesNotMatch(free.reason, /cannot verify that child's role/i);
    }

    holdRunLock(cwd, runId, 'registry');
    const started = Date.now();
    const contended = spawn();
    const elapsed = Date.now() - started;

    assert.equal(contended.kind, 'deny');
    if (contended.kind === 'deny') {
      assert.equal(contended.denyId, 'agent-reuse-await-codex-meta', 'a contended lock must not read as a verified reuse');
      assert.ok(contended.reason.trim().length > 0, 'an empty reason would still be a deny and would instruct nothing');
      assert.doesNotMatch(contended.reason, /\{\{[A-Z_]+\}\}/, 'every template variable was supplied');
      // The interpolation the previous lane judged already covered was covered
      // for ONE reason string. This is the other one, and it arrives by a
      // different status.
      assert.ok(
        contended.reason.includes('codex-registry-evidence-lock-unavailable'),
        'the deny names the transient cause verbatim, not a generic verification failure',
      );
      assert.ok(
        contended.reason.includes(`fresh Codex \`${CODEX_ROLE}\` registry row for child \`${CODEX_CHILD}\``),
        'and the row it is about',
      );
      assert.match(
        contended.reason,
        /a registry row another process held while this hook ran/,
        'the sentence that exists FOR this cause must be present when this cause fires',
      );
      assert.match(contended.reason, /clear without your intervention/, 'and it must be described as transient');
    }
    assert.ok(elapsed >= 3_000, `expected two bounded registry-lock timeouts, got ${elapsed}ms — the lock was not actually contended`);
    assert.equal(
      readRunAgentRegistry(cwd, runId)[CODEX_ROLE]?.replaced,
      false,
      'a child whose role was just proven is never retired over two seconds of contention',
    );

    // Releasing the lock restores the verified reuse: the deny above was the
    // lock and nothing that the two spawns before it left behind.
    fs.rmSync(runLockDir(cwd, runId, 'registry'), { recursive: true, force: true });
    const released = spawn();
    assert.equal(released.kind, 'deny');
    if (released.kind === 'deny') assert.equal(released.denyId, 'agent-reuse-continue', 'the contention was the only cause');
  });
});
