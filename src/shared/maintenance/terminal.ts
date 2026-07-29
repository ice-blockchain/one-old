// One maintenance terminality predicate shared by the runner, verifier, and
// doctor. `fallback-pending` is deliberately nonterminal even when fallback is
// allowed: permission to continue is not evidence that the continuation ran.

import { paidFallbackCompletionFromMaintenance } from './fallback-proof';

export const MAINTENANCE_TERMINAL_OUTCOMES = new Set([
  'success',
  'completed',
  'verified',
  'failed',
  'blocked',
  'skipped',
  'fallback-paid',
]);

type Rec = Record<string, unknown>;

export function maintenanceOutcome(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const rec = value as Rec;
  const raw = typeof rec.overallOutcome === 'string'
    ? rec.overallOutcome
    : typeof rec.outcome === 'string'
      ? rec.outcome
      : '';
  return raw.trim().toLowerCase();
}

export function isMaintenanceTerminal(value: unknown): boolean {
  const outcome = maintenanceOutcome(value);
  if (outcome === 'fallback-paid') {
    return Boolean(paidFallbackCompletionFromMaintenance(value));
  }
  return outcome !== 'fallback-pending' && MAINTENANCE_TERMINAL_OUTCOMES.has(outcome);
}
