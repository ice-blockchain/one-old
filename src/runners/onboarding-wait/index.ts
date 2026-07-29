// src/runners/onboarding-wait/index.ts
// A BLOCKING wait the agent runs right after opening the setup wizard, so the build
// resumes automatically when setup finishes — with no extra message from the user.
// It polls the SAME completeness predicate the gate uses (computeOnboarding(cwd).done),
// sleeping between checks (the only child process is the degraded-path /bin/sleep
// fallback). On completion it ALSO emits the maintenance-triage routing for the
// user's seeded original request: the agent continues that request inside the
// SAME turn, so no UserPromptSubmit hook ever fires for it — without this, the
// quick-fix/role/orchestrator + OpenCode-first rubric is never injected and the
// agent implements inline (which may write a fresh runId + once-marker).
// Compiles to dist/scripts/onboarding-wait.cjs via the build SHIM.
//
//   node onboarding-wait.cjs <cwd> [--timeout-ms <n>] [--interval-ms <n>]
//
// stdout TRAFFIC_ONE_SETUP_COMPLETE, exit 0 → setup finished; continue the build now.
// stdout TRAFFIC_ONE_SETUP_READY,    exit 0 → bootstrap-only started the wizard; open URL, then run normal waiter.
// stdout TRAFFIC_ONE_SETUP_BOOTSTRAP_REQUIRED, exit 2 → retry bootstrap with approved user-local state access.
// stdout TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED, exit 2 → setup finished, but OpenCode
//   must be restarted before development continues.
// stdout TRAFFIC_ONE_SETUP_PENDING,  exit 2 → still pending after the timeout; re-run.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

import { maintenanceTriageDirective } from '../../modules/session/triage-directive';
import { capabilityProfileForRun } from '../../shared/architecture-contract';
import { buildOrchestrationDirective } from '../../shared/build-orchestration-directive';
import { buildPreSpawnOpenCodeDirective } from '../../shared/opencode-plan-directive';
import { AGENT_ROLES } from '../../config/performance';
import { detectMode } from '../../shared/detection';
import { detectHost } from '../../shared/host';
import { detectHostPlan } from '../../shared/host-plan';
import { hostSpawnType } from '../../shared/host-spawn-types';
import { materializeProjectIfNeeded, writeOpenCodeHostAssets } from '../../shared/materialize';
import { buildCursorSpawnModelMap } from '../../shared/materialize/cursor-spawn-map';
import { freshCursorModels } from '../../shared/materialize/cursor-models';
import { modelCaptureCommand, modelGateCommand } from '../../shared/model-gate-command';
import { canonicalHost } from '../../shared/model-tiers';
import { currentAcceptableModels } from '../../shared/current-model-tiers';
import { obj } from '../../shared/obj';
import { pluginUseDeclined, recordPluginUseChoice } from '../../shared/state/plugin-use';
import { seedOriginalPrompt } from '../../shared/onboarding/seed-prompt';
import {
  onboardingBootstrapCommand,
  onboardingSyncSessionId,
  onboardingUseBootstrapCommand,
  onboardingWaitCommand,
} from '../../shared/onboarding-server/wait-command';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import {
  isOnboardingPermissionError,
  onboardingBootstrapReason,
  onboardingStartFailureReason,
} from '../../shared/onboarding-server/bootstrap';
import { ensureOnboardingServer } from '../../shared/onboarding-server/ensure';
import { agentOnboardingUrls } from '../../config/dashboard';
import { readServerRecord } from '../../shared/onboarding-server/registry';
import { localFallbackSection, wizardOpened } from '../../shared/onboarding-server/wizard-links';
import { awaitDashboardHealth } from '../../shared/onboarding-server/dashboard-health';
import { emittedWithin, stampEmitMarker } from '../../shared/once';
import { ensureOnboardingWaitPermission } from '../../shared/onboarding-server/wait-permission';
import { modelForRoleHost, teamModeForLevel } from '../../shared/performance';
import { ensureCurrentRunId, normalizeState, readEffectiveState } from '../../shared/state';
import { ensureRunModelPolicy, readRunModelPolicy } from '../../shared/run-model-policy';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import {
  syncOneMcpForSession,
  syncOneMcpOnce,
  type SessionOneMcpSync,
} from '../../modules/session/one-mcp-sync';

// 8 min keeps a single run safely under the host's ~10-min shell cap, so the agent
// gets a clean PENDING signal (rather than a hard kill) when the user is slow.
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2000;
// How recently THIS runner printed its own terminal banner. Deliberately short and
// deliberately scoped to the banner alone: it stops the same block appearing twice
// back-to-back in one turn, and gates no other surface. The old cross-surface
// "links were shown" marker is gone — see shared/onboarding-server/wizard-links.ts.
const WIZARD_BANNER_REPRINT_MS = 90 * 1000;

function bannerMarkerLabel(token: string): string {
  return `wizard-banner-printed:${createHash('sha256').update(token || 'pending', 'utf8').digest('hex').slice(0, 20)}`;
}

export type WaitOutcome = 'complete' | 'pending';

function positiveIntFlag(args: readonly string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const n = Number.parseInt(args[i + 1] || '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Block the thread for `ms` without busy-spinning the CPU (no event-loop work runs
// between polls). Falls back to /bin/sleep when SharedArrayBuffer is disabled —
// re-polling immediately here would spin a core for the whole (up to 8-minute) wait.
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    try {
      execFileSync('/bin/sleep', [String(Math.max(0, ms) / 1000)], { stdio: 'ignore' });
    } catch {
      // No sleep available either — re-poll immediately rather than throw.
    }
  }
}

function onboardingDone(cwd: string): boolean {
  try {
    return computeOnboarding(cwd).done;
  } catch {
    return false;
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  // Seams for tests (avoid real clock + state IO).
  isComplete?: (cwd: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => void;
}

export function waitForOnboarding(cwd: string, options: WaitOptions = {}): WaitOutcome {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const isComplete = options.isComplete ?? onboardingDone;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (isComplete(cwd)) return 'complete';
    if (now() >= deadline) return 'pending';
    sleep(intervalMs);
  }
}

// The post-setup routing for the request the agent is about to continue. The
// prompt was seeded into state.originalPrompt by the setup-required branch of
// UserPromptSubmit; non-maintenance projects (fresh new-project builds) and
// non-edit prompts return '' — the orchestrator flow owns those.
export function postSetupTriage(cwd: string): string {
  try {
    const state = JSON.parse(JSON.stringify(readEffectiveState(cwd))) as Record<string, unknown>;
    const prompt = typeof state.originalPrompt === 'string' ? state.originalPrompt.trim() : '';
    if (!prompt) return '';
    normalizeState(state, (state.mode as string) || detectMode(cwd));
    return maintenanceTriageDirective(cwd, state, prompt, {}, detectHost());
  } catch {
    return '';
  }
}

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
// full id as the policy target the gate verifies.
function claudeAgentToolAlias(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('fable')) return 'fable';
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  return modelId;
}

function claudeSpawnModelDirective(cwd: string): string {
  try {
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'claude' }) as Record<string, unknown>;
    if (!state || state.mode !== 'new-project') return '';
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    const policy = runId ? readRunModelPolicy(cwd, runId) : null;
    if (!policy || policy.host !== 'claude') return '';
    if (teamModeForLevel(policy.performanceLevel || '') !== 'subagents') return '';
    const rows: string[] = [];
    for (const role of AGENT_ROLES) {
      const rolePolicy = policy.roles[role];
      if (!rolePolicy?.preferredModel) continue;
      const alias = claudeAgentToolAlias(rolePolicy.preferredModel);
      rows.push(`   - ${role} → subagent_type: "traffic-one:${role}", model: "${alias}" (policy model: ${rolePolicy.preferredModel})`);
    }
    if (!rows.length) return '';
    return [
      `[traffic-one] Claude — per-role spawn map for run \`${runId}\` (immutable policy \`${policy.policyId}\`):`,
      '- Pass BOTH parameters on EVERY Agent spawn — the `subagent_type` AND the exact `model` alias below. The Agent tool accepts ONLY the alias values sonnet|opus|haiku|fable (a full model id fails the tool\'s own input validation as "failed to run agent" before any gate runs). A spawn without `model` inherits the parent session model, so the Performance gate denies it — passing the alias below on the FIRST spawn avoids the deny+retry entirely.',
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
    if (!state || state.mode !== 'new-project') return '';
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
      // Emitted at SETUP_COMPLETE, i.e. in the very session that materialized
      // `.cursor/agents/**` — recommend the built-in worker so the first spawn
      // is not a guaranteed "Couldn't start" (see formatCursorSpawnMapLines).
      const cursorSpawn = hostSpawnType('cursor', role);
      rows.push(`   - ${role} → subagent_type: "${cursorSpawn.fallback || cursorSpawn.primary}", model: ${spawnValue}`);
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
        '- The built-in worker type above is deliberate: `.cursor/agents/<role>.md` is written during this session, so a role-named `subagent_type` is not in the type list this session captured and Cursor answers "Couldn\'t start". The role is carried by the `[t1-role: senior-<role>]` FIRST prompt line — always include it, and tell the child to read `.cursor/agents/<role>.md`. Never build the role inline.',
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
      '   The built-in worker type above is deliberate: `.cursor/agents/<role>.md` is written during this session, so a role-named `subagent_type` is not in the type list this session captured and Cursor answers "Couldn\'t start". The role is carried by the `[t1-role: senior-<role>]` FIRST prompt line — always include it, and tell the child to read `.cursor/agents/<role>.md`. Never build the role inline.',
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
// there too). Best-effort: no record / placeholder URL ⇒ print nothing.
export function announceWizardUrl(
  cwd: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
  host: string = detectHost(),
  sessionId?: string,
): void {
  try {
    const rec = readServerRecord(cwd, process.env, host);
    if (!rec || !rec.url || rec.url.includes(':0/')) return;
    const urls = agentOnboardingUrls(process.env, rec.port, rec.token);
    const link = urls.dashboardUrl || urls.localWizardUrl;
    // The user has the wizard open in a browser — the server watched it arrive.
    // Keep a compact wait line so the terminal output still explains the block.
    // Note this is the ONLY thing that suppresses the banner: "some surface
    // already printed the URL" is explicitly NOT evidence the user saw it.
    if (wizardOpened(cwd, rec.token, process.env, host)) {
      write('\nWaiting for Traffic One setup to complete (the wizard is open in your browser; this command keeps the turn open)…\n');
      return;
    }
    // The banner is this process's own stdout, which several surfaces can print
    // near-simultaneously in one turn. A short production-scoped marker keeps the
    // terminal from showing the same block twice back-to-back — it never gates any
    // OTHER surface, so it cannot cause the silence this file exists to prevent.
    if (emittedWithin(cwd, bannerMarkerLabel(rec.token), WIZARD_BANNER_REPRINT_MS)) {
      write('\nWaiting for Traffic One setup to complete (setup link shown just above)…\n');
      return;
    }
    const localFallback = localFallbackSection(cwd, urls.localWizardUrl, process.env, host);
    const banner = (
      '\n════════════════════════════════════════════════════════════════\n'
      + '  TRAFFIC ONE SETUP — open this link in your browser to finish setup:\n\n'
      + `  ${link}\n\n`
      + (localFallback ? `  ${String(localFallback)}\n` : '')
      + '  Enter your API key and complete the setup steps.\n'
      + `  Setup link: ${link}\n`
      + '  Waiting for setup to complete (this command keeps the turn open)…\n'
      + '════════════════════════════════════════════════════════════════\n'
    );
    write(banner);
    stampEmitMarker(cwd, bannerMarkerLabel(rec.token));
  } catch {
    // best-effort — the wait still works without the banner
  }
}

// The bootstrap's stdout is NOT a user-visible surface on every host — Cursor
// collapses it into a "ran N commands" block. It used to stamp a cross-surface
// "links were shown" marker and tell the agent not to print the URLs again, which
// is precisely how a run reached the user with the agent asserting "link already
// shared above" over a conversation that had never contained a link (2cu, 5cu).
// It now stamps nothing and instructs the opposite.
export function bootstrapReadyOutput(
  cwd: string,
  _token: string,
  dashboardUrl: string,
  localWizardUrl: string,
  host?: string,
): string {
  const localFallback = localFallbackSection(cwd, localWizardUrl, process.env, host);
  return `TRAFFIC_ONE_SETUP_READY\nSetup link: ${dashboardUrl || localWizardUrl}\n`
    + (localFallback ? `${String(localFallback)}\n` : '')
    + 'Post the setup link to the user in your next CHAT MESSAGE, as plain clickable text on its own line. '
    + 'This command output does not count as showing it — several hosts collapse or hide it. '
    + 'Do NOT open the link yourself with a browser tool or an `open`/`xdg-open`/`start` command; the user clicks it.\n';
}

// The setup tab belongs to the user. Traffic One neither opens nor closes it —
// the agent-driven `browser_tabs` close directive that used to live here was part
// of the same "the agent drives the browser" model that left users with no link
// at all (2cu: navigate, claim "links were shared above", close the tab).

// Bounded grace: `computeOnboarding().done` flips on the LAST /answer, which is
// seconds BEFORE the wizard tab finishes (`/verify-toolchain` → `/complete` →
// done view). `/complete` shuts the server down and clears its record, so a short
// poll on the record lets the wizard settle before the build resumes — this is a
// LOCAL poll ordering our own shutdown ahead of materialization, not a browser
// action. Capped so a tab that never posts /complete (closed early, network
// error) cannot stall the released build.
const COMPLETION_ACK_GRACE_MS = 4000;
const COMPLETION_ACK_POLL_MS = 250;

export function awaitWizardCompletionAck(cwd: string, host: string, graceMs: number = COMPLETION_ACK_GRACE_MS): void {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      if (!readServerRecord(cwd, process.env, host)) return; // /complete landed — server gone
    } catch {
      return;
    }
    sleepSync(COMPLETION_ACK_POLL_MS);
  }
}

// The --decline output: records the durable opt-out. A setup tab the user may
// still have open is theirs to close — we do not drive their browser.
export function declineOutput(cwd: string, _host: string): string {
  recordPluginUseChoice(cwd, false, 'command');
  return 'TRAFFIC_ONE_DISABLED\n'
    + "Traffic One is disabled for this project — continue the user's request without Traffic One conventions. "
    + 'It stays silent here until the user explicitly asks for Traffic One again.\n';
}

// The `--use` yes path: record the durable per-project opt-in, then seed the
// request that triggered the ask-first question (`--seed-prompt=…`). In that
// flow NOTHING was written before this recorded yes — this is the FIRST write
// that may create the project's .traffic-one folder, exactly at decision time.
// The seed feeds the wizard's stack derivation and the post-setup triage.
export function applyUseChoice(
  cwd: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  recordPluginUseChoice(cwd, true, 'command', env);
  const seedArg = argv.find((a) => a.startsWith('--seed-prompt='));
  if (seedArg) seedOriginalPrompt(cwd, seedArg.slice('--seed-prompt='.length));
}

function syncSessionFromArgv(argv: readonly string[]): string {
  const flag = argv.find((arg) => arg.startsWith('--sync-session='));
  return onboardingSyncSessionId(flag?.slice('--sync-session='.length));
}

// Consent-phase writes (`--use` prefs under ~/.traffic-one) are the first thing
// main() does, and they crashed with a raw Node EPERM stack when the command ran
// inside a host sandbox that cannot write the user-local state root (observed
// 8c-codex: the ask-first YES bootstrap in Codex's workspace-write sandbox — the
// model had to improvise the escalated retry from the stack trace). Map that
// failure to the same clean, actionable recipe the launcher path already prints,
// prescribing the ORIGINAL command (--use and --seed-prompt intact) so the
// recorded yes is not lost on the escalated re-run.
export function consentPhaseFailureOutput(
  cwd: string,
  host: ReturnType<typeof detectHost>,
  argv: readonly string[],
  error: unknown,
): string {
  const seedArg = argv.find((arg) => arg.startsWith('--seed-prompt='));
  const retryCommand = argv.includes('--use')
    ? onboardingUseBootstrapCommand(cwd, host, seedArg?.slice('--seed-prompt='.length), syncSessionFromArgv(argv))
    : onboardingBootstrapCommand(cwd, host, syncSessionFromArgv(argv));
  return isOnboardingPermissionError(error)
    ? `TRAFFIC_ONE_SETUP_PERMISSION_REQUIRED\n\n${onboardingBootstrapReason(cwd, host, error, retryCommand)}\n`
    : `TRAFFIC_ONE_SETUP_START_FAILED\n\n${onboardingStartFailureReason(error, host)}\n`;
}

export function syncOneMcpBeforeOnboarding(
  cwd: string,
  host: unknown,
  argv: readonly string[],
  sync: SessionOneMcpSync = syncOneMcpForSession,
  env: NodeJS.ProcessEnv = process.env,
  featureEnabled?: boolean,
): boolean {
  return syncOneMcpOnce(cwd, host, syncSessionFromArgv(argv), env, sync, featureEnabled);
}

// Reconsideration follows an explicit user request to enable Traffic One, so it
// is exact opt-in—not a return to an undecided state. Persist that consent before
// any public sync; the normal setup flow starts only after this helper returns.
export function applyReconsiderChoice(
  cwd: string,
  host: unknown,
  sync: SessionOneMcpSync = syncOneMcpForSession,
  syncSession?: string,
  env: NodeJS.ProcessEnv = process.env,
  featureEnabled?: boolean,
): void {
  recordPluginUseChoice(cwd, true, 'reconsider', env);
  syncOneMcpOnce(cwd, host, onboardingSyncSessionId(syncSession), env, sync, featureEnabled);
}

interface BeginOnboardingOptions {
  sync?: SessionOneMcpSync;
  env?: NodeJS.ProcessEnv;
  featureEnabled?: boolean;
  isDone?: (cwd: string) => boolean;
}

// The single entry to every path that is about to read wizard state or
// start/reuse its server. Consent mutations happen first; public config sync
// happens next; only then may computeOnboarding run. A normal waiter and
// --bootstrap-only therefore cannot render stale bundled tiers merely because
// SessionStart was skipped or ran in another process.
export function beginOnboardingAttempt(
  cwd: string,
  host: unknown,
  argv: readonly string[],
  options: BeginOnboardingOptions = {},
): boolean {
  const sync = options.sync || syncOneMcpForSession;
  const env = options.env || process.env;
  const syncSession = syncSessionFromArgv(argv);
  const reconsider = argv.includes('--reconsider');

  if (reconsider) {
    applyReconsiderChoice(cwd, host, sync, syncSession, env, options.featureEnabled);
  }
  if (argv.includes('--use')) {
    applyUseChoice(cwd, argv, env);
  }
  // Reconsider already synchronized immediately after persisting consent. All
  // other parent paths converge here, including normal wait and bootstrap-only.
  if (!reconsider) syncOneMcpBeforeOnboarding(cwd, host, argv, sync, env, options.featureEnabled);

  return (options.isDone || onboardingDone)(cwd);
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const cwd = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const host = detectHost(process.env, argv);
  initializeTrafficOneEnv(cwd, host);
  // Durable per-project opt-out/opt-in. The choice lives in the per-user prefs
  // (never inside the repo); a decline also sweeps any pre-decline runtime
  // files, so the project keeps no .traffic-one folder.
  if (argv.includes('--decline')) {
    process.stdout.write(declineOutput(cwd, host));
    process.exit(0);
  }
  const reconsider = argv.includes('--reconsider');
  let alreadyDone = false;
  try {
    alreadyDone = beginOnboardingAttempt(cwd, host, argv);
  } catch (error) {
    process.stdout.write(consentPhaseFailureOutput(cwd, host, argv, error));
    process.exit(2);
  }
  if (reconsider) {
    process.stdout.write(
      'TRAFFIC_ONE_RECONSIDER\n'
      + 'Traffic One is enabled for this project again. Starting setup now.\n',
    );
  }
  // "Yes, use Traffic One here" — record the answer, then continue straight into
  // the normal wait behavior below (start wizard, print the link, block). With
  // `--bootstrap-only` it instead exits right after printing the link (the
  // ask-first recipe's fast first half, so the agent can show the link before
  // running the blocking waiter).
  // Consent + model sync for --use happened in beginOnboardingAttempt before
  // its first computeOnboarding read.
  // Self-heal a dead wizard link: the server the gate minted can die between then
  // and this wait (host restart, crash), leaving the agent's shown link broken and
  // the poll never completing. Re-ensure it here (idempotent — respawns only a
  // dead/stale record) so announceWizardUrl below always prints a LIVE url. Skipped
  // once setup is done, and best-effort (respects TRAFFIC_ONE_ONBOARDING_NO_SPAWN).
  let launchError: unknown;
  let ensuredLocalUrl = '';
  let ensuredDashboardUrl = '';
  let ensuredToken = '';
  let launchedServer = false;
  try {
    if (!alreadyDone) {
      const server = ensureOnboardingServer(cwd, { host });
      if (server.localWizardUrl && !server.localWizardUrl.includes(':0/')) {
        ensuredLocalUrl = server.localWizardUrl;
        ensuredDashboardUrl = server.dashboardUrl;
        ensuredToken = server.token;
        launchedServer = server.started;
      }
    }
  } catch (error) {
    launchError = error;
  }

  if (argv.includes('--bootstrap-only')) {
    if (alreadyDone) {
      process.stdout.write('TRAFFIC_ONE_SETUP_COMPLETE\n');
      process.exit(0);
    }
    if (launchError || !ensuredLocalUrl) {
      const failure = launchError || Object.assign(new Error('wizard did not publish a live URL'), { code: 'START_FAILED' });
      // This command already ran through the host's approved shell boundary.
      // Re-prescribing itself would loop forever for packaging bugs, malformed
      // state roots, child crashes, or even a permission denial that approval did
      // not resolve. Emit one terminal diagnostic instead.
      process.stdout.write(`TRAFFIC_ONE_SETUP_BOOTSTRAP_FAILED\n\n${onboardingStartFailureReason(failure, host)}\n`);
      process.exit(2);
    }
    // The follow-up wait command has a per-session argument tail the host's
    // permission classifier may not recognize; pre-allow it while we are still
    // inside this user-approved shell boundary.
    ensureOnboardingWaitPermission(cwd, host);
    // This prints the FIRST link the user ever sees, so it is the one surface worth
    // briefly waiting on the dashboard verdict for — otherwise the probe is always
    // still in flight here and the first message needlessly carries two URLs.
    // Bounded, and only when THIS invocation started the server: a reused server has
    // already written its verdict, and where no server process exists (NO_SPAWN)
    // nothing will ever write one, so waiting would just burn the timeout.
    if (launchedServer) awaitDashboardHealth(cwd, process.env, host);
    // `Setup link:` must carry the traffic.io dashboard deep link — the same URL
    // every other setup surface shows (observed on OpenCode: printing the raw
    // loopback URL here made the agent repost 127.0.0.1 instead of traffic.io).
    process.stdout.write(bootstrapReadyOutput(
      cwd,
      ensuredToken,
      ensuredDashboardUrl,
      ensuredLocalUrl,
      host,
    ));
    process.exit(0);
  }
  // A live server record means the wizard is up, so a launch error here is stale
  // and must not be reported as a hard failure.
  let wizardUrl = '';
  try {
    const record = readServerRecord(cwd, process.env, host);
    if (record?.url && !record.url.includes(':0/')) wizardUrl = record.url;
  } catch {
    // best-effort — a missing record just means we fall through to the error path
  }
  if (launchError && !wizardUrl && !alreadyDone) {
    const reason = isOnboardingPermissionError(launchError)
      ? onboardingBootstrapReason(cwd, host, launchError)
      : onboardingStartFailureReason(launchError, host);
    const marker = isOnboardingPermissionError(launchError)
      ? 'TRAFFIC_ONE_SETUP_BOOTSTRAP_REQUIRED'
      : 'TRAFFIC_ONE_SETUP_START_FAILED';
    process.stdout.write(`${marker}\n\n${reason}\n`);
    process.exit(2);
  }
  if (!argv.includes('--quiet-url')) announceWizardUrl(
    cwd,
    (s) => process.stdout.write(s),
    host,
    syncSessionFromArgv(argv),
  );
  const outcome = waitForOnboarding(cwd, {
    timeoutMs: positiveIntFlag(argv, '--timeout-ms') ?? undefined,
    intervalMs: positiveIntFlag(argv, '--interval-ms') ?? undefined,
  });
  if (outcome === 'complete') {
    // Let the wizard finish its /complete handshake (bounded) so its shutdown lands
    // before materialization below, and the user sees the done view.
    if (host === 'cursor' && !alreadyDone) awaitWizardCompletionAck(cwd, host);
    // The user declined Traffic One through the pre-onboarding plugin-use choice:
    // unblock the build with NO materialization, triage, or orchestration
    // directives — the project keeps no .traffic-one folder and the hooks stand
    // down from here on.
    if (pluginUseDeclined(cwd)) {
      process.stdout.write(
        'TRAFFIC_ONE_DISABLED\n'
        + "Traffic One is disabled for this project — continue the user's request without Traffic One conventions.\n",
      );
      process.exit(0);
    }
    // Converge project materialization NOW, before the agent resumes and spawns its
    // first subagent. Without this the architect (Phase-1, the FIRST spawn) races the
    // bundle: onboarding is `confirmed` but `manifest`/`rules`/`skills`/`AGENTS.md`
    // aren't stamped for ~tens of seconds, so the agent-model gate denies the spawn
    // ("materialization not complete" → Cursor renders "New subagent — Couldn't
    // start"), and the agent falls back to building the role INLINE (observed 13b).
    // Materializing here makes the bundle ready at SETUP_COMPLETE, so the first spawn
    // is clean. Idempotent + best-effort (the gate still self-heals if this is skipped).
    try {
      materializeProjectIfNeeded(cwd, { trigger: 'onboarding-wait setup-complete (pre-spawn materialize)' });
      if (host === 'opencode') writeOpenCodeHostAssets(cwd, readEffectiveState(cwd), []);
    } catch {
      // best-effort; the PreToolUse gate's materialize-then-retry remains the backstop
    }
    if (host === 'opencode') {
      process.stdout.write(`${openCodeRestartWarning()}\n`);
      process.exit(2);
    }
    process.stdout.write('TRAFFIC_ONE_SETUP_COMPLETE\n');
    const triage = postSetupTriage(cwd);
    if (triage) {
      process.stdout.write(`\n[traffic-one] Route the original request per this triage BEFORE implementing:\n${triage}\n`);
    }
    // Front-load the gate-minted run-id so the orchestrator never fabricates an ISO id in spawn prompts.
    const runIdDirective = preSpawnRunIdDirective(cwd, host);
    if (runIdDirective) {
      process.stdout.write(`\n${runIdDirective}\n`);
      if (preSpawnRunIdBlocksSetup(runIdDirective)) process.exit(2);
    }
    const orchestrationDirective = preSpawnOrchestrationDirective(cwd, host);
    if (orchestrationDirective) {
      process.stdout.write(`\n${orchestrationDirective}\n`);
    }
    // Windsurf/Devin: front-load the architect-first + on-stack flow so the agent spawns senior-architect
    // via run_subagent instead of jumping to an off-stack scaffolder. Backed by the scaffolder gate.
    const architectDirective = preSpawnArchitectDirective(cwd, host);
    if (architectDirective) {
      process.stdout.write(`\n${architectDirective}\n`);
    }
    // Cursor: front-load model capture + eligibility + the per-role model map so the team spawns
    // ONCE (no capture/model-tier deny + retry). Claude: front-load the per-role
    // subagent_type+model spawn map from the frozen policy for the same reason
    // (observed 1cl/2cl: the first model-less spawn was denied and retried).
    // Backed by the PreToolUse gates if not followed.
    const modelDirective = preSpawnModelDirective(cwd);
    if (modelDirective) {
      process.stdout.write(`\n${modelDirective}\n`);
    }
    const openCodeDirective = preSpawnOpenCodeDirective(cwd);
    if (openCodeDirective) {
      process.stdout.write(`\n${openCodeDirective}\n`);
    }
    process.exit(0);
  }
  process.stdout.write('TRAFFIC_ONE_SETUP_PENDING\n');
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Never hang or crash loudly — report pending so the agent re-runs.
    process.stdout.write('TRAFFIC_ONE_SETUP_PENDING\n');
    process.exit(2);
  }
}
