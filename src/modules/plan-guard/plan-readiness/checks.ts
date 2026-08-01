// src/modules/plan-guard/plan-readiness/checks.ts
// Evidence checks: QA-report freshness vs implementation, built-app
// identity, and the collapsed-product-source scan.

import * as fs from 'fs';
import * as path from 'path';
import {
  capabilityProfileForRun,
  moduleOutputVariants,
  readCompiledArchitecture,
} from '../../../shared/architecture-contract';
import { collapsedLineNumber, isCollapseCandidate } from '../../../shared/collapsed-source';
import { obj } from '../../../shared/obj';
import { type AssignedScope, matchesScope } from '../../../shared/scope';
import { readVerificationContract } from '../../../shared/verification-contract';
import {
  type StructureFinding,
} from '../react-structure';

import {
  COLLAPSE_LINE_CHARS,
  COLLAPSE_MAX_FILES,
  COLLAPSE_SKIP_DIR_RE,
  COLLAPSE_SOURCE_RE,
  type Rec,
} from './context';

/**
 * Compiled modules a given role owns that do not exist on disk — the same
 * existence test `contractFindings` reports as `STRUCT_MISSING_PLANNED_MODULE`,
 * scoped to one owner so a completion gate can raise it against the role that
 * can actually fix it.
 *
 * The full structure scan only runs at the reviewer's `APPROVED`, which is far
 * too late: a missing planned module discovered there costs a whole fix cycle
 * (observed 10co, where it hit the two-cycle cap and needed a user
 * authorization to recover).
 */
export function missingPlannedModulesForRole(
  projectRoot: string,
  runId: string,
  ownerRole: string,
): string[] {
  if (!runId) return [];
  const architecture = readCompiledArchitecture(projectRoot, runId);
  if (!architecture) return [];
  return (architecture.modules || [])
    .filter((module) => module.ownerRole === ownerRole && module.output)
    // Extension freedom: delivered at ANY allowed variant counts; the missing
    // path reported stays the DEFAULT concrete output.
    .filter((module) => !moduleOutputVariants(module).some((variant) => (
      fs.existsSync(path.join(projectRoot, variant))
    )))
    .map((module) => module.output)
    .sort();
}

/**
 * The share of its OWN compiled contract a role has actually delivered.
 *
 * Observed 10co-e2e: `verification-v2.json` asserted 15 changed files because
 * `changedPaths = observedChangedPaths ∪ plannedOutputs` and
 * `observedChangedPaths` was EMPTY — on disk exactly one of the 15 existed,
 * while root `package.json` declared `"test": "vitest run"` and `"test:e2e":
 * "playwright test"` against a `vitest.config.ts` and a `playwright.config.ts`
 * that were never written. The role still reported `IMPLEMENTED`.
 *
 * Scoped to the role's own compiled modules, and an output the verification
 * contract genuinely OBSERVED as changed is never counted missing (a delete is
 * a delivery). Both narrowings exist so legitimate partial work — another
 * role's share, a path the baseline diff already accounts for — cannot be
 * blocked by this gate.
 */
export function undeliveredContractOutputs(
  projectRoot: string,
  runId: string,
  ownerRole: string,
): { missing: string[]; planned: number } | null {
  if (!runId) return null;
  const architecture = readCompiledArchitecture(projectRoot, runId);
  if (!architecture) return null;
  const planned = (architecture.modules || [])
    .filter((module) => module.ownerRole === ownerRole && module.output);
  if (planned.length === 0) return null;
  const observed = new Set(readVerificationContract(projectRoot, runId)?.observedChangedPaths || []);
  // Extension freedom: ANY allowed variant observed as changed or present on
  // disk is a delivery; the missing path reported stays the DEFAULT output.
  const missing = planned
    .filter((module) => !moduleOutputVariants(module).some((variant) => (
      observed.has(variant) || fs.existsSync(path.join(projectRoot, variant))
    )))
    .map((module) => module.output)
    .sort();
  return missing.length > 0 ? { missing, planned: planned.length } : null;
}

export /**
 * A QA report that predates the newest implementer digest, i.e. a sweep that did not see
 * the code it claims to cover. Mirrors the settlement floor exactly: the report's
 * `generatedAt` FIELD (never its mtime — a re-copied file would look fresh) versus the
 * implementer digest mtimes. Returns null when there is no report, no implementer digest,
 * or the report is current — the caller must stay silent in every ambiguous case.
 */
function qaReportOlderThanImplementation(
  projectRoot: string,
  runId: string,
): { generatedAt: string; digest: string; digestAt: string } | null {
  if (!runId || /[\\/]/.test(runId)) return null;
  const memoryDir = '.traffic' + '-one';
  let generatedAtMs = 0;
  let generatedAt = '';
  try {
    const raw = JSON.parse(fs.readFileSync(
      path.join(projectRoot, memoryDir, 'reports', 'qa', runId, 'report.json'), 'utf8',
    )) as { generatedAt?: unknown };
    generatedAt = typeof raw?.generatedAt === 'string' ? raw.generatedAt : '';
    generatedAtMs = Date.parse(generatedAt);
  } catch {
    return null; // no report → other gates own that case
  }
  if (!Number.isFinite(generatedAtMs) || generatedAtMs <= 0) return null;
  let newest: { digest: string; digestAt: string; ms: number } | null = null;
  for (const name of ['frontend.md', 'senior-frontend.md', 'backend.md', 'senior-backend.md']) {
    try {
      const st = fs.statSync(path.join(projectRoot, memoryDir, 'digests', runId, name));
      if (!st.isFile() || st.size <= 0) continue;
      const ms = Math.floor(st.mtimeMs);
      if (!newest || ms > newest.ms) {
        newest = { digest: name, digestAt: new Date(ms).toISOString(), ms };
      }
    } catch {
      // digest absent under this spelling
    }
  }
  if (!newest || newest.ms <= generatedAtMs) return null;
  return { generatedAt, digest: newest.digest, digestAt: newest.digestAt };
}

// ── Lighthouse claim reconciliation ─────────────────────────────────────────
// Observed 10co-e2e: `.traffic-one/reports/lighthouse/` carried no run id and no
// build fingerprint, so report files survived across runs indistinguishably. The
// frontend self-ran Lighthouse 13.2.0 (before the `^12.8.2` pin existed), scored
// 0.98, and shipped "performance 98" downstream in its digest with verdict
// IMPLEMENTED — against a canonical runner measurement of 74. A number an agent
// types is a claim; the runner's evidence sidecar is the measurement.
const LIGHTHOUSE_LINE_RE = /\b(?:lighthouse|page[\s-]?speed)\b/i;
const PERFORMANCE_CLAIM_RE = /\bperformance\b[^0-9\n]{0,40}(\d{1,3})([^\n]{0,4})/i;

export function claimedLighthousePerformance(
  content: string,
): { value: number; line: string } | null {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !LIGHTHOUSE_LINE_RE.test(line)) continue;
    const match = PERFORMANCE_CLAIM_RE.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value < 0 || value > 100) continue;
    // `performance 4527 ms` is a metric, not a score.
    if (/^\s*(?:ms|s\b|kb|mb)/i.test(match[2] || '')) continue;
    return { value, line: line.length > 240 ? `${line.slice(0, 240)}…` : line };
  }
  return null;
}

/** The canonical runner's Lighthouse Performance score for this run, if any. */
export function canonicalLighthousePerformance(
  projectRoot: string,
  runId: string,
): number | null {
  if (!runId || /[\\/]/.test(runId)) return null;
  const memoryDir = '.traffic' + '-one';
  const qaDir = path.join(projectRoot, memoryDir, 'reports', 'qa', runId);
  try {
    const report = JSON.parse(fs.readFileSync(path.join(qaDir, 'report-v2.json'), 'utf8')) as {
      lighthouse?: { evidencePath?: unknown };
    };
    const evidencePath = report?.lighthouse?.evidencePath;
    if (typeof evidencePath !== 'string'
      || !evidencePath
      || path.isAbsolute(evidencePath)
      || evidencePath.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')) {
      return null;
    }
    const evidence = JSON.parse(fs.readFileSync(path.join(qaDir, evidencePath), 'utf8')) as {
      producer?: unknown;
      runId?: unknown;
      performance?: unknown;
    };
    if (evidence?.producer !== 'traffic-one-qa-runner' || evidence?.runId !== runId) return null;
    return typeof evidence.performance === 'number' && Number.isFinite(evidence.performance)
      ? evidence.performance
      : null;
  } catch {
    return null;
  }
}

// Identity of the build(s) currently on disk: the entry asset the built HTML
// references (Vite/CRA `dist|out/index.html`) or the Next `BUILD_ID`. Bounded to the
// project root and one level of `apps/*` — enough for every stack the plugin
// scaffolds, and it never walks node_modules.
export function builtAppIdentities(projectRoot: string): string[] {
  const roots = [projectRoot];
  try {
    for (const entry of fs.readdirSync(path.join(projectRoot, 'apps'), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(projectRoot, 'apps', entry.name));
    }
  } catch {
    // no apps/ dir — single-package project
  }
  const found = new Set<string>();
  for (const root of roots) {
    // HTML-entry layouts. Only Vite/CRA `dist|out` were recognized before, so
    // Nuxt, SvelteKit, Angular and Laravel returned NO identity at all — which
    // silently disabled the `tester-qa-build-identity-*` gates instead of failing
    // them. A gate that cannot see a build is worse than one that denies.
    for (const outDir of [
      'dist', 'out',
      '.output/public', // Nuxt
      'build', // SvelteKit adapter-static
      'public/build', // Laravel + Vite
    ]) {
      try {
        const html = fs.readFileSync(path.join(root, outDir, 'index.html'), 'utf8');
        const match = /<script[^>]+src="([^"]+\.js)"/.exec(html);
        if (match?.[1]) found.add(path.basename(match[1]));
      } catch {
        // not built with this layout
      }
    }
    // Angular nests one directory per app under dist/, with the entry in browser/.
    try {
      for (const entry of fs.readdirSync(path.join(root, 'dist'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const nested of [path.join(entry.name, 'browser'), entry.name]) {
          try {
            const html = fs.readFileSync(path.join(root, 'dist', nested, 'index.html'), 'utf8');
            const match = /<script[^>]+src="([^"]+\.js)"/.exec(html);
            if (match?.[1]) found.add(path.basename(match[1]));
          } catch {
            // not this nesting
          }
        }
      }
    } catch {
      // no dist/ dir
    }
    // Manifest-only builds: Laravel/Vite emits no index.html, and the manifest
    // names the hashed entry files.
    for (const manifestPath of ['public/build/manifest.json', 'public/build/.vite/manifest.json']) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8')) as
          Record<string, { file?: unknown }>;
        for (const entry of Object.values(manifest)) {
          if (typeof entry?.file === 'string' && entry.file) found.add(path.basename(entry.file));
        }
      } catch {
        // not a Vite manifest build
      }
    }
    try {
      const buildId = fs.readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim();
      if (buildId && buildId.length <= 200) found.add(buildId);
    } catch {
      // not a Next build
    }
  }
  return [...found];
}

// `verifiedBuild` as the tester recorded it. `null` when there is no readable
// report at all, so the other QA gates keep owning that case.
export function qaReportVerifiedBuild(
  projectRoot: string,
  runId: string,
): { present: boolean; value: string } | null {
  if (!runId || /[\\/]/.test(runId)) return null;
  const memoryDir = '.traffic' + '-one';
  try {
    const raw = JSON.parse(fs.readFileSync(
      path.join(projectRoot, memoryDir, 'reports', 'qa', runId, 'report.json'), 'utf8',
    )) as { verifiedBuild?: unknown };
    const value = typeof raw?.verifiedBuild === 'string' ? raw.verifiedBuild.trim() : '';
    return { present: value.length > 0, value };
  } catch {
    return null;
  }
}

// One summary format for every structural deny. Reporting only `id:file`
// withheld the message and line — the full-scan denies became unactionable
// (observed 1co: STRUCT_ROUTE_MODULE_MISMATCH pointed at the page module with
// no line and no cause, and the agent improvised until the run died).
export function structureFindingSummary(findings: readonly StructureFinding[]): string {
  return findings
    .map((finding) => `${finding.id} (${finding.file}${finding.line ? `:${finding.line}` : ''}): ${finding.message}`)
    .join(' | ');
}

/**
 * The run's frozen capability profile has NO implementation role: neither
 * `senior-frontend` (which needs a web-ui or native-ui surface) nor
 * `senior-backend` (which needs an owned backend or an api/cli/worker/data
 * surface). Returns a deny-message summary naming the STATE that produced it,
 * or null when at least one implementer is eligible.
 *
 * Such a profile is fatal before it is visible. The architecture compiler
 * refuses every route / app-shell / page / component module for it, so without
 * a dedicated gate the honest cause surfaces as a compiler error blaming the
 * architect's semantic input; the orchestration directive tells the parent not
 * to invent an implementer; and any module that does compile is skeleton-seeded
 * with no role permitted to edit it. Nothing planned under this profile can
 * ever be built.
 *
 * Judged on `capabilityProfileForRun` (the frozen run snapshot when one
 * exists), never live detection — the compiler is handed the same snapshot, so
 * the gate and the compiler must agree.
 */
export function noImplementerRoleSummary(projectRoot: string, state: Rec): string | null {
  const profile = capabilityProfileForRun(projectRoot, state);
  if (profile.roles.includes('senior-frontend') || profile.roles.includes('senior-backend')) {
    return null;
  }
  const field = (key: string): string => {
    const value = state[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'none';
  };
  const mobile = obj(state.mobile);
  const nativeFramework = typeof mobile?.framework === 'string' && mobile.framework.trim() !== ''
    ? mobile.framework.trim()
    : 'none';
  return `stack \`${field('stack')}\`, frontend \`${field('frontend')}\`, backend \`${field('backend')}\`, mobile \`${nativeFramework}\` compiled to capability profile \`${profile.profileId}\` with surfaces \`${profile.surfaces.join(', ') || 'none'}\` and roles \`${profile.roles.join(', ')}\``;
}

/** Verbatim TS fallback for the `capability-no-implementer-gate` T1BLOCK. */
export function noImplementerRoleFallback(profile: string, runId: string): string {
  return `Capability gate: this project's saved stack selection resolves to a capability profile with NO implementation role — ${profile}. \`PLAN_READY\` is denied because neither \`senior-frontend\` nor \`senior-backend\` is eligible, so no implementer can be spawned and nothing planned here could ever be built. This is a STACK-SELECTION defect in the project's \`.traffic-one/.one.json\`, not a planning mistake: no change to \`architecture-input-v1.json\` can fix it, and re-emitting \`PLAN_READY\` will be denied identically. Tell the user their saved selection names no buildable surface, and ask them to re-run Traffic One setup (or correct \`frontend\`/\`backend\` in \`.traffic-one/.one.json\`) so the project has a real web/native UI, a real backend, or both. Runtime freezes the capability profile when a run id is minted, so the corrected selection takes effect only in a NEW run — run \`${runId}\` must be replaced, not retried.`;
}

interface CollapseScanResult {
  file: string | null;
  incomplete: boolean;
  scanned: number;
}

/**
 * The literal directory prefix of an include pattern — `internal/**` → `internal`,
 * `apps/web/src/**\/*.tsx` → `apps/web/src`, `cmd/server/main.go` → `cmd/server`.
 * A walk root only has to be an ANCESTOR of the owned files; `matchesScope` does
 * the exact filtering per file, so an over-wide root costs a few `readdir` calls
 * and never widens what can be reported.
 */
function scopeRootDir(pattern: string): string {
  const segments = String(pattern || '').replace(/\\/g, '/').split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[\]{}]/.test(segment)) break;
    literal.push(segment);
  }
  // A trailing literal segment may be the file itself; its parent is the root.
  if (literal.length === segments.length && /\.[A-Za-z0-9]+$/.test(literal[literal.length - 1] || '')) {
    literal.pop();
  }
  return literal.join('/') || '.';
}

/**
 * @param scopes The owner role's assigned scopes. When non-empty the walk is
 *   restricted to files that role actually owns. Whole-project was wrong in both
 *   directions: it denied `senior-backend` for a collapsed `App.tsx` it cannot
 *   legally edit under the assignment allowlist, and on a repo Traffic One did
 *   not scaffold it judged files the run never touched. Empty scopes fall back
 *   to the whole tree — that only happens when assignments are missing or stale,
 *   which the allowlist-gap gate already denies on its own.
 */
export function collapsedProductSourceFile(
  projectRoot: string,
  state: Rec,
  scopes: readonly AssignedScope[] = [],
): CollapseScanResult {
  const profile = capabilityProfileForRun(projectRoot, state);
  const capabilityRoots = [
    ...profile.sourceRoots,
    ...profile.layerRoots.pages,
    ...profile.layerRoots.components,
    ...profile.layerRoots.features,
    ...profile.layerRoots.lib,
    ...profile.entrypoints.map((entrypoint) => path.dirname(entrypoint)),
    ...(profile.profileId === 'server-rendered' ? ['resources/css'] : []),
  ];
  const root = path.resolve(projectRoot);
  // Roots follow OWNERSHIP when scopes are given. The capability roots above are
  // the web profile's — `apps/web/src`, `packages`, the entrypoint dirs — so a Go
  // or Python backend's `internal/` was never on the stack no matter which
  // extensions the walker accepted. Scoping by extension alone would have left
  // the backend arm scanning zero files, which is what it did.
  const scopeRoots = scopes.flatMap((scope) => (scope.include || []).map(scopeRootDir));
  const stack = [...new Set([...capabilityRoots, ...scopeRoots, 'apps', 'packages'])]
    .map((dir) => path.resolve(projectRoot, dir))
    .filter((dir) => dir === root || dir.startsWith(`${root}${path.sep}`));
  const visited = new Set<string>();
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(realDir)) continue;
    visited.add(realDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (COLLAPSE_SKIP_DIR_RE.test(`/${rel}`)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !COLLAPSE_SOURCE_RE.test(entry.name)) continue;
      // Only the owner's own files. See the `scopes` note on this function.
      if (scopes.length > 0 && !scopes.some((scope) => matchesScope(rel, scope))) continue;
      // Emit-in-place skip: a `.js`/`.d.ts` with a same-stem `.ts`/`.tsx`
      // sibling is compiler output (a stock `tsc -b` build drops one next to
      // every source). Reporting it masked the REAL collapsed source — observed
      // 1co: the gate denied on the generated CourseDetailPage.js (first hit
      // alphabetically) while CourseDetailPage.tsx stayed collapsed and
      // unmentioned. Skipping it lets the scan reach the true source. Accepted
      // residual: a hand-written collapsed helper.js beside an unrelated
      // helper.ts escapes this scan (reviewer remains the net).
      const emittedStem = entry.name.endsWith('.d.ts')
        ? entry.name.slice(0, -'.d.ts'.length)
        : entry.name.endsWith('.js')
          ? entry.name.slice(0, -'.js'.length)
          : null;
      if (emittedStem && (
        fs.existsSync(path.join(dir, `${emittedStem}.ts`))
        || fs.existsSync(path.join(dir, `${emittedStem}.tsx`))
      )) continue;
      if (++scanned > COLLAPSE_MAX_FILES) {
        return { file: null, incomplete: true, scanned };
      }
      let text: string;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      // Two arms, each with the detector its language has. For JS/TS-family
      // sources use the SAME detector the write gate uses — it masks comments and
      // string bodies and thresholds at 140 code chars (80 for a JSX line). This
      // scan previously used only the raw >500-char arm below, 3.5x looser, so
      // everything the write gate flagged between those bounds was invisible here
      // and shipped collapsed: observed 15co, `pnpm format:check` red for a whole
      // run; 14co, 25 unformatted source files at the tester.
      // …but the strict bar is GREENFIELD-only. On a repo Traffic One did not
      // scaffold, 140 masked code chars (80 on a JSX line) is met by ordinary
      // code formatted at printWidth 100 or 120 — a single `<tr>` of five `<td>`
      // cells clears it — and `repairCollapsedSource` would then reformat the
      // user's own file and re-deny it forever, dead-ending a maintenance run on
      // code nobody touched. Existing codebases keep the raw >500-char arm below,
      // which is what shipped before this tightening and which no ordinary source
      // line reaches. The write gate is strict in BOTH modes: it judges only the
      // bytes being written, so collapse this run PRODUCES is still refused.
      if (isCollapseCandidate(rel) && state.mode === 'new-project') {
        const line = collapsedLineNumber(rel, text);
        if (line !== null) return { file: `${rel}:${line}`, incomplete: false, scanned };
        continue;
      }
      // CSS and friends keep the raw-length arm: `lexicalMask` is a JS/TS lexer
      // and produces nonsense on a stylesheet, and the shape this catches is real
      // (13co: a 424-char single-line `@theme` block no lexical gate could see).
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (line.length <= COLLAPSE_LINE_CHARS) continue;
        const statements = (line.match(/;/g) || []).length;
        const jsxClose = (line.match(/<\//g) || []).length;
        // Real collapse packs many statements or JSX closings onto one line; a
        // single long string/URI/data literal trips neither.
        if (statements >= 3 || jsxClose >= 2) {
          return { file: `${rel}:${i + 1}`, incomplete: false, scanned };
        }
      }
    }
  }
  return { file: null, incomplete: false, scanned };
}
// ── Emit-config + format-parity completion gates ────────────────────────────
// Deterministic replacements for prose-only mandates that did not bind every
// host identically (observed 1co on Codex: the stock Vite template — `tsc -b`
// scripts, `composite: true`, no `noEmit` — violated rules/frontend/react/vite.md
// verbatim and shipped compiled .js/.d.ts next to every source; a written
// .prettierrc had no prettier dependency, so format:check could never run).
// Both fire only in the frontend IMPLEMENTED branch, only for new-project mode,
// and target ONLY the web app package — never packages/* or tsconfig.base.json,
// where `composite`/`tsc -b` are legitimate (monorepo-architecture skill).

// Vite app tsconfigs are JSONC (comments + trailing commas). readJson's silent
// fallback would let a malformed config slip past the gate, so parse failures
