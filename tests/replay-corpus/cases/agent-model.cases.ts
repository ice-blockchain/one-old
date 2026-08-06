// tests/replay-corpus/cases/agent-model.cases.ts
// The priority-40 agent-model gate (src/modules/agent-model/handler.ts):
// spawn shape, run-id/model-policy minting, and (via gate-enforcement.ts) the
// materialization/performance/team/model-tier ladder. This module reads
// `raw.tool_input` directly (NOT ctx.input.tool), so every case below sets
// `raw` explicitly with the exact field names role-infer.ts / spawn-shape.ts
// look for.

import type { CaseSpec } from '../run-case';
import { cursorReady, greenfieldNoPlan, materializedGreenfield, midRunPendingClaimSlotUnwritable } from '../fixtures';

export const AGENT_MODEL_CASES: CaseSpec[] = [
  {
    id: 'agent-model.spawn-role-conflict',
    notes: 'Two different valid roles in the same authoritative evidence tier (subagent_type vs agent_type) -> spawn-role-conflict, before any state is read',
    host: 'claude',
    event: 'PreToolUse',
    project: greenfieldNoPlan,
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: { tool_input: { subagent_type: 'senior-frontend', agent_type: 'senior-backend', prompt: 'Build the feature' } },
  },
  {
    id: 'agent-model.spawn-background-forbidden',
    notes: 'A role spawn with run_in_background:true is always denied, independent of run/model state',
    host: 'claude',
    event: 'PreToolUse',
    project: greenfieldNoPlan,
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: { tool_input: { agent_type: 'senior-frontend', run_in_background: true, prompt: 'Build the feature' } },
  },
  {
    id: 'agent-model.spawn-child-cannot-mint-run',
    notes: 'A subagent-identified caller (parent_session_id present) spawning before any run id exists -> spawn-child-cannot-mint-run. Needs main-agent/low: under team.mode=subagents the SAME identity signal (hookSessionIdentity.isSubagent) also satisfies the priority -90 codex-child-observed-model gate (codex-child-model.ts), which runs first on EVERY host (not just Codex) whenever team.mode is subagents, and denies with codex-child-model-policy-missing before this handler ever runs',
    host: 'claude',
    event: 'PreToolUse',
    project: (host) => materializedGreenfield(host, { performance: 'low', team: { mode: 'main-agent', approved: true } }),
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: {
      session_id: 'child-session',
      parent_session_id: 'parent-session',
      tool_input: { agent_type: 'senior-frontend', prompt: 'Build the feature' },
    },
  },
  {
    id: 'agent-model.performance-main-agent',
    notes: 'Performance level "low" forces main-agent team mode -> any role spawn is denied with performance-main-agent',
    host: 'claude',
    event: 'PreToolUse',
    project: (host) => materializedGreenfield(host, { performance: 'low', team: { mode: 'main-agent', approved: true } }),
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: { tool_input: { agent_type: 'senior-frontend', prompt: 'Build the feature' } },
  },
  // NOTE: no case reaches agent-model's own 'team-confirmation' deny
  // (gate-enforcement.ts's `!isTeamApproved(state.team)` branch) or its
  // 'agent-materialization-deny'/'agent-materialization-missing' pair
  // (converge.ts). Both preconditions — an unapproved subagents team, and an
  // unmaterialized project — are ALSO exactly what onboarding-gate's own
  // completeness/convergence logic (priority 10, runs before agent-model's
  // 40) treats as "onboarding still pending": needsTeamConfirmation makes
  // computeOnboarding().step === 'team-confirmation' (so onboarding-gate
  // denies with its own onboarding-server-* id first), and
  // materializeProjectIfNeeded runs unconditionally for any reaching
  // PreToolUse. A hand-built fixture CAN force state where onboarding-gate
  // considers itself complete while agent-model's stricter check disagrees,
  // but that split-brain state is not one any real writer produces, so it is
  // left out rather than fabricated. See the coverage report for the full
  // list of denyIds this makes structurally unreachable through the real
  // composed pipeline.
  {
    id: 'agent-model.architect-phase-incomplete',
    notes: 'senior-frontend (a plan-batch-gated implementer role) spawned before the architect has published a compiled plan for this run -> architect-phase-incomplete',
    host: 'claude',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: { tool_input: { agent_type: 'senior-frontend', prompt: 'Build the feature' } },
  },
  {
    id: 'agent-model.performance-model-param-missing',
    notes: 'senior-architect (not plan-batch-gated) spawned with NO model parameter on an enforcing host -> performance-model-param',
    host: 'claude',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: { tool_input: { agent_type: 'senior-architect', prompt: 'Write the plan' } },
  },
  {
    id: 'agent-model.absolute-traffic-one-path',
    notes: 'The spawn prompt hands the child an ABSOLUTE .traffic-one path belonging to a different project -> absolute-traffic-one-path. Checked on the prompt text alone, before the model/plan ladder, because a child that follows such a path writes another project\'s run state',
    host: 'claude',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: {
      tool_input: {
        agent_type: 'senior-architect',
        model: 'claude-opus-5',
        prompt: 'Read /opt/some-other-project/.traffic-one/runs/999/assignments.json and continue.',
      },
    },
  },
  {
    id: 'agent-model.spawn-run-id-mismatch',
    notes: 'The spawn prompt names a fabricated ISO run id instead of currentRunId -> spawn-run-id-mismatch. The fixture pins currentRunId so the two ids are stable; the deny is self-healing (it echoes the corrected prompt), which is why it carries no once-marker and can be replayed as-is',
    host: 'claude',
    event: 'PreToolUse',
    project: (host) => materializedGreenfield(host, { currentRunId: 'replay-fixture-run' }),
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: {
      tool_input: {
        agent_type: 'senior-architect',
        model: 'claude-opus-5',
        prompt: 'Run ID: 2026-06-17T12-09-40Z\nWrite .traffic-one/runs/2026-06-17T12-09-40Z/assignments.json.',
      },
    },
  },
  // The three host-specific spellings of ONE cause: the spawn named a worker
  // type that cannot bind the role. Same rung of the ladder (gate-enforcement.ts,
  // immediately before the model-tier checks), three ids, three remedies — which
  // is exactly the kind of family a retiering can collapse by accident, so all
  // three are pinned. Each carries the role in the PROMPT MARKER
  // (`[t1-role: …]`, the convention Traffic One's own spawn recipes render)
  // rather than in the agent-type field, because the agent-type field is the
  // thing under test: `spawnAgentType` must read the host's wrong value while
  // role inference still resolves a role (role-infer.ts's marker tier).
  {
    id: 'agent-model.kilo-general-agent-required',
    notes: 'Kilo exposes exactly one spawnable worker type (`general`), so any other subagent_type is a misroute the child could not bind a role from -> kilo-general-agent-required',
    host: 'kilo',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'agent-model.spawn',
    // `task` — Kilo's spawn tool (adapters/kilo.ts's KILO_TOOL_TASK). Not
    // `new_task`: agentModelGate matches the bare tool name against
    // /^(Task|Agent|spawn_agent|run_subagent|spawn_subagent)$/i, so any other
    // spelling makes the whole gate a no-op.
    tool: { class: 'spawn-agent', rawName: 'task' },
    raw: { tool_input: { subagent_type: 'architect-worker', message: '[t1-role: senior-architect]\nWrite the plan' } },
  },
  {
    id: 'agent-model.opencode-named-agent-required',
    notes: 'OpenCode requires the materialized per-role global agent name; a built-in (`general`) inherits the parent session model instead of the role model -> opencode-named-agent-required',
    host: 'opencode',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'task' },
    raw: { tool_input: { subagentType: 'general', description: 'Write the plan', prompt: '[t1-role: senior-architect]\nWrite the plan' } },
  },
  {
    id: 'agent-model.cursor-agent-type-required',
    notes: 'Cursor accepts the role\'s own materialized agent or the built-in generic worker; a third type (here Cursor\'s own `code-reviewer`) binds no role -> cursor-agent-type-required. Needs the cursorReady fixture (a captured picker list whose PREFERRED picks are all present), otherwise onboarding-gate\'s models-capture deny or the model-choice pause fires first',
    host: 'cursor',
    event: 'PreToolUse',
    project: cursorReady,
    expectGate: 'agent-model.spawn',
    workspaceRoot: 'cwd',
    tool: { class: 'spawn-agent', rawName: 'Task' },
    raw: { tool_input: { subagent_type: 'code-reviewer', prompt: '[t1-role: senior-architect]\nWrite the plan' } },
  },
  {
    id: 'agent-model.spawn-claim-unavailable',
    notes: 'The role claim could not be RECORDED, so the spawn is refused -> spawn-claim-unavailable. OpenCode because it does not enforce the model param (spawn-shape.ts\'s modelParamEnforced), so the quick-fix branch needs no captured picker list. The fixture plants `runs/<id>/pending/quick-fix.json` as a symlink, which the write chokepoint refuses, so the mint reports `unavailable` rather than a decision — the one outcome state/run-agent/mutation-result.ts\'s split rule says claim minting must retry and then deny on. Seeded `claimMintDeny -> null` (the pre-fix behaviour of discarding the mint result): moves to allow, with the child spawned and no claim behind it',
    host: 'opencode',
    event: 'PreToolUse',
    project: midRunPendingClaimSlotUnwritable,
    expectGate: 'agent-model.spawn',
    tool: { class: 'spawn-agent', rawName: 'task' },
    raw: { tool_input: { subagentType: 'traffic-one-quick-fix', description: 'Fix the failing test', prompt: '[t1-role: quick-fix]\nFix the failing test' } },
  },
  {
    id: 'agent-model.post-tool-use-shell-noop-control',
    notes: 'Control case: PostToolUse(shell) is agent-model\'s after-shell-execution subscription, not a spawn path — exercises the event/tool-class combination with no expectation of a deny',
    host: 'claude',
    event: 'PostToolUse',
    project: greenfieldNoPlan,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'npm test' },
  },
];
