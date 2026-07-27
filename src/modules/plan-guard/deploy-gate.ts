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
import { computeProjectFingerprint } from '../../runners/security-check';
import { readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { resolveToolScope } from '../../shared/tool-scope';

type Rec = Record<string, unknown>;

export const DEPLOY_RE = /(^|[\s;&|])(vercel\s+(deploy|--prod)|eas\s+build\s+.*--auto-submit|eas\s+submit|supabase\s+db\s+push\s+--linked|supabase\s+functions\s+deploy\s+\S+\s+--linked|gh\s+release\s+create|fly\s+deploy|wrangler\s+deploy|npm\s+publish|pnpm\s+publish)\b/;

const SHIPPER_APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_CHECK_WINDOW_MS = 10 * 60 * 1000;

// The literal plugin-root expansion for the remediation command (single-quoted
// so the ${...} stays verbatim, exactly as the legacy reason text).
const SECURITY_RUN_CMD = 'node ~/.traffic-one/bin/security-check-runner.cjs --strict --stamp';

interface StampCheck { ok: boolean; reason?: string; }

export function checkSecurityDeployStamp(state: Rec, cwd: string): StampCheck {
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

  let current: string;
  try {
    current = computeProjectFingerprint(cwd).fingerprint;
  } catch (error) {
    return { ok: false, reason: `Deploy gate: could not compute the current security fingerprint: ${(error as Error).message}` };
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

export function deployGate(ctx: Ctx): HookResult {
  const scope = resolveToolScope(ctx);
  if (scope.standsDown) return noop();
  const projectRoot = scope.projectRoot;
  if (pluginUseDeclined(projectRoot)) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!DEPLOY_RE.test(command)) return noop();

  const state = readEffectiveState(projectRoot);
  const approvedAt = typeof state.lastShipperApprovalAt === 'string' ? Date.parse(state.lastShipperApprovalAt) : 0;
  const fresh = approvedAt > 0 && (Date.now() - approvedAt) < SHIPPER_APPROVAL_WINDOW_MS;
  if (!fresh) {
    return deny('Deploy gate: this command publishes to production. Run '
      + 'the `senior-shipper` subagent first; it stamps `lastShipperApprovalAt` '
      + 'in .traffic-one/.one.json after pre-flight (reviewer APPROVED, tests green, '
      + 'user confirmed). The stamp grants a 10-minute deploy window.');
  }

  const securityCheck = checkSecurityDeployStamp(state, projectRoot);
  if (!securityCheck.ok) return deny(securityCheck.reason ?? 'Deploy gate: security check failed.');

  return noop();
}
