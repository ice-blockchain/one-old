// src/modules/plan-guard/build-orchestration-directive.ts
// Post-setup build-start directive: the orchestrator must spawn senior-architect
// via the host task tool BEFORE any feature-source or monorepo scaffold writes.
// OpenCode/Kilo use named/global agents (`kiloOpenCodeSubagentsBuild`).
// Cursor/Claude/Codex use a parallel paid-host playbook (`paidHostSubagentsBuild`)
// with host-exact spawn instructions (Cursor: always generalPurpose + captured slug).

import * as fs from 'fs';
import * as path from 'path';

import { architectPhaseIncompleteReasons } from './plan-readiness';
import { capabilityProfileForRun } from '../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../shared/capabilities';
import { hostFlags } from '../../shared/host/capability-flags';
import { hostSpawnType } from '../../shared/host/spawn-types';
import { buildCursorSpawnModelMap } from '../../shared/materialize/cursor-spawn-map';
import { canonicalHost, claudeTaskSpawnAlias } from '../../shared/model-tiers';
import { obj, type Rec } from '../../shared/obj';
import { pluginRoot } from '../../shared/paths';
import { teamModeForLevel } from '../../shared/performance';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import { makeSkillBlock } from '../../shared/skill-block';
import { ensureCurrentRunId, isMaintenancePhase, isNewProjectMode, readEffectiveState } from '../../shared/state';
import { openCodeGlobalAgentName, openCodeGlobalAgentPath } from '../../shared/materialize/opencode-assets';

const PAID_HOST_IDS = ['cursor', 'claude', 'codex'] as const;
type PaidHostId = (typeof PAID_HOST_IDS)[number];

function isPaidHostId(host: string): host is PaidHostId {
  return (PAID_HOST_IDS as readonly string[]).includes(host);
}
const skillBlock = makeSkillBlock(pluginRoot);
const block = (
  name: string,
  vars: Record<string, string | number | null | undefined> = {},
  fallback = '',
): string => skillBlock('onboarding-gate', name, vars, fallback);

const KILO_OPENCODE_SPAWN_FIRST_FALLBACK = `[traffic-one] {{HOST}} build start — \`team.mode="subagents"\` is ACTIVE and \`.traffic-one/plan.md\` is still missing. You are the PARENT/orchestrator.

DO NOT write feature source, scaffold app files, or run package installs yourself in this thread.
Your FIRST action: spawn \`senior-architect\` via the host \`{{TASK_TOOL}}\` tool:
- \`subagent_type: "{{SUBAGENT_TYPE}}"\` — {{SPAWN_RULE}}
- prompt line 1 MUST be: \`[t1-role: senior-<role>]\` (substitute the spawned role; architect here)
- {{ROLE_CONTRACT_INSTRUCTION}}
- include \`Run ID: {{RUN_ID}}\` and the user's original request
- omit \`model\` on {{HOST}} unless the host documents a subagent model parameter

Runtime capability contract: {{PROFILE_SUMMARY}}.
Do not replace these detected surfaces, roots, framework conventions, skill buckets, or QA adapters with an unrelated default.

{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}
Read \`.traffic-one/rules/common/senior-engineer-team.md\` before the first eligible implementer spawn.`;

const KILO_OPENCODE_ARCHITECT_INCOMPLETE_FALLBACK = `[traffic-one] {{HOST}} build — \`.traffic-one/plan.md\` exists but the architect phase is INCOMPLETE. You are the PARENT/orchestrator.

DO NOT spawn any implementation role from the runtime capability contract yet. DO NOT patch \`assignments.json\` or \`digests/{{RUN_ID}}/architect.md\` yourself unless the user explicitly opts out of subagents.

Missing architect deliverables: {{MISSING}}

Respawn \`senior-architect\` via \`{{TASK_TOOL}}\` with:
- \`subagent_type: "{{SUBAGENT_TYPE}}"\` — {{SPAWN_RULE}}
- prompt line 1: \`[t1-role: senior-<role>]\` (substitute the spawned role; architect here)
- {{ROLE_CONTRACT_INSTRUCTION}}
- \`Run ID: {{RUN_ID}}\`
- instruct the architect to finish project memory and semantic
  \`.traffic-one/runs/{{RUN_ID}}/architecture-input-v1.json\`, then write
  \`.traffic-one/digests/{{RUN_ID}}/architect.md\` with \`PLAN_READY\`; runtime
  compiles architecture/verification, assignments, and work-unit bootstraps

Runtime capability contract: {{PROFILE_SUMMARY}}.
{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}

Implementer spawns are blocked until the digest carries \`PLAN_READY\` on disk.`;

const PAID_HOST_SPAWN_FIRST_FALLBACK = `[traffic-one] {{HOST}} build start — \`team.mode="subagents"\` is ACTIVE and \`.traffic-one/plan.md\` is still missing. You are the PARENT/orchestrator.

DO NOT write feature source, scaffold app files, or run package installs yourself in this thread.
Your FIRST action: spawn \`senior-architect\` via the host \`{{TASK_TOOL}}\` tool:
{{SPAWN_INSTRUCTIONS}}
- include \`Run ID: {{RUN_ID}}\` and the user's original request
- Foreground only: do NOT set \`run_in_background\`.

Runtime capability contract: {{PROFILE_SUMMARY}}.
Do not replace these detected surfaces, roots, framework conventions, skill buckets, or QA adapters with an unrelated default.

{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}
Read \`.traffic-one/rules/common/senior-engineer-team.md\` before the first eligible implementer spawn.`;

const PAID_HOST_ARCHITECT_INCOMPLETE_FALLBACK = `[traffic-one] {{HOST}} build — \`.traffic-one/plan.md\` exists but the architect phase is INCOMPLETE. You are the PARENT/orchestrator.

DO NOT write feature source. DO NOT spawn any implementation role from the runtime capability contract yet. DO NOT patch \`assignments.json\` or \`digests/{{RUN_ID}}/architect.md\` yourself unless the user explicitly opts out of subagents.

Missing architect deliverables: {{MISSING}}

Respawn \`senior-architect\` via \`{{TASK_TOOL}}\` with:
{{SPAWN_INSTRUCTIONS}}
- \`Run ID: {{RUN_ID}}\`
- Foreground only: do NOT set \`run_in_background\`.
- instruct the architect to finish project memory and semantic
  \`.traffic-one/runs/{{RUN_ID}}/architecture-input-v1.json\`, then write
  \`.traffic-one/digests/{{RUN_ID}}/architect.md\` with \`PLAN_READY\`; runtime
  compiles architecture/verification, assignments, and work-unit bootstraps

Runtime capability contract: {{PROFILE_SUMMARY}}.
{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}

Implementer spawns are blocked until the digest carries \`PLAN_READY\` on disk.`;

function profileSummary(profile: CapabilityProfileV1): string {
  return [
    `profile=${profile.profileId}`,
    `framework=${profile.framework}`,
    `surfaces=${profile.surfaces.join(', ') || 'none'}`,
    ...(profile.architectureTarget ? [`architecture target=${profile.architectureTarget}`] : []),
    ...(profile.blockingIssues?.length
      ? [`blocking issue=${profile.blockingIssues.map((issue) => issue.code).join(',')}`]
      : []),
    `source roots=${profile.sourceRoots.join(', ') || 'none'}`,
    `skill buckets=${profile.skillBuckets.join(', ') || 'universal only'}`,
  ].join('; ');
}

function implementerDirective(profile: CapabilityProfileV1, hostLabel: string): string {
  const roles = profile.roles.filter((role) => role === 'senior-frontend' || role === 'senior-backend');
  if (roles.length === 0) {
    return `After PLAN_READY, do not invent a frontend/backend implementer: this profile has no implementation role. Continue to the compiled verifier flow.`;
  }
  if (roles.length === 1) {
    return `After PLAN_READY, spawn only \`${roles[0]}\` on ${hostLabel}; do not create the ineligible sibling role. Use its compiled work-unit allowlist and matching host role contract.`;
  }
  return `After PLAN_READY, spawn \`${roles[0]}\` and \`${roles[1]}\` in parallel on ${hostLabel}, each with its compiled work-unit allowlist and matching host role contract.`;
}

function qaDirective(profile: CapabilityProfileV1): string {
  if (profile.blockingIssues?.length) {
    return 'Architecture is blocked: select the web-ui or native-ui target in runtime/user-owned state before implementation or QA.';
  }
  if (profile.architectureTarget === 'native-ui'
    || (!profile.architectureTarget && profile.surfaces.includes('native-ui'))) {
    return `Native UI QA uses ${profile.qaAdapters.join(', ') || 'the native simulator/emulator adapter'}; do not use browser QA.`;
  }
  if (profile.surfaces.includes('web-ui')) {
    return `Web QA derives uiImpact from the diff; use ${profile.qaAdapters.join(', ') || 'Playwright'} only for behavioral/visual impact, and require screenshots only for visual impact.`;
  }
  return 'This profile has no UI surface: run stack-native build/test/lint checks and do not assign browser, screenshot, design, or frontend QA.';
}

function subagentsTeamEligible(state: Rec): boolean {
  const team = obj(state.team);
  if (!team || team.mode !== 'subagents' || team.approved !== true) return false;
  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  if (level && teamModeForLevel(level) !== 'subagents') return false;
  return true;
}

function kiloOpenCodeSubagentsBuild(state: Rec, host: string): boolean {
  if (!isNewProjectMode(state)) return false;
  // `mode` deliberately remains `new-project` after the first build so the
  // original stack/plan gates stay available. The lifecycle is what tells us the
  // greenfield build is over. Never inject an architect-first build directive for
  // a maintenance prompt; maintenance triage owns its direct-role vs architect
  // decision and only complex work may re-enter the orchestrator.
  if (isMaintenancePhase(state, state.mode)) return false;
  const h = canonicalHost(host);
  if (!hostFlags(h).opencodeSelfHosted) return false;
  return subagentsTeamEligible(state);
}

function paidHostSubagentsBuild(state: Rec, host: string): boolean {
  if (!isNewProjectMode(state)) return false;
  if (isMaintenancePhase(state, state.mode)) return false;
  const raw = typeof host === 'string' ? host.trim().toLowerCase() : '';
  const h = canonicalHost(host);
  // canonicalHost maps unknown strings to `claude`; require the caller named a
  // paid host so garbage does not inherit the Claude playbook.
  if (!isPaidHostId(raw) || !isPaidHostId(h)) return false;
  if (hostFlags(h).opencodeSelfHosted) return false;
  return subagentsTeamEligible(state);
}

function eligibleSubagentsBuild(state: Rec, host: string): boolean {
  return kiloOpenCodeSubagentsBuild(state, host) || paidHostSubagentsBuild(state, host);
}

function paidHostSpawnInstructions(host: PaidHostId, cwd: string, state: Rec, runId: string): string {
  if (host === 'cursor') {
    const map = buildCursorSpawnModelMap(cwd, { ...state, currentRunId: runId });
    const slug = typeof map['senior-architect'] === 'string' ? map['senior-architect'].trim() : '';
    const modelLine = slug
      ? `- \`model: "${slug}"\` — exact captured Task slug from model-gate / model-policy.json`
      : '- pass the exact captured Task slug from model-gate / model-policy.json — NEVER the picker label (e.g. Claude Opus 5 High)';
    return [
      '- `subagent_type: "generalPurpose"` ALWAYS (role files may be missing from this session\'s enum)',
      '- prompt line 1 MUST be: `[t1-role: senior-architect]`',
      '- tell the child to read `.cursor/agents/senior-architect.md` if it exists',
      modelLine,
    ].join('\n');
  }
  if (host === 'claude') {
    const policy = readRunModelPolicy(cwd, runId);
    const rolePolicy = policy?.host === 'claude' ? policy.roles['senior-architect'] : undefined;
    const alias = rolePolicy
      ? (claudeTaskSpawnAlias(rolePolicy.acceptableModels) || rolePolicy.preferredModel || '')
      : '';
    const modelLine = alias
      ? `- \`model: "${alias}"\` — Claude Task/Agent spawn alias from the frozen run policy`
      : '- pass the Claude model alias from model-policy.json when known';
    return [
      '- `subagent_type: "senior-architect"` if that role is in the host enum; otherwise `subagent_type: "general-purpose"` plus `[t1-role: senior-architect]` as prompt line 1',
      modelLine,
    ].join('\n');
  }
  const policy = readRunModelPolicy(cwd, runId);
  const model = policy?.host === 'codex' ? (policy.roles['senior-architect']?.preferredModel || '') : '';
  const modelLine = model
    ? `- \`model: "${model}"\` — exact policy model`
    : '- pass the exact policy model from model-policy.json';
  return [
    '- `task_name: senior_architect`',
    '- `fork_turns: "none"`',
    modelLine,
  ].join('\n');
}

export function shouldEmitBuildOrchestration(cwd: string, state: Rec, host: string): boolean {
  if (!eligibleSubagentsBuild(state, host)) return false;
  try {
    return !fs.existsSync(path.join(cwd, '.traffic-one', 'plan.md'));
  } catch {
    return true;
  }
}

export function shouldEmitArchitectCompletionReminder(cwd: string, state: Rec, host: string): boolean {
  if (!eligibleSubagentsBuild(state, host)) return false;
  try {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', 'plan.md'))) return false;
  } catch {
    return false;
  }
  return architectPhaseIncompleteReasons(cwd, state).length > 0;
}

export function buildOrchestrationDirective(cwd: string, host: string, stateIn?: Rec): string {
  const loadedState = stateIn ?? readEffectiveState(cwd);
  const state = obj(loadedState) ? (loadedState as Rec) : {};
  if (paidHostSubagentsBuild(state, host) && !kiloOpenCodeSubagentsBuild(state, host)) {
    return paidHostOrchestrationDirective(cwd, state, host);
  }
  if (!kiloOpenCodeSubagentsBuild(state, host)) return '';

  const canonical = canonicalHost(host);
  const kilo = canonical === 'kilo';
  const hostLabel = canonical === 'kilo' ? 'Kilo' : 'OpenCode';
  const profile = capabilityProfileForRun(cwd, state);
  const architectSubagentType = kilo ? 'general' : openCodeGlobalAgentName(cwd, 'senior-architect');
  const spawnRule = kilo
    ? 'use Kilo\'s built-in `general` Task type. It is a real subagent; do not use `explore` and do not fall back to main-agent mode.'
    : `use the project-scoped global agent \`${architectSubagentType}\` materialized at ${openCodeGlobalAgentPath(cwd, 'senior-architect')}; do not use built-in \`general\`/\`explore\`.`;
  // CHECKED, not assumed. This clause hands the orchestrator a path to read, and
  // on Kilo that path is a materialized file: a host whose `.kilo/agents` could
  // not be written (a plain file at that path, an unwritable directory) makes the
  // instruction name a file that does not exist, which costs the child a failed
  // read and then leaves it with no contract at all and no idea it is missing.
  // Same check, same reason, as the fallback-child contract line in
  // session-start-setup.ts. OpenCode needs none: its contract travels INSIDE the
  // named global agent, so there is nothing for the child to open.
  const kiloContractRel = kilo ? hostSpawnType('kilo', 'senior-architect', cwd).contractPath : null;
  const kiloContractPresent = Boolean(kiloContractRel && fs.existsSync(path.join(cwd, kiloContractRel)));
  const roleContractInstruction = !kilo
    ? 'The named OpenCode agent already carries the full Traffic One role contract.'
    : kiloContractPresent
      ? `Immediately after the role marker, tell the child to read \`${kiloContractRel}\` before acting; that file is the full Traffic One role contract.`
      : `Do NOT tell the child to read \`${kiloContractRel}\` — Traffic One could not write it, so that file is not there. `
        + 'State the role\'s task and scope inline instead; the `[t1-role: …]` marker is what binds the role. '
        + 'Report to the user that whatever occupies that path has to be cleared.';

  if (shouldEmitBuildOrchestration(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    return block('kilo-opencode-spawn-first', {
      HOST: hostLabel,
      RUN_ID: runId,
      TASK_TOOL: 'task',
      SUBAGENT_TYPE: architectSubagentType,
      SPAWN_RULE: spawnRule,
      ROLE_CONTRACT_INSTRUCTION: roleContractInstruction,
      PROFILE_SUMMARY: profileSummary(profile),
      IMPLEMENTER_DIRECTIVE: implementerDirective(profile, hostLabel),
      QA_DIRECTIVE: qaDirective(profile),
    }, KILO_OPENCODE_SPAWN_FIRST_FALLBACK);
  }

  if (shouldEmitArchitectCompletionReminder(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    const missing = architectPhaseIncompleteReasons(cwd, state).join('; ');
    return block('kilo-opencode-architect-incomplete', {
      HOST: hostLabel,
      RUN_ID: runId,
      TASK_TOOL: 'task',
      SUBAGENT_TYPE: architectSubagentType,
      SPAWN_RULE: spawnRule,
      ROLE_CONTRACT_INSTRUCTION: roleContractInstruction,
      MISSING: missing,
      PROFILE_SUMMARY: profileSummary(profile),
      IMPLEMENTER_DIRECTIVE: implementerDirective(profile, hostLabel),
      QA_DIRECTIVE: qaDirective(profile),
    }, KILO_OPENCODE_ARCHITECT_INCOMPLETE_FALLBACK);
  }

  return '';
}

function paidHostOrchestrationDirective(cwd: string, state: Rec, host: string): string {
  const canonical = canonicalHost(host);
  if (!isPaidHostId(canonical)) return '';
  const hostLabel = canonical === 'cursor' ? 'Cursor' : canonical === 'claude' ? 'Claude' : 'Codex';
  const taskTool = canonical === 'codex' ? 'spawn_agent' : 'Task';
  const profile = capabilityProfileForRun(cwd, state);
  const varsBase = {
    HOST: hostLabel,
    TASK_TOOL: taskTool,
    PROFILE_SUMMARY: profileSummary(profile),
    IMPLEMENTER_DIRECTIVE: implementerDirective(profile, hostLabel),
    QA_DIRECTIVE: qaDirective(profile),
  };

  if (shouldEmitBuildOrchestration(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    return block('paid-host-spawn-first', {
      ...varsBase,
      RUN_ID: runId,
      SPAWN_INSTRUCTIONS: paidHostSpawnInstructions(canonical, cwd, state, runId),
    }, PAID_HOST_SPAWN_FIRST_FALLBACK);
  }

  if (shouldEmitArchitectCompletionReminder(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    const missing = architectPhaseIncompleteReasons(cwd, state).join('; ');
    return block('paid-host-architect-incomplete', {
      ...varsBase,
      RUN_ID: runId,
      SPAWN_INSTRUCTIONS: paidHostSpawnInstructions(canonical, cwd, state, runId),
      MISSING: missing,
    }, PAID_HOST_ARCHITECT_INCOMPLETE_FALLBACK);
  }

  return '';
}
