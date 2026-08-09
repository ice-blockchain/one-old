// src/shared/capabilities/detect-backend.ts
// Backend/native detection and per-stack state defaults.

import { obj, type Rec } from '../obj';

// Imported from the artifacts module rather than the `../detection` barrel: the
// barrel imports `../capabilities`, so going through it would close a cycle.
// `artifacts` itself imports nothing from here.
import { NATIVE_FRAMEWORK_MARKERS, nativeFrameworksAt } from '../detection/artifacts';

import {
  composerPackages,
  exists,
  safeNames,
  stringField,
} from './fs-probe';
import { frontendArtifactsPresent } from './web-roots';
import { candidateWebRoots } from './fs-probe';

export function detectedBackend(cwd: string, state: Rec): string {
  const configured = stringField(state, 'backend', 'none');
  if (!['', 'none', 'other'].includes(configured)) return configured;
  const composer = composerPackages(cwd);
  if (composer['laravel/framework']) return 'laravel';
  if (exists(cwd, 'go.mod')) return 'go';
  if (exists(cwd, 'Cargo.toml')) return 'rust';
  if (exists(cwd, 'pyproject.toml') || exists(cwd, 'requirements.txt') || exists(cwd, 'setup.py')) return 'python';
  if (
    safeNames(cwd).some((name) => name.endsWith('.py') && !name.startsWith('.'))
    && (stringField(state, 'stack') === 'custom-backend' || !frontendArtifactsPresent(cwd))
  ) return 'python';
  if (exists(cwd, 'pom.xml') || exists(cwd, 'build.gradle') || exists(cwd, 'build.gradle.kts')) return 'java';
  return configured;
}

export function defaultStateForStack(stack: string): Rec {
  if (stack === 'default') {
    return {
      stack,
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
    };
  }
  if (stack === 'custom-backend') {
    return {
      stack,
      frontend: 'none',
      backend: 'other',
      mobile: { enabled: false, framework: 'none', source: 'none' },
    };
  }
  return {
    stack,
    frontend: 'none',
    backend: stack === 'minimal' ? 'none' : 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'none' },
  };
}

interface NativeFrameworkDetectionV1 {
  framework: string;
  root: string;
}

/**
 * The native detector the capability profile consumes. It reads the same marker
 * table and the same precedence as the root chain in
 * `detectStackFromCodebase` — see `NATIVE_FRAMEWORK_MARKERS` for why one table
 * and one order, and for the proof that the order can only decide answers the
 * other site refuses to give.
 *
 * Two differences from that site remain, both deliberate, and both stated here
 * because they are what makes the two answer differently on real trees:
 *
 * 1. SEARCH SPACE. This walks `candidateWebRoots`; the stamp reads the project
 *    root only. A monorepo whose Flutter app lives at `apps/mobile` is
 *    `flutter` here and undetectable there. Neither side can adopt the other's:
 *    this one has to return a ROOT (every path in `nativeProfile` is prefixed
 *    with it), while widening the stamp would hand a `confirmed: true`,
 *    force-only-correctable answer to evidence from a subdirectory.
 *
 * 2. REFUSAL. The stamp may answer "two toolchains, I cannot tell"; this must
 *    return something, because a profile is compiled on every invocation. So on
 *    a contradictory root it takes the precedence order's winner where the
 *    stamp names both and declines. That asymmetry is safe only because the
 *    stamp's refusal is what routes the project to the tech-detect step, and
 *    the answer the user gives there arrives as `configured` below and wins
 *    over everything this function probes.
 */
export function detectedNativeFramework(cwd: string, state: Rec): NativeFrameworkDetectionV1 {
  const mobile = obj(state.mobile);
  const configured = stringField(mobile, 'framework', 'none');
  const roots = candidateWebRoots(cwd);
  // One pass per root; the table is then queried framework-major so precedence
  // beats proximity — an outer react-native app must not lose to the Gradle
  // project a nearer candidate root happens to hold.
  const frameworksByRoot = roots.map((root) => ({
    root,
    frameworks: nativeFrameworksAt(cwd, root).map((marker) => marker.framework),
  }));
  const rootFor = (framework: string): string | undefined => (
    frameworksByRoot.find((candidate) => candidate.frameworks.includes(framework))?.root
  );

  if (configured !== 'none') {
    const configuredRoot = rootFor(configured);
    if (configuredRoot) return { framework: configured, root: configuredRoot };
    const conventional = roots.find((root) => /(?:^|\/)(?:mobile|native|ios|android)$/.test(root));
    return { framework: configured, root: conventional || '.' };
  }
  for (const marker of NATIVE_FRAMEWORK_MARKERS) {
    const root = rootFor(marker.framework);
    if (root) return { framework: marker.framework, root };
  }
  return { framework: 'none', root: '.' };
}

