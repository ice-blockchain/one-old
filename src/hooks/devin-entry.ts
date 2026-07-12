// Native Devin Local hook entry used by the current Windsurf "Devin Local"
// backend. Unlike legacy Cascade hooks, stdout JSON is delivered to the agent.

import { makeDevinAdapter } from '../adapters/devin';
import { dispatchSubcommand } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { authRequiredMessage } from '../shared/auth';
import { applyTrafficOneEnv } from '../shared/state/traffic-one-paths';
import { parseJson } from '../shared/fsjson';
import { asRecord, asString } from '../adapters/coerce';
import { computeOnboarding } from '../shared/onboarding-server/flow';
import { ensureOnboardingServer } from '../shared/onboarding-server/ensure';
import { onboardingWaitCommand } from '../shared/onboarding-server/wait-command';
import { windsurfSetupReason } from '../shared/onboarding-server/windsurf-setup';
import { resolveProjectRoot } from '../shared/hook-paths';
import { isPluginAuthoringRoot } from '../shared/authoring-root';
import { stampWindsurfBackend } from '../shared/windsurf-backend';

export interface HookOutput { stdout: string; exitCode: number; }

function cwdFrom(stdin: string): string {
  const data = asRecord(parseJson<Record<string, unknown>>(stdin, {}));
  return asString(data.cwd) || process.cwd();
}

function onboardingStopResult(stdin: string, cwd: string): string {
  const data = asRecord(parseJson<Record<string, unknown>>(stdin, {}));
  // Devin re-runs Stop after a blocking Stop hook. Allow that second stop to
  // avoid an infinite loop if the model still refuses to issue the wait tool.
  if (data.stop_hook_active === true) return '';
  const root = resolveProjectRoot(cwd);
  if (isPluginAuthoringRoot(root) || computeOnboarding(root).done) return '';
  const server = ensureOnboardingServer(root, { host: 'windsurf' });
  return JSON.stringify({
    decision: 'block',
    reason: windsurfSetupReason(server.url, onboardingWaitCommand(root, 'windsurf')),
  });
}

export async function runDevinHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  stampWindsurfBackend('devin', env);
  if (!subcommand) return { stdout: '', exitCode: 0 };
  const cwd = cwdFrom(stdin);
  applyTrafficOneEnv(cwd, 'windsurf', env);
  try { process.chdir(cwd); } catch { /* best-effort */ }
  if (subcommand === 'onboarding-stop') {
    return { stdout: onboardingStopResult(stdin, cwd), exitCode: 0 };
  }
  try {
    const handlers = collectHandlers(loadModules(defaultModulesDir()));
    const stdout = await dispatchSubcommand(makeDevinAdapter(), handlers, subcommand, { stdin, argv: [subcommand, '--host=windsurf'] });
    return { stdout, exitCode: 0 };
  } catch {
    if (subcommand === 'session-start' || subcommand === 'user-prompt-submit') {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: subcommand === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
            additionalContext: authRequiredMessage(env),
          },
        }),
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = (): void => resolve(Buffer.concat(chunks).toString('utf8'));
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    if (process.stdin.isTTY) resolve('');
  });
}

export async function main(): Promise<number> {
  const stdin = await readStdin();
  const result = await runDevinHook(process.argv[2], stdin);
  if (result.stdout) process.stdout.write(result.stdout);
  return result.exitCode;
}

if (require.main === module) void main().then((code) => { process.exitCode = code; });
