// src/runners/onboarding-wait/pre-spawn-model.ts
// The per-role model directive built from the frozen run policy and
// captured host models.

import { AGENT_ROLES } from '../../config/performance';
import { detectHost } from '../../shared/host';
import { detectHostPlan } from '../../shared/host/plan';
import { hostSpawnType } from '../../shared/host/spawn-types';
import { buildCursorSpawnModelMap, CURSOR_SPAWN_ENUM_CHECK } from '../../shared/materialize/cursor-spawn-map';
import { freshCursorModels } from '../../shared/materialize/cursor-models';
import { modelCaptureCommand, modelGateCommand } from '../../shared/model-gate-command';
import { currentAcceptableModels } from '../../shared/current-model-tiers';
import { claudeTaskSpawnAlias } from '../../shared/model-tiers';
import { obj } from '../../shared/obj';
import { modelForRoleHost, teamModeForLevel } from '../../shared/performance';
import {  isNewProjectMode, readEffectiveState } from '../../shared/state';
import {  readRunModelPolicy } from '../../shared/run-model-policy';

function claudeSpawnModelDirective(cwd: string): string {
  try {
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'claude' }) as Record<string, unknown>;
    if (!state || !isNewProjectMode(state)) return '';
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    const policy = runId ? readRunModelPolicy(cwd, runId) : null;
    if (!policy || policy.host !== 'claude') return '';
    if (teamModeForLevel(policy.performanceLevel || '') !== 'subagents') return '';
    const rows: string[] = [];
    for (const role of AGENT_ROLES) {
      const rolePolicy = policy.roles[role];
      if (!rolePolicy?.preferredModel) continue;
      const alias = claudeTaskSpawnAlias(rolePolicy.acceptableModels) || rolePolicy.preferredModel;
      rows.push(`   - ${role} → subagent_type: "traffic-one:${role}", model: "${alias}" (policy model: ${rolePolicy.preferredModel})`);
    }
    if (!rows.length) return '';
    return [
      `[traffic-one] Claude — per-role spawn map for run \`${runId}\` (immutable policy \`${policy.policyId}\`):`,
      '- Pass BOTH parameters on EVERY Agent spawn — the `subagent_type` AND the exact `model` alias below (the short token from that role\'s frozen `acceptableModels`, the same list One MCP published). A full model id fails the Agent tool\'s own input validation as "failed to run agent" before any gate runs. A spawn without `model` inherits the parent session model; passing the alias below on the FIRST spawn avoids a rewrite.',
      ...rows,
      `- The gate verifies the spawned model against that role's \`acceptableModels\` in \`.traffic-one/runs/${runId}/model-policy.json\`; never pass an alias from another tier, and re-use this exact map for replacement and retry spawns.`,
    ].join('\n');
  } catch {
    return '';
  }
}

export function preSpawnModelDirective(cwd: string, host: string = detectHost()): string {
  if (host === 'claude') return claudeSpawnModelDirective(cwd);
  if (host !== 'cursor') return '';
  try {
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: host }) as Record<string, unknown>;
    if (!state || !isNewProjectMode(state)) return '';
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    const policy = runId ? readRunModelPolicy(cwd, runId) : null;
    if (runId && (!policy || policy.host !== 'cursor')) {
      return [
        'TRAFFIC_ONE_MODEL_POLICY_BLOCKED',
        `Traffic One cannot publish a Cursor spawn map because model-policy.json is missing or corrupt for run ${runId}.`,
        'Start a repaired parent run; do not rebuild the map from the current plan or availableModels.',
      ].join('\n');
    }
    const performance = obj(state.performance);
    const level = policy?.performanceLevel
      || (performance && typeof performance.level === 'string' ? performance.level : '');
    if (!level || teamModeForLevel(level) !== 'subagents') return '';
    const team = obj(state.team);
    const overrides = policy
      ? (policy.teamOverrides as Record<string, unknown>)
      : team && obj(team.overrides) ? (team.overrides as Record<string, unknown>) : null;
    const modelSelections = policy
      ? null
      : team && obj(team.modelSelections) ? (team.modelSelections as Record<string, unknown>) : null;
    const planCtx = { host, plan: policy?.plan || detectHostPlan(host) };

    const plan = policy?.plan || detectHostPlan(host);
    const captured = policy ? [...(policy.cursorAvailableModels || [])] : freshCursorModels(cwd, plan);
    const spawnMap = captured.length ? buildCursorSpawnModelMap(cwd, state) : {};

    const rows: string[] = [];
    const tierFallback = new Map<string, string>(); // tier family → next-eligible fallback family
    for (const role of AGENT_ROLES) {
      const rolePolicy = policy?.roles[role];
      const fam = rolePolicy?.preferredModel
        || modelForRoleHost(level, role, host, overrides, planCtx, process.env, modelSelections);
      if (!fam) continue;
      const hasExactCaptured = captured.length > 0
        && Object.prototype.hasOwnProperty.call(spawnMap, role);
      const spawnValue = hasExactCaptured
        ? spawnMap[role]
        : `(after step 2 — exact captured picker id for tier \`${fam}\`; never guess an uncaptured id)`;
      const cursorSpawn = hostSpawnType('cursor', role);
      rows.push(`   - ${role} → subagent_type: "${cursorSpawn.primary}", model: ${spawnValue}`);
      const acceptable = rolePolicy?.acceptableModels || currentAcceptableModels(fam, host, planCtx.plan);
      if (!tierFallback.has(fam)) tierFallback.set(fam, acceptable.slice(1)[0] || fam);
    }
    if (!rows.length) return '';
    const eligibility = Array.from(tierFallback.entries())
      .map(([fam, fb]) => `\`${fam}\`${fb && fb !== fam ? ` (fallback if unavailable: \`${fb}\`)` : ''}`)
      .join(', ');

    const gateCmd = modelGateCommand(cwd, host);
    const captureCmd = modelCaptureCommand(cwd, host);
    if (policy) {
      return [
        `[traffic-one] Cursor — immutable model policy is ready for run \`${runId}\` (\`${policy.policyId}\`).`,
        `- Frozen picker snapshot: ${captured.map((model) => `\`${model}\``).join(', ')}.`,
        '- Do NOT capture models again for this run. A plan, One MCP catalog, or Cursor picker change applies only to a new parent run; this policy is never rebased.',
        `- Run \`${gateCmd}\` once. It validates availability against the frozen snapshot and prints the authoritative exact spawn map.`,
        '- Spawn each role with the `subagent_type` and exact captured Task `model` below (never an uncaptured family guess):',
        ...rows,
        `- ${CURSOR_SPAWN_ENUM_CHECK} Keep \`[t1-role: senior-<role>]\` as the FIRST prompt line whichever type you pass. Never build the role inline.`,
        '- If the frozen snapshot requires an enable/fallback decision, `fallback` may continue this run on its frozen exact alternate. `enable` requires a new parent run after enabling and capturing the updated picker.',
      ].join('\n');
    }
    return [
      '[traffic-one] Cursor — resolve the subagent models BEFORE spawning the team (do this ONCE, in order; it avoids the spawn being denied and re-tried):',
      '1. Enumerate the exact model ids your `Task` tool offers for subagents, then run the internal capture command below with those ids in place of the placeholders. It writes only local per-user/project preferences; never create `.traffic-one/cursor-models.json`:',
      `   ${captureCmd}`,
      `2. Run this command (it checks whether your picked tier models — ${eligibility} — are actually offered):`,
      `   ${gateCmd}`,
      '   If a picked model is NOT offered, STOP — show the user the unavailable-model table in chat and wait for them to reply **fallback** or **enable** before spawning. The model-gate command and spawn gate both fail closed until that reply is recorded. Re-run after they enable a model.',
      '3. Spawn using the **spawn map** printed by step 2. Project `.cursor/agents` files are model-agnostic; pass each EXACT slug from the map in the Task `model` parameter, together with the role\'s `subagent_type` (preview; step 2 is authoritative):',
      ...rows,
      `   ${CURSOR_SPAWN_ENUM_CHECK} Keep \`[t1-role: senior-<role>]\` as the FIRST prompt line whichever type you pass. Never build the role inline.`,
      '   Use only ids present verbatim in the captured picker list. An exact id may equal its family anchor (for example `gpt-5.4-mini`); never invent a suffix or pass an uncaptured family guess.',
      '   Spawn the team only after steps 1–2. Passing the correct `model` per role on the FIRST spawn is what avoids the model-tier deny + retry.',
    ].join('\n');
  } catch {
    return '';
  }
}

// Print the live wizard URL to this command's OWN stdout before blocking. This is
// the one channel that reliably reaches the Cursor user: the agent watches (and the
// user sees) this command's terminal output, whereas Cursor does NOT render
// systemMessage→user_message on user-prompt-submit and the agent often won't repost
// the URL from the agent-facing additional_context. Host-agnostic (Claude/Codex open
// the wizard programmatically, but the printed URL is a harmless, useful fallback
