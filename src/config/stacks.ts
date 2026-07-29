// src/config/stacks.ts
// Stack ids, legacy aliases, and per-stack classification sets. THE knobs for what
// stacks exist and how deprecated ids map forward. The functions that read this
// (isKnownStack, pitch helpers) live in shared/config.ts.

export const STACK_IDS = new Set(['minimal', 'default', 'custom-frontend', 'custom-backend', 'custom-stack']);

export const LEGACY_STACK_ALIASES: Readonly<Record<string, string>> = {
  'react-realtime-monorepo': 'default',
  'react-frontend-only': 'custom-backend',
  'react-native-expo-monorepo': 'custom-frontend',
  'react-native-expo-app': 'custom-frontend',
  'node-backend': 'custom-backend',
  'framework-web': 'custom-frontend',
};

export const RN_STACKS = new Set(['react-native-expo-monorepo', 'react-native-expo-app']);

// Mutable feature flag read by pitchDeployLabel(); flip when our managed deploy lands.
export const INFRA_CONFIG = { ourDeployConfigured: false };
