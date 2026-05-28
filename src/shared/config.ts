// src/shared/config.ts
// Runtime constants + pitch helpers. Ported from scripts/hook-runtime/config.cjs
// (pluginRoot / cache helpers live in shared/paths.ts).

import * as path from 'path';

export const MAX_STDIN = 1024 * 1024;
export const STATE_DIR = '.traffic-one';
export const STATE_BASENAME = '.one.json';
export const STATE_FILE = path.join(STATE_DIR, STATE_BASENAME);
export const LEGACY_STATE_FILE = STATE_FILE;
export const LEGACY_LOCK_FILE = '.claude-plugin-mode';
export const BUDGET_CHARS = 9500;

export const STACK_IDS = new Set(['minimal', 'default', 'custom-frontend', 'custom-backend', 'custom-stack']);

export const LEGACY_STACK_ALIASES: Readonly<Record<string, string>> = {
  'react-realtime-monorepo': 'default',
  'react-frontend-only': 'custom-backend',
  'react-native-expo-monorepo': 'custom-frontend',
  'react-native-expo-app': 'custom-frontend',
  'node-backend': 'custom-backend',
  'framework-web': 'custom-frontend',
};

// A stack id is "known" if it's a current id or a recognized legacy alias.
export function isKnownStack(stack: unknown): boolean {
  return typeof stack === 'string'
    && (STACK_IDS.has(stack) || Object.prototype.hasOwnProperty.call(LEGACY_STACK_ALIASES, stack));
}

export const RN_STACKS = new Set(['react-native-expo-monorepo', 'react-native-expo-app']);
export const WEB_STACKS = new Set([
  'default', 'custom-frontend', 'custom-backend', 'custom-stack', 'react-realtime-monorepo', 'react-frontend-only',
]);

export const INFRA_CONFIG = { ourDeployConfigured: false };

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
