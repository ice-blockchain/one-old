// src/runners/onboarding-toolchain/index.ts
// Consolidated onboarding install task (compiles to scripts/onboarding-toolchain-runner.cjs).
// Spawned by the onboarding wizard at the `finalize` step. It reads the committed
// state and installs the dependencies the user actually chose:
//   - the code-graph provider (gitnexus/graphify) — install + first scan, WARN-AND-PROCEED;
//   - the OpenCode CLI when `openCode.enabled` — install only, OPTIONAL.
//
// The code-graph provider is a TOKEN OPTIMIZATION (like OpenCode), NOT a hard
// requirement: a non-technical user must reach "Setup complete" even if the
// graph provider cannot be installed on their machine. So a provider problem
// NEVER gates onboarding. Instead it degrades gracefully:
//   1. if the chosen provider can't install, try the SIBLING (graphify↔gitnexus)
//      but ONLY when the sibling's language runtime is actually present (no point
//      installing graphify with no Python). A working sibling is persisted as the
//      new machine-wide provider so future sessions reuse it.
//   2. if neither provider can be installed, DEFER — record a deferred marker and
//      let the SessionStart self-heal (ensureCodeGraphForExistingProject) and the
//      post-build hook retry later. result.ok stays true.
// OpenCode failure is likewise reported in the JSON summary but never blocks.
// The wizard polls the task; result.ok===true → exit 0 → no Retry wall.

import { bootstrap as graphifyBootstrap, ensureGraphifyTool } from '../graphify';
import { bootstrap as gitnexusBootstrap, ensureGitnexusTool } from '../gitnexus';
import { readEffectiveState, writeGlobalCodeGraphProvider, mergeProjectPrefs, stateTimestamp } from '../../shared/state';
import { ensureCodexMcpServerRegistered } from '../../shared/codex-mcp';
import { reconcileManagedToolStamp, toolRuntime } from '../toolchain';
import { ensureOpenCodeTool } from '../toolchain/onboarding';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { resolvePython, resolveNode } from '../../shared/runtime-resolve';
import { managedRuntimeAvailable } from '../../shared/managed-runtime';
import { detectHost } from '../../shared/host';

type GraphProvider = 'graphify' | 'gitnexus';

// The other provider — falling back graphify↔gitnexus.
function siblingProvider(provider: GraphProvider): GraphProvider {
  return provider === 'graphify' ? 'gitnexus' : 'graphify';
}

// Is the language runtime a provider needs actually present on this machine?
// Read the declared runtime (toolchain-versions.json) and probe for a satisfying
// interpreter via the GUI-PATH-proof resolver. `none` → always available (no
// runtime to find). Used to decide whether a sibling fallback is even worth
// attempting — installing graphify with no Python (or gitnexus with no Node 22)
// would just fail again.
function providerRuntimeAvailable(provider: GraphProvider): boolean {
  const { runtime, minMajor, minMinor } = toolRuntime(provider);
  // A resolvable interpreter OR a managed standalone runtime we can download
  // makes the sibling worth attempting (its install fetches the managed runtime).
  if (runtime === 'python') return Boolean(resolvePython(minMajor, minMinor)) || managedRuntimeAvailable('python');
  if (runtime === 'node') return Boolean(resolveNode(minMajor)) || managedRuntimeAvailable('node');
  return true;
}

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
//   - EXISTING codebase (`requireScan`): the repo already has code, so we WANT the
//     first scan now. But the graph is a token optimization, never a blocker — a
//     failed scan is a SOFT note ('scan deferred'), not a hard gate. The
//     SessionStart self-heal + post-build hook retry it later. `ok` stays true
//     whenever the tool itself installed.
function installGraphProvider(cwd: string, provider: GraphProvider, requireScan: boolean): ToolOutcome {
  const ensured = provider === 'graphify' ? ensureGraphifyTool(cwd) : ensureGitnexusTool(cwd);
  if (!ensured.ok) {
    return { tool: provider, ok: false, action: ensured.action, error: ensured.error, installedVersion: ensured.installedVersion ?? null };
  }
  const scan = provider === 'graphify' ? graphifyBootstrap(cwd, { force: false }) : gitnexusBootstrap(cwd, { force: false });
  // The tool installed. Whether or not the first scan produced a report, do not
  // gate completion on it — note a deferred scan and proceed. On an existing
  // codebase the deferral is called out so doctor/self-heal can prioritize it.
  let action: string;
  if (scan.ok) {
    action = scan.action;
  } else {
    const reason = (scan.error || 'no code files yet').split('\n')[0];
    action = requireScan
      ? `${ensured.action}; scan deferred on existing codebase (${reason})`
      : `${ensured.action}; scan deferred (${reason})`;
  }
  return { tool: provider, ok: true, action, error: null, installedVersion: ensured.installedVersion ?? scan.installedVersion ?? null };
}

export interface OnboardingToolchainResult {
  ok: boolean;
  action: string;
  provider: string | null;
  openCodeEnabled: boolean;
  results: ToolOutcome[];
}

// Best-effort state writes: a failed prefs / one.json write (read-only
// .traffic-one/, EACCES/EROFS, path-type clash) must NEVER throw out of this
// runner and gate onboarding — mirrors the graph runners' writeStateMerge guard.
function safePrefs(cwd: string, patch: Rec): void {
  try { mergeProjectPrefs(cwd, patch); } catch { /* best-effort; never blocks onboarding */ }
}
function safeWriteProvider(provider: GraphProvider): void {
  try { writeGlobalCodeGraphProvider(provider); } catch { /* best-effort; never blocks onboarding */ }
}

export function ensureOnboardingToolchain(cwd: string = process.cwd()): OnboardingToolchainResult {
  const state = readEffectiveState(cwd);
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const mode = typeof state.mode === 'string' ? state.mode : '';
  // Existing codebases have code to index now and no later reliable trigger, so
  // the first scan is REQUIRED before "Setup complete"; new/empty projects defer.
  const requireScan = mode === 'existing-codebase' || mode === 'existing-with-supabase';
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const host = detectHost();
  const openCodeEnabled = host !== 'opencode' && host !== 'kilo' && openCode?.enabled === true;

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

  // Code-graph provider — WARN-AND-PROCEED, never gates onboarding. Try the
  // chosen provider; if it can't install, try the SIBLING (graphify↔gitnexus)
  // but ONLY when the sibling's runtime is actually present; if neither can be
  // installed, DEFER (the self-heal + post-build hook retry later). A throw is
  // caught and likewise degrades to a deferral. result.ok is NEVER flipped by a
  // provider install/runtime problem.
  if (provider === 'graphify' || provider === 'gitnexus') {
    const chosen = provider as GraphProvider;
    try {
      let r = installGraphProvider(cwd, chosen, requireScan);
      if (!r.ok) {
        // The chosen provider failed. Try the sibling only when its language
        // runtime is present — otherwise installing it would just fail again.
        const sibling = siblingProvider(chosen);
        if (providerRuntimeAvailable(sibling)) {
          const fb = installGraphProvider(cwd, sibling, requireScan);
          if (fb.ok) {
            // Persist the switch so every future session reuses the working
            // provider (mirrors seed-provider's writeGlobalCodeGraphProvider).
            safeWriteProvider(sibling);
            r = { ...fb, action: `fell-back-to-${sibling} (${chosen} unavailable); ${fb.action}` };
          }
        }
      }
      if (!r.ok) {
        // Neither provider could be installed. Defer instead of failing: record a
        // marker doctor can surface; the self-heal retries later. ok stays true.
        safePrefs(cwd, { graphDeferredAt: stateTimestamp() });
        results.push({
          tool: chosen,
          ok: true,
          action: 'deferred',
          error: null,
          installedVersion: null,
        });
      } else {
        // Provider is installed/usable now — clear any prior deferral marker so
        // doctor doesn't surface a stale pending-graph after a later success.
        safePrefs(cwd, { graphDeferredAt: null });
        results.push(r);
      }
    } catch (e) {
      // A throw is not a blocker either — defer and proceed (best-effort write).
      safePrefs(cwd, { graphDeferredAt: stateTimestamp() });
      results.push({
        tool: chosen,
        ok: true,
        action: `deferred (install threw: ${(e as Error)?.message || 'graph provider threw'})`,
        error: null,
        installedVersion: null,
      });
    }
  }

  // Optional: install OpenCode when the managed bin is ABSENT (warn-and-proceed —
  // never gates completion). Runs LAST because its `--version` probe + first-run
  // warm-up can be slow; the stamp above already recorded a present bin.
  if (openCodeEnabled) {
    const r = ensureOpenCodeTool(cwd);
    results.push({ tool: 'opencode', ok: r.ok, action: r.action, error: r.error, installedVersion: r.installedVersion ?? null });
  }

  // Nothing here gates completion. The code-graph provider is a token
  // optimization that warns-and-proceeds (install failures fall back to the
  // sibling or defer), and OpenCode is an optional token-saver. So onboarding
  // always reaches "Setup complete"; provider/OpenCode problems are reported in
  // the results for doctor + the self-heal to act on later.
  return { ok: true, action: 'onboarding-toolchain', provider, openCodeEnabled, results };
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
  const host = detectHost();
  const openCodeEnabled = host !== 'opencode' && host !== 'kilo' && openCode?.enabled === true;
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

// CLI entry. Always exits 0 — the code-graph provider warns-and-proceeds (falls
// back to the sibling or defers) and OpenCode is optional, so nothing here gates
// the wizard's "Setup complete" screen. The JSON summary on stdout carries every
// per-tool outcome (deferred provider, OpenCode warning) for doctor + self-heal.
export function main(): number {
  try { ensureRunnerShims(); } catch { /* shim write is best-effort; never blocks */ }
  // Ultimate backstop: NOTHING here may produce a non-zero exit / Retry wall.
  // Even an unforeseen throw (e.g. an unwritable prefs path on a locked-down or
  // GUI-launched machine — exactly what this runner must tolerate) degrades to a
  // clean exit 0 with the error reported in the JSON summary.
  let result: OnboardingToolchainResult;
  try {
    result = process.argv.includes('--opencode-only')
      ? ensureOpenCodeOnly(process.cwd())
      : ensureOnboardingToolchain(process.cwd());
  } catch (e) {
    result = {
      ok: true,
      action: 'onboarding-toolchain',
      provider: null,
      openCodeEnabled: false,
      results: [{ tool: 'onboarding-toolchain', ok: true, action: 'errored-but-not-blocking', error: (e as Error)?.message || 'onboarding toolchain threw', installedVersion: null }],
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0; // never gates onboarding — provider/OpenCode problems are warn-and-proceed
}

if (require.main === module) {
  const code = main();
  if (typeof code === 'number') process.exitCode = code;
}
