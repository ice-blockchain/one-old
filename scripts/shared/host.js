"use strict";
// src/shared/host.ts
// Decide which host wire shape we're speaking. Claude and Codex share the nested
// hookSpecificOutput shape (and the raw→canonical tool mapping handles both tool
// vocabularies), so they use the same adapter; Cursor is the flat-JSON outlier
// and announces itself via `--host=cursor` from its own entry script.
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectHost = detectHost;
function detectHost(env = process.env, argv = process.argv) {
    if (argv.includes('--host=cursor') || env.CURSOR_PLUGIN_ROOT)
        return 'cursor';
    // Codex marks the hook subprocess at runtime. CODEX_PLUGIN_ROOT covers the CLI;
    // Codex Desktop instead sets CODEX_INTERNAL_ORIGINATOR_OVERRIDE (observed on every
    // Desktop hook invocation); CODEX_THREAD_ID is present on subagent threads. These
    // are process-scoped (not profile exports), so they don't misfire for Claude Code.
    // Getting this right matters: it selects the Codex model tier (gpt-5.x) for the
    // agent-model gate — host=claude here would wrongly demand opus/sonnet on Codex.
    if (env.CODEX_PLUGIN_ROOT || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || env.CODEX_THREAD_ID)
        return 'codex';
    return 'claude';
}
