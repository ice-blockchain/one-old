'use strict';

const {
  BOOTSTRAP_SKILLS,
  SKILL_FILTERS,
  addSkillSet,
  normalizedSkillState,
} = require('./_helpers.cjs');

function activeSkillsFor(stackOrState) {
  const state = normalizedSkillState(stackOrState);
  if (state.mode === 'new-project' && state.onboardingComplete !== true) {
    return new Set(BOOTSTRAP_SKILLS);
  }
  const out = new Set(SKILL_FILTERS._common);
  if (state.frontend === 'react-vite') {
    addSkillSet(out, 'react-vite');
  } else if (state.frontend === 'nextjs') {
    addSkillSet(out, 'nextjs');
  } else if (state.frontend && state.frontend !== 'none') {
    addSkillSet(out, 'custom-web');
  }
  if (state.mobile && state.mobile.framework === 'ionic-capacitor') {
    addSkillSet(out, 'ionic-capacitor');
  }
  if (state.mobile && state.mobile.framework === 'react-native-expo') {
    addSkillSet(out, 'react-native-expo');
  }
  if (state.backend === 'supabase' || state.backend === 'our-fork') {
    addSkillSet(out, 'supabase');
  } else if (state.backend === 'nestjs') {
    addSkillSet(out, 'node');
  } else if (state.backend === 'fastapi') {
    addSkillSet(out, 'python');
  } else if (state.backend === 'laravel') {
    addSkillSet(out, 'php');
  } else if (state.backend === 'csharp') {
    addSkillSet(out, 'dotnet');
  } else if (state.backend && state.backend !== 'none' && state.backend !== 'external-api' && state.backend !== 'other') {
    addSkillSet(out, state.backend);
  }
  return out;
}

module.exports = { activeSkillsFor };
