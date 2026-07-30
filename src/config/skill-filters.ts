// src/config/skill-filters.ts
// Stack-aware skill catalog: BOOTSTRAP_SKILLS (host skills/ dir, not per-project)
// and SKILL_FILTERS (_common ∪ per-capability/per-stack sets). Host-specific
// skills and maintainer-only catalog entries are separate on purpose: `_common`
// is reserved for behavior that is valid in every end-user project on every
// host. The filtering logic (activeSkillsFor, pruneSkillsDirective, cache
// surgery) lives in shared/skill-filters/index.ts.

import type { HostId } from '../core/types';

export const BOOTSTRAP_SKILLS = new Set<string>();

// Host-native configuration scanners must never leak into another host's
// project policy. These sets are additive only after capability filtering.
export const HOST_SKILL_FILTERS: Readonly<Partial<Record<HostId, ReadonlySet<string>>>> = {
  claude: new Set(['security-scan']),
};

// Catalog entries in this set remain available to plugin maintainers from the
// source catalog, but are never selectable, copied, indexed, or bootstrapped in
// an end-user project.
export const PROJECT_UNAVAILABLE_SKILLS: ReadonlySet<string> = new Set([
  'model-tier-sync',
]);

export const SKILL_FILTERS: Readonly<Record<string, Set<string>>> = {
  _common: new Set([
    'library-pick', 'context-budget', 'execution-discipline',
    'git-commit', 'refactor', 'security-review',
    'repo-scan', 'verification-loop', 'tdd-workflow',
    'coding-standards',
    'architecture-decision-records', 'deployment-patterns',
    'auto-documentation-generator', 'project-memory',
    'documentation-lookup', 'observability',
    'predeploy-security-check', 'traffic-one-doctor',
    'senior-eng-orchestrator', 'token-usage-report',
    'task-triage',
  ]),
  'web-ui': new Set([
    'create-component', 'create-feature', 'create-page', 'create-service',
    'i18n-text', 'ui-demo', 'design-system', 'design-audit', 'browser-qa',
    'app-launch-checklist',
  ]),
  'native-ui': new Set([
    'i18n-text', 'design-audit', 'app-launch-checklist',
  ]),
  'backend-common': new Set([
    'backend-patterns',
  ]),
  api: new Set(['api-design', 'api-connector-builder']),
  'react-vite': new Set([
    'frontend-design', 'frontend-patterns', 'accessibility', 'ionic-mobile',
    'vite-patterns', 'click-path-audit', 'seo', 'e2e-testing', 'ai-regression-testing',
    'monorepo-architecture',
  ]),
  nextjs: new Set([
    'frontend-design', 'frontend-patterns', 'accessibility', 'click-path-audit', 'seo',
    'e2e-testing', 'nextjs-turbopack',
  ]),
  nuxt: new Set([
    'frontend-design', 'accessibility', 'click-path-audit', 'seo',
    'e2e-testing', 'nuxt4-patterns',
  ]),
  'custom-web': new Set([
    'frontend-design', 'accessibility', 'click-path-audit', 'seo', 'e2e-testing',
  ]),
  'ionic-capacitor': new Set([
    'ionic-mobile', 'frontend-design', 'frontend-patterns', 'accessibility', 'e2e-testing', 'browser-qa',
  ]),
  'react-native-expo': new Set([
    'create-native-component', 'create-native-feature', 'create-native-screen', 'create-native-service',
    'frontend-patterns', 'accessibility',
  ]),
  'swift-native': new Set([
    'swiftui-patterns', 'swift-actor-persistence', 'swift-concurrency-6-2',
    'swift-protocol-di-testing',
  ]),
  'kotlin-android': new Set([
    'android-clean-architecture', 'compose-multiplatform-patterns',
    'kotlin-patterns', 'kotlin-testing', 'kotlin-coroutines-flows',
  ]),
  flutter: new Set([
    'dart-flutter-patterns', 'flutter-dart-code-review',
  ]),
  supabase: new Set(['backend-patterns', 'supabase-setup']),
  postgres: new Set(['postgres-review', 'postgres-patterns', 'database-migrations']),
  node: new Set([
    'backend-patterns', 'nestjs-patterns',
    'hexagonal-architecture', 'docker-patterns', 'bun-runtime', 'mcp-server-patterns', 'dashboard-builder',
  ]),
  go: new Set(['golang-patterns', 'golang-testing', 'backend-patterns']),
  python: new Set(['python-patterns', 'python-testing', 'backend-patterns']),
  django: new Set(['django-patterns', 'django-security', 'django-tdd', 'django-verification', 'backend-patterns']),
  rust: new Set(['rust-patterns', 'rust-testing', 'backend-patterns']),
  java: new Set(['java-coding-standards', 'springboot-patterns', 'springboot-security', 'springboot-tdd', 'springboot-verification', 'jpa-patterns', 'jwt-security', 'backend-patterns']),
  kotlin: new Set(['kotlin-patterns', 'kotlin-testing', 'kotlin-ktor-patterns', 'kotlin-exposed-patterns', 'kotlin-coroutines-flows', 'jwt-security', 'backend-patterns']),
  php: new Set(['laravel-patterns', 'laravel-security', 'laravel-tdd', 'laravel-verification', 'backend-patterns']),
  dotnet: new Set(['dotnet-patterns', 'csharp-testing', 'backend-patterns']),
  cpp: new Set(['cpp-coding-standards', 'cpp-testing', 'backend-patterns']),
  perl: new Set(['perl-patterns', 'perl-security', 'perl-testing', 'backend-patterns']),
};
