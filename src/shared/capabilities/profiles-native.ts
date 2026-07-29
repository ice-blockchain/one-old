// src/shared/capabilities/profiles-native.ts
// The native profile table plus profile glue.

import {  type Rec } from '../obj';

import {
  type ArchitectureTargetSurface,
  type CapabilityProfileV1,
} from './types';
import {
  stringField,
  unique,
} from './fs-probe';
import { prefixed } from './fs-probe';
import {
  frontendProfile,
} from './profiles-web';

export function nativeProfile(framework: string, nativeRoot = '.'): Pick<
  CapabilityProfileV1,
  'profileId' | 'framework' | 'router' | 'sourceRoots' | 'entrypoints' | 'layerRoots' | 'qaAdapters'
> {
  if (framework === 'react-native-expo') {
    const appRoot = prefixed(nativeRoot, 'app');
    const sourceRoot = prefixed(nativeRoot, 'src');
    return {
      profileId: 'react-native',
      framework,
      router: 'expo-router',
      sourceRoots: [appRoot, sourceRoot],
      entrypoints: [`${appRoot}/_layout.tsx`],
      layerRoots: {
        pages: [appRoot, `${sourceRoot}/screens`],
        components: [`${sourceRoot}/components`, 'packages/ui-native/src'],
        features: [`${sourceRoot}/features`],
        lib: [`${sourceRoot}/lib`, `${sourceRoot}/services`],
      },
      qaAdapters: ['maestro'],
    };
  }
  if (framework === 'swift-native') {
    return {
      profileId: 'swift-native',
      framework,
      router: 'swiftui-navigation',
      sourceRoots: [prefixed(nativeRoot, 'Sources'), prefixed(nativeRoot, 'App')],
      entrypoints: [prefixed(nativeRoot, 'App.swift')],
      layerRoots: {
        pages: [prefixed(nativeRoot, 'Features'), prefixed(nativeRoot, 'Views')],
        components: [prefixed(nativeRoot, 'Components')],
        features: [prefixed(nativeRoot, 'Features')],
        lib: [prefixed(nativeRoot, 'Core'), prefixed(nativeRoot, 'Services')],
      },
      qaAdapters: ['xcode-simulator'],
    };
  }
  if (framework === 'kotlin-android') {
    const appRoot = prefixed(nativeRoot, 'app');
    return {
      profileId: 'kotlin-native',
      framework,
      router: 'android-navigation',
      sourceRoots: [`${appRoot}/src/main`],
      entrypoints: [`${appRoot}/src/main/AndroidManifest.xml`],
      layerRoots: {
        pages: [`${appRoot}/src/main/java`, `${appRoot}/src/main/kotlin`],
        components: [`${appRoot}/src/main/java`, `${appRoot}/src/main/kotlin`],
        features: [prefixed(nativeRoot, 'features'), `${appRoot}/src/main`],
        lib: [prefixed(nativeRoot, 'core')],
      },
      qaAdapters: ['android-emulator'],
    };
  }
  const libRoot = prefixed(nativeRoot, 'lib');
  return {
    profileId: 'flutter-native',
    framework: 'flutter',
    router: 'flutter-router',
    sourceRoots: [libRoot],
    entrypoints: [`${libRoot}/main.dart`],
    layerRoots: {
      pages: [`${libRoot}/screens`, `${libRoot}/pages`],
      components: [`${libRoot}/widgets`],
      features: [`${libRoot}/features`],
      lib: [`${libRoot}/core`],
    },
    qaAdapters: ['flutter-driver'],
  };
}

export type StructuralProfileV1 = ReturnType<typeof frontendProfile> | ReturnType<typeof nativeProfile>;

export function frontendSkillBucket(frontend: string): string {
  if (frontend === 'react-vite' || frontend === 'nextjs' || frontend === 'nuxt') return frontend;
  return 'custom-web';
}

export function architectureTarget(state: Rec): ArchitectureTargetSurface | null {
  const raw = stringField(
    state,
    'architectureTarget',
    stringField(state, 'architectureTargetSurface', ''),
  );
  return raw === 'web-ui' || raw === 'native-ui' ? raw : null;
}

export function unsupportedHybridProfile(
  web: StructuralProfileV1,
  native: StructuralProfileV1,
): StructuralProfileV1 {
  return {
    profileId: 'unsupported-hybrid',
    framework: 'hybrid',
    router: 'unresolved',
    sourceRoots: unique([...web.sourceRoots, ...native.sourceRoots]),
    entrypoints: unique([...web.entrypoints, ...native.entrypoints]),
    layerRoots: {
      pages: unique([...web.layerRoots.pages, ...native.layerRoots.pages]),
      components: unique([...web.layerRoots.components, ...native.layerRoots.components]),
      features: unique([...web.layerRoots.features, ...native.layerRoots.features]),
      lib: unique([...web.layerRoots.lib, ...native.layerRoots.lib]),
    },
    qaAdapters: unique([...web.qaAdapters, ...native.qaAdapters]),
  };
}

