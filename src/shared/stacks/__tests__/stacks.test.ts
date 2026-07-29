import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

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

test('ionic-capacitor overlays the selected web framework without forcing React', () => {
  for (const frontend of ['react-vite', 'vue', 'angular']) {
    const manifest = composeRuleManifest({
      stack: 'custom-frontend',
      frontend,
      backend: 'external-api',
      mobile: { enabled: true, framework: 'ionic-capacitor' },
    });
    assert.ok(manifest.optional.includes('rules/frontend/ionic/capacitor.md'));
    assert.equal(
      manifest.mandatory.includes('rules/frontend/react/core.md'),
      frontend === 'react-vite',
      `${frontend} keeps only its selected base framework`,
    );
  }
});

test('ionic-capacitor contributes no rules without an explicit web framework', () => {
  const manifest = composeRuleManifest({
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'external-api',
    mobile: { enabled: true, framework: 'ionic-capacitor' },
  });
  assert.ok(!manifest.optional.includes('rules/frontend/ionic/capacitor.md'));
  assert.ok(!manifest.mandatory.includes('rules/frontend/react/core.md'));
});

test('roleScopedRules scopes per role and returns null for unknown roles', () => {
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  const fe = roleScopedRules('senior-frontend', state);
  assert.ok(fe && fe.includes('rules/frontend/i18n.md'));
  assert.ok(fe && fe.includes('rules/core.md'));
  const be = roleScopedRules('senior-backend', state);
  assert.ok(be && be.includes('rules/backend/postgres.md'));
  assert.ok(be && !be.includes('rules/core.md'));
  assert.equal(roleScopedRules('bogus', state), null);
});

test('API-only roles never inherit TypeScript or frontend rules from universal role bases', () => {
  const state = {
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'go',
    mobile: { framework: 'none' },
  };
  for (const role of ['senior-architect', 'senior-backend', 'senior-reviewer', 'senior-tester']) {
    const rules = roleScopedRules(role, state) || [];
    assert.ok(!rules.includes('rules/core.md'), `${role} leaked TypeScript core`);
    assert.ok(!rules.some((rule) => rule.startsWith('rules/frontend/')), `${role} leaked frontend rules`);
  }
  assert.ok(roleScopedRules('senior-backend', state)?.includes('rules/backend/golang.md'));
  assert.ok(!roleScopedRules('senior-backend', state)?.includes('rules/backend/postgres.md'));
});

test('stateless language backends get Postgres rules only with provider or data evidence', () => {
  for (const backend of ['node', 'python', 'go', 'laravel', 'rust']) {
    const manifest = composeRuleManifest({
      stack: 'custom-backend',
      frontend: 'none',
      backend,
      mobile: { framework: 'none' },
    });
    assert.equal(
      manifest.optional.includes('rules/backend/postgres.md'),
      false,
      `${backend} must not imply Postgres`,
    );
  }
  assert.ok(composeRuleManifest({
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'go',
    capabilitySurfaces: ['api', 'data'],
  }).optional.includes('rules/backend/postgres.md'));
  assert.ok(composeRuleManifest({
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'python',
    databaseProvider: 'postgresql',
  }).optional.includes('rules/backend/postgres.md'));
});

test('common rules stay stack-native and defer classification to runtime contracts', () => {
  const common = path.resolve(__dirname, '../../../modules/rules/rules/common');
  const clean = fs.readFileSync(path.join(common, 'clean-code.md'), 'utf8');
  assert.doesNotMatch(clean, /`const` by default|`camelCase` vars|800 hard cap|~50 lines max/);
  assert.match(clean, /per-component LOC, function-size,[\s\S]*top-level-function-count,[\s\S]*advisory[\s\S]*`WARN`/);
  assert.match(clean, /false-positive[\s\S]*below 1%/);
  // The one numeric threshold that blocks, and the escapes that keep it from
  // deadlocking a legitimately large or generated module.
  assert.match(clean, /400 logical lines[\s\S]*`STRUCT_MODULE_LOC`/);
  assert.match(clean, /`\*\.types\.ts`[\s\S]*are exempt/);

  const tooling = fs.readFileSync(path.join(common, 'quality-tooling.md'), 'utf8');
  assert.match(tooling, /JavaScript\/TypeScript only/);
  assert.match(tooling, /Go:[\s\S]*go test/);
  assert.match(tooling, /Python:[\s\S]*pytest/);
  assert.match(tooling, /Do not create `package\.json` scripts[\s\S]*non-JS projects/);

  const routing = fs.readFileSync(path.join(common, 'project-routing.md'), 'utf8');
  assert.match(routing, /capability-v1\.json/);
  assert.match(routing, /baseline sidecars/);
  assert.doesNotMatch(routing, /fewer than 5|@supabase\/supabase-js|State Supabase as the selected default/);
  assert.match(routing, /Go services, Python scripts\/CLIs\/workers, Laravel API-only projects/);
  assert.match(routing, /cannot reclassify those projects/);
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
