import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOTSTRAP_SKILLS,
  activeSkillsFor,
  cleanActiveSkills,
  copyActiveSkills,
  pruneSkillsDirective,
} from '../index';

test('activeSkillsFor(default state) unions common + react-vite + supabase', () => {
  const s = activeSkillsFor({ stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true });
  assert.ok(s.has('auth'));
  assert.ok(s.has('project-memory'));
  assert.ok(s.has('create-component')); // react-vite
  assert.ok(s.has('postgres-patterns')); // supabase
  assert.ok(!s.has('django-patterns'));
});

test('activeSkillsFor: pre-onboarding new project → only bootstrap skills', () => {
  const s = activeSkillsFor({ mode: 'new-project', onboardingComplete: false });
  assert.deepEqual([...s].sort(), [...BOOTSTRAP_SKILLS].sort());
});

test('activeSkillsFor accepts a stack string (legacy alias)', () => {
  const s = activeSkillsFor('default');
  assert.ok(s.has('create-component'));
  assert.ok(s.has('postgres-patterns'));
});

test('pruneSkillsDirective lists active + flags wrong-stack skills', () => {
  const directive = pruneSkillsDirective(
    { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true },
    ['auth', 'django-patterns'],
  );
  assert.ok(directive.includes('[ACTIVE SKILLS for stack=default]'));
  assert.ok(directive.includes('[DO NOT INVOKE'));
  assert.ok(directive.includes('django-patterns'));
});

test('cache surgery is a no-op outside the plugin cache path', () => {
  // pluginRoot resolves to this repo (not a .claude/plugins/cache path), so both return 0.
  assert.equal(cleanActiveSkills(), 0);
  assert.equal(copyActiveSkills('default'), 0);
});
