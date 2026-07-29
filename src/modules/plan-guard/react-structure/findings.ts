// src/modules/plan-guard/react-structure/findings.ts
// Per-file structural findings: entrypoint/page/collapse/module-LOC rules
// with the architect exception filter.

import * as path from 'path';
import {
  canonicalRoutePath,
  type ArchitectureExceptionRequestV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../../shared/capabilities';
import { collapsedLineNumber, lexicalMask } from '../../../shared/collapsed-source';
import { matchesPattern, matchesScope, type AssignedScope } from '../../../shared/scope';

import {
  type SourceAnalysis,
  type StructureFinding,
  type StructureFindingId,
} from './types';
import {
  logicalLoc,
  normalizeRel,
  unique,
} from './parse';

const EXCEPTIONABLE_IDS = new Set<StructureFindingId>([
  'STRUCT_COMPONENT_LOC',
  'STRUCT_FUNCTION_COUNT',
  'STRUCT_COMPONENTS_PER_FILE',
  'STRUCT_MODULE_LOC',
  // Advisory, not blocking: dynamic route paths (`path={ROUTES.x}`,
  // `routes.map(...)`) are legitimate patterns the contract simply cannot
  // verify. The blocking signal stays STRUCT_ROUTE_MODULE_MISMATCH, whose
  // message now carries this cause.
  'STRUCT_ROUTE_PATH_UNRESOLVED',
]);
const ADVISORY_FUNCTION_COUNT = 12;
// The one numeric threshold that BLOCKS. Per-component LOC and
// components-per-file stay advisory (rules/common/clean-code.md: numeric
// thresholds wait on a <1% false-positive fixture validation), but a module
// that packs an entire feature into one file is unambiguous: observed 6co,
// `pages/Catalog.tsx` shipped 515 logical lines / 7 components with all nine
// structural signals raised as non-blocking warnings, so `IMPLEMENTED` was
// accepted. Calibrated against that project: Catalog 515, next-largest module
// 307 — 400 separates the monolith from merely-large modules.
//
// It counts LOGICAL lines (the same collapse-resistant measure as
// STRUCT_COMPONENT_LOC), so minifying the module onto a handful of lines does
// not evade it — this is also the only size signal that runs on every scanned
// write rather than only at the frontend's `IMPLEMENTED` digest.
const BLOCKING_MODULE_LOC = 400;
// Generated declaration/type modules are legitimately enormous and nobody
// authored them: a Supabase `database.types.ts` is 198 logical lines from 85
// physical ones in 6co alone, and scales with the schema. Blocking those would
// be an unescapable deadlock on a file the implementer cannot shrink.
const GENERATED_MODULE_RE = /\.(?:d|types|generated)\.[cm]?[jt]sx?$/i;


function isEntrypoint(file: string, profile: CapabilityProfileV1): boolean {
  const normalized = normalizeRel(file);
  return profile.entrypoints.some((entry) => normalizeRel(entry) === normalized)
    || /(^|\/)(?:main|client)\.(?:tsx?|jsx?|mjs|cjs)$/.test(normalized);
}

function isBootstrapEntrypoint(file: string, profile: CapabilityProfileV1): boolean {
  const normalized = normalizeRel(file);
  if (/(^|\/)(?:main|client)\.(?:tsx?|jsx?|mjs|cjs)$/.test(normalized)) return true;
  return ['vite-react', 'generic-web'].includes(profile.profileId)
    && profile.entrypoints.some((entry) => normalizeRel(entry) === normalized);
}

function underAny(file: string, roots: string[]): boolean {
  const normalized = normalizeRel(file);
  return roots.some((root) => {
    const normalizedRoot = normalizeRel(root).replace(/\/+$/, '');
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
}

function pageLike(name: string): boolean {
  return /(?:Page|Screen|View)$/.test(name)
    || /^(?:Home|Catalog|CourseDetail|Lesson|Learning|News|Dashboard|Profile|Settings)$/.test(name);
}

function exceptionCovers(
  finding: StructureFinding,
  exceptions: ArchitectureExceptionRequestV1[],
): boolean {
  if (!EXCEPTIONABLE_IDS.has(finding.id)) return false;
  return exceptions.some((exception) => (
    exception.ruleId === finding.id
    && matchesPattern(finding.file, exception.glob)
  ));
}

export function localFindings(
  analysis: SourceAnalysis,
  profile: CapabilityProfileV1,
  exceptions: ArchitectureExceptionRequestV1[],
): StructureFinding[] {
  const findings: StructureFinding[] = [];
  const componentNames = new Set(analysis.components.map((component) => component.name));
  const localTargets = unique(analysis.routes.flatMap((route) => (
    route.targetNames
      .map((name) => name.split('.')[0]!)
      .filter((name) => componentNames.has(name))
  )));
  const localRouteUnits = unique(analysis.routes.flatMap((route) => {
    const named = route.targetNames
      .map((name) => name.split('.')[0]!)
      .filter((name) => componentNames.has(name))
      .map((name) => `component:${name}`);
    return route.inlineUi ? [...named, `inline:${route.index}`] : named;
  }));
  const inlineRoutes = analysis.routes.filter((route) => route.inlineUi);
  const pageComponents = analysis.components.filter((component) => (
    localTargets.includes(component.name) || pageLike(component.name)
  ));

  if (
    isEntrypoint(analysis.file, profile)
    && (analysis.components.length > 0 || inlineRoutes.length > 0 || analysis.inlineHostUi)
    && (
      isBootstrapEntrypoint(analysis.file, profile)
      || analysis.routerSignal
      || analysis.components.length > 1
    )
  ) {
    const first = analysis.components[0];
    const inline = inlineRoutes[0];
    const direct = analysis.inlineHostUi;
    findings.push({
      id: 'STRUCT_ENTRYPOINT_COMPONENT',
      severity: 'error',
      file: analysis.file,
      line: first?.line || inline?.line || direct?.line,
      message: first
        ? `Entrypoint declares UI component ${first.name}; entrypoints may only bootstrap providers and the application shell.`
        : inline
          ? `Entrypoint declares UI markup inline for route ${inline.path}; entrypoints may only bootstrap providers and the application shell.`
          : 'Entrypoint declares UI markup inline; entrypoints may only bootstrap providers and the application shell.',
    });
  }

  const appShell = /(^|\/)App\.(?:tsx?|jsx?)$/.test(analysis.file);
  if (appShell && localRouteUnits.length >= 1) {
    const first = analysis.components.find((component) => localTargets.includes(component.name));
    findings.push({
      id: 'STRUCT_APP_INLINE_PAGE',
      severity: 'error',
      file: analysis.file,
      line: first?.line || inlineRoutes[0]?.line,
      message: 'Application shell declares a route page inline; pages must live in their compiled page modules.',
    });
  }

  if (localRouteUnits.length >= 2) {
    findings.push({
      id: 'STRUCT_MULTI_PAGE_MODULE',
      severity: 'error',
      file: analysis.file,
      line: pageComponents[0]?.line || inlineRoutes[0]?.line,
      message: `Module contains multiple inline page/route targets (${localTargets.length > 0 ? localTargets.join(', ') : inlineRoutes.map((route) => route.path).join(', ')}).`,
    });
  }

  if (
    pageComponents.length > 0
    && !underAny(analysis.file, profile.layerRoots.pages)
    && !isEntrypoint(analysis.file, profile)
    && !appShell
  ) {
    findings.push({
      id: 'STRUCT_LAYER_MISMATCH',
      severity: 'error',
      file: analysis.file,
      line: pageComponents[0]?.line,
      message: 'Route page is outside the runtime-compiled page roots.',
    });
  }

  // Comments and string bodies are masked first: a module is "too long" by its
  // code, not its documentation, and counting comment lines would also break the
  // pretty-vs-minified parity the rest of this scanner guarantees (610 lines of
  // `// filler` must not outrank the same code on one line).
  const collapsedLine = collapsedLineNumber(analysis.file, analysis.text);
  if (collapsedLine !== null) {
    findings.push({
      id: 'STRUCT_COLLAPSED_LINE',
      severity: 'error',
      file: analysis.file,
      line: collapsedLine,
      message: `Line ${collapsedLine} packs an entire function/component onto one line. Collapsed source is a defect even when build and typecheck pass — write one statement per line and one JSX element per line.`,
    });
  }

  const moduleLoc = GENERATED_MODULE_RE.test(analysis.file)
    ? 0
    : logicalLoc(lexicalMask(analysis.text, true));
  if (moduleLoc > BLOCKING_MODULE_LOC) {
    findings.push({
      id: 'STRUCT_MODULE_LOC',
      severity: 'error',
      file: analysis.file,
      message: `Module is approximately ${moduleLoc} logical lines, over the ${BLOCKING_MODULE_LOC} limit. Split it along its own seams — routes, pages, features, and shared components each belong in their own module under the compiled layer roots.`,
    });
  }

  if (analysis.components.length > 1) {
    findings.push({
      id: 'STRUCT_COMPONENTS_PER_FILE',
      severity: 'warning',
      file: analysis.file,
      line: analysis.components[1]?.line,
      message: `Module declares ${analysis.components.length} UI components; the numeric one-component-per-file limit is advisory during rollout.`,
    });
  }
  for (const component of analysis.components) {
    if (component.logicalLoc <= 150) continue;
    findings.push({
      id: 'STRUCT_COMPONENT_LOC',
      severity: 'warning',
      file: analysis.file,
      line: component.line,
      message: `${component.name} is approximately ${component.logicalLoc} logical lines; the 150 LOC threshold is advisory during rollout.`,
    });
  }
  if (analysis.functionCount > ADVISORY_FUNCTION_COUNT) {
    findings.push({
      id: 'STRUCT_FUNCTION_COUNT',
      severity: 'warning',
      file: analysis.file,
      message: `Module declares ${analysis.functionCount} top-level functions; the ${ADVISORY_FUNCTION_COUNT}-function threshold is advisory during rollout.`,
    });
  }
  if (analysis.unresolvedRoutes.length > 0) {
    const first = analysis.unresolvedRoutes[0]!;
    findings.push({
      id: 'STRUCT_ROUTE_PATH_UNRESOLVED',
      severity: 'warning',
      file: analysis.file,
      line: first.line,
      message: `${analysis.unresolvedRoutes.length} route path value(s) (e.g. \`${first.display}\`) are not plain string literals, so contract verification cannot see them; prefer literal \`path\` strings.`,
    });
  }
  return findings.filter((finding) => !exceptionCovers(finding, exceptions));
}

