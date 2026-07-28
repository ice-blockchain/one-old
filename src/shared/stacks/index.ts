// src/shared/stacks/index.ts
// Technology-aware rule manifests. Ported 1:1 from scripts/hook-runtime/stacks/*.
// relPath strings use the LOGICAL `rules/...` namespace; use templatePath() to
// read the source file from disk.

import { isMaintenancePhase } from '../state/lifecycle';
import { templatePath } from './template-path';
import { defaultStateForStack } from '../capabilities';

export { templatePath };

type Rec = Record<string, unknown>;

const COMMON_MANDATORY = [
  'rules/common/auth-gate.md',
  'rules/common/setup-gate.md',
  'rules/common/project-routing.md',
  'rules/common/skill-precedence.md',
  'rules/common/clean-code.md',
  'rules/common/execution-discipline.md',
  'rules/common/security.md',
  'rules/common/senior-engineer-team.md',
  'rules/common/project-memory.md',
  'rules/common/documentation.md',
  'rules/common/quality-tooling.md',
  'rules/common/agent-handoff-digests.md',
  'rules/common/codebase-graph.md',
];

const COMMON_REFERENCES = [
  'rules/common/library-catalog.md',
];

// Setup-time-only in the MANIFEST (~19.5 KB): the onboarding Q&A protocol and
// the stack pitches drop out of the mandatory/optional index once a project
// reaches maintenance. Both remain architect base rules below, so hash-only
// bootstrap envelopes still reference them — materialization keeps every
// envelope-referenced rule body on disk (as reference material) in all phases
// via roleScopedRuleUnion.
const ONBOARDING_ONLY_MANDATORY = ['rules/common/onboarding.md'];
const ONBOARDING_ONLY_REFERENCES = ['rules/common/stack-recommendations.md'];

const TYPESCRIPT_CORE = ['rules/core.md'];

const FRONTEND_SHARED = [
  'rules/frontend/i18n.md',
  'rules/frontend/ui-quality.md',
  'rules/frontend/typography.md',
];

const FRONTEND_OPTIONAL = [
  'rules/common/seo.md',
  'rules/frontend/accessibility.md',
  'rules/frontend/performance.md',
  'rules/frontend/realtime.md',
  'rules/frontend/services.md',
  'rules/frontend/testing.md',
  'rules/frontend/ui-quality-reference.md', // on-demand slice of ui-quality.md
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

const SUPABASE_REACT_MANDATORY = ['rules/frontend/react/supabase-client.md'];

const BACKEND_RULES: Readonly<Record<string, string[]>> = {
  supabase: [],
  'our-fork': [],
  postgres: [],
  postgresql: [],
  node: ['rules/backend/node.md'],
  nestjs: ['rules/backend/node.md'],
  python: ['rules/backend/python.md'],
  django: ['rules/backend/python.md'],
  fastapi: ['rules/backend/python.md'],
  go: ['rules/backend/golang.md'],
  rust: ['rules/backend/rust.md'],
  java: ['rules/backend/java.md'],
  kotlin: ['rules/backend/kotlin.md'],
  php: ['rules/backend/php.md'],
  laravel: ['rules/backend/php.md'],
  dotnet: ['rules/backend/csharp.md'],
  csharp: ['rules/backend/csharp.md'],
  cpp: ['rules/backend/cpp.md'],
  perl: ['rules/backend/perl.md'],
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function stateUsesPostgres(state: Rec, backend: string): boolean {
  if (['supabase', 'our-fork', 'postgres', 'postgresql'].includes(backend)) return true;
  const surfaces = [
    ...stringArray(state.capabilitySurfaces),
    ...stringArray(state.surfaces),
  ];
  const buckets = stringArray(state.capabilitySkillBuckets);
  if (surfaces.includes('data') || buckets.includes('postgres')) return true;
  return [
    state.database,
    state.databaseProvider,
    state.database_provider,
    state.db,
    state.dbProvider,
  ].some((value) => typeof value === 'string' && /\b(?:postgres|postgresql|supabase)\b/i.test(value));
}

export const AGENT_ROLE_BASE_RULES: Readonly<Record<string, string[]>> = {
  'senior-architect': [
    'rules/common/auth-gate.md', 'rules/common/setup-gate.md', 'rules/common/project-routing.md', 'rules/common/onboarding.md', 'rules/common/skill-precedence.md', 'rules/common/clean-code.md', 'rules/common/execution-discipline.md',
    'rules/common/stack-recommendations.md', 'rules/common/library-catalog.md', 'rules/common/project-memory.md',
    'rules/common/documentation.md', 'rules/common/senior-engineer-team.md', 'rules/common/codebase-graph.md',
    'rules/common/security.md', 'rules/common/agent-handoff-digests.md',
  ],
  'senior-frontend': [
    'rules/common/auth-gate.md', 'rules/common/setup-gate.md', 'rules/common/skill-precedence.md', 'rules/common/clean-code.md', 'rules/common/execution-discipline.md',
    'rules/common/security.md', 'rules/common/codebase-graph.md', 'rules/common/agent-handoff-digests.md',
    'rules/frontend/i18n.md', 'rules/frontend/ui-quality.md', 'rules/frontend/typography.md',
  ],
  'senior-backend': [
    'rules/common/auth-gate.md', 'rules/common/setup-gate.md', 'rules/common/skill-precedence.md', 'rules/common/clean-code.md', 'rules/common/execution-discipline.md',
    'rules/common/security.md', 'rules/common/quality-tooling.md', 'rules/common/codebase-graph.md',
    'rules/common/agent-handoff-digests.md',
  ],
  'senior-reviewer': [
    'rules/common/auth-gate.md', 'rules/common/setup-gate.md', 'rules/common/skill-precedence.md', 'rules/common/security.md', 'rules/common/quality-tooling.md',
    'rules/common/clean-code.md', 'rules/common/execution-discipline.md', 'rules/common/agent-handoff-digests.md',
    'rules/common/codebase-graph.md',
  ],
  'senior-tester': [
    'rules/common/auth-gate.md', 'rules/common/setup-gate.md', 'rules/common/skill-precedence.md', 'rules/common/quality-tooling.md', 'rules/common/execution-discipline.md',
    'rules/common/agent-handoff-digests.md', 'rules/common/codebase-graph.md',
  ],
  'senior-shipper': [
    'rules/common/auth-gate.md', 'rules/common/setup-gate.md', 'rules/common/skill-precedence.md', 'rules/common/security.md', 'rules/common/git.md',
    'rules/common/agent-handoff-digests.md', 'rules/common/quality-tooling.md',
  ],
  'quick-fix': [
    'rules/common/auth-gate.md', 'rules/common/setup-gate.md', 'rules/common/skill-precedence.md',
    'rules/common/clean-code.md', 'rules/common/execution-discipline.md', 'rules/common/quality-tooling.md',
  ],
};

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizedManifestState(input: unknown): Rec {
  if (typeof input === 'string') return defaultStateForStack(input);
  const state = input && typeof input === 'object' ? (input as Rec) : {};
  const mobile = state.mobile && typeof state.mobile === 'object' ? (state.mobile as Rec) : {};
  return {
    ...defaultStateForStack((state.stack as string) || 'minimal'),
    ...state,
    mobile: { enabled: false, framework: 'none', source: 'none', ...mobile },
  };
}

function stackLabel(state: Rec): string {
  const m = state.mobile as Rec | undefined;
  const mobile = m && m.enabled ? ` + mobile:${m.framework}` : '';
  return `${(state.stack as string) || 'minimal'} stack · frontend:${(state.frontend as string) || 'none'} · backend:${(state.backend as string) || 'none'}${mobile}`;
}

export interface RuleManifest {
  label: string;
  mandatory: string[];
  optional: string[];
}

export function composeRuleManifest(input: unknown): RuleManifest {
  const state = normalizedManifestState(input);
  const setupEra = !isMaintenancePhase(state, state.mode);
  const mandatory = [...COMMON_MANDATORY, ...(setupEra ? ONBOARDING_ONLY_MANDATORY : [])];
  const optional = [...COMMON_REFERENCES, ...(setupEra ? ONBOARDING_ONLY_REFERENCES : [])];
  const frontend = (state.frontend as string) || 'none';
  const backend = (state.backend as string) || 'none';
  const mobile = state.mobile as Rec | undefined;
  const mobileFramework = mobile ? mobile.framework : undefined;

  if (frontend === 'react-vite') {
    mandatory.push(...REACT_VITE_MANDATORY);
    optional.push(...REACT_VITE_OPTIONAL);
  } else if (frontend !== 'none') {
    mandatory.push(...FRONTEND_SHARED);
    if (['nextjs', 'nuxt', 'vue', 'svelte', 'angular', 'astro'].includes(frontend)) {
      mandatory.push(...TYPESCRIPT_CORE);
    }
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

  const backendRules = BACKEND_RULES[backend];
  if (backendRules) optional.push(...backendRules);
  if (stateUsesPostgres(state, backend)) optional.push('rules/backend/postgres.md');

  if (state.stack === 'minimal') {
    mandatory.push(...COMMON_REFERENCES, ...(setupEra ? ONBOARDING_ONLY_REFERENCES : []));
  }

  return { label: stackLabel(state), mandatory: unique(mandatory), optional: unique(optional) };
}

export function stackSpecForState(state: unknown): RuleManifest {
  return composeRuleManifest(state);
}

export function roleScopedRules(role: string, state: unknown): string[] | null {
  const base = AGENT_ROLE_BASE_RULES[role];
  if (!base) return null;
  const spec = stackSpecForState(state);
  const frontendRules = spec.mandatory.filter((r) => r.startsWith('rules/frontend/'));
  const backendRules = spec.optional.filter((r) => r.startsWith('rules/backend/'));
  const testingRules = spec.optional.filter((r) => /\/testing\.md$/.test(r));
  const languageRules = spec.mandatory.filter((r) => r === 'rules/core.md');
  if (role === 'senior-frontend') return unique([...base, ...languageRules, ...frontendRules]);
  if (role === 'senior-backend') return unique([...base, ...backendRules]);
  if (role === 'senior-tester') return unique([...base, ...languageRules, ...testingRules, ...backendRules]);
  if (role === 'senior-architect') return unique([...base, ...languageRules, ...frontendRules, ...backendRules]);
  if (role === 'senior-reviewer') return unique([...base, ...languageRules, ...frontendRules, ...backendRules]);
  if (role === 'quick-fix') return unique([...base, ...languageRules]);
  return base;
}

// Union of every rule id any envelope-eligible role can reference. Hash-only
// bootstrap envelopes (schemaVersion 2) carry no rule bodies, so
// materialization must keep this whole set on disk under .traffic-one/rules/**
// for children to read — including ids outside the manifest index (e.g. the
// shipper's rules/common/git.md and the architect's setup-era pair).
export function roleScopedRuleUnion(roles: readonly string[], state: unknown): string[] {
  return unique(roles.flatMap((role) => roleScopedRules(role, state) || []));
}

export const STACKS = {
  minimal: composeRuleManifest('minimal'),
  default: composeRuleManifest('default'),
  'custom-frontend': composeRuleManifest('custom-frontend'),
  'custom-backend': composeRuleManifest('custom-backend'),
  'custom-stack': composeRuleManifest('custom-stack'),
} satisfies Record<string, RuleManifest>;
