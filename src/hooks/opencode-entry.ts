// src/hooks/opencode-entry.ts
// Thin host entry for OpenCode. The global user-level plugin wrapper invokes:
//   node <plugin>/scripts/opencode-hook-runtime.cjs <subcommand> --host=opencode
//
// Tool hooks run through the full handler set, like Cursor's coarse events.
// `before-tool-use` denies serialize to `{kind:"deny"}` so the wrapper can throw
// from `tool.execute.before` and fail closed.

import { makeOpenCodeAdapter } from '../adapters/opencode';
import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { authRequiredMessage } from '../shared/auth';
import { obj } from '../shared/obj';
import { applyTrafficOneEnv } from '../shared/state/traffic-one-paths';

export interface HookOutput { stdout: string; exitCode: number; }

const OPENCODE_NOOP = JSON.stringify({ kind: 'noop' });
const OPENCODE_PRE_TOOL_FAIL_CLOSED = JSON.stringify({
  kind: 'deny',
  reason: 'Traffic One OpenCode pre-tool gate failed before it could make a decision, so this tool call is blocked fail-closed. Run Traffic One doctor and retry after the plugin is healthy.',
});

function sessionStartFallback(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({ kind: 'context', context: authRequiredMessage(env) });
}

function subcommandFromArgs(args: readonly string[]): string | undefined {
  return args.find((arg) => typeof arg === 'string' && arg.length > 0 && !arg.startsWith('--'));
}

function cwdFromStdin(stdin: string): string {
  try {
    const payload = obj(JSON.parse(stdin)) || {};
    return firstString(payload.cwd, payload.projectRoot, payload.workspaceRoot);
  } catch {
    return '';
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export async function runOpenCodeHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  if (!subcommand) return { stdout: OPENCODE_NOOP, exitCode: 0 };
  const cwd = cwdFromStdin(stdin);
  if (cwd) applyTrafficOneEnv(cwd, 'opencode', env);
  const adapter = makeOpenCodeAdapter();
  try {
    const handlers = collectHandlers(loadModules(defaultModulesDir()));
    const stdout = await dispatch(adapter, handlers, { stdin, argv: [subcommand, '--host=opencode'] });
    return { stdout: stdout || OPENCODE_NOOP, exitCode: 0 };
  } catch {
    if (subcommand === 'session-start' || subcommand === 'system-transform') {
      return { stdout: sessionStartFallback(env), exitCode: 0 };
    }
    if (subcommand === 'before-tool-use') {
      return { stdout: OPENCODE_PRE_TOOL_FAIL_CLOSED, exitCode: 0 };
    }
    return { stdout: OPENCODE_NOOP, exitCode: 0 };
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
  const stdin = await readStdin();
  const { stdout } = await runOpenCodeHook(subcommand, stdin);
  process.stdout.write(stdout);
  process.exitCode = 0;
}

if (require.main === module) {
  void main();
}
