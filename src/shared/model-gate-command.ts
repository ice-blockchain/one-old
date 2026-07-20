// src/shared/model-gate-command.ts
// The shell command the Cursor orchestrator runs AFTER capturing its model list and BEFORE
// spawning the team. Running it as a shell command lets the beforeShellExecution hook pop a
// `permission:"ask"` dialog when a PICKED model isn't offered — but the runner itself fail-closed:
// it STOPs until the user replies **fallback** or **enable** in chat (recorded in model-choice.json).
// Mirrors onboardingWaitCommand: absolute path, inert shell-quoted args (clean-node-invocation
// allow-list), explicit `--host` so the runner subprocess detects Cursor.

import * as path from 'path';

import { pluginRoot } from './paths';
import { shellQuote } from './shell-quote';

export function modelGateScriptPath(): string {
  return path.join(pluginRoot(), 'scripts', 'model-gate.cjs');
}

export function modelGateCommand(cwd: string, host?: string): string {
  const hostArg = host ? ` ${shellQuote(`--host=${host}`)}` : '';
  return `node ${shellQuote(modelGateScriptPath())} ${shellQuote(cwd)}${hostArg}`;
}

export function modelCaptureCommand(cwd: string, host?: string): string {
  return `${modelGateCommand(cwd, host)} '--capture-models' 'EXACT_MODEL_ID_1' 'EXACT_MODEL_ID_2' 'MORE_EXACT_MODEL_IDS'`;
}
