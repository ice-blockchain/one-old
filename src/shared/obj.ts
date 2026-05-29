// src/shared/obj.ts
// Tiny shared helpers used across the engine: the `Rec` record alias and the
// `obj()` narrowing guard (plain object, not null/array). Consolidated here so
// the same two definitions aren't redeclared in every module.

export type Rec = Record<string, unknown>;

export function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}
