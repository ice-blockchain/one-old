// src/shared/onboarding-server/bootstrap.ts
// Fail-closed wrapper around the local wizard launcher. Some hosts execute hooks
// inside a workspace-only sandbox, while Traffic One deliberately keeps private
// preferences under ~/.traffic-one/projects. In that case the hook cannot create
// the wizard registry itself; return an actionable bootstrap command instead of
// throwing into a host entry that may discard the error.

import type { HostId } from '../../core/types';
import { makeSkillBlock } from '../skill-block';
import { pluginRoot } from '../paths';
import { ensureOnboardingServer, ONBOARDING_START_TIMEOUT_CODE, type EnsureResult } from './ensure';
import { onboardingBootstrapCommand, onboardingWaitCommand, onboardingWaitScriptPath } from './wait-command';
import { doctorCommand } from '../doctor-command';

const skillBlock = makeSkillBlock(pluginRoot);

type EnsureFn = (cwd: string, options: { host: string }) => EnsureResult;

interface OnboardingBootstrapReady {
  kind: 'ready';
  server: EnsureResult;
  waitCommand: string;
}

interface OnboardingBootstrapRequired {
  kind: 'bootstrap-required';
  reason: string;
  bootstrapCommand: string;
  waitCommand: string;
  errorCode: string;
}

interface OnboardingStartFailed {
  kind: 'start-failed';
  reason: string;
  errorCode: string;
}

// The launcher ran out of TIME, which is a different fact from a broken
// installation and carries a different remedy. `reason` is the retryable prose;
// `terminalReason` is what the SAME timeout must say once its one retry is
// spent. Both are carried because the classification stays PURE — the bound is
// claimed by the surface that actually BLOCKS (the PreToolUse gate), not by
// every surface that merely observes a timeout. A prompt-hook observation
// burning the budget would have handed the gate the terminal text on the very
// first tool call, which is the failure this whole split exists to remove.
interface OnboardingStartTimeout {
  kind: 'start-timeout';
  reason: string;
  terminalReason: string;
  errorCode: string;
}

type OnboardingBootstrap =
  | OnboardingBootstrapReady
  | OnboardingBootstrapRequired
  | OnboardingStartFailed
  | OnboardingStartTimeout;

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string') {
    return String((error as NodeJS.ErrnoException).code);
  }
  return 'START_FAILED';
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'unknown launcher error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown launcher error';
}

const ONBOARDING_PERMISSION_ERRORS = new Set(['EPERM', 'EACCES', 'EROFS']);

export function isOnboardingPermissionError(error: unknown): boolean {
  return ONBOARDING_PERMISSION_ERRORS.has(errorCode(error));
}

export function isOnboardingTimeoutError(error: unknown): boolean {
  return errorCode(error) === ONBOARDING_START_TIMEOUT_CODE;
}

// Terminal diagnostic for packaging/runtime failures. Approval cannot repair a
// missing runner, a crashed child or a malformed state root; do not prescribe
// the same bootstrap again and trap the agent in a retry loop.
//
// A readiness TIMEOUT used to be lumped in here, and it does not belong: it is
// the one member of the set that is routinely transient (ensure.ts documents
// concurrent hooks both racing to launch as NORMAL), so this text told a user
// hitting ordinary contention that their plugin was broken and to reinstall it,
// and then denied every tool. It has its own pair of messages below. The fear
// this comment was written with is still right, which is why the retryable one
// is bounded by the runtime rather than by its own prose.
export function onboardingStartFailureReason(error: unknown, host?: HostId): string {
  const code = errorCode(error);
  const detail = errorMessage(error);
  const doctor = doctorCommand();
  if (host === 'opencode' || host === 'kilo' || host === 'windsurf') {
    return `Traffic One setup launcher failed (${code}: ${detail}). Setup is paused because this is a plugin/runtime failure rather than a sandbox permission request. Stop and report this error. Run the read-only Traffic One doctor: ${doctor}. Reinstall/update the Traffic One plugin if needed, then retry setup.`;
  }
  return `Traffic One setup launcher failed (${code}: ${detail}). This is a plugin/runtime failure, not a sandbox approval request. Do NOT rerun \`--bootstrap-only\` and do not create private state inside the project. Stop and report this error, then run the read-only Traffic One doctor: ${doctor}. Reinstall/update the Traffic One plugin if needed before retrying.`;
}

// The RETRYABLE half. Prescribes exactly ONE retry and says what the next
// message will be, so the agent is not choosing between "retry forever" and
// "give up" — the runtime has already decided, and this text tells it which
// answer it is holding. Deliberately says reinstalling will NOT help: that is
// the instruction this case used to receive, and it is wrong.
export function onboardingStartTimeoutReason(error: unknown, host?: HostId): string {
  const code = errorCode(error);
  const detail = errorMessage(error);
  if (host === 'opencode' || host === 'kilo' || host === 'windsurf') {
    return `Traffic One setup did not finish starting in time (${code}: ${detail}). This is normally transient — another Traffic One hook process was starting the same setup server. Retry this exact tool call once, unchanged. If the same timeout is reported again, stop and report it; reinstalling the plugin will not help.`;
  }
  return `Traffic One setup did not finish starting in time (${code}: ${detail}). This is a TIMEOUT, not a plugin/runtime failure: each Traffic One hook runs in its own process, so a concurrent hook can already be starting the same setup server, and a cold start can overrun the window. Retry this exact tool call ONCE, unchanged — the retry normally reuses the server the other process just finished starting. Do NOT rerun \`--bootstrap-only\`, do not reinstall the plugin, and do not create private state inside the project. If the same timeout is reported again it is no longer contention, and the next message will tell you to stop.`;
}

// The TERMINAL half, once that one retry is spent. A separate message rather
// than the packaging one above because the diagnosis differs: nothing here says
// the installation is broken, and sending an operator to reinstall over a
// persistently slow or blocked launcher wastes the only lead they have.
export function onboardingStartTimeoutExhaustedReason(error: unknown, host?: HostId): string {
  const code = errorCode(error);
  const detail = errorMessage(error);
  const doctor = doctorCommand();
  if (host === 'opencode' || host === 'kilo' || host === 'windsurf') {
    return `Traffic One setup timed out again (${code}: ${detail}) after a retry, so this is not contention. Stop retrying and report it. Run the read-only Traffic One doctor: ${doctor}.`;
  }
  return `Traffic One setup timed out again (${code}: ${detail}). A retry was already spent, so this is no longer a concurrent hook — the setup server is not reaching a listening state on this machine. Stop retrying: another attempt will produce this same message. Do NOT rerun \`--bootstrap-only\` and do not create private state inside the project. Report this to the user, then run the read-only Traffic One doctor: ${doctor}.`;
}

function permissionStep(host: HostId): string {
  if (host === 'codex') {
    return `Codex: call \`exec_command\` with \`sandbox_permissions: "require_escalated"\`, use this project as \`workdir\`, and explain that Traffic One must write private onboarding state under \`~/.traffic-one/projects\`. Use the narrow persistent prefix \`["node",${JSON.stringify(onboardingWaitScriptPath())},"--bootstrap-only"]\`.`;
  }
  if (host === 'claude') {
    return 'Claude Code: run it with Bash and approve access to the user-local `~/.traffic-one/projects` state when prompted.';
  }
  if (host === 'cursor') {
    return 'Cursor: run it through the terminal tool with the permission needed to write user-local Traffic One state; do not launch an unrelated external browser.';
  }
  if (host === 'windsurf') {
    return 'Windsurf/Devin: run it through the command tool with user-local state access and keep the command active while setup is open.';
  }
  if (host === 'opencode') {
    return 'OpenCode: run it through the shell tool with approval for the user-local Traffic One state directory, then keep the waiter active until it reports completion.';
  }
  if (host === 'kilo') {
    return 'Kilo: run it through the shell tool with approval for the user-local Traffic One state directory, then keep the waiter active until it reports completion.';
  }
  return 'GitHub Copilot: run it through the shell tool with approval for the user-local Traffic One state directory, then keep the waiter active until it reports completion.';
}

function bootstrapFallback(bootstrapCommand: string, waitCommand: string, hostStep: string, code: string): string {
  return `Traffic One setup could not start inside this host's restricted hook sandbox (${code}). `
    + 'Private preferences MUST remain in `~/.traffic-one/projects`; do not create `preferences.json`, `machine.json`, or onboarding runtime files inside the project.\n\n'
    + 'Do not search for a wizard tool, claim the preview is already open, or end the turn. Your NEXT action is to run this exact bootstrap command with the required approval:\n\n'
    + `${bootstrapCommand}\n\n`
    + `${hostStep}\n\n`
    + 'The bootstrap prints `TRAFFIC_ONE_SETUP_READY` and a live `Setup link:`, then exits. Post that URL to the user as a standalone clickable link in a chat message — do not open it yourself with a browser tool. Immediately afterward run this normal waiter and keep the turn active:\n\n'
    + `${waitCommand}\n\n`
    + 'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, immediately continue the original request. If it prints `TRAFFIC_ONE_SETUP_PENDING`, run the exact same waiter again. If it prints `TRAFFIC_ONE_TECH_CLASSIFY_REQUIRED`, follow its printed classification instructions (inspect the repo, run the printed `--set-tech` command), then re-run. Building, installs, and subagent work remain blocked until completion.';
}

function compactBootstrapFallback(bootstrapCommand: string, waitCommand: string, code: string): string {
  return `Traffic One setup needs approved access to its user-local state at \`~/.traffic-one/projects\` (${code}).\n\n`
    + `Run with approval: ${bootstrapCommand}\n\n`
    + 'It prints the live setup link and exits. Show that link, then keep setup active with:\n'
    + `${waitCommand}\n\n`
    + 'Building remains blocked until the waiter reports completion.';
}

export function onboardingBootstrapReason(
  cwd: string,
  host: HostId,
  error: unknown,
  bootstrapCommand = onboardingBootstrapCommand(cwd, host),
  waitCommand = onboardingWaitCommand(cwd, host),
): string {
  const code = errorCode(error);
  if (host === 'opencode' || host === 'kilo' || host === 'windsurf') {
    return skillBlock('onboarding-gate', 'server-bootstrap-required-compact', {
      BOOTSTRAP_CMD: bootstrapCommand,
      ERROR_CODE: code,
      WAIT_CMD: waitCommand,
    }, compactBootstrapFallback(bootstrapCommand, waitCommand, code));
  }
  const hostStep = permissionStep(host);
  return skillBlock('onboarding-gate', 'server-bootstrap-required', {
    BOOTSTRAP_CMD: bootstrapCommand,
    ERROR_CODE: code,
    HOST_PERMISSION_STEP: hostStep,
    WAIT_CMD: waitCommand,
  }, bootstrapFallback(bootstrapCommand, waitCommand, hostStep, code));
}

export function prepareOnboardingServer(
  cwd: string,
  host: HostId,
  options: { ensure?: EnsureFn; syncSession?: string } = {},
): OnboardingBootstrap {
  const bootstrapCommand = onboardingBootstrapCommand(cwd, host, options.syncSession);
  const waitCommand = onboardingWaitCommand(cwd, host, options.syncSession);
  try {
    const server = (options.ensure || ensureOnboardingServer)(cwd, { host });
    return { kind: 'ready', server, waitCommand };
  } catch (error) {
    if (isOnboardingTimeoutError(error)) {
      return {
        kind: 'start-timeout',
        reason: onboardingStartTimeoutReason(error, host),
        terminalReason: onboardingStartTimeoutExhaustedReason(error, host),
        errorCode: errorCode(error),
      };
    }
    if (!isOnboardingPermissionError(error)) {
      return {
        kind: 'start-failed',
        reason: onboardingStartFailureReason(error, host),
        errorCode: errorCode(error),
      };
    }
    return {
      kind: 'bootstrap-required',
      reason: onboardingBootstrapReason(cwd, host, error, bootstrapCommand, waitCommand),
      bootstrapCommand,
      waitCommand,
      errorCode: errorCode(error),
    };
  }
}
