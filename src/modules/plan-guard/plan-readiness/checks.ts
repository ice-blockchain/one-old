// src/modules/plan-guard/plan-readiness/checks.ts
// Evidence checks: QA-report freshness vs implementation, built-app
// identity, and the collapsed-product-source scan.

import * as fs from 'fs';
import * as path from 'path';
import {
  capabilityProfileForRun,
} from '../../../shared/architecture-contract';
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
    for (const outDir of ['dist', 'out']) {
      try {
        const html = fs.readFileSync(path.join(root, outDir, 'index.html'), 'utf8');
        const match = /<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/.exec(html);
        if (match?.[1]) found.add(path.basename(match[1]));
      } catch {
        // not built with this layout
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

interface CollapseScanResult {
  file: string | null;
  incomplete: boolean;
  scanned: number;
}

export function collapsedProductSourceFile(projectRoot: string, state: Rec): CollapseScanResult {
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
  const stack = [...new Set([...capabilityRoots, 'apps', 'packages'])]
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
