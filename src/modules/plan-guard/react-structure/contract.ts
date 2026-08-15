// src/modules/plan-guard/react-structure/contract.ts
// Contract-aware checks: route/module matching against the compiled
// architecture and the allowlist coverage findings.

import * as fs from 'fs';
import * as path from 'path';
import { readRegularFile } from '../../../shared/bounded-read';
import {
  canonicalRoutePath,
  moduleOutputVariants,
  uiAstLintLayer,
  webPackageRoot,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../../shared/capabilities';
import { matchesPattern, matchesScope, type AssignedScope } from '../../../shared/scope';

import {
  tailwindToolchainPresent,
  tailwindUtilityEvidence,
} from '../../../shared/tailwind-evidence';
import {
  analyzeI18nSourceText,
  detectExistingI18nContract,
  projectDeclaresI18nRuntime,
  validateI18nCatalogs,
  type I18nReference,
} from '../../../shared/i18n-enforcement';

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

/**
 * BOUNDED (shared/bounded-read.ts): every read below opens a path the PROJECT
 * chose — a `packages/<name>` manifest, `components.json`, the shared UI public
 * API — from a PreToolUse hook, where a FIFO's `open(2)` never returns and no
 * timeout exists to notice. It THROWS for a non-regular object so each caller's
 * existing catch owns it, which is the arm those catches already describe: "not
 * scaffolded yet", "the framework scaffold owns a missing manifest", "missing
 * public API is already covered above".
 *
 * Two of those catches then ask `fs.existsSync`, so a planted FIFO at
 * `components.json` reports "must be valid JSON" rather than naming the shape.
 * That is imprecise and deliberately left: it is a legible deny an operator can
 * act on, in the fail-closed direction, and inventing a fourth message here
 * would be a bigger change than the hazard warrants.
 */
function readProjectFile(absolute: string): string {
  const text = readRegularFile(absolute);
  if (text === null) throw new Error(`not-a-regular-file: ${absolute}`);
  return text;
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
  return normalizeRel(value).replace(/\.(?:blade\.php|tsx?|jsx?|mjs|cjs|vue|svelte|astro|html)$/, '');
}

// Node/Vite resolve `./features/foo` to `./features/foo/index`. The compiled
// feature output is the index file; comparing stems without that suffix made
// every directory-imported feature an orphan (observed: lazy-loaded
// event-search-feature / bidding-feature, then `--unblock` offered as the fix).
function stemEqualsOrIndex(candidate: string, outputStem: string): boolean {
  return outputStem === candidate || outputStem === `${candidate}/index`;
}

// Shared with the architecture contract so a route declared as `*` (or `/*`)
// matches the `path="*"` every router uses in code. Comparing the two spellings
// literally made the catch-all unsatisfiable from both directions.
// Frameworks spell the same route parameter differently: react-router and
// vue-router use `:slug`, Laravel uses `{slug}` (or `{slug?}`), Next uses
// `[slug]`. The COMPILED contract always holds `:slug` — the input validator
// accepts nothing else — so an observed route had to be normalized to it or a
// correct routes/web.php could never match its own contract. Deliberately local
// to this comparison rather than added to the shared canonicalizer: contract
// route paths are hashed, and nothing authored may contain the other spellings
// anyway, so widening the shared function would risk hash churn for no gain.
function normalizedRoutePath(value: string): string {
  return canonicalRoutePath(value)
    // `{slug}` / `{slug?}` (Laravel) and `[slug]` / `[...slug]` (Next).
    .replace(/\{\.{0,3}([A-Za-z0-9_]+)\??\}/g, ':$1')
    .replace(/\[\.{0,3}([A-Za-z0-9_]+)\]/g, ':$1');
}

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
    return stemEqualsOrIndex(resolved, outputStem);
  }
  const aliasTail = sourceStem.startsWith('@/') || sourceStem.startsWith('~/')
    ? sourceStem.slice(2)
    : sourceStem.startsWith('/')
      ? sourceStem.slice(1)
      : /^@[^/]+\//.test(sourceStem)
        ? sourceStem.replace(/^@[^/]+\//, '')
        : sourceStem;
  return aliasTail.includes('/')
    && (stemEqualsOrIndex(aliasTail, outputStem)
      || outputStem.endsWith(`/${aliasTail}`)
      || outputStem.endsWith(`/${aliasTail}/index`));
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
      return normalizedOutput.endsWith(`resources/views/${normalizedName}.blade.php`);
    }
    const outputStem = normalizedOutput.replace(/\.(?:tsx?|jsx?|vue)$/, '');
    const inertiaStem = /(?:^|\/)resources\/js\/(?:Pages|pages)\/(.+)$/.exec(outputStem)?.[1] || '';
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

// When the extractor saw ZERO matching usages and no non-literal path, the
// page module named in the finding is not the file to edit — the app shell
// lost (or never had) a `<Route path>` / `createBrowserRouter` `path:` for
// this contract route. Observed: every page mismatched, the agent retried
// `frontend.md` four times, and App.tsx was never mentioned.
function missingRouteTableNote(
  analyses: readonly SourceAnalysis[],
  contract: CompiledArchitectureV1,
  routePath: string,
  moduleOutput: string,
): string {
  const shell = contract.modules.find((module) => module.kind === 'app-shell')?.output
    || 'the app shell';
  const page = path.posix.basename(moduleOutput).replace(/\.[^.]+$/, '');
  const snippet = `\`<Route path="${routePath}" element={<${page} />} />\``;
  if (!analyses.some((analysis) => analysis.routes.length > 0)) {
    return ` NOTE: no \`<Route path>\` / \`createBrowserRouter\` \`path:\` was found in the scanned source. Register this route on the app shell (\`${shell}\`): ${snippet}.`;
  }
  return ` NOTE: a router table was found but it has no literal path \`${routePath}\` bound to this module. Add ${snippet} on the app shell (\`${shell}\`).`;
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
  severity: StructureFinding['severity'],
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
        readProjectFile(path.join(projectRoot, dir, 'package.json')),
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
        severity,
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
// projects). i18n has its own occurrence-aware scanner below.
function stylingFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: readonly SourceAnalysis[],
  severity: StructureFinding['severity'],
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
  for (const analysis of analyses) {
    if (!/\.(?:tsx|jsx|vue|svelte)$/i.test(analysis.file)) continue;
    const utilities = tailwindUtilityEvidence(analysis.text);
    if (utilities.count >= 3 && !toolchainFor(analysis.file)) {
      findings.push({
        id: 'STRUCT_TAILWIND_NO_TOOLCHAIN',
        severity,
        file: analysis.file,
        message: `File styles with ${utilities.count} distinct Tailwind utilities (${utilities.sample.join(', ')}) but no \`tailwindcss\` dependency or tailwind config is reachable — the classes are inert and the UI renders unstyled. Install/configure Tailwind or restyle with the project's actual styling system.`,
      });
    }
  }
  return findings;
}

function uiSystemFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: readonly SourceAnalysis[],
  severity: StructureFinding['severity'],
): StructureFinding[] {
  const uiSystem = contract.profile.uiSystem;
  if (uiSystem?.family !== 'shadcn' || !uiSystem.sharedRoot) return [];
  const findings: StructureFinding[] = [];
  const addMissing = (file: string, message: string): void => {
    findings.push({
      id: 'STRUCT_UI_SYSTEM_MISSING',
      severity,
      file,
      message,
    });
  };
  const required = [
    `${uiSystem.sharedRoot}/package.json`,
    `${uiSystem.sharedRoot}/components.json`,
    `${uiSystem.sharedRoot}/src/index.ts`,
    `${uiSystem.sharedRoot}/src/lib/utils.ts`,
    'packages/tailwind-config/package.json',
    'packages/tailwind-config/src/globals.css',
  ];
  for (const rel of required) {
    if (fs.existsSync(path.join(projectRoot, rel))) continue;
    addMissing(
      rel,
      `Resolved ${uiSystem.adapter} UI system is missing required shared scaffold ${rel}. Initialize the adapter in ${uiSystem.sharedRoot} before reporting completion.`,
    );
  }

  const packageManifestPath = `${uiSystem.sharedRoot}/package.json`;
  try {
    const manifest = JSON.parse(
      readProjectFile(path.join(projectRoot, packageManifestPath)),
    ) as { name?: unknown; exports?: unknown };
    if (manifest.name !== '@app/ui' || !manifest.exports) {
      addMissing(
        packageManifestPath,
        'The shared UI package must be named `@app/ui` and declare package exports; application code may not deep-import its internals.',
      );
    }
  } catch {
    if (fs.existsSync(path.join(projectRoot, packageManifestPath))) {
      addMissing(packageManifestPath, 'The @app/ui package manifest must be valid JSON.');
    }
  }

  const componentsPath = `${uiSystem.sharedRoot}/components.json`;
  try {
    const config = JSON.parse(
      readProjectFile(path.join(projectRoot, componentsPath)),
    ) as { $schema?: unknown; aliases?: unknown };
    const aliases = config.aliases && typeof config.aliases === 'object'
      ? config.aliases as Record<string, unknown>
      : {};
    if (typeof config.$schema !== 'string' || typeof aliases.ui !== 'string') {
      addMissing(
        componentsPath,
        `Canonical ${uiSystem.adapter} components.json must declare the official schema and a shared \`ui\` alias.`,
      );
    }
  } catch {
    if (fs.existsSync(path.join(projectRoot, componentsPath))) {
      addMissing(componentsPath, `Canonical ${uiSystem.adapter} components.json must be valid JSON.`);
    }
  }

  const appManifestPath = `${webPackageRoot(contract.profile)}/package.json`
    .replace(/^\.\//, '');
  try {
    const manifest = JSON.parse(
      readProjectFile(path.join(projectRoot, appManifestPath)),
    ) as Record<string, unknown>;
    const dependencies = {
      ...(manifest.dependencies && typeof manifest.dependencies === 'object'
        ? manifest.dependencies as Record<string, unknown>
        : {}),
      ...(manifest.devDependencies && typeof manifest.devDependencies === 'object'
        ? manifest.devDependencies as Record<string, unknown>
        : {}),
    };
    if (!dependencies['@app/ui']) {
      addMissing(
        appManifestPath,
        'The web application must declare the shared `@app/ui` workspace dependency.',
      );
    }
    if (!tailwindToolchainPresent(projectRoot, appManifestPath)) {
      addMissing(
        appManifestPath,
        `Resolved ${uiSystem.adapter} requires the profile-compatible Tailwind toolchain.`,
      );
    }
  } catch {
    // The framework scaffold owns a missing application manifest.
  }
  if (!analyses.some((analysis) => (
    /(?:@app\/tailwind-config|packages\/tailwind-config)\/(?:src\/)?globals\.css/.test(analysis.text)
  ))) {
    addMissing(
      appManifestPath,
      'The web application does not import the shared Tailwind/theme stylesheet from @app/tailwind-config.',
    );
  }

  let publicApi = '';
  try {
    publicApi = readProjectFile(
      path.join(projectRoot, uiSystem.sharedRoot, 'src', 'index.ts'),
    );
  } catch {
    // Missing public API is already covered above.
  }
  for (const primitive of contract.uiPrimitives || []) {
    const primitivePath = uiSystem.adapter === 'shadcn'
      ? `${uiSystem.sharedRoot}/src/components/ui/${primitive}.tsx`
      : `${uiSystem.sharedRoot}/src/components/ui/${primitive}`;
    if (!fs.existsSync(path.join(projectRoot, primitivePath))) {
      addMissing(
        primitivePath,
        `Catalog-selected shadcn primitive \`${primitive}\` is missing from ${uiSystem.sharedRoot}; add it with the active adapter CLI instead of hand-rolling it in the app.`,
      );
    }
    const componentName = primitive
      .split('-')
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join('');
    const escapedPrimitive = primitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (
      publicApi
      && !new RegExp(`components/ui/${escapedPrimitive}(?:['"]|/|$)`, 'i').test(publicApi)
      && !new RegExp(`\\b${componentName}\\b`).test(publicApi)
    ) {
      addMissing(
        `${uiSystem.sharedRoot}/src/index.ts`,
        `Catalog-selected primitive \`${primitive}\` is not exported by the @app/ui public API.`,
      );
    }
    const localDuplicate = analyses.find((analysis) => (
      !normalizeRel(analysis.file).startsWith(`${uiSystem.sharedRoot}/`)
      && new RegExp(`(?:^|/)components/ui/${escapedPrimitive}(?:[./]|$)`, 'i')
        .test(normalizeRel(analysis.file))
    ));
    if (localDuplicate) {
      findings.push({
        id: 'STRUCT_UI_PRIMITIVE_DUPLICATE',
        severity,
        file: localDuplicate.file,
        message: `App-local \`${primitive}\` duplicates the catalog-selected primitive in ${uiSystem.sharedRoot}. Import it through @app/ui instead.`,
      });
    }
    const sharedImport = analyses.some((analysis) => analysis.imports.some((binding) => (
      (binding.source === '@app/ui' || binding.source.startsWith('@app/ui/'))
      && (
        binding.imported === '*'
        || binding.imported === componentName
        || binding.local === componentName
      )
    )));
    if (!sharedImport) {
      const handRolled = analyses.find((analysis) => (
        !normalizeRel(analysis.file).startsWith(`${uiSystem.sharedRoot}/`)
        && analysis.components.some((component) => component.name === componentName)
      ));
      // Two different claims wore one id, and only one of them is a fact.
      //
      // HAND-ROLLED is verifiable and stays blocking: a duplicate of a
      // catalog primitive exists on disk, and the remedy — import it from
      // @app/ui — is always available and always correct.
      //
      // NOT-CONSUMED is a product judgment: whether every primitive the
      // ARCHITECT selected ought to be used. The role cannot resolve it — the
      // catalog is immutable after PLAN_READY, deleting the file trades this
      // finding for STRUCT_UI_SYSTEM_MISSING, and the gate's own passing
      // fixture is a `<Name>Demo.tsx`. Both times it was enforced, the answer
      // was faked usage: 14co built a hidden primitive preview in App.tsx, and
      // when the reviewer rejected it the next cycle built another one; 15co
      // satisfied it with inert wrappers that had no focus trap, Escape, or
      // keyboard handling. The reviewer caught both — because judging whether a
      // component is really used is review work, not scanning work. So it now
      // rides the batched quality ledger to that reviewer instead of blocking a
      // role that has no honest way to clear it.
      findings.push({
        id: 'STRUCT_UI_PRIMITIVE_NOT_SHARED',
        severity: handRolled ? severity : 'warning',
        file: handRolled?.file || primitivePath,
        message: handRolled
          ? `Component \`${componentName}\` hand-rolls the catalog-selected \`${primitive}\` primitive. Import it from @app/ui instead.`
          : `Catalog-selected primitive \`${primitive}\` is installed and exported but no surface imports it from @app/ui. Either compose it into a real surface, or say in your digest that the plan selected a primitive this product does not need — do NOT add a preview/demo block to satisfy the scan.`,
      });
    }
  }
  return findings;
}

function i18nFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: readonly SourceAnalysis[],
  severity: StructureFinding['severity'],
  greenfield: boolean,
): StructureFinding[] {
  const runtimePresent = projectDeclaresI18nRuntime(projectRoot, contract);
  const i18n = contract.i18n || (runtimePresent ? detectExistingI18nContract(projectRoot) : undefined);
  if (!i18n && !runtimePresent) return [];
  const findings: StructureFinding[] = [];
  if (greenfield && !runtimePresent) {
    findings.push({
      id: 'STRUCT_I18N_RUNTIME',
      severity: 'error',
      file: contract.i18n?.runtimeOutputs[0] || 'package.json',
      message: 'New UI project is missing its profile-selected i18n runtime/provider setup.',
    });
  }
  // Where the compiled eslint config carries a real AST i18n rule
  // (React-family, Vue — see scaffold-content.ts), the lexical copy findings
  // demote to warnings: the project's own `lint` run owns the blocking verdict
  // there, and the implementer lint gate proves that toolchain is runnable and
  // reaching. Profiles without an AST equivalent keep the blocking scanner —
  // retiring it there would be an enforcement coverage gap. Catalog and
  // runtime findings are data validation, not copy parsing, and never demote.
  const lexicalCopyDemoted = uiAstLintLayer(contract.profile) !== null;
  const sourceSeverity = (finding: { id: string }): StructureFinding['severity'] => (
    lexicalCopyDemoted
    && (finding.id === 'STRUCT_HARDCODED_COPY' || finding.id === 'STRUCT_I18N_REACT_TRANS')
      ? 'warning'
      : severity
  );
  const references: I18nReference[] = [];
  for (const analysis of analyses) {
    const source = analyzeI18nSourceText(
      analysis.file,
      analysis.text,
      contract.profile,
      i18n,
    );
    references.push(...source.references);
    findings.push(...source.findings.map((finding) => ({
      ...finding,
      severity: sourceSeverity(finding),
    })));
  }
  if (i18n) {
    findings.push(...validateI18nCatalogs(projectRoot, i18n, {
      references,
      requireAllCatalogs: true,
    }).map((finding) => ({
      ...finding,
      severity,
    })));
  }
  return findings;
}

export function contractFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: SourceAnalysis[],
  allowlist: string[] | undefined,
  assignmentScope: AssignedScope | undefined,
  greenfield = false,
): StructureFinding[] {
  // Integration severity: blocking only where Traffic One owns the structure.
  // See StructureScanOptions.greenfield — on an existing codebase these stay
  // advisory so a maintenance run cannot deadlock on conventions the plugin
  // did not author.
  const integrationSeverity: StructureFinding['severity'] = greenfield ? 'error' : 'warning';
  const findings: StructureFinding[] = [];
  const routeOutputs = new Set(contract.routes.map((route) => normalizeRel(route.moduleOutput)));
  const entrypointOutputs = new Set(contract.entrypoints.map((entry) => normalizeRel(entry)));
  // Reference-graph checks need a real scan behind them: with zero analyzed
  // files every module would read as an orphan. An incomplete walk is already
  // denied by STRUCT_SCAN_INCOMPLETE.
  const canCheckReferences = analyses.length > 0;
  for (const module of contract.modules) {
    // Extension freedom: the module is satisfied when ANY allowed-extension
    // variant of its base path exists — the toolchain, not this gate, judges
    // the chosen form. The orphan/import checks below are already
    // extension-blind (withoutModuleExtension).
    if (!moduleOutputVariants(module).some((variant) => (
      fs.existsSync(path.join(projectRoot, variant))
    ))) {
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
        severity: integrationSeverity,
        file: module.output,
        message: `Planned ${module.kind} module exists but is imported nowhere in the scanned source — it is dead code, not an integrated deliverable. Import it from the page/feature that the plan pairs it with (or re-export it from a barrel that IS used).`,
      });
    }
  }
  if (canCheckReferences) {
    findings.push(...apiClientUsageFindings(projectRoot, contract, analyses, integrationSeverity));
    findings.push(...stylingFindings(projectRoot, contract, analyses, integrationSeverity));
    findings.push(...uiSystemFindings(projectRoot, contract, analyses, integrationSeverity));
    findings.push(...i18nFindings(
      projectRoot,
      contract,
      analyses,
      integrationSeverity,
      greenfield,
    ));
  }

  if (profileUsesExplicitRouter(contract.profile)) {
    const cause = unresolvedRouteNote(analyses);
    for (const route of contract.routes.filter((item) => !item.redirect)) {
      // Extension freedom: a page delivered at a non-default allowed variant
      // must still prove its route wiring (routeUsesModule matches by stem, so
      // the default moduleOutput compares extension-blind below).
      const routeModule = contract.modules.find((module) => module.output === route.moduleOutput);
      const deliveredAt = routeModule ? moduleOutputVariants(routeModule) : [route.moduleOutput];
      if (!deliveredAt.some((variant) => fs.existsSync(path.join(projectRoot, variant)))) continue;
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
          message: `Route ${route.path} does not demonstrably use its compiled module ${route.moduleOutput}.${
            matchingUsages.length === 0 && cause === ''
              ? missingRouteTableNote(analyses, contract, route.path, route.moduleOutput)
              : cause
          }`,
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
