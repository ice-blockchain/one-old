// src/shared/capabilities/profile.ts
// capabilityProfileForProject: the assembler.

import * as path from 'path';

import { scanSourceFiles } from '../detection';
import { obj } from '../obj';
import { isNewProjectMode } from '../state/lifecycle';

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
  profileSupportsShadcnWorkspace,
  resolveWebUiSystem,
} from './ui-system';
import {
  architectureTarget,
  frontendSkillBucket,
  nativeProfile,
  unsupportedHybridProfile,
  type StructuralProfileV1,
} from './profiles-native';

// Kept out of the assembler so the tree walk stays behind the `new-project`
// short-circuit: this runs in the Write pre-tool path, and only a project the
// mode calls greenfield can have its app relocated in the first place.
function webAppHoldsSource(
  cwd: string,
  detection: { onDisk: boolean; webRoot?: string },
): boolean {
  if (!detection.onDisk) return false;
  // `stopAfter: 0` answers "is there any" on the first source file instead of
  // walking the whole tree, and a budget-truncated count is a FLOOR rather than a
  // total — so a truncated zero means "could not tell", never "nothing here".
  // Reading it as nothing relocates the app out from under the source this veto
  // exists to protect, so ignorance has to answer the same as evidence.
  //
  // "Any source" means any the scan COUNTS, and it no longer counts dependency
  // trees, build output or caches — which lowers the count, i.e. weakens this
  // veto, at the same time as it pushes `state.mode` toward `new-project`. Both
  // terms of the `&&` below move together on one number, so the exclusion set is
  // narrower than the scan authority it derives from; the reasoning is at
  // `SOURCE_SCAN_SKIP_DIRS`.
  const scan = scanSourceFiles(path.join(cwd, detection.webRoot || '.'), { stopAfter: 0 });
  return scan.count > 0 || scan.truncated;
}

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

  // This becomes `frontendProfile`'s `preferredWebRoot`, which wins over its
  // own on-disk probe, so it moves every compiled sourceRoot, entrypoint and
  // layerRoot under `apps/web`.
  //
  // `state.mode` is a GUESS: `detectMode` answers `new-project` for anything
  // with five or fewer files in `SOURCE_EXTS` (measured — a 3-file Terraform
  // stack with a real commit reads `new-project`, and nothing later corrects it
  // because the wizard's new-project branch only opens when the mode ALREADY
  // says new-project and then re-stamps the same value). So the mode alone may
  // decide where to put an app, but never that an app which already holds code
  // should move: a relocated root orphans the project's own application, and an
  // agent handed a contract pointing at an empty subtree writes there and is
  // denied by the write gates — a deadlock.
  //
  // Hence the veto is "would this orphan source?", not "does a framework exist
  // on disk?". The looser form cannot work: a manifest with NO source under it
  // is a stub, not an application, and `detectMode` already calls a tree that
  // thin a new project — vetoing on it would only stop us from planning the
  // canonical layout for projects that have nothing to lose. Zero is the
  // threshold rather than `detectMode`'s five because relocation is far more
  // expensive than a rule-pack choice.
  //
  // Why not `greenfieldEvidence`/`hasCommittedHistory`: neither arm survives
  // here. Materialization converges `.gitignore` on the first SessionStart, so
  // the no-`.gitignore` arm is spent for every project by the time this runs;
  // and a greenfield project routinely HAS a commit at this point (a user who
  // ran `git init && git commit` first, and every run-sim case — `initRepo`
  // commits before the run id is minted), so the history arm would narrow
  // genuine greenfield runs.
  //
  // Why source on disk cannot be OUR OWN scaffold: the profile that compiles
  // the contract is frozen once, by `ensureArchitectureRunSnapshot` at run-id
  // mint, before `plan.md` exists and before any scaffolder runs at all
  // (`ensureScaffoldContent` runs INSIDE the PLAN_READY transaction, after
  // compilation). A genuine greenfield project has nothing on disk at that
  // moment; and once we HAVE scaffolded, the app is at `apps/web`, so the
  // detected root and the planned root agree and the profile stays stationary.
  // `isNewProjectMode`, not the raw string: the gates that consume this profile
  // read the mode through the predicate, and a profile derived from a stricter
  // reading of the same value is a profile for a different project.
  const plannedWebWorkspace = isNewProjectMode(state)
    && !webAppHoldsSource(cwd, frontendDetection)
    && profileSupportsShadcnWorkspace(cwd, frontend, state);
  const webStructural = hasWeb
    ? frontendProfile(
        frontend,
        cwd,
        plannedWebWorkspace ? 'apps/web' : frontendDetection.webRoot,
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

  const baseProfile: CapabilityProfileV1 = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    ...structural,
    backendFramework: backend,
    surfaces: unique(surfaces),
    roles: unique(roles),
    skillBuckets: unique(skillBuckets),
    ...profileExtras,
  };
  const uiSystem = resolveWebUiSystem(cwd, state, baseProfile);
  return {
    ...baseProfile,
    ...(uiSystem ? { uiSystem } : {}),
  };
}
