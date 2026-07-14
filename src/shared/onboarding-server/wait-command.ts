// src/shared/onboarding-server/wait-command.ts
// The shell command the agent runs right after opening the setup wizard to BLOCK
// until onboarding completes, then continue the build with no extra user message.
// Both the PreToolUse gate and the UserPromptSubmit handler surface it (filled into
// the server-deny-reason prose). The path is absolute so it runs from any cwd, and
// every argument is inertly shell-quoted so spaces and project-name punctuation
// remain a single value that the gate's deliberately small parser can validate.

import * as path from 'path';

import type { HostId } from '../../core/types';
import { trafficOneEnvShellPrefix } from '../state/traffic-one-paths';
import { pluginRoot } from '../paths';

export function onboardingWaitScriptPath(): string {
  return path.join(pluginRoot(), 'scripts', 'onboarding-wait.cjs');
}

// POSIX/PowerShell-compatible literal quoting. JSON double quotes are not shell
// quoting: `$`, backticks, and command substitution still expand inside them.
// Single-quote every generated argument so project names such as `app ($draft)`
// remain one inert argv value. The classifier understands the standard '\''
// splice used for a literal apostrophe.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function onboardingRunnerCommand(cwd: string, host: HostId | undefined, flags: readonly string[]): string {
  const flagArgs = flags.map((flag) => ` ${shellQuote(flag)}`).join('');
  const hostArg = host ? ` ${shellQuote(`--host=${host}`)}` : '';
  const envPrefix = trafficOneEnvShellPrefix(cwd, host);
  return `${envPrefix}node ${shellQuote(onboardingWaitScriptPath())}${flagArgs} ${shellQuote(cwd)}${hostArg}`;
}

// Starts the wizard under an approval-capable shell process, prints its live URL,
// and exits immediately. `--bootstrap-only` deliberately precedes the project
// path so Codex can persist a narrow prefix approval that works for future projects.
export function onboardingBootstrapCommand(cwd: string, host?: HostId): string {
  return onboardingRunnerCommand(cwd, host, ['--bootstrap-only']);
}

// `host` stamps an explicit `--host=<id>` arg so the spawned runner subprocess detects the
// host correctly — its env has no CURSOR_PLUGIN_ROOT/CODEX_* markers (those are set only for
// the hook process), so without this the runner would mis-detect as `claude` and skip the
// Cursor-only pre-spawn model directive. Shell-quoted so the gate's clean-node-invocation
// allow-list (isOnboardingWaitCommand) still recognizes it.
export function onboardingWaitCommand(cwd: string, host?: HostId): string {
  return onboardingRunnerCommand(cwd, host, []);
}
