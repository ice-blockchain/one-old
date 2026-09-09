// src/modules/plan-guard/deploy-gate.ts
// PreToolUse(shell) deploy gate: a production publish is denied unless a fresh
// senior-shipper approval stamp AND a fresh, fingerprint-matching pre-deployment
// security check are present. Ported 1:1 from the deploy half of
// runCheckLibraryAllowlist in scripts/hook-runtime/handlers/gates.cjs (deferred
// in the original port until the security-check runner existed — it now does).
// Shares the check-library-allowlist subcommand; priority 25 runs it after auth
// (0) and before the install-allowlist (30), matching the legacy ordering.

import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import type { DenyId } from '../../config/deny-ids';
import { computeProjectFingerprint } from '../../runners/security-check';
import { trustworthyAgeSince } from '../../shared/clock-skew';
import { readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { resolveToolScope, workspaceMemberRefusal } from '../../shared/tool-scope';

type Rec = Record<string, unknown>;

export const DEPLOY_RE = /(^|[\s;&|])(vercel\s+(deploy|--prod)|eas\s+build\s+.*--auto-submit|eas\s+submit|eas\s+update|supabase\s+db\s+push(?:\s+--linked)?|supabase\s+functions\s+deploy\s+\S+(?:\s+--linked)?|gh\s+release\s+create|fly\s+deploy|wrangler\s+deploy|netlify\s+deploy\s+.*--prod|firebase\s+deploy|npm\s+publish|pnpm\s+publish|yarn\s+publish|bun\s+publish)\b/;

const SHIPPER_APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_CHECK_WINDOW_MS = 10 * 60 * 1000;

// The literal plugin-root expansion for the remediation command (single-quoted
// so the ${...} stays verbatim, exactly as the legacy reason text).
const SECURITY_RUN_CMD = 'node ~/.traffic-one/bin/security-check-runner.cjs --strict --stamp';

// A failure REQUIRES both halves of its identity: every branch below already
// declared a reason and a denyId, but with them optional the call site had to
// carry a `??` arm for a state that cannot occur — and that arm needed its own
// catalog id (`deploy-gate-security-check-failed`) which nothing could ever
// record. The discriminated union removes the unreachable branch instead of
// documenting it.
type StampCheck =
  | { ok: true }
  | { ok: false; reason: string; denyId: DenyId };

function checkSecurityDeployStamp(state: Rec, cwd: string): StampCheck {
  const status = state.lastSecurityCheckStatus;
  const checkedAt = typeof state.lastSecurityCheckAt === 'string' ? Date.parse(state.lastSecurityCheckAt) : 0;
  // Both windows in this file are PERMISSION granted by freshness, so an age no
  // clock could have produced has to read as expired. `.one.json` is ordinary
  // project JSON: a stamp dated ahead of now makes `now - stamp` negative, which
  // passes `< WINDOW` by a wider margin the further ahead it is, and the deploy
  // gate then waves a production publish through forever on a security check
  // that may never have run. `trustworthyAgeMs` returns null there; null is not
  // fresh.
  const checkedAgeMs = checkedAt > 0 ? trustworthyAgeSince(checkedAt, Date.now()) : null;
  const fresh = checkedAgeMs !== null && checkedAgeMs < SECURITY_CHECK_WINDOW_MS;
  if (status !== 'passed' || !fresh) {
    return {
      ok: false,
      reason: 'Deploy gate: the Traffic One pre-deployment security check has not passed in the last 10 minutes. Run '
        + `\`${SECURITY_RUN_CMD}\` `
        + 'from the project root, address any findings, then deploy through `senior-shipper`.',
      denyId: 'deploy-gate-security-check-stale',
    };
  }

  // A non-strict stamp can still write lastSecurityCheckStatus:"passed". Deploy
  // authorization requires the --strict run the shipper remediation names.
  if (state.lastSecurityCheckStrict !== true) {
    return {
      ok: false,
      reason: 'Deploy gate: the last security check was not a --strict run, so it cannot authorize deploy. Run '
        + `\`${SECURITY_RUN_CMD}\` `
        + 'from the project root, then deploy through `senior-shipper`.',
      denyId: 'deploy-gate-security-check-stale',
    };
  }

  let current: string;
  try {
    current = computeProjectFingerprint(cwd).fingerprint;
  } catch (error) {
    return { ok: false, reason: `Deploy gate: could not compute the current security fingerprint: ${(error as Error).message}`, denyId: 'deploy-gate-fingerprint-error' };
  }

  if (state.lastSecurityCheckFingerprint !== current) {
    return {
      ok: false,
      reason: 'Deploy gate: the worktree changed after the last passing security check. Rerun '
        + `\`${SECURITY_RUN_CMD}\` `
        + 'so the security fingerprint matches the code being deployed.',
      denyId: 'deploy-gate-fingerprint-mismatch',
    };
  }

  return { ok: true };
}

export function deployGate(ctx: Ctx): HookResult {
  const scope = resolveToolScope(ctx);
  if (scope.standsDown) return noop();
  const unresolvedMember = workspaceMemberRefusal(scope);
  if (unresolvedMember) {
    return deny(unresolvedMember.reason,
      { denyId: unresolvedMember.denyId, denyTarget: unresolvedMember.denyTarget });
  }
  const projectRoot = scope.projectRoot;
  if (pluginUseDeclined(projectRoot)) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!DEPLOY_RE.test(command)) return noop();

  const state = readEffectiveState(projectRoot);
  const approvedAt = typeof state.lastShipperApprovalAt === 'string' ? Date.parse(state.lastShipperApprovalAt) : 0;
  const approvedAgeMs = approvedAt > 0 ? trustworthyAgeSince(approvedAt, Date.now()) : null;
  const fresh = approvedAgeMs !== null && approvedAgeMs < SHIPPER_APPROVAL_WINDOW_MS;
  if (!fresh) {
    return deny('Deploy gate: this command publishes to production. Run '
      + 'the `senior-shipper` subagent first; it stamps `lastShipperApprovalAt` '
      + 'in .traffic-one/.one.json after pre-flight (reviewer APPROVED, tests green, '
      + 'user confirmed). The stamp grants a 10-minute deploy window.',
      { denyId: 'deploy-gate-shipper-approval-required', denyTarget: command });
  }

  const securityCheck = checkSecurityDeployStamp(state, projectRoot);
  if (!securityCheck.ok) return deny(securityCheck.reason,
    { denyId: securityCheck.denyId, denyTarget: command });

  return noop();
}
