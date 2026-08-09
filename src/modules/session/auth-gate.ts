// src/modules/session/auth-gate.ts
// Priority-0 auth enforcement. API-key intake and validation belong exclusively
// to the onboarding wizard; hooks only read the canonical local auth record.

import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authEnforced, isLocallyAuthenticated } from '../../shared/auth';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { resolveToolScope, workspaceMemberRefusal } from '../../shared/tool-scope';
import { onboardingGate } from '../onboarding-gate/handler';

// While unauthenticated, reuse the onboarding gate so every host opens the
// wizard directly on its API-key step and blocks mutation until validation
// succeeds. The explicit pluginUse check below makes a decline stand down before
// the canonical auth state is read.
export function authPreToolGate(ctx: Ctx): HookResult {
  const scope = resolveToolScope(ctx);
  if (scope.standsDown) return noop();
  // Ahead of every read below, including `pluginUseDeclined`: a workspace
  // container has no project state for any of them to be about, and this gate
  // is priority 0 on all five PreToolUse subcommands, so it is where the fence
  // is reached first for most calls.
  const unresolvedMember = workspaceMemberRefusal(scope);
  if (unresolvedMember) {
    return deny(unresolvedMember.reason,
      { denyId: unresolvedMember.denyId, denyTarget: unresolvedMember.denyTarget });
  }
  const root = scope.projectRoot;
  if (isNonProjectRoot(root)) return noop();
  if (pluginUseDeclined(root)) return noop();
  if (!authEnforced() || isLocallyAuthenticated()) return noop();
  return onboardingGate(ctx);
}
