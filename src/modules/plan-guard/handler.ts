// src/modules/plan-guard/handler.ts
// PreToolUse(shell) forbidden-library gate: deny `npm/pnpm/yarn/bun add <lib>`
// for libraries that conflict with the active stack. Ported from
// runCheckLibraryAllowlist in gates.cjs (the install-allowlist half; the deploy
// sub-gate needs the security-check fingerprint and lands with that runner).
// Auth is enforced by the priority-0 session gate before this runs.

import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { isExistingProjectMode, isNewProjectMode, readEffectiveState } from '../../shared/state';
import { capabilityProfileForProject } from '../../shared/capabilities';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { resolveToolScope, workspaceMemberRefusal } from '../../shared/tool-scope';
import { INSTALL_RE, allowsNextjs, forbiddenForStack, installedFrameworkDeps } from './forbidden';

export function libraryAllowlistGate(ctx: Ctx): HookResult {
  const scope = resolveToolScope(ctx);
  if (scope.standsDown) return noop();
  const unresolvedMember = workspaceMemberRefusal(scope);
  if (unresolvedMember) {
    return deny(unresolvedMember.reason,
      { denyId: unresolvedMember.denyId, denyTarget: unresolvedMember.denyTarget });
  }
  const projectRoot = scope.projectRoot;
  if (pluginUseDeclined(projectRoot)) return noop();
  // The plugin authoring repo has a null-stack state that would fall into the
  // web forbidden table — never police installs there.
  if (isNonProjectRoot(projectRoot)) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!INSTALL_RE.test(command)) return noop();

  const state = readEffectiveState(projectRoot);
  // An existing codebase keeps its own dependency choices: every row this table
  // can emit is about a stack Traffic One prescribed, and it prescribed nothing
  // there.
  if (isExistingProjectMode(state)) return noop();
  // Undeclared mode is the awkward third case, and it takes exactly half the
  // table. The ADVISORY rows are opinions derived from `defaultStateForStack` —
  // a project that never declared a stack receiving stack advice invented from
  // a guess — so they stand down with the mode. The BLOCKING rows do not: a
  // blocking row is one whose install makes the run's frozen contracts false
  // about the project, and that stays true whatever `.one.json` says. Fencing
  // the whole gate behind the mode (the previous round) turned `{"mode": ""}`
  // into a way to stand the `next` row down, which is worse than the advisory
  // noise it was fixing — and the mode-downgrade guard in plan-write only
  // refused transitions to `existing*`, so writing an empty mode was a legal
  // move. Both ends are closed now; this is the braces.
  const scaffolded = isNewProjectMode(state);
  const arg = state.stack ? state : null;
  const profile = capabilityProfileForProject(projectRoot, state);
  const hits = forbiddenForStack(
    arg,
    allowsNextjs(state, projectRoot),
    profile.uiSystem,
    installedFrameworkDeps(projectRoot),
    profile.uiFrameworks?.web || profile.framework,
  )
    .filter((rule) => scaffolded || rule.blocking)
    .filter((rule) => new RegExp(rule.pattern).test(command));
  if (hits.length === 0) return noop();

  const lines = (rules: typeof hits): string => rules
    .map((rule) => `  - ${rule.pattern}: ${rule.tip}`)
    .join('\n');
  // Every row this gate can match is reported. Only the rows that would make
  // the compiled capability contract false about the project refuse the
  // install; the rest are stack advice, delivered on the same command rather
  // than instead of it (see ForbiddenRule.blocking for which is which).
  const advisories = hits.filter((rule) => !rule.blocking);
  const advice = advisories.length > 0
    ? `Stack advice for this install (not blocking):\n${lines(advisories)}`
    : '';
  const blocking = hits.filter((rule) => rule.blocking);
  if (blocking.length === 0) return context(advice);
  return deny(`Forbidden library:\n${lines(blocking)}\n\nSee rules/core.md and the active stack core for the approved stack.`,
    {
      denyId: 'library-allowlist-forbidden',
      denyTarget: command,
      ...(advice ? { context: advice } : {}),
    });
}
