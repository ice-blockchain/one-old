import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOOTSTRAP_SKILLS } from '../../../config/skill-filters';
import {
  activeSkillsFor,
  cleanActiveSkills,
  copyActiveSkills,
  pruneSkillsDirective,
} from '../index';

test('activeSkillsFor(default state) unions common + react-vite + supabase', () => {
  const s = activeSkillsFor({ stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true });
  assert.ok(s.has('library-pick')); // a real _common skill
  assert.ok(!s.has('auth')); // phantom auth is no longer listed
  assert.ok(s.has('project-memory'));
  assert.ok(s.has('create-component')); // react-vite
  assert.ok(s.has('postgres-patterns')); // supabase
  assert.ok(!s.has('django-patterns'));
});

test('activeSkillsFor: pre-onboarding new project → no skills (bootstrap set is empty)', () => {
  const s = activeSkillsFor({ mode: 'new-project', onboardingComplete: false });
  assert.deepEqual([...s].sort(), [...BOOTSTRAP_SKILLS].sort());
  assert.equal(s.size, 0);
});

test('activeSkillsFor accepts a stack string (legacy alias)', () => {
  const s = activeSkillsFor('default');
  assert.ok(s.has('create-component'));
  assert.ok(s.has('postgres-patterns'));
});

test('pruneSkillsDirective lists active + flags wrong-stack skills', () => {
  const directive = pruneSkillsDirective(
    { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true },
    ['library-pick', 'django-patterns'],
  );
  assert.ok(directive.includes('[ACTIVE SKILLS for stack=default]'));
  assert.ok(directive.includes('[DO NOT INVOKE'));
  assert.ok(directive.includes('django-patterns'));
});

test('pruneSkillsDirective allow-list narrows the active set to the task scope', () => {
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true };
  const directive = pruneSkillsDirective(state, ['library-pick'], ['i18n-text']);
  const activeLine = directive.split('\n')[0] ?? '';
  // Narrowed active set is exactly the allow ∩ active (i18n-text is _common, so stack-active).
  assert.ok(activeLine.includes('[ACTIVE SKILLS for stack=default]: i18n-text'));
  // create-component is stack-active but out of this task's scope → not in the active line.
  assert.ok(!/\bcreate-component\b/.test(activeLine));
});

test('pruneSkillsDirective allow-list with no overlap falls open to the full active set (never strip all)', () => {
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true };
  const narrowed = (pruneSkillsDirective(state, ['library-pick'], ['totally-unknown-skill']).split('\n')[0]) ?? '';
  const full = (pruneSkillsDirective(state, ['library-pick']).split('\n')[0]) ?? '';
  assert.equal(narrowed, full);
});

test('cache surgery is a no-op outside the plugin cache path', () => {
  // pluginRoot resolves to this repo (not a .claude/plugins/cache path), so both return 0.
  assert.equal(cleanActiveSkills(), 0);
  assert.equal(copyActiveSkills('default'), 0);
});
