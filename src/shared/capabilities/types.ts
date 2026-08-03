// src/shared/capabilities/types.ts
// Capability schema: profile ids, surfaces, and the CapabilityProfileV1.

export const CAPABILITY_SCHEMA_VERSION = 1 as const;

export type ProjectSurface = 'web-ui' | 'native-ui' | 'api' | 'cli' | 'worker' | 'data';
export const STRUCTURAL_PROFILE_IDS = [
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
export type StructuralProfileId = typeof STRUCTURAL_PROFILE_IDS[number];
type QaAdapterId = 'playwright' | 'maestro' | 'xcode-simulator' | 'android-emulator' | 'flutter-driver';
export type ArchitectureTargetSurface = 'web-ui' | 'native-ui';
export type ShadcnAdapterId = 'shadcn' | 'shadcn-vue' | 'shadcn-svelte';

export interface WebUiSystemV1 {
  family: 'shadcn' | 'external' | 'framework-native';
  adapter: ShadcnAdapterId | null;
  library: string;
  source: 'explicit' | 'detected' | 'default' | 'unsupported';
  sharedRoot: string | null;
}

interface CapabilityBlockingIssueV1 {
  code: 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED';
  message: string;
}

export interface CapabilityProfileV1 {
  schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  profileId: StructuralProfileId;
  surfaces: ProjectSurface[];
  framework: string;
  backendFramework: string;
  router: string;
  sourceRoots: string[];
  entrypoints: string[];
  layerRoots: {
    pages: string[];
    components: string[];
    features: string[];
    lib: string[];
  };
  roles: string[];
  skillBuckets: string[];
  qaAdapters: QaAdapterId[];
  /** Resolved component-system policy for the selected web surface. */
  uiSystem?: WebUiSystemV1;
  /** Runtime/user-owned selection for a project that exposes both UI domains. */
  architectureTarget?: ArchitectureTargetSurface;
  /** Detected frameworks are retained when the selected structural profile represents only one UI domain. */
  uiFrameworks?: {
    web: string;
    native: string;
  };
  /** Any entry is fail-closed at architecture compilation. */
  blockingIssues?: CapabilityBlockingIssueV1[];
}

export const UNIVERSAL_ROLES = ['senior-architect', 'senior-reviewer', 'senior-tester', 'senior-shipper'];
export const BACKEND_NONE = new Set(['', 'none', 'external-api']);
export const FRONTEND_NONE = new Set(['', 'none']);
export const MAX_WORKSPACE_ROOTS = 128;
