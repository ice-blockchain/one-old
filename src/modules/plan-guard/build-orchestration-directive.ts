// src/modules/plan-guard/build-orchestration-directive.ts
// Post-setup build-start directive for OpenCode/Kilo hosts: the orchestrator must
// spawn senior-architect via the host task tool BEFORE any feature-source or
// monorepo scaffold writes. OpenCode exposes the materialized named role agents;
// Kilo's Task API reliably exposes its built-in general worker, which reads the
// matching materialized role contract before it works.

import * as fs from 'fs';
import * as path from 'path';

import { architectPhaseIncompleteReasons } from './plan-readiness';
import { capabilityProfileForRun } from '../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../shared/capabilities';
import { hostFlags } from '../../shared/host/capability-flags';
import { hostSpawnType } from '../../shared/host/spawn-types';
import { canonicalHost } from '../../shared/model-tiers';
import { obj, type Rec } from '../../shared/obj';
import { pluginRoot } from '../../shared/paths';
import { teamModeForLevel } from '../../shared/performance';
import { makeSkillBlock } from '../../shared/skill-block';
import { ensureCurrentRunId, isMaintenancePhase, isNewProjectMode, readEffectiveState } from '../../shared/state';
import { openCodeGlobalAgentName, openCodeGlobalAgentPath } from '../../shared/materialize/opencode-assets';

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
  const team = obj(state.team);
  if (!team || team.mode !== 'subagents' || team.approved !== true) return false;
  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  if (level && teamModeForLevel(level) !== 'subagents') return false;
  return true;
}

export function shouldEmitBuildOrchestration(cwd: string, state: Rec, host: string): boolean {
  if (!kiloOpenCodeSubagentsBuild(state, host)) return false;
  try {
    return !fs.existsSync(path.join(cwd, '.traffic-one', 'plan.md'));
  } catch {
    return true;
  }
}

export function shouldEmitArchitectCompletionReminder(cwd: string, state: Rec, host: string): boolean {
  if (!kiloOpenCodeSubagentsBuild(state, host)) return false;
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
