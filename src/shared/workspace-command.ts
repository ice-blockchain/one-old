// src/shared/workspace-command.ts
// Path anchors and command printers for `traffic-one-workspace`, the sanctioned
// way to turn an onboarded project root into a workspace container.
//
// Structured exactly like reset-command.ts: the spelling the runtime PRINTS and
// the spelling the gate grammar ADMITS are both derived from the one list
// below, so a refusal can never name a command the gate then blocks.

import * as path from 'path';

import { gateExemptShimDirs, selfRelativePluginRoot } from './doctor-command';
import { documentedBinDir } from './runner-shims';
import { shellQuote } from './shell-quote';

const WORKSPACE_RUNNER = 'traffic-one-workspace.cjs';

export function workspaceScriptPath(): string {
  return path.join(selfRelativePluginRoot(), 'scripts', WORKSPACE_RUNNER);
}

export function workspaceShimPath(): string {
  return path.join(documentedBinDir(), WORKSPACE_RUNNER);
}

export function gateExemptWorkspaceScriptPaths(): readonly string[] {
  return [workspaceScriptPath(), ...gateExemptShimDirs().map((dir) => path.join(dir, WORKSPACE_RUNNER))];
}

export function convertToContainerCommand(): string {
  return `node ${shellQuote(workspaceScriptPath())} --convert-to-container`;
}

export function convertToContainerYesCommand(): string {
  return `node ${shellQuote(workspaceScriptPath())} --convert-to-container --yes`;
}
