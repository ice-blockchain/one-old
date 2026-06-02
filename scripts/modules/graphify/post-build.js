"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.__setCodeGraphBootstraps = __setCodeGraphBootstraps;
exports.__resetCodeGraphBootstraps = __resetCodeGraphBootstraps;
exports.postBuildCodeGraphHint = postBuildCodeGraphHint;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const result_1 = require("../../core/result");
const gitnexus_1 = require("../../runners/gitnexus");
const graphify_1 = require("../../runners/graphify");
const auth_1 = require("../../shared/auth");
const state_1 = require("../../shared/state");
const text_1 = require("../../shared/text");
const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;
const GRAPHIFY_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const GRAPHIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let gitnexusBootstrap = gitnexus_1.bootstrap;
let graphifyBootstrap = graphify_1.bootstrap;
// Test seam: override the foreground bootstraps so unit tests never spawn.
function __setCodeGraphBootstraps(overrides) {
    if (overrides.gitnexus)
        gitnexusBootstrap = overrides.gitnexus;
    if (overrides.graphify)
        graphifyBootstrap = overrides.graphify;
}
function __resetCodeGraphBootstraps() {
    gitnexusBootstrap = gitnexus_1.bootstrap;
    graphifyBootstrap = graphify_1.bootstrap;
}
function postBuildCodeGraphHint(ctx) {
    if (!(0, auth_1.isAuthenticatedLocal)())
        return (0, result_1.noop)();
    const command = ctx.input.tool?.command ?? '';
    if (!BUILD_COMMAND_RE.test(command))
        return (0, result_1.noop)();
    const cwd = ctx.cwd;
    const state = (0, state_1.readEffectiveState)(cwd);
    if (state.mode !== 'new-project' || state.onboardingComplete !== true)
        return (0, result_1.noop)();
    // Dispatch by codeGraphProvider. Without a provider, the post-write
    // incomplete-onboarding warning already nags; this hook stays silent rather
    // than picking a default.
    const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
    if (provider !== 'gitnexus' && provider !== 'graphify')
        return (0, result_1.noop)();
    // Provider-specific artefact path for freshness check.
    const artefactPath = provider === 'gitnexus'
        ? path.join(cwd, '.gitnexus')
        : path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
    const artefactExists = fs.existsSync(artefactPath);
    const artefactFresh = artefactExists
        ? (Date.now() - fs.statSync(artefactPath).mtimeMs) < GRAPHIFY_FRESH_MS
        : false;
    if (artefactFresh)
        return (0, result_1.noop)();
    const lastHinted = typeof state.graphifyLastHintedAt === 'string'
        ? Date.parse(state.graphifyLastHintedAt)
        : 0;
    if (lastHinted > 0 && (Date.now() - lastHinted) < GRAPHIFY_COOLDOWN_MS)
        return (0, result_1.noop)();
    // Stamp the cooldown immediately so a flurry of builds doesn't re-enter the
    // bootstrap (which can take ~30–60s). The runner itself stamps
    // `<provider>LastRunAt` / `<provider>LastErrorAt` separately. graphifyLastHintedAt
    // is a local-pref field, so it goes to per-user preferences (not .one.json).
    try {
        (0, state_1.mergeProjectPrefs)(cwd, { graphifyLastHintedAt: (0, text_1.nowIso)() });
    }
    catch {
        // best-effort; the bootstrap still runs even if the stamp can't persist
    }
    // Run the foreground bootstrap. Never throws; returns a structured result.
    let result;
    try {
        result = provider === 'gitnexus' ? gitnexusBootstrap(cwd) : graphifyBootstrap(cwd);
    }
    catch (err) {
        result = {
            ok: false,
            action: 'install-skipped',
            report: null,
            error: `${provider} runner crashed: ${(err && err.message) || String(err)}`,
            durationMs: 0,
        };
    }
    const additionalContext = buildHintMessage(provider, result);
    return (0, result_1.context)(additionalContext);
}
function buildHintMessage(provider, result) {
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
            : (result.action === 'used-managed'
                ? 'used Traffic One managed `graphify` install'
                : (result.action === 'installed-pipx'
                    ? 'installed `graphifyy` via pipx'
                    : 'installed `graphifyy` in a Traffic One managed venv'));
        return `[graphify] Codebase graph built (${seconds}s, ${actionLabel}). `
            + 'Report at `graphify-out/GRAPH_REPORT.md`. Subagents and skills will consult it '
            + 'before grep/glob for module/structure questions. Add `graphify-out/` to .gitignore if not already.';
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
