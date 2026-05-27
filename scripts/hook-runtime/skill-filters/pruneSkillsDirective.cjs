'use strict';

const { normalizedSkillState } = require('./_helpers.cjs');
const { activeSkillsFor } = require('./activeSkillsFor.cjs');

// allSkills is the set of skills currently present in skills/ (bootstrap + any
// already copied this session). The directive always shows the full computed
// active set for the stack so the model knows what it can invoke — including
// skills not yet physically in skills/ (they arrive next session via
// copyActiveSkills, but are available now via the directive).
function pruneSkillsDirective(stackOrState, allSkills) {
  const active = activeSkillsFor(stackOrState);
  // Wrong-stack skills: physically in skills/ but not in the active set.
  // With lazy-load this will typically be empty (only bootstrap is in skills/).
  const wrongStack = [];
  for (const name of allSkills) {
    if (!active.has(name)) {
      wrongStack.push(name);
    }
  }
  const activeList = [...active].sort();
  if (activeList.length === 0) {
    return '';
  }
  const wrongStackPreview = wrongStack.slice(0, 30).join(', ');
  const wrongStackSuffix = wrongStack.length > 30 ? `, ... +${wrongStack.length - 30} more` : '';
  let directive = `[ACTIVE SKILLS for stack=${normalizedSkillState(stackOrState).stack}]: ${activeList.join(', ')}\n`;
  if (wrongStack.length > 0) {
    directive += `[DO NOT INVOKE — wrong stack]: ${wrongStackPreview}${wrongStackSuffix}\n`;
  }
  return directive;
}

module.exports = { pruneSkillsDirective };
