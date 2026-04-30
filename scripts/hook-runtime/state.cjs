'use strict';

// scripts/hook-runtime/state.cjs
// Low-level JSON / file I/O helpers and the .traffic-one.json read/write API.
// Every module that needs to touch the state file goes through here.

const fs = require('node:fs');
const path = require('node:path');

const { STATE_FILE, LEGACY_LOCK_FILE, STATE_VERSION } = require('./config.cjs');

// ── JSON / file helpers ──────────────────────────────────────────────────────
function parseJsonText(text, fallback = {}) {
  if (!text || !text.trim()) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReadJson(filePath, fallback = {}) {
  const text = safeReadText(filePath);
  return text === null ? fallback : parseJsonText(text, fallback);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── .traffic-one.json read / write ───────────────────────────────────────────
function readState(cwd) {
  const statePath = path.join(cwd, STATE_FILE);
  if (fs.existsSync(statePath)) {
    return safeReadJson(statePath, {});
  }

  // Legacy migration: very old projects used a flat .claude-plugin-mode file
  const legacyPath = path.join(cwd, LEGACY_LOCK_FILE);
  const legacy = safeReadText(legacyPath);
  if (legacy !== null) {
    return {
      version: STATE_VERSION,
      mode: legacy.trim(),
      stack: null,
      confirmed: false,
    };
  }
  return {};
}

function writeState(cwd, state) {
  const nextState = { ...state, version: STATE_VERSION };
  writeJson(path.join(cwd, STATE_FILE), nextState);
}

// ── Tolerate partial state ───────────────────────────────────────────────────
// The model sometimes writes `.traffic-one.json` with just `{stack, backend,
// realtime, version}`, dropping `mode`, `confirmed`, `onboardingComplete`,
// `confirmedAt`. We treat that as "the user picked a stack, we just need to
// fill in the bookkeeping" rather than restart onboarding from scratch.
//
// `defaultMode` is the mode to use when state.mode is missing — pass the
// detected mode here so we don't re-detect from the calling site.
//
// Returns `true` if any field was added (so the caller knows to write back).
function normalizeState(state, defaultMode) {
  if (!state || typeof state !== 'object' || !state.stack) {
    return false;
  }

  let changed = false;

  if (!state.mode && defaultMode) {
    state.mode = defaultMode;
    changed = true;
  }
  if (state.confirmed !== true) {
    state.confirmed = true;
    changed = true;
  }
  if (state.onboardingComplete !== true) {
    state.onboardingComplete = true;
    changed = true;
  }
  if (!state.confirmedAt) {
    state.confirmedAt = nowIso();
    changed = true;
  }
  if (!state.realtime) {
    state.realtime = 'none';
    changed = true;
  }
  if (!state.backend) {
    state.backend = 'supabase';
    changed = true;
  }

  return changed;
}

module.exports = {
  parseJsonText,
  safeReadText,
  safeReadJson,
  writeJson,
  nowIso,
  readState,
  writeState,
  normalizeState,
};
