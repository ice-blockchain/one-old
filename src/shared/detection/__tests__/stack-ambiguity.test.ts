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

// ── the native/mobile chain ──────────────────────────────────────────────────
// Same defect, different mechanism. The frontend chain's fix was a subsumption
// table because its relationships are real (an Astro app depends on the UI
// library it renders). The native markers are all read at the ROOT, and the
// containment people reach for — a Flutter project holding an `android/` and an
// `ios/` subtree, a React Native project holding the same — happens in
// directories this probe never opens. So two markers AT THE ROOT are two
// toolchains claiming one directory, which is disagreement, not containment.

function withTree(build: (dir: string) => void, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-'));
  try {
    build(dir);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir: string, rel: string, body = ''): void {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, 'utf8');
}

// The premise for treating this as ambiguity rather than subsumption, measured
// rather than assumed: a COMPLETE Flutter layout and a COMPLETE React Native
// layout each resolve to exactly one framework, because their Gradle and Xcode
// projects sit under `android/` and `ios/` and nothing here descends.
test('a real Flutter or React Native layout has no competitor to resolve', () => {
  withTree((dir) => {
    write(dir, 'pubspec.yaml', 'name: app\n');
    write(dir, 'lib/main.dart', 'void main() {}\n');
    write(dir, 'android/settings.gradle', "include ':app'\n");
    write(dir, 'android/app/build.gradle', 'android {}\n');
    fs.mkdirSync(path.join(dir, 'ios', 'Runner.xcodeproj'), { recursive: true });
  }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.mobile?.framework, 'flutter', 'a Flutter project keeps its Android and Xcode projects in subtrees this probe never opens');
    assert.equal(detected.ambiguous, undefined, 'so there is nothing here to subsume — the nested markers are invisible, not outranked');
    assert.equal(detected.stack, 'custom-frontend');
  });

  withTree((dir) => {
    write(dir, 'package.json', JSON.stringify({ dependencies: { react: '18', 'react-native': '0.74' } }));
    write(dir, 'android/settings.gradle', "include ':app'\n");
    fs.mkdirSync(path.join(dir, 'ios', 'App.xcodeproj'), { recursive: true });
  }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.mobile?.framework, 'react-native-expo');
    assert.equal(detected.ambiguous, undefined, 'React Native\'s own android/ios projects are equally invisible here');
  });
});

// The deliverable. Verified against the old code first: this root resolved to
// `flutter` and the other two vanished, with only 'Flutter pubspec detected'
// left in the evidence — decided by nothing but if/else order.
test('competing native toolchains at the ROOT resolve to NO stack rather than an arbitrary winner', () => {
  withTree((dir) => {
    write(dir, 'pubspec.yaml', 'name: app\n');
    write(dir, 'Package.swift', '// swift-tools-version:5.9\n');
    write(dir, 'settings.gradle', "rootProject.name = 'app'\n");
  }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null, 'three toolchains claiming one directory is not a stack');
    assert.equal(detected.mobile, undefined, 'and no framework may be asserted while they disagree');
    assert.deepEqual(
      [...(detected.ambiguous || [])].sort(),
      ['flutter', 'kotlin-android', 'swift-native'],
      'all three must be NAMED — the dropped competitors are what made the old answer unreviewable',
    );
  });

  // Two is enough; Kotlin Multiplatform with an SPM export really does produce
  // this pair, and it is genuinely both rather than one hosting the other.
  withTree((dir) => {
    write(dir, 'Package.swift', '// swift-tools-version:5.9\n');
    write(dir, 'settings.gradle.kts', 'rootProject.name = "app"\n');
  }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null);
    assert.deepEqual([...(detected.ambiguous || [])].sort(), ['kotlin-android', 'swift-native']);
  });
});

// The root manifests and the package manifest are two independent probes of the
// SAME surface. The deps arm used to overwrite the root chain's answer with no
// comparison, so this tree reported `react-native-expo` while its own evidence
// still read 'Flutter pubspec detected'.
test('a package manifest that contradicts the root manifests is disagreement, not an override', () => {
  withTree((dir) => {
    write(dir, 'pubspec.yaml', 'name: app\n');
    write(dir, 'package.json', JSON.stringify({ dependencies: { 'react-native': '0.74' } }));
  }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null, 'a real RN project has no root pubspec and a real Flutter project has no react-native dependency');
    assert.equal(detected.mobile, undefined, 'the overwritten answer must not survive as a confident one');
    assert.deepEqual([...(detected.ambiguous || [])].sort(), ['flutter', 'react-native-expo']);
    assert.ok(
      detected.evidence.some((line) => /react-native\/expo .* root holds flutter/.test(line)),
      `the evidence must state the contradiction rather than assert one side (got ${JSON.stringify(detected.evidence)})`,
    );
  });
});

// Both chains detect their own disagreements and a project can have both, so the
// list accumulates. It used to be ASSIGNED by the frontend chain, which would
// have erased a native disagreement detected moments earlier.
test('native and frontend disagreements accumulate rather than overwrite each other', () => {
  withTree((dir) => {
    write(dir, 'pubspec.yaml', 'name: app\n');
    write(dir, 'settings.gradle', "rootProject.name = 'app'\n");
    write(dir, 'package.json', JSON.stringify({ dependencies: { vue: '3', svelte: '4' } }));
  }, (dir) => {
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null);
    assert.deepEqual(
      [...(detected.ambiguous || [])].sort(),
      ['flutter', 'kotlin-android', 'svelte', 'vue'],
      'all four competitors must reach the classification hints; a frontend disagreement must not erase the native one',
    );
  });
});

// A single native marker is the overwhelming majority and must be untouched.
test('a lone native toolchain still resolves exactly as before', () => {
  const singles: [string, (dir: string) => void][] = [
    ['flutter', (dir) => write(dir, 'pubspec.yaml', 'name: app\n')],
    ['swift-native', (dir) => write(dir, 'Package.swift', '//\n')],
    ['swift-native', (dir) => fs.mkdirSync(path.join(dir, 'App.xcodeproj'), { recursive: true })],
    ['kotlin-android', (dir) => write(dir, 'settings.gradle', '//\n')],
    ['kotlin-android', (dir) => write(dir, 'app/build.gradle', 'android {}\n')],
    ['react-native-expo', (dir) => write(dir, 'package.json', JSON.stringify({ dependencies: { expo: '51' } }))],
  ];
  for (const [expected, build] of singles) {
    withTree(build, (dir) => {
      const detected = detectStackFromCodebase(dir);
      assert.equal(detected.mobile?.framework, expected, `a lone ${expected} project must be unaffected by the ambiguity rule`);
      assert.equal(detected.ambiguous, undefined, `a lone ${expected} project has nothing to disagree about`);
      assert.equal(detected.stack, 'custom-frontend');
    });
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
