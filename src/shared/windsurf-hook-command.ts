// src/shared/windsurf-hook-command.ts
// Shell command strings for Windsurf / Devin Desktop Cascade hooks. User-level
// installs use an absolute plugin root; workspace hooks use the stable shim under
// ~/.traffic-one/bin so version bumps do not rewrite committed hook paths.

import * as path from 'path';

import { WINDSURF_HOOK_EVENTS, type WindsurfHookEvent } from '../config/windsurf-host';
import { stableBinDir } from './runner-shims';

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

const STABLE_SHIM = path.join(stableBinDir(), 'windsurf-hook-runtime.cjs');

export function windsurfHookEnvPrefix(pluginRoot?: string): string {
  const parts = ['TRAFFIC_ONE_HOST=windsurf'];
  if (pluginRoot) parts.unshift(`TRAFFIC_ONE_PLUGIN_ROOT=${shellQuote(pluginRoot)}`);
  return parts.join(' ');
}

/** User-level install: absolute plugin-root runtime (survives one approval path). */
export function windsurfUserHookCommand(pluginRoot: string, event: WindsurfHookEvent): string {
  const runtime = path.join(pluginRoot, 'scripts', 'windsurf-hook-runtime.cjs');
  return `${windsurfHookEnvPrefix(pluginRoot)} node ${shellQuote(runtime)} ${event} --host=windsurf`;
}

/** Current Windsurf Devin Local backend: native Claude-compatible lifecycle hooks. */
export function devinUserHookCommand(pluginRoot: string, subcommand: string): string {
  const runtime = path.join(pluginRoot, 'scripts', 'devin-hook-runtime.cjs');
  return `${windsurfHookEnvPrefix(pluginRoot)} node ${shellQuote(runtime)} ${subcommand} --host=windsurf`;
}

/** Workspace-level hooks: stable shim path (written by ensureRunnerShims). */
export function windsurfWorkspaceHookCommand(event: WindsurfHookEvent): string {
  return `${windsurfHookEnvPrefix()} node ${shellQuote(STABLE_SHIM)} ${event} --host=windsurf`;
}

export const WINDSURF_WORKSPACE_HOOKS_REL = path.join('.windsurf', 'hooks.json');

export function windsurfWorkspaceHooksJson(): string {
  const hooks: Record<string, Array<{ command: string; show_output: boolean }>> = {};
  for (const event of WINDSURF_HOOK_EVENTS) {
    hooks[event] = [{ command: windsurfWorkspaceHookCommand(event), show_output: true }];
  }
  return `${JSON.stringify({ trafficOneGenerated: true, hooks }, null, 2)}\n`;
}

export function isGeneratedWindsurfWorkspaceHooks(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { trafficOneGenerated?: unknown };
    return parsed.trafficOneGenerated === true;
  } catch {
    return false;
  }
}
