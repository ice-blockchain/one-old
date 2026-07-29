// src/shared/opencode-plan/unit-types.ts
// The plan-delegation unit shape, alone in a leaf so opencode-queue no longer
// imports it from opencode-roles (which imports runtime helpers from the queue
// -- a real module cycle that only erased because the import was type-only).

export interface PlanDelegationUnit {
  id?: string;
  role: string;
  files: string;
  task: string;
  kind?: string;
  dependsOn?: string[];
}
