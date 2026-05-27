'use strict';

const {
  loadExistingManifest,
  MANIFEST_ORDER,
} = require('./_helpers.cjs');

function normalizedCursorManifest() {
  const existing = loadExistingManifest();
  const interfaceData = existing.interface && typeof existing.interface === 'object' ? existing.interface : {};
  const defaults = {
    name: existing.name || 'traffic-one',
    displayName: existing.displayName || interfaceData.displayName || 'Traffic One',
    description:
      existing.description ||
      interfaceData.shortDescription ||
      'React, Ionic/Capacitor, and explicit React Native TypeScript workflow rules.',
    version: existing.version || '0.0.0',
    author: existing.author || { name: 'Traffic One' },
    keywords:
      existing.keywords || ['react', 'ionic', 'capacitor', 'react-native', 'typescript', 'turborepo', 'rtk-query', 'cursor-rules'],
    category: existing.category || 'engineering',
    tags: existing.tags || ['react', 'ionic', 'capacitor', 'react-native', 'typescript', 'testing', 'security'],
    skills: './skills/',
    rules: './.cursor/rules/',
  };

  for (const key of MANIFEST_ORDER) {
    if (Object.prototype.hasOwnProperty.call(existing, key) && !Object.prototype.hasOwnProperty.call(defaults, key) && key !== 'interface') {
      defaults[key] = existing[key];
    }
  }

  const ordered = {};
  for (const key of MANIFEST_ORDER) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      ordered[key] = defaults[key];
    }
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

module.exports = { normalizedCursorManifest };
