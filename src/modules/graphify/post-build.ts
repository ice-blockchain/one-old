// src/modules/graphify/post-build.ts
// PostToolUse(shell) code-graph bootstrap. After a production build on a fresh
// `mode: new-project` scaffold, run the foreground gitnexus/graphify bootstrap
// (by provider) so the project ends up with its codebase graph without the
// agent or user having to remember. Non-blocking (context only), auth-gated,
// cooldown-throttled. Ported 1:1 from runPostBuildGraphifyHint in
// scripts/hook-runtime/handlers/post.cjs.
//
// The bootstraps are injectable so tests exercise the message/cooldown logic
// without spawning gitnexus/graphify.

import * as fs from 'fs';
import * as path from 'path';

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { GITNEXUS_REL, GRAPHIFY_REPORT_REL, codeGraphIndexIsStale } from '../../shared/codegraph';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { bootstrap as gitnexusBootstrapImpl, gitnexusGraphIsEmpty } from '../../runners/gitnexus';
import { bootstrap as graphifyBootstrapImpl, graphifyGraphIsEmpty } from '../../runners/graphify';
import { authSatisfied } from '../../shared/auth';
import { isNewProjectMode, mergeProjectPrefs, readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { nowIso } from '../../shared/text';

const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;
const GRAPHIFY_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const GRAPHIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface CodeGraphResult {
  ok: boolean;
  action: string;
  error?: string | null;
  durationMs?: number;
  restored?: string[];
}

type BootstrapFn = (cwd: string) => CodeGraphResult;

let gitnexusBootstrap: BootstrapFn = gitnexusBootstrapImpl;
let graphifyBootstrap: BootstrapFn = graphifyBootstrapImpl;

// Test seam: override the foreground bootstraps so unit tests never spawn.
export function __setCodeGraphBootstraps(overrides: { gitnexus?: BootstrapFn; graphify?: BootstrapFn }): void {
  if (overrides.gitnexus) gitnexusBootstrap = overrides.gitnexus;
  if (overrides.graphify) graphifyBootstrap = overrides.graphify;
}

export function __resetCodeGraphBootstraps(): void {
  gitnexusBootstrap = gitnexusBootstrapImpl;
  graphifyBootstrap = graphifyBootstrapImpl;
}

export function postBuildCodeGraphHint(ctx: Ctx): HookResult {
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (isNonProjectRoot(cwd) || pluginUseDeclined(cwd)) return noop();
  if (!authSatisfied()) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!BUILD_COMMAND_RE.test(command)) return noop();

  const state = readEffectiveState(cwd);
  if (!isNewProjectMode(state) || state.onboardingComplete !== true) return noop();

  // Dispatch by codeGraphProvider. Without a provider, the post-write
  // incomplete-onboarding warning already nags; this hook stays silent rather
  // than picking a default.
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  if (provider !== 'gitnexus' && provider !== 'graphify') return noop();

  // Provider-specific artefact path for freshness check.
  const artefactPath = provider === 'gitnexus'
    ? path.join(cwd, GITNEXUS_REL)
    : path.join(cwd, GRAPHIFY_REPORT_REL);
  const artefactExists = fs.existsSync(artefactPath);
  let artefactMtime = 0;
  if (artefactExists) {
    try { artefactMtime = fs.statSync(artefactPath).mtimeMs; } catch { artefactMtime = 0; }
  }
  // An existing-but-empty index (built pre-scaffold) is NOT fresh: its mtime is
  // recent but it predates the real code, so force a rebuild to pick the code up.
  // BOTH providers need this — gitnexus records stats.files:0, and graphify (the
  // earlier belief that it "produces no report on an empty project" was wrong)
  // leaves a frozen 0-node graph.json + report from the onboarding scan.
  const artefactEmpty = provider === 'gitnexus'
    ? gitnexusGraphIsEmpty(cwd)
    : graphifyGraphIsEmpty(cwd);
  // A build just landed code: if any source is newer than a non-empty index, the
  // graph is stale and must rebuild too (not only when empty). This is the build
  // hook's whole point — refresh the graph against the code that was just built.
  const artefactStale = artefactExists && codeGraphIndexIsStale(cwd, artefactMtime);
  const artefactFresh = artefactExists && !artefactEmpty && !artefactStale
    ? (Date.now() - artefactMtime) < GRAPHIFY_FRESH_MS
    : false;
  if (artefactFresh) return noop();

  const lastHinted = typeof state.graphifyLastHintedAt === 'string'
    ? Date.parse(state.graphifyLastHintedAt)
    : 0;
  if (!artefactEmpty && !artefactStale && lastHinted > 0 && (Date.now() - lastHinted) < GRAPHIFY_COOLDOWN_MS) return noop();

  // Stamp the cooldown immediately so a flurry of builds doesn't re-enter the
  // bootstrap (which can take ~30–60s). The runner itself stamps
  // `<provider>LastRunAt` / `<provider>LastErrorAt` separately. graphifyLastHintedAt
  // is a local-pref field, so it goes to per-user preferences (not .one.json).
  try {
    mergeProjectPrefs(cwd, { graphifyLastHintedAt: nowIso() });
  } catch {
    // best-effort; the bootstrap still runs even if the stamp can't persist
  }

  // Run the foreground bootstrap. Never throws; returns a structured result.
  let result: CodeGraphResult;
  try {
    result = provider === 'gitnexus' ? gitnexusBootstrap(cwd) : graphifyBootstrap(cwd);
  } catch (err) {
    result = {
      ok: false,
      action: 'install-skipped',
      report: null,
      error: `${provider} runner crashed: ${(err && (err as Error).message) || String(err)}`,
      durationMs: 0,
    } as CodeGraphResult;
  }

  const additionalContext = buildHintMessage(provider, result);
  return context(additionalContext);
}

function buildHintMessage(provider: 'gitnexus' | 'graphify', result: CodeGraphResult): string {
  const seconds = Math.round((result.durationMs || 0) / 100) / 10;
  if (result.ok) {
    if (provider === 'gitnexus') {
      const restored = Array.isArray(result.restored) && result.restored.length > 0
        ? ` Restored traffic-one's ${result.restored.join(', ')} (GitNexus auto-write conflicted).`
        : '';
      return `[gitnexus] Codebase graph built (${seconds}s, ${result.action}). `
        + `Index at \`.traffic-one/.gitnexus/\` (under .traffic-one, already gitignored). License reminder: PolyForm Noncommercial — only legal on non-commercial projects.${restored} `
        + 'Subagents and skills will consult `.traffic-one/.gitnexus/` before grep/glob for module/structure questions.';
    }
    const actionLabel = result.action === 'used-existing'
      ? 'used existing `graphify` install'
      : (result.action === 'used-managed'
        ? 'used Traffic One managed `graphify` install'
        : 'installed `graphifyy` in a Traffic One managed venv');
    return `[graphify] Codebase graph built (${seconds}s, ${actionLabel}). `
      + 'Report at `.traffic-one/graphify-out/GRAPH_REPORT.md` (under .traffic-one, already gitignored). '
      + 'Subagents and skills will consult it before grep/glob for module/structure questions.';
  }

  if (provider === 'gitnexus') {
    // Most actionable branch first: nvm is installed but no v22 yet.
    if (result.action === 'nvm-install-needed') {
      return '[gitnexus] Auto-bootstrap blocked — Node 22 not installed yet.\n'
        + `${result.error}\n`
        + 'The hook will retry the managed install on the next onboarding or build event. '
        + 'No user-run install command is required.';
    }
    if (result.action === 'node-version-mismatch') {
      return '[gitnexus] Auto-bootstrap blocked — Node version too old + nvm not present.\n'
        + `${result.error}\n`
        + 'Traffic One could not prepare a Node 22 GitNexus toolchain automatically. '
        + 'Pick `codeGraphProvider: "graphify"` if you want a Python-based graph provider.';
    }
    return `[gitnexus] Auto-bootstrap failed (${seconds}s): ${result.error || 'unknown error'}. `
      + 'The hook attempted a managed install/upgrade and will retry on the next build. '
      + 'License: PolyForm Noncommercial. Disable auto-bootstrap with `"codeGraphAutoRun": false` in local Traffic One preferences.';
  }

  return `[graphify] Auto-bootstrap failed (${seconds}s): ${result.error || 'unknown error'}. `
    + 'The hook attempted a managed install/upgrade and will retry on the next build. '
    + 'To disable auto-bootstrap entirely, set `"codeGraphAutoRun": false` in local Traffic One preferences.';
}
