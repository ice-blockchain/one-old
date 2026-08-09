// The quick-fix scope regrant: what a duplicate spawn's `[t1-bounded-scope]`
// marker is allowed to change, what it must not, and what the orchestrator is
// told in each case.
//
// The gap this closes was measured before it was closed: a second `quick-fix`
// spawn carrying a WIDER marker is refused by the reuse gate BEFORE allowSpawn
// runs, so the marker was discarded, the live agent's WorkUnitContract stayed
// exactly as it was, and the only route left to a scope change was
// `[t1-replace-agent]` — destroying a live agent's context to widen its
// allowlist.
//
// The load-bearing assertion in this file is not any single behaviour but the
// PAIRING: the gate that OFFERS a regrant and the publisher that ENFORCES what
// may be published must ask the same question. `fallbackContractMatches`
// returns true unconditionally exactly when
// `!roleOwesPendingMaintenanceFallback`, and the offer is gated on that same
// predicate. If the two ever drift, the gate promises a widening the publisher
// refuses (or, worse, offers one it should not), and a divergence pair is
// exactly the defect class this surface keeps closing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { readActiveRunBootstrap } from '../../../shared/run-bootstrap-policy';
import {
  fallbackContractMatches,
  roleOwesPendingMaintenanceFallback,
} from '../../../shared/run-bootstrap-policy/envelope-io';
import type { WorkUnitContractV1 } from '../../../shared/architecture-contract';
import { recordRunAgent } from '../../../shared/state';
import { extractBlock } from '../../../shared/skill-block';
import {
  AGENT_REUSE_SCOPE_REGRANT_FALLBACK,
  AGENT_REUSE_SCOPE_REGRANT_REFUSED_FALLBACK,
} from '../handler-prose';
import { writeArchitectPhaseComplete } from '../../plan-guard/__tests__/architect-phase-fixtures';
import type { Ctx, HookInput, HookResult, ToolClass } from '../../../core/types';
import { withMaterialized } from './agent-model-fixtures';

const PARENT = 'parent-1';
const ROLE = 'quick-fix';
const AGENT = 'agent-quick-fix-1';
const MODEL = 'haiku';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MODULE_SKILL = path.join(REPO_ROOT, 'src', 'modules', 'agent-model', 'skill', 'SKILL.md');

const NARROW = '[t1-bounded-scope: {"outputs":["src/a.ts"],"allowlist":["src/a.ts"],"exclude":[]}]';
const WIDER = '[t1-bounded-scope: {"outputs":["src/a.ts","src/b.ts"],"allowlist":["src/a.ts","src/b.ts"],"exclude":[]}]';

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

function spawnCtx(cwd: string, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: { tool_name: 'Task', tool_input: toolInput, session_id: PARENT },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function spawn(cwd: string, prompt: string, role = ROLE, model = MODEL): HookResult {
  return agentModelGate(spawnCtx(cwd, { subagent_type: role, model, prompt }));
}

function currentRunId(cwd: string): string {
  const one = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')) as { currentRunId?: string };
  return String(one.currentRunId ?? '');
}

/**
 * An assignment-less maintenance project with a LIVE quick-fix agent bound to a
 * NARROW bounded envelope — the exact state the gap was observed in. Returns the
 * run id and the envelope hash the live agent holds.
 */
function withLiveNarrowQuickFix(fn: (cwd: string, runId: string, narrowHash: string) => void): void {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    withTeamsEnv(() => {
      const onePath = path.join(cwd, '.traffic-one', '.one.json');
      const one = JSON.parse(fs.readFileSync(onePath, 'utf8')) as Record<string, unknown>;
      one.mode = 'existing-codebase';
      one.lifecycle = { phase: 'maintenance', source: 'test' };
      fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

      const first = spawn(cwd, NARROW);
      assert.equal(first.kind, 'noop', first.kind === 'deny' ? first.reason : 'PRECONDITION: the first bounded spawn is admitted');
      const runId = currentRunId(cwd);
      const narrow = readActiveRunBootstrap(cwd, runId, ROLE);
      assert.deepEqual(
        narrow?.workUnit.allowlist,
        [`.traffic-one/digests/${runId}/quick-fix.md`, 'src/a.ts'],
        'PRECONDITION: the live agent holds the NARROW contract',
      );
      recordRunAgent(cwd, runId, ROLE, { agentId: AGENT, parentSessionId: PARENT, model: MODEL });
      fn(cwd, runId, narrow!.envelopeHash);
    });
  });
}

// ── the regrant itself ───────────────────────────────────────────────────────

test('a duplicate quick-fix spawn carrying a wider scope widens the LIVE agent and still refuses the spawn', () => {
  withLiveNarrowQuickFix((cwd, runId, narrowHash) => {
    const second = spawn(cwd, WIDER);

    assert.equal(second.kind, 'deny', 'the duplicate spawn is still refused — a regrant authorises no second agent');
    if (second.kind !== 'deny') return;
    assert.equal(second.denyId, 'agent-reuse-scope-regrant');
    assert.equal(second.denyTarget, ROLE);
    assert.doesNotMatch(second.reason, /\{\{[A-Z_]+\}\}/, 'every template variable was supplied');
    assert.ok(second.reason.includes(`already has a LIVE \`${ROLE}\` agent — id \`${AGENT}\``),
      'the deny points at the agent to continue, not at a respawn');
    assert.ok(second.reason.includes('these 2 file(s): src/a.ts, src/b.ts'),
      'and names the scope the contract now carries');
    assert.ok(second.reason.includes(`Call \`SendMessage\` with \`to: "${AGENT}"\``),
      'ending in an action the ORCHESTRATOR can take, on the agent it already has');

    const widened = readActiveRunBootstrap(cwd, runId, ROLE);
    assert.notEqual(widened?.envelopeHash, narrowHash, 'the contract really was republished');
    assert.deepEqual(widened?.workUnit.allowlist, [
      `.traffic-one/digests/${runId}/quick-fix.md`,
      'src/a.ts',
      'src/b.ts',
    ]);
    assert.deepEqual(widened?.workUnit.outputs, [
      `.traffic-one/digests/${runId}/quick-fix.md`,
      'src/a.ts',
      'src/b.ts',
    ]);
  });
});

test('re-sending the SAME scope announces no regrant — nothing was granted', () => {
  withLiveNarrowQuickFix((cwd, runId, narrowHash) => {
    const again = spawn(cwd, NARROW);
    assert.equal(again.kind, 'deny');
    if (again.kind !== 'deny') return;
    assert.equal(
      again.denyId, 'agent-reuse-continue',
      'an unchanged envelope is not a scope change, and claiming one would be a lie the orchestrator acts on',
    );
    assert.equal(readActiveRunBootstrap(cwd, runId, ROLE)?.envelopeHash, narrowHash);
  });
});

test('a duplicate spawn with NO scope marker is the ordinary continue deny', () => {
  withLiveNarrowQuickFix((cwd, runId, narrowHash) => {
    const bare = spawn(cwd, 'keep going on the fix');
    assert.equal(bare.kind, 'deny');
    if (bare.kind !== 'deny') return;
    assert.equal(bare.denyId, 'agent-reuse-continue');
    assert.equal(readActiveRunBootstrap(cwd, runId, ROLE)?.envelopeHash, narrowHash);
  });
});

test('a run with a COMPILED architecture never lets the marker override it', () => {
  withLiveNarrowQuickFix((cwd, runId, narrowHash) => {
    // The compiled contract is the run's authority over what each role may
    // build. A marker that could widen past it would let an orchestrator grant
    // scope from prose in exactly the run shape that has a real plan.
    const one = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')) as Record<string, unknown>;
    writeArchitectPhaseComplete(cwd, runId, one);

    const second = spawn(cwd, WIDER);
    assert.equal(second.kind, 'deny');
    if (second.kind !== 'deny') return;
    assert.equal(second.denyId, 'agent-reuse-continue', 'no regrant is offered where a compiled authority exists');
    assert.equal(readActiveRunBootstrap(cwd, runId, ROLE)?.envelopeHash, narrowHash, 'and nothing was republished');
  });
});

test('a senior implementer in a COMPILED run carrying the same marker gets no regrant', () => {
  // `quickFixScopeFromSpawn` is consulted for `quick-fix` ONLY, so for a senior
  // role the marker is not the origin of anything — its bounded envelope comes
  // from a pending OpenCode fallback debt, and widening THAT is what
  // fallbackContractMatches exists to refuse.
  //
  // MEASURED, and it is why the sibling case below exists: in the DEFAULT
  // fixture a senior implementer only exists once the architect phase has
  // compiled assignments, so what actually refuses this spawn is the
  // compiled-architecture guard, not the role guard. Keep both cases: this one
  // pins the compiled run, the next one pins the run shape where the role guard
  // is the only thing left.
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      const runId = currentRunId(cwd);
      const first = spawn(cwd, 'build the API', 'senior-backend', 'opus');
      assert.equal(first.kind, 'noop', first.kind === 'deny' ? first.reason : undefined);
      const before = readActiveRunBootstrap(cwd, runId, 'senior-backend')?.envelopeHash;
      assert.ok(before, 'PRECONDITION: the senior role holds a published envelope');
      recordRunAgent(cwd, runId, 'senior-backend', { agentId: 'agent-be-1', parentSessionId: PARENT, model: 'opus' });

      const second = spawn(cwd, `continue\n${WIDER}`, 'senior-backend', 'opus');
      assert.equal(second.kind, 'deny');
      if (second.kind !== 'deny') return;
      assert.equal(second.denyId, 'agent-reuse-continue');
      assert.equal(readActiveRunBootstrap(cwd, runId, 'senior-backend')?.envelopeHash, before);
    });
  });
});

test('the only NON-quick-fix role that can be live in an assignment-less run gets no regrant either', () => {
  // In the exact run shape the regrant is offered in — no compiled
  // architecture, no runtime assignments — `senior-architect` is the one other
  // role whose first spawn is admitted at all. (Measured: senior-backend and
  // senior-frontend deny `architect-phase-incomplete`, senior-reviewer
  // `spawn-bootstrap-publish-failed`, senior-tester and senior-shipper
  // `performance-model-param`.) So it is the whole reachable surface of "a role
  // other than quick-fix carrying the marker", and the assertion below is the
  // only place that surface is covered.
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    withTeamsEnv(() => {
      const onePath = path.join(cwd, '.traffic-one', '.one.json');
      const one = JSON.parse(fs.readFileSync(onePath, 'utf8')) as Record<string, unknown>;
      one.mode = 'existing-codebase';
      one.lifecycle = { phase: 'maintenance', source: 'test' };
      fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

      const first = spawn(cwd, NARROW, 'senior-architect', 'opus');
      assert.equal(first.kind, 'noop', first.kind === 'deny' ? first.reason : 'PRECONDITION: the architect spawn is admitted');
      const runId = currentRunId(cwd);
      const before = readActiveRunBootstrap(cwd, runId, 'senior-architect')?.envelopeHash;
      assert.ok(before, 'PRECONDITION: the architect holds a published envelope');
      recordRunAgent(cwd, runId, 'senior-architect', { agentId: 'agent-arch-1', parentSessionId: PARENT, model: 'opus' });

      const second = spawn(cwd, WIDER, 'senior-architect', 'opus');
      assert.equal(second.kind, 'deny');
      if (second.kind !== 'deny') return;
      assert.equal(second.denyId, 'agent-reuse-continue', 'the marker is not an origin of scope for any role but quick-fix');
      assert.equal(readActiveRunBootstrap(cwd, runId, 'senior-architect')?.envelopeHash, before, 'and nothing was republished');
    });
  });
});

// ── the refused republish, consumed rather than dropped ──────────────────────

test('a republish the runtime REFUSES is reported as refused, never minted as applied', () => {
  withLiveNarrowQuickFix((cwd, runId, narrowHash) => {
    const roleDir = path.join(cwd, '.traffic-one', 'runs', runId, 'bootstrap', ROLE);
    // A read-only role bootstrap directory: the same 0o555 fixture
    // build/__tests__/sync-hosts.test.ts uses for an unwritable parent. The
    // path is READ before it is written (ensureRunBootstrap reads active.json
    // to compare hashes), so a dangling symlink would break the read and prove
    // nothing about the write; the fixture guard below asserts the read still
    // resolves.
    fs.chmodSync(roleDir, 0o555);
    try {
      assert.equal(
        readActiveRunBootstrap(cwd, runId, ROLE)?.envelopeHash, narrowHash,
        'FIXTURE GUARD: the envelope is still READABLE, so only the write is blocked',
      );

      const second = spawn(cwd, WIDER);
      assert.equal(second.kind, 'deny');
      if (second.kind !== 'deny') return;
      assert.equal(
        second.denyId, 'agent-reuse-scope-regrant-refused',
        'a refused write must not render as an applied one, and must not crash the gate either',
      );
      assert.doesNotMatch(second.reason, /\{\{[A-Z_]+\}\}/, 'every template variable was supplied');
      assert.ok(second.reason.includes('the widening did NOT happen'), 'the deny names what did not happen');
      assert.ok(second.reason.includes('src/a.ts, src/b.ts'), 'and the files that are NOT writable');
      assert.ok(
        second.reason.includes('report BLOCKED'),
        'and ends in an action the orchestrator can take when the retry does not clear',
      );

      assert.equal(
        readActiveRunBootstrap(cwd, runId, ROLE)?.envelopeHash, narrowHash,
        'the live agent still holds the scope it started with',
      );
    } finally {
      fs.chmodSync(roleDir, 0o755);
    }
  });
});

// ── the pairing: one question, asked by the offerer and by the enforcer ───────

// A candidate contract the enforcer has never seen a pin for. Only the four
// fields fallbackContractMatches reads are populated: whether it admits THIS is
// the whole question ("does the guard admit an arbitrary scope right now?").
const FOREIGN_UNIT = {
  unitId: `${ROLE}:bootstrap`,
  contractHash: 'f'.repeat(64),
  allowlist: ['src/foreign.ts'],
  allowlistExclude: [],
} as unknown as WorkUnitContractV1;

const MAINTENANCE_STATES: ReadonlyArray<{ name: string; marker: Record<string, unknown> | null }> = [
  { name: 'no maintenance marker at all', marker: null },
  {
    name: 'a PENDING fallback debt for this role',
    marker: {
      overallOutcome: 'fallback-pending',
      role: ROLE,
      workUnitContractHash: 'a'.repeat(64),
      allowlistHash: 'b'.repeat(64),
      fallbackSourceBaseline: { files: [{ path: 'src/owed.ts' }] },
    },
  },
  {
    name: 'a PENDING fallback debt for a DIFFERENT role',
    marker: {
      overallOutcome: 'fallback-pending',
      role: 'senior-backend',
      workUnitContractHash: 'a'.repeat(64),
      allowlistHash: 'b'.repeat(64),
      fallbackSourceBaseline: { files: [{ path: 'src/owed.ts' }] },
    },
  },
  {
    name: 'a debt for this role that is already PAID',
    marker: {
      overallOutcome: 'fallback-paid',
      role: ROLE,
      workUnitContractHash: 'a'.repeat(64),
      allowlistHash: 'b'.repeat(64),
      fallbackSourceBaseline: { files: [{ path: 'src/owed.ts' }] },
    },
  },
];

test('the regrant OFFERER and the envelope ENFORCER ask the SAME question', () => {
  withLiveNarrowQuickFix((cwd, runId) => {
    const markerPath = path.join(cwd, '.traffic-one', 'runs', runId, 'maintenance.json');
    const observed: { offered: boolean; admits: boolean }[] = [];
    for (const state of MAINTENANCE_STATES) {
      if (state.marker) fs.writeFileSync(markerPath, JSON.stringify(state.marker), 'utf8');
      else fs.rmSync(markerPath, { force: true });

      // The ENFORCER: does ensureRunBootstrap's own guard admit an arbitrary
      // scope for this role right now?
      const admits = fallbackContractMatches(cwd, runId, ROLE, FOREIGN_UNIT);
      // The predicate the offerer is written against, asserted to be the exact
      // complement of that — this is the claim, not an intermediate step.
      assert.equal(
        roleOwesPendingMaintenanceFallback(cwd, runId, ROLE), !admits,
        `${state.name}: roleOwesPendingMaintenanceFallback must be the exact negation of "the enforcer admits anything"`,
      );

      // The OFFERER: does the gate actually offer the regrant, driven through
      // the real composed handler rather than through the predicate?
      const result = spawn(cwd, WIDER);
      assert.equal(result.kind, 'deny', `${state.name}: the duplicate spawn is refused either way`);
      const offered = result.kind === 'deny' && result.denyId === 'agent-reuse-scope-regrant';
      assert.equal(
        offered, admits,
        `${state.name}: the gate offered a regrant the publisher would ${admits ? 'have admitted' : 'have refused'}`,
      );
      // Not merely "no regrant": a state the OFFERER declines must render the
      // ordinary continue deny. Reaching the publisher and rendering its
      // refusal instead would tell an orchestrator a transient write failed and
      // send it back to re-send a spawn that can never succeed, when the honest
      // answer is "you already have this agent".
      assert.equal(
        result.kind === 'deny' ? result.denyId : '',
        admits ? 'agent-reuse-scope-regrant' : 'agent-reuse-continue',
        `${state.name}: a declined regrant must not surface as a refused republish`,
      );
      observed.push({ offered, admits });

      // Put the narrow contract back so each row starts from the same state.
      if (offered) assert.equal(spawn(cwd, NARROW).kind, 'deny');
    }

    // NON-VACUITY: a matrix that only ever answered one way would pass the
    // biconditional above while measuring nothing.
    assert.ok(observed.some((row) => row.offered), 'at least one state offers the regrant');
    assert.ok(observed.some((row) => !row.offered), 'at least one state refuses it');
  });
});

// ── the prose ────────────────────────────────────────────────────────────────

test('both regrant blocks exist in SKILL.md and every hole they carry is filled', () => {
  const skill = fs.readFileSync(MODULE_SKILL, 'utf8');
  const fallbacks: Record<string, string> = {
    'agent-reuse-scope-regrant': AGENT_REUSE_SCOPE_REGRANT_FALLBACK,
    'agent-reuse-scope-regrant-refused': AGENT_REUSE_SCOPE_REGRANT_REFUSED_FALLBACK,
  };
  for (const name of ['agent-reuse-scope-regrant', 'agent-reuse-scope-regrant-refused']) {
    const body = extractBlock(skill, name);
    assert.ok(body, `${name}: the block the gate renders must exist, or the deny falls back to TS prose silently`);
    // plan-guard's skill-fallback-parity test pins its OWN module's pairs only,
    // so this pair has no other keeper: a shipped block edited without its TS
    // fallback would change what an installed plugin says while every test that
    // reads the fallback stayed green.
    assert.equal(
      body, fallbacks[name],
      `${name}: the TS fallback must stay byte-identical to the shipped block`,
    );
    // Every placeholder must be one the call site passes. The gate is the only
    // caller, so an unpassed hole renders as a literal `{{VAR}}` in an
    // orchestrator-facing refusal.
    const holes = [...new Set([...body!.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!))].sort();
    assert.ok(holes.length >= 6, `${name}: expected a fully-interpolated block, found holes ${holes.join(', ')}`);
  }
});
