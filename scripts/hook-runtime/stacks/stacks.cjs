'use strict';

// scripts/hook-runtime/stacks/stacks.cjs
// Technology-aware rule manifests. `stack` now describes the user's high-level
// intent; concrete frontend/backend/mobile technologies decide which rules are
// loaded and later materialized into the project-local `.traffic-one/` folder.
//
// SOURCE LAYOUT: rule files live at `<plugin-root>/rules-templates/...` (the
// "templates" library, never auto-loaded by any harness). The relPath strings
// in this module use the LOGICAL `rules/...` namespace — that's the path users
// see in `.traffic-one/rules/active/` and the path callers reference. Use
// `templatePath(relPath)` whenever you need to read the source file from disk.
//
// Each function lives in its own file; this is the aggregating entry point.

const { AGENT_ROLE_BASE_RULES } = require('./_helpers.cjs');
const { composeRuleManifest } = require('./composeRuleManifest.cjs');
const { stackSpecForState } = require('./stackSpecForState.cjs');
const { roleScopedRules } = require('./roleScopedRules.cjs');
const { templatePath } = require('./templatePath.cjs');

const STACKS = {
  minimal: composeRuleManifest('minimal'),
  default: composeRuleManifest('default'),
  'custom-frontend': composeRuleManifest('custom-frontend'),
  'custom-backend': composeRuleManifest('custom-backend'),
  'custom-stack': composeRuleManifest('custom-stack'),
};

module.exports = {
  STACKS,
  composeRuleManifest,
  stackSpecForState,
  AGENT_ROLE_BASE_RULES,
  roleScopedRules,
  templatePath,
};
