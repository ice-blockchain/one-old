// src/runners/onboarding-wait/consent.ts
// Session sync, consent-phase failure output, pre-onboarding one-mcp sync,
// reconsider handling, and the begin-onboarding attempt.

import { detectHost } from '../../shared/host';
import { pluginUseDeclined, recordPluginUseChoice } from '../../shared/state/plugin-use';
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
import {
  syncOneMcpForSession,
  syncOneMcpOnce,
  type SessionOneMcpSync,
} from '../../modules/session/one-mcp-sync';

import {
  onboardingDone,
} from './wait-loop';
import {
  applyUseChoice,
} from './wizard-output';

export function syncSessionFromArgv(argv: readonly string[]): string {
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

function syncOneMcpBeforeOnboarding(
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
