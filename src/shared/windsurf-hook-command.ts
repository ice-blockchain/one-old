// src/shared/windsurf-hook-command.ts
// Cross-platform Node command strings for Windsurf / Devin Desktop hooks.
// User-level installs use an absolute plugin root; workspace hooks name the
// stable shim by RESOLVING its directory at run time, so version bumps do not
// rewrite committed paths AND a committed file works on every machine.

import * as path from 'path';

import { WINDSURF_HOOK_EVENTS, type WindsurfHookEvent } from '../config/windsurf-host';

// Basename only — deliberately NOT path.join(stableBinDir(), ...). That resolved
// the INSTALLING machine's state dir at module-load time and baked it into a
// workspace file (see windsurfWorkspaceHookCommand). Kept in sync with
// RUNNER_SHIMS by __tests__/windsurf-hook-command.test.ts.
const WORKSPACE_SHIM = 'windsurf-hook-runtime.cjs';

const SAFE_TOKEN = /^[A-Za-z0-9_.=-]+$/;

// Nothing that reaches the `node -e "..."` argument may be able to close the
// double quote or introduce shell syntax on either POSIX or Windows.
function assertSafeCommandTokens(runtimeParts: readonly string[], args: readonly string[]): void {
  if (runtimeParts.length === 0
    || runtimeParts.some((part) => !SAFE_TOKEN.test(part))
    || args.some((arg) => !SAFE_TOKEN.test(arg))) {
    throw new Error('portable Windsurf hook command received an unsafe runtime or argument');
  }
}

// Exact pre-portability renderer, retained only so install/uninstall can identify
// and replace Traffic One commands written by older releases. Never emit this.
function legacyShellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function legacyUserHookCommand(pluginRoot: string, runtimeName: string, subcommand: string): string {
  const runtime = path.join(pluginRoot, 'scripts', runtimeName);
  return `TRAFFIC_ONE_PLUGIN_ROOT=${legacyShellQuote(pluginRoot)} TRAFFIC_ONE_HOST=windsurf node ${legacyShellQuote(runtime)} ${subcommand} --host=windsurf`;
}

// USER-LEVEL renderer: bakes an absolute base dir. Only ever written to
// user-scope config (~/.codeium/windsurf/hooks.json, ~/.config/devin/config.json),
// which never enters a repository, so an absolute path is correct there — it is
// what survives a single host approval across plugin versions.
function portableWindsurfCommand(
  baseDir: string,
  runtimeParts: readonly string[],
  args: readonly string[],
  stampPluginRoot: boolean,
): string {
  assertSafeCommandTokens(runtimeParts, args);
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

/**
 * Workspace-level hooks: the stable shim dir resolved at RUN time.
 *
 * `.windsurf/hooks.json` is a WORKSPACE file — it lands in the project and gets
 * committed — so nothing machine-specific may be baked into it. Encoding
 * `stableBinDir()` here (as this did) put the installing developer's home
 * directory into a committed launcher: correct on that machine, a `require()` of
 * a non-existent path on every teammate's.
 *
 * Both properties now hold at once:
 *  - version-stable: no plugin version appears, so a bump rewrites nothing;
 *  - machine-portable: the same bytes resolve per-machine, because the launcher
 *    recomputes stableBinDir()'s own env precedence (TRAFFIC_ONE_TOOLCHAIN_ROOT,
 *    then XDG_STATE_HOME, then HOME) and falls back to the documented
 *    `~/.traffic-one/bin`.
 *
 * Trying BOTH candidates — rather than pinning to HOME — is what keeps this
 * correct on a relocated-state machine: ensureRunnerShims() writes this shim to
 * every runnerShimDirs() entry, but a HOME that is not writable leaves only the
 * env-derived copy, and an env-derived dir that predates this shim leaves only
 * the HOME copy. First existing wins; the documented path is the fallback so a
 * genuinely absent shim fails naming the path the docs tell users to check.
 */
export function windsurfWorkspaceHookCommand(event: WindsurfHookEvent): string {
  const args = [event, '--host=windsurf'];
  assertSafeCommandTokens([WORKSPACE_SHIM], args);
  // Every character below is a literal inside both POSIX `sh -c` and Windows
  // `cmd /c` double quotes: no ", \, $, backtick, |, &, <, >, %, ! or newline
  // anywhere, and the only interpolated value is SAFE_TOKEN-validated. There is
  // no path left to encode, so base64 is not needed to keep the string inert.
  const launcher = [
    "const p=require('path'),f=require('fs'),o=require('os'),e=process.env;",
    `const n='${WORKSPACE_SHIM}';`,
    'const h=e.HOME ? e.HOME : o.homedir();',
    // The other copy of globalTrafficOneDir() (shared/state-root.ts) that cannot
    // import it, and the harder of the two: this is `node -e` source AND it ships
    // inside a COMMITTED workspace file, so a stale spelling strands teammates
    // rather than only this machine. Its tail is that base verbatim, nested
    // inside a mirror of stableBinDir()'s precedence — toolchain knob first (bin
    // sits beside the toolchains wherever they were moved), then the base. A
    // precedence step added at EITHER is owed here by hand, and
    // __tests__/launcher-state-root.test.ts holds that debt: it calls the real
    // stableBinDir() under one cell per env key either source reads, then runs
    // THIS command and checks which shim it loaded.
    "const s=e.TRAFFIC_ONE_TOOLCHAIN_ROOT ? p.dirname(p.resolve(e.TRAFFIC_ONE_TOOLCHAIN_ROOT)) : (e.XDG_STATE_HOME ? p.join(e.XDG_STATE_HOME,'traffic-one') : p.join(h,'.traffic-one'));",
    "const d=p.join(h,'.traffic-one','bin');",
    'let t=d;',
    "for(const c of [p.join(s,'bin'),d]){if(f.existsSync(p.join(c,n))){t=c;break;}}",
    "e.TRAFFIC_ONE_HOST='windsurf';",
    "process.argv.splice(1,0,'traffic-one-launcher');",
    'require(p.join(t,n));',
  ].join('');
  return `node -e "${launcher}" ${args.join(' ')}`;
}

export const WINDSURF_WORKSPACE_HOOKS_REL = path.join('.windsurf', 'hooks.json');

/**
 * The Cascade workspace-hooks file.
 *
 * NO PRODUCTION CALLER at present: current Windsurf drives Traffic One from
 * user-scope Cascade hooks plus native Devin lifecycle hooks, and the one place
 * that touches this path (`materialize/windsurf-assets.ts`) REMOVES a generated
 * file rather than writing one. It is kept because the shape is the Cascade
 * workspace contract, and it is kept PORTABLE so that reviving it cannot
 * reintroduce a committed machine-specific path.
 */
export function windsurfWorkspaceHooksJson(): string {
  const hooks: Record<string, Array<{ command: string; show_output: boolean }>> = {};
  for (const event of WINDSURF_HOOK_EVENTS) {
    hooks[event] = [{ command: windsurfWorkspaceHookCommand(event), show_output: true }];
  }
  return `${JSON.stringify({ trafficOneGenerated: true, hooks }, null, 2)}\n`;
}

/**
 * Workspace-side ownership test — the counterpart of matchesWindsurfUserHookCommand,
 * and deliberately NOT a per-command matcher.
 *
 * The user-level matchers must enumerate spellings because they rewrite ONE
 * entry inside a file of foreign entries. This file is wholly ours, marked by
 * `trafficOneGenerated`, so ownership is decided by the MARKER: it already
 * recognizes the pre-portability spelling that baked an absolute home path, this
 * portable one, and any future one, while still never claiming a hand-written
 * `.windsurf/hooks.json`. That is what lets an upgrade heal an existing broken
 * file — materialization recognizes and removes it — with no third spelling to
 * enumerate and no way to miss one.
 */
export function isGeneratedWindsurfWorkspaceHooks(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { trafficOneGenerated?: unknown };
    return parsed.trafficOneGenerated === true;
  } catch {
    return false;
  }
}
