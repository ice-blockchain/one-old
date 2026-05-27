#!/usr/bin/env node
'use strict';

const { generatedRuleDocuments } = require('./sync-cursor/generatedRuleDocuments.cjs');
const { normalizedCursorManifest } = require('./sync-cursor/normalizedCursorManifest.cjs');
const { renderCursorRule } = require('./sync-cursor/renderCursorRule.cjs');
const { syncCursor } = require('./sync-cursor/syncCursor.cjs');

function parseArgs(argv) {
  return {
    check: argv.includes('--check'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/sync-cursor.cjs [--check]');
    return 0;
  }
  try {
    return syncCursor({ check: args.check });
  } catch (error) {
    console.error(`cursor sync failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  generatedRuleDocuments,
  normalizedCursorManifest,
  renderCursorRule,
  syncCursor,
};
