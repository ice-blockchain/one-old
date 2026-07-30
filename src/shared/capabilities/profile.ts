// src/shared/capabilities/profile.ts
// capabilityProfileForProject: the assembler.

import { obj } from '../obj';

import {
  BACKEND_NONE,
  CAPABILITY_SCHEMA_VERSION,
  FRONTEND_NONE,
  UNIVERSAL_ROLES,
  type CapabilityProfileV1,
  type ProjectSurface,
} from './types';
import {
  backendExposesApi,
  backendSkillBucket,
  exists,
  postgresEvidencePresent,
  pythonCliEvidencePresent,
  stringField,
  unique,
} from './fs-probe';
import {
  detectFrontendFramework,
} from './detect-frontend';
import {
  detectedBackend,
  detectedNativeFramework,
} from './detect-backend';
import {
  frontendProfile,
} from './profiles-web';
import {
  architectureTarget,
  frontendSkillBucket,
  nativeProfile,
  unsupportedHybridProfile,
  type StructuralProfileV1,
} from './profiles-native';

export function capabilityProfileForProject(cwd: string, input: unknown): CapabilityProfileV1 {
  const state = obj(input) || {};
  const frontendDetection = detectFrontendFramework(cwd, state);
  const frontend = frontendDetection.frontend;
  const nativeDetection = detectedNativeFramework(cwd, state);
  const nativeFramework = nativeDetection.framework;
  const backend = detectedBackend(cwd, state);
  const surfaces: ProjectSurface[] = [];
  const skillBuckets: string[] = [];
  const hasWeb = !FRONTEND_NONE.has(frontend);
  const hasNative = nativeFramework !== 'none' && nativeFramework !== 'ionic-capacitor';
  const selectedTarget = architectureTarget(state);
  let profileExtras: Pick<
    CapabilityProfileV1,
    'architectureTarget' | 'uiFrameworks' | 'blockingIssues'
  > = {};

  const plannedViteMonorepo = frontend === 'react-vite'
    && state.mode === 'new-project'
    && (
      state.stack === 'default'
      || state.stack === 'react-realtime-monorepo'
      || (state.frontend === 'react-vite' && !BACKEND_NONE.has(backend))
    );
  const webStructural = hasWeb
    ? frontendProfile(
        frontend,
        cwd,
        plannedViteMonorepo ? 'apps/web' : frontendDetection.webRoot,
        // The state's configured frontend seeds the Inertia kind on a new
        // laravel project where no dependency evidence exists yet (8cl).
        stringField(state, 'frontend', ''),
      )
    : null;
  const nativeStructural = hasNative
    ? nativeProfile(nativeFramework, nativeDetection.root)
    : null;

  let structural: StructuralProfileV1;
  if (webStructural && nativeStructural) {
    surfaces.push('web-ui', 'native-ui');
    skillBuckets.push(
      'web-ui',
      frontendSkillBucket(frontend),
      'native-ui',
      nativeFramework,
    );
    profileExtras = {
      uiFrameworks: { web: frontend, native: nativeFramework },
      ...(selectedTarget ? { architectureTarget: selectedTarget } : {}),
      ...(!selectedTarget
        ? {
            blockingIssues: [{
              code: 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED' as const,
              message: 'Both web-ui and native-ui were detected; set runtime/user-owned architectureTarget to web-ui or native-ui before architecture compilation.',
            }],
          }
        : {}),
    };
    structural = selectedTarget === 'web-ui'
      ? webStructural
      : selectedTarget === 'native-ui'
        ? nativeStructural
        : unsupportedHybridProfile(webStructural, nativeStructural);
  } else if (nativeStructural) {
    structural = nativeStructural;
    surfaces.push('native-ui');
    skillBuckets.push('native-ui', nativeFramework);
  } else if (webStructural) {
    structural = webStructural;
    surfaces.push('web-ui');
    skillBuckets.push('web-ui', frontendSkillBucket(frontend));
    if (nativeFramework === 'ionic-capacitor') skillBuckets.push('ionic-capacitor');
  } else {
    structural = {
      profileId: 'backend-only',
      framework: backend,
      router: 'none',
      sourceRoots: ['src', 'app', 'cmd', 'internal'],
      entrypoints: [],
      layerRoots: { pages: [], components: [], features: ['src', 'app', 'internal'], lib: ['lib', 'pkg'] },
      qaAdapters: [],
    };
  }

  if (backendExposesApi(cwd, backend)) {
    surfaces.push('api');
  }
  if (
    exists(cwd, 'cmd')
    || exists(cwd, 'bin')
    || (backend === 'python' && !surfaces.includes('api') && pythonCliEvidencePresent(cwd))
  ) {
    surfaces.push('cli');
  }
  if (exists(cwd, 'workers') || exists(cwd, 'jobs') || exists(cwd, 'app/Jobs')) surfaces.push('worker');
  if (exists(cwd, 'migrations') || exists(cwd, 'database/migrations') || exists(cwd, 'supabase/migrations')) surfaces.push('data');
  if (!BACKEND_NONE.has(backend)) {
    skillBuckets.push('backend-common');
    if (surfaces.includes('api')) skillBuckets.push('api');
    const languageBucket = backendSkillBucket(backend);
    if (languageBucket) skillBuckets.push(languageBucket);
  }
  if (surfaces.includes('data') || postgresEvidencePresent(cwd, state, backend)) {
    skillBuckets.push('postgres');
  }

  const roles = [
    ...UNIVERSAL_ROLES,
    ...(surfaces.includes('web-ui') || surfaces.includes('native-ui') ? ['senior-frontend'] : []),
    ...(!BACKEND_NONE.has(backend)
      || surfaces.some((surface) => ['api', 'cli', 'worker', 'data'].includes(surface))
      ? ['senior-backend']
      : []),
  ];

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    ...structural,
    backendFramework: backend,
    surfaces: unique(surfaces),
    roles: unique(roles),
    skillBuckets: unique(skillBuckets),
    ...profileExtras,
  };
}

