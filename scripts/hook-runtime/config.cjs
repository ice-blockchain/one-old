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
const STATE_VERSION      = 2;

const RN_STACKS  = new Set(['react-native-expo-monorepo', 'react-native-expo-app']);
const WEB_STACKS = new Set(['react-realtime-monorepo', 'react-frontend-only']);

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

function isInPluginCache() {
  return pluginRoot().includes(`${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`);
}

module.exports = {
  MAX_STDIN,
  STATE_FILE,
  LEGACY_LOCK_FILE,
  BUDGET_CHARS,
  STATE_VERSION,
  RN_STACKS,
  WEB_STACKS,
  INFRA_CONFIG,
  defaultBackendValue,
  pitchBackendLabel,
  pitchDeployLabel,
  pluginRoot,
  isInPluginCache,
};
