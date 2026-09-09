// src/hooks/kilo-entry.ts
// Thin host entry for Kilo. The user-level Kilo server plugin wrapper invokes:
//   node <plugin>/scripts/kilo-hook-runtime.cjs <subcommand> --host=kilo
//
// Tool hooks run through the shared handler set. Before-tool denies serialize to
// `{kind:"deny"}` so the wrapper can throw from `tool.execute.before`.

import { makeKiloAdapter } from '../adapters/kilo';
import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { obj } from '../shared/obj';
import { initializeTrafficOneEnv } from '../shared/state/runtime-env';
import { authFallbackMessage, safeHookFallbackStandsDown } from './auth-fallback';
import { guardedMain } from './entry-guard';
import { hasValidPreToolPayload, safeFailClosedRecoveryExemption, wrapperPreToolDeny } from './fail-closed';

export interface HookOutput { stdout: string; exitCode: number; }

const KILO_NOOP = JSON.stringify({ kind: 'noop' });
const KILO_PRE_TOOL_FAIL_CLOSED = wrapperPreToolDeny('Kilo');
const KILO_PROMPT_FAIL_CONTEXT = 'Traffic One Kilo hook failed before it could provide project context. Run Traffic One doctor, then restart Kilo/WebStorm so the plugin reloads.';

function sessionStartFallback(message: string): string {
  return JSON.stringify({ kind: 'context', context: message });
}

function subcommandFromArgs(args: readonly string[]): string | undefined {
  return args.find((arg) => typeof arg === 'string' && arg.length > 0 && !arg.startsWith('--'));
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function cwdFromStdin(stdin: string): string {
  try {
    const payload = obj(JSON.parse(stdin)) || {};
    return firstString(payload.cwd, payload.projectRoot, payload.workspaceRoot);
  } catch {
    return '';
  }
}

export async function runKiloHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  if (!subcommand) return { stdout: KILO_NOOP, exitCode: 0 };
  if (subcommand === 'before-tool-use'
    && !hasValidPreToolPayload(stdin, subcommand, 'wrapper')
    && !safeFailClosedRecoveryExemption(stdin, subcommand, 'wrapper')) {
    return { stdout: KILO_PRE_TOOL_FAIL_CLOSED, exitCode: 0 };
  }
  try {
    const cwd = cwdFromStdin(stdin);
    if (cwd) initializeTrafficOneEnv(cwd, 'kilo', env);
    const adapter = makeKiloAdapter();
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const stdout = await dispatch(adapter, handlers, { stdin, argv: [subcommand, '--host=kilo'] });
    return { stdout: stdout || KILO_NOOP, exitCode: 0 };
  } catch {
    if (safeHookFallbackStandsDown(stdin, env)) return { stdout: KILO_NOOP, exitCode: 0 };
    if (subcommand === 'session-start' || subcommand === 'system-transform') {
      const message = authFallbackMessage(stdin, env);
      return { stdout: message ? sessionStartFallback(message) : KILO_NOOP, exitCode: 0 };
    }
    if (subcommand === 'before-tool-use') {
      if (safeFailClosedRecoveryExemption(stdin, subcommand, 'wrapper')) return { stdout: KILO_NOOP, exitCode: 0 };
      return { stdout: KILO_PRE_TOOL_FAIL_CLOSED, exitCode: 0 };
    }
    if (subcommand === 'user-prompt-submit') {
      return { stdout: JSON.stringify({ kind: 'context', context: KILO_PROMPT_FAIL_CONTEXT, systemMessage: 'traffic-one Kilo hook failed' }), exitCode: 0 };
    }
    return { stdout: KILO_NOOP, exitCode: 0 };
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stdin = process.stdin;
    let settled = false;
    const done = (): void => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    stdin.on('end', done);
    stdin.on('error', done);
    if (stdin.isTTY) done();
  });
}

export async function main(): Promise<void> {
  const subcommand = subcommandFromArgs(process.argv.slice(2));
  try {
    const stdin = await readStdin();
    const out = await guardedMain({
      subcommand,
      stdin,
      isPreTool: subcommand === 'before-tool-use',
      surface: 'wrapper',
      deny: { stdout: KILO_PRE_TOOL_FAIL_CLOSED, exitCode: 0 },
      noop: { stdout: KILO_NOOP, exitCode: 0 },
      run: () => runKiloHook(subcommand, stdin),
    });
    process.stdout.write(out.stdout);
    process.exitCode = 0;
  } catch {
    try {
      process.stdout.write(subcommand === 'before-tool-use' ? KILO_PRE_TOOL_FAIL_CLOSED : KILO_NOOP);
    } catch { /* last-ditch write must not reject */ }
    process.exitCode = 0;
  }
}

if (require.main === module) {
  void main().catch(() => {
    try {
      const subcommand = subcommandFromArgs(process.argv.slice(2));
      process.stdout.write(subcommand === 'before-tool-use' ? KILO_PRE_TOOL_FAIL_CLOSED : KILO_NOOP);
    } catch { /* */ }
    process.exitCode = 0;
  });
}
