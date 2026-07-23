// src/shared/windsurf-hook-command.ts
// Cross-platform Node command strings for Windsurf / Devin Desktop hooks.
// User-level installs use an absolute plugin root; workspace hooks use the stable
// shim under ~/.traffic-one/bin so version bumps do not rewrite committed paths.

import * as path from 'path';

import { WINDSURF_HOOK_EVENTS, type WindsurfHookEvent } from '../config/windsurf-host';
import { stableBinDir } from './runner-shims';

const STABLE_SHIM = path.join(stableBinDir(), 'windsurf-hook-runtime.cjs');

// Exact pre-portability renderer, retained only so install/uninstall can identify
// and replace Traffic One commands written by older releases. Never emit this.
function legacyShellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function legacyUserHookCommand(pluginRoot: string, runtimeName: string, subcommand: string): string {
  const runtime = path.join(pluginRoot, 'scripts', runtimeName);
  return `TRAFFIC_ONE_PLUGIN_ROOT=${legacyShellQuote(pluginRoot)} TRAFFIC_ONE_HOST=windsurf node ${legacyShellQuote(runtime)} ${subcommand} --host=windsurf`;
}

function portableWindsurfCommand(
  baseDir: string,
  runtimeParts: readonly string[],
  args: readonly string[],
  stampPluginRoot: boolean,
): string {
  const safeToken = /^[A-Za-z0-9_.=-]+$/;
  if (runtimeParts.length === 0
    || runtimeParts.some((part) => !safeToken.test(part))
    || args.some((arg) => !safeToken.test(arg))) {
    throw new Error('portable Windsurf hook command received an unsafe runtime or argument');
  }
  // The absolute path is data, never shell syntax. Base64 keeps arbitrary
  // Windows/POSIX path characters out of the cross-shell `node -e` argument.
  const encodedBase = Buffer.from(path.resolve(baseDir), 'utf8').toString('base64');
  const joinedRuntime = runtimeParts.map((part) => `'${part}'`).join(',');
  const launcher = [
    `const p=require('path'),e=process.env,b=Buffer.from('${encodedBase}','base64').toString('utf8');`,
    "e.TRAFFIC_ONE_HOST='windsurf';",
    ...(stampPluginRoot ? ['e.TRAFFIC_ONE_PLUGIN_ROOT=b;'] : []),
    "process.argv.splice(1,0,'traffic-one-launcher');",
    `require(p.join(b,${joinedRuntime}));`,
  ].join('');
  return `node -e "${launcher}" ${args.join(' ')}`;
}

/** User-level install: absolute plugin-root runtime (survives one approval path). */
export function windsurfUserHookCommand(pluginRoot: string, event: WindsurfHookEvent): string {
  return portableWindsurfCommand(
    pluginRoot,
    ['scripts', 'windsurf-hook-runtime.cjs'],
    [event, '--host=windsurf'],
    true,
  );
}

export function matchesWindsurfUserHookCommand(command: string, pluginRoot: string, event: WindsurfHookEvent): boolean {
  return command === windsurfUserHookCommand(pluginRoot, event)
    || command === legacyUserHookCommand(pluginRoot, 'windsurf-hook-runtime.cjs', event);
}

/** Current Windsurf Devin Local backend: native Claude-compatible lifecycle hooks. */
export function devinUserHookCommand(pluginRoot: string, subcommand: string): string {
  return portableWindsurfCommand(
    pluginRoot,
    ['scripts', 'devin-hook-runtime.cjs'],
    [subcommand, '--host=windsurf'],
    true,
  );
}

export function matchesDevinUserHookCommand(command: string, pluginRoot: string, subcommand: string): boolean {
  return command === devinUserHookCommand(pluginRoot, subcommand)
    || command === legacyUserHookCommand(pluginRoot, 'devin-hook-runtime.cjs', subcommand);
}

/** Workspace-level hooks: stable shim path (written by ensureRunnerShims). */
export function windsurfWorkspaceHookCommand(event: WindsurfHookEvent): string {
  return portableWindsurfCommand(
    path.dirname(STABLE_SHIM),
    [path.basename(STABLE_SHIM)],
    [event, '--host=windsurf'],
    false,
  );
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
