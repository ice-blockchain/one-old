"use strict";
// src/modules/plan-guard/deploy-gate.ts
// PreToolUse(shell) deploy gate: a production publish is denied unless a fresh
// senior-shipper approval stamp AND a fresh, fingerprint-matching pre-deployment
// security check are present. Ported 1:1 from the deploy half of
// runCheckLibraryAllowlist in scripts/hook-runtime/handlers/gates.cjs (deferred
// in the original port until the security-check runner existed — it now does).
// Shares the check-library-allowlist subcommand; priority 25 runs it after auth
// (0) and before the install-allowlist (30), matching the legacy ordering.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPLOY_RE = void 0;
exports.checkSecurityDeployStamp = checkSecurityDeployStamp;
exports.deployGate = deployGate;
const result_1 = require("../../core/result");
const security_check_1 = require("../../runners/security-check");
const state_1 = require("../../shared/state");
const auth_choice_1 = require("../session/auth-choice");
exports.DEPLOY_RE = /(^|[\s;&|])(vercel\s+(deploy|--prod)|eas\s+build\s+.*--auto-submit|eas\s+submit|supabase\s+db\s+push\s+--linked|supabase\s+functions\s+deploy\s+\S+\s+--linked|gh\s+release\s+create|fly\s+deploy|wrangler\s+deploy|npm\s+publish|pnpm\s+publish)\b/;
const SHIPPER_APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_CHECK_WINDOW_MS = 10 * 60 * 1000;
// The literal plugin-root expansion for the remediation command (single-quoted
// so the ${...} stays verbatim, exactly as the legacy reason text).
const SECURITY_RUN_CMD = 'node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/security-check-runner.cjs" --strict --stamp';
function checkSecurityDeployStamp(state, cwd) {
    const status = state.lastSecurityCheckStatus;
    const checkedAt = typeof state.lastSecurityCheckAt === 'string' ? Date.parse(state.lastSecurityCheckAt) : 0;
    const fresh = checkedAt > 0 && (Date.now() - checkedAt) < SECURITY_CHECK_WINDOW_MS;
    if (status !== 'passed' || !fresh) {
        return {
            ok: false,
            reason: 'Deploy gate: the Traffic One pre-deployment security check has not passed in the last 10 minutes. Run '
                + `\`${SECURITY_RUN_CMD}\` `
                + 'from the project root, address any findings, then deploy through `senior-shipper`.',
        };
    }
    let current;
    try {
        current = (0, security_check_1.computeProjectFingerprint)(cwd).fingerprint;
    }
    catch (error) {
        return { ok: false, reason: `Deploy gate: could not compute the current security fingerprint: ${error.message}` };
    }
    if (state.lastSecurityCheckFingerprint !== current) {
        return {
            ok: false,
            reason: 'Deploy gate: the worktree changed after the last passing security check. Rerun '
                + `\`${SECURITY_RUN_CMD}\` `
                + 'so the security fingerprint matches the code being deployed.',
        };
    }
    return { ok: true };
}
function deployGate(ctx) {
    if ((0, auth_choice_1.authChoiceAllowsContinue)(ctx.cwd))
        return (0, result_1.noop)();
    const command = ctx.input.tool?.command ?? '';
    if (!exports.DEPLOY_RE.test(command))
        return (0, result_1.noop)();
    const state = (0, state_1.readEffectiveState)(ctx.cwd);
    const approvedAt = typeof state.lastShipperApprovalAt === 'string' ? Date.parse(state.lastShipperApprovalAt) : 0;
    const fresh = approvedAt > 0 && (Date.now() - approvedAt) < SHIPPER_APPROVAL_WINDOW_MS;
    if (!fresh) {
        return (0, result_1.deny)('Deploy gate: this command publishes to production. Run '
            + 'the `senior-shipper` subagent first; it stamps `lastShipperApprovalAt` '
            + 'in .traffic-one/.one.json after pre-flight (reviewer APPROVED, tests green, '
            + 'user confirmed). The stamp grants a 10-minute deploy window.');
    }
    const securityCheck = checkSecurityDeployStamp(state, ctx.cwd);
    if (!securityCheck.ok)
        return (0, result_1.deny)(securityCheck.reason ?? 'Deploy gate: security check failed.');
    return (0, result_1.noop)();
}
