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
    'api-design', 'api-connector-builder',
    'adaptive-communication',
    'design-audit', 'browser-qa',
    'supabase-setup', 'predeploy-security-check',
  ]),
  'react-realtime-monorepo': new Set([
    'create-component', 'create-feature', 'create-page', 'create-service',
    'frontend-design', 'frontend-patterns',
    'accessibility', 'ionic-mobile',
    'e2e-testing', 'ai-regression-testing',
    'postgres-review', 'postgres-patterns', 'database-migrations',
    'nextjs-turbopack',
  ]),
  'react-frontend-only': new Set([
    'create-component', 'create-feature', 'create-page', 'create-service',
    'frontend-design', 'frontend-patterns',
    'accessibility', 'ionic-mobile',
    'e2e-testing',
  ]),
  'react-native-expo-monorepo': new Set([
    'create-native-component', 'create-native-feature', 'create-native-screen',
    'create-native-service',
    'frontend-patterns', 'accessibility', 'e2e-testing',
    'android-clean-architecture',
    'swift-concurrency-6-2', 'swift-actor-persistence',
    'swift-protocol-di-testing', 'swiftui-patterns',
    'compose-multiplatform-patterns',
    'dart-flutter-patterns', 'flutter-dart-code-review',
  ]),
  'react-native-expo-app': new Set([
    'create-native-component', 'create-native-feature', 'create-native-screen',
    'create-native-service',
    'frontend-patterns', 'accessibility', 'e2e-testing',
  ]),
  'node-backend': new Set([
    'backend-patterns', 'nestjs-patterns',
    'postgres-review', 'postgres-patterns', 'database-migrations',
    'hexagonal-architecture', 'docker-patterns', 'bun-runtime',
    'mcp-server-patterns', 'dashboard-builder',
  ]),
  minimal: new Set(),
};

function activeSkillsFor(stack) {
  const out = new Set(SKILL_FILTERS._common);
  const stackSet = SKILL_FILTERS[stack];
  if (stackSet) {
    for (const name of stackSet) {
      out.add(name);
    }
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

function pruneSkillsDirective(stack, allSkills) {
  const active = activeSkillsFor(stack);
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
    `[ACTIVE SKILLS for stack=${stack}]: ${activeIntersect.join(', ')}\n` +
    `[DO NOT INVOKE — wrong stack]: ${inactivePreview}${inactiveSuffix}\n`
  );
}

function pruneCacheSkills(stack) {
  // Only mutate the cache when running from the plugin install path; source
  // repo dev work stays untouched.
  if (!isInPluginCache()) {
    return 0;
  }
  const skillsDir = path.join(pluginRoot(), 'skills');
  if (!fs.existsSync(skillsDir)) {
    return 0;
  }
  const active = activeSkillsFor(stack);
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
