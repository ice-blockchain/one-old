// The native surface is a SURFACE, not a competing answer to "which frontend".
//
// `detectStackFromCodebase` resolved three of the four native toolchains in its
// own step and the fourth — react-native, which is named by a dependency rather
// than a root file — as an arm of the frontend `if/else`. Two measured
// consequences, both fixed here and pinned below: `next` + `react-native` in one
// manifest dropped the native surface entirely while `next` + `pubspec.yaml`
// reported both, and a root holding `pubspec.yaml`, `next` and `react-native`
// stamped `flutter` with no ambiguity recorded at all, because the arm that
// compares the two probes was unreachable once a web framework matched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  NATIVE_FRAMEWORK_MARKERS,
  detectStackFromCodebase,
  nativeFrameworksAt,
} from '../artifacts';

function write(dir: string, rel: string, body = ''): void {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, 'utf8');
}

/**
 * One builder per framework in the shared table. Keyed by framework id and
 * checked for completeness below, so a fifth marker added to the table fails
 * this file as a FIXTURE error instead of quietly going untested.
 */
const MARKER_BUILDERS: Record<string, (dir: string) => void> = {
  'react-native-expo': (dir) => write(dir, 'package.json', JSON.stringify({ dependencies: { 'react-native': '0.74' } })),
  flutter: (dir) => write(dir, 'pubspec.yaml', 'name: app\n'),
  'swift-native': (dir) => write(dir, 'Package.swift', '// swift-tools-version:5.9\n'),
  'kotlin-android': (dir) => write(dir, 'settings.gradle', "rootProject.name = 'app'\n"),
};

function withTree(build: (dir: string) => void, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-surface-'));
  try {
    build(dir);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A detection fixture that stops being the shape it claims must fail AS A
 * FIXTURE, not pass because the detector correctly said nothing about a tree
 * that no longer holds the markers the test is named for.
 */
function assertFixture(dir: string, expected: readonly string[]): void {
  const actual = nativeFrameworksAt(dir, '.').map((marker) => marker.framework).sort();
  assert.deepEqual(
    actual,
    [...expected].sort(),
    `FIXTURE: the tree does not hold the native markers this case is about (wanted ${expected.join('+') || 'none'}, the table sees ${actual.join('+') || 'none'})`,
  );
}

const webPackage = (extra: Record<string, string> = {}) => JSON.stringify({
  dependencies: { next: '14', react: '18', ...extra },
});

test('every framework in the shared native table has a fixture builder', () => {
  const tabled = NATIVE_FRAMEWORK_MARKERS.map((marker) => marker.framework).sort();
  assert.deepEqual(
    Object.keys(MARKER_BUILDERS).sort(),
    tabled,
    'FIXTURE: the table and this file\'s builders have diverged — every native framework must be exercised here',
  );
});

// The parity that settles the direction. Three of these already reported both
// surfaces; react-native was the odd one out purely because of where its probe
// sat. Refusing the hybrid instead would have meant refusing a shape the
// capability profile already compiles (`CAPABILITY_HYBRID_UI_TARGET_REQUIRED`).
test('a web framework beside a native toolchain reports BOTH surfaces, for every native framework', () => {
  for (const framework of Object.keys(MARKER_BUILDERS)) {
    withTree((dir) => {
      MARKER_BUILDERS[framework]!(dir);
      // react-native shares the manifest the web framework is declared in; the
      // other three add a root file beside it.
      const existing: Record<string, string> = framework === 'react-native-expo'
        ? { 'react-native': '0.74' }
        : {};
      write(dir, 'package.json', webPackage(existing));
    }, (dir) => {
      assertFixture(dir, [framework]);
      const detected = detectStackFromCodebase(dir);
      assert.equal(detected.frontend, 'nextjs', `${framework}: the web surface must survive the native one`);
      assert.equal(detected.mobile?.framework, framework, `${framework}: the native surface must survive the web one`);
      assert.equal(detected.mobile?.enabled, true, `${framework}: a detected native surface is enabled`);
      assert.equal(detected.ambiguous, undefined, `${framework}: a web and a native framework are not competitors`);
      assert.equal(detected.stack, 'custom-frontend');
    });
  }
});

// The blast radius, measured rather than argued: `classifyDetectedSurfaces`
// takes `hasWebUi || hasNativeUi` down every arm that can fire here, so adding
// the native surface moves `mobile` and nothing else.
test('adding the native surface does not move the stack id', () => {
  const stackFor = (extra: Record<string, string>): string | null => {
    let stack: string | null = null;
    withTree((dir) => write(dir, 'package.json', webPackage(extra)), (dir) => {
      stack = detectStackFromCodebase(dir).stack;
    });
    return stack;
  };
  assert.equal(stackFor({}), 'custom-frontend');
  assert.equal(stackFor({ 'react-native': '0.74' }), 'custom-frontend', 'a native surface beside a web one is still custom-frontend');
  assert.equal(stackFor({ '@supabase/supabase-js': '2' }), 'custom-stack');
  assert.equal(
    stackFor({ '@supabase/supabase-js': '2', 'react-native': '0.74' }),
    'custom-stack',
    'and still custom-stack once a backend is present',
  );
});

// Previously: `flutter`, confidently, with 'Flutter pubspec detected' as its
// only evidence. The contradiction was invisible because the arm that reports
// it lived behind `else if` on a chain a matching web framework had already
// consumed.
test('a web framework no longer hides a contradiction between the native probes', () => {
  withTree((dir) => {
    write(dir, 'pubspec.yaml', 'name: app\n');
    write(dir, 'package.json', webPackage({ 'react-native': '0.74' }));
  }, (dir) => {
    assertFixture(dir, ['flutter', 'react-native-expo']);
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null, 'a root that is both a Flutter project and a React Native project is not a stack');
    assert.equal(detected.mobile, undefined, 'and no native framework may be asserted while they disagree');
    assert.deepEqual([...(detected.ambiguous || [])].sort(), ['flutter', 'react-native-expo']);
    assert.ok(
      detected.evidence.some((line) => /react-native\/expo .* root holds flutter/.test(line)),
      `the evidence must state the contradiction (got ${JSON.stringify(detected.evidence)})`,
    );
  });
});

// The property that keeps the shared table's PRECEDENCE out of this file's
// answers. It holds by construction — a framework is resolved only when there
// is exactly one contender — and this pins it across every pair, so a future
// "just pick the first one" cannot reintroduce an order-decided winner here.
test('no pair of native markers at the root ever resolves to a winner', () => {
  const frameworks = NATIVE_FRAMEWORK_MARKERS.map((marker) => marker.framework);
  let pairs = 0;
  for (let i = 0; i < frameworks.length; i += 1) {
    for (let j = i + 1; j < frameworks.length; j += 1) {
      const [first, second] = [frameworks[i]!, frameworks[j]!];
      pairs += 1;
      withTree((dir) => {
        MARKER_BUILDERS[first]!(dir);
        MARKER_BUILDERS[second]!(dir);
      }, (dir) => {
        assertFixture(dir, [first, second]);
        const detected = detectStackFromCodebase(dir);
        assert.equal(detected.mobile, undefined, `${first} + ${second}: two toolchains at one root is not a framework`);
        assert.equal(detected.stack, null, `${first} + ${second}: and it is not a stack`);
        assert.deepEqual(
          [...(detected.ambiguous || [])].sort(),
          [first, second].sort(),
          `${first} + ${second}: both must be named`,
        );
      });
    }
  }
  assert.equal(pairs, 6, 'FIXTURE: four frameworks make six pairs — the table changed size');
});
