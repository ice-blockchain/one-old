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

import { maintenanceTriageDirective } from '../../modules/session/triage-directive';
import { buildOrchestrationDirective } from '../../shared/build-orchestration-directive';
import { buildPreSpawnOpenCodeDirective } from '../../shared/opencode-plan-directive';
import { AGENT_ROLES } from '../../config/performance';
import { detectMode } from '../../shared/detection';
import { detectHost } from '../../shared/host';
import { detectHostPlan } from '../../shared/host-plan';
import { materializeProjectIfNeeded, writeOpenCodeHostAssets } from '../../shared/materialize';
import { buildCursorSpawnModelMap, isBareCursorTierFamily } from '../../shared/materialize/cursor-spawn-map';
import { freshCursorModels } from '../../shared/materialize/cursor-models';
import { modelCaptureCommand, modelGateCommand } from '../../shared/model-gate-command';
import { canonicalHost } from '../../shared/model-tiers';
import { currentAcceptableModels } from '../../shared/current-model-tiers';
import { obj } from '../../shared/obj';
import { emittedWithin, stampEmitMarker } from '../../shared/once';
import { clearPluginUseChoice, pluginUseDeclined, recordPluginUseChoice } from '../../shared/state/plugin-use';
import { seedOriginalPrompt } from '../../shared/onboarding/seed-prompt';
import { onboardingWaitCommand } from '../../shared/onboarding-server/wait-command';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import {
  isOnboardingPermissionError,
  onboardingBootstrapReason,
  onboardingStartFailureReason,
} from '../../shared/onboarding-server/bootstrap';
import { ensureOnboardingServer } from '../../shared/onboarding-server/ensure';
import { agentOnboardingUrl } from '../../config/dashboard';
import { readServerRecord } from '../../shared/onboarding-server/registry';
import { modelForRoleHost, teamModeForLevel } from '../../shared/performance';
import { ensureCurrentRunId, normalizeState, readEffectiveState } from '../../shared/state';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';

// 8 min keeps a single run safely under the host's ~10-min shell cap, so the agent
// gets a clean PENDING signal (rather than a hard kill) when the user is slow.
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2000;
// How recently another surface must have shown the wizard URL for the runner's
// banner to be considered a duplicate in the same turn/session.
const WIZARD_URL_TTL_MS = 15 * 60 * 1000;

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
      '2. Spawn the architect FIRST with `run_subagent` profile `subagent_general` (custom profiles materialized',
      '   during onboarding are not registered until a new Devin session). The task MUST start with',
      '   `[t1-role: senior-<role>]` (substitute the spawned role; architect here), then tell the child to read `.devin/agents/senior-architect/AGENT.md`.',
      '   It writes',
      '   `.traffic-one/plan.md` (PLAN_READY) + the `apps/web` monorepo scaffold. Development is BLOCKED until',
      '   `.traffic-one/plan.md` exists (the scaffolder + plan gates deny premature/off-stack commands).',
      '3. After PLAN_READY, spawn every role via `subagent_general`, with its `[t1-role: senior-…]` marker first',
      '   and an instruction to read the matching `.devin/agents/<role>/AGENT.md` contract,',
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
    const planCtx = { host, plan: detectHostPlan(host) };

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
      if (!tierFallback.has(fam)) tierFallback.set(fam, currentAcceptableModels(fam, host, planCtx.plan).slice(1)[0] || fam);
    }
    if (!rows.length) return '';
    const eligibility = Array.from(tierFallback.entries())
      .map(([fam, fb]) => `\`${fam}\`${fb && fb !== fam ? ` (fallback if unavailable: \`${fb}\`)` : ''}`)
      .join(', ');

    const gateCmd = modelGateCommand(cwd, host);
    const captureCmd = modelCaptureCommand(cwd, host);
    return [
      '[traffic-one] Cursor — resolve the subagent models BEFORE spawning the team (do this ONCE, in order; it avoids the spawn being denied and re-tried):',
      '1. Enumerate the exact model ids your `Task` tool offers for subagents, then run the internal capture command below with those ids in place of the placeholders. It writes only local per-user/project preferences; never create `.traffic-one/cursor-models.json`:',
      `   ${captureCmd}`,
      `2. Run this command (it checks whether your picked tier models — ${eligibility} — are actually offered):`,
      `   ${gateCmd}`,
      '   If a picked model is NOT offered, STOP — show the user the unavailable-model table in chat and wait for them to reply **fallback** or **enable** before spawning. The model-gate command and spawn gate both fail closed until that reply is recorded. Re-run after they enable a model.',
      '3. Spawn using the **spawn map** printed by step 2. Project `.cursor/agents` files are model-agnostic; pass each EXACT slug from the map in the Task `model` parameter (preview; step 2 is authoritative):',
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
export function announceWizardUrl(
  cwd: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
  host: string = detectHost(),
): void {
  try {
    const rec = readServerRecord(cwd, process.env, host);
    if (!rec || !rec.url || rec.url.includes(':0/')) return;
    // Show the dashboard setup link (matches the link surfaced in chat); fall back to
    // the local URL (which itself redirects to the dashboard) if no dashboard URL.
    const link = agentOnboardingUrl(process.env, rec.port, rec.token) || rec.url;
    // Another surface (session-start banner / prompt-submit recipe / gate deny)
    // already showed this exact link moments ago — repeating the full banner
    // renders the URL twice in the same turn (observed on Cursor). Keep a
    // compact wait line so the terminal output still explains the block.
    if (emittedWithin(cwd, 'wizard-url-shown', WIZARD_URL_TTL_MS)) {
      write('\nWaiting for Traffic One setup to complete (link shown above; this command keeps the turn open)…\n');
      return;
    }
    stampEmitMarker(cwd, 'wizard-url-shown');
    // A4: the dashboard deep link can 404 (external service) — always name the
    // local wizard as the fallback so setup never dead-ends on the public URL.
    const localFallback = link !== rec.url
      ? `  If that page fails to load (404), use the local wizard instead: ${rec.url}\n`
      : '';
    write(
      '\n════════════════════════════════════════════════════════════════\n'
      + '  TRAFFIC ONE SETUP — open this link in your browser to finish setup:\n\n'
      + `  ${link}\n\n`
      + localFallback
      + '  Enter your API key and complete the setup steps.\n'
      + `  Setup link: ${link}\n`
      + '  Waiting for setup to complete (this command keeps the turn open)…\n'
      + '════════════════════════════════════════════════════════════════\n',
    );
  } catch {
    // best-effort — the wait still works without the banner
  }
}

// Cursor's Browser editor is not a script-opened browser window, so page JavaScript
// cannot close its tab. Cursor exposes that operation to the current agent via
// browser_tabs — but only when the Browser feature is active, and only when setup
// actually ran in the in-app Browser (the dashboard flow opens an EXTERNAL browser
// that browser_tabs cannot see). Emit a tolerant sequence at SETUP_COMPLETE so
// cleanup is automatic when possible and silently skipped when it is not (A5:
// the hard 5-step directive sent agents hunting for a tool that did not exist).
export function cursorSetupCloseDirective(wizardUrl: string, host: string = detectHost()): string {
  if (host !== 'cursor') return '';
  const primary = wizardUrl && !wizardUrl.includes(':0/')
    ? `the tab whose URL is exactly \`${wizardUrl}\``
    : 'the tab titled "Traffic One — Setup" on 127.0.0.1';
  return [
    '[traffic-one] Cursor — if the setup tab is open in Cursor\'s in-app Browser, close it before the next build command:',
    `1. If a \`browser_tabs\` tool is available in this session, call it with \`{"action":"list"}\`, find ${primary} (fall back to the tab titled "Traffic One — Setup" on 127.0.0.1), close it with \`{"action":"close","index":<matching index>}\`, and re-list once to verify.`,
    '2. If no `browser_tabs` tool exists, or no matching tab is listed (setup ran in the external browser), skip this cleanup silently — do not hunt for other tools and do not ask the user to close anything.',
    '3. Continue the original request immediately.',
  ].join('\n');
}

// Bounded grace: `computeOnboarding().done` flips on the LAST /answer, which is
// seconds BEFORE the wizard tab finishes (`/verify-toolchain` → `/complete` →
// done view). `/complete` shuts the server down and clears its record, so a
// short poll on the record lets the tab settle on its final URL/title before
// the agent is told to close it — the exact-URL `browser_tabs` match then
// succeeds. Capped so a tab that never posts /complete (closed early, network
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

// The --decline output: records the durable opt-out and, when a wizard tab is
// already open (a live server record exists — the flag-off flow where the link
// was shown before the user said no), also tells the Cursor agent to close it.
// The URL is read BEFORE recording so the exact-URL tab match still works.
export function declineOutput(cwd: string, host: string): string {
  let openWizardUrl = '';
  try {
    const rec = readServerRecord(cwd, process.env, host);
    if (rec?.url && !rec.url.includes(':0/')) openWizardUrl = rec.url;
  } catch {
    // best-effort — the decline itself never depends on the record
  }
  recordPluginUseChoice(cwd, false, 'command');
  let out = 'TRAFFIC_ONE_DISABLED\n'
    + "Traffic One is disabled for this project — continue the user's request without Traffic One conventions. "
    + 'It stays silent here until the user explicitly asks for Traffic One again.\n';
  if (openWizardUrl) {
    const close = cursorSetupCloseDirective(openWizardUrl, host);
    if (close) out += `\n${close}\n`;
  }
  return out;
}

// The `--use` yes path: record the durable per-project opt-in, then seed the
// request that triggered the ask-first question (`--seed-prompt=…`). In that
// flow NOTHING was written before this recorded yes — this is the FIRST write
// that may create the project's .traffic-one folder, exactly at decision time.
// The seed feeds the wizard's stack derivation and the post-setup triage.
export function applyUseChoice(cwd: string, argv: readonly string[]): void {
  recordPluginUseChoice(cwd, true, 'command');
  const seedArg = argv.find((a) => a.startsWith('--seed-prompt='));
  if (seedArg) seedOriginalPrompt(cwd, seedArg.slice('--seed-prompt='.length));
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
  if (argv.includes('--reconsider')) {
    clearPluginUseChoice(cwd);
    process.stdout.write(
      'TRAFFIC_ONE_RECONSIDER\n'
      + `Traffic One can be set up for this project again. Run the setup wait command now:\n${onboardingWaitCommand(cwd, host)}\n`,
    );
    process.exit(0);
  }
  // "Yes, use Traffic One here" — record the answer, then continue straight into
  // the normal wait behavior below (start wizard, print the link, block). With
  // `--bootstrap-only` it instead exits right after printing the link (the
  // ask-first recipe's fast first half, so the agent can show the link before
  // running the blocking waiter).
  if (argv.includes('--use')) applyUseChoice(cwd, argv);
  // Self-heal a dead wizard link: the server the gate minted can die between then
  // and this wait (host restart, crash), leaving the agent's shown link broken and
  // the poll never completing. Re-ensure it here (idempotent — respawns only a
  // dead/stale record) so announceWizardUrl below always prints a LIVE url. Skipped
  // once setup is done, and best-effort (respects TRAFFIC_ONE_ONBOARDING_NO_SPAWN).
  const alreadyDone = onboardingDone(cwd);
  let launchError: unknown;
  let ensuredUrl = '';
  try {
    if (!alreadyDone) {
      const server = ensureOnboardingServer(cwd, { host });
      if (server.url && !server.url.includes(':0/')) ensuredUrl = server.url;
    }
  } catch (error) {
    launchError = error;
  }

  if (argv.includes('--bootstrap-only')) {
    if (alreadyDone) {
      process.stdout.write('TRAFFIC_ONE_SETUP_COMPLETE\n');
      process.exit(0);
    }
    if (launchError || !ensuredUrl) {
      const failure = launchError || Object.assign(new Error('wizard did not publish a live URL'), { code: 'START_FAILED' });
      // This command already ran through the host's approved shell boundary.
      // Re-prescribing itself would loop forever for packaging bugs, malformed
      // state roots, child crashes, or even a permission denial that approval did
      // not resolve. Emit one terminal diagnostic instead.
      process.stdout.write(`TRAFFIC_ONE_SETUP_BOOTSTRAP_FAILED\n\n${onboardingStartFailureReason(failure, host)}\n`);
      process.exit(2);
    }
    process.stdout.write(`TRAFFIC_ONE_SETUP_READY\nSetup link: ${ensuredUrl}\n`);
    process.exit(0);
  }
  // Windsurf opens the wizard before the prompt and runs this waiter inside the
  // first mutating hook. Suppress the terminal-style URL banner there: it is not
  // clickable in Devin's tool card and the browser is already open.
  let wizardUrl = '';
  try {
    const record = readServerRecord(cwd, process.env, host);
    if (record?.url && !record.url.includes(':0/')) wizardUrl = record.url;
  } catch {
    // best-effort — the close directive can still match the setup title + host
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
  if (!argv.includes('--quiet-url')) announceWizardUrl(cwd, (s) => process.stdout.write(s), host);
  const outcome = waitForOnboarding(cwd, {
    timeoutMs: positiveIntFlag(argv, '--timeout-ms') ?? undefined,
    intervalMs: positiveIntFlag(argv, '--interval-ms') ?? undefined,
  });
  if (outcome === 'complete') {
    // Let the wizard tab finish its /complete handshake (bounded) so the close
    // directive below targets a settled tab and the user sees the done view.
    if (host === 'cursor' && !alreadyDone) awaitWizardCompletionAck(cwd, host);
    // The user declined Traffic One through the pre-onboarding plugin-use choice:
    // unblock the build with NO materialization, triage, or orchestration
    // directives — the project
    // keeps no .traffic-one folder and the hooks stand down from here on. The
    // Cursor tab-close directive still applies (the wizard tab is open).
    if (pluginUseDeclined(cwd)) {
      process.stdout.write(
        'TRAFFIC_ONE_DISABLED\n'
        + "Traffic One is disabled for this project — continue the user's request without Traffic One conventions.\n",
      );
      const declinedClose = cursorSetupCloseDirective(wizardUrl, host);
      if (declinedClose) process.stdout.write(`\n${declinedClose}\n`);
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
    const closeDirective = cursorSetupCloseDirective(wizardUrl, host);
    if (closeDirective) {
      process.stdout.write(`\n${closeDirective}\n`);
    }
    const triage = postSetupTriage(cwd);
    if (triage) {
      process.stdout.write(`\n[traffic-one] Route the original request per this triage BEFORE implementing:\n${triage}\n`);
    }
    // Front-load the gate-minted run-id so the orchestrator never fabricates an ISO id in spawn prompts.
    const runIdDirective = preSpawnRunIdDirective(cwd);
    if (runIdDirective) {
      process.stdout.write(`\n${runIdDirective}\n`);
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
