// src/modules/plan-guard/react-structure/contract.ts
// Contract-aware checks: route/module matching against the compiled
// architecture and the allowlist coverage findings.

import * as fs from 'fs';
import * as path from 'path';
import {
  canonicalRoutePath,
  type ArchitectureExceptionRequestV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../../shared/capabilities';
import { matchesPattern, matchesScope, type AssignedScope } from '../../../shared/scope';

import {
  type ImportBinding,
  type RouteUsage,
  type SourceAnalysis,
  type StructureFinding,
} from './types';
import {
  normalizeRel,
} from './parse';
import {
  analyzeText,
} from './analyze';
import {
  localFindings,
} from './findings';

export interface StructureTextContractOptions {
  allowlist?: string[];
  assignmentScope?: AssignedScope;
}

function profileUsesExplicitRouter(profile: CapabilityProfileV1): boolean {
  return [
    'vite-react',
    'generic-web',
    'vue',
    'angular',
  ].includes(profile.profileId)
    || (
      profile.profileId === 'server-rendered'
      && profile.framework === 'laravel'
    );
}

/**
 * Contract-aware hot path. It evaluates only the proposed contents of the
 * touched file, but still proves that every route observed in that file points
 * at the runtime-compiled module and that the work unit covers its planned
 * outputs. Missing routes/modules remain the responsibility of the complete
 * IMPLEMENTED/APPROVED scan.
 */
export function analyzeStructureTextAgainstContract(
  file: string,
  text: string,
  contract: CompiledArchitectureV1,
  options: StructureTextContractOptions = {},
): StructureFinding[] {
  const analysis = analyzeText(normalizeRel(file), text);
  const findings = localFindings(analysis, contract.profile, contract.exceptions);
  if (profileUsesExplicitRouter(contract.profile)) {
    const cause = unresolvedRouteNote([analysis]);
    for (const usage of analysis.routes) {
      const routePath = normalizedRoutePath(usage.path);
      const compiled = contract.routes.filter((route) => (
        !route.redirect && normalizedRoutePath(route.path) === routePath
      ));
      if (compiled.length > 0 && compiled.some((route) => (
        routeUsesModule(analysis, usage, route.moduleOutput)
      ))) continue;
      findings.push({
        id: 'STRUCT_ROUTE_MODULE_MISMATCH',
        severity: 'error',
        file: analysis.file,
        line: usage.line,
        message: (compiled.length === 0
          ? `Route ${usage.path} is not present in the runtime-compiled architecture contract.`
          : `Route ${usage.path} does not use its runtime-compiled module ${compiled.map((route) => route.moduleOutput).join(' or ')}.`) + cause,
      });
    }
  }
  if (options.allowlist !== undefined || options.assignmentScope) {
    for (const output of contract.allowedOutputs) {
      const covered = options.assignmentScope
        ? matchesScope(output, options.assignmentScope)
        : options.allowlist!.some((pattern) => matchesPattern(output, pattern));
      if (covered) continue;
      findings.push({
        id: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
        severity: 'error',
        file: output,
        message: 'Planned output is not covered by the work-unit assignment allowlist.',
      });
    }
  }
  return findings.sort((a, b) => (
    a.id.localeCompare(b.id)
    || a.file.localeCompare(b.file)
    || (a.line || 0) - (b.line || 0)
  ));
}


function withoutModuleExtension(value: string): string {
  return normalizeRel(value).replace(/\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|html)$/, '');
}

// Shared with the architecture contract so a route declared as `*` (or `/*`)
// matches the `path="*"` every router uses in code. Comparing the two spellings
// literally made the catch-all unsatisfiable from both directions.
const normalizedRoutePath = canonicalRoutePath;

function sourceMatchesModule(
  importerFile: string,
  importSource: string,
  moduleOutput: string,
): boolean {
  const outputStem = withoutModuleExtension(moduleOutput);
  const sourceStem = withoutModuleExtension(importSource);
  if (importSource.startsWith('.')) {
    const resolved = normalizeRel(path.posix.normalize(path.posix.join(
      path.posix.dirname(normalizeRel(importerFile)),
      sourceStem,
    )));
    return resolved === outputStem;
  }
  const aliasTail = sourceStem.startsWith('@/') || sourceStem.startsWith('~/')
    ? sourceStem.slice(2)
    : sourceStem.startsWith('/')
      ? sourceStem.slice(1)
      : /^@[^/]+\//.test(sourceStem)
        ? sourceStem.replace(/^@[^/]+\//, '')
        : sourceStem;
  return aliasTail.includes('/')
    && (outputStem === aliasTail || outputStem.endsWith(`/${aliasTail}`));
}

function bindingMatchesModule(
  analysis: SourceAnalysis,
  targetName: string,
  binding: ImportBinding,
  moduleOutput: string,
): boolean {
  if (sourceMatchesModule(analysis.file, binding.source, moduleOutput)) return true;
  const outputStem = withoutModuleExtension(moduleOutput);
  const outputName = path.posix.basename(outputStem);
  const outputDir = path.posix.dirname(outputStem);
  const targetParts = targetName.split('.');
  if (binding.imported === '*' && targetParts[1] !== outputName) return false;
  if (binding.imported !== '*' && binding.imported !== outputName && binding.imported !== 'default') return false;
  if (!binding.source.startsWith('.')) return false;
  const resolvedSource = normalizeRel(path.posix.normalize(path.posix.join(
    path.posix.dirname(normalizeRel(analysis.file)),
    withoutModuleExtension(binding.source),
  )));
  return resolvedSource === outputDir;
}

function routeUsesModule(
  analysis: SourceAnalysis,
  route: RouteUsage,
  moduleOutput: string,
): boolean {
  const normalizedOutput = normalizeRel(moduleOutput);
  if (route.laravelTargets?.some((target) => {
    const normalizedName = target.name
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\./g, '/');
    if (!normalizedName || normalizedName.includes('::')) return false;
    if (target.kind === 'view') {
      return normalizedOutput === `resources/views/${normalizedName}.blade.php`;
    }
    const outputStem = normalizedOutput.replace(/\.(?:tsx?|jsx?|vue)$/, '');
    const inertiaStem = /^resources\/js\/(?:Pages|pages)\/(.+)$/.exec(outputStem)?.[1] || '';
    return inertiaStem === normalizedName;
  })) {
    return true;
  }
  if (route.opaqueLaravelTarget) {
    // Controller execution is intentionally outside this static analyzer. The
    // caller already proved the compiled page file exists, so accepting this
    // indeterminate edge avoids rejecting valid controller routing while still
    // failing closed for absent routes and directly mismatched render targets.
    return true;
  }
  if (route.importSources.some((source) => sourceMatchesModule(analysis.file, source, moduleOutput))) {
    return true;
  }
  return route.targetNames.some((targetName) => {
    const local = targetName.split('.')[0]!;
    return analysis.imports
      .filter((binding) => binding.local === local)
      .some((binding) => bindingMatchesModule(analysis, targetName, binding, moduleOutput));
  });
}

// The actionable CAUSE for an unmatched contract route: when any analyzed file
// carries a non-literal `path`, the extractor could not see that route at all.
// Without this note the deny points at the page module with no line and no
// explanation (observed 1co: the agent kept "fixing" the slash instead of the
// literal until the run died).
function unresolvedRouteNote(analyses: readonly SourceAnalysis[]): string {
  const carriers = analyses.filter((analysis) => analysis.unresolvedRoutes.length > 0);
  if (carriers.length === 0) return '';
  const total = carriers.reduce((sum, analysis) => sum + analysis.unresolvedRoutes.length, 0);
  const sample = carriers[0]!;
  const first = sample.unresolvedRoutes[0]!;
  return ` NOTE: ${total} non-literal route path value(s) (e.g. \`${first.display}\` at ${sample.file}:${first.line}) cannot be verified — route \`path\` must be a plain string literal in the JSX attribute/object property.`;
}

export function contractFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: SourceAnalysis[],
  allowlist: string[] | undefined,
  assignmentScope: AssignedScope | undefined,
): StructureFinding[] {
  const findings: StructureFinding[] = [];
  for (const module of contract.modules) {
    if (!fs.existsSync(path.join(projectRoot, module.output))) {
      findings.push({
        id: 'STRUCT_MISSING_PLANNED_MODULE',
        severity: 'error',
        file: module.output,
        message: `Compiled ${module.kind} module is missing.`,
      });
    }
  }

  if (profileUsesExplicitRouter(contract.profile)) {
    const cause = unresolvedRouteNote(analyses);
    for (const route of contract.routes.filter((item) => !item.redirect)) {
      if (!fs.existsSync(path.join(projectRoot, route.moduleOutput))) continue;
      const routePath = normalizedRoutePath(route.path);
      const matchingUsages = analyses.flatMap((analysis) => (
        analysis.routes
          .filter((usage) => normalizedRoutePath(usage.path) === routePath)
          .map((usage) => ({ analysis, usage }))
      ));
      if (!matchingUsages.some(({ analysis, usage }) => (
        routeUsesModule(analysis, usage, route.moduleOutput)
      ))) {
        findings.push({
          id: 'STRUCT_ROUTE_MODULE_MISMATCH',
          severity: 'error',
          file: route.moduleOutput,
          message: `Route ${route.path} does not demonstrably use its compiled module ${route.moduleOutput}.${cause}`,
        });
      }
    }
  }

  if (allowlist || assignmentScope) {
    for (const output of contract.allowedOutputs) {
      if (assignmentScope ? matchesScope(output, assignmentScope) : allowlist!.some((pattern) => matchesPattern(output, pattern))) continue;
      findings.push({
        id: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
        severity: 'error',
        file: output,
        message: 'Planned output is not covered by the work-unit assignment allowlist.',
      });
    }
  }
  return findings;
}

