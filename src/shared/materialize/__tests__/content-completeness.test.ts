// The PREMISE of materialize.ts's tornRootRefusal, asserted rather than assumed.
//
// That refusal decides "this plugin root is torn" from a shortfall: the runtime
// declares a candidate set (stacks.ts's rule manifests, config/skill-filters.ts's
// skill buckets) and the root failed to satisfy all of it. The inference is only
// sound while a COMPLETE install satisfies the whole candidate set — and nothing
// but this file enforces that. A single skill name added to SKILL_FILTERS without
// its catalog directory, or a rule id added to a manifest without the file, would
// otherwise make materialization refuse for every project of that shape, on a
// perfectly healthy install, with no test between the typo and the release.
//
// So this is not a tautology test. It is the tripwire that has to fail FIRST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
  BOOTSTRAP_SKILLS,
  HOST_SKILL_FILTERS,
  PROJECT_UNAVAILABLE_SKILLS,
  SKILL_FILTERS,
} from '../../../config/skill-filters';
import { STRUCTURAL_PROFILE_IDS } from '../../capabilities';
import { MODE_SPINE_RULE_BY_MODE, modeRuleCandidatesForState } from '../cleanup';
import { AGENT_ROLE_BASE_RULES, composeRuleManifest, roleScopedRuleUnion, templatePath } from '../../stacks';

// The SOURCE trees `npm run gen` re-emits byte-identical as `rules/**` and
// `skills-catalog/**` (src/gen/emit/{rules,skills}.ts), so checking them here is
// checking what a complete install ships.
const RULES_SOURCE = path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules');
const CATALOG_SOURCE = path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog');

// Every axis composeRuleManifest / skillBucketsForState branch on. Not a sample:
// a shape that is missing here is a shape whose refusal nothing would catch.
const STACKS = ['minimal', 'default', 'custom-frontend', 'custom-backend', 'custom-stack'];
const FRONTENDS = ['none', 'react-vite', 'nextjs', 'nuxt', 'vue', 'svelte', 'angular', 'astro', 'custom-web'];
const BACKENDS = [
  'none', 'supabase', 'our-fork', 'postgres', 'postgresql', 'node', 'nestjs', 'python', 'django',
  'fastapi', 'go', 'rust', 'java', 'kotlin', 'php', 'laravel', 'dotnet', 'csharp', 'cpp', 'perl',
];
const MOBILES = ['none', 'react-native-expo', 'ionic-capacitor', 'swift-native', 'kotlin-native', 'flutter-native'];
const MODES = ['new-project', 'existing-codebase'];
const PHASES = [undefined, { phase: 'maintenance' }];

// The whole tree read once. The cross product below asks about the same ~100
// paths tens of thousands of times, and one readdir is cheaper than 150k stats.
function shippedRuleIds(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}/`);
      else if (entry.isFile()) out.add(`rules/${rel}`);
    }
  };
  walk(RULES_SOURCE, '');
  return out;
}

test('every rule id the runtime can ask a plugin root for exists in the shipped rules tree', () => {
  const shipped = shippedRuleIds();
  assert.ok(shipped.size > 90, `expected the whole rules tree, got ${shipped.size}`);
  const missing = new Map<string, string>();
  let shapes = 0;
  for (const stack of STACKS) {
    for (const frontend of FRONTENDS) {
      for (const backend of BACKENDS) {
        for (const framework of MOBILES) {
          for (const mode of MODES) {
            for (const lifecycle of PHASES) {
              shapes += 1;
              const state = {
                stack,
                frontend,
                backend,
                mobile: { enabled: framework !== 'none', framework },
                mode,
                onboardingComplete: true,
                confirmed: true,
                ...(lifecycle ? { lifecycle } : {}),
              };
              const spec = composeRuleManifest(state);
              const envelope = roleScopedRuleUnion(Object.keys(AGENT_ROLE_BASE_RULES), state);
              for (const relPath of [...spec.mandatory, ...spec.optional, ...envelope]) {
                if (shipped.has(templatePath(relPath))) continue;
                if (!missing.has(relPath)) missing.set(relPath, `${stack}/${frontend}/${backend}/${framework}/${mode}`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(shapes > 10000, `expected the full cross product, checked ${shapes}`);
  assert.deepEqual(
    [...missing].map(([relPath, shape]) => `${relPath} (e.g. ${shape})`),
    [],
    'a rule id with no file makes tornRootRefusal fire on a HEALTHY install for every project of that shape',
  );
});

// The same tripwire for the MODE half of the candidate set, which joined it when
// the rules/modes/** tear was closed. The exposure is larger here than for the
// stack manifests, because the mode candidates are declared in two hand-written
// tables (MODE_SPINE_RULE_BY_MODE, NEW_PROJECT_PROFILE_RULE_BY_ID) rather than
// composed: an entry whose file does not ship would make materialization refuse
// on a HEALTHY install for every project of that mode/profile.
test('every mode rule the runtime can ask a plugin root for exists in the shipped rules tree', () => {
  const shipped = shippedRuleIds();
  const missing = new Map<string, string>();
  let shapes = 0;
  // `stack` is in the cross product because DEFAULT_VITE_NEW_PROJECT_SETUP_RULE
  // is selected from it, and `undefined` because a profile that has not resolved
  // yet must fail closed to the spine rather than to a guessed profile rule.
  for (const mode of Object.keys(MODE_SPINE_RULE_BY_MODE)) {
    for (const profileId of [...STRUCTURAL_PROFILE_IDS, undefined, 'a-profile-a-future-release-adds']) {
      for (const stack of STACKS) {
        shapes += 1;
        for (const relPath of modeRuleCandidatesForState({ mode, stack }, profileId)) {
          if (shipped.has(templatePath(relPath))) continue;
          if (!missing.has(relPath)) missing.set(relPath, `${mode}/${profileId ?? 'no-profile'}/${stack}`);
        }
      }
    }
  }
  assert.ok(shapes > 100, `expected the full cross product, checked ${shapes}`);
  assert.deepEqual(
    [...missing].map(([relPath, shape]) => `${relPath} (e.g. ${shape})`),
    [],
    'a declared mode rule with no file makes the completeness refusal fire on a HEALTHY install',
  );
  // Positively: the tables are actually reached. A candidate function that
  // silently returned [] would satisfy the emptiness assertion above forever.
  assert.deepEqual(
    modeRuleCandidatesForState({ mode: 'new-project', stack: 'default' }, 'vite-react'),
    [
      'rules/modes/new-project.md',
      'rules/modes/new-project-vite-react.md',
      'rules/modes/new-project-architecture.md',
      'rules/modes/new-project-setup.md',
    ],
  );
  // …and a mode that ships no rule declares no candidate, which is the whole
  // reason the spine is a table. detectMode also answers `existing-with-supabase`,
  // and asking a root for `rules/modes/existing-with-supabase.md` would report
  // every healthy install as torn for those projects.
  assert.deepEqual(modeRuleCandidatesForState({ mode: 'existing-with-supabase' }, 'vite-react'), []);
  assert.deepEqual(modeRuleCandidatesForState({}, undefined), []);
});

// The one branch of modeRulesForState with no config-side authority: slices
// named `<mode>-<topic>.md` are found by reading the root's own directory, so a
// slice a torn tree lost is invisible. That is tolerable ONLY while the live
// surface is empty — no shipped mode has a slice, so nothing can be swept
// through it today. This pins that, and fails the moment a slice is added, which
// is the moment the family needs an authority.
test('no shipped mode has rule slices, so the one self-referential branch has no live surface', () => {
  const modesDir = path.join(RULES_SOURCE, 'modes');
  const names = fs.readdirSync(modesDir).filter((name) => name.endsWith('.md'));
  const slices = Object.keys(MODE_SPINE_RULE_BY_MODE)
    // `new-project` returns through the profile branch above the slice readdir,
    // so its `new-project-*.md` family never reaches it.
    .filter((mode) => mode !== 'new-project')
    .flatMap((mode) => names.filter((name) => name.startsWith(`${mode}-`)));
  assert.deepEqual(
    slices,
    [],
    'a mode slice is resolved by reading the plugin root itself and cannot be declared — see cleanup.ts modeRulesForState',
  );
});

test('every skill name any bucket can select exists in the shipped catalog', () => {
  const named = new Set<string>();
  for (const bucket of Object.values(SKILL_FILTERS)) for (const name of bucket) named.add(name);
  for (const hostSet of Object.values(HOST_SKILL_FILTERS)) for (const name of hostSet ?? []) named.add(name);

  assert.ok(named.size > 90, `expected the whole bucket inventory, got ${named.size}`);
  assert.deepEqual(
    [...named].filter((name) => !fs.existsSync(path.join(CATALOG_SOURCE, name, 'SKILL.md'))).sort(),
    [],
    'a bucket name with no catalog entry makes tornRootRefusal fire on a HEALTHY install',
  );
});

// The pairing that makes a half-copied catalog detectable at all: a directory
// present without its SKILL.md is a shape only a torn tree can produce, because
// the shipped catalog never has one. A legitimate removal takes the directory
// with it, which is exactly why the refusal cannot fire on an upgrade.
test('the shipped catalog pairs every skill directory with a SKILL.md', () => {
  const dirs = fs.readdirSync(CATALOG_SOURCE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(dirs.length > 100, `expected the full catalog, got ${dirs.length}`);
  assert.deepEqual(dirs.filter((name) => !fs.existsSync(path.join(CATALOG_SOURCE, name, 'SKILL.md'))), []);
});

// The one project-unavailable entry is deliberately absent from every bucket, so
// the candidate set (which filters it out) can never ask a root for it.
test('project-unavailable skills are never candidates', () => {
  const named = new Set<string>();
  for (const bucket of Object.values(SKILL_FILTERS)) for (const name of bucket) named.add(name);
  for (const name of PROJECT_UNAVAILABLE_SKILLS) {
    assert.equal(named.has(name), false, `${name} is unavailable to projects and must not sit in a bucket`);
  }
  for (const name of BOOTSTRAP_SKILLS) {
    assert.ok(fs.existsSync(path.join(CATALOG_SOURCE, name, 'SKILL.md')), `bootstrap skill ${name} must ship`);
  }
});
