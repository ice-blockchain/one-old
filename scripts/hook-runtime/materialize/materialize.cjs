'use strict';

// scripts/hook-runtime/materialize/materialize.cjs
// Project materialization: writes the project-local `.traffic-one/` active rule
// bundle, skills, and root AGENTS.md/CLAUDE.md from the selected stack state.
// Each exported function lives in its own file; this is the aggregating entry
// point. Private helpers live in ./_helpers.cjs.

const { GENERATED_MARKER } = require('./_helpers.cjs');
const { materializeProjectAssets } = require('./materializeProjectAssets.cjs');
const { hasMaterializedProjectAssets } = require('./hasMaterializedProjectAssets.cjs');
const { isPluginAuthoringRoot } = require('./isPluginAuthoringRoot.cjs');
const { isLeanMaterialization } = require('./isLeanMaterialization.cjs');
const { generateGraphPreview } = require('./generateGraphPreview.cjs');
const { writeGraphPreview } = require('./writeGraphPreview.cjs');

module.exports = {
  GENERATED_MARKER,
  materializeProjectAssets,
  hasMaterializedProjectAssets,
  isPluginAuthoringRoot,
  isLeanMaterialization,
  generateGraphPreview,
  writeGraphPreview,
};
