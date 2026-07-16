// src/shared/onboarding-server/bootstrap.ts
// Fail-closed wrapper around the local wizard launcher. Some hosts execute hooks
// inside a workspace-only sandbox, while Traffic One deliberately keeps private
// preferences under ~/.traffic-one/projects. In that case the hook cannot create
// the wizard registry itself; return an actionable bootstrap command instead of
// throwing into a host entry that may discard the error.

import type { HostId } from '../../core/types';
import { makeSkillBlock } from '../skill-block';
import { pluginRoot } from '../paths';
import { ensureOnboardingServer, type EnsureResult } from './ensure';
import { onboardingBootstrapCommand, onboardingWaitCommand, onboardingWaitScriptPath } from './wait-command';

const skillBlock = makeSkillBlock(pluginRoot);

type EnsureFn = (cwd: string, options: { host: string }) => EnsureResult;

export interface OnboardingBootstrapReady {
  kind: 'ready';
  server: EnsureResult;
  waitCommand: string;
}

export interface OnboardingBootstrapRequired {
  kind: 'bootstrap-required';
  reason: string;
  bootstrapCommand: string;
  waitCommand: string;
  errorCode: string;
}

export interface OnboardingStartFailed {
  kind: 'start-failed';
  reason: string;
  errorCode: string;
}

export type OnboardingBootstrap = OnboardingBootstrapReady | OnboardingBootstrapRequired | OnboardingStartFailed;

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

// Terminal diagnostic for packaging/runtime failures. Approval cannot repair a
// missing runner, crashed child, malformed state root, or readiness timeout; do
// not prescribe the same bootstrap again and trap the agent in a retry loop.
export function onboardingStartFailureReason(error: unknown, host?: HostId): string {
  const code = errorCode(error);
  const detail = errorMessage(error);
  if (host === 'opencode' || host === 'kilo' || host === 'windsurf') {
    return `Traffic One setup launcher failed (${code}: ${detail}). Setup is paused because this is a plugin/runtime failure rather than a sandbox permission request. Stop and report this error. Run Traffic One doctor or reinstall/update the Traffic One plugin, then retry setup.`;
  }
  return `Traffic One setup launcher failed (${code}: ${detail}). This is a plugin/runtime failure, not a sandbox approval request. Do NOT rerun \`--bootstrap-only\` and do not create private state inside the project. Stop and report this error, then run Traffic One doctor or reinstall/update the Traffic One plugin before retrying.`;
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
    + 'The bootstrap prints `TRAFFIC_ONE_SETUP_READY` and a live `Setup link:`, then exits. Show that URL to the user as a standalone clickable link (or open it in the host\'s in-app web view). Immediately afterward run this normal waiter and keep the turn active:\n\n'
    + `${waitCommand}\n\n`
    + 'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, close the setup view and immediately continue the original request. If it prints `TRAFFIC_ONE_SETUP_PENDING`, run the exact same waiter again. Building, installs, and subagent work remain blocked until completion.';
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
  options: { ensure?: EnsureFn } = {},
): OnboardingBootstrap {
  const bootstrapCommand = onboardingBootstrapCommand(cwd, host);
  const waitCommand = onboardingWaitCommand(cwd, host);
  try {
    const server = (options.ensure || ensureOnboardingServer)(cwd, { host });
    return { kind: 'ready', server, waitCommand };
  } catch (error) {
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
