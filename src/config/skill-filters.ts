// src/config/skill-filters.ts
// Stack-aware skill catalog: BOOTSTRAP_SKILLS (host skills/ dir, not per-project)
// and SKILL_FILTERS (_common ∪ per-stack sets). THE knob for which skills a stack
// activates. The filtering logic (activeSkillsFor, pruneSkillsDirective, cache
// surgery) lives in shared/skill-filters/index.ts.

export const BOOTSTRAP_SKILLS = new Set<string>();

export const SKILL_FILTERS: Readonly<Record<string, Set<string>>> = {
  _common: new Set([
    'library-pick', 'context-budget', 'execution-discipline',
    'git-commit', 'refactor', 'security-review', 'security-scan',
    'repo-scan', 'verification-loop', 'tdd-workflow',
    'coding-standards', 'i18n-text', 'ui-demo', 'design-system',
    'architecture-decision-records', 'deployment-patterns',
    'auto-documentation-generator', 'project-memory',
    'api-design', 'api-connector-builder',
    'documentation-lookup', 'observability', 'app-launch-checklist',
    'design-audit', 'browser-qa', 'supabase-setup', 'predeploy-security-check',
    'senior-eng-orchestrator', 'token-usage-report', 'model-tier-sync',
    'task-triage',
  ]),
  'react-vite': new Set([
    'create-component', 'create-feature', 'create-page', 'create-service',
    'frontend-design', 'frontend-patterns', 'accessibility', 'ionic-mobile',
    'vite-patterns', 'click-path-audit', 'seo', 'e2e-testing', 'ai-regression-testing',
    'monorepo-architecture',
  ]),
  nextjs: new Set([
    'frontend-design', 'frontend-patterns', 'accessibility', 'click-path-audit', 'seo',
    'e2e-testing', 'nextjs-turbopack',
  ]),
  'custom-web': new Set([
    'frontend-design', 'frontend-patterns', 'accessibility', 'click-path-audit', 'seo', 'e2e-testing',
  ]),
  'ionic-capacitor': new Set([
    'ionic-mobile', 'frontend-design', 'frontend-patterns', 'accessibility', 'e2e-testing', 'browser-qa',
  ]),
  'react-native-expo': new Set([
    'create-native-component', 'create-native-feature', 'create-native-screen', 'create-native-service',
    'frontend-patterns', 'accessibility', 'e2e-testing',
  ]),
  supabase: new Set(['backend-patterns', 'postgres-review', 'postgres-patterns', 'database-migrations', 'supabase-setup']),
  node: new Set([
    'backend-patterns', 'nestjs-patterns', 'postgres-review', 'postgres-patterns', 'database-migrations',
    'hexagonal-architecture', 'docker-patterns', 'bun-runtime', 'mcp-server-patterns', 'dashboard-builder',
  ]),
  go: new Set(['golang-patterns', 'golang-testing', 'backend-patterns']),
  python: new Set(['python-patterns', 'python-testing', 'backend-patterns']),
  django: new Set(['django-patterns', 'django-security', 'django-tdd', 'django-verification', 'backend-patterns']),
  rust: new Set(['rust-patterns', 'rust-testing', 'backend-patterns']),
  java: new Set(['java-coding-standards', 'springboot-patterns', 'springboot-security', 'springboot-tdd', 'springboot-verification', 'backend-patterns']),
  kotlin: new Set(['kotlin-patterns', 'kotlin-testing', 'kotlin-ktor-patterns', 'kotlin-exposed-patterns', 'backend-patterns']),
  php: new Set(['laravel-patterns', 'laravel-security', 'laravel-tdd', 'laravel-verification', 'backend-patterns']),
  dotnet: new Set(['dotnet-patterns', 'csharp-testing', 'backend-patterns']),
  cpp: new Set(['cpp-coding-standards', 'cpp-testing', 'backend-patterns']),
  perl: new Set(['perl-patterns', 'perl-security', 'perl-testing', 'backend-patterns']),
};
