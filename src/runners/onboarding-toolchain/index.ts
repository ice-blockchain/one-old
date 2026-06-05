// src/runners/onboarding-toolchain/index.ts
// Consolidated onboarding install task (compiles to scripts/onboarding-toolchain-runner.cjs).
// Spawned by the onboarding wizard at the `finalize` step. It reads the committed
// state and installs the dependencies the user actually chose:
//   - the code-graph provider (gitnexus/graphify) — install + first scan, REQUIRED;
//   - the OpenCode CLI when `openCode.enabled` — install only, OPTIONAL.
//
// Exit code is the completion gate: non-zero ONLY when the REQUIRED graph
// provider failed to install/run. OpenCode is an optional token-saver, so its
// failure is reported in the JSON summary but never blocks onboarding (warn-and-
// proceed). The wizard polls the task; a non-zero exit surfaces as task `error`
// and keeps the "Setup complete" screen gated behind a Retry.

import { bootstrap as graphifyBootstrap, ensureGraphifyTool } from '../graphify';
import { bootstrap as gitnexusBootstrap, ensureGitnexusTool } from '../gitnexus';
import { readEffectiveState } from '../../shared/state';
import { ensureOpenCodeTool } from '../toolchain/onboarding';

type Rec = Record<string, unknown>;

interface ToolOutcome {
  tool: string;
  ok: boolean;
  action: string;
  error: string | null;
  installedVersion?: string | null;
}

// Install the chosen graph provider and gate ONLY on "is it installed/usable".
// The first scan is best-effort and must NOT block onboarding: a brand-new
// project is empty at this point, so graphify/gitnexus legitimately find "no
// code files to index" (graphify even exits non-zero). The post-build hook
// rebuilds the graph once real code exists, so a deferred scan is not a failure.
function installGraphProvider(cwd: string, provider: 'graphify' | 'gitnexus'): ToolOutcome {
  const ensured = provider === 'graphify' ? ensureGraphifyTool(cwd) : ensureGitnexusTool(cwd);
  if (!ensured.ok) {
    return { tool: provider, ok: false, action: ensured.action, error: ensured.error, installedVersion: ensured.installedVersion ?? null };
  }
  const scan = provider === 'graphify' ? graphifyBootstrap(cwd, { force: false }) : gitnexusBootstrap(cwd, { force: false });
  const action = scan.ok
    ? scan.action
    : `${ensured.action}; scan deferred (${(scan.error || 'no code files yet').split('\n')[0]})`;
  return { tool: provider, ok: true, action, error: null, installedVersion: ensured.installedVersion ?? scan.installedVersion ?? null };
}

export interface OnboardingToolchainResult {
  ok: boolean;
  action: string;
  provider: string | null;
  openCodeEnabled: boolean;
  results: ToolOutcome[];
}

export function ensureOnboardingToolchain(cwd: string = process.cwd()): OnboardingToolchainResult {
  const state = readEffectiveState(cwd);
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const openCodeEnabled = openCode?.enabled === true;

  const results: ToolOutcome[] = [];

  // Required: the chosen code-graph provider must be INSTALLED (the first scan
  // is best-effort — see installGraphProvider).
  let graphFailed = false;
  if (provider === 'graphify' || provider === 'gitnexus') {
    const r = installGraphProvider(cwd, provider);
    graphFailed = !r.ok;
    results.push(r);
  }

  // Optional: OpenCode (warn-and-proceed — never gates completion).
  if (openCodeEnabled) {
    const r = ensureOpenCodeTool(cwd);
    results.push({ tool: 'opencode', ok: r.ok, action: r.action, error: r.error, installedVersion: r.installedVersion ?? null });
  }

  // Gate ONLY on the required graph provider. A missing provider (none chosen)
  // is not a failure — there is simply nothing required to install.
  const ok = !graphFailed;
  return { ok, action: 'onboarding-toolchain', provider, openCodeEnabled, results };
}

// CLI entry. Returns the process exit code (the shim + the wizard task runner
// map non-zero → task `error` → blocked "Setup complete" screen). The failing
// provider's detail is echoed to stderr so the task surfaces it to the user.
export function main(): number {
  const result = ensureOnboardingToolchain(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    const failed = result.results.find((r) => r.tool === result.provider && !r.ok);
    process.stderr.write(`${result.provider} install failed: ${failed?.error || 'unknown error'}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  const code = main();
  if (typeof code === 'number') process.exitCode = code;
}
