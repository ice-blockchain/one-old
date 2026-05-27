'use strict';

const { AGENT_ROLE_BASE_RULES, unique } = require('./_helpers.cjs');
const { stackSpecForState } = require('./stackSpecForState.cjs');

// Returns the role-scoped rule paths for a subagent, or null if the role is
// unknown (caller falls back to the full mandatory set).
function roleScopedRules(role, state) {
  const base = AGENT_ROLE_BASE_RULES[role];
  if (!base) return null;
  const spec = stackSpecForState(state);
  const frontendRules = spec.mandatory.filter((r) => r.startsWith('rules/frontend/'));
  const backendRules  = spec.optional.filter((r) => r.startsWith('rules/backend/'));
  const testingRules  = spec.optional.filter((r) => /\/testing\.md$/.test(r));
  if (role === 'senior-frontend') {
    return unique([...base, ...frontendRules]);
  }
  if (role === 'senior-backend') {
    return unique([...base, ...backendRules]);
  }
  if (role === 'senior-tester') {
    return unique([...base, ...testingRules, ...backendRules]);
  }
  if (role === 'senior-architect') {
    // Architect gets a top-level view: stack-recommendations + a few frontend/
    // backend headers so they can write a plan that references actual rules.
    return unique([...base, ...frontendRules, ...backendRules]);
  }
  if (role === 'senior-reviewer') {
    // Reviewer reads diffs against all stack rules — include them for reference.
    return unique([...base, ...frontendRules, ...backendRules]);
  }
  return base;
}

module.exports = { roleScopedRules };
