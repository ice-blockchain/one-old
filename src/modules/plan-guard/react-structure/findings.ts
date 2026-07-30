// src/modules/plan-guard/react-structure/findings.ts
// Per-file structural findings: entrypoint and collapse rules with the architect
// exception filter.
//
// Numeric size budgets and page/layer placement used to live here as regex
// heuristics. They are now the project's own compiled eslint/prettier/ruff config
// (see architecture-contract/scaffold-content.ts), seeded at PLAN_READY so every
// implementer inherits the bar before writing. What remains here is what a linter
// cannot know: collapse on a tree with no node_modules yet, and — in contract.ts —
// agreement with the compiled architecture.

import * as path from 'path';
import {
  type ArchitectureExceptionRequestV1,
} from '../../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../../shared/capabilities';
import { collapsedLineNumber } from '../../../shared/collapsed-source';
import { matchesPattern } from '../../../shared/scope';

import {
  type SourceAnalysis,
  type StructureFinding,
  type StructureFindingId,
} from './types';
import { normalizeRel } from './parse';

const EXCEPTIONABLE_IDS = new Set<StructureFindingId>([
  // Deliberately NOT listed: STRUCT_ROUTE_PATH_UNRESOLVED. It is advisory, so an
  // exception would suppress nothing, and `validateExceptionRequest` rejects it
  // as ineligible anyway — keeping it here only made the two lists disagree
  // about the same vocabulary. Any id added here must also appear in
  // `architecture-contract/core.ts` EXCEPTION_RULES to be declarable.
]);
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
  const inlineRoutes = analysis.routes.filter((route) => route.inlineUi);
  // Entrypoint evidence grading: the compiled profile naming this file is
  // evidence; matching the `main|client` filename regex is a convention that
  // happens to hold for Vite-shaped stacks and not for others.
  const declaredEntrypoint = profile.entrypoints
    .some((entry) => normalizeRel(entry) === normalizeRel(analysis.file));

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
      severity: declaredEntrypoint ? 'error' : 'warning',
      file: analysis.file,
      line: first?.line || inline?.line || direct?.line,
      message: first
        ? `Entrypoint declares UI component ${first.name}; entrypoints may only bootstrap providers and the application shell.`
        : inline
          ? `Entrypoint declares UI markup inline for route ${inline.path}; entrypoints may only bootstrap providers and the application shell.`
          : 'Entrypoint declares UI markup inline; entrypoints may only bootstrap providers and the application shell.',
    });
  }

  // RETIRED — page/layer PLACEMENT is now the project's own lint config:
  //   STRUCT_APP_INLINE_PAGE, STRUCT_MULTI_PAGE_MODULE, STRUCT_LAYER_MISMATCH
  //     -> eslint `no-restricted-imports` path groups (and eslint-plugin-boundaries
  //        where a project wants stricter layering)
  // These three were the worst offenders in the whole scanner because they could
  // only ever guess. `pageLike` carried a hardcoded product name list
  // (`Home|Catalog|CourseDetail|Lesson|…`), the app-shell test was a literal
  // `App.tsx` regex that silently never matched Vue `App.vue`, Nuxt `app.vue`,
  // Next `layout.tsx` or SvelteKit `+layout.svelte`, and a `React.lazy` binding
  // read as a locally declared page — so the canonical code-splitting idiom was
  // denied while the identical file with static imports passed.
  //
  // A lint config states the boundary in import paths, which is what the rule was
  // always about, and it works for every stack without a name table.
  // Route↔module correctness itself is NOT retired: `contractFindings` still
  // proves it against the compiled architecture, which no linter can know.

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

  // RETIRED — the project's own toolchain owns every numeric size budget now:
  //   STRUCT_MODULE_LOC          -> eslint `max-lines` (400), ruff, golangci funlen
  //   STRUCT_COMPONENT_LOC       -> eslint `max-lines-per-function`
  //   STRUCT_FUNCTION_COUNT      -> eslint `complexity` / max-lines-per-function
  //   STRUCT_COMPONENTS_PER_FILE -> the same config, per project taste
  // Runtime compiles those configs per stack and seeds them at PLAN_READY, so
  // every implementer inherits the bar before it writes a line. Keeping a second,
  // regex-based copy here bought nothing and cost repeatedly: the statement
  // counter read string bodies as code and reported 1233 logical lines for a
  // 358-line file, which made a module its owning role could not legally edit.
  //
  // STRUCT_COLLAPSED_LINE above deliberately stays: prettier makes collapse
  // impossible, but the write gate and the OpenCode post-apply check both run on
  // trees that have no node_modules yet, so the formatter cannot be reached there.
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

