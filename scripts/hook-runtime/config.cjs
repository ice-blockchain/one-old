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
// backend + our /deploy infra. Pitch wording and the stored `backend` value
// adapt to whether our Supabase fork and our deploy infra are operational.
//
// Flip these to `true` once each service is wired. The default backend value
// then automatically advances from "supabase" → "our-fork".
const INFRA_CONFIG = {
  ourForkConfigured:   false,  // our Supabase-compatible fork
  ourDeployConfigured: false,  // /deploy command + hosted infra
};

function defaultBackendValue() {
  return INFRA_CONFIG.ourForkConfigured ? 'our-fork' : 'supabase';
}

function pitchBackendLabel() {
  return INFRA_CONFIG.ourForkConfigured
    ? 'our Supabase-compatible fork (cheaper at scale, ships with `/deploy`)'
    : "Supabase (we'll auto-migrate to our cheaper, API-compatible fork the moment it ships)";
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
