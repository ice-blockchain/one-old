'use strict';

const {
  COMMON_MANDATORY,
  COMMON_REFERENCES,
  TYPESCRIPT_CORE,
  FRONTEND_SHARED,
  REACT_VITE_MANDATORY,
  REACT_VITE_OPTIONAL,
  REACT_NATIVE_MANDATORY,
  REACT_NATIVE_OPTIONAL,
  IONIC_OPTIONAL,
  SUPABASE_REACT_MANDATORY,
  BACKEND_RULES,
  unique,
  normalizedManifestState,
  stackLabel,
} = require('./_helpers.cjs');

function composeRuleManifest(input) {
  const state = normalizedManifestState(input);
  const mandatory = [...COMMON_MANDATORY];
  const optional = [...COMMON_REFERENCES];
  const frontend = state.frontend || 'none';
  const backend = state.backend || 'none';
  const mobileFramework = state.mobile && state.mobile.framework;

  if (frontend === 'react-vite') {
    mandatory.push(...REACT_VITE_MANDATORY);
    optional.push(...REACT_VITE_OPTIONAL);
  } else if (frontend !== 'none') {
    mandatory.push(...TYPESCRIPT_CORE, ...FRONTEND_SHARED);
  }

  if (mobileFramework === 'react-native-expo') {
    mandatory.push(...REACT_NATIVE_MANDATORY);
    optional.push(...REACT_NATIVE_OPTIONAL);
  } else if (mobileFramework === 'ionic-capacitor') {
    if (frontend !== 'react-vite') {
      mandatory.push(...REACT_VITE_MANDATORY);
      optional.push(...REACT_VITE_OPTIONAL);
    }
    optional.push(...IONIC_OPTIONAL);
  }

  if ((backend === 'supabase' || backend === 'our-fork') && frontend === 'react-vite') {
    mandatory.push(...SUPABASE_REACT_MANDATORY);
  }

  if (BACKEND_RULES[backend]) {
    optional.push(...BACKEND_RULES[backend]);
  }

  if (state.stack === 'minimal') {
    mandatory.push(...COMMON_REFERENCES);
  }

  return {
    label: stackLabel(state),
    mandatory: unique(mandatory),
    optional: unique(optional),
  };
}

module.exports = { composeRuleManifest };
