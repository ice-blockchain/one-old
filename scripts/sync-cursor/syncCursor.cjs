'use strict';

const fs = require('fs');

const {
  staleCursorRules,
  diffSummary,
  writeTextIfChanged,
  relative,
  CURSOR_PLUGIN_MANIFEST,
} = require('./_helpers.cjs');
const { generatedRuleDocuments } = require('./generatedRuleDocuments.cjs');
const { normalizedCursorManifest } = require('./normalizedCursorManifest.cjs');

function syncCursor({ check }) {
  const expectedRules = generatedRuleDocuments();
  const expectedPaths = new Set(expectedRules.map((document) => document.outputPath));
  const staleRules = staleCursorRules(expectedPaths);
  const manifest = normalizedCursorManifest();
  const differences = diffSummary(expectedRules, staleRules, manifest);

  if (check) {
    if (differences.length > 0) {
      console.log('Cursor sync is out of date:');
      for (const difference of differences) {
        console.log(`  - ${difference}`);
      }
      console.log('\nRun: node scripts/sync-cursor.cjs');
      return 1;
    }
    console.log('Cursor sync is up to date.');
    return 0;
  }

  const changed = [];
  for (const document of expectedRules) {
    if (writeTextIfChanged(document.outputPath, document.content)) {
      changed.push(relative(document.outputPath));
    }
  }

  for (const filePath of staleRules) {
    fs.unlinkSync(filePath);
    changed.push(relative(filePath));
  }

  if (writeTextIfChanged(CURSOR_PLUGIN_MANIFEST, manifest)) {
    changed.push(relative(CURSOR_PLUGIN_MANIFEST));
  }

  if (changed.length > 0) {
    console.log('Updated Cursor sync artifacts:');
    for (const filePath of changed) {
      console.log(`  - ${filePath}`);
    }
  } else {
    console.log('Cursor sync artifacts already up to date.');
  }
  return 0;
}

module.exports = { syncCursor };
