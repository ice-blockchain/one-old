// src/hooks/windsurf-entry.ts
// Thin host entry for Windsurf / Devin Desktop Cascade. Cascade hooks block
// only through exit code 2 + stderr, so this entry maps the shared Traffic One
// result envelope to that process protocol.

import { makeWindsurfAdapter } from '../adapters/windsurf';
import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { authRequiredMessage } from '../shared/auth';
import { applyTrafficOneEnv } from '../shared/state/traffic-one-paths';
import { parseJson } from '../shared/fsjson';
import { asRecord, firstString } from '../adapters/coerce';

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

// Cascade pre_user_prompt ignores stdout and show_output — only exit 2 + stderr
// reaches the agent (docs.devin.ai/desktop/cascade/hooks). Setup/auth/onboarding
// context must block or Windsurf silently drops it and the agent freelances.
function shouldBlockPreUserPromptContext(text: string): boolean {
  if (shouldBlockPromptForAuth(text)) return true;
  const lower = text.toLowerCase();
  return lower.includes('[setup required]')
    || lower.includes('setup required')
    || lower.includes('open the setup wizard')
    || lower.includes('traffic one needs a quick setup')
    || lower.includes('project setup is required');
}

export async function runWindsurfHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  const action = actionName(stdin, subcommand);
  if (!action) return { stdout: '', stderr: '', exitCode: 0 };
  const cwd = cwdFrom(stdin);
  applyTrafficOneEnv(cwd, 'windsurf', env);
  try { process.chdir(cwd); } catch { /* Cascade usually sets cwd; best-effort */ }

  const adapter = makeWindsurfAdapter();
  try {
    const handlers = collectHandlers(loadModules(defaultModulesDir()));
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
      if (action === 'pre_user_prompt' && message && shouldBlockPreUserPromptContext(message)) {
        return { stdout: '', stderr: message, exitCode: 2 };
      }
      return { stdout: message, stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  } catch {
    if (action === 'pre_user_prompt') {
      return { stdout: '', stderr: authRequiredMessage(env), exitCode: 2 };
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
