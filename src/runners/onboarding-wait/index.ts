// src/runners/onboarding-wait/index.ts
// Onboarding-wait CLI entry: main(argv) drives the flag dispatch, server
// self-heal, wait, and terminal banner emission. The stdout token protocol
// documented in the sibling headers is the contract with the agent.

import { detectHost } from '../../shared/host';
import { materializeProjectIfNeeded, writeOpenCodeHostAssets } from '../../shared/materialize';
import { pluginUseDeclined, recordPluginUseChoice } from '../../shared/state/plugin-use';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import {
  isOnboardingPermissionError,
  onboardingBootstrapReason,
  onboardingStartFailureReason,
} from '../../shared/onboarding-server/bootstrap';
import { ensureOnboardingServer } from '../../shared/onboarding-server/ensure';
import { readServerRecord } from '../../shared/onboarding-server/registry';
import { awaitDashboardHealth } from '../../shared/onboarding-server/dashboard-health';
import { ensureOnboardingWaitPermission } from '../../shared/onboarding-server/wait-permission';
import { ensureCurrentRunId, normalizeState, readEffectiveState } from '../../shared/state';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';

import {
  positiveIntFlag,
  postSetupTriage,
  waitForOnboarding,
} from './wait-loop';
import {
  openCodeRestartWarning,
  preSpawnArchitectDirective,
  preSpawnOpenCodeDirective,
  preSpawnOrchestrationDirective,
  preSpawnRunIdBlocksSetup,
  preSpawnRunIdDirective,
} from './pre-spawn-directives';
import {
  preSpawnModelDirective,
} from './pre-spawn-model';
import {
  announceWizardUrl,
  awaitWizardCompletionAck,
  bootstrapReadyOutput,
  declineOutput,
} from './wizard-output';
import {
  beginOnboardingAttempt,
  consentPhaseFailureOutput,
  syncSessionFromArgv,
} from './consent';

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

export { postSetupTriage, waitForOnboarding, type WaitOptions, type WaitOutcome } from './wait-loop';
export {
  openCodeRestartWarning,
  preSpawnArchitectDirective,
  preSpawnOpenCodeDirective,
  preSpawnOrchestrationDirective,
  preSpawnRunIdBlocksSetup,
  preSpawnRunIdDirective,
} from './pre-spawn-directives';
export { preSpawnModelDirective } from './pre-spawn-model';
export {
  announceWizardUrl,
  applyUseChoice,
  awaitWizardCompletionAck,
  bootstrapReadyOutput,
  declineOutput,
} from './wizard-output';
export {
  applyReconsiderChoice,
  beginOnboardingAttempt,
  consentPhaseFailureOutput,
} from './consent';
