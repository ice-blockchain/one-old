import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { detectStackFromCodebase } from '../artifacts';

// `detectStackFromCodebase` picked the first match in a fixed candidate array,
// so the array's own order decided every repo that names more than one
// framework — and it decided silently, producing a stack id downstream gates
// read as settled fact.

function withDeps(deps: Record<string, string>, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ambig-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: deps }), 'utf8');
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Measured before the subsumption table existed: astro+vue detected `vue` and
// astro+svelte detected `svelte`, while astro+react and astro+solid correctly
// detected `astro`. Nothing distinguished those cases except each candidate's
// index in the array. Rendering another framework's components is Astro's
// headline feature, so all four are ordinary Astro projects.
test('a meta-framework wins over the UI library it renders', () => {
  const cases: [string, Record<string, string>][] = [
    ['astro + vue', { astro: '4', '@astrojs/vue': '4', vue: '3' }],
    ['astro + svelte', { astro: '4', '@astrojs/svelte': '5', svelte: '4' }],
    ['astro + react', { astro: '4', '@astrojs/react': '3', react: '18' }],
    ['astro + solid', { astro: '4', 'solid-js': '1' }],
    ['astro + preact', { astro: '4', preact: '10' }],
  ];
  for (const [label, deps] of cases) {
    withDeps(deps, (dir) => {
      const detected = detectStackFromCodebase(dir);
      assert.equal(detected.frontend, 'astro', `${label} is an Astro project — the embedded library is evidence FOR astro, not a competitor`);
      assert.equal(detected.stack, 'custom-frontend', `${label} must still resolve to a stack`);
    });
  }

  withDeps({ nuxt: '3', vue: '3' }, (dir) => {
    assert.equal(detectStackFromCodebase(dir).frontend, 'nuxt', 'every Nuxt app ships vue');
  });
  withDeps({ next: '14', react: '18' }, (dir) => {
    assert.equal(detectStackFromCodebase(dir).frontend, 'nextjs', 'every Next app ships react');
  });
});

// The deliverable: disagreement resolves to "I do not know", not to a winner.
test('genuinely competing frameworks resolve to NO stack rather than an arbitrary winner', () => {
  withDeps({ next: '14', vue: '3' }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null, 'two unrelated frameworks is not a stack — null routes to the agent-classification step that already exists');
    assert.equal(detected.frontend, null, 'no frontend may be asserted when the manifests name two');
    assert.deepEqual(
      [...(detected.ambiguous || [])].sort(),
      ['nextjs', 'vue'],
      'both competitors must be NAMED so the classification hints can show them',
    );
  });

  withDeps({ '@angular/core': '17', svelte: '4', astro: '4' }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null, 'angular and astro are unrelated — astro subsumes svelte but not angular');
    assert.deepEqual(
      [...(detected.ambiguous || [])].sort(),
      ['angular', 'astro'],
      'svelte is subsumed by astro and must drop out; the surviving disagreement is angular vs astro',
    );
  });
});

// Order-independence is the actual property. The old behaviour was stable too —
// stably wrong — so asserting one answer twice proves nothing unless the inputs
// differ in the way that used to matter.
test('the verdict does not depend on the order dependencies are declared', () => {
  let first: unknown;
  withDeps({ next: '14', vue: '3' }, (dir) => { first = detectStackFromCodebase(dir).stack; });
  withDeps({ vue: '3', next: '14' }, (dir) => {
    assert.equal(detectStackFromCodebase(dir).stack, first, 'declaration order must not change the answer');
    assert.equal(first, null, 'and the order-independent answer must be null, not a stable arbitrary winner');
  });
});

// An unresolved frontend must not be laundered into a confident stack by a
// backend that WAS resolved: `custom-backend` asserts there is no UI, which is
// a stronger claim than the probe is entitled to make here.
test('an ambiguous frontend nulls the stack even when the backend is certain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ambig-'));
  try {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '14', '@angular/core': '17' } }),
      'utf8',
    );
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.backend, 'go', 'the backend evidence is unambiguous and survives');
    assert.equal(detected.stack, null, 'but an unresolved frontend must not be reported as custom-backend, which asserts there is no UI');
    assert.ok((detected.ambiguous || []).length > 1, 'the competing frontends are recorded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Single-framework repos are the overwhelming majority and must be untouched.
test('a single framework still resolves exactly as before', () => {
  const singles: [string, Record<string, string>][] = [
    ['nextjs', { next: '14' }],
    ['vue', { vue: '3' }],
    ['svelte', { svelte: '4' }],
    ['angular', { '@angular/core': '17' }],
    ['astro', { astro: '4' }],
    ['remix', { '@remix-run/react': '2' }],
    ['gatsby', { gatsby: '5' }],
    ['qwik', { '@builder.io/qwik': '1' }],
    ['lit', { lit: '3' }],
    ['ember', { 'ember-source': '5' }],
  ];
  for (const [expected, deps] of singles) {
    withDeps(deps, (dir) => {
      const detected = detectStackFromCodebase(dir);
      assert.equal(detected.frontend, expected, `a lone ${expected} project must be unaffected by the ambiguity rule`);
      assert.equal(detected.ambiguous, undefined, `a lone ${expected} project has nothing to disagree about`);
    });
  }
});
