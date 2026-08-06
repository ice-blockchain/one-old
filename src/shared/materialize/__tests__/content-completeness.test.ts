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
