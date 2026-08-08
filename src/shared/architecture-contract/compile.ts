// src/shared/architecture-contract/compile.ts
// Compilation: capability profile resolution, run snapshots, and
// compileArchitecture(ForRun) with persist/read.

import * as fs from 'fs';
import * as path from 'path';
import {
  capabilityProfileForProject,
  runtimeCapabilityStateFromProfile,
  type CapabilityProfileV1,
} from '../capabilities';
import { readJson, writeJson } from '../fsjson';
import { obj, type Rec } from '../obj';
import { withProjectStateLock } from '../state/project-state-lock';

import {
  ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION,
  ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION,
  COMPILED_ARCHITECTURE_SCHEMA_VERSION,
  type ArchitectureBaselineV1,
  type ArchitectureInputV1,
  type ArchitectureRunBaselineV1,
  type ArchitectureRunSnapshotV1,
  type CompiledArchitectureV1,
} from './types';
import {
  MEMORY_DIR,
  contractHash,
  normalizeRelative,
  baselineContains,
} from './core';
import {
  resolveModuleOutput,
} from './naming';
import {
  REPOSITORY_SCAFFOLD_OUTPUTS,
  appendUniqueScaffoldOutputs,
  backendQualityOutputs,
  backendScaffoldOutputs,
  backendWiringOutputs,
  environmentScaffoldOutputs,
  frontendScaffoldOutputs,
  nativeScaffoldOutputs,
  nodeToolingScaffoldOutputs,
  repositoryScaffoldOutputs,
  resolveInitialScaffoldOwners,
  selectedImplementationOwner,
  sharedUiScaffoldOutputs,
  uiPrimitiveScaffoldOutputs,
} from './scaffold';
import {
  routeRegistrationOutputs,
  testerOutputs,
  workspaceManifestOutputs,
} from './scaffold-tests';
import {
  i18nScaffoldOutputs,
  resolveArchitectureI18n,
} from './i18n';
import {
  validateArchitectureInput,
} from './validate';
import {
  architectureRunBaselinePath,
  architectureRunSnapshotPath,
  baselinePathSet,
  captureArchitectureBaseline,
  readArchitectureRunBaseline,
  readArchitectureRunSnapshot,
} from './baseline';


export function capabilityProfileForRun(
  projectRoot: string,
  state: unknown,
): CapabilityProfileV1 {
  const runId = String(obj(state)?.currentRunId || '').trim();
  return (runId ? readArchitectureRunSnapshot(projectRoot, runId)?.profile : null)
    || capabilityProfileForProject(projectRoot, state);
}

export function capabilityStateForRun(projectRoot: string, state: unknown): Rec {
  return runtimeCapabilityStateFromProfile(capabilityProfileForRun(projectRoot, state), state);
}

/**
 * Mint-once runtime snapshot. Call this when the run id is established, before
 * any architect/implementer write. Replanning reuses it and cannot steer roots
 * by adding framework markers or editing package manifests mid-run.
 */
export function ensureArchitectureRunSnapshot(
  projectRoot: string,
  runId: string,
  state: unknown,
): ArchitectureRunSnapshotV1 {
  if (!runId || /[\\/]/.test(runId)) throw new Error('runId is invalid');
  const existing = readArchitectureRunSnapshot(projectRoot, runId);
  if (existing) {
    const baseline = readArchitectureRunBaseline(projectRoot, runId);
    if (!baseline || baseline.baselineHash !== existing.baselineHash) {
      throw new Error('immutable run baseline is missing or corrupt');
    }
    return supersedeBlockedRunSnapshot(projectRoot, runId, state, existing) || existing;
  }
  if (fs.existsSync(architectureRunSnapshotPath(projectRoot, runId))) {
    throw new Error('immutable runtime capability snapshot is corrupt');
  }
  const capturedAt = new Date().toISOString();
  // A pre-existing compiled sidecar is not an authority: it may be stale,
  // agent-authored, or from a rolled-back runtime. Mint the immutable profile
  // and baseline only from current runtime detection at run start.
  const profile = capabilityProfileForProject(projectRoot, state);
  const baseline = captureArchitectureBaseline(projectRoot, profile, capturedAt);
  const baselineCanonical = {
    schemaVersion: ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION,
    runId,
    baseline,
  };
  const baselineSidecar: ArchitectureRunBaselineV1 = {
    ...baselineCanonical,
    baselineHash: contractHash(baselineCanonical),
  };
  const canonical = {
    schemaVersion: ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION,
    runId,
    profile,
    baselineIdentity: baseline.identity,
    baselineHash: baselineSidecar.baselineHash,
    capturedAt,
  };
  const candidate: ArchitectureRunSnapshotV1 = {
    ...canonical,
    snapshotHash: contractHash(canonical),
  };

  return withProjectStateLock(projectRoot, () => {
    const raced = readArchitectureRunSnapshot(projectRoot, runId);
    if (raced) {
      const racedBaseline = readArchitectureRunBaseline(projectRoot, runId);
      if (!racedBaseline || racedBaseline.baselineHash !== raced.baselineHash) {
        throw new Error('immutable run baseline is missing or corrupt');
      }
      return raced;
    }
    if (fs.existsSync(architectureRunSnapshotPath(projectRoot, runId))) {
      throw new Error('immutable runtime capability snapshot is corrupt');
    }
    if (fs.existsSync(architectureRunBaselinePath(projectRoot, runId))) {
      throw new Error('incomplete runtime snapshot: baseline exists without capability marker');
    }
    // Publish the potentially large manifest first and the small capability
    // marker last. Hot hooks read only capability-v1.json.
    writeJson(architectureRunBaselinePath(projectRoot, runId), baselineSidecar);
    writeJson(architectureRunSnapshotPath(projectRoot, runId), candidate);
    const persisted = readArchitectureRunSnapshot(projectRoot, runId);
    const persistedBaseline = readArchitectureRunBaseline(projectRoot, runId);
    if (!persisted
      || !persistedBaseline
      || persisted.baselineHash !== persistedBaseline.baselineHash) {
      throw new Error('runtime capability snapshot could not be persisted atomically');
    }
    return persisted;
  });
}

// Mint-once exists to stop mid-run steering of roots/roles by file drift. A
// snapshot whose profile is a FAIL-CLOSED state (blockingIssues — e.g. a hybrid
// repo frozen before `architectureTarget` was answered) authorized NO roots or
// roles, so there is nothing a re-mint could steer — while keeping it wedges
// the run forever: assignments can never compile, maintenance writes fail
// closed, rotation is refused because the run already holds artifacts, and the
// agent's only exit is asking the user for main-agent mode (observed live: run
// 1785681001843 — `unsupported-hybrid` frozen, `architectureTarget: native-ui`
// set moments later, run permanently uncompilable). When the CURRENT state now
// resolves a CLEAN profile, replace the blocked profile in place: same run id,
// same immutable baseline (diff evidence preserved), recomputed snapshotHash.
// A healthy snapshot is NEVER superseded, and a still-blocked fresh profile
// changes nothing — the fail-closed state stands until the input arrives.
function supersedeBlockedRunSnapshot(
  projectRoot: string,
  runId: string,
  state: unknown,
  existing: ArchitectureRunSnapshotV1,
): ArchitectureRunSnapshotV1 | null {
  if ((existing.profile.blockingIssues || []).length === 0) return null;
  const fresh = capabilityProfileForProject(projectRoot, state);
  if ((fresh.blockingIssues || []).length > 0) return null;
  const canonical = {
    schemaVersion: ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION,
    runId,
    profile: fresh,
    baselineIdentity: existing.baselineIdentity,
    baselineHash: existing.baselineHash,
    capturedAt: existing.capturedAt,
  };
  const candidate: ArchitectureRunSnapshotV1 = {
    ...canonical,
    snapshotHash: contractHash(canonical),
  };
  return withProjectStateLock(projectRoot, () => {
    // Re-check under the lock: a sibling process may have superseded already.
    const current = readArchitectureRunSnapshot(projectRoot, runId);
    if (!current || (current.profile.blockingIssues || []).length === 0) return current;
    writeJson(architectureRunSnapshotPath(projectRoot, runId), candidate);
    const persisted = readArchitectureRunSnapshot(projectRoot, runId);
    if (!persisted) throw new Error('superseded runtime capability snapshot could not be persisted');
    return persisted;
  });
}

export function architectureInputPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'architecture-input-v1.json');
}

export function compiledArchitecturePath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'architecture-v1.json');
}

export function compileArchitecture(
  projectRoot: string,
  runId: string,
  state: unknown,
  input: ArchitectureInputV1,
  baseline?: ArchitectureBaselineV1,
  frozenProfile?: CapabilityProfileV1,
): CompiledArchitectureV1 {
  const validation = validateArchitectureInput(input);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (!runId || /[\\/]/.test(runId)) throw new Error('runId is invalid');
  const profile = frozenProfile || capabilityProfileForProject(projectRoot, state);
  const uiPrimitives = [...new Set((input.uiPrimitives || []).map((name) => name.trim()))].sort();
  if (profile.profileId === 'unsupported-hybrid' || (profile.blockingIssues?.length || 0) > 0) {
    const issue = profile.blockingIssues?.[0];
    throw new Error(
      `[${issue?.code || 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED'}] ${
        issue?.message
        || 'Architecture compilation is blocked until web-ui or native-ui is selected by runtime/user-owned state.'
      }`,
    );
  }
  const hasUi = profile.surfaces.includes('web-ui') || profile.surfaces.includes('native-ui');
  if (uiPrimitives.length > 0 && profile.uiSystem?.family !== 'shadcn') {
    throw new Error(`uiPrimitives require a resolved shadcn component system; profile ${profile.profileId} selected ${profile.uiSystem?.family || 'none'}`);
  }
  if (input.modules.some((module) => module.placement === 'shared-ui') && !profile.uiSystem?.sharedRoot) {
    throw new Error(`shared-ui component placement requires a resolved shared UI root for profile ${profile.profileId}`);
  }
  if (
    input.modules.some((module) => module.kind === 'edge-function')
    && !['supabase', 'our-fork'].includes(profile.backendFramework)
  ) {
    // `supabase/functions/<name>/index.ts` is a Supabase CLI layout. On any
    // other backend the same path deploys nowhere, so the kind is refused
    // rather than compiled into a directory no toolchain reads.
    throw new Error(`edge-function modules require a Supabase-family backend; profile ${profile.profileId} selected backend ${profile.backendFramework || 'none'}`);
  }
  const uiOnlyModules = input.modules.filter((module) => (
    module.kind === 'app-shell' || module.kind === 'page' || module.kind === 'component'
  ));
  if (!hasUi && (input.routes.length > 0 || uiOnlyModules.length > 0)) {
    throw new Error(
      `capability profile ${profile.profileId} has no UI surface; routes/app-shell/page/component modules are unavailable`,
    );
  }
  const compiledSourceRoots = [...new Set([
    ...profile.sourceRoots,
    ...profile.layerRoots.pages,
    ...profile.layerRoots.components,
    ...profile.layerRoots.features,
    ...profile.layerRoots.lib,
  ].map((root) => normalizeRelative(root)).filter((root): root is string => Boolean(root)))];
  const compiledBaseline = baseline
    || captureArchitectureBaseline(projectRoot, { ...profile, sourceRoots: compiledSourceRoots });
  const immutablePaths = baselinePathSet(projectRoot, compiledBaseline);
  const routesByModule = new Map(input.routes.map((route) => [route.moduleId, route]));
  const modules = input.modules.map((module) => {
    const resolved = resolveModuleOutput(
      projectRoot,
      profile,
      module,
      routesByModule.get(module.id),
      immutablePaths,
    );
    return {
      ...module,
      ownerRole: module.kind === 'test'
        ? 'senior-tester'
        // An edge function is server code by definition — it must never reach the
        // UI branch below, whatever surfaces the profile has.
        : module.kind === 'edge-function'
          ? (profile.roles.includes('senior-backend') ? 'senior-backend' : 'senior-frontend')
          : (
              ['app-shell', 'page', 'component', 'feature'].includes(module.kind)
              && hasUi
            )
              ? 'senior-frontend'
              : profile.roles.includes('senior-backend')
                ? 'senior-backend'
                : 'senior-frontend',
      output: resolved.output,
      outputBase: resolved.outputBase,
      allowedExtensions: resolved.allowedExtensions,
    };
  });
  const outputById = new Map(modules.map((module) => [module.id, module.output]));
  const routes = input.routes.map((route) => ({
    ...route,
    moduleOutput: route.redirect ? '' : (outputById.get(route.moduleId) || ''),
  }));
  const entrypointCandidates = profile.entrypoints
    .map(normalizeRelative)
    .filter((entry): entry is string => Boolean(entry));
  const existingEntrypoints = entrypointCandidates.filter((entry) => immutablePaths.has(entry));
  const parentBackedEntrypoints = entrypointCandidates.filter((entry) => {
    const parent = path.posix.dirname(entry);
    return parent !== '.' && baselineContains(immutablePaths, parent);
  });
  const selectedEntrypoints = existingEntrypoints.length > 0
    ? existingEntrypoints
    : parentBackedEntrypoints.length > 0
      ? [parentBackedEntrypoints[0]!]
      : entrypointCandidates.slice(0, 1);
  // The `state.mode` guess, and the widest consumer of it: every scaffold set
  // below is gated on it. Deliberately left as the guess, because what it
  // produces is a DECLARATION — a list of paths and owners in the compiled
  // contract, which nothing acts on until a writer does. The writers hold the
  // evidence: `ensureScaffoldContent` withholds every repository-convention body
  // from a project with commits, and seeds only missing-or-blank files. Adding a
  // second evidence gate here would instead make the contract itself disagree
  // with itself between runs as the tree fills in.
  const isNewProject = obj(state)?.mode === 'new-project';
  const i18n = resolveArchitectureI18n(profile, input, isNewProject, selectedEntrypoints);
  const scaffoldOutputs = resolveInitialScaffoldOwners(profile, [
    ...(isNewProject ? frontendScaffoldOutputs(profile) : []),
    ...(!isNewProject && (
      uiPrimitives.length > 0
      || input.modules.some((module) => module.placement === 'shared-ui')
    ) ? sharedUiScaffoldOutputs(profile) : []),
    ...uiPrimitiveScaffoldOutputs(profile, uiPrimitives),
    ...(isNewProject ? nativeScaffoldOutputs(profile) : []),
    ...((isNewProject || input.i18n) ? i18nScaffoldOutputs(i18n) : []),
    ...(isNewProject ? backendScaffoldOutputs(profile) : []),
    // NOT gated on `isNewProject`, unlike the manifest arm above it, and the
    // asymmetry is the point: a scaffold output CREATES a skeleton, so it belongs
    // to a greenfield tree, while a wiring home is the integration edge of a
    // framework that already exists. The existing-codebase case is the one that
    // needs it most — an established Laravel app already HAS `routes/api.php` and
    // the run's job is to add a route to it — and the compiled scope was measured
    // just as empty there as on a greenfield tree. `routeRegistrationOutputs` and
    // `testerOutputs` below are unconditional for the same reason.
    ...backendWiringOutputs(profile, immutablePaths),
    ...routeRegistrationOutputs(profile, input.routes),
    ...testerOutputs(profile, modules),
  ]);
  if (isNewProject) {
    appendUniqueScaffoldOutputs(scaffoldOutputs, repositoryScaffoldOutputs(profile));
    appendUniqueScaffoldOutputs(scaffoldOutputs, environmentScaffoldOutputs(profile));
    scaffoldOutputs.push(...workspaceManifestOutputs(scaffoldOutputs, modules));
    appendUniqueScaffoldOutputs(
      scaffoldOutputs,
      nodeToolingScaffoldOutputs(profile, scaffoldOutputs, immutablePaths),
    );
    appendUniqueScaffoldOutputs(scaffoldOutputs, backendQualityOutputs(profile));
    const duplicateScaffold = scaffoldOutputs.find((output, index) => (
      scaffoldOutputs.findIndex((candidate) => candidate.path === output.path) !== index
    ));
    if (duplicateScaffold) {
      throw new Error(`compiled scaffold output ${duplicateScaffold.path} has multiple owners`);
    }
    const repositoryOwner = selectedImplementationOwner(profile);
    if (repositoryOwner) {
      for (const required of REPOSITORY_SCAFFOLD_OUTPUTS) {
        const output = scaffoldOutputs.find((candidate) => candidate.path === required);
        if (!output || output.ownerRole !== repositoryOwner) {
          throw new Error(`repository scaffold ${required} is missing its deterministic owner`);
        }
      }
    }
  }
  const inputHash = contractHash(input);
  const allowedOutputs = [...new Set([
    ...selectedEntrypoints,
    ...modules.map((module) => module.output),
    ...scaffoldOutputs.map((output) => output.path),
  ])].sort();
  const runtimeOwnedOutput = allowedOutputs.find((output) => (
    output === 'AGENTS.md'
    || output === 'CLAUDE.md'
    || output === '.traffic-one'
    || output.startsWith('.traffic-one/')
  ));
  if (runtimeOwnedOutput) {
    throw new Error(`compiled output ${runtimeOwnedOutput} is runtime/materializer-owned`);
  }
  const withoutHash = {
    schemaVersion: COMPILED_ARCHITECTURE_SCHEMA_VERSION,
    runId,
    profile,
    baseline: compiledBaseline,
    sourceRoots: compiledSourceRoots,
    entrypoints: selectedEntrypoints,
    layers: profile.layerRoots,
    routes,
    modules,
    ...(uiPrimitives.length > 0 ? { uiPrimitives } : {}),
    ...(i18n ? { i18n } : {}),
    scaffoldOutputs,
    allowedOutputs,
    exceptions: input.exceptions || [],
    inputHash,
  };
  return {
    ...withoutHash,
    contractHash: contractHash(withoutHash),
  };
}

export function compileArchitectureForRun(
  projectRoot: string,
  runId: string,
  state: unknown,
  options: { persist?: boolean } = {},
): CompiledArchitectureV1 {
  const input = readJson<ArchitectureInputV1 | null>(architectureInputPath(projectRoot, runId), null);
  if (!input) throw new Error(`missing ${path.relative(projectRoot, architectureInputPath(projectRoot, runId))}`);
  const snapshot = ensureArchitectureRunSnapshot(projectRoot, runId, state);
  const frozenBaseline = readArchitectureRunBaseline(projectRoot, runId);
  if (!frozenBaseline || frozenBaseline.baselineHash !== snapshot.baselineHash) {
    throw new Error('immutable run baseline is missing or corrupt');
  }
  const inputHash = contractHash(input);
  // Baseline is mint-once for a run. Replanning recompiles topology against the
  // same snapshot rather than silently grandfathering code written mid-run.
  const compiled = compileArchitecture(
    projectRoot,
    runId,
    state,
    input,
    frozenBaseline.baseline,
    snapshot.profile,
  );
  if (compiled.inputHash !== inputHash) throw new Error('architecture input hash mismatch');
  // persist:false lets the completion gate validate the FULL candidate set
  // before anything touches disk. A compiled sidecar persisted next to a
  // DENIED digest flips every on-disk contract check while the role bootstraps
  // still describe the pre-compile world (observed 2cl: the live architect
  // lost all tool access mid-flight and had to be respawned).
  if (options.persist !== false) persistCompiledArchitecture(projectRoot, compiled);
  return compiled;
}

/**
 * Persist the compiled architecture, or THROW when the write chokepoint refused
 * it (fsjson.ts: an unanswered consent question, a planted symlink, a path that
 * escapes the state dir).
 *
 * Both callers used to drop that refusal and carry on describing a sidecar that
 * was never written — `compileArchitectureForRun` returned the in-memory
 * `compiled` object, and the architect accept path published verification-v2.json
 * and assignments.json against a `contractHash` no file on disk carried. It was
 * only ever caught downstream, and incidentally: publishRuntimeAssignments
 * re-reads architecture-v1.json, so the run was denied for "assignments could not
 * be persisted" — naming a file that was fine.
 *
 * A throw rather than a widened return, for the reason compileVerificationContract
 * already gives: the value both callers hand back is non-nullable and consumed at
 * ~20 assertion sites, and an architecture that could not be persisted is not an
 * architecture. Both production paths run inside a gate's try/catch, which turns
 * this into that gate's own deny — never a failed tool call.
 */
export function persistCompiledArchitecture(
  projectRoot: string,
  compiled: CompiledArchitectureV1,
): void {
  if (!writeJson(compiledArchitecturePath(projectRoot, compiled.runId), compiled)) {
    throw new Error(
      `the compiled architecture for run ${compiled.runId} could not be persisted: `
      + 'the project state write fence refused .traffic-one/runs/'
      + `${compiled.runId}/architecture-v1.json`,
    );
  }
}

export function readCompiledArchitecture(
  projectRoot: string,
  runId: string,
): CompiledArchitectureV1 | null {
  const raw = readJson<CompiledArchitectureV1 | null>(compiledArchitecturePath(projectRoot, runId), null);
  if (!raw || raw.schemaVersion !== COMPILED_ARCHITECTURE_SCHEMA_VERSION || raw.runId !== runId) return null;
  const { contractHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}
