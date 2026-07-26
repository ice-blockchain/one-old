// src/modules/plan-guard/plan-readiness.ts
// The project-readiness half of the plan-write gate: monorepo scaffold,
// state-file presence, materialization, and plan gates. Ported 1:1 from
// runCheckPlanWrite, minus the run-team enforcement
// gate (which lands separately). `writingFeatureSource` is precomputed by the
// caller from the feature-source helpers — this keeps the readiness logic
// independently testable. Deny PROSE comes from skill/SKILL.md via skillBlock.

import * as fs from 'fs';
import * as path from 'path';

import { isKnownStack } from '../../shared/config';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { detectMode } from '../../shared/detection';
import { packageJsonDeclaresWorkspace, stateRequiresNewProjectMonorepo } from '../../shared/hook-paths';
import { hasMaterializedProjectAssets } from '../../shared/materialize';
import { canonicalHost } from '../../shared/model-tiers';
import { openCodeDelegationActive } from '../../shared/performance';
import { OPENCODE_PLAN_MIN_UNITS, parsePlanDelegationUnits, planDelegationUnitCount } from '../../shared/opencode-roles';
import { openCodeQueuePolicyViolations, type OpenCodeQueuePolicyOptions } from '../../shared/opencode-queue';
import { obj } from '../../shared/obj';
import { activeAgentRole, isMaterialized, legacyStatePath, readRunAssignmentsResilient, resolveRunAgentContext, stackFingerprint, statePath } from '../../shared/state';

type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

const PLAN_FILE_RE = /(^|\/)\.traffic-one\/plan\.md$/;
const ASSIGNMENTS_FILE_RE = /(^|\/)\.traffic-one\/runs\/[^/]+\/assignments\.json$/;
const ARCHITECT_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/[^/]+\/architect\.md$/;
const FRONTEND_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/[^/]+\/frontend\.md$/;
const TESTER_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-)?tester\.md$/;
// Collapsed-source delivery guard. A single source line packing an entire
// component/route (observed 16c: apps/web/src/App.tsx held the whole app —
// Catalog, CoursePage, LessonPage, Dashboard, routing, data — as one-line
// functions up to 1722 chars, leaving every scaffolded pages/features/components
// dir empty; the frontend still reported IMPLEMENTED because build/typecheck
// pass on collapsed code). A hand-written code line does not approach this
// length; a long string/URL/data-URI has none of the statement/JSX punctuation
// required below, so the threshold is safe from false positives.
const COLLAPSE_SOURCE_RE = /\.(?:tsx?|jsx?|mjs|cjs|css|scss)$/;
const COLLAPSE_SKIP_DIR_RE = /(^|\/)(node_modules|dist|build|coverage|out|\.turbo|\.next|\.vite|generated|__generated__)(\/|$)/;
const COLLAPSE_LINE_CHARS = 500;
const COLLAPSE_MAX_FILES = 600;

/**
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
function builtAppIdentities(projectRoot: string): string[] {
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
function qaReportVerifiedBuild(
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

function collapsedProductSourceFile(projectRoot: string): string | null {
  const stack = ['apps', 'packages'].map((dir) => path.join(projectRoot, dir));
  let scanned = 0;
  while (stack.length > 0 && scanned < COLLAPSE_MAX_FILES) {
    const dir = stack.pop()!;
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
      if (++scanned > COLLAPSE_MAX_FILES) break;
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
        if (statements >= 3 || jsxClose >= 2) return `${rel}:${i + 1}`;
      }
    }
  }
  return null;
}
const ADR_OR_DOC_RE = /(^|\/)(docs|architecture|README|ADR)/i;
const ROOT_VITE_RE = /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/;
const ROOT_MONOREPO_FLAT_RE = /^tsconfig(?!\.base\.json$)(\.[a-z0-9-]+)?\.json$/;
const T1_MEMORY_DIR = '.traffic' + '-one';
const CANONICAL_TAILWIND_GLOBALS_PATH = 'packages/tailwind-config/src/globals.css';
const TAILWIND_CONFIG_BASELINE_PATHS = [
  CANONICAL_TAILWIND_GLOBALS_PATH,
  'packages/tailwind-config/globals.css',
  'packages/tailwind-config/index.ts',
  'packages/tailwind-config/tailwind.config.ts',
];

// The OpenCode plan-queue gate is a TOKEN-OPTIMIZATION, not a correctness gate: it
// wants the architect to list bounded units for the free OpenCode batch. On
// Windsurf/Devin it must NOT block — Devin's agent treats any gate deny as terminal
// (it stops, and a non-technical user is stuck with no "continue"), and OpenCode
// delegation is best-effort anyway (a missing queue just falls back to paid). So
// Windsurf never blocks here; other hosts keep the original hard block (their agents
// read the deny and retry with the queue).
function opencodeQueueBlocks(host: string | undefined): boolean {
  return canonicalHost(host) !== 'windsurf';
}

function exists(projectRoot: string, relPath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relPath));
}

function existsAny(projectRoot: string, relPaths: string[]): boolean {
  return relPaths.some((relPath) => exists(projectRoot, relPath));
}

function hasAnyAppPackage(projectRoot: string): boolean {
  const appsDir = path.join(projectRoot, 'apps');
  try {
    return fs.readdirSync(appsDir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && fs.existsSync(path.join(appsDir, entry.name, 'package.json')));
  } catch {
    return false;
  }
}

function packageJsonMatchesWorkspaceRoot(projectRoot: string, content: string): boolean {
  if (packageJsonDeclaresWorkspace(content)) return true;
  if (!existsAny(projectRoot, ['pnpm-workspace.yaml', 'pnpm-workspace.yml'])) return false;
  try {
    const pkg = JSON.parse(content);
    const hasPnpmPackageManager = typeof pkg?.packageManager === 'string' && /^pnpm@\d/.test(pkg.packageManager);
    return pkg?.private === true && hasPnpmPackageManager;
  } catch {
    return true;
  }
}

function rootPackageJsonMatchesWorkspaceRoot(projectRoot: string): boolean {
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    return packageJsonMatchesWorkspaceRoot(projectRoot, content);
  } catch {
    return false;
  }
}

function missingArchitectScaffold(projectRoot: string, state: Rec): string[] {
  if (!stateRequiresNewProjectMonorepo(state)) return [];
  const missing: string[] = [];
  if (!existsAny(projectRoot, ['pnpm-workspace.yaml', 'pnpm-workspace.yml'])) missing.push('pnpm-workspace.yaml');
  if (!exists(projectRoot, 'turbo.json')) missing.push('turbo.json');
  if (!exists(projectRoot, 'tsconfig.base.json')
    && !exists(projectRoot, 'packages/tsconfig/base.json')) {
    missing.push('tsconfig.base.json (or packages/tsconfig/base.json)');
  }
  if (!rootPackageJsonMatchesWorkspaceRoot(projectRoot)) {
    missing.push('package.json (private + pnpm packageManager + workspace declaration)');
  }
  if (!hasAnyAppPackage(projectRoot)) missing.push('apps/<name>/package.json');
  if (!exists(projectRoot, 'packages/ui/package.json')) missing.push('packages/ui/package.json');
  // The UI barrel legitimately becomes index.tsx once components land in it.
  // Accepting only index.ts made the architect's own digest unwritable AFTER a
  // sibling role upgraded the barrel: the completion gate re-validated the
  // original scaffold shape and refused every `PLAN_READY`-bearing rewrite
  // (observed 12c: an ownership-transfer bookkeeping update had to be skipped).
  if (!existsAny(projectRoot, ['packages/ui/src/index.ts', 'packages/ui/src/index.tsx'])) {
    missing.push('packages/ui/src/index.ts (or index.tsx)');
  }
  if (!exists(projectRoot, 'packages/tailwind-config/package.json')) missing.push('packages/tailwind-config/package.json');
  if (!existsAny(projectRoot, TAILWIND_CONFIG_BASELINE_PATHS)) {
    missing.push(CANONICAL_TAILWIND_GLOBALS_PATH);
  }
  if (!exists(projectRoot, 'packages/i18n/package.json')) missing.push('packages/i18n/package.json');
  if (!exists(projectRoot, 'packages/i18n/src/index.ts')) missing.push('packages/i18n/src/index.ts');
  // Formatting is a delivery gate. Without a formatter config + a root
  // `format:check` script the generated code ships collapsed/minified and still
  // passes lint (observed 10c: every page component landed as one multi-
  // thousand-character line — ESLint carried no formatting rule, prettier was
  // configured nowhere, and no mechanical gate ran `format:check`).
  if (!hasPrettierConfig(projectRoot)) {
    missing.push('.prettierrc (or prettier.config.*, or a "prettier" key in root package.json)');
  }
  if (!rootPackageJsonScript(projectRoot, 'format:check')) {
    missing.push('package.json "format:check" script (e.g. "prettier --check .") plus the prettier devDependency and a .prettierignore covering build output AND the generated `.traffic-one/` tree (its prose/metadata is not product source and must not fail the gate)');
  }
  return missing;
}

const PRETTIER_CONFIG_PATHS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml', '.prettierrc.yml',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
];

function hasPrettierConfig(projectRoot: string): boolean {
  if (existsAny(projectRoot, PRETTIER_CONFIG_PATHS)) return true;
  try {
    const parsed = obj(JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')));
    return Boolean(parsed && parsed.prettier != null);
  } catch {
    return false;
  }
}

function rootPackageJsonScript(projectRoot: string, name: string): boolean {
  try {
    const parsed = obj(JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')));
    const scripts = obj(parsed?.scripts);
    const value = scripts?.[name];
    return typeof value === 'string' && value.trim().length > 0;
  } catch {
    return false;
  }
}

function readTrimmed(projectRoot: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(projectRoot, relPath), 'utf8').trim();
  } catch {
    return null;
  }
}

function hasRealContent(projectRoot: string, relPath: string, minBytes = 16): boolean {
  const content = readTrimmed(projectRoot, relPath);
  return Boolean(content && content.length >= minBytes);
}

function hasNotApplicableReason(projectRoot: string, relPath: string): boolean {
  const content = readTrimmed(projectRoot, relPath);
  if (!content) return false;
  if (!/\b(not applicable|n\/a|not-applicable)\b/i.test(content)) return false;
  return content.length >= 32 && /\b(because|reason|no |without|none|external|static|frontend[- ]only)\b/i.test(content);
}

function hasDecisionRecordWhenNeeded(projectRoot: string, state: Rec): boolean {
  const mobile = obj(state.mobile);
  const hasNonDefaultChoice = state.stack !== 'default'
    || state.frontend !== 'react-vite'
    || state.backend !== 'supabase'
    || Boolean(mobile?.enabled);
  if (!hasNonDefaultChoice) return true;
  const dir = path.join(projectRoot, T1_MEMORY_DIR, 'decisions');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) return false;
      return hasRealContent(projectRoot, path.join(T1_MEMORY_DIR, 'decisions', entry.name), 32);
    });
  } catch {
    return false;
  }
}

function missingProjectMemoryBaseline(projectRoot: string, state: Rec): string[] {
  if (state.mode !== 'new-project') return [];
  const missing: string[] = [];
  for (const relPath of [
    '.traffic-one/product.md',
    '.traffic-one/stack.md',
    '.traffic-one/coding.md',
    '.traffic-one/security.md',
    '.traffic-one/known-issues.md',
    '.traffic-one/deployment.md',
    '.traffic-one/environment-setup.md',
    '.traffic-one/agent-log.md',
    '.traffic-one/.agentignore',
  ]) {
    if (!hasRealContent(projectRoot, relPath, relPath.endsWith('.agentignore') ? 1 : 16)) missing.push(relPath);
  }

  const backend = typeof state.backend === 'string' ? state.backend : '';
  const hasOwnedBackend = backend !== '' && backend !== 'none' && backend !== 'external-api';
  const backendDocs = ['.traffic-one/api.md', '.traffic-one/database.md', '.traffic-one/schema.sql'];
  for (const relPath of backendDocs) {
    const ok = hasOwnedBackend
      ? (hasRealContent(projectRoot, relPath, 16) || hasNotApplicableReason(projectRoot, relPath))
      : hasNotApplicableReason(projectRoot, relPath);
    if (!ok) missing.push(hasOwnedBackend ? relPath : `${relPath} (Not applicable + reason)`);
  }

  if (!hasDecisionRecordWhenNeeded(projectRoot, state)) {
    missing.push('.traffic-one/decisions/*.md (ADR for non-default stack choice)');
  }
  return missing;
}

function missingOpenCodeDelegateBlock(content: string): boolean {
  return planDelegationUnitCount(content) < OPENCODE_PLAN_MIN_UNITS;
}

function hasOpenCodeDelegateMarker(content: string): boolean {
  return content.includes('opencode-delegate:start') || content.includes('opencode-delegate:end');
}

function openCodeQueuePolicyErrors(content: string): string[] {
  return openCodeQueuePolicyViolations(parsePlanDelegationUnits(content));
}

function planOnDiskMissingOpenCodeBlock(projectRoot: string): boolean {
  try {
    const plan = fs.readFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), 'utf8');
    return missingOpenCodeDelegateBlock(plan);
  } catch {
    return true;
  }
}

function planOnDiskHasOpenCodeDelegateMarker(projectRoot: string): boolean {
  try {
    const plan = fs.readFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), 'utf8');
    return hasOpenCodeDelegateMarker(plan);
  } catch {
    return false;
  }
}

function planOnDiskOpenCodeQueuePolicyErrors(
  projectRoot: string,
  options: OpenCodeQueuePolicyOptions = {},
): string[] {
  try {
    const plan = fs.readFileSync(path.join(projectRoot, T1_MEMORY_DIR, 'plan.md'), 'utf8');
    return openCodeQueuePolicyViolations(parsePlanDelegationUnits(plan), options);
  } catch {
    return [];
  }
}

function assignmentsUsesCanonicalShape(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(obj(parsed)?.assignments);
  } catch {
    return false;
  }
}

function assignmentRoleErrors(content: string): string[] {
  const allowed = new Set(['senior-frontend', 'senior-backend']);
  try {
    const parsed = obj(JSON.parse(content) as unknown);
    const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : [];
    const roles = assignments
      .map((entry) => obj(entry)?.role)
      .filter((role): role is string => typeof role === 'string' && role.trim().length > 0);
    const invalid = roles.filter((role) => !allowed.has(role));
    return invalid.length ? [`Assignments manifest may include only senior-frontend and senior-backend entries in this version; remove: ${[...new Set(invalid)].join(', ')}`] : [];
  } catch {
    return [];
  }
}

function missingAssignmentsManifest(projectRoot: string, state: Rec): string[] {
  if (state.mode !== 'new-project') return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return ['.traffic-one/runs/<runId>/assignments.json (currentRunId missing)'];
  const relPath = `.traffic-one/runs/${runId}/assignments.json`;
  if (!exists(projectRoot, relPath)) return [relPath];
  try {
    const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf8');
    if (!assignmentsUsesCanonicalShape(content)) {
      return [`${relPath} (canonical top-level assignments array required)`];
    }
    const roleErrors = assignmentRoleErrors(content);
    if (roleErrors.length > 0) return roleErrors.map((err) => `${relPath} (${err})`);
  } catch {
    return [`${relPath} (unreadable)`];
  }
  return [];
}

function missingArchitectDigest(projectRoot: string, state: Rec): string[] {
  if (state.mode !== 'new-project') return [];
  if (architectPlanReadyOnDisk(projectRoot, state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '<runId>';
  return [`.traffic-one/digests/${runId}/architect.md (must contain PLAN_READY)`];
}

export function architectPhaseIncompleteReasons(projectRoot: string, state: Rec): string[] {
  if (state.mode !== 'new-project') return [];
  return [
    ...missingArchitectScaffold(projectRoot, state),
    ...missingProjectMemoryBaseline(projectRoot, state),
    ...missingAssignmentsManifest(projectRoot, state),
    ...missingArchitectDigest(projectRoot, state),
  ];
}

export function isArchitectPhaseComplete(projectRoot: string, state: Rec): boolean {
  return architectPhaseIncompleteReasons(projectRoot, state).length === 0;
}

export function architectPlanReadyOnDisk(projectRoot: string, state: Rec): boolean {
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return false;
  try {
    return /\bPLAN_READY\b/.test(fs.readFileSync(path.join(projectRoot, T1_MEMORY_DIR, 'digests', runId, 'architect.md'), 'utf8'));
  } catch {
    return false;
  }
}

function assignmentWriterRole(projectRoot: string, state: Rec, rawData: unknown, host?: string): string | null {
  const ctx = rawData ? resolveRunAgentContext(projectRoot, state, rawData, { claimPending: true, host }) : null;
  return (ctx && typeof ctx.role === 'string' ? ctx.role : null) || activeAgentRole(state);
}

function isEmptyBarrelContent(content: string): boolean {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '')
    .trim();
  return stripped === '' || stripped === 'export {}' || stripped === 'export {};';
}

function isArchitectPackageBarrelTarget(filePath: string): boolean {
  return /^packages\/[^/]+\/src\/index\.ts$/.test(filePath);
}

function isArchitectTailwindGlobalsTarget(filePath: string): boolean {
  return filePath === CANONICAL_TAILWIND_GLOBALS_PATH || filePath === 'packages/tailwind-config/globals.css';
}

function isArchitectBaselineFeatureWrite(filePath: string, content: string): boolean {
  if (isArchitectTailwindGlobalsTarget(filePath)) return true;
  return isArchitectPackageBarrelTarget(filePath) && isEmptyBarrelContent(content);
}

function usesMainAgentTeam(state: Rec): boolean {
  return obj(state.team)?.mode === 'main-agent';
}

export interface ReadinessArgs {
  filePath: string;          // project-relative target path
  content: string;           // write content (Write.content / Edit.new_string)
  projectRoot: string;       // resolved project root for the target
  state: Rec;                // readEffectiveState(projectRoot)
  writingFeatureSource: boolean;
  host?: string;
  rawData?: unknown;
  block: Block;
}

// Readiness violations for a single write/edit. Empty array == nothing to block.
export function planReadinessViolations(args: ReadinessArgs): string[] {
  const { filePath, content, projectRoot, state, writingFeatureSource, rawData, block, host } = args;
  const violations: string[] = [];
  const currentHost = canonicalHost(host);

  const requiresMonorepoScaffold = stateRequiresNewProjectMonorepo(state);

  if (requiresMonorepoScaffold && filePath === 'package.json' && !packageJsonMatchesWorkspaceRoot(projectRoot, content)) {
    violations.push(block('monorepo-package-json',
      'New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: `private: true`, `packageManager: pnpm@...`, and a workspace declaration (`pnpm-workspace.yaml` or package.json `workspaces`) for `apps/*` and `packages/*`. Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.'));
  }

  if (requiresMonorepoScaffold && ROOT_VITE_RE.test(filePath)) {
    violations.push(block('monorepo-root-vite',
      'New-project monorepo gate: root Vite app files are not allowed for this stack. Use `apps/web/` for the React app and create the required `packages/*` workspaces first; see `rules/modes/new-project.md`.'));
  }

  if (requiresMonorepoScaffold && ROOT_MONOREPO_FLAT_RE.test(filePath)) {
    violations.push(block('monorepo-root-flat-scaffold',
      'New-project monorepo gate: root-level TypeScript config files (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, etc.) are not allowed for this stack. Complete the architect phase and scaffold the Turborepo workspace (`pnpm-workspace.yaml`, `apps/web/`, `packages/*`, `tsconfig.base.json`) instead of creating a flat root Vite layout.'));
  }

  if (ARCHITECT_DIGEST_RE.test(filePath) && /\bPLAN_READY\b/.test(content)) {
    const missing = missingArchitectScaffold(projectRoot, state);
    if (missing.length > 0) {
      violations.push(block('architect-scaffold-gate',
        `Architect completion gate: do not write \`PLAN_READY\` until the required Traffic One workspace scaffold exists. Missing: ${missing.join(', ')}. Write the missing baseline files, then update \`.traffic-one/digests/<runId>/architect.md\` and only then emit \`PLAN_READY\`.`,
        { MISSING: missing.join(', ') }));
    }
    const missingMemory = missingProjectMemoryBaseline(projectRoot, state);
    if (missingMemory.length > 0) {
      violations.push(block('architect-memory-baseline-gate',
        `Architect completion gate: do not write \`PLAN_READY\` until the required .traffic-one project-memory baseline exists with real content. Missing or incomplete: ${missingMemory.join(', ')}. Write the missing memory files yourself (do not delegate .traffic-one/* to OpenCode), then update \`.traffic-one/digests/<runId>/architect.md\` and only then emit \`PLAN_READY\`.`,
        { MISSING: missingMemory.join(', ') }));
    }
    if (state.mode === 'new-project' && openCodeDelegationActive(state, host) && planOnDiskMissingOpenCodeBlock(projectRoot) && opencodeQueueBlocks(host)) {
      violations.push(block('architect-opencode-queue-gate',
        `Architect completion gate: OpenCode is enabled but \`.traffic-one/plan.md\` is missing at least ${OPENCODE_PLAN_MIN_UNITS} runnable machine-readable delegation units. Include \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` with 3–6 bounded units (\`- role: … | files: … | task: …\`) before emitting \`PLAN_READY\`. The orchestrator runs \`opencode_delegate_from_plan\` from that block BEFORE spawning implementers.`));
    }
    if (state.mode === 'new-project' && (currentHost === 'opencode' || currentHost === 'kilo') && planOnDiskHasOpenCodeDelegateMarker(projectRoot)) {
      violations.push(block('architect-opencode-self-delegation-gate',
        'Architect completion gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block before emitting `PLAN_READY`; implementer work runs directly on the current host.'));
    }
  }

  // Frontend completion gate: an `IMPLEMENTED` digest must not ship collapsed
  // product source. build/typecheck/lint all pass on a one-line-per-function
  // App.tsx, so nothing else stops it before the tester's format:check — and a
  // run interrupted before Phase 3 delivers a monolithic collapsed app with
  // empty scaffolded module dirs (observed 16c).
  if (FRONTEND_DIGEST_RE.test(filePath) && /\bIMPLEMENTED\b/.test(content)) {
    const collapsed = collapsedProductSourceFile(projectRoot);
    if (collapsed) {
      violations.push(block('frontend-collapse-gate',
        `Frontend completion gate: do not write \`IMPLEMENTED\` with collapsed source. \`${collapsed}\` packs an entire component/route onto a single line (over ${COLLAPSE_LINE_CHARS} chars) — collapsed/minified source is a defect even when build and typecheck pass. Run the project formatter (\`format\` script), and split routes, pages, features, and shared components into their own files under the scaffolded module dirs (\`App.tsx\` is the router/shell only, not the whole app). Then re-run \`format:check\` and re-emit \`IMPLEMENTED\`.`,
        { FILE: collapsed }));
    }
  }

  // Tester completion gate: `TESTS_GREEN` must not rest on a QA report that predates the
  // implementation it claims to verify. The settlement floor already REFUSES such a report
  // (strictQaReportResult uses max(qaContractActivatedAt, frontend digest mtime)), but it
  // refuses SILENTLY: observed live in cursor-16c the frontend re-emitted its digest 11s
  // after the sweep ran, so reviewer APPROVED + tester TESTS_GREEN + a `passed` report still
  // left the run non-terminal — and it only recovered by accident when an unrelated feature
  // request triggered a fresh sweep. The orchestrator prose already tells the tester to
  // re-run the sweep after a fix cycle; this turns "ignored instruction, silent stall" into
  // an actionable deny at the moment the stale verdict is written.
  const testerDigest = TESTER_DIGEST_RE.exec(filePath);
  if (testerDigest && /\bTESTS_GREEN\b/.test(content)) {
    const staleQa = qaReportOlderThanImplementation(projectRoot, testerDigest[2] || '');
    if (staleQa) {
      violations.push(block('tester-stale-qa-gate',
        `Tester completion gate: do not write \`TESTS_GREEN\` on a stale QA report. The report was generated at ${staleQa.generatedAt} but \`${staleQa.digest}\` was re-emitted at ${staleQa.digestAt}, so the sweep did not see the current implementation and the run cannot settle. Re-run the visual QA sweep now, write the fresh report, and only then re-emit \`TESTS_GREEN\`.`,
        { GENERATED_AT: staleQa.generatedAt, DIGEST: staleQa.digest, DIGEST_AT: staleQa.digestAt }));
    }
    // Every other QA freshness check is TEMPORAL, so a sweep aimed at a leftover
    // preview server passes them all: it genuinely ran, just against another app.
    // Only the served build identity answers "which application answered?".
    const expectedBuilds = builtAppIdentities(projectRoot);
    if (expectedBuilds.length > 0) {
      const observed = qaReportVerifiedBuild(projectRoot, testerDigest[2] || '');
      if (observed && !observed.present) {
        violations.push(block('tester-qa-build-identity-missing',
          `Tester completion gate: do not write \`TESTS_GREEN\` on a QA report that does not name the build it loaded. This run's fresh build is \`${expectedBuilds.join(', ')}\`, but the QA report has no \`verifiedBuild\`. Start the preview on a port THIS run owns (\`--strictPort\`, never a shared default like 4173/5173/3000), fetch the base URL, read the entry asset the served HTML references, record it as \`verifiedBuild\`, and re-run the sweep.`,
          { EXPECTED: expectedBuilds.join(', ') }));
      } else if (observed && observed.present && !expectedBuilds.includes(observed.value)) {
        violations.push(block('tester-qa-build-identity-mismatch',
          `Tester completion gate: the QA sweep validated a DIFFERENT application. The report records \`verifiedBuild: ${observed.value}\` but this run's fresh build is \`${expectedBuilds.join(', ')}\` — the base URL answered a leftover preview server (observed live: a previous project's \`vite preview\` still held the port, so every check passed against another app). Kill the foreign server or bind your own free port with \`--strictPort\`, re-run the sweep against it, and only then re-emit \`TESTS_GREEN\`.`,
          { EXPECTED: expectedBuilds.join(', '), OBSERVED: observed.value }));
      }
    }
  }

  // Queue-policy validation runs whenever a delegate block is present and OpenCode
  // is active — new-project builds AND complex maintenance builds the architect
  // was spawned for (which emit the same block). The require-block gate above stays
  // new-project-only; we never force a maintenance plan to contain a queue.
  if (ARCHITECT_DIGEST_RE.test(filePath) && /\bPLAN_READY\b/.test(content) && openCodeDelegationActive(state, host) && !planOnDiskMissingOpenCodeBlock(projectRoot)) {
    // Cross-check the queue against the architect's OWN assignments manifest here,
    // where both artifacts exist and are still architect-owned: a unit whose files
    // belong to another role is a contradiction the runtime only catches after
    // paying for the delegation (17c: `seo-public-assets` → `.env.example`).
    const scopeManifest = readRunAssignmentsResilient(
      projectRoot,
      typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '',
    );
    const policyErrors = planOnDiskOpenCodeQueuePolicyErrors(
      projectRoot,
      scopeManifest ? { assignments: scopeManifest.assignments } : {},
    );
    if (policyErrors.length > 0) {
      violations.push(block('architect-opencode-queue-policy-gate',
        `Architect completion gate: OpenCode queue metadata is unsafe: ${policyErrors.join('; ')}. Add stable unique ids, exact files allowlists, and depends edges for overlapping areas before emitting \`PLAN_READY\`.`,
        { ERRORS: policyErrors.join('; ') }));
    }
  }

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && openCodeDelegationActive(state, host) && missingOpenCodeDelegateBlock(content) && opencodeQueueBlocks(host)) {
    violations.push(block('plan-opencode-queue-gate',
      `Plan gate: OpenCode is enabled — \`.traffic-one/plan.md\` must include the machine-readable \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` block with at least ${OPENCODE_PLAN_MIN_UNITS} runnable bounded units (\`- role: frontend|backend|tester|docs | files: … | task: …\`). Prose-only or incomplete OpenCode lists are ignored by \`opencode_delegate_from_plan\`.`));
  }

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && (currentHost === 'opencode' || currentHost === 'kilo') && hasOpenCodeDelegateMarker(content)) {
    violations.push(block('plan-opencode-self-delegation-gate',
      'Plan gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block; implementer work runs directly on the current host.'));
  }

  if (PLAN_FILE_RE.test(filePath) && openCodeDelegationActive(state, host) && !missingOpenCodeDelegateBlock(content)) {
    const policyErrors = openCodeQueuePolicyErrors(content);
    if (policyErrors.length > 0) {
      violations.push(block('plan-opencode-queue-policy-gate',
        `Plan gate: OpenCode queue metadata is unsafe: ${policyErrors.join('; ')}. Add stable unique ids, exact files allowlists, and depends edges for overlapping areas.`,
        { ERRORS: policyErrors.join('; ') }));
    }
  }

  if (ASSIGNMENTS_FILE_RE.test(filePath) && state.mode === 'new-project' && !assignmentsUsesCanonicalShape(content)) {
    violations.push(block('assignments-shape-gate',
      'Assignments gate: `.traffic-one/runs/<runId>/assignments.json` must use the canonical shape with a top-level `assignments` ARRAY of `{ role, scope: { include, exclude? } }` entries — not a `roles` object or `ownedPaths` fields. Rewrite it as `{ "version": 1, "runId": "<currentRunId>", "assignments": [{ "role": "senior-frontend", "scope": { "include": ["apps/web/**", "packages/ui/**", "packages/i18n/**", "packages/tailwind-config/**"], "exclude": [] } }, { "role": "senior-backend", "scope": { "include": ["supabase/**", "packages/api-client/**"], "exclude": [] } }] }` and adjust paths to the real Module map.'));
  }

  if (ASSIGNMENTS_FILE_RE.test(filePath) && state.mode === 'new-project' && assignmentsUsesCanonicalShape(content)) {
    const roleErrors = assignmentRoleErrors(content);
    if (roleErrors.length > 0) {
      violations.push(block('assignments-roles-gate',
        roleErrors.join('; '),
        { ERRORS: roleErrors.join('; ') }));
    }
    const writerRole = assignmentWriterRole(projectRoot, state, rawData, host);
    if (writerRole && writerRole !== 'senior-architect' && architectPlanReadyOnDisk(projectRoot, state)) {
      violations.push(block('assignments-owner-gate',
        `Assignments gate: \`.traffic-one/runs/<runId>/assignments.json\` is architect/orchestrator-owned and must not be changed by \`${writerRole}\` after \`PLAN_READY\`. Surface the needed scope change in the role digest instead.`,
        { ROLE: writerRole }));
    }
  }

  const validStateStack = Boolean(state.stack && isKnownStack(state.stack));
  const stateMissing = !fs.existsSync(statePath(projectRoot)) && !fs.existsSync(legacyStatePath(projectRoot));
  const memoryPresent = fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'))
    || fs.existsSync(path.join(projectRoot, '.traffic-one', 'stack.md'));
  const detectedModeForState = state.mode || (stateMissing ? detectMode(projectRoot) : null);

  if (writingFeatureSource && !validStateStack && (detectedModeForState === 'new-project' || memoryPresent)) {
    violations.push(block('state-gate',
      'State gate: root .traffic-one/.one.json is missing or incomplete. Write the Traffic One state file with mode, stack, backend, realtime, confirmed, onboardingComplete, and confirmedAt before writing feature source. The .traffic-one/ folder is project memory, not the stack-selection state file.'));
  }

  const hasMaterializedAssets = hasMaterializedProjectAssets(projectRoot, state);
  const featureContextMaterialized = isPluginAuthoringRoot(projectRoot)
    || !state.onboardingComplete
    || (isMaterialized(state) && hasMaterializedAssets);

  if (writingFeatureSource && !featureContextMaterialized) {
    violations.push(block('materialization-gate',
      `Materialization gate: stack context for ${stackFingerprint(state)} has not been materialized on disk yet. Run \`node -e "const p=require('node:path'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,'traffic-one-runtime');require(p.join(r,'scripts','hook-runtime.cjs'))" materialize-project\` from the project root and verify \`.traffic-one/rules/**\`, \`.traffic-one/skills/**\`, \`.traffic-one/manifest.json\`, root \`AGENTS.md\`, and root \`CLAUDE.md\` exist before writing feature source.`,
      { FINGERPRINT: stackFingerprint(state) }));
  }

  const isNewProject = state.mode === 'new-project';
  const planMissing = !fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'));
  const writingPlan = PLAN_FILE_RE.test(filePath);
  const writingDoc = ADR_OR_DOC_RE.test(filePath);
  const writerRole = assignmentWriterRole(projectRoot, state, rawData, host);

  if (isNewProject && planMissing && writingFeatureSource && !writingPlan && !writingDoc
    // The architect's own baseline scaffold (empty barrels, Tailwind globals) is
    // legitimate pre-plan work — architect-pre-ready-feature below governs it.
    && !(writerRole === 'senior-architect' && filePath && isArchitectBaselineFeatureWrite(filePath, content))) {
    if (usesMainAgentTeam(state)) {
      violations.push(block('plan-main-agent-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project in Low/main-agent mode. Do NOT call `run_subagent`, `Task`, `spawn_agent`, `task`, or another subagent tool. You are the architect in this thread: write `.traffic-one/plan.md` and required `.traffic-one/` project memory before root config, workspace scaffold, or feature-source writes; then resume the same ordered phases. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    } else if (writerRole === 'senior-architect') {
      // Never tell the architect to "run the senior-architect subagent" (B8) —
      // it IS that subagent. Tell it to write the plan itself.
      violations.push(block('plan-architect-self-gate',
        'Plan gate: .traffic-one/plan.md is missing on this new project. You ARE the `senior-architect` for this run — write `.traffic-one/plan.md` (and the `.traffic-one/` project-memory baseline) BEFORE any feature-source file; do not spawn another architect. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README, empty `packages/*/src/index.ts` barrels, and the shared Tailwind globals baseline.'));
    } else {
      violations.push(block('plan-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    }
  }

  if (isNewProject
    && writingFeatureSource
    && writerRole === 'senior-architect'
    && !architectPlanReadyOnDisk(projectRoot, state)
    && !(filePath && isArchitectBaselineFeatureWrite(filePath, content))) {
    violations.push(block('architect-pre-ready-feature',
      'Architect scope gate: `senior-architect` may write only workspace scaffold, the shared Tailwind globals baseline, and empty `packages/*/src/index.ts` barrels before `PLAN_READY`. Finish the project-memory baseline, `.traffic-one/runs/<runId>/assignments.json`, and `.traffic-one/digests/<runId>/architect.md` with `PLAN_READY` before writing app or package implementation files.',
      { TARGET: filePath }));
  }

  return violations;
}
