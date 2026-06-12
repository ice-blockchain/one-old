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
import { ensureCodexMcpServerRegistered } from '../../shared/codex-mcp';
import { reconcileManagedToolStamp } from '../toolchain';
import { ensureOpenCodeTool } from '../toolchain/onboarding';

type Rec = Record<string, unknown>;

interface ToolOutcome {
  tool: string;
  ok: boolean;
  action: string;
  error: string | null;
  installedVersion?: string | null;
}

// Install the chosen graph provider, then run the first scan.
//   - NEW/empty project: the scan is best-effort. The project is empty at this
//     point, so graphify/gitnexus legitimately find "no code files to index"
//     (graphify even exits non-zero); the post-build hook rebuilds it later, so a
//     deferred scan is NOT a failure → gate only on "installed/usable".
//   - EXISTING codebase (`requireScan`): the repo already has code AND there is
//     no later reliable trigger (the post-build hook needs a `build` command,
//     Phase 5 only fires on full orchestrator runs). So the first scan MUST
//     produce a graph before "Setup complete" — a failed scan gates completion.
function installGraphProvider(cwd: string, provider: 'graphify' | 'gitnexus', requireScan: boolean): ToolOutcome {
  const ensured = provider === 'graphify' ? ensureGraphifyTool(cwd) : ensureGitnexusTool(cwd);
  if (!ensured.ok) {
    return { tool: provider, ok: false, action: ensured.action, error: ensured.error, installedVersion: ensured.installedVersion ?? null };
  }
  const scan = provider === 'graphify' ? graphifyBootstrap(cwd, { force: false }) : gitnexusBootstrap(cwd, { force: false });
  if (!scan.ok && requireScan) {
    return {
      tool: provider,
      ok: false,
      action: `${ensured.action}; scan failed`,
      error: scan.error || 'graph scan produced no report on an existing codebase',
      installedVersion: ensured.installedVersion ?? null,
    };
  }
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
  const mode = typeof state.mode === 'string' ? state.mode : '';
  // Existing codebases have code to index now and no later reliable trigger, so
  // the first scan is REQUIRED before "Setup complete"; new/empty projects defer.
  const requireScan = mode === 'existing-codebase' || mode === 'existing-with-supabase';
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const openCodeEnabled = openCode?.enabled === true;

  const results: ToolOutcome[] = [];

  // OpenCode setup runs FIRST — BEFORE the required graph provider. The graph
  // install+scan on a real repo is slow and can throw or get the runner killed
  // before the OpenCode branch is reached (observed: graphify stamps, then neither
  // the opencode stamp NOR the Codex MCP registration ever run). These two steps
  // are cheap, spawn-free, and graph-independent, so do them up front where they
  // can't be skipped:
  //   1. stamp the present managed opencode bin (no `opencode --version` probe —
  //      that probe/5-min warm-up is exactly what was failing to persist), and
  //   2. on Codex, register the opencode-worker MCP server in ~/.codex/config.toml
  //      (Codex ignores the plugin's bundled .mcp.json; this runner is unsandboxed
  //      so it can write the user's Codex config). No-op on Claude/Cursor.
  if (openCodeEnabled) {
    reconcileManagedToolStamp(cwd, 'opencode');
    const reg = ensureCodexMcpServerRegistered();
    if (reg !== 'skipped-not-codex') {
      results.push({
        tool: 'opencode-mcp',
        ok: reg !== 'failed',
        action: `codex-register:${reg}`,
        error: reg === 'failed' ? 'could not write ~/.codex/config.toml' : null,
        installedVersion: null,
      });
    }
  }

  // Required: the chosen code-graph provider must be INSTALLED, plus the first
  // scan must succeed on an existing codebase (see installGraphProvider). Guard
  // against a throw so a scan failure can't take down the optional OpenCode
  // install below (or the setup above) — it degrades to a gated completion.
  let graphFailed = false;
  if (provider === 'graphify' || provider === 'gitnexus') {
    try {
      const r = installGraphProvider(cwd, provider, requireScan);
      graphFailed = !r.ok;
      results.push(r);
    } catch (e) {
      graphFailed = true;
      results.push({ tool: provider, ok: false, action: 'install-threw', error: (e as Error)?.message || 'graph provider threw', installedVersion: null });
    }
  }

  // Optional: install OpenCode when the managed bin is ABSENT (warn-and-proceed —
  // never gates completion). Runs LAST because its `--version` probe + first-run
  // warm-up can be slow; the stamp above already recorded a present bin.
  if (openCodeEnabled) {
    const r = ensureOpenCodeTool(cwd);
    results.push({ tool: 'opencode', ok: r.ok, action: r.action, error: r.error, installedVersion: r.installedVersion ?? null });
  }

  // Gate ONLY on the required graph provider. A missing provider (none chosen)
  // is not a failure — there is simply nothing required to install.
  const ok = !graphFailed;
  return { ok, action: 'onboarding-toolchain', provider, openCodeEnabled, results };
}

// Targeted OpenCode-only pass: the SessionStart self-heal spawns this (detached,
// `--opencode-only`) when `openCode.enabled` but the CLI is missing — e.g. npm
// was unavailable during onboarding, so the warn-and-proceed install never
// landed. Skips the graph provider entirely (it has its own self-heal with its
// own cooldown); runs the same stamp + Codex registration + managed install the
// full onboarding pass would. Best-effort: always exits 0.
export function ensureOpenCodeOnly(cwd: string = process.cwd()): OnboardingToolchainResult {
  const state = readEffectiveState(cwd);
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const openCodeEnabled = openCode?.enabled === true;
  const results: ToolOutcome[] = [];
  if (openCodeEnabled) {
    reconcileManagedToolStamp(cwd, 'opencode');
    const reg = ensureCodexMcpServerRegistered();
    if (reg !== 'skipped-not-codex') {
      results.push({
        tool: 'opencode-mcp',
        ok: reg !== 'failed',
        action: `codex-register:${reg}`,
        error: reg === 'failed' ? 'could not write ~/.codex/config.toml' : null,
        installedVersion: null,
      });
    }
    const r = ensureOpenCodeTool(cwd);
    results.push({ tool: 'opencode', ok: r.ok, action: r.action, error: r.error, installedVersion: r.installedVersion ?? null });
  }
  return { ok: true, action: 'opencode-only', provider: null, openCodeEnabled, results };
}

// CLI entry. Returns the process exit code (the shim + the wizard task runner
// map non-zero → task `error` → blocked "Setup complete" screen). The failing
// provider's detail is echoed to stderr so the task surfaces it to the user.
export function main(): number {
  if (process.argv.includes('--opencode-only')) {
    const result = ensureOpenCodeOnly(process.cwd());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0; // self-heal is best-effort; never surfaces as a task error
  }
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
