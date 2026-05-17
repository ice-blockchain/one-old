'use strict';

// scripts/hook-runtime/stacks.cjs
// Technology-aware rule manifests. `stack` now describes the user's high-level
// intent; concrete frontend/backend/mobile technologies decide which rules are
// loaded and later materialized into the project-local `.traffic-one/` folder.

const COMMON_MANDATORY = [
  'rules/common/clean-code.md',
  'rules/common/execution-discipline.md',
  'rules/common/security.md',
  'rules/common/senior-engineer-team.md',
  'rules/common/project-memory.md',
  'rules/common/documentation.md',
  'rules/common/seo.md',
  'rules/common/quality-tooling.md',
  'rules/common/agent-handoff-digests.md',
  'rules/common/codebase-graph.md',
];

const COMMON_REFERENCES = [
  'rules/common/stack-recommendations.md',
  'rules/common/library-catalog.md',
];

const TYPESCRIPT_CORE = [
  'rules/core.md',
];

const FRONTEND_SHARED = [
  'rules/frontend/i18n.md',
  'rules/frontend/ui-quality.md',
  'rules/frontend/typography.md',
];

const FRONTEND_OPTIONAL = [
  'rules/frontend/accessibility.md',
  'rules/frontend/performance.md',
  'rules/frontend/realtime.md',
  'rules/frontend/services.md',
  'rules/frontend/testing.md',
];

const REACT_VITE_MANDATORY = [
  ...TYPESCRIPT_CORE,
  'rules/frontend/react/core.md',
  ...FRONTEND_SHARED,
  'rules/frontend/react/design-quality.md',
];

const REACT_VITE_OPTIONAL = [
  ...FRONTEND_OPTIONAL,
  'rules/frontend/react/components.md',
  'rules/frontend/react/vite.md',
  'rules/frontend/react/stores.md',
  'rules/frontend/react/services.md',
  'rules/frontend/react/realtime.md',
  'rules/frontend/react/performance.md',
  'rules/frontend/react/testing.md',
  'rules/frontend/react/security.md',
];

const REACT_NATIVE_MANDATORY = [
  ...TYPESCRIPT_CORE,
  'rules/frontend/react-native/core.md',
  ...FRONTEND_SHARED,
];

const REACT_NATIVE_OPTIONAL = [
  ...FRONTEND_OPTIONAL,
  'rules/frontend/react-native/navigation.md',
  'rules/frontend/react-native/components.md',
  'rules/frontend/react-native/styles.md',
  'rules/frontend/react-native/stores.md',
  'rules/frontend/react-native/services.md',
  'rules/frontend/react-native/realtime.md',
  'rules/frontend/react-native/performance.md',
  'rules/frontend/react-native/accessibility.md',
  'rules/frontend/react-native/testing.md',
  'rules/frontend/react-native/security.md',
];

const IONIC_OPTIONAL = [
  'rules/frontend/ionic/core.md',
  'rules/frontend/ionic/capacitor.md',
  'rules/frontend/ionic/navigation.md',
  'rules/frontend/ionic/components.md',
  'rules/frontend/ionic/styles.md',
  'rules/frontend/ionic/services.md',
  'rules/frontend/ionic/stores.md',
  'rules/frontend/ionic/realtime.md',
  'rules/frontend/ionic/performance.md',
  'rules/frontend/ionic/security.md',
  'rules/frontend/ionic/testing.md',
  'rules/frontend/ionic/accessibility.md',
];

const SUPABASE_REACT_MANDATORY = [
  'rules/frontend/react/supabase-client.md',
];

const BACKEND_RULES = {
  supabase: ['rules/backend/postgres.md'],
  'our-fork': ['rules/backend/postgres.md'],
  postgres: ['rules/backend/postgres.md'],
  node: ['rules/backend/node.md', 'rules/backend/postgres.md'],
  nestjs: ['rules/backend/node.md', 'rules/backend/postgres.md'],
  python: ['rules/backend/python.md', 'rules/backend/postgres.md'],
  django: ['rules/backend/python.md', 'rules/backend/postgres.md'],
  fastapi: ['rules/backend/python.md', 'rules/backend/postgres.md'],
  go: ['rules/backend/golang.md', 'rules/backend/postgres.md'],
  rust: ['rules/backend/rust.md', 'rules/backend/postgres.md'],
  java: ['rules/backend/java.md', 'rules/backend/postgres.md'],
  kotlin: ['rules/backend/kotlin.md', 'rules/backend/postgres.md'],
  php: ['rules/backend/php.md', 'rules/backend/postgres.md'],
  laravel: ['rules/backend/php.md', 'rules/backend/postgres.md'],
  dotnet: ['rules/backend/csharp.md', 'rules/backend/postgres.md'],
  csharp: ['rules/backend/csharp.md', 'rules/backend/postgres.md'],
  cpp: ['rules/backend/cpp.md'],
  perl: ['rules/backend/perl.md', 'rules/backend/postgres.md'],
};

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function defaultStateForStack(stack) {
  if (stack === 'default') {
    return {
      stack,
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
    };
  }
  if (stack === 'custom-backend') {
    return {
      stack,
      frontend: 'react-vite',
      backend: 'other',
      mobile: { enabled: false, framework: 'none', source: 'none' },
    };
  }
  return {
    stack,
    frontend: 'none',
    backend: stack === 'minimal' ? 'none' : 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'none' },
  };
}

function normalizedManifestState(input) {
  if (typeof input === 'string') {
    return defaultStateForStack(input);
  }
  const state = input && typeof input === 'object' ? input : {};
  return {
    ...defaultStateForStack(state.stack || 'minimal'),
    ...state,
    mobile: {
      enabled: false,
      framework: 'none',
      source: 'none',
      ...(state.mobile && typeof state.mobile === 'object' ? state.mobile : {}),
    },
  };
}

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

function stackLabel(state) {
  const mobile = state.mobile && state.mobile.enabled ? ` + mobile:${state.mobile.framework}` : '';
  return `${state.stack || 'minimal'} stack · frontend:${state.frontend || 'none'} · backend:${state.backend || 'none'}${mobile}`;
}

const STACKS = {
  minimal: composeRuleManifest('minimal'),
  default: composeRuleManifest('default'),
  'custom-frontend': composeRuleManifest('custom-frontend'),
  'custom-backend': composeRuleManifest('custom-backend'),
  'custom-stack': composeRuleManifest('custom-stack'),
};

function stackSpecForState(state) {
  return composeRuleManifest(state);
}

// PER-ROLE RULE SCOPING.
// When the orchestrator signals via `state.activeAgentRole` which subagent is
// being spawned, the SessionStart hook emits a slim rule index scoped to that
// role's actual needs — instead of the kitchen-sink mandatory bundle.
//
// Each role's base set is small, curated, and supplemented with stack-specific
// rules computed dynamically (e.g. frontend gets React rules from the active
// stack spec). Anything not listed here is still materialized to
// .traffic-one/rules/active/ and can be read on demand.
const AGENT_ROLE_BASE_RULES = {
  'senior-architect': [
    'rules/common/clean-code.md',
    'rules/common/execution-discipline.md',
    'rules/common/stack-recommendations.md',
    'rules/common/library-catalog.md',
    'rules/common/project-memory.md',
    'rules/common/documentation.md',
    'rules/common/senior-engineer-team.md',
    'rules/common/codebase-graph.md',
    'rules/common/security.md',
    'rules/common/agent-handoff-digests.md',
    'rules/core.md',
  ],
  'senior-frontend': [
    'rules/common/clean-code.md',
    'rules/common/execution-discipline.md',
    'rules/common/security.md',
    'rules/common/codebase-graph.md',
    'rules/common/agent-handoff-digests.md',
    'rules/core.md',
    'rules/frontend/i18n.md',
    'rules/frontend/ui-quality.md',
    'rules/frontend/typography.md',
  ],
  'senior-backend': [
    'rules/common/clean-code.md',
    'rules/common/execution-discipline.md',
    'rules/common/security.md',
    'rules/common/quality-tooling.md',
    'rules/common/codebase-graph.md',
    'rules/common/agent-handoff-digests.md',
    'rules/core.md',
  ],
  'senior-reviewer': [
    'rules/common/security.md',
    'rules/common/quality-tooling.md',
    'rules/common/clean-code.md',
    'rules/common/execution-discipline.md',
    'rules/common/agent-handoff-digests.md',
    'rules/common/codebase-graph.md',
  ],
  'senior-tester': [
    'rules/common/quality-tooling.md',
    'rules/common/execution-discipline.md',
    'rules/common/agent-handoff-digests.md',
    'rules/common/codebase-graph.md',
    'rules/frontend/testing.md',
  ],
  'senior-shipper': [
    'rules/common/security.md',
    'rules/common/git.md',
    'rules/common/agent-handoff-digests.md',
    'rules/common/quality-tooling.md',
  ],
};

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

module.exports = {
  STACKS,
  composeRuleManifest,
  stackSpecForState,
  AGENT_ROLE_BASE_RULES,
  roleScopedRules,
};
