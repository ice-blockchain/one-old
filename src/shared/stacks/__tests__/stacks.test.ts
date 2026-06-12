import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_ROLE_BASE_RULES, STACKS, composeRuleManifest, roleScopedRules, templatePath } from '../index';

test('templatePath maps the logical namespace to the rules/ source (identity)', () => {
  assert.equal(templatePath('rules/common/auth-gate.md'), 'rules/common/auth-gate.md');
  assert.equal(templatePath('rules/core.md'), 'rules/core.md');
});

test('AGENT_ROLE_BASE_RULES covers all six senior roles with curated, auth-gated sets', () => {
  const roles = ['senior-architect', 'senior-frontend', 'senior-backend', 'senior-reviewer', 'senior-tester', 'senior-shipper'];
  for (const role of roles) {
    const rules = AGENT_ROLE_BASE_RULES[role];
    assert.ok(Array.isArray(rules) && rules.length > 0, `missing base rules for ${role}`);
    // auth-gate is the universal baseline for every role.
    assert.ok(rules.includes('rules/common/auth-gate.md'), `${role} should include the auth gate`);
    assert.ok(rules.includes('rules/common/setup-gate.md'), `${role} should include the setup gate`);
    // Every role carries the skill-precedence policy (skills are subordinate to rules).
    assert.ok(rules.includes('rules/common/skill-precedence.md'), `${role} should include skill precedence`);
  }
  // The architect additionally carries the routing + onboarding policy rules.
  assert.ok(AGENT_ROLE_BASE_RULES['senior-architect']?.includes('rules/common/project-routing.md'));
  assert.ok(AGENT_ROLE_BASE_RULES['senior-architect']?.includes('rules/common/onboarding.md'));
  // Role scoping is curated: the frontend role carries UI rules; the backend role does not.
  assert.ok(AGENT_ROLE_BASE_RULES['senior-frontend']?.some((r) => r.startsWith('rules/frontend/')));
  assert.ok(!AGENT_ROLE_BASE_RULES['senior-backend']?.some((r) => r === 'rules/frontend/ui-quality.md'));
});

test('STACKS exposes the five stack manifests', () => {
  assert.deepEqual(
    Object.keys(STACKS).sort(),
    ['custom-backend', 'custom-frontend', 'custom-stack', 'default', 'minimal'],
  );
});

test('default stack: react + supabase mandatory, postgres optional, no dupes', () => {
  const m = STACKS.default;
  assert.ok(m.mandatory.includes('rules/common/auth-gate.md'));
  assert.ok(m.mandatory.includes('rules/common/setup-gate.md'));
  assert.ok(m.mandatory.includes('rules/common/project-routing.md'));
  assert.ok(m.mandatory.includes('rules/common/onboarding.md'));
  assert.ok(m.mandatory.includes('rules/common/skill-precedence.md'));
  assert.ok(m.mandatory.includes('rules/frontend/react/core.md'));
  assert.ok(m.mandatory.includes('rules/frontend/react/supabase-client.md'));
  assert.ok(m.optional.includes('rules/backend/postgres.md'));
  assert.equal(new Set(m.mandatory).size, m.mandatory.length);
  assert.equal(new Set(m.optional).size, m.optional.length);
});

test('minimal stack pushes common references into mandatory', () => {
  assert.ok(STACKS.minimal.mandatory.includes('rules/common/stack-recommendations.md'));
});

test('ionic-capacitor adds the react base + ionic optional rules', () => {
  const m = composeRuleManifest({
    stack: 'custom-frontend', frontend: 'none', backend: 'supabase',
    mobile: { enabled: true, framework: 'ionic-capacitor' },
  });
  assert.ok(m.mandatory.includes('rules/frontend/react/core.md'));
  assert.ok(m.optional.includes('rules/frontend/ionic/capacitor.md'));
});

test('roleScopedRules scopes per role and returns null for unknown roles', () => {
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  const fe = roleScopedRules('senior-frontend', state);
  assert.ok(fe && fe.includes('rules/frontend/i18n.md'));
  const be = roleScopedRules('senior-backend', state);
  assert.ok(be && be.includes('rules/backend/postgres.md'));
  assert.equal(roleScopedRules('bogus', state), null);
});

test('onboarding-only rules drop out of maintenance-phase manifests', () => {
  // Building (new project, pre-build): onboarding protocol + stack pitches present.
  const building = composeRuleManifest({ stack: 'default', mode: 'new-project' });
  assert.ok(building.mandatory.includes('rules/common/onboarding.md'));
  assert.ok(building.optional.includes('rules/common/stack-recommendations.md'));

  // Maintenance (build complete): both are setup-era content and disappear.
  const maintained = composeRuleManifest({ stack: 'default', mode: 'new-project', lifecycle: { phase: 'maintenance' } });
  assert.ok(!maintained.mandatory.includes('rules/common/onboarding.md'));
  assert.ok(!maintained.optional.includes('rules/common/stack-recommendations.md'));

  // Existing codebases are maintenance from first detection — never materialized.
  const existing = composeRuleManifest({ stack: 'minimal', mode: 'existing-codebase' });
  assert.ok(!existing.mandatory.includes('rules/common/onboarding.md'));
  assert.ok(!existing.mandatory.includes('rules/common/stack-recommendations.md'));
  assert.ok(existing.mandatory.includes('rules/common/library-catalog.md'), 'library-catalog stays useful post-setup');
});
