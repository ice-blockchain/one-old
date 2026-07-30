// OpenCode i18n boundary normalization. The runtime may widen a frontend unit
// only with exact, compiled catalog outputs already owned by that role.

import {
  detectExistingI18nContract,
  projectDeclaresI18nRuntime,
} from '../../shared/i18n-enforcement';
import {
  readCompiledArchitecture,
  type CompiledArchitectureV1,
  type CompiledI18nContractV1,
} from '../../shared/architecture-contract';
import {
  parseAllowedFiles,
  normalizeOpenCodeRole,
} from '../../shared/opencode-queue';
import type { PlanDelegationUnit } from '../../shared/opencode-plan/unit-types';
import {
  matchesPattern,
  matchesScope,
} from '../../shared/scope';
import {
  readRunAssignmentsResilient,
} from '../../shared/state';

export interface OpenCodeI18nScope {
  allowedFiles: string[];
  injectedCatalogs: string[];
  prompt: string;
  error: string | null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isFrontendRole(role: string): boolean {
  return normalizeOpenCodeRole(role) === 'frontend';
}

function namespaceForModule(
  contract: CompiledArchitectureV1,
  module: CompiledArchitectureV1['modules'][number],
): string {
  if (module.kind === 'page') {
    const route = contract.routes.find((candidate) => (
      candidate.moduleId === module.id && !candidate.redirect
    ));
    return route?.id || module.id;
  }
  if (module.kind === 'feature') return module.id;
  return 'common';
}

function compiledCatalogsForPatterns(
  contract: CompiledArchitectureV1,
  patterns: readonly string[],
): string[] {
  if (!contract.i18n) return [];
  const namespaces = new Set<string>();
  for (const module of contract.modules) {
    if (patterns.some((pattern) => matchesPattern(module.output, pattern))) {
      namespaces.add(namespaceForModule(contract, module));
    }
  }
  if (contract.entrypoints.some((entry) => patterns.some((pattern) => matchesPattern(entry, pattern)))) {
    namespaces.add('common');
  }
  for (const catalog of contract.i18n.catalogs) {
    if (patterns.some((pattern) => matchesPattern(catalog.path, pattern))) {
      for (const namespace of catalog.namespaces) namespaces.add(namespace);
    }
  }
  const sourcePattern = patterns.some((pattern) => (
    /\.(?:tsx?|jsx?|vue|svelte|astro|swift|kt|dart)$/.test(pattern)
    || contract.sourceRoots.some((root) => matchesPattern(root, pattern) || matchesPattern(pattern, root))
  ));
  if (sourcePattern && namespaces.size === 0) namespaces.add('common');
  return unique(contract.i18n.catalogs
    .filter((catalog) => catalog.namespaces.some((namespace) => namespaces.has(namespace)))
    .map((catalog) => catalog.path));
}

function assignmentError(
  cwd: string,
  runId: string,
  role: string,
  injected: readonly string[],
): string | null {
  if (!runId || injected.length === 0) return null;
  const manifest = readRunAssignmentsResilient(cwd, runId);
  if (!manifest) return null;
  const scopes = manifest.assignments
    .filter((assignment) => normalizeOpenCodeRole(assignment.role) === normalizeOpenCodeRole(role))
    .map((assignment) => assignment.scope);
  const outside = injected.filter((catalog) => !scopes.some((scope) => matchesScope(catalog, scope)));
  return outside.length > 0
    ? `i18n catalog scope expansion is outside ${role}'s compiled assignment: ${outside.join(', ')}`
    : null;
}

function i18nPrompt(
  contract: CompiledArchitectureV1 | null,
  injected: readonly string[],
  detected?: CompiledI18nContractV1,
): string {
  const i18n = contract?.i18n || detected;
  if (!i18n && injected.length === 0) return '';
  const lines = [
    '',
    '## i18n contract (Traffic One — mandatory)',
    '- Every static React child string uses `<Trans ns="…" i18nKey="…">source fallback</Trans>`, including simple button/link/heading text.',
    '- Use `t()` only where a string value is required: props/attributes, metadata, validation, accessibility APIs, or imperative APIs. Never render `{t(...)}` as a React child.',
    '- Every `<Trans>` needs literal `ns`, literal `i18nKey`, and non-empty source-language children. Add every referenced key to every declared locale with a non-empty value.',
  ];
  if (i18n) {
    lines.push(`- Source locale: ${i18n.sourceLocale}; declared locales: ${i18n.locales.join(', ')}; namespaces: ${i18n.namespaces.join(', ')}.`);
    lines.push(`- Literal brand exceptions only: ${i18n.literalBrands.length > 0 ? i18n.literalBrands.join(', ') : '(none)'}.`);
  }
  if (injected.length > 0) lines.push(`- Catalog files added to this boundary: ${injected.join(', ')}.`);
  lines.push('- If the complete UI + catalog change cannot satisfy this contract, return no changes; a non-compliant diff is rolled back.');
  return lines.join('\n');
}

export function normalizeOpenCodeI18nScope(
  cwd: string,
  runId: string,
  role: string,
  allowedFiles: unknown,
): OpenCodeI18nScope {
  const allowed = parseAllowedFiles(allowedFiles);
  if (!isFrontendRole(role)) {
    return { allowedFiles: allowed, injectedCatalogs: [], prompt: '', error: null };
  }
  const contract = runId ? readCompiledArchitecture(cwd, runId) : null;
  const compiled = contract ? compiledCatalogsForPatterns(contract, allowed) : [];
  const touchesUi = allowed.some((file) => /\.(?:tsx?|jsx?|vue|svelte|astro|swift|kt|dart)$/.test(file));
  const detectedContract = !contract?.i18n && touchesUi ? detectExistingI18nContract(cwd) : undefined;
  const detected = detectedContract?.catalogs.map((catalog) => catalog.path) || [];
  const unresolvedExistingRuntime = !contract?.i18n
    && touchesUi
    && !detectedContract
    && projectDeclaresI18nRuntime(cwd, contract || undefined);
  const injectedCatalogs = unique([...compiled, ...detected])
    .filter((catalog) => !allowed.includes(catalog));
  const error = unresolvedExistingRuntime
    ? 'i18n runtime is present but no existing catalog paths can be detected; ad-hoc delegation fails closed because it cannot complete locale parity without inventing outputs'
    : assignmentError(cwd, runId, role, injectedCatalogs);
  const safeInjected = error ? [] : injectedCatalogs;
  return {
    allowedFiles: unique([...allowed, ...safeInjected]),
    injectedCatalogs: safeInjected,
    prompt: i18nPrompt(contract, safeInjected, detectedContract),
    error,
  };
}

export function normalizePlanI18nUnits(
  cwd: string,
  runId: string,
  units: readonly PlanDelegationUnit[],
): { units: PlanDelegationUnit[]; errors: Map<string, string> } {
  const errors = new Map<string, string>();
  const lastUnitByCatalog = new Map<string, string>();
  const normalized = units.map((unit, index) => {
    const scope = normalizeOpenCodeI18nScope(cwd, runId, unit.role, unit.files);
    const id = unit.id || `position-${index + 1}`;
    if (scope.error) errors.set(id, scope.error);
    const dependsOn = new Set(unit.dependsOn || []);
    for (const catalog of scope.injectedCatalogs) {
      const prior = lastUnitByCatalog.get(catalog);
      if (prior && prior !== unit.id) dependsOn.add(prior);
      if (unit.id) lastUnitByCatalog.set(catalog, unit.id);
    }
    return {
      ...unit,
      files: scope.allowedFiles.join(','),
      dependsOn: [...dependsOn],
    };
  });
  return { units: normalized, errors };
}
