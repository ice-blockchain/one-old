import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STACKS, composeRuleManifest, roleScopedRules, templatePath } from '../index';

test('templatePath rewrites the logical namespace to the source library', () => {
  assert.equal(templatePath('rules/common/auth-gate.md'), 'rules-templates/common/auth-gate.md');
  assert.equal(templatePath('rules/core.md'), 'rules-templates/core.md');
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
