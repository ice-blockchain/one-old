// src/shared/capabilities/queries.ts
// Public queries over the assembled profile.

import { obj, type Rec } from '../obj';

import {
  BACKEND_NONE,
  FRONTEND_NONE,
  type CapabilityProfileV1,
} from './types';
import {
  stringField,
  unique,
} from './fs-probe';
import {
  architectureTarget,
} from './profiles-native';
import {
  capabilityProfileForProject,
} from './profile';

export function profileHasWebUi(profile: CapabilityProfileV1): boolean {
  return profile.surfaces.includes('web-ui');
}

export function profileHasNativeUi(profile: CapabilityProfileV1): boolean {
  return profile.surfaces.includes('native-ui');
}

export function eligibleRolesForProject(cwd: string, input: unknown): Set<string> {
  return new Set(capabilityProfileForProject(cwd, input).roles);
}

export function eligibleRolesForProfile(profile: CapabilityProfileV1): Set<string> {
  return new Set(profile.roles);
}

/** Pure state-only projection used by materialization before project files exist. */
export function skillBucketsForState(input: unknown): string[] {
  const state = obj(input) || {};
  const frontend = stringField(state, 'frontend', 'none');
  const backend = stringField(state, 'backend', 'none');
  const mobile = stringField(obj(state.mobile), 'framework', 'none');
  const buckets: string[] = [];
  if (!FRONTEND_NONE.has(frontend)) {
    buckets.push('web-ui');
    if (frontend === 'react-vite') buckets.push('react-vite');
    else if (frontend === 'nextjs') buckets.push('nextjs');
    else if (frontend === 'nuxt') buckets.push('nuxt');
    else buckets.push('custom-web');
  }
  if (mobile !== 'none' && mobile !== 'ionic-capacitor') {
    buckets.push('native-ui', mobile);
  } else if (mobile === 'ionic-capacitor' && !FRONTEND_NONE.has(frontend)) {
    // Capacitor wraps the selected web framework. React/Vite, Vue, Angular,
    // and generic web projects keep their own base bucket; Ionic must never
    // manufacture a web/React stack when no base frontend was selected.
    buckets.push('ionic-capacitor');
  }
  if (!BACKEND_NONE.has(backend)) {
    buckets.push('backend-common');
    const explicitSurfaces = Array.isArray(state.capabilitySurfaces)
      ? state.capabilitySurfaces
      : Array.isArray(state.surfaces)
        ? state.surfaces
        : [];
    if (
      explicitSurfaces.includes('api')
      || (explicitSurfaces.length === 0 && !['python', 'other'].includes(backend))
    ) buckets.push('api');
    if (backend === 'supabase' || backend === 'our-fork') buckets.push('supabase', 'postgres');
    else if (backend === 'postgres' || backend === 'postgresql') buckets.push('postgres');
    else if (backend === 'nestjs') buckets.push('node');
    else if (backend === 'fastapi') buckets.push('python');
    else if (backend === 'laravel') buckets.push('php');
    else if (backend === 'csharp') buckets.push('dotnet');
    else if (backend !== 'other') buckets.push(backend);
  }
  const surfaces = Array.isArray(state.capabilitySurfaces)
    ? state.capabilitySurfaces
    : Array.isArray(state.surfaces)
      ? state.surfaces
      : [];
  const profileBuckets = Array.isArray(state.capabilitySkillBuckets)
    ? state.capabilitySkillBuckets
    : [];
  if (surfaces.includes('data') || profileBuckets.includes('postgres')) buckets.push('postgres');
  const provider = [
    state.database,
    state.databaseProvider,
    state.database_provider,
    state.db,
    state.dbProvider,
  ].find((value) => typeof value === 'string' && value.trim());
  if (typeof provider === 'string' && /\b(?:postgres|postgresql|supabase)\b/i.test(provider)) {
    buckets.push('postgres');
  }
  return unique(buckets);
}

/** Runtime-derived state view for rule/skill materialization; never persisted. */
export function runtimeCapabilityState(cwd: string, input: unknown): Rec {
  const state = obj(input) || {};
  const profile = capabilityProfileForProject(cwd, state);
  return runtimeCapabilityStateFromProfile(profile, state);
}

export function runtimeCapabilityStateFromProfile(
  profile: CapabilityProfileV1,
  input: unknown,
): Rec {
  const state = obj(input) || {};
  const frontend = profile.surfaces.includes('web-ui')
    ? profile.uiFrameworks?.web
      || (profile.framework === 'laravel' ? 'laravel-ui' : profile.framework)
    : 'none';
  const mobile = obj(state.mobile) || {};
  const nativeFramework = profile.uiFrameworks?.native
    || (profile.surfaces.includes('native-ui') ? profile.framework : stringField(mobile, 'framework', 'none'));
  return {
    ...state,
    frontend,
    backend: profile.backendFramework,
    mobile: {
      ...mobile,
      enabled: profile.surfaces.includes('native-ui') || mobile.framework === 'ionic-capacitor',
      framework: nativeFramework,
    },
    // Ephemeral runtime projection consumed by rule/skill materialization.
    // Persisted state never owns or edits these values.
    capabilityProfileId: profile.profileId,
    capabilitySurfaces: [...profile.surfaces],
    capabilitySkillBuckets: [...profile.skillBuckets],
    ...(profile.architectureTarget ? { capabilityArchitectureTarget: profile.architectureTarget } : {}),
    ...(profile.blockingIssues ? { capabilityBlockingIssues: [...profile.blockingIssues] } : {}),
  };
}
