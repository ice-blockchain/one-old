// Two detectors answer "which native framework is this": the stamp's root chain
// in `detectStackFromCodebase` and `detectedNativeFramework`, which is the one
// the capability profile consumes. They carried separate marker tables in
// different orders, and the divergence was live — measured over the 1,024-tree
// marker space, a root holding `project.pbxproj` plus a `react-native`
// dependency was a confident React Native project to one and, once the tables
// agree, a contradiction to the other.
//
// They now read ONE table. What remains different is deliberate: this file pins
// both the agreement and the two intended asymmetries, so neither can drift
// back into an accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  NATIVE_FRAMEWORK_MARKERS,
  detectStackFromCodebase,
  nativeFrameworksAt,
} from '../../detection/artifacts';
import { detectedNativeFramework } from '../detect-backend';
import { capabilityProfileForProject } from '../index';

function write(dir: string, rel: string, body = ''): void {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, 'utf8');
}

const MARKER_BUILDERS: Record<string, (dir: string, root: string) => void> = {
  'react-native-expo': (dir, root) => write(dir, `${root}/package.json`, JSON.stringify({ dependencies: { 'react-native': '0.74' } })),
  flutter: (dir, root) => write(dir, `${root}/pubspec.yaml`, 'name: app\n'),
  'swift-native': (dir, root) => write(dir, `${root}/Package.swift`, '// swift-tools-version:5.9\n'),
  'kotlin-android': (dir, root) => write(dir, `${root}/settings.gradle`, "rootProject.name = 'app'\n"),
};

function withTree(build: (dir: string) => void, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-parity-'));
  try {
    build(dir);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertFixture(dir: string, root: string, expected: readonly string[]): void {
  const actual = nativeFrameworksAt(dir, root).map((marker) => marker.framework).sort();
  assert.deepEqual(
    actual,
    [...expected].sort(),
    `FIXTURE: ${root} does not hold the markers this case is about (wanted ${expected.join('+') || 'none'}, the table sees ${actual.join('+') || 'none'})`,
  );
}

test('both native detectors agree on every single-toolchain project root', () => {
  for (const framework of Object.keys(MARKER_BUILDERS)) {
    withTree((dir) => MARKER_BUILDERS[framework]!(dir, '.'), (dir) => {
      assertFixture(dir, '.', [framework]);
      assert.equal(detectStackFromCodebase(dir).mobile?.framework, framework, `${framework}: the stamp`);
      assert.equal(detectedNativeFramework(dir, {}).framework, framework, `${framework}: the profile's detector`);
    });
  }
});

// One table means one EVIDENCE SET too, not just one order. `project.pbxproj`
// used to be Swift evidence to the profile detector and invisible to the stamp,
// which is why a root holding it plus a `react-native` dependency was a
// confident React Native project to the stamp while the profile detector had
// already seen a second toolchain there.
test('both detectors read the same Swift evidence, project.pbxproj included', () => {
  for (const marker of ['Package.swift', 'project.pbxproj']) {
    withTree((dir) => write(dir, marker, '//\n'), (dir) => {
      assertFixture(dir, '.', ['swift-native']);
      assert.equal(detectStackFromCodebase(dir).mobile?.framework, 'swift-native', `${marker}: the stamp`);
      assert.equal(detectedNativeFramework(dir, {}).framework, 'swift-native', `${marker}: the profile's detector`);
    });
  }

  withTree((dir) => {
    write(dir, 'project.pbxproj', '//\n');
    MARKER_BUILDERS['react-native-expo']!(dir, '.');
  }, (dir) => {
    assertFixture(dir, '.', ['react-native-expo', 'swift-native']);
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.mobile, undefined, 'evidence only one detector could see used to make this a confident react-native project');
    assert.deepEqual([...(detected.ambiguous || [])].sort(), ['react-native-expo', 'swift-native']);
  });
});

// The order is the table's, not each call site's. Asserted against the table
// itself rather than a hardcoded list, so reordering the table moves this test's
// expectation with it — which is the point of there being one table.
test('the profile detector applies the shared table order, outer framework first', () => {
  const frameworks = NATIVE_FRAMEWORK_MARKERS.map((marker) => marker.framework);
  for (let i = 0; i < frameworks.length; i += 1) {
    for (let j = i + 1; j < frameworks.length; j += 1) {
      const [outer, inner] = [frameworks[i]!, frameworks[j]!];
      withTree((dir) => {
        MARKER_BUILDERS[outer]!(dir, '.');
        MARKER_BUILDERS[inner]!(dir, '.');
      }, (dir) => {
        assertFixture(dir, '.', [outer, inner]);
        assert.equal(
          detectedNativeFramework(dir, {}).framework,
          outer,
          `${outer} + ${inner}: a wrapper framework contains the platform projects it generates, so it is asked about first`,
        );
      });
    }
  }
  assert.equal(
    frameworks[0],
    'react-native-expo',
    'FIXTURE: the outer-to-inner premise starts at react-native — the table was reordered without revisiting it',
  );
});

// The table is queried framework-major, not root-major: the search space is
// widened to FIND the app, not to let whichever candidate root sorts first
// decide which framework the project is. Root-major is the obvious
// implementation and answers `kotlin-android` here.
test('precedence beats proximity when two candidate roots hold different toolchains', () => {
  withTree((dir) => {
    MARKER_BUILDERS['react-native-expo']!(dir, '.');
    MARKER_BUILDERS['kotlin-android']!(dir, 'apps/mobile');
  }, (dir) => {
    assertFixture(dir, '.', ['react-native-expo']);
    assertFixture(dir, 'apps/mobile', ['kotlin-android']);
    assert.deepEqual(
      detectedNativeFramework(dir, {}),
      { framework: 'react-native-expo', root: '.' },
      'a react-native app contains the Gradle project it generates, so it outranks one found nearer the top of the candidate list',
    );
    assert.equal(detectStackFromCodebase(dir).mobile?.framework, 'react-native-expo', 'and the stamp agrees');
  });
});

// Asymmetry 1: search space. Not a defect and not fixable in either direction —
// this detector must return a ROOT (every path in `nativeProfile` is prefixed
// with it), and widening the stamp would hand a `confirmed: true` answer to
// evidence from a subdirectory.
test('only the profile detector looks past the project root, and that is deliberate', () => {
  withTree((dir) => MARKER_BUILDERS.flutter!(dir, 'apps/mobile'), (dir) => {
    assertFixture(dir, '.', []);
    assertFixture(dir, 'apps/mobile', ['flutter']);
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.mobile, undefined, 'the stamp reads the project root only');
    assert.equal(detected.stack, null, 'so it derives nothing and the project is routed to tech-detect');
    assert.deepEqual(
      detectedNativeFramework(dir, {}),
      { framework: 'flutter', root: 'apps/mobile' },
      'while the profile detector walks the candidate roots and reports where it found the app',
    );
  });
});

// Asymmetry 2: refusal. The stamp may answer "I cannot tell"; a profile is
// compiled on every invocation and must return something. Safe only because the
// refusal is what routes the project to tech-detect, and the answer given there
// arrives as configured state and outranks everything the detector probes.
test('a configured framework outranks the profile detector\'s own guess', () => {
  withTree((dir) => {
    MARKER_BUILDERS.flutter!(dir, '.');
    MARKER_BUILDERS['react-native-expo']!(dir, '.');
  }, (dir) => {
    assertFixture(dir, '.', ['react-native-expo', 'flutter']);
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.stack, null, 'the stamp refuses, which is what asks the user');
    assert.equal(
      detectedNativeFramework(dir, {}).framework,
      'react-native-expo',
      'the profile detector cannot refuse, so it takes the shared order\'s winner meanwhile',
    );
    assert.equal(
      detectedNativeFramework(dir, { mobile: { framework: 'flutter' } }).framework,
      'flutter',
      'and the answer the user gave at tech-detect wins over that guess',
    );
  });
});

// The product models web+native as one project with two surfaces and a required
// target selection. The stamp used to drop the native half of exactly this shape
// while the profile compiled it, so the two layers contradicted each other.
test('the stamp and the capability profile now agree that next + react-native is a hybrid', () => {
  withTree((dir) => write(dir, 'package.json', JSON.stringify({
    dependencies: { next: '14', react: '18', 'react-native': '0.74' },
  })), (dir) => {
    assertFixture(dir, '.', ['react-native-expo']);
    const detected = detectStackFromCodebase(dir);
    assert.equal(detected.frontend, 'nextjs');
    assert.equal(detected.mobile?.framework, 'react-native-expo');

    const profile = capabilityProfileForProject(dir, {
      stack: detected.stack,
      frontend: detected.frontend,
      backend: 'none',
      mobile: detected.mobile,
    });
    assert.ok(profile.surfaces.includes('web-ui'), 'the profile keeps the web surface');
    assert.ok(profile.surfaces.includes('native-ui'), 'and the native one');
    assert.deepEqual(profile.uiFrameworks, { web: 'nextjs', native: 'react-native-expo' });
    assert.equal(
      profile.blockingIssues?.[0]?.code,
      'CAPABILITY_HYBRID_UI_TARGET_REQUIRED',
      'with no architectureTarget chosen the hybrid is fail-closed rather than silently resolved',
    );
    assert.equal(profile.profileId, 'unsupported-hybrid');
  });
});

// `nativeProfile` prefixes every path with the detected root and
// `architectureTarget` reads only state, so neither needed to change for a
// project that reports two surfaces. Pinned because that was the open question:
// a capability-model change would have been a different size of work.
test('a chosen architecture target resolves the hybrid without either detector moving', () => {
  withTree((dir) => write(dir, 'package.json', JSON.stringify({
    dependencies: { next: '14', react: '18', 'react-native': '0.74' },
  })), (dir) => {
    const base = { stack: 'custom-frontend', frontend: 'nextjs', backend: 'none', mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' } };
    const native = capabilityProfileForProject(dir, { ...base, architectureTarget: 'native-ui' });
    assert.equal(native.profileId, 'react-native');
    assert.equal(native.architectureTarget, 'native-ui');
    assert.equal(native.blockingIssues, undefined, 'a chosen target clears the blocker');
    assert.ok(native.entrypoints.includes('app/_layout.tsx'), 'and the native root is the project root here');

    const web = capabilityProfileForProject(dir, { ...base, architectureTarget: 'web-ui' });
    assert.ok(['next-app', 'next-pages', 'generic-web'].includes(web.profileId), `web target keeps a Next profile (got ${web.profileId})`);
    assert.equal(web.blockingIssues, undefined);
    assert.deepEqual(web.uiFrameworks, { web: 'nextjs', native: 'react-native-expo' }, 'both frameworks stay recorded whichever target is selected');
  });
});
