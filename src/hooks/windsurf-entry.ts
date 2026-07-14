// src/hooks/windsurf-entry.ts
// Thin host entry for Windsurf / Devin Desktop Cascade. Cascade hooks block
// only through exit code 2 + stderr, so this entry maps the shared Traffic One
// result envelope to that process protocol.

import { makeWindsurfAdapter } from '../adapters/windsurf';
import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { authRequiredMessage } from '../shared/auth';
import { initializeTrafficOneEnv } from '../shared/state/runtime-env';
import { parseJson } from '../shared/fsjson';
import { asRecord, firstString } from '../adapters/coerce';
import { stampWindsurfBackend } from '../shared/windsurf-backend';
import { isWindsurfPreToolAction, preToolFailureReason } from './fail-closed';

export interface HookOutput { stdout: string; stderr: string; exitCode: number; }

type WindResult =
  | { kind: 'noop' }
  | { kind: 'context'; context?: string; systemMessage?: string }
  | { kind: 'deny'; reason?: string; context?: string; systemMessage?: string };

const PRE_HOOKS = new Set(['pre_user_prompt', 'pre_read_code', 'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use']);

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

function actionName(stdin: string, subcommand: string | undefined): string {
  const data = asRecord(parseJson<Record<string, unknown>>(stdin, {}));
  return firstString(data.agent_action_name, data.action, data.event, subcommand);
}

function cwdFrom(stdin: string): string {
  const data = asRecord(parseJson<Record<string, unknown>>(stdin, {}));
  const info = asRecord(data.tool_info ?? data.toolInfo ?? data.input);
  return firstString(info.cwd, info.working_directory, info.workingDirectory, data.cwd, data.workspace_root, data.workspaceRoot) || process.cwd();
}

// Devin Local currently also forwards each native lifecycle event through the
// legacy Cascade hook bridge. Those synthetic Cascade payloads are identifiable
// by an explicitly present but empty trajectory_id; genuine Cascade sessions
// carry a real trajectory id (or older builds omit the field). Ignore only the
// synthetic duplicate so both backends can stay installed without double gates.
function isSyntheticDevinCascadeDuplicate(stdin: string): boolean {
  const data = asRecord(parseJson<Record<string, unknown>>(stdin, {}));
  return typeof data.agent_action_name === 'string'
    && Object.prototype.hasOwnProperty.call(data, 'trajectory_id')
    && typeof data.trajectory_id === 'string'
    && data.trajectory_id.trim() === '';
}

function parseEnvelope(stdout: string): WindResult {
  try {
    const parsed = JSON.parse(stdout || '{"kind":"noop"}') as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { kind?: unknown }).kind === 'string') {
      return parsed as WindResult;
    }
  } catch {
    // fall through
  }
  return { kind: 'noop' };
}

function contextText(result: Extract<WindResult, { kind: 'context' }>): string {
  return [result.systemMessage, result.context].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n\n');
}

function shouldBlockPromptForAuth(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('traffic-one inactive')
    || lower.includes('authentication is missing')
    || lower.includes('authenticate traffic one')
    || lower.includes('api key')
    || lower.includes('session expired');
}

export async function runWindsurfHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  stampWindsurfBackend('cascade', env);
  if (isSyntheticDevinCascadeDuplicate(stdin)) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  const action = actionName(stdin, subcommand);
  if (!action) return { stdout: '', stderr: '', exitCode: 0 };
  try {
    const cwd = cwdFrom(stdin);
    initializeTrafficOneEnv(cwd, 'windsurf', env);
    try { process.chdir(cwd); } catch { /* Cascade usually sets cwd; best-effort */ }
    const adapter = makeWindsurfAdapter();
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const rawOut = await dispatch(adapter, handlers, { stdin, argv: [action, '--host=windsurf'] });
    const result = parseEnvelope(rawOut);
    const isPre = PRE_HOOKS.has(action);

    if (result.kind === 'deny') {
      const message = [result.reason, result.context, result.systemMessage]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n\n');
      return isPre
        ? { stdout: '', stderr: message || 'traffic-one blocked this action', exitCode: 2 }
        : { stdout: message, stderr: '', exitCode: 0 };
    }

    if (result.kind === 'context') {
      const message = contextText(result);
      // Current Windsurf/Devin Local loads both the legacy Cascade config and
      // native Devin lifecycle hooks. Blocking setup here prevents the native
      // UserPromptSubmit hook from ever admitting the user's prompt (the session
      // contains no user node and therefore cannot run onboarding-wait). Native
      // hooks inject setup context; legacy Cascade still gets the recipe on the
      // first mutating tool gate. Authentication remains fail-closed here.
      if (action === 'pre_user_prompt' && message && shouldBlockPromptForAuth(message)) {
        return { stdout: '', stderr: message, exitCode: 2 };
      }
      return { stdout: message, stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  } catch {
    if (action === 'pre_user_prompt') {
      return { stdout: '', stderr: authRequiredMessage(env), exitCode: 2 };
    }
    if (isWindsurfPreToolAction(action)) {
      return { stdout: '', stderr: preToolFailureReason('Windsurf'), exitCode: 2 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

export async function main(): Promise<number> {
  const subcommand = process.argv[2];
  const stdin = await readStdin();
  const { stdout, stderr, exitCode } = await runWindsurfHook(subcommand, stdin);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return exitCode;
}

if (require.main === module) {
  void main().then((code) => { process.exitCode = code; });
}
