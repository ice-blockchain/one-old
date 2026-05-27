'use strict';

// scripts/hook-runtime/detection/detection.cjs
// Project mode + stack detection from package.json / workspace files.
// All read-only, all from the user's project cwd.
// Each function lives in its own file; this is the aggregating entry point.

const { loadPackageJson } = require('./loadPackageJson.cjs');
const { dependenciesFromPackage } = require('./dependenciesFromPackage.cjs');
const { hasWorkspaces } = require('./hasWorkspaces.cjs');
const { workspaceYamlPresent } = require('./workspaceYamlPresent.cjs');
const { countSourceFiles } = require('./countSourceFiles.cjs');
const { detectMode } = require('./detectMode.cjs');
const { detectStackFromCodebase } = require('./detectStackFromCodebase.cjs');
const { classifyPromptForStack } = require('./classifyPromptForStack.cjs');

module.exports = {
  loadPackageJson,
  dependenciesFromPackage,
  hasWorkspaces,
  workspaceYamlPresent,
  countSourceFiles,
  detectMode,
  detectStackFromCodebase,
  classifyPromptForStack,
};
