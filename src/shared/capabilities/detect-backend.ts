// src/shared/capabilities/detect-backend.ts
// Backend/native detection and per-stack state defaults.

import * as path from 'path';
import { obj, type Rec } from '../obj';

import {
  composerPackages,
  exists,
  packageDependencies,
  safeNames,
  stringField,
} from './fs-probe';
import { frontendArtifactsPresent } from './web-roots';
import { candidateWebRoots, prefixed } from './fs-probe';

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

export function detectedNativeFramework(cwd: string, state: Rec): NativeFrameworkDetectionV1 {
  const mobile = obj(state.mobile);
  const configured = stringField(mobile, 'framework', 'none');
  const roots = candidateWebRoots(cwd);
  const dependencySets = roots.map((root) => ({ root, deps: packageDependencies(cwd, root) }));
  const reactNative = dependencySets.find(({ deps }) => Boolean(deps.expo || deps['react-native']));
  const flutter = roots.find((root) => exists(cwd, prefixed(root, 'pubspec.yaml')));
  const swift = roots.find((root) => (
    exists(cwd, prefixed(root, 'Package.swift'))
    || exists(cwd, prefixed(root, 'project.pbxproj'))
    || safeNames(path.join(cwd, root)).some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))
  ));
  const kotlin = roots.find((root) => (
    exists(cwd, prefixed(root, 'settings.gradle'))
    || exists(cwd, prefixed(root, 'settings.gradle.kts'))
    || exists(cwd, prefixed(root, 'app/build.gradle'))
    || exists(cwd, prefixed(root, 'app/build.gradle.kts'))
  ));
  if (configured !== 'none') {
    if (configured === 'react-native-expo' && reactNative) return { framework: configured, root: reactNative.root };
    if (configured === 'flutter' && flutter) return { framework: configured, root: flutter };
    if (configured === 'swift-native' && swift) return { framework: configured, root: swift };
    if (configured === 'kotlin-android' && kotlin) return { framework: configured, root: kotlin };
    const conventional = roots.find((root) => /(?:^|\/)(?:mobile|native|ios|android)$/.test(root));
    return { framework: configured, root: conventional || '.' };
  }
  if (reactNative) return { framework: 'react-native-expo', root: reactNative.root };
  if (flutter) return { framework: 'flutter', root: flutter };
  if (swift) return { framework: 'swift-native', root: swift };
  if (kotlin) return { framework: 'kotlin-android', root: kotlin };
  return { framework: 'none', root: '.' };
}

