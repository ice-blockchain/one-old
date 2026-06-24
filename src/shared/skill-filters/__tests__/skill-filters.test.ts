import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOOTSTRAP_SKILLS } from '../../../config/skill-filters';
import {
  activeSkillsFor,
  cleanActiveSkills,
  copyActiveSkills,
  pruneSkillsDirective,
  roleAgentBody,
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

test('cache surgery is a no-op outside the plugin cache path', () => {
  // pluginRoot resolves to this repo (not a .claude/plugins/cache path), so both return 0.
  assert.equal(cleanActiveSkills(), 0);
  assert.equal(copyActiveSkills('default'), 0);
});

// ── Role-scoped skill directives ──────────────────────────────────────────────────

test('roleDeclaredSkills parses the role agent-doc frontmatter (authoring repo path)', async () => {
  const { roleDeclaredSkills } = await import('../index');
  const skills = roleDeclaredSkills('senior-frontend');
  assert.ok(skills, 'senior-frontend agent doc resolves in the authoring repo');
  assert.ok(skills!.has('create-page'));
  assert.ok(skills!.has('frontend-design'));
  assert.ok(!skills!.has('postgres-patterns'));
});

test('roleSkillsDirective lists only the role∩stack skills, no wrong-stack dump', async () => {
  const { roleSkillsDirective } = await import('../index');
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true };
  const directive = roleSkillsDirective(state, 'senior-frontend', []);
  assert.ok(directive.includes('[ACTIVE SKILLS for senior-frontend on stack=default]'));
  assert.ok(directive.includes('create-page'));
  // Backend skills active on the stack must not leak into the frontend role list.
  assert.ok(!directive.includes('postgres-patterns'));
  // The long [DO NOT INVOKE] name dump is replaced by a single scope sentence.
  assert.ok(!directive.includes('[DO NOT INVOKE'));
  assert.ok(directive.includes('[SKILL SCOPE]'));
});

test('roleSkillsDirective falls back to the stack directive for unknown roles', async () => {
  const { roleSkillsDirective } = await import('../index');
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true };
  const fallback = roleSkillsDirective(state, 'not-a-real-role', []);
  assert.ok(fallback.includes('[ACTIVE SKILLS for stack=default]'));
});

test('roleAgentBody returns the role contract with frontmatter stripped (the body Cursor inlines)', () => {
  const body = roleAgentBody('senior-architect');
  assert.ok(body && body.length > 0, 'architect body resolved from the shipped/source agent doc');
  // Frontmatter is stripped — the body starts with prose, not a YAML block.
  assert.doesNotMatch(body as string, /^---\s*\nname:\s*senior-architect/, 'leading YAML frontmatter removed');
  // The body carries the host-only gate that must now reach Cursor.
  assert.match(body as string, /Required project-memory baseline/);
  assert.match(body as string, /ls \.traffic-one/);
});

test('roleAgentBody is null for malformed / unknown roles', () => {
  assert.equal(roleAgentBody('Not A Role'), null); // fails the [a-z0-9-] guard
  assert.equal(roleAgentBody(''), null);
  assert.equal(roleAgentBody('definitely-not-a-shipped-role'), null); // valid shape, no doc
});
