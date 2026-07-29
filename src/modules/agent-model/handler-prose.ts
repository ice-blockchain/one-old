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

export function isPlanBatchGatedRole(role: string): boolean {
  return PLAN_BATCH_GATED_ROLES.has(role);
}
