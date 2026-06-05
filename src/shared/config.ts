// src/shared/config.ts
// Stack/pitch helper functions. The tunable data moved to config/stacks.ts
// (stack ids/aliases, INFRA_CONFIG) and config/paths.ts (state file locations).

import { INFRA_CONFIG, LEGACY_STACK_ALIASES, STACK_IDS } from '../config/stacks';

// A stack id is "known" if it's a current id or a recognized legacy alias.
export function isKnownStack(stack: unknown): boolean {
  return typeof stack === 'string'
    && (STACK_IDS.has(stack) || Object.prototype.hasOwnProperty.call(LEGACY_STACK_ALIASES, stack));
}

export function defaultBackendValue(): string {
  return 'supabase';
}

export function pitchBackendLabel(): string {
  return 'Supabase (managed Postgres with Auth, Storage, Realtime, and RLS)';
}

export function pitchDeployLabel(): string {
  return INFRA_CONFIG.ourDeployConfigured
    ? '`/deploy` ships it live on our infra in one command'
    : "one short deploy command will ship it (we're wiring up `/deploy` next)";
}
