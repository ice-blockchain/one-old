// src/shared/state/materialization.ts
// Stack fingerprinting, materialization-freshness, and subagent / fix-cycle
// signals. Ported 1:1 from scripts/hook-runtime/state/materialization.cjs.

import { obj, type Rec } from '../obj';
import { SUBAGENT_STALE_MS, VALID_AGENT_ROLES } from '../../config/state';
import { stateVersion } from './io';

export function stackFingerprint(state: unknown): string {
  const s = obj(state);
  if (!s) return 'minimal|none|none|none';
  const mobile = obj(s.mobile);
  return [
    (s.stack as string) || 'minimal',
    (s.frontend as string) || 'none',
    (s.backend as string) || 'none',
    (mobile && (mobile.framework as string)) || 'none',
  ].join('|');
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
