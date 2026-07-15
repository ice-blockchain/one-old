// src/modules/plan-guard/handler.ts
// PreToolUse(shell) forbidden-library gate: deny `npm/pnpm/yarn/bun add <lib>`
// for libraries that conflict with the active stack. Ported from
// runCheckLibraryAllowlist in gates.cjs (the install-allowlist half; the deploy
// sub-gate needs the security-check fingerprint and lands with that runner).
// Auth is enforced by the priority-0 session gate before this runs.

import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { INSTALL_RE, allowsNextjs, forbiddenForStack } from './forbidden';

export function libraryAllowlistGate(ctx: Ctx): HookResult {
  if (pluginUseDeclined(ctx.cwd)) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!INSTALL_RE.test(command)) return noop();

  const state = readEffectiveState(ctx.cwd);
  const arg = state.stack ? state : null;
  const hits = forbiddenForStack(arg, allowsNextjs(state, ctx.cwd)).filter(([pattern]) => new RegExp(pattern).test(command));
  if (hits.length === 0) return noop();

  const lines = hits.map(([pattern, tip]) => `  - ${pattern}: ${tip}`).join('\n');
  return deny(`Forbidden library:\n${lines}\n\nSee rules/core.md and the active stack core for the approved stack.`);
}
