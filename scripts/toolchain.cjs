'use strict';

// scripts/toolchain.cjs
// Single source of truth for "what version of <tool> is installed on this
// machine" and "what does the plugin recommend?" Both gitnexus-runner.cjs
// and graphify-runner.cjs use the probe + stamp helpers to write the
// `toolchain` field into `.traffic-one/.one.json` after a successful run.
// doctor.cjs uses the same helpers to surface a `TOOLCHAIN_OUTDATED`
// finding when the installed version drifts behind `recommended` or sits
// below `minimum`.
//
// The plugin-source spec at `scripts/toolchain-versions.json` is the single
// place to bump version recommendations — a small one-file PR.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SPEC_PATH = path.join(__dirname, 'toolchain-versions.json');

let cachedSpec = null;
function loadSpec() {
  if (cachedSpec !== null) return cachedSpec;
  try {
    const text = fs.readFileSync(SPEC_PATH, 'utf8');
    const parsed = JSON.parse(text);
    cachedSpec = (parsed && parsed.tools) || {};
  } catch {
    cachedSpec = {};
  }
  return cachedSpec;
}

// Return the spec entry for `toolName` or null if unknown.
function getToolSpec(toolName) {
  const spec = loadSpec();
  return Object.prototype.hasOwnProperty.call(spec, toolName) ? spec[toolName] : null;
}

// Compare two semver strings without pulling in a dep. Returns:
//   -1  if a < b
//    0  if a === b
//    1  if a > b
// Missing/non-semver values are treated as null and never compare; callers
// should guard for null inputs and skip the comparison.
function compareSemver(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const norm = (v) => v.replace(/^v/, '').split('.').map((n) => Number(n));
  const aa = norm(a);
  const bb = norm(b);
  if (aa.length !== 3 || bb.length !== 3) return null;
  if (aa.some(Number.isNaN) || bb.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i += 1) {
    if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

// Probe `tool --version` (or the spec-declared versionCommand) and extract
// the semver via the spec's `versionRegex`. Returns the matched semver as
// a string, or null if the probe failed (tool not on PATH, crash, unparseable
// output, regex miss). `opts.binPath` lets callers force an absolute binary
// path so we don't rely on PATH order (matters for the nvm-v22 gitnexus
// case the gitnexus-runner already handles).
function probeToolVersion(toolName, opts = {}) {
  const spec = getToolSpec(toolName);
  if (!spec) return null;

  // Build the command. `binPath` (absolute) overrides the spec's argv[0].
  let cmd;
  let args;
  if (opts.binPath && typeof opts.binPath === 'string') {
    // Extract just the args part of `<cmd> --version` from the spec.
    const tokens = String(spec.versionCommand || `${toolName} --version`).split(/\s+/);
    cmd = opts.binPath;
    args = tokens.slice(1);
  } else {
    const tokens = String(spec.versionCommand || `${toolName} --version`).split(/\s+/);
    cmd = tokens[0];
    args = tokens.slice(1);
  }

  let result;
  try {
    result = spawnSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 1000,
    });
  } catch {
    return null;
  }
  // gitnexus prints "1.6.4" on stdout; graphify prints to stdout too.
  // Some tools (gitleaks) print to stderr — try both.
  const blob = `${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`;
  const regex = new RegExp(spec.versionRegex || 'v?(\\d+\\.\\d+\\.\\d+)');
  const match = regex.exec(blob);
  if (!match || !match[1]) return null;
  return match[1];
}

// Status summary for a tool: where it sits vs. spec.
// Returns { installed, recommended, minimum, status } where status is one of:
//   'unknown'   — tool not in spec
//   'missing'   — probe returned null (tool not installed / not runnable)
//   'too-old'   — installed < minimum (runner should refuse with this)
//   'outdated'  — minimum <= installed < recommended (nudge only)
//   'current'   — installed >= recommended
function toolStatus(toolName, installedVersion) {
  const spec = getToolSpec(toolName);
  if (!spec) {
    return { installed: installedVersion || null, recommended: null, minimum: null, status: 'unknown' };
  }
  if (!installedVersion) {
    return { installed: null, recommended: spec.recommended, minimum: spec.minimum, status: 'missing' };
  }
  const vMin = compareSemver(installedVersion, spec.minimum);
  const vRec = compareSemver(installedVersion, spec.recommended);
  let status = 'current';
  if (vMin !== null && vMin < 0) status = 'too-old';
  else if (vRec !== null && vRec < 0) status = 'outdated';
  return { installed: installedVersion, recommended: spec.recommended, minimum: spec.minimum, status };
}

// Merge a new toolchain entry into the in-memory state object. Callers are
// responsible for persisting the updated state file via their own writeState
// helper (we don't import state.cjs here to keep this module free of plugin
// internals).
function mergeToolchainStamp(state, toolName, { version, binPath, at }) {
  const next = (state && typeof state === 'object') ? state : {};
  const toolchain = (next.toolchain && typeof next.toolchain === 'object') ? next.toolchain : {};
  toolchain[toolName] = {
    installedVersion: version || null,
    installedAt: at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(binPath ? { binPath } : {}),
  };
  next.toolchain = toolchain;
  return next;
}

module.exports = {
  loadSpec,
  getToolSpec,
  compareSemver,
  probeToolVersion,
  toolStatus,
  mergeToolchainStamp,
  SPEC_PATH,
};
