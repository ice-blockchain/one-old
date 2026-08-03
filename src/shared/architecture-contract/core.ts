// src/shared/architecture-contract/core.ts
// Rule sets, route grammar, canonical route spelling, and the stable-JSON
// contract hash shared by every sibling.

import * as path from 'path';
import { sha256 } from '../text';

export const MEMORY_DIR = '.traffic' + '-one';
export const BLOCKED_EXCEPTION_RULES = new Set([
  'STRUCT_ENTRYPOINT_COMPONENT',
  'STRUCT_MULTI_PAGE_MODULE',
  'STRUCT_ROUTE_MODULE_MISMATCH',
  'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
  'STRUCT_SCAN_INCOMPLETE',
]);
export const EXCEPTION_RULES = new Set([
  'STRUCT_COMPONENT_LOC',
  'STRUCT_FUNCTION_COUNT',
  'STRUCT_COMPONENTS_PER_FILE',
  // Blocking, unlike its neighbours here — but a compound primitive family under
  // `packages/ui` can legitimately exceed the module budget, and the glob
  // constraint below already confines the escape to exactly those. Authored
  // application modules keep only one remedy: split the file.
  'STRUCT_MODULE_LOC',
]);
export const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
// `*` (bare) is the router-idiomatic catch-all every SPA needs for its 404.
// Requiring a leading slash made it undeclarable, and the structural gate then
// compared the contract path literally against the `path="*"` in code — so the
// only legal outcome was shipping without a not-found route at all (2cu shipped
// exactly that, leaving its compiled NotFoundPage module unreachable).
export const ROUTE_PATH_RE = /^(?:\*|\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%{}[\]-]+\/?)*)$/;

/**
 * One canonical spelling for the catch-all so the compiled contract and the
 * route table in code always agree: `*`, `/*`, and `/**` are the same route.
 * Shared with the structural gate — keep the two in sync.
 */
export function canonicalRoutePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '*' || trimmed === '/*' || trimmed === '/**') return '*';
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '') || '/';
}
// Display-only field: the kebab-case `id` drives paths, so common title
// punctuation is safe here. Path/markup metacharacters stay excluded
// (observed 2cl: "Content schema, RLS, and seeds" cost the architect a
// deny cycle over the comma).
export const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9 ,.()&+':-]{0,79}$/;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sorted(child)]),
  );
}

export function stableContractJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

export function contractHash(value: unknown): string {
  return sha256(stableContractJson(value));
}

export function normalizeRelative(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function baselineContains(paths: ReadonlySet<string>, candidate: string): boolean {
  return paths.has(candidate)
    || [...paths].some((entry) => entry.startsWith(`${candidate.replace(/\/+$/, '')}/`));
}
