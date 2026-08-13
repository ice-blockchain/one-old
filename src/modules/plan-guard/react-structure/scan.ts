// src/modules/plan-guard/react-structure/scan.ts
// The full-project scan: mtime/size cache (process singleton), bounded
// source walk, report assembly and persistence.

import * as fs from 'fs';
import * as path from 'path';
import {
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import { readRegularFile } from '../../../shared/bounded-read';
import { writeJson } from '../../../shared/fsjson';

import {
  STRUCTURE_REPORT_SCHEMA_VERSION,
  STRUCTURE_SCAN_DEFAULT_MAX_FILES,
  type CacheEntry,
  type SourceAnalysis,
  type StructureFinding,
  type StructureReportV1,
  type StructureScanOptions,
  SKIP_RE,
  STRUCTURAL_SOURCE_RE,
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
import {
  contractFindings,
} from './contract';
import {
  assertNever,
  entryKind,
  scanCoverage,
  type DirectoryListing,
  type ScanCoverage,
  type ScanExit,
} from '../scan-coverage';

const cache = new Map<string, CacheEntry>();
// Findings an architect-declared exception may suppress. Every advisory numeric
// rule qualifies, plus the one BLOCKING numeric rule (STRUCT_MODULE_LOC) —
// without that a legitimately large module would have no escape hatch at all.

export function invalidateStructureCache(filePath: string): void {
  cache.delete(path.resolve(filePath));
}

/**
 * BOUNDED (shared/bounded-read.ts). The `stat` above is a cache KEY, never a
 * kind check — it neither opens nor blocks, and deciding regular-ness from it
 * would be the classify-one-object-read-another window bounded-read.ts exists
 * to close. The kind is decided on the descriptor instead, and a non-regular
 * object THROWS to match this function's existing contract: `statSync` already
 * threw for an absent file, and the one caller turns any throw into
 * `cannot read source file <file>` in `skipped`. Landing it there rather than
 * in a clean analysis is the same withdrawal `collapseHit` makes for a
 * `chmod 000` file — an `O_NONBLOCK` FIFO reads as EOF, so the alternative is a
 * source file analysed as EMPTY and reported as defect-free.
 */
function cachedAnalysis(projectRoot: string, file: string): SourceAnalysis {
  const absolute = path.join(projectRoot, file);
  const stat = fs.statSync(absolute);
  const existing = cache.get(absolute);
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return existing.analysis;
  const text = readRegularFile(absolute);
  if (text === null) throw new Error(`cannot read source file (not-a-regular-file): ${file}`);
  const analysis = analyzeText(file, text);
  cache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, analysis });
  return analysis;
}

/**
 * What stopped the walk, and whether anything can make up for it.
 *
 * `bound` is the file CAP: a hard limit this walk imposes on itself over a tree
 * that really is source. The verification contract can compensate for it by
 * pinning `uiImpact` to the truncated-scan floor, which is what licenses
 * STRUCT_SCAN_INCOMPLETE to be a warning — see the push site below.
 *
 * `unresolvable` is the walk having no tree to read at all: every compiled
 * source root missing, a root that escapes the project, a root reached through
 * a link. No floor compensates for that, because the floor raises the EVIDENCE
 * a run owes and this is a report about nothing.
 *
 * `unaccounted` is the walk's own accounting failing to balance: `readdir`
 * handed it entries it never disposed of. It keeps the ERROR severity and takes
 * precedence over `bound`, because it is not a fact about the project at all —
 * it is unreachable in a correct walk, so it can never cost a healthy run
 * anything, and the one thing it must not do is be tradeable for evidence. A
 * scan that cannot say what it did with part of a directory cannot price what
 * it missed either.
 */
type SourceWalkTruncation = { kind: 'bound' | 'unresolvable' | 'unaccounted'; reason: string };

interface SourceWalk {
  files: string[];
  truncation: SourceWalkTruncation | null;
  /**
   * Entries the walk stepped over and kept going. An ENTRY the walk cannot use
   * is not a truncation: a gitignored `vendor -> ../vendor` link inside a source
   * root is an ordinary thing to find, and abandoning the remainder of the tree
   * over one is how an error-grade defect three directories later went unjudged
   * while `complete` still read true for the file COUNT. Recorded so the report
   * still says what was not read — and, because every one of these sits inside a
   * compiled source root, the report's `skippedEntries` count raises the same
   * evidence floor the file cap raises. Continuing withdraws the SUBTREE behind
   * the entry, not nothing.
   */
  skipped: string[];
}

/** One deferred symbolic link, judged after the walk finishes. */
interface DeferredLink { rel: string; real: string; directory: boolean }

type SourceDirectoryPlan =
  | { action: 'read'; real: string; listing: DirectoryListing }
  | { action: 'exit'; kind: ScanExit };

type SourceEntryPlan =
  | { action: 'descend' }
  | { action: 'defer-link'; real: string; directory: boolean }
  | { action: 'collect' }
  | { action: 'exit'; kind: ScanExit };

/**
 * The plan carries a LISTING rather than an entry array, and that is the round-7
 * change. `coverage.open` is the walk's only `readdir`, it counts the entries at
 * the syscall, and it keeps that count where nothing here can reach it — so the
 * one-line edit that defeated round 6 (`entries: entries.filter(…)`, returned as
 * a perfectly well-formed `{ action: 'read' }` literal) has nothing left to
 * filter. Whatever array reaches the walker, the entries it never disposes of
 * come back as `unaccounted-entry` withdrawals naming each one.
 */
function planSourceDirectory(
  dir: string,
  dirRel: string,
  seenDirs: Set<string>,
  coverage: ScanCoverage,
): SourceDirectoryPlan {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return { action: 'exit', kind: 'unresolvable-directory' };
  }
  if (seenDirs.has(real)) return { action: 'exit', kind: 'already-visited' };
  const listing = coverage.open(dir, dirRel);
  if (listing === null) return { action: 'exit', kind: 'unreadable-directory' };
  return { action: 'read', real, listing };
}

function planSourceEntry(dir: string, entry: fs.Dirent, rel: string): SourceEntryPlan {
  if (SKIP_RE.test(`/${rel}`)) return { action: 'exit', kind: 'excluded-name' };
  const absolute = path.join(dir, entry.name);
  const kind = entryKind(entry, absolute, fs.lstatSync);
  if (kind === 'link') {
    // A DIRECTORY link can graft an untracked subtree into a source root —
    // source the contract does not govern, laundered in through a link — so
    // the walk does not follow it and says so. What it does NOT do is stop:
    // a gitignored `vendor -> ../vendor` beside the pages directory is an
    // ordinary thing to find, and abandoning the rest of the tree over one
    // silently withdrew every finding after it in sort order — a planted
    // `aaa-link` took STRUCT_ENTRYPOINT_COMPONENT off an error-grade report
    // while `filesScanned` still read plausible.
    //
    // A link to a file that is not structural source cannot contribute
    // source, so it is skipped exactly like any other non-source file, and
    // silently: Traffic One's own materialization writes one (root
    // `CLAUDE.md -> AGENTS.md`), so recording it would put a permanent
    // entry on every `.`-rooted profile's report.
    //
    // Whether not following COSTS anything is decided after the walk, because
    // "the target is read some other way" is a fact about the finished walk.
    let directory = true;
    let real: string;
    try {
      directory = fs.statSync(absolute).isDirectory();
      real = fs.realpathSync(absolute);
    } catch {
      return { action: 'exit', kind: 'broken-link' };
    }
    if (!directory && !STRUCTURAL_SOURCE_RE.test(entry.name)) {
      return { action: 'exit', kind: 'not-source' };
    }
    return { action: 'defer-link', real, directory };
  }
  if (kind === 'directory') return { action: 'descend' };
  // Neither a directory, a regular file nor a link — a socket, a fifo or a
  // device node. The walk has no arm for it, and non-recognition is not
  // evidence of emptiness.
  if (kind === 'other') return { action: 'exit', kind: 'undecidable-entry' };
  if (!STRUCTURAL_SOURCE_RE.test(entry.name)) return { action: 'exit', kind: 'not-source' };
  return { action: 'collect' };
}

/**
 * The tree walk itself, and the whole of it: every disposition an entry can get
 * is a `SourceEntryPlan`/`SourceDirectoryPlan` arm, and every arm either does
 * work or names a `ScanExit`.
 *
 * What keeps that true is not the shape of this function — round 6 believed it
 * was, and a peer defeated the belief with a `break`, which cannot be banned
 * because the cap below is one. It is `listing.disposed`, which is how this
 * loop records an exit AND how the ledger learns the entry was handled at all.
 * Anything that leaves the loop early, steps over an entry, or routes the exit
 * through a helper that drops it leaves entries the ledger counted at `readdir`
 * and never heard about again, and `coverage.withdrawals` names every one of
 * them. There is also no `continue` and no `catch` here, which the closure test
 * still checks — cheap, true, and no longer the thing holding the property up.
 *
 * @returns true when the file CAP stopped the walk.
 */
function walkSourceTree(context: {
  projectRoot: string;
  stack: string[];
  maxFiles: number;
  coverage: ScanCoverage;
  files: string[];
  seenDirs: Set<string>;
  deferredLinks: DeferredLink[];
}): boolean {
  const { projectRoot, stack, maxFiles, coverage, files, seenDirs, deferredLinks } = context;
  let capped = false;
  while (stack.length > 0 && !capped) {
    const dir = stack.pop()!;
    const dirRel = normalizeRel(path.relative(projectRoot, dir)) || '.';
    const directory = planSourceDirectory(dir, dirRel, seenDirs, coverage);
    if (directory.action === 'exit') {
      coverage.exit(directory.kind, dirRel);
    } else if (directory.action === 'read') {
      seenDirs.add(directory.real);
      const listing = directory.listing;
      for (const entry of listing.entries) {
        const absolute = path.join(dir, entry.name);
        const rel = normalizeRel(path.relative(projectRoot, absolute));
        const plan = planSourceEntry(dir, entry, rel);
        // The accounting and the withdrawal are the same call, so there is no
        // spelling of "handled" that is not also "recorded".
        listing.disposed(entry, plan);
        if (plan.action === 'exit') {
          // Recorded by `disposed` above, with the ledger's own subject.
          void plan.kind;
        } else if (plan.action === 'descend') {
          stack.push(absolute);
        } else if (plan.action === 'defer-link') {
          deferredLinks.push({ rel, real: plan.real, directory: plan.directory });
        } else if (plan.action === 'collect') {
          // The one genuine hard bound, and now the only thing that truncates
          // this walk. It is compensable — see the STRUCT_SCAN_INCOMPLETE push
          // site. The remainder of the directory is abandoned EXPLICITLY: a
          // `break` that just left would leave every entry after this one
          // unaccounted, which is now a report the reader sees rather than a
          // silence.
          if (files.length >= maxFiles) {
            capped = true;
            // The stack still holds directories this walk promised to descend
            // into. They are the bound, not a second finding.
            coverage.settleEarly();
            listing.abandonFrom(entry, 'file-cap');
            break;
          }
          files.push(rel);
        } else {
          assertNever(plan, 'source entry plan');
        }
      }
    } else {
      assertNever(directory, 'source directory plan');
    }
  }
  return capped;
}

function walkSourceFiles(
  projectRoot: string,
  roots: string[],
  maxFiles: number,
  declaredBuildOutputs: readonly string[] = [],
): SourceWalk {
  const files: string[] = [];
  const coverage = scanCoverage();
  // Links are judged at the END of the walk, not where they are met. A link
  // whose target this same walk reads under its REAL path withdrew nothing — the
  // loop link `…/loop -> apps/web/src`, or a monorepo link into another source
  // root — and recording those would owe evidence for a subtree that is fully in
  // the report. Deferred rather than answered in place because "already walked"
  // is a fact about the finished walk: at the link, `seenDirs` is only whatever
  // the stack happened to pop first, so the same tree would answer differently
  // depending on directory order.
  const deferredLinks: DeferredLink[] = [];
  // `coverage.withdrawals` is read at each exit rather than aliased once up
  // front: the ledger appends the entries nobody accounted for as the list is
  // read, so a captured reference would report the pre-audit set.
  const unresolvable = (reason: string): SourceWalk => ({
    files,
    truncation: { kind: 'unresolvable', reason },
    skipped: [...coverage.withdrawals],
  });
  const seenDirs = new Set<string>();
  const resolvedProjectRoot = path.resolve(projectRoot);
  let realProjectRoot: string;
  try { realProjectRoot = fs.realpathSync(resolvedProjectRoot); } catch {
    return unresolvable('cannot resolve project root');
  }
  const requestedRoots = [...new Set(roots
    .map((root) => path.resolve(projectRoot, normalizeRel(root)))
  )];
  const outsideRoot = requestedRoots.find((root) => (
    root !== resolvedProjectRoot && !root.startsWith(`${resolvedProjectRoot}${path.sep}`)
  ));
  if (outsideRoot) {
    return unresolvable(
      `source root escapes project boundary: ${normalizeRel(path.relative(projectRoot, outsideRoot))}`,
    );
  }
  // Absolute real paths of the build outputs this project DECLARED, resolved
  // once. `realpathSync` is used so a declaration and a link target that reach
  // the same directory by different routes still compare equal; a declaration
  // naming a directory that does not exist resolves to nothing and forgives
  // nothing.
  const declaredOutputRoots: string[] = [];
  for (const declared of declaredBuildOutputs) {
    const absolute = path.resolve(resolvedProjectRoot, declared);
    if (absolute !== resolvedProjectRoot && !absolute.startsWith(`${resolvedProjectRoot}${path.sep}`)) continue;
    try { declaredOutputRoots.push(fs.realpathSync(absolute)); } catch { /* undeclared in fact */ }
  }
  const underDeclaredOutput = (real: string): boolean => declaredOutputRoots.some((root) => (
    real === root || real.startsWith(`${root}${path.sep}`)
  ));
  // Which deferred links actually cost coverage. There are exactly TWO no-loss
  // answers. The first is a fact about this walk's own output: the target was
  // read, under its real path, by this same walk. A target outside the project
  // is never covered. The second is a fact about the run's frozen input: the
  // target resolves under a build output the contract DECLARES, which is the
  // narrowing that keeps `public/assets -> dist/assets` and the monorepo
  // bundler idiom from each costing the truncated-scan floor. Eight such links
  // used to produce eight findings, and a reviewer reads eight of those as
  // eight problems.
  //
  // The removed third clause — "or the target matches SKIP_RE, so a link named
  // `assets` pointing at a build cache is the same non-loss as the `dist`
  // directory beside it" — is true of a link that ADDS an excluded tree to the
  // walk and false of one that REPLACES a source path with an excluded target.
  // A link whose own NAME is excluded never reaches this list (the walk tests
  // the entry's name first and exits `excluded-name`), so the clause could only
  // ever fire for a visible source name pointing at bytes NO consumer reads
  // under either name. Measured on a react-vite fixture with an error-grade
  // collapsed component behind the link: `apps/web/src/features/widgets ->
  // apps/web/src/generated/widgets` gave complete=true, skippedEntries=0, no
  // STRUCT_COLLAPSED_LINE, no scan-bound.json, floor nonvisual; the identical
  // fixture with the target one directory to the left, outside the project,
  // recorded the skip and floored at visual. The walk cannot tell a laundered
  // source tree from a genuine build cache, so it records both and the floor
  // asks for more evidence rather than less.
  const recordUnfollowedLinks = (): void => {
    for (const link of deferredLinks) {
      const relReal = normalizeRel(path.relative(realProjectRoot, link.real));
      const inProject = link.real === realProjectRoot
        || link.real.startsWith(`${realProjectRoot}${path.sep}`);
      const covered = inProject
        && (link.directory ? seenDirs.has(link.real) : files.includes(relReal));
      coverage.exit(
        covered
          ? 'covered-elsewhere'
          : inProject && underDeclaredOutput(link.real)
            ? 'declared-build-output'
            : 'unfollowed-link',
        link.rel,
      );
    }
  };
  const stack: string[] = [];
  const unresolvedRoots: string[] = [];
  for (const root of requestedRoots) {
    const rootRel = normalizeRel(path.relative(resolvedProjectRoot, root));
    let rootCursor = resolvedProjectRoot;
    let symbolicRootSegment: string | null = null;
    for (const segment of rootRel.split('/').filter(Boolean)) {
      rootCursor = path.join(rootCursor, segment);
      try {
        if (fs.lstatSync(rootCursor).isSymbolicLink()) {
          symbolicRootSegment = normalizeRel(path.relative(projectRoot, rootCursor));
          break;
        }
      } catch {
        break;
      }
    }
    if (symbolicRootSegment) {
      return unresolvable(`source root contains symbolic link: ${symbolicRootSegment}`);
    }
    let real: string;
    try {
      real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      // Capability profiles carry alternative roots (for example Next app and
      // src/app, or Nuxt app and the configured srcDir). An absent alternative
      // contains no files to scan. The scan is incomplete only when none of the
      // compiled roots can be resolved.
      const rootRelative = normalizeRel(path.relative(projectRoot, root)) || '.';
      coverage.exit('absent-root', rootRelative);
      unresolvedRoots.push(rootRelative);
      continue;
    }
    if (real !== realProjectRoot && !real.startsWith(`${realProjectRoot}${path.sep}`)) {
      return unresolvable(
        `source root resolves outside project boundary: ${normalizeRel(path.relative(projectRoot, root)) || '.'}`,
      );
    }
    stack.push(root);
  }
  if (stack.length === 0 && requestedRoots.length > 0) {
    return unresolvable(
      `cannot resolve source root${unresolvedRoots.length === 1 ? '' : 's'} ${unresolvedRoots.join(', ')}`,
    );
  }
  const capped = walkSourceTree({
    projectRoot, stack, maxFiles, coverage, files, seenDirs, deferredLinks,
  });
  if (!capped) files.sort();
  recordUnfollowedLinks();
  // The accounting, read after every disposition this walk will ever make. An
  // entry `readdir` returned that reached no plan function, no exit and no bulk
  // abandonment is here, whatever token dropped it.
  const unaccounted = coverage.unaccounted;
  return {
    files,
    truncation: unaccounted.length > 0
      ? {
        kind: 'unaccounted',
        reason: `source scan did not account for ${unaccounted.length} `
          + `director${unaccounted.length === 1 ? 'y entry' : 'y entries'} `
          + `readdir returned: ${unaccounted.slice(0, 3).join(', ')}`
          + `${unaccounted.length > 3 ? ', …' : ''}`,
      }
      : capped
        ? { kind: 'bound', reason: `source scan exceeds ${maxFiles} files` }
        : null,
    skipped: [...coverage.withdrawals],
  };
}



// Laravel declares its route→module bindings in `routes/web.php`, so that file
// has to be in the scan or no Inertia page and no Blade view can ever bind to
// its route. The directory sits beside the app, and the compiler legitimately
// NESTS a Laravel app under a web root (apps/web/...), where a literal `routes`
// resolves to nothing and is silently dropped as an unresolved root.
function laravelRoutesRoots(contract: CompiledArchitectureV1): string[] {
  const roots = new Set<string>(['routes']);
  for (const root of contract.sourceRoots) {
    const marker = root.indexOf('/resources/');
    if (marker > 0) roots.add(`${root.slice(0, marker)}/routes`);
  }
  return [...roots];
}

export function analyzeProjectStructure(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  options: StructureScanOptions = {},
): StructureReportV1 {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles || STRUCTURE_SCAN_DEFAULT_MAX_FILES));
  const laravelRouteRoots = contract.profile.profileId === 'server-rendered'
    && contract.profile.framework === 'laravel'
    ? laravelRoutesRoots(contract)
    : [];
  const walked = walkSourceFiles(
    projectRoot,
    [...new Set([...contract.sourceRoots, ...laravelRouteRoots])],
    maxFiles,
    contract.buildOutputs || [],
  );
  const analyses: SourceAnalysis[] = [];
  const truncation = walked.truncation;
  const skipped = [...walked.skipped];
  // One unreadable file is one unreadable file. This loop used to `break`, so a
  // single `chmod 000` on a committed source file dropped every file after it
  // in sort order — measured as `filesScanned: 0` with the git diff still
  // complete, i.e. a whole-project verdict rendered from nothing.
  for (const file of walked.files) {
    try {
      analyses.push(cachedAnalysis(projectRoot, file));
    } catch {
      skipped.push(`cannot read source file ${file}`);
    }
  }
  let findings = analyses.flatMap((analysis) => (
    localFindings(analysis, contract.profile, contract.exceptions)
  ));
  findings.push(...contractFindings(
    projectRoot,
    contract,
    analyses,
    options.allowlist,
    options.assignmentScope,
    options.greenfield === true,
  ));
  // Not-scaffolded demotion (StructureScanOptions.notScaffolded): this scan
  // judges every pre-existing file, so an architectural hard-error here
  // blocks completion on conventions the plugin never authored — a user
  // entrypoint that declares components, printWidth-120 code the strict
  // collapse mask reads as packed, routing the compiled contract cannot see,
  // a component split the scanner calls a duplicate, a catalog whose locale
  // set is the user's own. The whole list is an OPINION about code Traffic One
  // did not write, and a maintenance run that cannot land one is worth less
  // than one that lands with the opinion recorded, so the demotion is stated
  // as an exclusion rather than an enumeration: the only findings that survive
  // as errors are the two that are not opinions at all.
  //
  // Ownership is a fact about THIS run — the worker wrote outside the
  // runtime-owned WorkUnitContract — and plan delivery is a fact about the
  // compiled contract: the module the plan promised does not exist. Neither
  // one is a convention, and neither one has a legitimate shape on an existing
  // codebase, so both stay blocking in every mode.
  //
  // Nothing is dropped: `findings` still carries every demoted id with its
  // file, line and message, the report status becomes `warnings` rather than
  // `passed`, and the completion digest consolidates them into the run's
  // quality ledger. Greenfield is untouched — there Traffic One owns the
  // structure and blocks on all of it. The write gate keeps its own collapse
  // check for bytes a run authors.
  if (options.notScaffolded === true) {
    const BLOCKING_ON_UNOWNED = new Set<StructureFinding['id']>([
      'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
      'STRUCT_MISSING_PLANNED_MODULE',
    ]);
    findings = findings.map((finding) => (
      finding.severity === 'error' && !BLOCKING_ON_UNOWNED.has(finding.id)
        ? { ...finding, severity: 'warning' as const }
        : finding
    ));
  }
  // Entries the walk stepped over. Reported so the report still says what it
  // did not read, and never blocking: the REST of the tree is walked to the end
  // either way, which is the whole reason continuing beats abandoning. What
  // continuing does not do is make the step free — behind a skipped directory
  // link or an unreadable directory sits a subtree nothing in this report judged
  // (measured: a collapsed source file planted there produced `warnings` with no
  // STRUCT_COLLAPSED_LINE anywhere), so `skippedEntries` below carries the count
  // and the caller raises the truncated-scan evidence floor from it exactly as
  // it does for the file cap. Pushed after the demotion above deliberately —
  // what a scan did not read is a fact about the scan, not an opinion about the
  // user's code.
  for (const entry of skipped) {
    findings.push({
      id: 'STRUCT_SCAN_SKIPPED',
      severity: 'warning',
      file: '<scan>',
      message: entry,
    });
  }
  if (truncation) {
    // The demotion and the compensation are ONE decision, so they are written
    // as one condition. `bound` is the file CAP: the verification contract
    // raises `uiImpact` to `truncatedScanUiImpactFloor` for it (the caller
    // feeds `boundedScanTruncated`), so a bound-hit run owes MORE browser
    // evidence than a complete one and the warning cannot buy a cheap
    // `verified`. What it buys is a run that can start, over a generated tree
    // whose size the writer cannot act on.
    //
    // `unresolvable` has no such floor behind it and keeps the error. Nothing
    // compensates a report about nothing: the walk found no tree to read, so
    // "every error still in this report was really seen" is true of an empty
    // set, and demoting it would let a run whose source roots do not resolve
    // clear the completion gates on the strength of having judged no files.
    //
    // `unaccounted` keeps the error for a different reason: it is not a fact
    // about the project, it is this walk admitting that entries `readdir`
    // handed it went somewhere it cannot name. There is no honest floor for
    // "the scan does not know what it skipped", and since a correct walk cannot
    // produce one, the error costs no real run anything.
    findings.push({
      id: 'STRUCT_SCAN_INCOMPLETE',
      severity: truncation.kind === 'bound' ? 'warning' : 'error',
      file: '<scan>',
      message: truncation.reason,
    });
  }
  findings.sort((a, b) => (
    a.id.localeCompare(b.id)
    || a.file.localeCompare(b.file)
    || (a.line || 0) - (b.line || 0)
  ));
  const failed = findings.some((finding) => finding.severity === 'error');
  return {
    schemaVersion: STRUCTURE_REPORT_SCHEMA_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    contractHash: contract.contractHash,
    status: failed ? 'failed' : findings.length ? 'warnings' : 'passed',
    complete: !truncation,
    ...(truncation ? { truncationKind: truncation.kind } : {}),
    skippedEntries: skipped.length,
    filesScanned: analyses.length,
    findings,
  };
}

export function writeStructureReport(
  projectRoot: string,
  runId: string,
  report: StructureReportV1,
): string {
  const reportPath = path.join(projectRoot, '.traffic-one', 'runs', runId, 'structure-report.json');
  writeJson(reportPath, report);
  return reportPath;
}
