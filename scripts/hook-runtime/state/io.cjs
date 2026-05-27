'use strict';

// scripts/hook-runtime/state/io.cjs
// Low-level JSON / file I/O primitives + plugin version lookup. Every state
// module that needs to touch disk goes through these.

const fs = require('fs');
const path = require('path');

const { pluginRoot } = require('../config.cjs');

const PLUGIN_MANIFEST_DIRS = ['.codex-plugin', '.claude-plugin', '.cursor-plugin'];

// Cache the plugin's own version so we can stamp it into every
// `.traffic-one/.one.json` write. The cache is set once at module load; the plugin
// version doesn't change mid-session.
let cachedPluginVersion = null;
function getPluginVersion() {
  if (cachedPluginVersion !== null) return cachedPluginVersion;
  const root = pluginRoot();
  for (const manifestDir of PLUGIN_MANIFEST_DIRS) {
    try {
      const manifestPath = path.join(root, manifestDir, 'plugin.json');
      const text = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(text);
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        cachedPluginVersion = parsed.version;
        return cachedPluginVersion;
      }
    } catch {
      // Try the next host-specific manifest.
    }
  }
  cachedPluginVersion = '';
  return cachedPluginVersion;
}

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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = {
  getPluginVersion,
  parseJsonText,
  safeReadText,
  safeReadJson,
  writeJson,
  nowIso,
};
