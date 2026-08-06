// src/modules/agent-model/handler-prose.ts
// The skillBlock/block prose closures and the verbatim SKILL.md fallback
// constants shared by every deny builder.

import {  deny } from '../../core/result';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';

const skillBlock = makeSkillBlock(pluginRoot);
export const block = (
  name: string,
  vars: Record<string, string | number | null | undefined> = {},
  fallback = '',
): string => skillBlock('agent-model', name, vars, fallback);
const PLAN_BATCH_GATED_ROLES = new Set(['senior-frontend', 'senior-backend']);
// Verification roles gated on a LIVE Step-0 batch (never on a dead or terminal
// one): reviewing/testing pre-batch state wastes the whole round. Deliberately
// separate from PLAN_BATCH_GATED_ROLES — implementers wait for terminality,
// verifiers only for liveness, with their own at-most-once budget.
const VERIFY_BATCH_GATED_ROLES = new Set(['senior-reviewer', 'senior-tester']);

export const CURSOR_MODELS_CAPTURE_FALLBACK = `Cursor model-capture gate (required before the first team spawn, run {{RUN_ID}}). The spawn is blocked until Traffic One freezes the exact model ids offered by this Cursor build.
Missing captured tiers for this run: {{MISSING_TIERS}}.
Do this once before retrying:
1. List the model ids your \`Task\` tool offers for spawning subagents (the same list Cursor shows when you pick a subagent model).
2. Run \`{{CAPTURE_CMD}}\`, replacing the placeholders with those EXACT ids verbatim (e.g. \`claude-fable-5-thinking-high\`, \`gpt-5.6-terra-medium\`, \`composer-2.5-fast\`, or \`gpt-5.4-mini\`). A valid picker id may or may not include a reasoning suffix; never invent one. Include at least one id per tier the team needs — highest + balanced + cheapest. This internal command writes only your local per-user/project Cursor preferences; do not create \`.traffic-one/cursor-models.json\`.
3. Re-run model-gate, then retry the spawn with the exact role→model value it prints. Project \`.cursor/agents\` contracts remain model-agnostic.
Do not retry with an uncaptured family guess and do not build the project inline because of this gate.`;

// Verbatim mirror of the SKILL.md `architect-phase-incomplete` block, so a
// missing block never softens the gate's prose (observed 8c: the orchestrator
// mis-read this deny as a Step-0 request and burned a second dead spawn — the
// prose must lead with the exact next action).
export const ARCHITECT_PHASE_INCOMPLETE_FALLBACK = `Architect phase gate: \`{{ROLE}}\` cannot start yet — spawn \`senior-architect\` for run \`{{RUN_ID}}\` FIRST, in your next message. Do NOT retry \`{{ROLE}}\` unchanged and do NOT run the OpenCode Step-0 plan batch instead; neither clears this gate.

Missing on disk: {{MISSING}}

The architect must finish the required project-memory baseline, semantic \`.traffic-one/runs/{{RUN_ID}}/architecture-input-v1.json\`, and \`.traffic-one/digests/{{RUN_ID}}/architect.md\` containing \`PLAN_READY\`. Traffic One runtime—not the architect—then compiles and atomically publishes the architecture, verification, assignments, and child bootstraps. Only after those hash-valid contracts exist may you retry \`{{ROLE}}\` with the same task. Do not spawn other implementers or patch runtime-owned coordination artifacts yourself.`;

// Verbatim mirror of the SKILL.md `spawn-claim-unavailable` block. This gate
// exists precisely for the case where the project's state dir is not answering,
// which is also a state a missing/unreadable SKILL.md correlates with — so it is
// the last gate that can afford to render as `''`.
export const SPAWN_CLAIM_UNAVAILABLE_FALLBACK = `Traffic One spawn gate: the role claim for \`{{ROLE}}\` in run \`{{RUN_ID}}\` could not be recorded, so the spawn was blocked before a child started ({{REASON}}). Nothing is wrong with the run — its ledger still admits claims and the role is free — and this is not a model, team, or plan problem. Traffic One already retried once.

A child spawned without a claim binds no role: it writes as the main agent, is invisible to the duplicate-spawn gate, and cannot be released when the run settles. Blocking the spawn is the recoverable outcome.

Retry the SAME spawn, unchanged, in your next message. A concurrent hook holding the run's claims or ledger lock clears in about two seconds. If the same deny repeats more than twice, another process is wedged on this run's state: run \`node ~/.traffic-one/bin/doctor.cjs --run "{{RUN_ID}}"\` and fix what it reports before spawning again. Do NOT change the role, the model, or the task to work around it, and do NOT build the project inline instead.`;

export function isPlanBatchGatedRole(role: string): boolean {
  return PLAN_BATCH_GATED_ROLES.has(role);
}

export function isVerifyBatchGatedRole(role: string): boolean {
  return VERIFY_BATCH_GATED_ROLES.has(role);
}
