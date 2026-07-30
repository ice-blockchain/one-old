// src/modules/plan-guard/react-structure/types.ts
// Finding ids/severities, report schema, and the internal analysis shapes.

import * as path from 'path';
import {   type AssignedScope } from '../../../shared/scope';

export const STRUCTURE_REPORT_SCHEMA_VERSION = 1 as const;
export const STRUCTURE_SCAN_DEFAULT_MAX_FILES = 10_000;

export type StructureFindingId =
  | 'STRUCT_ENTRYPOINT_COMPONENT'
  | 'STRUCT_APP_INLINE_PAGE'
  | 'STRUCT_MULTI_PAGE_MODULE'
  | 'STRUCT_ROUTE_MODULE_MISMATCH'
  | 'STRUCT_ROUTE_PATH_UNRESOLVED'
  | 'STRUCT_MISSING_PLANNED_MODULE'
  | 'STRUCT_ORPHAN_MODULE'
  | 'STRUCT_API_CLIENT_UNUSED'
  | 'STRUCT_TAILWIND_NO_TOOLCHAIN'
  | 'STRUCT_HARDCODED_COPY'
  | 'STRUCT_I18N_RUNTIME'
  | 'STRUCT_I18N_REACT_TRANS'
  | 'STRUCT_I18N_CATALOG'
  | 'STRUCT_LAYER_MISMATCH'
  | 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP'
  | 'STRUCT_SCAN_INCOMPLETE'
  | 'STRUCT_COMPONENT_LOC'
  | 'STRUCT_FUNCTION_COUNT'
  | 'STRUCT_COMPONENTS_PER_FILE'
  | 'STRUCT_MODULE_LOC'
  | 'STRUCT_COLLAPSED_LINE';

export interface StructureFinding {
  id: StructureFindingId;
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  message: string;
}

export interface StructureReportV1 {
  schemaVersion: typeof STRUCTURE_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  contractHash: string;
  status: 'passed' | 'warnings' | 'failed';
  complete: boolean;
  filesScanned: number;
  findings: StructureFinding[];
}

export interface StructureScanOptions {
  maxFiles?: number;
  allowlist?: string[];
  assignmentScope?: AssignedScope;
  generatedAt?: string;
  /**
   * True only for `mode: "new-project"`, where Traffic One owns the whole
   * structure and may block on its own conventions. On an EXISTING codebase the
   * plugin does not own the conventions, so integration findings whose accuracy
   * depends on them (orphan module, unused API package, styling system) degrade
   * to warnings: a maintenance run must never deadlock on a repo the plugin did
   * not create — a component reached by a dynamic string import, an API package
   * consumed from a source root outside the contract, or Tailwind arriving via
   * a preset are all legitimate shapes this scanner cannot see.
   */
  greenfield?: boolean;
}

export interface ComponentDeclaration {
  name: string;
  index: number;
  line: number;
  logicalLoc: number;
}

export interface ImportBinding {
  local: string;
  imported: string;
  source: string;
}

export interface RouteUsage {
  path: string;
  index: number;
  line: number;
  targetNames: string[];
  importSources: string[];
  inlineUi: boolean;
  laravelTargets?: Array<{
    kind: 'view' | 'inertia';
    name: string;
  }>;
  /**
   * Controller/callable routes are valid Laravel routing, but resolving their
   * return value without PHP execution is not safely provable. In that case
   * the compiled page's separate file-existence gate remains authoritative.
   */
  opaqueLaravelTarget?: boolean;
}

// A route whose `path` attribute/property EXISTS but is not a plain string
// literal (`path={courseRoute}`, `path={\`/x/${'{id}'}\`}`). The extractor
// cannot verify it against the compiled contract, so the route is invisible —
// and before this field existed, the resulting mismatch deny never said WHY
// (observed 1co: the agent improvised `'/'` escapes until the run died).
export interface UnresolvedRoute {
  display: string;
  line: number;
}

export interface SourceAnalysis {
  file: string;
  text: string;
  components: ComponentDeclaration[];
  functionCount: number;
  imports: ImportBinding[];
  routes: RouteUsage[];
  unresolvedRoutes: UnresolvedRoute[];
  routerSignal: boolean;
  inlineHostUi: { index: number; line: number } | null;
}

export interface CacheEntry {
  mtimeMs: number;
  size: number;
  analysis: SourceAnalysis;
}

export const STRUCTURAL_SOURCE_RE = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|html|php|css|scss|swift|kt|dart)$/i;
export const ANALYZABLE_UI_RE = /\.(?:tsx?|jsx?|mjs|cjs|vue)$/i;
export const SKIP_RE = /(^|\/)(?:\.git|\.traffic-one|node_modules|dist|build|coverage|out|\.turbo|\.next|\.vite|generated|__generated__|tests?|__tests__|fixtures?|stories)(?:\/|$)|\.(?:test|spec|stories?)\.[^.]+$/i;
