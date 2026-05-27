'use strict';

const path = require('path');

const { safeRead, safeStat, normalizeState } = require('./_helpers.cjs');
const {
  effectiveState,
  projectPrefsPath,
  readProjectPrefs,
  stripLocalPreferenceFields,
} = require('../hook-runtime/state/state.cjs');

function probeProject(cwd) {
  const trafficOne = safeRead(path.join(cwd, '.traffic-one', '.one.json'))
    || safeRead(path.join(cwd, '.traffic-one.json'));
  let state = null;
  if (trafficOne) { try { state = JSON.parse(trafficOne); } catch { state = null; } }
  let normalizedState = null;
  let localPreferences = {};
  let localPreferencesPath = null;
  if (state && typeof state === 'object') {
    localPreferencesPath = projectPrefsPath(cwd);
    localPreferences = readProjectPrefs(cwd);
    normalizedState = effectiveState(stripLocalPreferenceFields(state), localPreferences);
    normalizeState(normalizedState, normalizedState.mode || normalizedState.projectMode || 'new-project');
  }
  const nvmrcRaw = safeRead(path.join(cwd, '.nvmrc'));
  const gitDir = safeStat(path.join(cwd, '.git'));
  const gitnexusOut = safeStat(path.join(cwd, '.gitnexus'));
  const graphifyOut = safeStat(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'));
  return {
    cwd,
    hasState: !!state,
    state,
    localPreferences,
    localPreferencesPath,
    hasLocalPreferences: Object.keys(localPreferences || {}).length > 0,
    normalizedState,
    nvmrc: nvmrcRaw === null ? null : nvmrcRaw.trim(),
    hasGit: !!gitDir && gitDir.isDirectory(),
    artefacts: {
      gitnexus: gitnexusOut ? { mtimeMs: gitnexusOut.mtimeMs } : null,
      graphify: graphifyOut ? { mtimeMs: graphifyOut.mtimeMs } : null,
    },
  };
}

module.exports = { probeProject };
