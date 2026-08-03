// src/modules/plan-guard/react-structure/scan.ts
// The full-project scan: mtime/size cache (process singleton), bounded
// source walk, report assembly and persistence.

import * as fs from 'fs';
import * as path from 'path';
import {
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
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

const cache = new Map<string, CacheEntry>();
// Findings an architect-declared exception may suppress. Every advisory numeric
// rule qualifies, plus the one BLOCKING numeric rule (STRUCT_MODULE_LOC) —
// without that a legitimately large module would have no escape hatch at all.

export function invalidateStructureCache(filePath: string): void {
  cache.delete(path.resolve(filePath));
}

function cachedAnalysis(projectRoot: string, file: string): SourceAnalysis {
  const absolute = path.join(projectRoot, file);
  const stat = fs.statSync(absolute);
  const existing = cache.get(absolute);
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return existing.analysis;
  const analysis = analyzeText(file, fs.readFileSync(absolute, 'utf8'));
  cache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, analysis });
  return analysis;
}

function walkSourceFiles(
  projectRoot: string,
  roots: string[],
  maxFiles: number,
): { files: string[]; incomplete: string | null } {
  const files: string[] = [];
  const seenDirs = new Set<string>();
  const resolvedProjectRoot = path.resolve(projectRoot);
  let realProjectRoot: string;
  try { realProjectRoot = fs.realpathSync(resolvedProjectRoot); } catch {
    return { files, incomplete: 'cannot resolve project root' };
  }
  const requestedRoots = [...new Set(roots
    .map((root) => path.resolve(projectRoot, normalizeRel(root)))
  )];
  const outsideRoot = requestedRoots.find((root) => (
    root !== resolvedProjectRoot && !root.startsWith(`${resolvedProjectRoot}${path.sep}`)
  ));
  if (outsideRoot) {
    return {
      files,
      incomplete: `source root escapes project boundary: ${normalizeRel(path.relative(projectRoot, outsideRoot))}`,
    };
  }
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
      return {
        files,
        incomplete: `source root contains symbolic link: ${symbolicRootSegment}`,
      };
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
      unresolvedRoots.push(normalizeRel(path.relative(projectRoot, root)) || '.');
      continue;
    }
    if (real !== realProjectRoot && !real.startsWith(`${realProjectRoot}${path.sep}`)) {
      return {
        files,
        incomplete: `source root resolves outside project boundary: ${normalizeRel(path.relative(projectRoot, root)) || '.'}`,
      };
    }
    stack.push(root);
  }
  if (stack.length === 0 && requestedRoots.length > 0) {
    return {
      files,
      incomplete: `cannot resolve source root${unresolvedRoots.length === 1 ? '' : 's'} ${unresolvedRoots.join(', ')}`,
    };
  }
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let real: string;
    try { real = fs.realpathSync(dir); } catch {
      return { files, incomplete: `cannot resolve source directory ${normalizeRel(path.relative(projectRoot, dir))}` };
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
      return { files, incomplete: `cannot read source directory ${normalizeRel(path.relative(projectRoot, dir))}` };
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const rel = normalizeRel(path.relative(projectRoot, absolute));
      if (SKIP_RE.test(`/${rel}`)) continue;
      if (entry.isSymbolicLink()) {
        // A DIRECTORY link can graft an untracked subtree into a source root —
        // source the contract does not govern, laundered in through a link — so
        // it still makes the scan incomplete. Same for a link whose target
        // cannot be resolved at all.
        //
        // A link to a file that is not structural source cannot contribute
        // source, so it is skipped exactly like any other non-source file.
        // Traffic One's own materialization writes one: root
        // `CLAUDE.md -> AGENTS.md`. Treating it as fatal meant every profile
        // whose source root is the project root (Nuxt, and any `.`-rooted
        // profile) reported STRUCT_SCAN_INCOMPLETE and could never emit
        // IMPLEMENTED — a dead end no implementer can clear, because the file
        // is generated.
        let targetIsDirectory = true;
        try {
          targetIsDirectory = fs.statSync(absolute).isDirectory();
        } catch {
          // Broken link: nothing to scan and nothing to account for.
          continue;
        }
        if (!targetIsDirectory && !STRUCTURAL_SOURCE_RE.test(entry.name)) continue;
        return { files, incomplete: `source scan encountered symbolic link: ${rel}` };
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !STRUCTURAL_SOURCE_RE.test(entry.name)) continue;
      if (files.length >= maxFiles) {
        return { files, incomplete: `source scan exceeds ${maxFiles} files` };
      }
      files.push(rel);
    }
  }
  files.sort();
  return { files, incomplete: null };
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
  );
  const analyses: SourceAnalysis[] = [];
  let incomplete = walked.incomplete;
  for (const file of walked.files) {
    try {
      analyses.push(cachedAnalysis(projectRoot, file));
    } catch {
      incomplete = `cannot read source file ${file}`;
      break;
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
  // Existing-codebase demotion (StructureScanOptions.existing): this complete
  // scan judges every pre-existing file, so the remaining architectural
  // hard-errors would block completion on conventions the plugin never
  // authored — a user entrypoint that declares components, printWidth-120
  // code the strict collapse mask reads as packed, or routing the compiled
  // contract cannot see. The write gate keeps its own collapse check for
  // bytes a run authors; ownership/scan-integrity/plan-delivery ids stay
  // blocking above.
  if (options.existing === true) {
    const DEMOTED_ON_EXISTING = new Set<StructureFinding['id']>([
      'STRUCT_ENTRYPOINT_COMPONENT',
      'STRUCT_COLLAPSED_LINE',
      'STRUCT_ROUTE_MODULE_MISMATCH',
    ]);
    findings = findings.map((finding) => (
      finding.severity === 'error' && DEMOTED_ON_EXISTING.has(finding.id)
        ? { ...finding, severity: 'warning' as const }
        : finding
    ));
  }
  if (incomplete) {
    findings.push({
      id: 'STRUCT_SCAN_INCOMPLETE',
      severity: 'error',
      file: '<scan>',
      message: incomplete,
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
    complete: !incomplete,
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
