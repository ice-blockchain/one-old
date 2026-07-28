// src/shared/state/materialization.ts
// Stack fingerprinting, materialization-freshness, and subagent / fix-cycle
// signals. Ported 1:1 from scripts/hook-runtime/state/materialization.cjs.

import { obj, type Rec } from '../obj';
import { SUBAGENT_STALE_MS, VALID_AGENT_ROLES } from '../../config/state';
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

export function stackFingerprint(state: unknown): string {
  const s = obj(state);
  if (!s) return UNKNOWN_STACK_FINGERPRINT;
  const mobile = obj(s.mobile);
  // A real minimal project carries `stack: 'minimal'` (normalizeState sets it).
  // A record with no identity-bearing key at all is a degraded read.
  if (!s.stack && !s.frontend && !s.backend && !mobile) return UNKNOWN_STACK_FINGERPRINT;
  return [
    (s.stack as string) || 'minimal',
    (s.frontend as string) || 'none',
    (s.backend as string) || 'none',
    (mobile && (mobile.framework as string)) || 'none',
  ].join('|');
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

export function getSpawnIndex(state: unknown, role: string): number {
  const s = obj(state);
  if (!s) return 0;
  const map = obj(s.spawnIndex);
  if (!map) return 0;
  const n = map[role];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

export function isFixCycleSession(state: unknown): boolean {
  if (!isSubagentSession(state)) return false;
  const role = activeAgentRole(state);
  if (!role) return false;
  return getSpawnIndex(state, role) > 1;
}
