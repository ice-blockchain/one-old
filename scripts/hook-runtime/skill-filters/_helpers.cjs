'use strict';

// scripts/hook-runtime/skill-filters/_helpers.cjs
// Shared constants + private helpers for stack-aware skill filtering.
// `_common` skills are always active regardless of stack.
// `BOOTSTRAP_SKILLS` are always kept in skills/ and never removed.

const fs   = require('fs');
const path = require('path');

const SKILLS_TEMPLATES_DIR = 'skills-templates';
const SKILLS_ACTIVE_DIR    = 'skills';
const BOOTSTRAP_SKILLS     = new Set(['stack-setup', 'detect-project', 'traffic-one-doctor']);

const SKILL_FILTERS = {
  _common: new Set([
    'stack-setup', 'library-pick', 'context-budget', 'execution-discipline',
    'git-commit', 'refactor', 'security-review', 'security-scan',
    'detect-project', 'repo-scan', 'verification-loop', 'tdd-workflow',
    'coding-standards', 'i18n-text', 'ui-demo', 'design-system',
    'architecture-decision-records', 'deployment-patterns',
    'auto-documentation-generator', 'project-memory',
    'api-design', 'api-connector-builder',
    'adaptive-communication',
    'documentation-lookup',
    'observability',
    'app-launch-checklist',
    'design-audit', 'browser-qa',
    'supabase-setup', 'predeploy-security-check',
    'senior-eng-orchestrator',
    'traffic-one-doctor',
    'token-usage-report',
    'model-tier-sync',
  ]),
  'react-vite': new Set([
    'create-component', 'create-feature', 'create-page', 'create-service',
    'frontend-design', 'frontend-patterns',
    'accessibility', 'ionic-mobile',
    'vite-patterns', 'click-path-audit', 'seo',
    'e2e-testing', 'ai-regression-testing',
    'monorepo-architecture',
  ]),
  nextjs: new Set([
    'frontend-design', 'frontend-patterns',
    'accessibility', 'click-path-audit', 'seo',
    'e2e-testing',
    'nextjs-turbopack',
  ]),
  'custom-web': new Set([
    'frontend-design', 'frontend-patterns',
    'accessibility', 'click-path-audit', 'seo',
    'e2e-testing',
  ]),
  'ionic-capacitor': new Set([
    'ionic-mobile', 'frontend-design', 'frontend-patterns',
    'accessibility', 'e2e-testing', 'browser-qa',
  ]),
  'react-native-expo': new Set([
    'create-native-component', 'create-native-feature', 'create-native-screen',
    'create-native-service',
    'frontend-patterns', 'accessibility', 'e2e-testing',
  ]),
  supabase: new Set([
    'backend-patterns',
    'postgres-review', 'postgres-patterns', 'database-migrations',
    'supabase-setup',
  ]),
  node: new Set([
    'backend-patterns', 'nestjs-patterns',
    'postgres-review', 'postgres-patterns', 'database-migrations',
    'hexagonal-architecture', 'docker-patterns', 'bun-runtime',
    'mcp-server-patterns', 'dashboard-builder',
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

function addSkillSet(out, name) {
  const stackSet = SKILL_FILTERS[name];
  if (!stackSet) return;
  for (const skillName of stackSet) {
    out.add(skillName);
  }
}

function normalizedSkillState(input) {
  if (input && typeof input === 'object') {
    return {
      mode: input.mode || 'unknown',
      stack: input.stack || 'minimal',
      frontend: input.frontend || 'none',
      backend: input.backend || 'none',
      onboardingComplete: input.onboardingComplete === true,
      mobile: input.mobile && typeof input.mobile === 'object'
        ? input.mobile
        : { enabled: false, framework: 'none', source: 'none' },
    };
  }
  const stack = typeof input === 'string' ? input : 'minimal';
  if (stack === 'default' || stack === 'react-realtime-monorepo') {
    return { mode: 'unknown', stack: 'default', frontend: 'react-vite', backend: 'supabase', onboardingComplete: true, mobile: { enabled: false, framework: 'none', source: 'none' } };
  }
  if (stack === 'react-frontend-only') {
    return { mode: 'unknown', stack: 'custom-backend', frontend: 'react-vite', backend: 'none', onboardingComplete: true, mobile: { enabled: false, framework: 'none', source: 'none' } };
  }
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return { mode: 'unknown', stack: 'custom-frontend', frontend: 'none', backend: 'supabase', onboardingComplete: true, mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' } };
  }
  return { mode: 'unknown', stack, frontend: 'none', backend: 'none', onboardingComplete: true, mobile: { enabled: false, framework: 'none', source: 'none' } };
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

module.exports = {
  SKILLS_TEMPLATES_DIR,
  SKILLS_ACTIVE_DIR,
  BOOTSTRAP_SKILLS,
  SKILL_FILTERS,
  addSkillSet,
  normalizedSkillState,
  copyDirSync,
};
