// src/shared/opencode-queue-policy.ts
// The queue policy engine: overlap/docs-only/dependency heuristics and the
// policy report. Pure over OpenCodeQueueUnit[] -- no filesystem access.

import * as path from 'path';
import type { PlanDelegationUnit } from '../opencode-plan/unit-types';
import { matchesPattern, matchesScope,  type AssignedScope } from '../scope';

import {
  UNIT_ID_RE,
  UNSAFE_ALLOWED_FILE_PATTERNS,
  type OpenCodeQueueUnit,
} from './types';
import {
  buildOpenCodeQueue,
  normalizeOpenCodeRole,
} from './store';

function literalStem(pattern: string): string {
  const idx = pattern.search(/[*?[\]{}()!+@]/);
  const stem = idx >= 0 ? pattern.slice(0, idx) : pattern;
  return stem.replace(/\/+$/, '');
}

/**
 * Allowlist entries the delegated-diff validator can never accept: generated
 * output and `.traffic-one/**`. The plan-queue validator has always rejected
 * these up front; the ad-hoc `opencode_delegate` path did not, so the same
 * entry was only discovered AFTER the model finished — the whole diff is then
 * discarded (observed 1cu-cursor: `.traffic-one/digests/<run>/backend.md` in
 * the allowlist burned four delegations and produced zero files).
 */
export function unsafeAllowedFilePatterns(allowedFiles: readonly string[]): string[] {
  return allowedFiles.filter((allowed) => UNSAFE_ALLOWED_FILE_PATTERNS.some(
    (pattern) => matchesPattern(allowed, pattern) || matchesPattern(literalStem(allowed) || allowed, pattern),
  ));
}

function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aStem = literalStem(a);
  const bStem = literalStem(b);
  if (aStem && bStem && (aStem.startsWith(`${bStem}/`) || bStem.startsWith(`${aStem}/`))) return true;
  return matchesPattern(aStem || a, b) || matchesPattern(bStem || b, a);
}

function unitsOverlap(a: OpenCodeQueueUnit, b: OpenCodeQueueUnit): boolean {
  for (const ap of a.allowedFiles) {
    for (const bp of b.allowedFiles) {
      if (patternsOverlap(ap, bp)) return true;
    }
  }
  return false;
}

function mentionsTestWork(task: string): boolean {
  return /\b(unit[- ]?test(?:able|s)?|testable|testability|tests?|testing|vitest|playwright|specs?)\b/i.test(task);
}

function mentionsInlineDependencyField(task: string): boolean {
  return /(^|\s)(depends|depends_on|dependson):/i.test(task);
}

function stripNegatedDependencyPhrases(task: string): string {
  return task
    .replace(/\b(?:no|without)\s+(?:external\s+)?(?:dependency|dependencies|deps?)\b/gi, '')
    .replace(/\b(?:no|without)\s+(?:dependency|dependencies|deps?)\/version\s+(?:changes?|updates?|work|edits?)\b/gi, '')
    .replace(/\b(?:no|without)\s+(?:dependency|dependencies|deps?|package[- ]manager|lockfiles?)\s+(?:changes?|updates?|work|edits?|writes?)\b/gi, '')
    // Verb-phrase negations: "do not add packages", "don't install anything",
    // "never bump dependencies", "avoid touching package.json". The clause is
    // stripped up to the next sentence/clause boundary so an affirmative
    // instruction later in the task ("… then run pnpm install X") survives.
    // Over-stripping only relaxes THIS unsafe-unit heuristic (8c: a negated
    // draft phrase still routed a pure-helpers unit off OpenCode).
    .replace(/\b(?:do\s+not|don'?t|never|avoid|without|not\s+to)\s+(?:add(?:ing)?|install(?:ing)?|remov(?:e|ing)|upgrad(?:e|ing)|updat(?:e|ing)|bump(?:ing)?|touch(?:ing)?|modify(?:ing)?|chang(?:e|ing)|edit(?:ing)?)\s+[^.;,\n]*/gi, '')
    // Reversed noun negations: "no changes to package.json", "without edits to
    // lockfiles" — the earlier patterns only cover "<neg> <noun> <change-word>".
    .replace(/\b(?:no|without|zero)\s+(?:changes?|updates?|edits?|writes?|modifications?)\s+to\s+[^.;,\n]*/gi, '');
}

function isDocumentationPath(p: string): boolean {
  const stem = literalStem(p) || p;
  return /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(stem)
    || /(^|\/)(readme|changelog|contributing|authors|notice|license)(\.[^/]*)?$/i.test(stem)
    || /(^|\/)docs?(\/|$)/i.test(stem);
}

// A docs-only unit (README/CHANGELOG/docs/**) cannot perform dependency work —
// its file allowlist is enforced downstream. Describing `npm install` steps in
// prose is documentation, not package-manager work (the readme-draft unit was
// falsely routed off OpenCode for documenting install commands).
function isDocsOnlyUnit(unit: OpenCodeQueueUnit): boolean {
  return unit.allowedFiles.length > 0 && unit.allowedFiles.every(isDocumentationPath);
}

function mentionsDependencyWork(unit: OpenCodeQueueUnit): boolean {
  if (isDocsOnlyUnit(unit)) return false;
  const kind = unit.kind || '';
  const task = stripNegatedDependencyPhrases(unit.task || '');
  if (/\b(deps?|dependencies|package[- ]?manager|lockfiles?)\b/i.test(kind)) return true;
  if (unit.allowedFiles.some((allowed) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/i.test(allowed))) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|dedupe|import|ci)\b/i.test(task)) return true;
  if (/\b(?:install|add|remove|upgrade|update|bump)\s+(?:a\s+|the\s+)?(?:dependency|dependencies|deps?|packages?)\b/i.test(task)) return true;
  if (/\b(?:write|modify|touch|regenerate|refresh|update|change)\s+(?:a\s+|the\s+)?(?:package[- ]manager\s+files?|lockfiles?)\b/i.test(task)) return true;
  if (/\b(?:package[- ]manager\s+files?|lockfiles?)\s+(?:changes?|updates?|writes?|edits?|work)\b/i.test(task)) return true;
  if (unit.allowedFiles.some((allowed) => /(^|\/)package\.json$/i.test(allowed))) {
    if (/\b(?:install|upgrade)\b/i.test(task)) return true;
    if (/\b(?:add|remove)\s+(?!(?:a\s+|the\s+|an\s+)?(?:scripts?|metadata|config|field|build|exports?|engines?|workspaces?)\b)\S+/i.test(task)) return true;
  }
  return false;
}

function allowsTestOrConfigPath(allowedFiles: string[]): boolean {
  return allowedFiles.some((allowed) => (
    /(^|\/)(tests?|e2e)\//i.test(allowed)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(allowed)
    || /(^|\/)(vitest|playwright|jest)\.config\.[cm]?[jt]s$/i.test(allowed)
  ));
}

export function openCodeQueuePolicyViolations(
  units: PlanDelegationUnit[],
  options: OpenCodeQueuePolicyOptions = {},
): string[] {
  return openCodeQueuePolicyReport(units, options).violations;
}

interface OpenCodeQueuePolicyReport {
  violations: string[];
  byUnitId: Map<string, string[]>;
}

export interface OpenCodeQueuePolicyOptions {
  /**
   * Per-role write assignments for the run (`runs/<runId>/assignments.json`).
   * Omitted → the scope cross-check is skipped (the plan can be authored before
   * the manifest exists); the runtime diff check still fails closed.
   */
  assignments?: ReadonlyArray<{ role: string; scope: AssignedScope }>;
}

// A glob cannot be compared against a scope pattern without false positives, so
// only LITERAL allowlist entries take part in the scope cross-check.
const GLOB_META_RE = /[*?[\]{}()!+@]/;

export function openCodeQueuePolicyReport(
  units: PlanDelegationUnit[],
  options: OpenCodeQueuePolicyOptions = {},
): OpenCodeQueuePolicyReport {
  const queue = buildOpenCodeQueue('', '', units);
  const violations: string[] = [];
  const byUnitId = new Map<string, string[]>();
  const idToIndex = new Map<string, number>();
  const scopesByRole = new Map<string, AssignedScope[]>();
  for (const assignment of options.assignments || []) {
    if (!assignment?.role || !assignment.scope) continue;
    const role = normalizeOpenCodeRole(assignment.role);
    scopesByRole.set(role, [...(scopesByRole.get(role) || []), assignment.scope]);
  }
  const add = (message: string, ...ids: Array<string | null | undefined>): void => {
    violations.push(message);
    for (const id of ids) {
      if (!id) continue;
      const existing = byUnitId.get(id) || [];
      existing.push(message);
      byUnitId.set(id, existing);
    }
  };

  for (let i = 0; i < queue.units.length; i++) {
    const unit = queue.units[i] as OpenCodeQueueUnit;
    const original = units[i] as PlanDelegationUnit | undefined;
    if (!original?.id || !UNIT_ID_RE.test(original.id)) {
      add(`OpenCode unit at position ${i + 1} needs a stable unique \`id\``, unit.id);
    }
    if (idToIndex.has(unit.id)) {
      add(`OpenCode unit id \`${unit.id}\` is duplicated; every queued unit needs a stable unique id`, unit.id);
    } else {
      idToIndex.set(unit.id, i);
    }
    if (unit.allowedFiles.length === 0) {
      add(`OpenCode unit \`${unit.id}\` has no parseable files allowlist`, unit.id);
    }
    if (mentionsDependencyWork(unit)) {
      add(`OpenCode unit \`${unit.id}\` appears to require dependency/package-manager work; route it to a paid subagent instead of OpenCode`, unit.id);
    }
    if (mentionsInlineDependencyField(unit.task)) {
      add(`OpenCode unit \`${unit.id}\` puts a dependency marker inside task text; add it as a pipe-delimited \`depends:\` field instead`, unit.id);
    }
    // Docs-only units document commands rather than perform them (same rationale
    // as the dependency exemption above): a CONTRIBUTING.md draft saying "run
    // `pnpm test` before a PR" is prose, not test work — its allowlist already
    // confines it to documentation files (observed false-deny on a root-docs unit).
    if (!isDocsOnlyUnit(unit) && mentionsTestWork(unit.task) && !allowsTestOrConfigPath(unit.allowedFiles)) {
      add(`OpenCode unit \`${unit.id}\` mentions tests/testability but its files allowlist does not include exact test/spec/config paths; either add those paths explicitly or remove the test acceptance criteria`, unit.id);
    }
    for (const allowed of unit.allowedFiles) {
      if (/[{}]/.test(allowed)) {
        add(`OpenCode unit \`${unit.id}\` uses ambiguous brace/glob syntax in files allowlist \`${allowed}\`; list explicit paths/areas instead`, unit.id);
      }
      if (allowed === '*' || allowed === '**' || allowed === '**/*') {
        add(`OpenCode unit \`${unit.id}\` uses an overbroad files allowlist \`${allowed}\`; list explicit source paths/areas instead`, unit.id);
      }
      if (unsafeAllowedFilePatterns([allowed]).length > 0) {
        add(`OpenCode unit \`${unit.id}\` allowlist includes generated/internal path \`${allowed}\``, unit.id);
      }
    }
    // A `feature` unit whose allowlist is ONLY the barrel forces the entire
    // feature into one file, and every source file is capped at 400 logical
    // lines by the compiled lint rule — so the unit's success becomes a coin
    // flip on model verbosity. Measured 16co: `news-fixtures` wrote 461 lines
    // into its single allowed `index.tsx`, the diff was discarded after 8
    // minutes, and the failure cascaded through the batch. The role's compiled
    // scope owns the feature DIRECTORY, so siblings are legal; requiring one in
    // the allowlist costs nothing (an unneeded listed sibling is simply never
    // written) and gives the model the escape hatch the size gate assumes.
    if (
      unit.kind === 'feature'
      && unit.allowedFiles.length === 1
      && /(^|\/)index\.[cm]?[jt]sx?$/.test(unit.allowedFiles[0] || '')
    ) {
      add(`OpenCode unit \`${unit.id}\` (kind feature) allows ONLY the barrel \`${unit.allowedFiles[0]}\`; with the 400-logical-line file cap this forces a coin flip on output size. Add the sibling files the content will need to \`files:\` (e.g. \`${(unit.allowedFiles[0] || '').replace(/index\.[cm]?[jt]sx?$/, 'selectors.ts')}\`) — the role owns the feature directory, and an unneeded listed sibling costs nothing`, unit.id);
    }
    // A unit's declared files must be writable BY ITS OWN ROLE. validateDelegatedDiff
    // already fails closed on this, but only AFTER the model ran: observed 17c, unit
    // `seo-public-assets` (role frontend) listed `.env.example`, which the same
    // architect's assignments.json gives to backend — a full delegation burned, and the
    // three in-scope files it did produce were rolled back with the rejected patch.
    const roleScopes = scopesByRole.get(normalizeOpenCodeRole(unit.role)) || [];
    if (roleScopes.length > 0) {
      const outside = unit.allowedFiles.filter((allowed) => !GLOB_META_RE.test(allowed)
        && !roleScopes.some((scope) => matchesScope(allowed, scope)));
      if (outside.length > 0) {
        // Remediation must be something the reader is ALLOWED to do: the same
        // gate that emits this denies the architect any write to assignments.json
        // ("do not scaffold assignments"), and runtime rehashes it anyway — so
        // "widen assignments.json" sent the architect down a path that can only
        // fail (observed 1cu-cursor: it dropped the units instead, halving the
        // delegation queue). Ownership comes from the module declaration.
        // Print real in-scope paths: "declare the module" alone still made
        // agents guess (observed 4cl: 4/5 units invented helper paths like
        // src/lib/format.ts that no module kind ever compiles, so their files
        // were unwritable for EVERYONE and the delegation silently fell back).
        const inScope = roleScopes
          .flatMap((scope) => scope.include)
          .filter((entry) => !GLOB_META_RE.test(entry));
        const sample = inScope.slice(0, 8).join(', ');
        const sampleTail = inScope.length > 8 ? ', …' : '';
        add(`OpenCode unit \`${unit.id}\` (role ${unit.role}) lists file(s) outside ${unit.role}'s assignment scope: ${outside.join(', ')}; retarget the unit to files ${unit.role} actually owns, move it to the owning role, or drop it. These files are NOT writable by the implementers either — the compiled scope is the whole write surface for this run, so fold the unit's content into an owned file instead. In-scope ${unit.role} files include: ${sample}${sampleTail}. \`runs/<runId>/assignments.json\` is runtime-owned and compiled from your ArchitectureInputV1 modules — declare the module under the owning role instead of editing that file.`, unit.id);
      }
    }
  }

  for (let i = 0; i < queue.units.length; i++) {
    const unit = queue.units[i] as OpenCodeQueueUnit;
    for (const dep of unit.dependsOn) {
      const depIndex = idToIndex.get(dep);
      if (depIndex === undefined) {
        add(`OpenCode unit \`${unit.id}\` depends on unknown unit \`${dep}\``, unit.id);
      } else if (depIndex >= i) {
        add(`OpenCode unit \`${unit.id}\` depends on \`${dep}\`, but dependencies must appear earlier in the queue`, unit.id);
      }
    }
  }

  for (let i = 0; i < queue.units.length; i++) {
    for (let j = i + 1; j < queue.units.length; j++) {
      const a = queue.units[i] as OpenCodeQueueUnit;
      const b = queue.units[j] as OpenCodeQueueUnit;
      if (!unitsOverlap(a, b)) continue;
      const ordered = b.dependsOn.includes(a.id) || a.dependsOn.includes(b.id);
      if (!ordered) {
        add(`OpenCode units \`${a.id}\` and \`${b.id}\` have overlapping files/areas; add an explicit \`depends:\` edge or split the files`, a.id, b.id);
      }
    }
  }

  return { violations, byUnitId };
}

/**
 * Unit kinds that PRODUCE the exported contracts other units in the same batch
 * consume, and the kinds that consume them. The architecture compiles each
 * module to its OWN file, so a consumer resolves a producer by module name —
 * the two allowlists never intersect and the overlap rule above (which needs
 * intersecting paths) is structurally blind to the edge.
 */
const PRODUCER_UNIT_KINDS = new Set(['feature', 'service', 'store']);
const CONSUMER_UNIT_KINDS = new Set(['page', 'component', 'app-shell', 'test']);

/**
 * Producer→consumer edges the queue did NOT declare, inferred from unit kinds.
 *
 * Consulted ONLY through `blockedByFailedDependencies`, i.e. only once a unit
 * has already FAILED: in a batch where nothing failed these edges change
 * nothing, so the inference can never cost a delegation that would have run.
 * When a producer HAS failed, its diff was rolled back with it and every later
 * same-role consumer is about to spend a full model run against exports that no
 * longer exist — measured 16co: `news-article-presentation` (kind page) burned
 * 565s and then failed `TS2305 … has no exported member 'getNewsBySlug'`
 * because `news-fixtures` (kind feature) had been reverted nine minutes
 * earlier. Their allowlists were disjoint, so nothing in the queue could see
 * the dependency and the plan declared no `depends:` edge.
 *
 * The prose asks the architect for that edge; this is the safety net for when
 * it is missing, deliberately narrow: same role only, producer strictly EARLIER
 * in the queue, declared edges never duplicated. A false edge costs one free
 * delegation in a batch that is already degraded; a missing one costs a full
 * model run plus, in maintenance, a fallback debt for work that never landed.
 */
export function implicitProducerDependencies(
  units: readonly OpenCodeQueueUnit[],
): Map<string, string[]> {
  const producersByRole = new Map<string, string[]>();
  const edges = new Map<string, string[]>();
  for (const unit of units) {
    const kind = (unit.kind || '').trim().toLowerCase();
    const role = normalizeOpenCodeRole(unit.role);
    if (CONSUMER_UNIT_KINDS.has(kind)) {
      const declared = new Set(unit.dependsOn);
      const inferred = (producersByRole.get(role) || [])
        .filter((id) => id !== unit.id && !declared.has(id));
      if (inferred.length > 0) edges.set(unit.id, inferred);
    }
    // Registered AFTER the consumer check so an edge is never derived from a
    // producer that runs later — the queue is walked in order.
    if (PRODUCER_UNIT_KINDS.has(kind)) {
      producersByRole.set(role, [...(producersByRole.get(role) || []), unit.id]);
    }
  }
  return edges;
}

// A unit whose declared `depends:` predecessor ended in one of these has no
// prerequisites on disk: running it burns a full delegation to fail the same way
// (17c: a tester unit spent 303s trying to CREATE the package its dependency
// never produced). `no_changes` and `skipped` are NOT blocking — the dependency
