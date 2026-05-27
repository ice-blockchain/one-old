'use strict';

// scripts/hook-runtime/directives/directives.cjs
// Long-form prose blocks that get injected into SessionStart context. Pitch
// wording is templated through `pitchBackendLabel` / `pitchDeployLabel` so
// Supabase stays the default backend while deploy wording can evolve as
// `/deploy` infra comes online.
//
// Each directive function lives in its own file; this is the aggregating entry
// point. The popup/fallback helpers are re-exported from ../onboarding-prompts.cjs.

const {
  hostPopupInstruction,
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
} = require('../onboarding-prompts.cjs');
const { onboardingDirectiveNewProject } = require('./onboardingDirectiveNewProject.cjs');
const { autoDetectedAnnouncement } = require('./autoDetectedAnnouncement.cjs');
const { onboardingReminderShort } = require('./onboardingReminderShort.cjs');
const { postWriteIncompleteWarning } = require('./postWriteIncompleteWarning.cjs');

module.exports = {
  onboardingDirectiveNewProject,
  autoDetectedAnnouncement,
  onboardingReminderShort,
  postWriteIncompleteWarning,
  hostPopupInstruction,
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
};
