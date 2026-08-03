// Native Devin Local hook entry used by the current Windsurf "Devin Local"
// backend. Unlike legacy Cascade hooks, stdout JSON is delivered to the agent.

import { makeDevinAdapter } from '../adapters/devin';
import { dispatchSubcommand } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { initializeTrafficOneEnv } from '../shared/state/runtime-env';
import { parseJson } from '../shared/fsjson';
import { asRecord, asString } from '../adapters/coerce';
import { computeOnboarding } from '../shared/onboarding-server/flow';
import { prepareOnboardingServer } from '../shared/onboarding-server/bootstrap';
import { windsurfSetupReason } from '../shared/onboarding-server/windsurf-setup';
import { resolveProjectRoot } from '../shared/hook/paths';
import { isNonProjectRoot } from '../shared/authoring-root';
import { stampWindsurfBackend } from '../shared/windsurf-backend';
import { devinPreToolDeny, hasValidPreToolPayload, isGatePreToolSubcommand } from './fail-closed';
import { authFallbackMessage, hookFallbackStandsDown } from './auth-fallback';
import { localFallbackSection } from '../shared/onboarding-server/wizard-links';
import { onboardingSetTechCommandTemplate, onboardingSyncSessionId } from '../shared/onboarding-server/wait-command';
import { techClassifyHints, techClassifyRequiredReason } from '../shared/onboarding-server/tech-classify-setup';

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
  if (isNonProjectRoot(root)) return '';
  const onboarding = computeOnboarding(root);
  if (onboarding.done) return '';
  const syncSession = onboardingSyncSessionId(data.session_id ?? data.sessionId);
  // Setup pending on the AGENT (tech classification): no wizard server or link —
  // block once with the classification recipe instead (this Stop block is the
  // Devin backend's only re-delivery channel).
  if (onboarding.step === 'tech-detect') {
    const template = onboardingSetTechCommandTemplate(root, 'windsurf', syncSession);
    return JSON.stringify({
      decision: 'block',
      reason: techClassifyRequiredReason(template, techClassifyHints(null)),
    });
  }
  const prepared = prepareOnboardingServer(root, 'windsurf', { syncSession });
  if (prepared.kind !== 'ready') {
    return JSON.stringify({ decision: 'block', reason: prepared.reason });
  }
  // Deliberately NOT gated on the wizard already being open: this Stop block is
  // Windsurf/Devin's only re-delivery channel, and dropping it would end the turn
  // mid-onboarding. When the user does have the wizard open the message still
  // re-states the same live link, which is harmless; going silent is not.
  return JSON.stringify({
    decision: 'block',
    reason: windsurfSetupReason(
      prepared.server.dashboardUrl,
      localFallbackSection(root, prepared.server.localWizardUrl, process.env, 'windsurf'),
      prepared.waitCommand,
    ),
  });
}

export async function runDevinHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  if (!subcommand) return { stdout: '', exitCode: 0 };
  if (isGatePreToolSubcommand(subcommand) && !hasValidPreToolPayload(stdin, subcommand, 'nested')) {
    return { stdout: devinPreToolDeny(), exitCode: 0 };
  }
  try {
    stampWindsurfBackend('devin', env);
    const cwd = cwdFrom(stdin);
    initializeTrafficOneEnv(cwd, 'windsurf', env);
    try { process.chdir(cwd); } catch { /* best-effort */ }
    if (subcommand === 'onboarding-stop') {
      return { stdout: onboardingStopResult(stdin, cwd), exitCode: 0 };
    }
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const stdout = await dispatchSubcommand(makeDevinAdapter(), handlers, subcommand, { stdin, argv: [subcommand, '--host=windsurf'] });
    return { stdout, exitCode: 0 };
  } catch {
    if (hookFallbackStandsDown(stdin, env)) return { stdout: '', exitCode: 0 };
    if (subcommand === 'session-start' || subcommand === 'user-prompt-submit') {
      const message = authFallbackMessage(stdin, env);
      if (!message) return { stdout: '', exitCode: 0 };
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: subcommand === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
            additionalContext: message,
          },
        }),
        exitCode: 0,
      };
    }
    if (isGatePreToolSubcommand(subcommand)) {
      return { stdout: devinPreToolDeny(), exitCode: 0 };
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
