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

import * as fs from 'fs';

import { bootstrap as graphifyBootstrap, ensureGraphifyTool } from '../graphify';
import { bootstrap as gitnexusBootstrap, ensureGitnexusTool } from '../gitnexus';
import { isExistingProjectMode, readEffectiveState, writeGlobalCodeGraphProvider, mergeProjectPrefs, stateTimestamp } from '../../shared/state';
import { ensureCodexMcpServerRegistered } from '../../shared/codex-mcp';
import { reconcileManagedToolStamp, toolRuntime } from '../toolchain';
import { ensureOpenCodeTool } from '../toolchain/onboarding';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { resolvePython, resolveNode } from '../../shared/runtime-resolve';
import { managedRuntimeAvailable } from '../../shared/managed-runtime';
import { detectHost } from '../../shared/host';
import { hostFlags } from '../../shared/host/capability-flags';

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

// ── Install progress ─────────────────────────────────────────────────────────
// The wizard/dashboard polls /task/:id while this runner works; without
// intermediate signals a first-time install (managed runtime download, npm/pip
// install, first repo scan, OpenCode warm-up) looks stuck for minutes. The
// runner therefore emits full progress SNAPSHOTS as NDJSON lines on stdout —
// `{"t1Progress":{"steps":[…]}}` — which the task runner folds into the polled
// task state. Everything below main() is synchronous, so snapshots are written
// with fs.writeSync(1, …): Node's stdout is ASYNC on POSIX pipes and stream
// writes would not flush until the event loop turns (i.e. at exit). The final
// result JSON stays the LAST stdout line (actionFrom parses lines from the end).

export type ProgressStepStatus = 'pending' | 'running' | 'done' | 'warn';

export interface ProgressStep {
  id: string;
  label: string;
  status: ProgressStepStatus;
  /** Relative share of the overall bar (UIs divide by the sum — not a percent). */
  weight: number;
}

type ProgressSink = (steps: ProgressStep[]) => void;

// Snapshot-based so dynamically re-labeled steps (sibling fallback, deferrals)
// need no incremental-event bookkeeping on the consumer side.
class ProgressReporter {
  private steps: ProgressStep[] = [];
  constructor(private readonly sink?: ProgressSink) {}
  add(id: string, label: string, weight: number): void {
    this.steps.push({ id, label, status: 'pending', weight });
  }
  set(id: string, status: ProgressStepStatus, label?: string): void {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    step.status = status;
    if (label) step.label = label;
    this.emit();
  }
  emit(): void {
    if (!this.sink) return;
    try { this.sink(this.steps.map((s) => ({ ...s }))); } catch { /* progress is best-effort; never blocks the install */ }
  }
}

function providerLabel(provider: GraphProvider): string {
  return provider === 'gitnexus' ? 'GitNexus' : 'graphify';
}

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
function installGraphProvider(cwd: string, provider: GraphProvider, requireScan: boolean, onScanStart?: () => void): ToolOutcome {
  const ensured = provider === 'graphify' ? ensureGraphifyTool(cwd) : ensureGitnexusTool(cwd);
  if (!ensured.ok) {
    return { tool: provider, ok: false, action: ensured.action, error: ensured.error, installedVersion: ensured.installedVersion ?? null };
  }
  if (onScanStart) onScanStart();
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

interface OnboardingToolchainResult {
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

export function ensureOnboardingToolchain(cwd: string = process.cwd(), onProgress?: ProgressSink): OnboardingToolchainResult {
  const state = readEffectiveState(cwd);
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  // Existing codebases have code to index now and no later reliable trigger, so
  // the first scan is REQUIRED before "Setup complete"; new/empty projects defer.
  const requireScan = isExistingProjectMode(state);
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const host = detectHost();
  const openCodeEnabled = !hostFlags(host).opencodeSelfHosted && openCode?.enabled === true;

  const results: ToolOutcome[] = [];

  // The full step plan is known up front (weights are rough duration shares so
  // the bar does not leap from 5% to 70%); one initial snapshot lets the UI
  // render the whole checklist before the first slow step starts.
  const progress = new ProgressReporter(onProgress);
  const graphChosen: GraphProvider | null = provider === 'graphify' || provider === 'gitnexus' ? (provider as GraphProvider) : null;
  if (openCodeEnabled) progress.add('opencode-prepare', 'Preparing OpenCode', 5);
  if (graphChosen) {
    progress.add('graph-install', `Installing ${providerLabel(graphChosen)}`, 40);
    progress.add('graph-scan', 'Scanning your codebase', 30);
  }
  if (openCodeEnabled) progress.add('opencode-install', 'Installing the OpenCode CLI', 25);
  progress.emit();

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
    progress.set('opencode-prepare', 'running');
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
    progress.set('opencode-prepare', 'done');
  }

  // Code-graph provider — WARN-AND-PROCEED, never gates onboarding. Try the
  // chosen provider; if it can't install, try the SIBLING (graphify↔gitnexus)
  // but ONLY when the sibling's runtime is actually present; if neither can be
  // installed, DEFER (the self-heal + post-build hook retry later). A throw is
  // caught and likewise degrades to a deferral. result.ok is NEVER flipped by a
  // provider install/runtime problem.
  if (graphChosen) {
    const chosen = graphChosen;
    const onScanStart = (): void => {
      progress.set('graph-install', 'done');
      progress.set('graph-scan', 'running');
    };
    try {
      progress.set('graph-install', 'running');
      let r = installGraphProvider(cwd, chosen, requireScan, onScanStart);
      if (!r.ok) {
        // The chosen provider failed. Try the sibling only when its language
        // runtime is present — otherwise installing it would just fail again.
        const sibling = siblingProvider(chosen);
        if (providerRuntimeAvailable(sibling)) {
          progress.set('graph-install', 'running', `Trying ${providerLabel(sibling)} instead`);
          const fb = installGraphProvider(cwd, sibling, requireScan, onScanStart);
          if (fb.ok) {
            // Persist the working sibling so later sessions reuse it; this
            // does not skip the picker (routers key on this project's ack,
            // not the provider).
            safeWriteProvider(sibling);
            r = { ...fb, action: `fell-back-to-${sibling} (${chosen} unavailable); ${fb.action}` };
          }
        }
      }
      if (!r.ok) {
        // Neither provider could be installed. Defer instead of failing: record a
        // marker doctor can surface; the self-heal retries later. ok stays true.
        safePrefs(cwd, { graphDeferredAt: stateTimestamp() });
        progress.set('graph-install', 'warn', 'Code-graph deferred — Traffic One retries later');
        progress.set('graph-scan', 'warn', 'Scan deferred');
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
        progress.set('graph-install', 'done');
        progress.set('graph-scan', 'done');
        results.push(r);
      }
    } catch (e) {
      // A throw is not a blocker either — defer and proceed (best-effort write).
      safePrefs(cwd, { graphDeferredAt: stateTimestamp() });
      progress.set('graph-install', 'warn', 'Code-graph deferred — Traffic One retries later');
      progress.set('graph-scan', 'warn', 'Scan deferred');
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
    progress.set('opencode-install', 'running');
    const r = ensureOpenCodeTool(cwd);
    results.push({ tool: 'opencode', ok: r.ok, action: r.action, error: r.error, installedVersion: r.installedVersion ?? null });
    progress.set('opencode-install', r.ok ? 'done' : 'warn', r.ok ? undefined : 'OpenCode deferred — Traffic One retries later');
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
function ensureOpenCodeOnly(cwd: string = process.cwd()): OnboardingToolchainResult {
  const state = readEffectiveState(cwd);
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const host = detectHost();
  const openCodeEnabled = !hostFlags(host).opencodeSelfHosted && openCode?.enabled === true;
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
  // Progress snapshots go out as NDJSON via fs.writeSync so they reach the
  // wizard server's pipe DURING this fully synchronous run (stream writes to a
  // POSIX pipe only flush when the event loop turns — i.e. at exit, too late).
  // With the detached self-heal spawn (stdio 'ignore') fd 1 is /dev/null and the
  // writes are harmless; an EPIPE from a dead parent must never kill the install.
  const emitProgress: (steps: ProgressStep[]) => void = (steps) => {
    try { fs.writeSync(1, `${JSON.stringify({ t1Progress: { steps } })}\n`); } catch { /* best-effort */ }
  };
  let result: OnboardingToolchainResult;
  try {
    result = process.argv.includes('--opencode-only')
      ? ensureOpenCodeOnly(process.cwd())
      : ensureOnboardingToolchain(process.cwd(), emitProgress);
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
