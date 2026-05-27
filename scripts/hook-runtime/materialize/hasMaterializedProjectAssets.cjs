'use strict';

const fs = require('fs');
const path = require('path');

const { isGenerated } = require('./_helpers.cjs');

function hasMaterializedProjectAssets(cwd, state) {
  const manifestPath = path.join(cwd, '.traffic-one', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }

  if (!manifest || manifest.generatedBy !== 'traffic-one') return false;
  if (state && manifest.stack && state.stack && manifest.stack !== state.stack) return false;
  if (!Array.isArray(manifest.rules) || manifest.rules.length === 0) return false;
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) return false;

  const agentsPath = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(agentsPath) || !isGenerated(agentsPath)) return false;
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) return false;

  for (const relPath of manifest.rules) {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', relPath))) return false;
  }
  for (const name of manifest.skills) {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', 'skills', name, 'SKILL.md'))) {
      return false;
    }
  }
  return true;
}

module.exports = { hasMaterializedProjectAssets };
