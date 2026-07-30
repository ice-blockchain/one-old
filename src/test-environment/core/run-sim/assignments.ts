// src/test-environment/core/run-sim/assignments.ts
// The inversion that keeps this tier maintainable: the COMPILED CONTRACT
// enumerates paths, the case supplies semantics per module id.
//
// Compiled output paths are born inside the PLAN_READY transaction (naming.ts
// for modules, scaffold.ts for the scaffold tables). A case that hardcoded
// `apps/web/src/pages/Home.tsx` would break the moment the compiler changed a
// root — across every case at once. Reading them back from the published
// assignments instead means a new scaffold output is picked up automatically
// and immediately exercised.

import {
  type CompiledArchitectureV1,
  type CompiledArchitectureModuleV1,
} from '../../../shared/architecture-contract';
import { obj, type Rec } from '../../../shared/obj';

export interface ImplementContext {
  runId: string;
  architecture: CompiledArchitectureV1;
  /** Compiled outputs this role is allowed to write, in contract order. */
  outputsFor(role: string): string[];
  /** Semantic module id → its compiled output path. */
  outputOf(moduleId: string): string | null;
  /** Reverse: compiled path → the module it implements, when it is one. */
  moduleAt(rel: string): CompiledArchitectureModuleV1 | null;
  /** Roles that actually own a work unit in this run. */
  roles(): string[];
  entrypoints: string[];
}

// assignments.json entries are `{ role, summary, scope }` with the allowlist
// under `scope.include`. Typed loosely here on purpose: the harness must not
// re-declare a runtime shape it does not own.
function scopeInclude(assignment: Rec): string[] {
  const scope = obj(assignment.scope);
  const include = scope?.include;
  return Array.isArray(include) ? include.filter((v): v is string => typeof v === 'string') : [];
}

export function buildImplementContext(
  runId: string,
  architecture: CompiledArchitectureV1,
  assignments: { assignments: unknown[] },
): ImplementContext {
  const byRole = new Map<string, string[]>();
  for (const raw of assignments.assignments) {
    const assignment = obj(raw);
    if (!assignment) continue;
    const role = typeof assignment.role === 'string' ? assignment.role : '';
    if (!role) continue;
    const existing = byRole.get(role) ?? [];
    byRole.set(role, [...existing, ...scopeInclude(assignment)]);
  }

  const moduleByPath = new Map<string, CompiledArchitectureModuleV1>();
  const outputById = new Map<string, string>();
  for (const module of architecture.modules) {
    moduleByPath.set(module.output, module);
    outputById.set(module.id, module.output);
  }

  return {
    runId,
    architecture,
    outputsFor: (role) => byRole.get(role) ?? [],
    outputOf: (moduleId) => outputById.get(moduleId) ?? null,
    moduleAt: (rel) => moduleByPath.get(rel) ?? null,
    roles: () => [...byRole.keys()],
    entrypoints: architecture.profile.entrypoints ?? [],
  };
}
