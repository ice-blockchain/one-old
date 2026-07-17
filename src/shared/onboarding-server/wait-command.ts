// src/shared/onboarding-server/wait-command.ts
// The shell command the agent runs right after opening the setup wizard to BLOCK
// until onboarding completes, then continue the build with no extra user message.
// Both the PreToolUse gate and the UserPromptSubmit handler surface it (filled into
// the server-deny-reason prose). The path is absolute so it runs from any cwd, and
// every argument is inertly shell-quoted so spaces and project-name punctuation
// remain a single value that the gate's deliberately small parser can validate.

import * as path from 'path';

import type { HostId } from '../../core/types';
import { qualifiesAsSeedPrompt, truncateSeedPrompt } from '../onboarding/seed-prompt';
import { trafficOneEnvShellPrefix } from '../state/traffic-one-paths';
import { pluginRoot } from '../paths';

// Keep the value inert and bounded both in generated commands and in the
// project-local once-marker filename. This mirrors once.ts's safe-key alphabet
// and ceiling, so a SessionStart marker and its waiter command resolve to the
// exact same identity even when a host supplies punctuation.
const MAX_SYNC_SESSION_ID_LENGTH = 96;

export function onboardingSyncSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, MAX_SYNC_SESSION_ID_LENGTH);
}

export function onboardingWaitScriptPath(): string {
  return path.join(pluginRoot(), 'scripts', 'onboarding-wait.cjs');
}

// POSIX/PowerShell-compatible literal quoting. JSON double quotes are not shell
// quoting: `$`, backticks, and command substitution still expand inside them.
// Single-quote every generated argument so project names such as `app ($draft)`
// remain one inert argv value. The classifier understands the standard '\''
// splice used for a literal apostrophe.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function onboardingRunnerCommand(
  cwd: string,
  host: HostId | undefined,
  flags: readonly string[],
  trailingFlags: readonly string[] = [],
): string {
  const flagArgs = flags.map((flag) => ` ${shellQuote(flag)}`).join('');
  const hostArg = host ? ` ${shellQuote(`--host=${host}`)}` : '';
  const trailingArgs = trailingFlags.map((flag) => ` ${shellQuote(flag)}`).join('');
  const envPrefix = trafficOneEnvShellPrefix(cwd, host);
  return `${envPrefix}node ${shellQuote(onboardingWaitScriptPath())}${flagArgs} ${shellQuote(cwd)}${hostArg}${trailingArgs}`;
}

// The user's original request, carried on the `--use` yes commands as an inert
// quoted `--seed-prompt=` argument. In ask-first mode NOTHING is written before
// the recorded yes — so the prompt that triggered the question cannot be seeded
// into project state by the hook (the old pre-decision write). The runner seeds
// it right after recording the yes instead. Only a prompt that looks like a
// project description is embedded; control prompts ("stop", greetings) never are.
function seedPromptFlags(seedPrompt?: string): string[] {
  const text = truncateSeedPrompt(seedPrompt || '');
  if (!text || !qualifiesAsSeedPrompt(text)) return [];
  return [`--seed-prompt=${text}`];
}

function syncSessionFlags(syncSession?: string): string[] {
  const identity = onboardingSyncSessionId(syncSession);
  return identity ? [`--sync-session=${identity}`] : [];
}

// Starts the wizard under an approval-capable shell process, prints its live URL,
// and exits immediately. `--bootstrap-only` deliberately precedes the project
// path so Codex can persist a narrow prefix approval that works for future projects.
export function onboardingBootstrapCommand(cwd: string, host?: HostId, syncSession?: string): string {
  return onboardingRunnerCommand(cwd, host, ['--bootstrap-only'], syncSessionFlags(syncSession));
}

// `host` stamps an explicit `--host=<id>` arg so the spawned runner subprocess detects the
// host correctly — its env has no CURSOR_PLUGIN_ROOT/CODEX_* markers (those are set only for
// the hook process), so without this the runner would mis-detect as `claude` and skip the
// Cursor-only pre-spawn model directive. Shell-quoted so the gate's clean-node-invocation
// allow-list (isOnboardingWaitCommand) still recognizes it.
export function onboardingWaitCommand(cwd: string, host?: HostId, syncSession?: string): string {
  return onboardingRunnerCommand(cwd, host, [], syncSessionFlags(syncSession));
}

// Records the durable per-project "don't use Traffic One" choice (stored in the
// per-user prefs, never inside the repo) and exits. Every Traffic One hook
// stands down for the project afterwards.
export function onboardingDeclineCommand(cwd: string, host?: HostId): string {
  return onboardingRunnerCommand(cwd, host, ['--decline']);
}

// Records "yes, use Traffic One here", then continues straight into the normal
// wait behavior: starts the wizard, prints the setup link, and blocks until
// setup completes — one command for the whole yes path. The prescribed recipe
// (usePluginQuestion) is now the bootstrap-first two-step, but this single-command
// form stays valid: sessions that saw the old prose re-run it verbatim.
export function onboardingUseCommand(cwd: string, host?: HostId, seedPrompt?: string, syncSession?: string): string {
  return onboardingRunnerCommand(cwd, host, ['--use'], [...seedPromptFlags(seedPrompt), ...syncSessionFlags(syncSession)]);
}

// The fast first half of the yes path: records "yes, use Traffic One here",
// starts the wizard, prints its live `Setup link:` URL, and exits immediately
// (TRAFFIC_ONE_SETUP_READY) — so the agent can SHOW/open the link BEFORE
// blocking on the waiter. On hosts that hide a running command's stdout
// (Claude desktop), the single blocking --use command buried the link for its
// whole 8-minute timeout and read as a hang (observed 2026-07-14). Prints
// TRAFFIC_ONE_SETUP_COMPLETE instead when setup is already done.
export function onboardingUseBootstrapCommand(cwd: string, host?: HostId, seedPrompt?: string, syncSession?: string): string {
  return onboardingRunnerCommand(cwd, host, ['--use', '--bootstrap-only'], [...seedPromptFlags(seedPrompt), ...syncSessionFlags(syncSession)]);
}

// The ask-first HOST-CHAT question (ASK_USE_PLUGIN_FIRST / TRAFFIC_ONE_ASK_USE_PLUGIN):
// shown by the session/prompt/gate hooks INSTEAD of the wizard link while the
// project has no recorded use-plugin choice. No wizard server is launched, no
// URL is shown, and NOTHING is written (project or per-user) until the user
// answers. `seedPrompt` (the request that triggered the question) rides the yes
// command so the runner can seed `originalPrompt` AFTER recording the yes.
export function usePluginQuestion(cwd: string, host?: HostId, seedPrompt?: string, syncSession?: string): string {
  return [
    'traffic-one — before anything else, ask the user IN CHAT and STOP for their reply:',
    '',
    '"Do you want to use the Traffic One plugin for this development?"',
    '',
    '- If the user answers YES, do these steps IN ORDER:',
    `  1. Run this command — it saves the choice, starts the setup wizard, prints its \`Setup link:\` URL, and returns immediately:\n${onboardingUseBootstrapCommand(cwd, host, seedPrompt, syncSession)}`,
    '  2. Show that setup link to the user in chat; if a browser tool is available, ALSO open the link there so they can complete setup. (Skip this step if step 1 printed TRAFFIC_ONE_SETUP_COMPLETE.)',
    `  3. Run this command to wait for setup to finish — IN THE BACKGROUND when the shell tool supports it (a foreground run hides its output while it blocks and looks hung). Do read-only orientation meanwhile; when it prints TRAFFIC_ONE_SETUP_COMPLETE, follow any directives it printed and continue the request:\n${onboardingWaitCommand(cwd, host, syncSession)}`,
    `- If the user answers NO, run this command — the choice is saved outside the project (no files are added to it) and Traffic One stays silent here until the user explicitly asks for it again:\n${onboardingDeclineCommand(cwd, host)}`,
    '',
    'Do not scaffold, edit files, or start building until the user has answered.',
  ].join('\n');
}

// Records exact opt-in after the user explicitly asks to re-enable Traffic One,
// synchronizes current model config, then starts the normal setup flow.
export function onboardingReconsiderCommand(cwd: string, host?: HostId, syncSession?: string): string {
  return onboardingRunnerCommand(cwd, host, ['--reconsider'], syncSessionFlags(syncSession));
}
