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
import { bootstrap as gitnexusBootstrapImpl } from '../../runners/gitnexus';
import { bootstrap as graphifyBootstrapImpl } from '../../runners/graphify';
import { isAuthenticatedLocal } from '../../shared/auth';
import { mergeProjectPrefs, readEffectiveState } from '../../shared/state';
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
  if (!isAuthenticatedLocal()) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!BUILD_COMMAND_RE.test(command)) return noop();

  const cwd = ctx.cwd;
  const state = readEffectiveState(cwd);
  if (state.mode !== 'new-project' || state.onboardingComplete !== true) return noop();

  // Dispatch by codeGraphProvider. Without a provider, the post-write
  // incomplete-onboarding warning already nags; this hook stays silent rather
  // than picking a default.
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  if (provider !== 'gitnexus' && provider !== 'graphify') return noop();

  // Provider-specific artefact path for freshness check.
  const artefactPath = provider === 'gitnexus'
    ? path.join(cwd, '.gitnexus')
    : path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
  const artefactExists = fs.existsSync(artefactPath);
  const artefactFresh = artefactExists
    ? (Date.now() - fs.statSync(artefactPath).mtimeMs) < GRAPHIFY_FRESH_MS
    : false;
  if (artefactFresh) return noop();

  const lastHinted = typeof state.graphifyLastHintedAt === 'string'
    ? Date.parse(state.graphifyLastHintedAt)
    : 0;
  if (lastHinted > 0 && (Date.now() - lastHinted) < GRAPHIFY_COOLDOWN_MS) return noop();

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
        + `Index at \`.gitnexus/\`. License reminder: PolyForm Noncommercial — only legal on non-commercial projects.${restored} `
        + 'Subagents and skills will consult `.gitnexus/` before grep/glob for module/structure questions. '
        + 'Add `.gitnexus/` and `.traffic-one/backups/` to .gitignore if not already.';
    }
    const actionLabel = result.action === 'used-existing'
      ? 'used existing `graphify` install'
      : (result.action === 'installed-pipx'
        ? 'installed `graphifyy` via pipx'
        : 'installed `graphifyy` via `pip --user`');
    return `[graphify] Codebase graph built (${seconds}s, ${actionLabel}). `
      + 'Report at `graphify-out/GRAPH_REPORT.md`. Subagents and skills will consult it '
      + 'before grep/glob for module/structure questions. To auto-rebuild on each git commit: '
      + '`graphify hook install`. Add `graphify-out/` to .gitignore if not already.';
  }

  if (provider === 'gitnexus') {
    // Most actionable branch first: nvm is installed but no v22 yet.
    if (result.action === 'nvm-install-needed') {
      return '[gitnexus] Auto-bootstrap blocked — Node 22 not installed yet.\n'
        + `${result.error}\n`
        + 'AGENT: present the bash command above to the user, then run it via '
        + 'your Bash tool. The Bash permission prompt is the consent gate — '
        + 'do NOT install Node without it. After it succeeds, the runner will '
        + 'pick up the new Node 22 binary automatically (no Claude Code '
        + 'relaunch needed; the runner globs `~/.nvm/versions/node/v22.*` '
        + 'directly).';
    }
    if (result.action === 'node-version-mismatch') {
      return '[gitnexus] Auto-bootstrap blocked — Node version too old + nvm not present.\n'
        + `${result.error}\n`
        + 'Install nvm first (https://github.com/nvm-sh/nvm), then re-invoke '
        + 'the runner. Or pick `codeGraphProvider: "graphify"` (Python; works '
        + 'on any Node) by updating local Traffic One preferences.';
    }
    return `[gitnexus] Auto-bootstrap failed (${seconds}s): ${result.error || 'unknown error'}. `
      + 'Falling back to a manual hint — install + build once when convenient:\n'
      + '  npm install -g gitnexus   # or: npx gitnexus@latest analyze .\n'
      + '  gitnexus analyze\n'
      + 'License: PolyForm Noncommercial. Disable auto-bootstrap with `"codeGraphAutoRun": false` in local Traffic One preferences.';
  }

  return `[graphify] Auto-bootstrap failed (${seconds}s): ${result.error || 'unknown error'}. `
    + 'Falling back to a manual hint — install + build once when convenient:\n'
    + '  pipx install graphifyy   # or: python3 -m pip install --user graphifyy\n'
    + '  graphify update .\n'
    + '  graphify hook install    # optional: regenerate on every git commit\n'
    + 'To disable auto-bootstrap entirely, set `"codeGraphAutoRun": false` in local Traffic One preferences.';
}
