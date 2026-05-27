'use strict';

// scripts/hook-runtime/skill-filters/skill-filters.cjs
// Stack-aware skill filtering. Two layers:
//   1. `pruneSkillsDirective(stack, allSkills)` — emits an [ACTIVE SKILLS for
//      stack=…] / [DO NOT INVOKE — wrong stack] block injected into
//      SessionStart context. The model uses it to ignore wrong-stack skills.
//   2. `copyActiveSkills(stackOrState)` — copies only relevant skill dirs from
//      skills-templates/ into skills/ in the plugin install path. The next
//      session's harness discovers only the filtered subset (real token saving).
//
// MULTI-PROJECT SAFETY: every SessionStart calls `cleanActiveSkills()` first
// to remove whatever the previous project's session copied, then copies the
// correct set for THIS project. Cache is shared across all traffic-one projects
// on the machine; this clean-then-copy pattern keeps each project converging
// to its own correct subset on session start.
//
// `_common` skills are always active regardless of stack.
// `BOOTSTRAP_SKILLS` are always kept in skills/ and never removed.
//
// Each function lives in its own file; this is the aggregating entry point.

const { SKILL_FILTERS, BOOTSTRAP_SKILLS } = require('./_helpers.cjs');
const { activeSkillsFor } = require('./activeSkillsFor.cjs');
const { listAllSkills } = require('./listAllSkills.cjs');
const { pruneSkillsDirective } = require('./pruneSkillsDirective.cjs');
const { cleanActiveSkills } = require('./cleanActiveSkills.cjs');
const { copyActiveSkills } = require('./copyActiveSkills.cjs');

module.exports = {
  SKILL_FILTERS,
  BOOTSTRAP_SKILLS,
  activeSkillsFor,
  listAllSkills,
  pruneSkillsDirective,
  cleanActiveSkills,
  copyActiveSkills,
  // Deprecated no-op shims — remove in next major release
  pruneCacheSkills:      () => 0,
  restoreDisabledSkills: () => 0,
};
