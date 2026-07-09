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
// stdout TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED, exit 2 → setup finished, but OpenCode
//   must be restarted before development continues.
// stdout TRAFFIC_ONE_SETUP_PENDING,  exit 2 → still pending after the timeout; re-run.

import { execFileSync } from 'child_process';

import { maintenanceTriageDirective } from '../../modules/session/triage-directive';
import { buildPreSpawnOpenCodeDirective } from '../../shared/opencode-plan-directive';
import { AGENT_ROLES } from '../../config/performance';
import { detectMode } from '../../shared/detection';
import { detectHost } from '../../shared/host';
import { detectHostPlan } from '../../shared/host-plan';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { buildCursorSpawnModelMap, isBareCursorTierFamily } from '../../shared/materialize/cursor-spawn-map';
import { freshCursorModels } from '../../shared/materialize/cursor-models';
import { modelGateCommand } from '../../shared/model-gate-command';
import { acceptableModelsFor, canonicalHost } from '../../shared/model-tiers';
import { obj } from '../../shared/obj';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { ensureOnboardingServer } from '../../shared/onboarding-server/ensure';
import { readServerRecord } from '../../shared/onboarding-server/registry';
import { modelForRoleHost, openCodeDelegationActive, teamModeForLevel } from '../../shared/performance';
import { ensureCurrentRunId, normalizeState, readEffectiveState } from '../../shared/state';
import { applyTrafficOneEnv } from '../../shared/state/traffic-one-paths';

// 8 min keeps a single run safely under the host's ~10-min shell cap, so the agent
// gets a clean PENDING signal (rather than a hard kill) when the user is slow.
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2000;

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
export function preSpawnRunIdDirective(cwd: string): string {
  try {
    const state = readEffectiveState(cwd) as Record<string, unknown>;
    if (!state || state.mode !== 'new-project') return '';
    const runId = ensureCurrentRunId(cwd, state);
    if (!runId) return '';
    return [
      '[traffic-one] Build run-id — use EXACTLY this value in every spawn prompt (never `date`, ISO, or UTC):',
      `- currentRunId in .traffic-one/.one.json: \`${runId}\``,
      `- Assignments: \`.traffic-one/runs/${runId}/assignments.json\``,
      `- Digests: \`.traffic-one/digests/${runId}/<role>.md\``,
      `- Spawn prompt line: \`Run ID: ${runId}\``,
      'Wrong run-id in a spawn prompt is denied; copy the paths above verbatim.',
    ].join('\n');
  } catch {
    return '';
  }
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
    const stack = typeof state.stack === 'string' ? state.stack : 'default';
    const frontend = typeof state.frontend === 'string' ? state.frontend : 'react-vite';
    return [
      '[traffic-one] Windsurf build flow — do this FIRST, before writing or scaffolding anything:',
      `1. This project's stack is \`${stack}\` (frontend \`${frontend}\`). Build ONLY on that stack — do NOT run`,
      '   `create-next-app` / `create-react-app`; the React/Vite app lives under `apps/web` (Vite), per the plan.',
      '2. Spawn the architect FIRST with the `run_subagent` tool (profile `senior-architect`). It writes',
      '   `.traffic-one/plan.md` (PLAN_READY) + the `apps/web` monorepo scaffold. Development is BLOCKED until',
      '   `.traffic-one/plan.md` exists (the scaffolder + plan gates deny premature/off-stack commands).',
      '3. After PLAN_READY, spawn the implementer roles (`senior-frontend`, `senior-backend`, …) via `run_subagent`,',
      '   then `senior-reviewer` + `senior-tester`. Build ON the plan the architect produced.',
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
export function preSpawnModelDirective(cwd: string, host: string = detectHost()): string {
  if (host !== 'cursor') return '';
  try {
    const state = readEffectiveState(cwd) as Record<string, unknown>;
    if (!state || state.mode !== 'new-project') return '';
    const performance = obj(state.performance);
    const level = performance && typeof performance.level === 'string' ? performance.level : '';
    if (!level || teamModeForLevel(level) !== 'subagents') return '';
    const team = obj(state.team);
    const overrides = team && obj(team.overrides) ? (team.overrides as Record<string, unknown>) : null;
    const planCtx = { host, plan: detectHostPlan(host), useOpenCode: openCodeDelegationActive(state, host) };

    const plan = detectHostPlan(host);
    const captured = freshCursorModels(cwd, plan);
    const spawnMap = captured.length ? buildCursorSpawnModelMap(cwd, state) : {};

    const rows: string[] = [];
    const tierFallback = new Map<string, string>(); // tier family → next-eligible fallback family
    for (const role of AGENT_ROLES) {
      const fam = modelForRoleHost(level, role, host, overrides, planCtx);
      if (!fam) continue;
      const slug = spawnMap[role] || fam;
      const spawnValue = captured.length && !isBareCursorTierFamily(slug, fam)
        ? slug
        : `(after step 2 — exact slug for tier \`${fam}\`; never pass the bare family)`;
      rows.push(`   - ${role} → ${spawnValue}`);
      if (!tierFallback.has(fam)) tierFallback.set(fam, acceptableModelsFor(fam, host).slice(1)[0] || fam);
    }
    if (!rows.length) return '';
    const eligibility = Array.from(tierFallback.entries())
      .map(([fam, fb]) => `\`${fam}\`${fb && fb !== fam ? ` (fallback if unavailable: \`${fb}\`)` : ''}`)
      .join(', ');

    const gateCmd = modelGateCommand(cwd, host);
    return [
      '[traffic-one] Cursor — resolve the subagent models BEFORE spawning the team (do this ONCE, in order; it avoids the spawn being denied and re-tried):',
      '1. Enumerate the model ids your `Task` tool offers for subagents and write them to `.traffic-one/cursor-models.json` as {"models":[...]} (EXACT ids, with their reasoning suffixes). Traffic One re-materializes the real per-role slug for each tier from this list.',
      `2. Run this command (it checks whether your picked tier models — ${eligibility} — are actually offered):`,
      `   ${gateCmd}`,
      '   If a picked model is NOT offered, STOP — show the user the unavailable-model table in chat and wait for them to reply **fallback** or **enable** before spawning. The model-gate command and spawn gate both fail closed until that reply is recorded. Re-run after they enable a model.',
      '3. Spawn using the **spawn map** printed by step 2 (or read each `.cursor/agents/<role>.md` `model:` refreshed by step 2). Pass each EXACT slug in the Task `model` parameter — per-role models (preview; step 2 is authoritative once capture exists):',
      ...rows,
      '   Never pass bare tier family aliases (e.g. `claude-opus-4-8` without a reasoning suffix) — Cursor rejects them and the spawn gate denies the first attempt.',
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
export function announceWizardUrl(cwd: string, write: (s: string) => void = (s) => process.stdout.write(s)): void {
  try {
    const rec = readServerRecord(cwd);
    if (!rec || !rec.url || rec.url.includes(':0/')) return;
    write(
      '\n════════════════════════════════════════════════════════════════\n'
      + '  TRAFFIC ONE SETUP WIZARD — open this link to finish setup:\n\n'
      + `  ${rec.url}\n\n`
      + '  Cursor: click the link, or Cmd+Shift+P → "Simple Browser: Show" → paste it.\n'
      + `  Setup link: ${rec.url}\n`
      + '  Waiting for setup to complete (this command keeps the turn open)…\n'
      + '════════════════════════════════════════════════════════════════\n',
    );
  } catch {
    // best-effort — the wait still works without the banner
  }
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const cwd = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const host = detectHost(process.env, argv);
  applyTrafficOneEnv(cwd, host);
  // Self-heal a dead wizard link: the server the gate minted can die between then
  // and this wait (host restart, crash), leaving the agent's shown link broken and
  // the poll never completing. Re-ensure it here (idempotent — respawns only a
  // dead/stale record) so announceWizardUrl below always prints a LIVE url. Skipped
  // once setup is done, and best-effort (respects TRAFFIC_ONE_ONBOARDING_NO_SPAWN).
  try {
    if (!onboardingDone(cwd)) ensureOnboardingServer(cwd, { host });
  } catch {
    // best-effort — the wait still polls without a respawn
  }
  announceWizardUrl(cwd);
  const outcome = waitForOnboarding(cwd, {
    timeoutMs: positiveIntFlag(argv, '--timeout-ms') ?? undefined,
    intervalMs: positiveIntFlag(argv, '--interval-ms') ?? undefined,
  });
  if (outcome === 'complete') {
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
    const runIdDirective = preSpawnRunIdDirective(cwd);
    if (runIdDirective) {
      process.stdout.write(`\n${runIdDirective}\n`);
    }
    // Windsurf/Devin: front-load the architect-first + on-stack flow so the agent spawns senior-architect
    // via run_subagent instead of jumping to an off-stack scaffolder. Backed by the scaffolder gate.
    const architectDirective = preSpawnArchitectDirective(cwd, host);
    if (architectDirective) {
      process.stdout.write(`\n${architectDirective}\n`);
    }
    // Cursor: front-load model capture + eligibility + the per-role model map so the team spawns
    // ONCE (no capture/model-tier deny + retry). Backed by the PreToolUse gates if not followed.
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
