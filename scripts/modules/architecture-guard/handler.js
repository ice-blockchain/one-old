"use strict";
// src/modules/architecture-guard/handler.ts
// PreToolUse(shell) forbidden-library gate: deny `npm/pnpm/yarn/bun add <lib>`
// for libraries that conflict with the active stack. Ported from
// runCheckLibraryAllowlist in gates.cjs (the install-allowlist half; the deploy
// sub-gate needs the security-check fingerprint and lands with that runner).
// Auth is enforced by the priority-0 session gate before this runs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.libraryAllowlistGate = libraryAllowlistGate;
const result_1 = require("../../core/result");
const state_1 = require("../../shared/state");
const forbidden_1 = require("./forbidden");
function libraryAllowlistGate(ctx) {
    const command = ctx.input.tool?.command ?? '';
    if (!forbidden_1.INSTALL_RE.test(command))
        return (0, result_1.noop)();
    const state = (0, state_1.readEffectiveState)(ctx.cwd);
    const arg = state.stack ? state : null;
    const hits = (0, forbidden_1.forbiddenForStack)(arg, (0, forbidden_1.allowsNextjs)(state, ctx.cwd)).filter(([pattern]) => new RegExp(pattern).test(command));
    if (hits.length === 0)
        return (0, result_1.noop)();
    const lines = hits.map(([pattern, tip]) => `  - ${pattern}: ${tip}`).join('\n');
    return (0, result_1.deny)(`Forbidden library:\n${lines}\n\nSee rules/core.md and the active stack core for the approved stack.`);
}
