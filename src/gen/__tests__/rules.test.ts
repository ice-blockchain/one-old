import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedRuleTemplates } from '../emit/rules';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STRUCTURAL_PROFILE_IDS = [
  'vite-react',
  'next-app',
  'next-pages',
  'nuxt',
  'vue',
  'sveltekit',
  'svelte',
  'astro',
  'angular',
  'server-rendered',
  'generic-web',
  'unsupported-hybrid',
  'react-native',
  'swift-native',
  'kotlin-native',
  'flutter-native',
  'backend-only',
] as const;

test('generatedRuleTemplates re-gathers the full nested rules tree', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  assert.equal(docs.length, 96); // Previous 80 + 16 new profile-specific architecture rules.
  const paths = new Set(docs.map((d) => d.relPath));
  // Root, common, and deeply-nested rule paths are all preserved exactly.
  assert.ok(paths.has(path.join('rules', 'core.md')));
  assert.ok(paths.has(path.join('rules', 'common', 'auth-gate.md')));
  assert.ok(paths.has(path.join('rules', 'common', 'setup-gate.md')));
  assert.ok([...paths].some((p) => p.startsWith(path.join('rules', 'frontend', 'react'))));
  // Output is sorted + every doc carries content.
  const sorted = [...docs].map((d) => d.relPath).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(docs.map((d) => d.relPath), sorted);
  for (const doc of docs) assert.ok(doc.content.length > 0, `empty: ${doc.relPath}`);
});

test('new-project rules keep the universal spine stack-neutral and scope the default Vite playbook', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  const byPath = new Map(docs.map((doc) => [doc.relPath, doc.content]));
  const spine = byPath.get(path.join('rules', 'modes', 'new-project.md'));
  const vite = byPath.get(path.join('rules', 'modes', 'new-project-vite-react.md'));
  const setup = byPath.get(path.join('rules', 'modes', 'new-project-setup.md'));
  const architecture = byPath.get(path.join('rules', 'modes', 'new-project-architecture.md'));
  assert.ok(spine);
  assert.ok(vite);
  assert.ok(setup);
  assert.ok(architecture);
  assert.doesNotMatch(spine, /\b(?:React|Vite|Turborepo|Supabase|Playwright)\b|apps\/web/i);
  assert.match(spine, /runtime-compiled architecture contract/i);
  assert.match(spine, /runtime-owned assignments/i);
  assert.match(spine, /architect writes only the semantic plan\/project memory/i);
  assert.doesNotMatch(spine, /architect (?:creates|writes|scaffolds).*(?:package|workspace|Tailwind|barrel|assignments)/i);
  assert.match(vite, /profileId=vite-react/i);
  assert.match(vite, /eligible implementer\(s\), not the architect/i);
  assert.match(vite, /rules\/modes\/new-project-setup\.md/);
  assert.match(vite, /rules\/modes\/new-project-architecture\.md/);
  assert.match(setup, /Never apply[\s\S]*Next\.js[\s\S]*backend-only[\s\S]*native/i);
  assert.match(architecture, /not a fallback\s+architecture/i);
});

test('generated rules do not require architecture.md artifacts', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  for (const doc of docs) {
    assert.doesNotMatch(doc.content, /\b(write|create|ship|include)\s+`?architecture\.md`?/i, doc.relPath);
    assert.doesNotMatch(doc.content, /architecture\.md`\s*\(REQUIRED\)/i, doc.relPath);
    assert.doesNotMatch(doc.content, /package-architecture/i, doc.relPath);
  }
});

test('setup-gate evaluates pluginUse first, then makes auth and local preferences blocking', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  const setup = docs.find((d) => d.relPath === path.join('rules', 'common', 'setup-gate.md'));
  const existing = docs.find((d) => d.relPath === path.join('rules', 'modes', 'existing-codebase.md'));
  assert.ok(setup);
  assert.ok(existing);
  assert.match(setup.content, /per-project `pluginUse` decision is evaluated before this gate/);
  assert.match(setup.content, /Canonical wizard API-key auth is valid/);
  assert.match(setup.content, /Existing-project order is\s*OpenCode, Performance,\s*Team Confirmation for Balanced\/High, then Code Graph/);
  assert.match(existing.content, /rules\/common\/setup-gate\.md/);
  assert.doesNotMatch(existing.content, /non-blocking popup/);
});

test('i18n rule shows the link-in-sentence <Trans> case + a greppable reviewer tell (10b t()-fragment regression)', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  const i18n = docs.find((d) => d.relPath === path.join('rules', 'frontend', 'i18n.md'));
  assert.ok(i18n);
  // The MOST COMMON rich case (a sentence with an inline link) must be a worked
  // before/after example, not just a generic "links" mention — that nuance is what
  // 10b's frontend missed (LoginPage/SignupPage split it into t() fragments).
  assert.ok(i18n.content.includes("Don't have an account?"), 'common link-in-sentence example present');
  assert.ok(i18n.content.includes('<signup>Sign up</signup>'), '<Trans> components mapping shown');
  // A concrete, greppable reviewer tell — not just a judgment call.
  assert.match(i18n.content, /split sentence/i, 'split-sentence anti-pattern named');
  assert.match(i18n.content, /never imports `?Trans`?/i, 'no-Trans-import-in-rich-UI is flagged');
});

test('new policy rules exist and carry their canonical text', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  const find = (name: string) => docs.find((d) => d.relPath === path.join('rules', 'common', name));
  const routing = find('project-routing.md');
  const onboarding = find('onboarding.md');
  const precedence = find('skill-precedence.md');
  assert.ok(routing, 'project-routing.md missing');
  assert.ok(onboarding, 'onboarding.md missing');
  assert.ok(precedence, 'skill-precedence.md missing');
  // onboarding carries the invariant that existing projects skip new-project Q&A
  // (the wizard owns the questions now; this rule must not re-introduce a chat flow).
  assert.match(onboarding.content, /without\s+new-project Q&A/);
  assert.match(onboarding.content, /local setup wizard/);
  // skill-precedence carries the precedence policy moved off every skill.
  assert.match(precedence.content, /take precedence/);
  assert.match(precedence.content, /Do not implement via any skill until the setup gate/);
});

test('new-project architecture catalog is exhaustive and keeps cross-profile overlays honest', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  const byPath = new Map(docs.map((doc) => [doc.relPath, doc.content]));

  for (const profileId of STRUCTURAL_PROFILE_IDS) {
    const relPath = path.join('rules', 'modes', `new-project-${profileId}.md`);
    const content = byPath.get(relPath);
    assert.ok(content, `missing ${relPath}`);
    const frontmatter = content.split('---', 3)[1] || '';
    assert.ok(
      frontmatter.includes(`Apply only when CompiledArchitectureV1 profileId=${profileId}:`),
      `${relPath} must scope its frontmatter to exactly ${profileId}`,
    );
    const marker = `CompiledArchitectureV1.profile.profileId=${profileId}\``;
    assert.ok(content.includes(marker), `${relPath} must carry ${marker}`);
    assert.equal(
      STRUCTURAL_PROFILE_IDS.filter((id) => (
        content.includes(`CompiledArchitectureV1.profile.profileId=${id}\``)
      )).length,
      1,
      `${relPath} must claim exactly one structural profile`,
    );
  }

  const architecture = byPath.get(path.join(
    'rules',
    'modes',
    'new-project-architecture.md',
  ));
  assert.ok(architecture);
  for (const phrase of [
    'CapabilityProfileV1.skillBuckets',
    'ionic-capacitor',
    '@ionic/react',
    '@ionic/vue',
    '@ionic/angular',
    'never translate a Vue or Angular project into React',
    'VITE_API_URL',
    'AGENTS.md',
    'CLAUDE.md',
    '.traffic-one/**',
  ]) {
    assert.ok(architecture.includes(phrase), `architecture index missing ${phrase}`);
  }

  const laravel = byPath.get(path.join(
    'rules',
    'modes',
    'new-project-server-rendered.md',
  ));
  assert.ok(laravel);
  assert.ok(laravel.includes('Prettier and Pint coexistence'));
  assert.ok(laravel.includes('Use Prettier for JavaScript'));
  assert.ok(laravel.includes('Use Laravel Pint for PHP'));

  const unsupported = byPath.get(path.join(
    'rules',
    'modes',
    'new-project-unsupported-hybrid.md',
  ));
  assert.ok(unsupported);
  assert.ok(unsupported.includes('CAPABILITY_HYBRID_UI_TARGET_REQUIRED'));
  assert.ok(unsupported.includes('Do not produce a tree'));
  assert.ok(!unsupported.includes('```'), 'unsupported hybrid must not expose an implementable tree');
});
