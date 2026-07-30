// src/modules/plan-guard/react-structure/contract.ts
// Contract-aware checks: route/module matching against the compiled
// architecture and the allowlist coverage findings.

import * as fs from 'fs';
import * as path from 'path';
import {
  canonicalRoutePath,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../../shared/capabilities';
import { matchesPattern, matchesScope, type AssignedScope } from '../../../shared/scope';

import {
  tailwindToolchainPresent,
  tailwindUtilityEvidence,
} from '../../../shared/tailwind-evidence';

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

interface StructureTextContractOptions {
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

// A module is "referenced" when any OTHER analyzed source file imports,
// lazy-imports, or re-exports it. Re-export bindings come from
// importBindings, so barrel routing counts. A dead import (imported but
// unused symbol) still counts as referenced — false negatives are acceptable
// here, false positives are not.
function moduleReferenced(
  moduleOutput: string,
  analyses: readonly SourceAnalysis[],
): boolean {
  const ownFile = normalizeRel(moduleOutput);
  return analyses.some((analysis) => (
    analysis.file !== ownFile
    && analysis.imports.some((binding) => (
      sourceMatchesModule(analysis.file, binding.source, moduleOutput)
    ))
  ));
}

// Planned workspace API packages (packages/*api*|*client*|*sdk*) that the web
// source never imports. Observed 8co: every learner route rendered static
// fixtures while the planned typed api-client package sat unimported —
// build/typecheck green, product non-functional.
function apiClientUsageFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: readonly SourceAnalysis[],
): StructureFinding[] {
  if (!contract.profile.surfaces.includes('web-ui')) return [];
  const packageDirs = new Set<string>();
  for (const output of contract.allowedOutputs) {
    const match = /^(packages\/[^/]*(?:api|client|sdk)[^/]*)\//i.exec(normalizeRel(output));
    if (match) packageDirs.add(match[1]!);
  }
  const findings: StructureFinding[] = [];
  for (const dir of [...packageDirs].sort()) {
    let packageName = '';
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(projectRoot, dir, 'package.json'), 'utf8'),
      ) as { name?: unknown };
      packageName = typeof manifest.name === 'string' ? manifest.name : '';
    } catch {
      continue; // package not scaffolded yet — the missing-module gate owns that
    }
    if (!packageName) continue;
    const used = analyses.some((analysis) => analysis.imports.some((binding) => (
      binding.source === packageName
      || binding.source.startsWith(`${packageName}/`)
      || (binding.source.startsWith('.') && sourceMatchesModule(analysis.file, binding.source, `${dir}/src/index`))
    )));
    if (!used) {
      findings.push({
        id: 'STRUCT_API_CLIENT_UNUSED',
        severity: 'error',
        file: dir,
        message: `Planned API package \`${packageName}\` (${dir}) is imported nowhere in the scanned source — the UI cannot be consuming the backend contract. Wire pages/features to it (live-or-demo) before reporting completion.`,
      });
    }
  }
  return findings;
}

// Tailwind utilities without a Tailwind toolchain render as unstyled text —
// the mismatch is invisible to build/typecheck/format (className strings are
// deliberately masked by the collapse scanner). Blocking, ≥3 distinct
// utilities per file keeps hand-written class names out (calibrated on 8co:
// fires on the delegated CourseCard/LessonOutline; zero hits on plain-CSS
// projects). The hardcoded-copy companion is ADVISORY (warning): the i18n
// heuristic is inherently fuzzier, so it informs the digest without denying.
function stylingFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: readonly SourceAnalysis[],
): StructureFinding[] {
  const findings: StructureFinding[] = [];
  const toolchainByDir = new Map<string, boolean>();
  const toolchainFor = (file: string): boolean => {
    const dir = path.posix.dirname(normalizeRel(file));
    if (!toolchainByDir.has(dir)) {
      toolchainByDir.set(dir, tailwindToolchainPresent(projectRoot, file));
    }
    return toolchainByDir.get(dir)!;
  };
  const i18nRuntimePresent = projectDeclaresI18nRuntime(projectRoot, contract);
  const copyLayers = [
    ...(contract.layers.pages || []),
    ...(contract.layers.components || []),
  ].map((layer) => normalizeRel(layer));
  for (const analysis of analyses) {
    if (!/\.(?:tsx|jsx|vue|svelte)$/i.test(analysis.file)) continue;
    const utilities = tailwindUtilityEvidence(analysis.text);
    if (utilities.count >= 3 && !toolchainFor(analysis.file)) {
      findings.push({
        id: 'STRUCT_TAILWIND_NO_TOOLCHAIN',
        severity: 'error',
        file: analysis.file,
        message: `File styles with ${utilities.count} distinct Tailwind utilities (${utilities.sample.join(', ')}) but no \`tailwindcss\` dependency or tailwind config is reachable — the classes are inert and the UI renders unstyled. Install/configure Tailwind or restyle with the project's actual styling system.`,
      });
    }
    if (i18nRuntimePresent
      && copyLayers.some((layer) => analysis.file.startsWith(`${layer}/`))
      && hardcodedCopySignals(analysis.text) >= 5) {
      findings.push({
        id: 'STRUCT_HARDCODED_COPY',
        severity: 'warning',
        file: analysis.file,
        message: 'User-facing copy is hardcoded in JSX while the project ships an i18n runtime — route the strings through the translation catalog (advisory).',
      });
    }
  }
  return findings;
}

function projectDeclaresI18nRuntime(
  projectRoot: string,
  contract: CompiledArchitectureV1,
): boolean {
  const manifests = new Set<string>(['package.json']);
  for (const root of contract.sourceRoots) {
    const parts = normalizeRel(root).split('/');
    // apps/web/src -> apps/web/package.json
    for (let depth = 1; depth < parts.length; depth += 1) {
      manifests.add(`${parts.slice(0, depth).join('/')}/package.json`);
    }
  }
  for (const rel of manifests) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(projectRoot, rel), 'utf8'),
      ) as Record<string, unknown>;
      for (const key of ['dependencies', 'devDependencies']) {
        const deps = manifest[key];
        if (deps && typeof deps === 'object' && !Array.isArray(deps)
          && ['i18next', 'react-i18next', 'vue-i18n', '@lingui/core', 'next-intl'].some((name) => (
            Object.prototype.hasOwnProperty.call(deps, name)
          ))) {
          return true;
        }
      }
    } catch {
      // manifest absent/unreadable — keep looking
    }
  }
  return false;
}

// JSX text literals of three or more words outside t()/<Trans> usage — a
// coarse signal, which is exactly why its finding is a warning, never a deny.
function hardcodedCopySignals(text: string): number {
  if (/\buseTranslation\b|\b<Trans\b|\bt\(\s*['"]/.test(text)) return 0;
  // Tokens may not contain angle brackets, so one match never spans elements.
  const matches = text.match(/>\s*[A-Za-z][^<>{}\n]*?(?:[ \t]+[^<>\s{}]+){2,}[ \t]*</g);
  return matches ? matches.length : 0;
}

export function contractFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: SourceAnalysis[],
  allowlist: string[] | undefined,
  assignmentScope: AssignedScope | undefined,
): StructureFinding[] {
  const findings: StructureFinding[] = [];
  const routeOutputs = new Set(contract.routes.map((route) => normalizeRel(route.moduleOutput)));
  const entrypointOutputs = new Set(contract.entrypoints.map((entry) => normalizeRel(entry)));
  // Reference-graph checks need a real scan behind them: with zero analyzed
  // files every module would read as an orphan. An incomplete walk is already
  // denied by STRUCT_SCAN_INCOMPLETE.
  const canCheckReferences = analyses.length > 0;
  for (const module of contract.modules) {
    if (!fs.existsSync(path.join(projectRoot, module.output))) {
      findings.push({
        id: 'STRUCT_MISSING_PLANNED_MODULE',
        severity: 'error',
        file: module.output,
        message: `Compiled ${module.kind} module is missing.`,
      });
      continue;
    }
    // Orphan check: a planned component/feature module that EXISTS but is
    // referenced by nothing is delivered-but-dead (observed 8co: authored
    // CourseCard/LessonOutline with zero call sites shipped as IMPLEMENTED).
    // Route modules and entrypoints are wired by the router/bootstrap and are
    // covered by their own checks.
    if (!canCheckReferences || !['component', 'feature'].includes(module.kind)) continue;
    const output = normalizeRel(module.output);
    if (routeOutputs.has(output) || entrypointOutputs.has(output)) continue;
    if (!moduleReferenced(module.output, analyses)) {
      findings.push({
        id: 'STRUCT_ORPHAN_MODULE',
        severity: 'error',
        file: module.output,
        message: `Planned ${module.kind} module exists but is imported nowhere in the scanned source — it is dead code, not an integrated deliverable. Import it from the page/feature that the plan pairs it with (or re-export it from a barrel that IS used).`,
      });
    }
  }
  if (canCheckReferences) {
    findings.push(...apiClientUsageFindings(projectRoot, contract, analyses));
    findings.push(...stylingFindings(projectRoot, contract, analyses));
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

