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
  | 'STRUCT_UI_SYSTEM_MISSING'
  | 'STRUCT_UI_PRIMITIVE_DUPLICATE'
  | 'STRUCT_UI_PRIMITIVE_NOT_SHARED'
  | 'STRUCT_HARDCODED_COPY'
  | 'STRUCT_I18N_RUNTIME'
  | 'STRUCT_I18N_REACT_TRANS'
  | 'STRUCT_I18N_CATALOG'
  | 'STRUCT_LAYER_MISMATCH'
  | 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP'
  | 'STRUCT_SCAN_INCOMPLETE'
  | 'STRUCT_SCAN_SKIPPED'
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
  /**
   * Present only when `complete` is false, and the whole reason the demotion is
   * legible: `bound` is the file CAP, which the verification contract
   * compensates for by pinning `uiImpact` to the truncated-scan floor, so
   * STRUCT_SCAN_INCOMPLETE is a warning there. `unresolvable` is a walk with no
   * tree to read, which nothing compensates, so the finding stays an error.
   * A consumer that must feed the floor reads THIS rather than re-deriving the
   * distinction from the finding's severity.
   *
   * `unaccounted` is the walk's own entry accounting failing to balance:
   * `readdir` returned entries no plan function ever disposed of. Also an
   * error, and unreachable in a correct walk — it exists so that a future edit
   * which drops entries by ANY spelling (a filter upstream of the walker, a
   * `break`, a `slice`, an index stride, a helper that swallows the exit)
   * surfaces as a report the reader can see, rather than as a smaller number.
   */
  truncationKind?: 'bound' | 'unresolvable' | 'unaccounted';
  /**
   * How many entries inside a compiled source root the walk stepped over and
   * kept going (`STRUCT_SCAN_SKIPPED`). NOT a truncation — the walk reached the
   * end of every other branch, so `complete` and `truncationKind` stay silent —
   * but not free either: what a skipped entry costs is the whole SUBTREE behind
   * it, including error-grade findings that will never appear in `findings`
   * because the files carrying them were never read. Measured with one collapsed
   * source file planted behind a directory link: `status: warnings`, the defect
   * absent, and no evidence owed.
   *
   * So this is the THIRD state — neither complete nor truncated — and the floor
   * reads it exactly as it reads `truncationKind: 'bound'`: any nonzero count
   * makes the run owe the truncated-scan `uiImpact` floor (see
   * `runFullStructureScan`). A count rather than a flag because the message list
   * is already in `findings`; this is the number the floor decision keys on.
   */
  skippedEntries: number;
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
  /**
   * True for any project Traffic One did not scaffold — the exact negation of
   * `greenfield`, which is why it is spelled as one: `!isNewProjectMode`.
   *
   * It was `isExistingProjectMode` (existing-* modes only), which left the
   * UNDECLARED mode as neither, and that is the mode where Traffic One knows
   * least about the project. It received the most opinion of the three: the
   * error-grade architectural findings all fired, while the nine toolchain
   * gates and the install table stood down around them. Undeclared is not
   * scaffolded, so it takes the same demotion an existing codebase takes.
   *
   * On a codebase Traffic One did not write, every architectural finding is an
   * OPINION about someone else's conventions — route/module wiring, entrypoint
   * conventions, strict collapse on pre-existing files, primitive sharing,
   * styling systems, the project's own catalog shape — so all of them demote to
   * warnings and a maintenance run can never dead-end on the user's own code.
   * Only ownership (`STRUCT_ASSIGNMENT_ALLOWLIST_GAP`) and plan delivery
   * (`STRUCT_MISSING_PLANNED_MODULE`) stay blocking, because neither is a
   * convention: one says this run wrote outside its WorkUnitContract, the other
   * that a module the compiled plan promised does not exist.
   *
   * Scan integrity is not in the demotion's reach at all: STRUCT_SCAN_INCOMPLETE
   * and STRUCT_SCAN_SKIPPED are pushed after it, because what a scan did not
   * read is a fact about the scan rather than an opinion about the code — see
   * their push sites in scan.ts for which of them blocks and why.
   */
  notScaffolded?: boolean;
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
// The build-output roots must stay in step with COLLAPSE_SKIP_DIR_RE in
// plan-readiness/context.ts. Anything missing here is not merely counted
// against STRUCTURE_SCAN_DEFAULT_MAX_FILES — it is ANALYZED, so a framework
// cache inside a source root gets structurally judged as if the user had
// authored it, and its emitted bundles are exactly the collapsed, oversized,
// hardcoded-copy shapes every finding here looks for. `.svelte-kit`, `.nuxt`
// and `.angular` are the SvelteKit/Nuxt/Angular equivalents of `.next`;
// `target` is the Rust/Maven one. Each matches a whole path segment, so a
// source file named `target.ts` is untouched.
export const SKIP_RE = /(^|\/)(?:\.git|\.traffic-one|node_modules|dist|build|coverage|out|target|\.turbo|\.next|\.nuxt|\.vite|\.svelte-kit|\.angular|generated|__generated__|tests?|__tests__|fixtures?|stories)(?:\/|$)|\.(?:test|spec|stories?)\.[^.]+$/i;
