'use strict';

// scripts/hook-runtime/skill-filters.cjs
// Stack-aware skill filtering. Two layers:
//   1. `pruneSkillsDirective(stack, allSkills)` — emits an [ACTIVE SKILLS for
//      stack=…] / [DO NOT INVOKE — wrong stack] block injected into
//      SessionStart context. The model uses it to ignore wrong-stack skills.
//   2. `pruneCacheSkills(stack)` — physically renames irrelevant skill
//      directories to `.disabled-<name>` in the plugin install path. Claude
//      Code only auto-discovers non-hidden directories, so the NEXT session
//      loads only the filtered subset (real token saving).
//
// MULTI-PROJECT SAFETY: every SessionStart calls `restoreDisabledSkills()`
// first to undo whatever the previous project's session left, then re-prunes
// for THIS project's stack. Cache is shared across all traffic-one projects
// on the machine; this restore-then-reprune pattern keeps each project
// converging to its own correct subset on session start.
//
// `_common` skills are always active regardless of stack.

const fs   = require('fs');
const path = require('path');

const { pluginRoot, isInPluginCache } = require('./config.cjs');

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
      stack: input.stack || 'minimal',
      frontend: input.frontend || 'none',
      backend: input.backend || 'none',
      mobile: input.mobile && typeof input.mobile === 'object'
        ? input.mobile
        : { enabled: false, framework: 'none', source: 'none' },
    };
  }
  const stack = typeof input === 'string' ? input : 'minimal';
  if (stack === 'default' || stack === 'react-realtime-monorepo') {
    return { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { enabled: false, framework: 'none', source: 'none' } };
  }
  if (stack === 'react-frontend-only') {
    return { stack: 'custom-backend', frontend: 'react-vite', backend: 'none', mobile: { enabled: false, framework: 'none', source: 'none' } };
  }
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return { stack: 'custom-frontend', frontend: 'none', backend: 'supabase', mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' } };
  }
  return { stack, frontend: 'none', backend: 'none', mobile: { enabled: false, framework: 'none', source: 'none' } };
}

function activeSkillsFor(stackOrState) {
  const state = normalizedSkillState(stackOrState);
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

function listAllSkills() {
  const skillsDir = path.join(pluginRoot(), 'skills');
  if (!fs.existsSync(skillsDir)) {
    return new Set();
  }
  const out = new Set();
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      out.add(entry.name);
    }
  }
  return out;
}

function pruneSkillsDirective(stackOrState, allSkills) {
  const active = activeSkillsFor(stackOrState);
  const inactive = [];
  for (const name of allSkills) {
    if (!active.has(name)) {
      inactive.push(name);
    }
  }
  if (inactive.length === 0) {
    return '';
  }
  inactive.sort();
  const activeIntersect = [...active].filter((name) => allSkills.has(name)).sort();
  const inactivePreview = inactive.slice(0, 30).join(', ');
  const inactiveSuffix = inactive.length > 30 ? `, ... +${inactive.length - 30} more` : '';
  return (
    `[ACTIVE SKILLS for stack=${normalizedSkillState(stackOrState).stack}]: ${activeIntersect.join(', ')}\n` +
    `[DO NOT INVOKE — wrong stack]: ${inactivePreview}${inactiveSuffix}\n`
  );
}

function pruneCacheSkills(stackOrState) {
  // Only mutate the cache when running from the plugin install path; source
  // repo dev work stays untouched.
  if (!isInPluginCache()) {
    return 0;
  }
  const skillsDir = path.join(pluginRoot(), 'skills');
  if (!fs.existsSync(skillsDir)) {
    return 0;
  }
  const active = activeSkillsFor(stackOrState);
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (active.has(entry.name)) continue;
    const src = path.join(skillsDir, entry.name);
    const dst = path.join(skillsDir, `.disabled-${entry.name}`);
    if (fs.existsSync(dst)) continue;
    try {
      fs.renameSync(src, dst);
      removed += 1;
    } catch {
      // best-effort; skip on permission/race errors
    }
  }
  return removed;
}

function restoreDisabledSkills() {
  if (!isInPluginCache()) {
    return 0;
  }
  const skillsDir = path.join(pluginRoot(), 'skills');
  if (!fs.existsSync(skillsDir)) {
    return 0;
  }
  let restored = 0;
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('.disabled-')) continue;
    const realName = entry.name.slice('.disabled-'.length);
    const src = path.join(skillsDir, entry.name);
    const dst = path.join(skillsDir, realName);
    if (fs.existsSync(dst)) continue;
    try {
      fs.renameSync(src, dst);
      restored += 1;
    } catch {
      // best-effort
    }
  }
  return restored;
}

module.exports = {
  SKILL_FILTERS,
  activeSkillsFor,
  listAllSkills,
  pruneSkillsDirective,
  pruneCacheSkills,
  restoreDisabledSkills,
};
