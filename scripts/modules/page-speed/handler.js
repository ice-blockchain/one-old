"use strict";
// src/modules/page-speed/handler.ts
// PostToolUse(shell) advisory: after a production build on a web stack, remind
// the agent to run the Lighthouse mobile gate. Ported 1:1 from
// runPostBuildPageSpeed in scripts/hook-runtime/handlers/post.cjs — including
// the opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.postBuildPageSpeed = postBuildPageSpeed;
const result_1 = require("../../core/result");
const auth_1 = require("../../shared/auth");
const state_1 = require("../../shared/state");
const token_logger_1 = require("../../shared/token-logger");
const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;
function postBuildPageSpeed(ctx) {
    if (!(0, auth_1.isAuthenticatedLocal)())
        return (0, result_1.noop)();
    (0, token_logger_1.logToolUse)(ctx.cwd, ctx.input.raw && typeof ctx.input.raw === 'object' ? ctx.input.raw : null);
    const command = ctx.input.tool?.command ?? '';
    if (!BUILD_COMMAND_RE.test(command))
        return (0, result_1.noop)();
    if (!(0, state_1.isWebState)((0, state_1.readEffectiveState)(ctx.cwd)))
        return (0, result_1.noop)();
    return (0, result_1.context)([
        '[traffic-one] A production build just ran for a web stack.',
        'Before final delivery for generated/changed React or Ionic routes, run the Lighthouse mobile gate:',
        '',
        '  node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/lighthouse-runner.mjs" --route /',
        '',
        'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. If the environment blocks Lighthouse, explicitly report page speed as unverified with concrete risks.',
    ].join('\n'), { systemMessage: 'traffic-one page-speed gate pending after build' });
}
