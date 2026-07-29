// src/runners/onboarding-wait/pre-spawn-directives.ts
// Pre-spawn directives: OpenCode restart, orchestration, run-id minting,
// and the Windsurf/Devin architect directive.

import { capabilityProfileForRun } from '../../shared/architecture-contract';
import { buildOrchestrationDirective } from '../../modules/plan-guard/build-orchestration-directive';
import { buildPreSpawnOpenCodeDirective } from '../../shared/opencode-plan/directive';
import { detectHost } from '../../shared/host';
import { detectHostPlan } from '../../shared/host/plan';
import { freshCursorModels } from '../../shared/materialize/cursor-models';
import { modelCaptureCommand } from '../../shared/model-gate-command';
import { canonicalHost } from '../../shared/model-tiers';
import { obj } from '../../shared/obj';
import { ensureCurrentRunId,  readEffectiveState } from '../../shared/state';
import { ensureRunModelPolicy, readRunModelPolicy } from '../../shared/run-model-policy';

export function preSpawnOpenCodeDirective(cwd: string, host: string = detectHost()): string {
  return buildPreSpawnOpenCodeDirective(cwd, host);
}

export function openCodeRestartWarning(): string {
  return [
    'TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED',
    '',
    'Traffic One onboarding is complete, but OpenCode must be restarted before development continues.',
    'Restart OpenCode to load the onboarding settings and new agent definitions.',
    'After restart, return to this project and type "continue" or "resume" to continue development.',
  ].join('\n');
}

// Host-agnostic PRE-SPAWN run-id directive, emitted at SETUP_COMPLETE on the main thread (the
// same stdout channel that reliably reaches the Cursor user/agent). Models STILL fabricate a
// `date`/ISO run-id in spawn prompts despite the PreToolUse announce (observed: composer-2.5
// typing `2026-06-23T10-30-00Z` instead of the gate-minted epoch-ms `currentRunId`). Mint/persist
// here so the orchestrator reads the exact value BEFORE building the first spawn prompt. The
// spawn gate's run-id deny + self-healing echo remains the backstop. Returns '' for non-new-project.
export function preSpawnOrchestrationDirective(cwd: string, host: string = detectHost()): string {
  return buildOrchestrationDirective(cwd, host);
}

export function preSpawnRunIdDirective(cwd: string, host: string = detectHost()): string {
  try {
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: host }) as Record<string, unknown>;
    const team = obj(state?.team);
    if (!state || team?.mode !== 'subagents') return '';
    const runId = ensureCurrentRunId(cwd, state);
    if (!runId) return '';
    const existingPolicy = readRunModelPolicy(cwd, runId);
    if (existingPolicy && existingPolicy.host !== canonicalHost(host)) {
      return [
        'TRAFFIC_ONE_MODEL_POLICY_BLOCKED',
        `Run ${runId} is frozen for ${existingPolicy.host}, not ${canonicalHost(host)}.`,
        'Start a new parent run for the active host; do not rebase model-policy.json.',
      ].join('\n');
    }
    if (canonicalHost(host) === 'cursor') {
      const plan = detectHostPlan('cursor');
      if (!existingPolicy && freshCursorModels(cwd, plan).length === 0) {
        return [
          'TRAFFIC_ONE_CURSOR_MODELS_REQUIRED',
          `Traffic One has not frozen run ${runId}: Cursor's current Task model picker must be captured first.`,
          'Enumerate the exact model ids offered to subagents verbatim (an id may or may not include a reasoning suffix), then run:',
          modelCaptureCommand(cwd, 'cursor'),
          'This writes only the project\'s local user preferences. Retry setup completion afterward; the same run id will then receive its immutable model-policy.json.',
        ].join('\n');
      }
    }
    // Always run the parent bootstrap preflight. A valid immutable policy does
    // not prove that its capability baseline and architect envelope were
    // published; short-circuiting on `existingPolicy` previously let setup
    // claim completion before the first real tool call failed.
    const policy = ensureRunModelPolicy(
      cwd, runId, host, state, { ...process.env, TRAFFIC_ONE_HOST: host },
    );
    if (!policy) {
      const frozenPolicy = readRunModelPolicy(cwd, runId);
      if (frozenPolicy) {
        return [
          'TRAFFIC_ONE_BOOTSTRAP_BLOCKED',
          `Run ${runId} already has a valid immutable model policy and saved Performance choice, but Traffic One could not publish or validate its capability baseline and parent bootstrap.`,
          'Do not spawn a child and do not redo onboarding. Update or repair Traffic One, then retry setup completion with the same run.',
        ].join('\n');
      }
      return [
        'TRAFFIC_ONE_MODEL_POLICY_BLOCKED',
        'Traffic One could not freeze the acknowledged Performance/model catalog for this run.',
        'Do not spawn a child. Reopen Performance, confirm the active choice, then retry setup completion.',
      ].join('\n');
    }
    if (state.mode !== 'new-project') {
      return [
        '[traffic-one] Immutable run model policy is ready before delegation:',
        `- run: \`${runId}\``,
        `- policy: \`.traffic-one/runs/${runId}/model-policy.json\` (\`${policy.policyId}\`)`,
        '- Every spawn, replacement, and retry must use the role model recorded in that file.',
      ].join('\n');
    }
    return [
      '[traffic-one] Build run-id — use EXACTLY this value in every spawn prompt (never `date`, ISO, or UTC):',
      `- currentRunId in .traffic-one/.one.json: \`${runId}\``,
      `- Immutable model policy: \`.traffic-one/runs/${runId}/model-policy.json\` (\`${policy.policyId}\`)`,
      `- Assignments: \`.traffic-one/runs/${runId}/assignments.json\``,
      `- Digests: \`.traffic-one/digests/${runId}/<role>.md\``,
      `- Spawn prompt line: \`Run ID: ${runId}\``,
      'Wrong run-id in a spawn prompt is denied; copy the paths above verbatim.',
    ].join('\n');
  } catch {
    return '';
  }
}

export function preSpawnRunIdBlocksSetup(directive: string): boolean {
  return directive.startsWith('TRAFFIC_ONE_MODEL_POLICY_BLOCKED')
    || directive.startsWith('TRAFFIC_ONE_CURSOR_MODELS_REQUIRED')
    || directive.startsWith('TRAFFIC_ONE_BOOTSTRAP_BLOCKED');
}

// Windsurf/Devin-only PRE-SPAWN architect directive, emitted at SETUP_COMPLETE. Devin Local's
// SWE-tier agent otherwise jumps straight to an off-stack scaffolder (create-next-app) instead of
// spawning the architect. Other hosts get this flow from AGENTS.md read-routing; Windsurf gets no
// post-setup nudge, so front-load it here. The scaffolder gate is the hard backstop; this is the
// proactive "do this next" push so the build follows the flow smoothly. Returns '' off Windsurf,
// for non-new-project, or on any read error.
export function preSpawnArchitectDirective(cwd: string, host: string = detectHost()): string {
  if (canonicalHost(host) !== 'windsurf') return '';
  try {
    const state = readEffectiveState(cwd) as Record<string, unknown>;
    if (!state || state.mode !== 'new-project') return '';
    const profile = capabilityProfileForRun(cwd, state);
    const implementers = profile.roles.filter((role) => role === 'senior-frontend' || role === 'senior-backend');
    const implementerStep = implementers.length === 2
      ? `spawn ${implementers.map((role) => `\`${role}\``).join(' and ')} in parallel`
      : implementers.length === 1
        ? `spawn only \`${implementers[0]}\` (do not invent the ineligible sibling role)`
        : 'do not invent a frontend/backend implementer; continue with verifier roles';
    const qa = profile.surfaces.includes('native-ui')
      ? `use native QA (${profile.qaAdapters.join(', ') || 'simulator/emulator'}), never browser QA`
      : profile.surfaces.includes('web-ui')
        ? `derive uiImpact and use ${profile.qaAdapters.join(', ') || 'Playwright'} only for behavioral/visual UI risk`
        : 'run stack-native build/test/lint checks; do not assign browser, screenshot, design, or frontend QA';
    return [
      '[traffic-one] Windsurf build flow — do this FIRST, before writing or scaffolding anything:',
      `1. Runtime capability contract: profile \`${profile.profileId}\`; framework \`${profile.framework}\`;`,
      `   surfaces \`${profile.surfaces.join(', ') || 'none'}\`; source roots \`${profile.sourceRoots.join(', ') || 'none'}\`;`,
      `   skill buckets \`${profile.skillBuckets.join(', ') || 'universal only'}\`. Build ONLY on that contract; do not substitute an unrelated stack, QA adapter, or implementation role.`,
      '2. Spawn the architect FIRST with `run_subagent` profile `subagent_general` (custom profiles materialized',
      '   during onboarding are not registered until a new Devin session). The task MUST start with',
      '   `[t1-role: senior-<role>]` (substitute the spawned role; architect here), then tell the child to read `.devin/agents/senior-architect/AGENT.md`.',
      '   It writes',
      '   `.traffic-one/plan.md` (PLAN_READY), the runtime architecture input, and only the scaffold outputs allowed by the compiled contract. Development is BLOCKED until',
      '   `.traffic-one/plan.md` exists (the scaffolder + plan gates deny premature/off-stack commands).',
      `3. After PLAN_READY, ${implementerStep} via \`subagent_general\`, with each \`[t1-role: senior-…]\` marker first`,
      '   and an instruction to read the matching `.devin/agents/<role>/AGENT.md` contract,',
      `   then \`senior-reviewer\` + \`senior-tester\`. QA: ${qa}. Build ON the compiled plan the architect produced.`,
    ].join('\n');
  } catch {
    return '';
  }
}

// Cursor-only PRE-SPAWN model directive, emitted at SETUP_COMPLETE on the main thread (the same
// stdout channel that reliably reaches the Cursor user/agent). It front-loads everything the spawn
// gate would otherwise deny-and-retry: (1) capture the build's model list, (2) check the chosen
// tier models are actually offered (else ASK the user — disabled/limit), (3) the exact per-role
// model map to pass. Resolving this BEFORE the first spawn turns the observed spawn→deny→retry
// dance (capture deny + model-param deny) into a single clean spawn. The PreToolUse gates remain
// the backstop. Returns '' for non-Cursor hosts, non-new-project, non-subagents levels, or on any
// read error — so Claude/Codex and main-agent builds print nothing.
// Claude — per-role spawn map, emitted at SETUP_COMPLETE right after the run-id
// directive froze model-policy.json. Front-loading it makes the FIRST spawn
// carry the correct `model` parameter — without it the root spawns model-less,
// the Performance gate denies, and the host renders that deny as "failed to
// run agent" (observed 1cl + 2cl; both self-recovered but burned a retry each).
// Returns '' for non-new-project, non-subagents levels, or on any read error.

// Claude's Agent tool `model` parameter is an ENUM OF FAMILY ALIASES
// (sonnet|opus|haiku|fable), not a model-id field: a spawn that copies the
// policy's full id verbatim fails the host's own InputValidationError before
// any Traffic One gate runs (observed 6cl: `model: "claude-opus-4-8"` →
// "Failed to run agent", recovered only by re-reading model-policy.json and
// retrying with `opus`). Print the alias as the value to PASS and keep the
