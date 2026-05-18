'use strict';

// scripts/hook-runtime/config.cjs
// Shared constants, infra-config flags, and pitch helpers used by every other
// hook-runtime module.

const path = require('path');

// ── Runtime constants ────────────────────────────────────────────────────────
const MAX_STDIN          = 1024 * 1024;
const STATE_FILE         = '.traffic-one.json';
const LEGACY_LOCK_FILE   = '.claude-plugin-mode';
const BUDGET_CHARS       = 9500;

const STACK_IDS = new Set([
  'minimal',
  'default',
  'custom-frontend',
  'custom-backend',
  'custom-stack',
]);

const LEGACY_STACK_ALIASES = {
  'react-realtime-monorepo': 'default',
  'react-frontend-only': 'custom-backend',
  'react-native-expo-monorepo': 'custom-frontend',
  'react-native-expo-app': 'custom-frontend',
  'node-backend': 'custom-backend',
  'framework-web': 'custom-frontend',
};

const RN_STACKS  = new Set(['react-native-expo-monorepo', 'react-native-expo-app']);
const WEB_STACKS = new Set(['default', 'custom-frontend', 'custom-backend', 'custom-stack', 'react-realtime-monorepo', 'react-frontend-only']);

// ── Infrastructure config (end-to-end default) ───────────────────────────────
// The plugin's recommended stack is end-to-end: React monorepo + Supabase
// backend + our /deploy infra. Supabase is the stable default backend for new
// projects unless the user explicitly chooses something else.
const INFRA_CONFIG = {
  ourDeployConfigured: false,  // /deploy command + hosted infra
};

function defaultBackendValue() {
  return 'supabase';
}

function pitchBackendLabel() {
  return 'Supabase (managed Postgres with Auth, Storage, Realtime, and RLS)';
}

function pitchDeployLabel() {
  return INFRA_CONFIG.ourDeployConfigured
    ? '`/deploy` ships it live on our infra in one command'
    : "one short deploy command will ship it (we're wiring up `/deploy` next)";
}

// ── Path helpers ─────────────────────────────────────────────────────────────
function pluginRoot() {
  // hook-runtime/config.cjs lives at scripts/hook-runtime/ → up two = plugin root
  return path.resolve(__dirname, '..', '..');
}

function isManagedPluginCachePath(root) {
  return [
    `${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`,
    `${path.sep}.codex${path.sep}plugins${path.sep}cache${path.sep}`,
  ].some((marker) => root.includes(marker));
}

function isInPluginCache() {
  return isManagedPluginCachePath(pluginRoot());
}

module.exports = {
  MAX_STDIN,
  STATE_FILE,
  LEGACY_LOCK_FILE,
  BUDGET_CHARS,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
  RN_STACKS,
  WEB_STACKS,
  INFRA_CONFIG,
  defaultBackendValue,
  pitchBackendLabel,
  pitchDeployLabel,
  pluginRoot,
  isManagedPluginCachePath,
  isInPluginCache,
};
