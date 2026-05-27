'use strict';

const fs = require('fs');
const path = require('path');
const {
  dependencyNames,
  addTechForDependency,
} = require('./_helpers.cjs');

function collectTechnologies(cwd, state, fileExtensions) {
  const techs = new Set();
  const stateTech = state && state.technologies && typeof state.technologies === 'object' ? state.technologies : {};
  for (const values of Object.values(stateTech)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized) techs.add(normalized);
    }
  }

  for (const dep of dependencyNames(cwd)) addTechForDependency(techs, dep);
  if (fileExtensions.ts || fileExtensions.tsx) techs.add('typescript');
  if (fileExtensions.js || fileExtensions.jsx || fileExtensions.mjs || fileExtensions.cjs) techs.add('javascript');
  if (fileExtensions.go) techs.add('go');
  if (fileExtensions.rs) techs.add('rust');
  if (fileExtensions.py) techs.add('python');
  if (fileExtensions.kt || fileExtensions.kts) techs.add('kotlin');
  if (fileExtensions.swift) techs.add('swift');
  if (fileExtensions.dart) techs.add('dart');
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) techs.add('pnpm');
  return [...techs].filter(Boolean).sort().slice(0, 50);
}

module.exports = { collectTechnologies };
