// src/shared/state/materialization.ts
// Stack fingerprinting, materialization-freshness, and subagent / fix-cycle
// signals. Ported 1:1 from scripts/hook-runtime/state/materialization.cjs.

import { obj } from '../obj';
import { SUBAGENT_STALE_MS, VALID_AGENT_ROLES } from '../../config/state';
import { WORKSPACE_PROJECT_MODE } from '../hook/workspace-members';
import { stateVersion } from './io';

// An absent/unreadable state is NOT a minimal project. `readJson` collapses a
// missing, torn, or unparseable `.one.json` to `{}` (fsjson.ts), and the old
// `||` defaults then minted the plausible-looking `minimal|none|none|none` for
// it — a fabricated identity that got stamped into a run ledger and its claims,
// after which every claim mismatched the real state and role binding silently
// died for the life of the project (observed test-laravel: run
// `1785172002942` carries `minimal|none|none|none` while `.one.json` says
// laravel). Writers must be able to tell "no identity" from "this identity".
export const UNKNOWN_STACK_FINGERPRINT = 'unknown|unknown|unknown|unknown';

/**
 * The identity of a WORKSPACE CONTAINER, which carries no stack by construction.
 *
 * A container is not a codebase — its members are — so `stack`, `frontend`,
 * `backend` and `mobile` are all absent on a perfectly healthy `mode:
 * 'workspace'` record, and the "no identity-bearing key" test below therefore
 * read a valid workspace as a DEGRADED READ.
 *
 * A DURABILITY GUARD, NOT A BUG FIX, and the difference is worth stating
 * because the first version of this note claimed the second. It said the old
 * answer left a container "re-materializing on every convergence pass", and
 * MEASURED against the only writer that creates one, that state does not exist:
 * `writeWorkspaceMemberRegistry` commits `mode: 'workspace'` WITHOUT
 * `onboardingComplete`, and `isMaterialized` returns true for any record whose
 * `onboardingComplete` is falsy — the pre-onboarding short-circuit — before it
 * ever compares a stamp. A container therefore never reached the comparison,
 * with UNKNOWN or with this value. The migration surface is EMPTY for the same
 * reason: no container on disk carries a `materializedStack` at all, so no
 * stamp has to be reinterpreted and nothing has to be rewritten.
 *
 * What the value buys is that the comparison cannot become wrong silently. The
 * moment anything completes a container's onboarding — which is the whole point
 * of the workspace flow — `isMaterialized` starts comparing the stamp against
 * `stackFingerprint`, and UNKNOWN is what a container would stamp AND what it
 * would re-derive: equal by accident, and equal to every unreadable record on
 * the machine. A dedicated value makes that comparison mean something the day
 * it starts running.
 *
 * NEVER the `minimal|none|none|none` the join below would have produced. That
 * string is exactly the fabricated identity the note above records as a live
 * defect, and a container and a minimal project sharing one fingerprint would
 * put a container's run ledger and a minimal project's on the same footing.
 * `workspace` cannot collide with a real stack either — it is not in
 * `STACK_IDS` (config/stacks.ts), which is closed over minimal / default /
 * custom-frontend / custom-backend / custom-stack.
 *
 * The 4-tuple SHAPE is unchanged, and that is load-bearing rather than tidy:
 * this string is frozen into every run ledger, claim, rebind journal and
 * assignments manifest, and a claim whose fingerprint disagrees with the run's
 * is rejected as `fingerprint-mismatch` (state/run-agent/claims-pending.ts) —
 * a deny no respawn can clear.
 */
export const WORKSPACE_STACK_FINGERPRINT = 'workspace|none|none|none';

export function stackFingerprint(state: unknown): string {
  const s = obj(state);
  if (!s) return UNKNOWN_STACK_FINGERPRINT;
  const mobile = obj(s.mobile);
  const joined = [
    (s.stack as string) || 'minimal',
    (s.frontend as string) || 'none',
    (s.backend as string) || 'none',
    (mobile && (mobile.framework as string)) || 'none',
  ].join('|');
  // KEYED ON THE MODE, not on emptiness, and the difference is a fabricated
  // identity. Keyed on "no identity-bearing key at all", a container carrying
  // one incidental field — `{ mode: 'workspace', frontend: 'none' }` is the
  // measured case, and `'none'` is a real value the wizard writes — fell
  // through to the join, whose `stack` slot defaults to `'minimal'`, and
  // produced exactly the `minimal|none|none|none` this module exists to keep
  // out of a run ledger. The mode is the fact being asserted; ask it directly.
  //
  // A workspace record that DOES carry a stack (a legacy state path, or a
  // hand-edit) still falls through to the join and keeps the answer it has
  // today.
  if (s.mode === WORKSPACE_PROJECT_MODE) return s.stack ? joined : WORKSPACE_STACK_FINGERPRINT;
  // A real minimal project carries `stack: 'minimal'` (normalizeState sets it).
  // A record with no identity-bearing key at all is a degraded read.
  if (!s.stack && !s.frontend && !s.backend && !mobile) return UNKNOWN_STACK_FINGERPRINT;
  // …and the container identity is RESERVED to the branch above. `workspace` is
  // not a stack id, so a record that joins to the container's fingerprint
  // without SAYING it is a container is not a container — it is an illegible
  // record wearing a reserved name, and UNKNOWN is precisely what this module
  // means by that. Without this line `{ stack: 'workspace' }` produced the
  // container identity, so a hand-edited or legacy project and every container
  // on the machine would have shared one fingerprint — the collision the
  // dedicated value was introduced to prevent, arriving through the other door.
  // No writer can reach it: `stack` is written from `STACK_IDS`, and
  // `isKnownStack('workspace')` is false, so such a project is refused
  // materialization long before anything stamps a fingerprint for it.
  return joined === WORKSPACE_STACK_FINGERPRINT ? UNKNOWN_STACK_FINGERPRINT : joined;
}

export function isUnknownStackFingerprint(value: unknown): boolean {
  return value === UNKNOWN_STACK_FINGERPRINT;
}

export function isMaterialized(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  if (!s.onboardingComplete) return true; // pre-onboarding: don't block
  if (!s.materializedStack) return false;
  if (s.materializedStack !== stackFingerprint(s)) return false;
  // Older projects predate the version stamp and stay compatible. Once a stamp
  // exists, however, a plugin upgrade must refresh the generated AGENTS/rules/
  // role contracts instead of silently carrying a previous runtime's guidance.
  const version = typeof s.materializedVersion === 'string' ? s.materializedVersion.trim() : '';
  return !version || version === stateVersion();
}

export function isSubagentSession(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  if (typeof s.currentRunId !== 'string' || !s.currentRunId) return false;
  if (!s.materializedStack) return false;
  if (s.materializedStack !== stackFingerprint(s)) return false;
  if (typeof s.materializedAt === 'string') {
    const ageMs = Date.now() - Date.parse(s.materializedAt);
    if (Number.isFinite(ageMs) && ageMs > SUBAGENT_STALE_MS) return false;
  }
  return true;
}

export function activeAgentRole(state: unknown): string | null {
  const s = obj(state);
  if (!s) return null;
  const role = s.activeAgentRole;
  return typeof role === 'string' && VALID_AGENT_ROLES.has(role) ? role : null;
}

// Secondary input to `nextSpawnIndex` only, and 0 on any host that binds roles
// through `bindThreadRole` (Codex, Claude agent-teams): that path deliberately
// declines `writeState()` so parallel subagents cannot clobber the shared
// `.one.json`, so `state.spawnIndex` is simply never written there. The
// authoritative count is the on-disk claim files — see `nextSpawnIndex`, which
// takes `Math.max(stateIndex, diskIndex, 1)`.
//
// Do NOT build a gate on this alone. `isFixCycleSession()` did exactly that and
// was silently `false` for every Codex run; it was deleted rather than fixed
// because it had no production callers. Read `spawnIndex` off the resolved
// `RunAgentContext` instead, the way `subagentRoleContext` does.
export function getSpawnIndex(state: unknown, role: string): number {
  const s = obj(state);
  if (!s) return 0;
  const map = obj(s.spawnIndex);
  if (!map) return 0;
  const n = map[role];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}
