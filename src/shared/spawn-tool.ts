// src/shared/spawn-tool.ts
// Windows-safe spawnSync wrapper for invoking EXTERNAL TOOLS (npm/npx/opencode/
// gitnexus/tsc/git/pipx) — anything whose resolved target may be a `.cmd`/`.bat`
// shim or a bare name PATHEXT would resolve to one.
//
// Why: Node >=22 (the CVE-2024-27980 fix, this repo pins engines.node>=22) REFUSES
// to spawnSync a `.cmd`/`.bat` without shell:true and throws EINVAL. So on Windows
// we resolve the command to a concrete path and, when it is a batch shim, run it
// through cmd.exe. CRITICAL: Node/libuv's argv quoting is generic CommandLineToArgvW
// quoting — it does NOT neutralize cmd.exe metacharacters (& | < > ^ ( ) % ! etc.),
// so passing free-form text (e.g. an opencode delegation prompt) straight to
// `cmd /c` would mis-parse or inject. We therefore escape every argument with the
// canonical cross-spawn / qntm.org/cmd algorithm (caret-escaping the cmd metachar
// set, including spaces — which is also how a spaced command path stays one token)
// and pass the assembled line verbatim (windowsVerbatimArguments:true). On POSIX
// this is a thin passthrough to spawnSync.
//
// NOTE: pure `.exe` targets (a managed node.exe / python.exe / git.exe) pass
// straight through unchanged — only batch shims go through cmd.exe.

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { exec } from './exec';

// cmd.exe metacharacters that must be caret-escaped on a `cmd /c` command line.
// Ported verbatim from cross-spawn (MIT) — see http://www.robvanderwoude.com/escapechars.php
// and https://qntm.org/cmd. Includes space so a spaced command/arg stays one token.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// Escape the command (program) token: caret-escape metachars only (no surrounding
// quotes — the spaced-path case is handled by the caret-escaped space).
export function escapeCmdCommand(arg: string): string {
  return String(arg).replace(CMD_META, '^$1');
}

// Escape an argument: qntm.org/cmd quoting (double backslashes before a quote /
// at end, escape embedded quotes, wrap in quotes) then caret-escape cmd metachars.
// The backtracking-safe regexes match cross-spawn PR #160.
export function escapeCmdArgument(arg: string): string {
  let s = `${arg}`;
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META, '^$1');
  return s;
}

// Resolve a command to a concrete on-disk path on Windows. Absolute existing path
// → used as-is; absolute bare name → try .cmd/.bat/.exe siblings; otherwise
// exec.which() does the PATHEXT-aware PATH lookup. Falls back to the original so a
// genuinely-missing command still yields the normal ENOENT the caller handles.
//
// Exported for qa-evidence/native-process.ts, which needs the same resolution
// for an ASYNC spawn and cannot use spawnTool. A second copy of these four
// lines is exactly the drift this module's escaping is imported to avoid, and
// this is a pure export: nothing about the behaviour five other runners depend
// on changes.
export function resolveWindowsCommand(command: string): string {
  if (path.isAbsolute(command)) {
    if (fs.existsSync(command)) return command;
    for (const ext of ['.cmd', '.bat', '.exe']) {
      if (fs.existsSync(command + ext)) return command + ext;
    }
    return command;
  }
  return exec.which(command) || command;
}

export function spawnTool(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string> {
  if (process.platform !== 'win32') {
    return spawnSync(command, [...args], options) as SpawnSyncReturns<string>;
  }
  const resolved = resolveWindowsCommand(command);
  const lower = resolved.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    // Assemble the fully-escaped command line and pass it verbatim. `/d` skips
    // AutoRun, `/s` strips the outer quote pair, `/c` runs then exits.
    const shellCommand = [escapeCmdCommand(resolved), ...args.map((a) => escapeCmdArgument(String(a)))].join(' ');
    return spawnSync(comspec, ['/d', '/s', '/c', `"${shellCommand}"`], {
      ...options,
      windowsVerbatimArguments: true,
    }) as SpawnSyncReturns<string>;
  }
  return spawnSync(resolved, [...args], options) as SpawnSyncReturns<string>;
}
