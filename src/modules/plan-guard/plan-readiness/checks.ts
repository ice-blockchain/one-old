// src/modules/plan-guard/plan-readiness/checks.ts
// Evidence checks: QA-report freshness vs implementation, built-app
// identity, and the collapsed-product-source scan.

import * as fs from 'fs';
import * as path from 'path';
import { readRegularFile } from '../../../shared/bounded-read';
import {
  capabilityProfileForRun,
  moduleOutputVariants,
  readCompiledArchitecture,
} from '../../../shared/architecture-contract';
import { collapsedLineNumber, isCollapseCandidate } from '../../../shared/collapsed-source';
import { obj } from '../../../shared/obj';
import { isNewProjectMode } from '../../../shared/state';
import { type AssignedScope, matchesScope } from '../../../shared/scope';
import { readVerificationContract } from '../../../shared/verification-contract';
import {
  type StructureFinding,
} from '../react-structure';
import {
  assertNever,
  entryKind,
  scanCoverage,
  type DirectoryListing,
  type ScanCoverage,
  type ScanExit,
} from '../scan-coverage';

import {
  COLLAPSE_LINE_CHARS,
  COLLAPSE_MAX_FILES,
  COLLAPSE_SKIP_DIR_RE,
  COLLAPSE_SOURCE_RE,
  type Rec,
} from './context';

/**
 * The BOUNDED reader every project-controlled read in this file goes through.
 *
 * Nine bare `fs.readFileSync` calls used to live here — a QA report, a
 * Lighthouse evidence sidecar, a built `index.html`, a Vite manifest, a Next
 * `BUILD_ID`, a source file — and every one of them reads a path a project (or
 * an agent with Bash) chooses, on a PreToolUse hook. `open(O_RDONLY)` on a FIFO
 * waits for a writer forever and a symlink to `/dev/zero` answers a read as
 * long as anybody keeps asking; MEASURED through this module's own gate entry
 * point at `.traffic-one/plan.md`, both shapes took SIGKILL at 12 023 ms and
 * 12 080 ms with no deny, no timeout and nothing logged.
 *
 * IT THROWS for a non-regular object rather than answering, and that is the
 * whole reason it is a helper instead of a bare `readRegularFile` at each site.
 * Every caller below is already `try { … } catch { <no evidence> }`, so a throw
 * lands the shape in the arm an unreadable file already reached — no report, no
 * build identity, `'unreadable'` from `collapseHit`. Returning the empty string
 * would land it in the OPPOSITE arm at three of them: an `O_NONBLOCK` FIFO
 * reads as EOF, so a planted `dist/index.html` would be a build with no entry
 * asset and a planted source file would be a file with no collapse in it —
 * evidence of absence manufactured out of a read that never happened.
 */
function readProjectJsonText(absolute: string): string {
  const text = readRegularFile(absolute);
  if (text === null) throw new Error(`not-a-regular-file: ${absolute}`);
  return text;
}

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
    // BOUNDED — see `readProjectJson` below; `null` throws into the catch, so a
    // non-regular report is the same "no report" this already returns null for.
    const raw = JSON.parse(readProjectJsonText(
      path.join(projectRoot, memoryDir, 'reports', 'qa', runId, 'report.json'),
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
    const report = JSON.parse(readProjectJsonText(path.join(qaDir, 'report-v2.json'))) as {
      lighthouse?: { evidencePath?: unknown };
    };
    const evidencePath = report?.lighthouse?.evidencePath;
    if (typeof evidencePath !== 'string'
      || !evidencePath
      || path.isAbsolute(evidencePath)
      || evidencePath.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')) {
      return null;
    }
    const evidence = JSON.parse(readProjectJsonText(path.join(qaDir, evidencePath))) as {
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
        const html = readProjectJsonText(path.join(root, outDir, 'index.html'));
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
            const html = readProjectJsonText(path.join(root, 'dist', nested, 'index.html'));
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
        const manifest = JSON.parse(readProjectJsonText(path.join(root, manifestPath))) as
          Record<string, { file?: unknown }>;
        for (const entry of Object.values(manifest)) {
          if (typeof entry?.file === 'string' && entry.file) found.add(path.basename(entry.file));
        }
      } catch {
        // not a Vite manifest build
      }
    }
    try {
      const buildId = readProjectJsonText(path.join(root, '.next', 'BUILD_ID')).trim();
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
    const raw = JSON.parse(readProjectJsonText(
      path.join(projectRoot, memoryDir, 'reports', 'qa', runId, 'report.json'),
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

export interface CollapseScanResult {
  file: string | null;
  incomplete: boolean;
  scanned: number;
  /**
   * What this walk did NOT read, one statement per withdrawal.
   *
   * The structure walk has had a `skipped` channel since the round that
   * discovered directory links; this scan had NONE, so a `readdir` failure, a
   * `readFile` failure and a `Dirent` that is neither a file nor a directory
   * were bare `continue`s: the gate saw `file: null`, passed, and nothing
   * anywhere raised the floor or reached the quality ledger. Measured over a
   * react-vite fixture with an error-grade collapsed component planted behind
   * each termination, five of six routes returned `file: null,
   * incomplete: false` — the byte-identical answer to a clean tree.
   *
   * Consumers treat a non-empty list exactly as they treat `incomplete`: it is
   * the same fact (part of the owned tree went unjudged) reached by a different
   * route, and `truncatedScanUiImpactFloor` is the same compensation.
   */
  withdrawn: readonly string[];
}

/**
 * How this walk disposes of one directory entry. A closed union so the switch
 * that consumes it can be exhaustive: a route added later must add a member
 * here, and `assertNever` refuses to compile without an arm for it.
 */
type CollapseEntryPlan =
  | { action: 'descend' }
  | { action: 'defer-link'; real: string; directory: boolean }
  | { action: 'read' }
  | { action: 'exit'; kind: ScanExit };

/** The same, for a directory the walk is about to open. */
interface CollapseWalkOutcome { found: string | null; truncated: boolean; scanned: number }

type CollapseDirectoryPlan =
  | { action: 'read'; real: string; listing: DirectoryListing }
  | { action: 'exit'; kind: ScanExit };

/**
 * Emit-in-place skip: a `.js`/`.d.ts` with a same-stem `.ts`/`.tsx` sibling is
 * compiler output (a stock `tsc -b` build drops one next to every source).
 * Reporting it masked the REAL collapsed source — observed 1co: the gate denied
 * on the generated CourseDetailPage.js (first hit alphabetically) while
 * CourseDetailPage.tsx stayed collapsed and unmentioned. Skipping it lets the
 * scan reach the true source. Accepted residual: a hand-written collapsed
 * helper.js beside an unrelated helper.ts escapes this scan (reviewer remains
 * the net).
 */
function isEmittedSibling(dir: string, name: string): boolean {
  const stem = name.endsWith('.d.ts')
    ? name.slice(0, -'.d.ts'.length)
    : name.endsWith('.js')
      ? name.slice(0, -'.js'.length)
      : null;
  if (!stem) return false;
  return fs.existsSync(path.join(dir, `${stem}.ts`)) || fs.existsSync(path.join(dir, `${stem}.tsx`));
}

/**
 * `coverage.open` is this walk's only `readdir`, and it counts the entries
 * inside the ledger at the syscall — see the accounting note on `ScanCoverage`.
 * The plan therefore carries a LISTING, not an array, so there is nothing here
 * for a future `entries.filter(…)` to shorten.
 */
function planCollapseDirectory(
  dir: string,
  dirRel: string,
  visited: Set<string>,
  seedRoot: boolean,
  coverage: ScanCoverage,
): CollapseDirectoryPlan {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // A CANDIDATE root that is not there holds no files; a directory this walk
    // DISCOVERED and can no longer resolve was there when readdir listed it.
    return { action: 'exit', kind: seedRoot ? 'absent-root' : 'unresolvable-directory' };
  }
  if (visited.has(real)) return { action: 'exit', kind: 'already-visited' };
  const listing = coverage.open(dir, dirRel);
  if (listing === null) return { action: 'exit', kind: 'unreadable-directory' };
  return { action: 'read', real, listing };
}

function planCollapseEntry(
  dir: string,
  entry: fs.Dirent,
  rel: string,
  scopes: readonly AssignedScope[],
): CollapseEntryPlan {
  if (COLLAPSE_SKIP_DIR_RE.test(`/${rel}`)) return { action: 'exit', kind: 'excluded-name' };
  const absolute = path.join(dir, entry.name);
  const kind = entryKind(entry, absolute, fs.lstatSync);
  if (kind === 'link') {
    // Judged at the END of the walk like the structure walk's links: a link
    // whose target this same walk reads under its real path withdrew nothing.
    try {
      return {
        action: 'defer-link',
        directory: fs.statSync(absolute).isDirectory(),
        real: fs.realpathSync(absolute),
      };
    } catch {
      return { action: 'exit', kind: 'broken-link' };
    }
  }
  if (kind === 'directory') return { action: 'descend' };
  // Neither a directory, a regular file nor a link — a socket, a fifo or a
  // device node. The walk has no arm for it, and non-recognition is not
  // evidence of emptiness.
  if (kind === 'other') return { action: 'exit', kind: 'undecidable-entry' };
  if (!COLLAPSE_SOURCE_RE.test(entry.name)) return { action: 'exit', kind: 'not-source' };
  // Only the owner's own files. See the `scopes` note on collapsedProductSourceFile.
  if (scopes.length > 0 && !scopes.some((scope) => matchesScope(rel, scope))) {
    return { action: 'exit', kind: 'out-of-scope' };
  }
  if (isEmittedSibling(dir, entry.name)) return { action: 'exit', kind: 'emitted-sibling' };
  return { action: 'read' };
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
  const seeds = [...new Set([...capabilityRoots, ...scopeRoots, 'apps', 'packages'])]
    .map((dir) => path.resolve(projectRoot, dir))
    .filter((dir) => dir === root || dir.startsWith(`${root}${path.sep}`));
  const seedRoots = new Set(seeds);
  const stack = [...seeds];
  const visited = new Set<string>();
  const readReal = new Set<string>();
  const coverage = scanCoverage();
  // Links are judged at the END of the walk, exactly as the structure walk
  // judges its own: at the link, `visited` is only whatever the stack happened
  // to pop first, so the same tree would answer differently depending on
  // directory order.
  const deferredLinks: Array<{ rel: string; real: string; directory: boolean }> = [];
  let scanned = 0;
  let found: string | null = null;
  let truncated = false;

  const settle = (): CollapseScanResult => {
    for (const link of deferredLinks) {
      const covered = link.directory ? visited.has(link.real) : readReal.has(link.real);
      coverage.exit(covered ? 'covered-elsewhere' : 'unfollowed-link', link.rel);
    }
    // Entries `readdir` returned that reached no disposition mean this walk
    // cannot say what it looked at, so `file: null` from it is not evidence of
    // a clean tree. Reported as incomplete for the same reason the file cap is.
    const unaccounted = coverage.unaccounted;
    return {
      file: found,
      incomplete: truncated || unaccounted.length > 0,
      scanned,
      withdrawn: coverage.withdrawals,
    };
  };

  const walk: CollapseWalkOutcome = walkCollapseTree({
    projectRoot, state, scopes, stack, seedRoots, visited, readReal, coverage, deferredLinks,
  });
  found = walk.found;
  truncated = walk.truncated;
  scanned = walk.scanned;
  return settle();
}

/**
 * The collapse tree walk, and the whole of it. Every disposition an entry can
 * get is a `CollapseEntryPlan`/`CollapseDirectoryPlan` arm, and every arm
 * either does work or names a `ScanExit`.
 *
 * Both places this loop stops part-way through a directory — the file cap and
 * "the defect has been found" — say so to the ledger through `abandonFrom`,
 * because the ledger counted the directory's entries at `readdir` and audits
 * the difference. That is what makes a future silent drop visible however it is
 * spelled; the absence of `continue` and `catch` here is checked too, but is
 * no longer what the property rests on.
 */
function walkCollapseTree(context: {
  projectRoot: string;
  state: Rec;
  scopes: readonly AssignedScope[];
  stack: string[];
  seedRoots: ReadonlySet<string>;
  visited: Set<string>;
  readReal: Set<string>;
  coverage: ScanCoverage;
  deferredLinks: Array<{ rel: string; real: string; directory: boolean }>;
}): CollapseWalkOutcome {
  const {
    projectRoot, state, scopes, stack, seedRoots, visited, readReal, coverage, deferredLinks,
  } = context;
  let scanned = 0;
  let found: string | null = null;
  let truncated = false;
  while (stack.length > 0 && found === null && !truncated) {
    const dir = stack.pop()!;
    const rel = path.relative(projectRoot, dir).replace(/\\/g, '/') || '.';
    const directory = planCollapseDirectory(dir, rel, visited, seedRoots.has(dir), coverage);
    if (directory.action === 'exit') {
      coverage.exit(directory.kind, rel);
    } else if (directory.action === 'read') {
      visited.add(directory.real);
      const listing = directory.listing;
      for (const entry of listing.entries) {
        const full = path.join(dir, entry.name);
        const entryRel = path.relative(projectRoot, full).replace(/\\/g, '/');
        const plan = planCollapseEntry(dir, entry, entryRel, scopes);
        // Accounting and withdrawal in one call, so "handled" and "recorded"
        // cannot come apart.
        listing.disposed(entry, plan);
        if (plan.action === 'exit') {
          // Recorded by `disposed` above, with the ledger's own subject.
          void plan.kind;
        } else if (plan.action === 'descend') {
          stack.push(full);
        } else if (plan.action === 'defer-link') {
          deferredLinks.push({ rel: entryRel, real: plan.real, directory: plan.directory });
        } else if (plan.action === 'read') {
          scanned += 1;
          if (scanned > COLLAPSE_MAX_FILES) {
            // `abandonFrom` is the whole record: it names `file-cap`, names the
            // entry the bound landed on and how many the walk never reached.
            // The scanned COUNT reaches the gate through `CollapseScanResult`.
            coverage.settleEarly();
            listing.abandonFrom(entry, 'file-cap');
            truncated = true;
            break;
          }
          const hit = collapseHit(state, full, entryRel, readReal);
          if (hit === 'unreadable') coverage.exit('unreadable-file', entryRel);
          else if (hit !== null) found = hit;
          if (found !== null) {
            coverage.settleEarly();
            listing.abandonFrom(entry, 'answer-found');
            break;
          }
        } else {
          assertNever(plan, 'collapse entry plan');
        }
      }
    } else {
      assertNever(directory, 'collapse directory plan');
    }
  }
  return { found, truncated, scanned };
}

/**
 * One file, read and judged. Returns `"<rel>:<line>"` for a collapse hit, null
 * when the file is clean, and the sentinel `'unreadable'` when the bytes could
 * not be read — which is a WITHDRAWAL, not a clean file. It used to be a bare
 * `continue`: a `chmod 000` on the one collapsed source in the tree made the
 * gate pass with `file: null`, byte-identical to a tree with no defect in it.
 */
function collapseHit(
  state: Rec,
  absolute: string,
  rel: string,
  readReal: Set<string>,
): string | null | 'unreadable' {
  let text: string;
  try {
    // BOUNDED. `unreadable` is a WITHDRAWAL and a non-regular file belongs in
    // it: an O_NONBLOCK FIFO reads as EOF, which would make a planted source
    // file indistinguishable from a clean one — the exact defect the `chmod 000`
    // case above records, one shape over.
    text = readProjectJsonText(absolute);
  } catch {
    return 'unreadable';
  }
  try {
    readReal.add(fs.realpathSync(absolute));
  } catch {
    readReal.add(absolute);
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
  if (isCollapseCandidate(rel) && isNewProjectMode(state)) {
    const line = collapsedLineNumber(rel, text);
    return line === null ? null : `${rel}:${line}`;
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
    if (statements >= 3 || jsxClose >= 2) return `${rel}:${i + 1}`;
  }
  return null;
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
