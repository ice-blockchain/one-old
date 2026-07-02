// src/shared/onboarding-server/wait-command.ts
// The shell command the agent runs right after opening the setup wizard to BLOCK
// until onboarding completes, then continue the build with no extra user message.
// Both the PreToolUse gate and the UserPromptSubmit handler surface it (filled into
// the server-deny-reason prose). The path is absolute so it runs from any cwd, and
// the args are JSON-quoted so spaces are safe — and so the gate's allow-list (which
// rejects shell metacharacters) recognizes it as a single clean node invocation.

import * as path from 'path';

import type { HostId } from '../../core/types';
import { trafficOneEnvShellPrefix } from '../state/traffic-one-paths';
import { pluginRoot } from '../paths';

export function onboardingWaitScriptPath(): string {
  return path.join(pluginRoot(), 'scripts', 'onboarding-wait.cjs');
}

// `host` stamps an explicit `--host=<id>` arg so the spawned runner subprocess detects the
// host correctly — its env has no CURSOR_PLUGIN_ROOT/CODEX_* markers (those are set only for
// the hook process), so without this the runner would mis-detect as `claude` and skip the
// Cursor-only pre-spawn model directive. JSON-quoted so the gate's clean-node-invocation
// allow-list (isOnboardingWaitCommand) still recognizes it.
export function onboardingWaitCommand(cwd: string, host?: HostId): string {
  const hostArg = host ? ` ${JSON.stringify(`--host=${host}`)}` : '';
  const envPrefix = trafficOneEnvShellPrefix(cwd, host);
  return `${envPrefix}node ${JSON.stringify(onboardingWaitScriptPath())} ${JSON.stringify(cwd)}${hostArg}`;
}
