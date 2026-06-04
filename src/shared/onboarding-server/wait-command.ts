// src/shared/onboarding-server/wait-command.ts
// The shell command the agent runs right after opening the setup wizard to BLOCK
// until onboarding completes, then continue the build with no extra user message.
// Both the PreToolUse gate and the UserPromptSubmit handler surface it (filled into
// the server-deny-reason prose). The path is absolute so it runs from any cwd, and
// the args are JSON-quoted so spaces are safe — and so the gate's allow-list (which
// rejects shell metacharacters) recognizes it as a single clean node invocation.

import * as path from 'path';

import { pluginRoot } from '../paths';

export function onboardingWaitScriptPath(): string {
  return path.join(pluginRoot(), 'scripts', 'onboarding-wait.cjs');
}

export function onboardingWaitCommand(cwd: string): string {
  return `node ${JSON.stringify(onboardingWaitScriptPath())} ${JSON.stringify(cwd)}`;
}
