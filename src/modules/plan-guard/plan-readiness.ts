// src/modules/plan-guard/plan-readiness.ts
// The project-readiness half of the plan-write gate: monorepo scaffold,
// state-file presence, materialization, and plan gates. Ported 1:1 from
// runCheckPlanWrite, minus the run-team enforcement
// gate (which lands separately). `writingFeatureSource` is precomputed by the
// caller from the feature-source helpers — this keeps the readiness logic
// independently testable. Deny PROSE comes from skill/SKILL.md via skillBlock.

import * as fs from 'fs';
import * as path from 'path';

import {
  buildRuntimeAssignments,
  capabilityProfileForRun,
  compileArchitectureForRun,
  persistCompiledArchitecture,
  publishRuntimeAssignments,
  readCompiledArchitecture,
  readRuntimeAssignments,
  validateArchitectureInput,
  webPackageRoot,
  type CompiledArchitectureV1,
} from '../../shared/architecture-contract';
import { profileHasWebUi, type CapabilityProfileV1 } from '../../shared/capabilities';
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
import { readQaReportV2 } from '../../shared/qa-report-v2';
import {
  activateRunV2RollbackBarrier,
  writeRunSettlement,
} from '../../shared/run-settlement';
import {
  canPublishRunPolicyBootstraps,
  ensureRunPolicyBootstraps,
  readRunModelPolicy,
} from '../../shared/run-model-policy';
import { readActiveRunBootstrap } from '../../shared/run-bootstrap-policy';
import { matchesPattern, matchesScope, normalizeRelPath, type AssignedScope } from '../../shared/scope';
import {
  activeAgentRole,
  isMaterialized,
  legacyStatePath,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
  stackFingerprint,
  statePath,
} from '../../shared/state';
import {
  buildVerificationContract,
  changedPathsFromBaseline,
  publishVerificationContract,
  readVerificationContract,
  type LighthouseThresholdsV1,
  type UiImpact,
} from '../../shared/verification-contract';
import { readVerificationPlanIntent } from '../../shared/verification-plan-intent';
import {
  analyzeProjectStructure,
  analyzeStructureText,
  analyzeStructureTextAgainstContract,
  invalidateStructureCache,
  writeStructureReport,
  type StructureFinding,
} from './react-structure';

type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

const PLAN_FILE_RE = /(^|\/)\.traffic-one\/plan\.md$/;
const ASSIGNMENTS_FILE_RE = /(^|\/)\.traffic-one\/runs\/[^/]+\/assignments\.json$/;
const ARCHITECTURE_INPUT_RE = /(^|\/)\.traffic-one\/runs\/([^/]+)\/architecture-input-v1\.json$/;
const RUN_RUNTIME_SIDECAR_RE = /^\.traffic-one\/runs\/([^/]+)\/(.+)$/;
const RUN_DIGEST_ARTIFACT_RE =
  /^\.traffic-one\/digests\/([^/]+)\/(?:senior-)?(architect|frontend|backend|reviewer|tester|shipper)\.md$/;
const QA_REPORT_ARTIFACT_RE = /^\.traffic-one\/reports\/qa\/([^/]+)\/report-v2\.json$/;
const ARCHITECT_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/architect\.md$/;
const FRONTEND_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-)?frontend\.md$/;
const IMPLEMENTER_DIGEST_RE =
  /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-)?(frontend|backend)\.md$/;
const REVIEWER_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-)?reviewer\.md$/;
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

// One summary format for every structural deny. Reporting only `id:file`
// withheld the message and line — the full-scan denies became unactionable
// (observed 1co: STRUCT_ROUTE_MODULE_MISMATCH pointed at the page module with
// no line and no cause, and the agent improvised until the run died).
function structureFindingSummary(findings: readonly StructureFinding[]): string {
  return findings
    .map((finding) => `${finding.id} (${finding.file}${finding.line ? `:${finding.line}` : ''}): ${finding.message}`)
    .join(' | ');
}

interface CollapseScanResult {
  file: string | null;
  incomplete: boolean;
  scanned: number;
}

function collapsedProductSourceFile(projectRoot: string, state: Rec): CollapseScanResult {
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
// surface as a violation instead of a silent pass.
function parseJsonc(text: string): unknown | null {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) { out += next; i += 1; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue; }
    out += ch;
  }
  try {
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

// { parsed: null } distinguishes "present but unparseable" (a violation) from
// "absent" (null — another gate's concern).
function jsoncFile(projectRoot: string, relPath: string): { parsed: Rec | null } | null {
  const raw = readTrimmed(projectRoot, relPath);
  if (raw === null || raw === '') return null;
  return { parsed: obj(parseJsonc(raw)) };
}

const EMIT_BUILD_SCRIPT_RE = /\btsc\s+(?:-b\b|--build\b)/;

function emitConfigProblems(projectRoot: string, profile: CapabilityProfileV1): string[] {
  const webRoot = webPackageRoot(profile);
  const at = (rel: string): string => (webRoot === '.' ? rel : `${webRoot}/${rel}`);
  const tsconfigRel = at('tsconfig.json');
  const tsconfig = jsoncFile(projectRoot, tsconfigRel);
  if (!tsconfig) return [];
  const problems: string[] = [];
  if (!tsconfig.parsed) {
    problems.push(`\`${tsconfigRel}\` could not be parsed as JSON/JSONC`);
  } else {
    const compiler = obj(tsconfig.parsed.compilerOptions) || {};
    if (compiler.composite === true) {
      problems.push(`\`${tsconfigRel}\` sets \`"composite": true\` (build mode forces declaration emit)`);
    }
    if (compiler.noEmit === false) {
      problems.push(`\`${tsconfigRel}\` sets \`"noEmit": false\``);
    } else if (compiler.noEmit !== true) {
      const base = jsoncFile(projectRoot, 'tsconfig.base.json');
      const baseCompiler = base?.parsed ? obj(base.parsed.compilerOptions) || {} : {};
      if (baseCompiler.noEmit !== true) {
        problems.push(`neither \`${tsconfigRel}\` nor \`tsconfig.base.json\` sets \`"noEmit": true\``);
      }
    }
  }
  const pkg = jsoncFile(projectRoot, at('package.json'));
  const scripts = pkg?.parsed ? obj(pkg.parsed.scripts) || {} : {};
  for (const name of ['build', 'typecheck'] as const) {
    const script = scripts[name];
    if (typeof script === 'string' && EMIT_BUILD_SCRIPT_RE.test(script)) {
      problems.push(`\`${at('package.json')}\` "${name}" script runs \`tsc -b\` (build mode EMITS next to sources)`);
    }
  }
  return problems;
}

// quality-tooling parity: only emit a script/config whose tool is actually
// declared. Not "prettier is mandatory" — the check fires only when a prettier
// config or format script EXISTS without the dependency (the v1.0.20 refactor
// deliberately removed any architect-side formatter requirement).
const PRETTIER_CONFIG_FILES = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml',
  '.prettierrc.yml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs',
  '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs',
  'prettier.config.mjs', 'prettier.config.ts',
];

type FormatParityProblem =
  | { kind: 'missing-dependency'; reference: string }
  | { kind: 'missing-toolchain' }
  | { kind: 'uncovered-outputs'; script: string; command: string; uncovered: string[] };

// A format script proves nothing about files its own arguments exclude.
// Observed 6co: `"lint": "prettier --check \"apps/web/src/**/*.{ts,tsx}\"
// \"packages/{i18n,tailwind-config,ui}/**/*.{ts,css,json}\" && pnpm typecheck"`
// passed while a plain `prettier --check .` failed on 25 owned source files —
// all four `packages/api-client` modules, every test, and `vitest.config.ts`.
// Presence of a formatter was verified; coverage never was.
const FORMATTABLE_OUTPUT_RE = /\.(?:[cm]?[jt]sx?|css|scss|less|json|jsonc|md|mdx|ya?ml|html|vue|svelte|astro|graphql|gql)$/i;

// `a/{b,c}/*.{ts,tsx}` → every concrete pattern. Bounded so a pathological
// script can never blow up the gate.
function expandBraces(pattern: string, budget = 64): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === '{') depth += 1;
    else if (pattern[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const choice of pattern.slice(open + 1, close).split(',')) {
    for (const expanded of expandBraces(`${head}${choice.trim()}${tail}`, budget)) {
      if (out.length >= budget) return out;
      out.push(expanded);
    }
  }
  return out;
}

// The path arguments a `prettier --check`/`--write` invocation actually reads.
// Null when the script does not run prettier at all (another formatter, or a
// composite script whose prettier segment is absent).
function prettierCheckTargets(script: string): { command: string; targets: string[] } | null {
  for (const segment of script.split(/&&|\|\||;/)) {
    const command = segment.trim();
    if (!/(?:^|[\s/])prettier\b/.test(command)) continue;
    const targets: string[] = [];
    // Quoted args keep their globs intact; bare args are shell-split.
    const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    for (const raw of tokens.slice(1)) {
      const token = raw.replace(/^["']|["']$/g, '');
      if (!token || token.startsWith('-')) continue;
      if (/(?:^|\/)prettier$/.test(token)) continue;
      targets.push(normalizeRelPath(token));
    }
    if (targets.length > 0) return { command, targets };
  }
  return null;
}

function coversPath(targets: readonly string[], relPath: string): boolean {
  return targets.some((target) => {
    if (target === '.' || target === './' || target === '**' || target === '**/*') return true;
    return expandBraces(target).some((pattern) => matchesPattern(relPath, pattern));
  });
}

interface FormatToolchainTarget {
  configPath: string;
  manifestPath: string;
  toolingRoot: string;
}

function compiledFormatToolchainForRole(
  architecture: CompiledArchitectureV1,
  ownerRole: string,
): FormatToolchainTarget | null {
  const config = (architecture.scaffoldOutputs || []).find((output) => (
    output.ownerRole === ownerRole
    && path.posix.basename(output.path) === '.prettierrc'
  ));
  if (!config) return null;
  const toolingRoot = path.posix.dirname(config.path);
  return {
    configPath: config.path,
    manifestPath: toolingRoot === '.' ? 'package.json' : `${toolingRoot}/package.json`,
    toolingRoot,
  };
}

function formatParityViolation(
  projectRoot: string,
  target: FormatToolchainTarget,
  ownedOutputs: readonly string[] = [],
): FormatParityProblem | null {
  const at = (rel: string): string => (
    target.toolingRoot === '.' ? rel : `${target.toolingRoot}/${rel}`
  );
  const pkg = jsoncFile(projectRoot, target.manifestPath)?.parsed || null;
  let reference: string | null = null;
  for (const rel of PRETTIER_CONFIG_FILES) {
    if (exists(projectRoot, at(rel))) { reference = `\`${at(rel)}\``; break; }
  }
  if (!reference && pkg && 'prettier' in pkg) {
    reference = `the \`${target.manifestPath}\` "prettier" key`;
  }
  if (!reference) {
    const scripts = pkg ? obj(pkg.scripts) || {} : {};
    const script = ['format', 'format:check'].find((name) => typeof scripts[name] === 'string');
    if (script) reference = `the \`${target.manifestPath}\` "${script}" script`;
  }
  if (!reference) {
    // NOTHING prettier-shaped exists. On a new-project scaffold that includes
    // `.prettierrc` in the compiled scope this means the frontend skipped the
    // formatter toolchain entirely — the collapse-gate remedy ("run the format
    // script") is then impossible and collapsed one-liner code ships unchecked
    // (observed 3co: 9+ files with 500+ char lines, no config, no scripts, no
    // dependency). An alternative formatter (biome) counts as a toolchain.
    const biome = ['biome.json', 'biome.jsonc'].some((rel) => exists(projectRoot, at(rel)));
    return biome ? null : { kind: 'missing-toolchain' };
  }
  const deps = { ...(pkg ? obj(pkg.dependencies) : null), ...(pkg ? obj(pkg.devDependencies) : null) };
  if (typeof deps.prettier !== 'string') return { kind: 'missing-dependency', reference };

  // The toolchain is real; now prove it reads what this role wrote. Only the
  // scripts an implementer is told to run are inspected — a hand-typed
  // `prettier --check .` is always the passing shape.
  const scripts = pkg ? obj(pkg.scripts) || {} : {};
  for (const name of ['format:check', 'format', 'lint']) {
    const script = typeof scripts[name] === 'string' ? String(scripts[name]) : '';
    const invocation = script ? prettierCheckTargets(script) : null;
    if (!invocation) continue;
    const formattable = ownedOutputs.filter((output) => FORMATTABLE_OUTPUT_RE.test(output));
    const uncovered = formattable.filter((output) => !coversPath(invocation.targets, output));
    if (uncovered.length > 0) {
      return {
        kind: 'uncovered-outputs',
        script: name,
        command: invocation.command,
        uncovered: uncovered.slice(0, 5),
      };
    }
    // The first prettier-bearing script decides; later ones are aliases of it.
    break;
  }
  return null;
}

// Typecheck twin of the format-parity pair above. A role that owns compiled
// TypeScript outputs but has NO reachable compiler cannot verify its own
// `IMPLEMENTED`: observed 5co-codex, the backend wrote "tsc is not installed"
// in its accepted digest and the 7 strict-TS errors in its repository surfaced
// two fix cycles later in the sibling frontend's build (which also fabricated
// an ambient module shim to compile around the unresolvable package).
const TS_SOURCE_OUTPUT_RE = /\.(?:ts|tsx|mts|cts)$/;

// Every path the contract compiles, optionally narrowed to one role's share.
function compiledOutputPaths(
  architecture: CompiledArchitectureV1,
  ownerRole?: string,
): string[] {
  return [
    ...(architecture.scaffoldOutputs || [])
      .filter((output) => !ownerRole || output.ownerRole === ownerRole)
      .map((output) => output.path),
    ...(architecture.modules || [])
      .filter((module) => !ownerRole || module.ownerRole === ownerRole)
      .map((module) => module.output),
  ];
}

function roleOwnedTsOutputs(
  architecture: CompiledArchitectureV1,
  ownerRole: string,
): string[] {
  return compiledOutputPaths(architecture, ownerRole)
    .filter((output) => TS_SOURCE_OUTPUT_RE.test(output) && !output.endsWith('.d.ts'));
}

// A root `typecheck` that only fans out to workspace members (`turbo run
// typecheck`, `pnpm -r typecheck`, `nx run-many`) proves nothing about a member
// that has no such script: the runner finds no target and exits 0.
const DELEGATING_RUNNER_RE = /(?:^|[\s;&|])(?:turbo|nx|lerna)\s|(?:pnpm|yarn|npm)\s+(?:run\s+)?(?:-r|--recursive|--workspaces|-ws)\b|\s--filter\b/;

type TypecheckCoverage = 'none' | 'delegated' | 'direct';

function manifestTypecheckCoverage(pkg: Rec | null): TypecheckCoverage {
  if (!pkg) return 'none';
  const scripts = obj(pkg.scripts) || {};
  const script = typeof scripts.typecheck === 'string' ? scripts.typecheck.trim() : '';
  if (script) return DELEGATING_RUNNER_RE.test(script) ? 'delegated' : 'direct';
  const deps = { ...obj(pkg.dependencies), ...obj(pkg.devDependencies) };
  return typeof deps.typescript === 'string' ? 'direct' : 'none';
}

// Null when EVERY workspace member that owns TS outputs is actually governed by
// a compiler — its own manifest, or a root manifest that compiles directly
// rather than fanning out. The previous form returned clean as soon as ANY
// manifest in the candidate set qualified, and `package.json` was always seeded
// into that set: observed 6co, the root declared `"typecheck": "turbo run
// typecheck"` while `packages/api-client` had `scripts: {}`, so the gate passed
// and the backend shipped `IMPLEMENTED` whose own digest said `pnpm exec tsc
// --version` reported tsc not found.
function typecheckParityViolation(
  projectRoot: string,
  tsOutputs: readonly string[],
): { manifests: string[] } | null {
  const owners = new Set<string>();
  let rootOwned = false;
  for (const output of tsOutputs) {
    const pkg = /^((?:apps|packages|services)\/[^/]+)\//.exec(output)?.[1];
    if (pkg) owners.add(pkg);
    else rootOwned = true;
  }
  const rootCoverage = manifestTypecheckCoverage(jsoncFile(projectRoot, 'package.json')?.parsed || null);
  const uncovered = new Set<string>();
  for (const owner of owners) {
    const manifest = `${owner}/package.json`;
    const parsed = jsoncFile(projectRoot, manifest)?.parsed || null;
    if (manifestTypecheckCoverage(parsed) !== 'none') continue;
    // A root that runs the compiler itself (`tsc -b`, project references) does
    // cover its members; a delegating runner does not.
    if (rootCoverage === 'direct') continue;
    uncovered.add(parsed ? manifest : 'package.json');
  }
  if (rootOwned && rootCoverage === 'none') uncovered.add('package.json');
  return uncovered.size > 0 ? { manifests: [...uncovered].sort() } : null;
}

// rules/common/seo.md already says "never invent a deploy URL", and 6co invented
// one anyway: every `<loc>` in the shipped `apps/web/public/sitemap.xml` reads
// `https://workshop.example/…`. The reviewer caught it; the frontend completion
// gate did not. A crawl asset is the one place a fabricated origin is
// unambiguous — reserved/placeholder hosts and loopback can never be a
// production site, and a relative `<loc>` is invalid per the sitemap spec. A
// real-looking-but-unverified domain is NOT decidable here and stays a reviewer
// concern; this gate only rejects what is provably wrong.
const CRAWL_ORIGIN_FILE_RE = /(?:^|\/)public\/(?:sitemap\.xml|robots\.txt)$/;
const RESERVED_ORIGIN_HOST_RE = /(?:^|\.)(?:example|test|invalid|local|localhost)$/i;
const PLACEHOLDER_ORIGIN_RE = /(?:your[-_.]?(?:domain|site|app)|changeme|change-me|placeholder|example\.(?:com|org|net)|mysite|my-site)/i;
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i;

function fabricatedOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname;
  return LOOPBACK_HOST_RE.test(host)
    || RESERVED_ORIGIN_HOST_RE.test(host)
    || PLACEHOLDER_ORIGIN_RE.test(host)
    ? parsed.origin
    : null;
}

function crawlOriginProblem(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
  ownerRole: string,
): { file: string; detail: string } | null {
  const assets = (architecture.scaffoldOutputs || [])
    .filter((output) => output.ownerRole === ownerRole && CRAWL_ORIGIN_FILE_RE.test(output.path))
    .map((output) => output.path);
  for (const asset of assets) {
    const raw = readTrimmed(projectRoot, asset);
    if (!raw) continue;
    if (asset.endsWith('sitemap.xml')) {
      const locations = [...raw.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]!);
      for (const location of locations) {
        const origin = fabricatedOrigin(location);
        if (origin) return { file: asset, detail: `\`${origin}\` is not a real production origin` };
        if (!/^https?:\/\//i.test(location)) {
          return { file: asset, detail: `\`${location}\` is relative, and sitemap \`<loc>\` must be an absolute URL` };
        }
      }
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const declared = /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1];
      if (!declared) continue;
      const origin = fabricatedOrigin(declared);
      if (origin) return { file: asset, detail: `\`${origin}\` is not a real production origin` };
      if (!/^https?:\/\//i.test(declared)) {
        return { file: asset, detail: `\`${declared}\` is relative, and the \`Sitemap:\` directive must be an absolute URL` };
      }
    }
  }
  return null;
}

// Third parity twin: the tester OWNS `vitest.config.ts`/`playwright.config.ts`
// but never the manifest that would carry their dependencies and scripts, so a
// run can hand it configs for runners that are not installed. Observed 6co: the
// first tester had no Vitest, Playwright, Lighthouse, or `test`/`test:e2e`
// script at all and had to negotiate with the manifest owner mid-run; the
// `playwright.config.ts` it finally wrote is `defineConfig({ testDir:
// './tests/e2e' })` — no `baseURL`, no `webServer` — so `test:e2e` still cannot
// run. Ownership must stay single, so accountability lands on whoever owns the
// governing manifest: it must ship the runner before claiming `IMPLEMENTED`.
const TEST_RUNNER_REQUIREMENTS: Array<{
  config: RegExp;
  dependency: string;
  script: string;
  label: string;
}> = [
  { config: /(?:^|\/)vitest\.config\.[cm]?[jt]s$/, dependency: 'vitest', script: 'test', label: 'Vitest' },
  { config: /(?:^|\/)playwright\.config\.[cm]?[jt]s$/, dependency: '@playwright/test', script: 'test:e2e', label: 'Playwright' },
];

function testToolchainGaps(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
  ownerRole: string,
): { manifest: string; missing: string[] } | null {
  const infra = (architecture.scaffoldOutputs || []).filter((output) => output.kind === 'test-infra');
  if (infra.length === 0) return null;
  // One governing manifest per config; only the role that owns it is answerable.
  const manifestFor = (outputPath: string): string => {
    const pkg = /^((?:apps|packages|services)\/[^/]+)\//.exec(outputPath)?.[1];
    return pkg ? `${pkg}/package.json` : 'package.json';
  };
  const manifestPath = manifestFor(infra[0]!.path);
  const manifestOwner = (architecture.scaffoldOutputs || [])
    .find((output) => output.path === manifestPath)?.ownerRole;
  if (manifestOwner !== ownerRole) return null;
  const pkg = jsoncFile(projectRoot, manifestPath)?.parsed || null;
  const deps = { ...(pkg ? obj(pkg.dependencies) : null), ...(pkg ? obj(pkg.devDependencies) : null) };
  const scripts = pkg ? obj(pkg.scripts) || {} : {};
  const missing: string[] = [];
  for (const requirement of TEST_RUNNER_REQUIREMENTS) {
    if (!infra.some((output) => requirement.config.test(output.path))) continue;
    if (typeof deps[requirement.dependency] !== 'string') {
      missing.push(`\`${requirement.dependency}\` dependency (${requirement.label})`);
    }
    if (typeof scripts[requirement.script] !== 'string') {
      missing.push(`\`${requirement.script}\` script (${requirement.label})`);
    }
  }
  return missing.length > 0 ? { manifest: manifestPath, missing } : null;
}

// The toolchain gates above prove a compiler/formatter is REACHABLE. They cannot
// prove it was RUN — and an implementer that says so in its own digest has
// already published the evidence: observed 6co, `backend.md` read "TypeScript
// execution was skipped because dependencies are not installed … `pnpm exec tsc
// --version` reported `tsc` not found" directly above `verdict: IMPLEMENTED`.
// Take the digest at its word rather than letting the omission surface two fix
// cycles later in a sibling role's build.
const REQUIRED_COMMAND_RE = /\b(?:tsc|typecheck|type-check|typescript|prettier|format:check|eslint|lint|build)\b/i;
const SKIPPED_COMMAND_RE = /\b(?:skipped|not run|never run|did not run|didn'?t run|could ?n[o']t (?:be )?run|cannot (?:be )?run|can'?t (?:be )?run|unable to run|not installed|not available|unavailable|not found|missing)\b/i;
// "no checks were skipped", "0 files skipped", "nothing was omitted" are reports
// of absence, not confessions.
const NEGATED_SKIP_RE = /\b(?:no|none|nothing|zero|0|not)\b(?:[^.;\n]{0,40}?)\b(?:skipped|omitted|missing|unavailable)\b/i;

function skippedVerificationLine(content: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!REQUIRED_COMMAND_RE.test(line)) continue;
    if (!SKIPPED_COMMAND_RE.test(line)) continue;
    if (NEGATED_SKIP_RE.test(line)) continue;
    return line.length > 240 ? `${line.slice(0, 240)}…` : line;
  }
  return null;
}

const ADR_OR_DOC_RE = /(^|\/)(docs|architecture|README|ADR)/i;
const ROOT_VITE_RE = /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/;
const ROOT_MONOREPO_FLAT_RE = /^tsconfig(?!\.base\.json$)(\.[a-z0-9-]+)?\.json$/;
const T1_MEMORY_DIR = '.traffic' + '-one';

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

function architectureInputErrors(content: string): string[] {
  try {
    return validateArchitectureInput(JSON.parse(content)).errors;
  } catch {
    return ['architecture input must be valid JSON'];
  }
}

function assignmentScopesForRole(
  projectRoot: string,
  runId: string,
  role: string,
): AssignedScope[] {
  const runtime = readRuntimeAssignments(projectRoot, runId);
  if (runtime) {
    return runtime.assignments
      .filter((assignment) => assignment.role === role)
      .map((assignment) => assignment.scope);
  }
  // Once a compiled v2 sidecar exists, missing/corrupt runtime assignments are
  // a hard absence. Never borrow a sibling/legacy manifest to widen the scan.
  if (readCompiledArchitecture(projectRoot, runId)) return [];
  const manifest = readRunAssignmentsResilient(projectRoot, runId);
  if (!manifest) return [];
  return manifest.assignments
    .filter((assignment) => assignment.role === role)
    .map((assignment) => assignment.scope);
}

function roleContract(
  contract: CompiledArchitectureV1,
  role: string,
): CompiledArchitectureV1 {
  const modules = contract.modules.filter((module) => module.ownerRole === role);
  const moduleOutputs = new Set(modules.map((module) => module.output));
  const entrypoints = role === 'senior-frontend' ? contract.entrypoints : [];
  return {
    ...contract,
    entrypoints,
    modules,
    routes: contract.routes.filter((route) => route.redirect || moduleOutputs.has(route.moduleOutput)),
    allowedOutputs: [...new Set([...entrypoints, ...modules.map((module) => module.output)])],
  };
}

function runFullStructureScan(
  projectRoot: string,
  runId: string,
  contract: CompiledArchitectureV1,
  role?: string,
): ReturnType<typeof analyzeProjectStructure> {
  const scopedContract = role ? roleContract(contract, role) : contract;
  const scopes = role ? assignmentScopesForRole(projectRoot, runId, role) : [];
  // Multiple same-role work units are allowed. Their union is represented as a
  // pattern list here; exact per-unit coverage was already checked at PLAN_READY.
  const allowlist = scopes.flatMap((scope) => scope.include);
  const report = analyzeProjectStructure(projectRoot, scopedContract, {
    allowlist: role && allowlist.length > 0 ? allowlist : undefined,
  });
  writeStructureReport(projectRoot, runId, report);
  return report;
}

function verificationImpactRank(value: UiImpact): number {
  return {
    none: 0,
    nonvisual: 1,
    behavioral: 2,
    visual: 3,
    'native-ui': 4,
  }[value];
}

function thresholdsWeakened(
  before: LighthouseThresholdsV1 | undefined,
  after: LighthouseThresholdsV1 | undefined,
): boolean {
  if (!before) return false;
  for (const [key, previous] of Object.entries(before)) {
    const next = after?.[key as keyof LighthouseThresholdsV1];
    if (typeof next !== 'number') return true;
    if (key.endsWith('Min') ? next < previous : next > previous) return true;
  }
  return false;
}

// True when the digest CLAIMS the given verdict token. The machine-readable
// channel is the `verdict:` line — when one exists, only its leading token
// counts. A bare body word-match remains ONLY as the fallback for digests with
// no verdict line at all (fail-closed: prose claiming IMPLEMENTED without the
// contract line still triggers the completion gates). Matching the whole body
// blocked honest failure reports: observed 5co-codex, a `verdict: BLOCKED …`
// digest was denied by the IMPLEMENTED completion gates because its blocker
// section said "…before this role can emit `IMPLEMENTED`" — the agent got
// through only by rewording, so gates were selecting for phrasing, not truth.
function digestClaimsVerdict(content: string, token: string): boolean {
  const verdictLine = /^[ \t]*verdict:[ \t]*(.+)$/m.exec(content);
  if (verdictLine) return new RegExp(`^${token}\\b`).test(verdictLine[1]!.trim());
  return new RegExp(`\\b${token}\\b`).test(content);
}

function allImplementationRolesDelivered(
  projectRoot: string,
  runId: string,
  proposedDigestPath: string,
): boolean {
  const assignments = readRuntimeAssignments(projectRoot, runId);
  if (!assignments) return false;
  const roles = assignments.assignments
    .map((assignment) => assignment.role)
    .filter((role) => role === 'senior-frontend' || role === 'senior-backend');
  return roles.every((role) => {
    const suffix = role.replace(/^senior-/, '');
    const rel = `.traffic-one/digests/${runId}/${suffix}.md`;
    if (rel === proposedDigestPath) return true;
    try {
      return digestClaimsVerdict(fs.readFileSync(path.join(projectRoot, rel), 'utf8'), 'IMPLEMENTED');
    } catch {
      return false;
    }
  });
}

function refreshVerificationAfterImplementation(
  projectRoot: string,
  runId: string,
  state: Rec,
): { error: string | null; changed: boolean } {
  const architecture = readCompiledArchitecture(projectRoot, runId);
  if (!architecture) return { error: 'CompiledArchitectureV1 is missing or invalid', changed: false };
  try {
    const previous = readVerificationContract(projectRoot, runId);
    if (!previous) {
      return { error: 'the current VerificationContractV2 is missing or invalid', changed: false };
    }
    const currentDiff = changedPathsFromBaseline(projectRoot, architecture);
    if (!currentDiff.complete) {
      return {
        error: `STRUCT_SCAN_INCOMPLETE: ${currentDiff.reason || 'baseline diff is incomplete'}`,
        changed: false,
      };
    }
    const authorizedPaths = new Set(previous.changedPaths);
    const unauthorized = currentDiff.paths.filter((entry) => !authorizedPaths.has(entry));
    if (unauthorized.length > 0) {
      return {
        error: `changed paths outside the frozen verification/WorkUnit authority: ${unauthorized.slice(0, 20).join(', ')}`,
        changed: false,
      };
    }
    const verification = buildVerificationContract(
      projectRoot,
      runId,
      state,
      architecture,
      readVerificationPlanIntent(projectRoot),
    );
    if (!verification.scanComplete) {
      return {
        error: `STRUCT_SCAN_INCOMPLETE: ${verification.scanReason || 'baseline diff is incomplete'}`,
        changed: false,
      };
    }
    if (verificationImpactRank(verification.uiImpact) < verificationImpactRank(previous.uiImpact)
      || (previous.browserRequired && !verification.browserRequired)
      || previous.requiredScreenshotWidths.some((width) => !verification.requiredScreenshotWidths.includes(width))
      || (previous.performance.required && !verification.performance.required)
      || thresholdsWeakened(
        previous.performance.explicitThresholds,
        verification.performance.explicitThresholds,
      )
      || thresholdsWeakened(
        previous.performance.advisoryThresholds,
        verification.performance.advisoryThresholds,
      )) {
      return {
        error: 'the refreshed plan/diff would weaken an already-published verification requirement',
        changed: false,
      };
    }
    if (verification.contractHash === previous.contractHash) {
      return { error: null, changed: false };
    }
    const assignments = buildRuntimeAssignments(architecture, verification.contractHash);
    const modelPolicy = readRunModelPolicy(projectRoot, runId);
    if (obj(state.team)?.mode === 'subagents' && !modelPolicy) {
      return { error: 'immutable model-policy.json is missing or invalid', changed: false };
    }
    if (modelPolicy && !canPublishRunPolicyBootstraps(
      projectRoot,
      modelPolicy,
      state,
      { architecture, verification, assignments },
    )) {
      return {
        error: 'refreshed role/rule/skill materials or WorkUnitContract preflight failed',
        changed: false,
      };
    }
    publishVerificationContract(projectRoot, verification);
    publishRuntimeAssignments(projectRoot, architecture, verification.contractHash);
    if (modelPolicy && !ensureRunPolicyBootstraps(projectRoot, modelPolicy, state)) {
      return {
        error: 'refreshed bootstrap publication failed after a successful preflight',
        changed: true,
      };
    }
    return { error: null, changed: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      changed: false,
    };
  }
}

function missingArchitectureContract(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return ['.traffic-one/runs/<runId>/architecture-input-v1.json (currentRunId missing)'];
  const inputRel = `.traffic-one/runs/${runId}/architecture-input-v1.json`;
  if (!exists(projectRoot, inputRel)) return [inputRel];
  const compiledRel = `.traffic-one/runs/${runId}/architecture-v1.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readCompiledArchitecture(projectRoot, runId)) return [compiledRel];
  const verificationRel = `.traffic-one/runs/${runId}/verification-v2.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readVerificationContract(projectRoot, runId)) return [verificationRel];
  const assignmentsRel = `.traffic-one/runs/${runId}/assignments.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readRuntimeAssignments(projectRoot, runId)) {
    return [`${assignmentsRel} (runtime-owned hash-valid manifest required)`];
  }
  return [];
}

function missingAssignmentsManifest(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return ['.traffic-one/runs/<runId>/assignments.json (currentRunId missing)'];
  const relPath = `.traffic-one/runs/${runId}/assignments.json`;
  if (!readRuntimeAssignments(projectRoot, runId)) {
    return [`${relPath} (runtime-owned hash-valid manifest required)`];
  }
  return [];
}

function missingArchitectDigest(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  if (architectPlanReadyOnDisk(projectRoot, state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '<runId>';
  return [`.traffic-one/digests/${runId}/architect.md (must contain PLAN_READY)`];
}

export function architectPhaseIncompleteReasons(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  return [
    ...(state.mode === 'new-project' ? missingProjectMemoryBaseline(projectRoot, state) : []),
    ...missingArchitectureContract(projectRoot, state),
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
    return digestClaimsVerdict(fs.readFileSync(path.join(projectRoot, T1_MEMORY_DIR, 'digests', runId, 'architect.md'), 'utf8'), 'PLAN_READY');
  } catch {
    return false;
  }
}

function assignmentWriterRole(projectRoot: string, state: Rec, rawData: unknown, host?: string): string | null {
  const ctx = rawData ? resolveRunAgentContext(projectRoot, state, rawData, { claimPending: true, host }) : null;
  return (ctx && typeof ctx.role === 'string' ? ctx.role : null) || activeAgentRole(state);
}

const ARCHITECT_MEMORY_RE =
  /^\.traffic-one\/(?:plan|product|stack|coding|security|known-issues|deployment|environment-setup|agent-log|api|database)\.md$/;

// ADRs live in `.traffic-one/decisions/` under whatever name the record needs —
// `project-memory` prose hands the architect that directory (README + ADR files)
// and `senior-engineer-team` lists `decisions/*` among the memory it owns, while
// this gate used to accept exactly ONE filename nothing documented. Observed
// 1cu-cursor: `decisions/README.md` and `decisions/0001-<slug>.md` were denied
// three times and the architect gave up on recording the ADR at all — for a
// non-default stack, `missingPlanArtifacts` then REQUIRES a file the architect
// was never allowed to write.
//
// The run-exactness this replaces still holds where it matters: `decisions/` is
// APPEND-ONLY across runs (project-memory: "never rewrite prior decisions
// silently"), so an ADR that already exists may be overwritten only under this
// run's own prefix. Markdown, one level deep, no traversal.
const ARCHITECT_DECISION_RE = /^\.traffic-one\/decisions\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function architectMayWriteDecision(projectRoot: string, filePath: string, runId: string): boolean {
  if (!ARCHITECT_DECISION_RE.test(filePath) || filePath.includes('..')) return false;
  const name = filePath.slice('.traffic-one/decisions/'.length);
  if (name === 'README.md') return true;
  if (runId && (name === `${runId}-architecture.md` || name.startsWith(`${runId}-`))) return true;
  // A brand-new ADR is a new decision; an existing one belongs to whoever
  // recorded it. Unreadable project root → treat as existing (fail closed).
  try {
    return !fs.existsSync(path.join(projectRoot, filePath));
  } catch {
    return false;
  }
}

function architectMayWrite(projectRoot: string, filePath: string, runId: string): boolean {
  if (ARCHITECT_MEMORY_RE.test(filePath)
    || filePath === '.traffic-one/.agentignore'
    || filePath === '.traffic-one/schema.sql') return true;
  if (architectMayWriteDecision(projectRoot, filePath, runId)) return true;
  if (!runId) return false;
  return filePath === `.traffic-one/runs/${runId}/architecture-input-v1.json`
    || filePath === `.traffic-one/digests/${runId}/architect.md`;
}

function requiresRunContracts(state: Rec): boolean {
  if (state.mode === 'new-project') return true;
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  return Boolean(runId && obj(state.team)?.mode === 'subagents');
}

function runtimeOwnedRunSidecar(filePath: string): boolean {
  const matched = RUN_RUNTIME_SIDECAR_RE.exec(filePath);
  return Boolean(matched && matched[2] !== 'architecture-input-v1.json');
}

function artifactContract(filePath: string, currentRunId: string): {
  runId: string;
  role: string;
} | null {
  const digest = RUN_DIGEST_ARTIFACT_RE.exec(filePath);
  if (digest) {
    return {
      runId: digest[1] || '',
      role: `senior-${digest[2] || ''}`,
    };
  }
  const report = QA_REPORT_ARTIFACT_RE.exec(filePath);
  if (report) return { runId: report[1] || '', role: 'senior-tester' };
  if (filePath === '.traffic-one/deployments.jsonl' && currentRunId) {
    return { runId: currentRunId, role: 'senior-shipper' };
  }
  return null;
}

function usesMainAgentTeam(state: Rec): boolean {
  return obj(state.team)?.mode === 'main-agent';
}

export interface ReadinessArgs {
  filePath: string;          // project-relative target path
  content: string;           // write content (Write.content / Edit.new_string)
  // False when the target was inferred from a shell command whose write payload
  // cannot be reconstructed (e.g. `node -e` naming the file). Content-shape
  // gates then judge the on-disk artifact instead of an empty pseudo-payload.
  contentVerified?: boolean;
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
  const contentVerified = args.contentVerified !== false;
  const violations: string[] = [];
  const currentHost = canonicalHost(host);
  const currentRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  const writerRole = assignmentWriterRole(projectRoot, state, rawData, host);

  const requiresMonorepoScaffold = stateRequiresNewProjectMonorepo(state);
  const architectureInputTarget = ARCHITECTURE_INPUT_RE.exec(filePath);

  if (ASSIGNMENTS_FILE_RE.test(filePath)) {
    violations.push(block('runtime-assignments-owner-gate',
      'Runtime contract gate: `.traffic-one/runs/<runId>/assignments.json` is generated atomically from CompiledArchitectureV1 and VerificationContractV2. Agents and the parent may not create, edit, widen, or replace it; change ArchitectureInputV1 and re-run PLAN_READY compilation instead.'));
  }

  if (runtimeOwnedRunSidecar(filePath) && !ASSIGNMENTS_FILE_RE.test(filePath)) {
    violations.push(block('runtime-sidecar-owner-gate',
      `Runtime sidecar gate: \`${filePath}\` is generated and atomically published by Traffic One runtime. Agents, children, and the parent may read it but may not create, edit, delete, widen, replace, or repair it through Write/Edit/apply_patch/shell. Change the semantic ArchitectureInputV1 or invoke the owning runtime transition instead.`,
      { TARGET: filePath }));
  }

  const childArtifact = artifactContract(filePath, currentRunId);
  if (obj(state.team)?.mode === 'subagents' && childArtifact) {
    const bootstrap = writerRole === childArtifact.role
      ? readActiveRunBootstrap(projectRoot, childArtifact.runId, childArtifact.role)
      : null;
    const scope = bootstrap
      ? {
          include: bootstrap.workUnit.allowlist,
          exclude: bootstrap.workUnit.allowlistExclude,
        }
      : null;
    if (childArtifact.runId !== currentRunId
      || !bootstrap
      || !bootstrap.workUnit.outputs.includes(filePath)
      || !scope
      || !matchesScope(filePath, scope)) {
      violations.push(block('run-artifact-work-unit-gate',
        `Run artifact gate: \`${filePath}\` may be written only by the parent-bound \`${childArtifact.role}\` child whose current, hash-valid WorkUnitContract names this exact output. Active role is \`${writerRole || 'unresolved'}\`; no digest, QA report, or deployment claim may self-authorize or borrow another run's bootstrap.`,
        {
          TARGET: filePath,
          ROLE: writerRole || 'unresolved',
          EXPECTED_ROLE: childArtifact.role,
        }));
    }
  }

  if (writerRole === 'senior-architect'
    && filePath
    && !ASSIGNMENTS_FILE_RE.test(filePath)
    && !architectMayWrite(projectRoot, filePath, currentRunId)) {
    violations.push(block('architect-planning-allowlist-gate',
      `Architect scope gate: \`senior-architect\` may write only the semantic plan/project-memory files, NEW ADRs under \`.traffic-one/decisions/<name>.md\` (existing ones are append-only across runs — use the \`${currentRunId || '<runId>'}-\` prefix to rewrite your own), \`.traffic-one/runs/${currentRunId || '<runId>'}/architecture-input-v1.json\`, and its architect digest. \`${filePath}\` is runtime- or implementer-owned. Do not scaffold packages, workspace/config/source files, barrels, Tailwind assets, tests, or assignments; emit semantic ArchitectureInputV1 and let runtime compile the work units.`,
      { TARGET: filePath }));
  }

  if (architectureInputTarget) {
    if (writerRole && writerRole !== 'senior-architect') {
      violations.push(block('architecture-input-owner-gate',
        `Architecture input gate: only the parent-bound \`senior-architect\` planning role may write ArchitectureInputV1; active role is \`${writerRole}\`.`,
        { ROLE: writerRole }));
    }
    if (contentVerified) {
      const errors = architectureInputErrors(content);
      if (errors.length > 0) {
        violations.push(block('architecture-input-gate',
          `Architecture input gate: ArchitectureInputV1 may contain only semantic routes, modules, and narrow exception requests. Runtime owns profiles, roots, roles, limits, output paths, and the baseline. Fix: ${errors.join('; ')}.`,
          { ERRORS: errors.join('; ') }));
      }
    } else {
      // Shell-inferred target: the payload is not reconstructable, so judge the
      // artifact already on disk. A valid on-disk file means this is almost
      // certainly a read/diagnostic (observed 3co: the architect running the
      // plugin's own validateArchitectureInput via `node -e` was denied with a
      // message blaming a file that was valid the whole time). Only a missing
      // or invalid on-disk artifact keeps the deny — and says what is actually
      // wrong instead of accusing the file when the COMMAND is the unknown.
      const diskErrors = ((): string[] => {
        try {
          return architectureInputErrors(
            fs.readFileSync(path.join(projectRoot, filePath), 'utf8'),
          );
        } catch {
          return ['architecture input file does not exist on disk yet'];
        }
      })();
      if (diskErrors.length > 0) {
        violations.push(block('architecture-input-shell-unverified',
          `Architecture input gate: this shell command references \`${filePath}\` but its write payload cannot be reconstructed for validation, and the current on-disk file is not valid ArchitectureInputV1 (${diskErrors.join('; ')}). Read-only checks pass once the on-disk file is valid; to (re)write it, use the role-scoped Write/Edit tools with the complete semantic JSON instead of shell eval.`,
          { TARGET: filePath, ERRORS: diskErrors.join('; ') }));
      }
    }
  }

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

  // Hot structural path: analyze only the touched file against the immutable
  // compiled contract and current work-unit allowlist. Numeric limits remain
  // warnings; robust responsibility/route/assignment findings deny immediately.
  if (writingFeatureSource && /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|php)$/i.test(filePath)) {
    const profile = capabilityProfileForRun(projectRoot, state);
    if (profileHasWebUi(profile)) {
      invalidateStructureCache(path.join(projectRoot, filePath));
      const architecture = currentRunId
        ? readCompiledArchitecture(projectRoot, currentRunId)
        : null;
      const scopedArchitecture = architecture && writerRole
        ? roleContract(architecture, writerRole)
        : architecture;
      const scopes = architecture && writerRole
        ? assignmentScopesForRole(projectRoot, currentRunId, writerRole)
        : [];
      const allowlist = scopes.flatMap((scope) => scope.include);
      const findings = (scopedArchitecture
        ? analyzeStructureTextAgainstContract(
            filePath,
            content,
            scopedArchitecture,
            writerRole ? { allowlist } : {},
          )
        : analyzeStructureText(filePath, content, profile, []))
        .filter((finding) => finding.severity === 'error');
      if (findings.length > 0) {
        // Carry each finding's own message. Reporting only `ID (file:line)`
        // withheld the one fact that resolves the deny — which route/module is
        // wrong and what the compiled contract expects instead — so the writer
        // guessed: observed 2cu, three of four routes were correct and only the
        // catch-all failed, but the frontend read the generic prose as "routes
        // are forbidden here", reported BLOCKED twice, and burned a re-plan.
        const summary = structureFindingSummary(findings);
        violations.push(block('frontend-structure-hot-gate',
          `Structural gate: ${summary}. Entrypoints may only bootstrap the app; route pages must be separate compiled modules. Formatting the same monolith across more lines does not satisfy this gate.`,
          { FINDINGS: summary }));
      }
    }
  }

  const architectDigest = ARCHITECT_DIGEST_RE.exec(filePath);
  if (architectDigest && digestClaimsVerdict(content, 'PLAN_READY')) {
    const runId = architectDigest[2] || '';
    const missingMemory = missingProjectMemoryBaseline(projectRoot, state);
    if (missingMemory.length > 0) {
      violations.push(block('architect-memory-baseline-gate',
        `Architect completion gate: do not write \`PLAN_READY\` until the required .traffic-one project-memory baseline exists with real content. Missing or incomplete: ${missingMemory.join(', ')}. Write the missing memory files yourself (do not delegate .traffic-one/* to OpenCode), then update \`.traffic-one/digests/<runId>/architect.md\` and only then emit \`PLAN_READY\`.`,
        { MISSING: missingMemory.join(', ') }));
    }
    if (state.mode === 'new-project' && openCodeDelegationActive(state, host) && planOnDiskMissingOpenCodeBlock(projectRoot) && opencodeQueueBlocks(host)) {
      violations.push(block('architect-opencode-queue-gate',
        `Architect completion gate: OpenCode is enabled but \`.traffic-one/plan.md\` is missing at least ${OPENCODE_PLAN_MIN_UNITS} runnable machine-readable delegation units. Include \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` with 3–6 bounded units (\`- id: <stable-unit-id> | role: … | files: … | task: …\`) before emitting \`PLAN_READY\`. The orchestrator runs \`opencode_delegate_from_plan\` from that block BEFORE spawning implementers.`));
    }
    if (state.mode === 'new-project' && (currentHost === 'opencode' || currentHost === 'kilo') && planOnDiskHasOpenCodeDelegateMarker(projectRoot)) {
      violations.push(block('architect-opencode-self-delegation-gate',
        'Architect completion gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block before emitting `PLAN_READY`; implementer work runs directly on the current host.'));
    }
    const modelPolicy = readRunModelPolicy(projectRoot, runId);
    const subagentMode = obj(state.team)?.mode === 'subagents';
    if (subagentMode && !modelPolicy) {
      violations.push(block('bootstrap-publication-gate',
        'Bootstrap gate: immutable parent model-policy.json is missing or corrupt. No architecture assignments or implementation bootstrap may be published until parent preflight creates it.',
        { ERROR: 'model policy missing' }));
    }
    const inputExists = Boolean(runId) && exists(projectRoot, `.traffic-one/runs/${runId}/architecture-input-v1.json`);
    if (violations.length === 0 && (state.mode === 'new-project' || inputExists)) {
      try {
        // Compile in memory only: nothing may reach disk until every
        // completion check has passed. A persisted architecture-v1.json next
        // to a DENIED digest invalidates the live architect's bootstrap
        // envelope and revokes its tools mid-flight (observed 2cl).
        const compiled = compileArchitectureForRun(projectRoot, runId, state, { persist: false });
        const verification = buildVerificationContract(
          projectRoot,
          runId,
          state,
          compiled,
          readVerificationPlanIntent(projectRoot),
        );
        if (!verification.scanComplete) {
          violations.push(block('verification-contract-scan-gate',
            `Verification contract gate: STRUCT_SCAN_INCOMPLETE (${verification.scanReason || 'unknown reason'}). Runtime could not derive the complete diff from the immutable baseline, so \`PLAN_READY\` is forbidden.`,
            { ERROR: verification.scanReason || 'scan incomplete' }));
        } else {
          const candidateAssignments = buildRuntimeAssignments(
            compiled,
            verification.contractHash,
          );
          // Full queue checks: metadata (stable ids, depends edges, parseable
          // files, unit-kind heuristics) AND the file-vs-assignment scope
          // cross-check. The compiled allowlist is born in THIS call, so the
          // scope check runs against `candidateAssignments` and its deny
          // prints the REAL in-scope file lists — the architect never has to
          // guess compiled paths (the 2cl failure mode that once forced this
          // check to be deferred). Deferring it to Step-0 delegation silently
          // wasted the whole batch instead: observed 5cl-claude, 0/3 units
          // delegable because every unit invented conventional Next paths
          // (components/course-card.tsx, …) that the compiled scope never
          // contained, and the run lost the entire OpenCode economy with no
          // signal to the architect.
          const queuePolicyErrors = openCodeDelegationActive(state, host)
            && !planOnDiskMissingOpenCodeBlock(projectRoot)
            ? planOnDiskOpenCodeQueuePolicyErrors(projectRoot, {
              assignments: candidateAssignments.assignments,
            })
            : [];
          if (queuePolicyErrors.length > 0) {
            violations.push(block('architect-opencode-queue-policy-gate',
              `Architect completion gate: OpenCode queue metadata is unsafe: ${queuePolicyErrors.join('; ')}. Fix the queue block in \`.traffic-one/plan.md\` (stable unique ids, parseable \`files:\`, explicit \`depends:\` edges for overlaps) and re-emit \`PLAN_READY\`. Scope errors above list the owning role's real compiled in-scope files — retarget each unit's \`files:\` to those exact paths, or declare the module in ArchitectureInputV1 so runtime compiles the output you need.`,
              { ERRORS: queuePolicyErrors.join('; ') }));
          } else if (modelPolicy && !canPublishRunPolicyBootstraps(
            projectRoot,
            modelPolicy,
            state,
            {
              architecture: compiled,
              verification,
              assignments: candidateAssignments,
            },
          )) {
            violations.push(block('bootstrap-publication-gate',
              'Bootstrap gate: canonical role/rule/skill materials or a candidate WorkUnitContract could not be resolved before publication. No assignments or child envelope were published; repair the parent policy/materialization and retry PLAN_READY.',
              { ERROR: 'bootstrap preflight failed' }));
          } else {
            // This atomic legacy projection MUST precede verification-v2.json.
            // If the process dies on the next instruction, runtime 1.0.19 sees
            // blocked while the current runtime recovers canonical `active`.
            const rollbackBarrier = activateRunV2RollbackBarrier(projectRoot, runId);
            if (!rollbackBarrier) {
              violations.push(block('architecture-contract-gate',
                `Architecture contract gate: the runtime could not atomically activate the V2 rollback barrier for run \`${runId}\`. No V2 verification contract or implementation bootstrap was published.`,
                { ERROR: 'V2 rollback barrier activation failed' }));
            } else {
              // Accept path: persist the compiled architecture first — the
              // verification/assignments sidecars published below reference
              // its contractHash, and ensureRunPolicyBootstraps re-reads it
              // from disk at the end of this same call.
              persistCompiledArchitecture(projectRoot, compiled);
              publishVerificationContract(projectRoot, verification);
              const assignments = publishRuntimeAssignments(
                projectRoot,
                compiled,
                verification.contractHash,
              );
              const settlement = writeRunSettlement(projectRoot, runId, {
                status: 'active',
                incompleteChecks: ['verification-not-started'],
              });
              if (!settlement) {
                violations.push(block('architecture-contract-gate',
                  `Architecture contract gate: the V2 rollback barrier is active, but the canonical run settlement could not be published for run \`${runId}\`. The run remains fail-closed and no implementer may spawn.`,
                  { ERROR: 'canonical V2 settlement publication failed' }));
              } else if (modelPolicy) {
                if (!ensureRunPolicyBootstraps(projectRoot, modelPolicy, state)) {
                  violations.push(block('bootstrap-publication-gate',
                    `Bootstrap gate: the parent could not atomically publish role/rule/skill and work-unit envelopes against architecture=${compiled.contractHash}, verification=${verification.contractHash}, and assignments=${assignments.assignmentsHash}. No implementer may spawn until the immutable envelopes are published.`,
                    { ERROR: 'bootstrap publication failed' }));
                }
              }
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(block('architecture-contract-gate',
          `Architecture contract gate: do not emit \`PLAN_READY\` until \`.traffic-one/runs/${runId || '<runId>'}/architecture-input-v1.json\` is valid and runtime compilation succeeds. ${message}. The architect may change only semantic routes/modules/exceptions; runtime owns roots, roles, outputs, baseline, and hashes.`,
          { ERROR: message }));
      }
    }
  }

  // Frontend completion gate: an `IMPLEMENTED` digest must not ship collapsed
  // product source. build/typecheck/lint all pass on a one-line-per-function
  // App.tsx, so nothing else stops it before the tester's format:check — and a
  // run interrupted before Phase 3 delivers a monolithic collapsed app with
  // empty scaffolded module dirs (observed 16c).
  const frontendDigest = FRONTEND_DIGEST_RE.exec(filePath);
  if (frontendDigest && digestClaimsVerdict(content, 'IMPLEMENTED')) {
    const collapsed = collapsedProductSourceFile(projectRoot, state);
    if (collapsed.incomplete) {
      violations.push(block('frontend-structure-scan-incomplete',
        `Frontend completion gate: STRUCT_SCAN_INCOMPLETE after ${collapsed.scanned} product source files. A truncated scan is never a pass; narrow generated/output roots or split the project contract before re-emitting \`IMPLEMENTED\`.`,
        { SCANNED: collapsed.scanned }));
    }
    if (collapsed.file) {
      violations.push(block('frontend-collapse-gate',
        `Frontend completion gate: do not write \`IMPLEMENTED\` with collapsed source. \`${collapsed.file}\` packs an entire component/route onto a single line (over ${COLLAPSE_LINE_CHARS} chars) — collapsed/minified source is a defect even when build and typecheck pass. Run the project formatter (\`format\` script), and split routes, pages, features, and shared components into their own files under the scaffolded module dirs (\`App.tsx\` is the router/shell only, not the whole app). Then re-run \`format:check\` and re-emit \`IMPLEMENTED\`.`,
        { FILE: collapsed.file }));
    }
    // Deterministic emit-config gate (new-project only; the pre-existing tsc -b
    // choices of an existing codebase are the user's, and maintenance must
    // never dead-end on them). Formatter parity is implementer-owner scoped
    // below and intentionally does not share this frontend-only branch.
    const frontendProfile = capabilityProfileForRun(projectRoot, state);
    if (state.mode === 'new-project' && frontendProfile.profileId === 'vite-react') {
      const emitProblems = emitConfigProblems(projectRoot, frontendProfile);
      if (emitProblems.length > 0) {
        const problems = emitProblems.join('; ');
        violations.push(block('frontend-emit-config-gate',
          `Frontend completion gate: ${problems}. The stock Vite template emits compiled \`.js\`/\`.d.ts\` next to every source on the first build, and the stale output can shadow the module at import time. Fix exactly this: set \`"noEmit": true\` in the app tsconfig, remove \`"composite": true\`, and use \`"build": "tsc --noEmit && vite build"\`, \`"typecheck": "tsc --noEmit"\`. Then re-emit \`IMPLEMENTED\`.`,
          { PROBLEMS: problems }));
      }
    }
    const runId = frontendDigest[2] || '';
    const architecture = runId ? readCompiledArchitecture(projectRoot, runId) : null;
    if (architecture) {
      if (!readRuntimeAssignments(projectRoot, runId)) {
        violations.push(block('frontend-structure-completion-gate',
          'Frontend completion gate: STRUCT_ASSIGNMENT_ALLOWLIST_GAP — current-run assignments are missing, stale, or hash-invalid. A complete structural scan cannot prove that this worker stayed within its runtime-owned WorkUnitContract; recompile the run before writing `IMPLEMENTED`.',
          { FINDINGS: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP' }));
      } else {
        const report = runFullStructureScan(projectRoot, runId, architecture, 'senior-frontend');
        const errors = report.findings.filter((finding) => finding.severity === 'error');
        if (errors.length > 0) {
          const summary = structureFindingSummary(errors);
          violations.push(block('frontend-structure-completion-gate',
            `Frontend completion gate: runtime structure report failed (${summary}). Fix every blocking finding and re-run the complete scan before writing \`IMPLEMENTED\`. Per-component LOC, function-count, and component-count findings remain warnings during this rollout; \`STRUCT_MODULE_LOC\` blocks — split the module.`,
            { FINDINGS: summary }));
        }
      }
    }
  }

  // PLAN_READY is necessarily compiled before implementation exists. Refresh
  // the runtime-owned verification contract at the first terminal implementer
  // handoff so uiImpact, tablet risk, changed routes, and performance evidence
  // come from the real immutable-baseline diff. Candidate assignments and every
  // bootstrap are preflighted against the new hash before publication.
  const implementedDigest = IMPLEMENTER_DIGEST_RE.exec(filePath);
  if (
    implementedDigest
    && digestClaimsVerdict(content, 'IMPLEMENTED')
    && state.mode === 'new-project'
  ) {
    const runId = implementedDigest[2] || '';
    const ownerRole = `senior-${implementedDigest[3] || ''}`;
    const architecture = runId ? readCompiledArchitecture(projectRoot, runId) : null;
    const tooling = architecture
      ? compiledFormatToolchainForRole(architecture, ownerRole)
      : null;
    if (tooling) {
      // Reaching here means this role OWNS the compiled `.prettierrc`, so it is
      // accountable for the script reading the whole compiled tree — not just
      // its own share. The remedy is a one-line edit in its own manifest
      // (`prettier --check .` plus `.prettierignore`), never formatting another
      // role's files, so this cannot deadlock across roles.
      const parity = formatParityViolation(
        projectRoot,
        tooling,
        architecture ? compiledOutputPaths(architecture) : [],
      );
      if (parity?.kind === 'uncovered-outputs') {
        const sample = parity.uncovered.map((output) => `\`${output}\``).join(', ');
        violations.push(block('implementer-format-coverage-gate',
          `Implementer format coverage gate: the \`${tooling.manifestPath}\` "${parity.script}" script runs \`${parity.command}\`, whose arguments never reach compiled outputs including ${sample}. A formatter that skips owned source proves nothing — it passes while those files are unformatted. Check the whole project instead (\`prettier --check .\`) and put build output, lockfiles, and \`.traffic-one\` in \`.prettierignore\`, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            MANIFEST: tooling.manifestPath,
            SCRIPT: parity.script,
            COMMAND: parity.command,
            UNCOVERED: sample,
          }));
      } else if (parity?.kind === 'missing-dependency') {
        violations.push(block('implementer-format-parity-gate',
          `Implementer format parity gate: role \`${ownerRole}\` owns formatter config \`${tooling.configPath}\`, but \`prettier\` is not declared in \`${tooling.manifestPath}\` dependencies/devDependencies. A script or config that names an absent tool makes verification meaningless. Add \`prettier\` with the selected package manager at tooling root \`${tooling.toolingRoot}\`, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            CONFIG: tooling.configPath,
            MANIFEST: tooling.manifestPath,
            TOOLING_ROOT: tooling.toolingRoot,
          }));
      } else if (parity?.kind === 'missing-toolchain') {
        violations.push(block('implementer-format-toolchain-gate',
          `Implementer format toolchain gate: role \`${ownerRole}\` owns compiled formatter outputs at \`${tooling.toolingRoot}\`, but no Prettier config, \`format\`/\`format:check\` scripts, or \`prettier\` dependency is present. Create \`${tooling.configPath}\`, add matching scripts and the dependency to \`${tooling.manifestPath}\`, run the formatter, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            CONFIG: tooling.configPath,
            MANIFEST: tooling.manifestPath,
            TOOLING_ROOT: tooling.toolingRoot,
          }));
      }
    }
    if (architecture) {
      const tsOutputs = roleOwnedTsOutputs(architecture, ownerRole);
      const typecheckGap = tsOutputs.length > 0
        ? typecheckParityViolation(projectRoot, tsOutputs)
        : null;
      if (typecheckGap) {
        const manifestList = typecheckGap.manifests.map((manifest) => `\`${manifest}\``).join(', ');
        violations.push(block('implementer-typecheck-toolchain-gate',
          `Implementer typecheck gate: role \`${ownerRole}\` owns compiled TypeScript outputs, but no \`typescript\` dependency or \`typecheck\` script exists in ${manifestList}. \`IMPLEMENTED\` without a runnable compiler is unverifiable — the type errors surface later in a sibling role's build instead. Add \`typescript\` and a \`typecheck\` script (\`tsc --noEmit\`) to the tooling root, run it clean, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            MANIFESTS: manifestList,
          }));
      }
    }
    if (architecture) {
      const origin = crawlOriginProblem(projectRoot, architecture, ownerRole);
      if (origin) {
        violations.push(block('implementer-crawl-origin-gate',
          `Implementer crawl origin gate: \`${origin.file}\` ships an unusable production origin — ${origin.detail}. Crawl assets are published verbatim, so an invented origin is a live defect, not a placeholder. Generate these files from the public site-url env var (\`VITE_SITE_URL\` or the framework equivalent) and fail generation when it is unset; leave the deploy origin \`Unverified\` in project memory until the user supplies it. Then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            FILE: origin.file,
            DETAIL: origin.detail,
          }));
      }
      const testGaps = testToolchainGaps(projectRoot, architecture, ownerRole);
      if (testGaps) {
        const missing = testGaps.missing.join(', ');
        violations.push(block('implementer-test-toolchain-gate',
          `Implementer test toolchain gate: role \`${ownerRole}\` owns \`${testGaps.manifest}\`, and the contract compiles tester-owned runner configs there, but ${missing} is absent. The tester owns the configs and never the manifest, so it cannot install its own runner — it inherits a config for a tool that is not there and has no way to run the suite. Add the missing dependencies and scripts to \`${testGaps.manifest}\`, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            MANIFEST: testGaps.manifest,
            MISSING: missing,
          }));
      }
    }
    const skipped = skippedVerificationLine(content);
    if (skipped) {
      violations.push(block('implementer-verification-skipped-gate',
        `Implementer verification gate: this digest reports a required command as skipped or unavailable — "${skipped}" — directly alongside \`IMPLEMENTED\`. A verdict is a claim that the owned scope was verified, so an unrun build/typecheck/lint makes it unverifiable and the errors surface later in a sibling role's build. Install the toolchain at its owning manifest, run the command to completion, record the real outcome, then re-emit \`IMPLEMENTED\`. If the command genuinely does not apply, say why without claiming it was skipped.`,
        { EVIDENCE: skipped }));
    }
  }
  if (implementedDigest
    && implementedDigest[2] === currentRunId
    && digestClaimsVerdict(content, 'IMPLEMENTED')
    && violations.length === 0) {
    const runId = implementedDigest[2] || '';
    if (allImplementationRolesDelivered(projectRoot, runId, filePath)) {
      const refresh = refreshVerificationAfterImplementation(projectRoot, runId, state);
      if (refresh.error) {
        violations.push(block('verification-contract-refresh-gate',
          `Verification refresh gate: \`IMPLEMENTED\` is forbidden because runtime could not rederive and atomically republish VerificationContractV2 from the immutable baseline (${refresh.error}). No stale nonvisual/behavioral classification may reach QA; repair the semantic plan/runtime prerequisite and retry the same digest.`,
          { ERROR: refresh.error }));
      }
    }
  }

  const reviewerDigest = REVIEWER_DIGEST_RE.exec(filePath);
  if (reviewerDigest && digestClaimsVerdict(content, 'APPROVED') && !digestClaimsVerdict(content, 'CHANGES_REQUESTED')) {
    const runId = reviewerDigest[2] || '';
    const architecture = runId ? readCompiledArchitecture(projectRoot, runId) : null;
    if (architecture) {
      if (!readRuntimeAssignments(projectRoot, runId)) {
        violations.push(block('reviewer-structure-gate',
          'Reviewer gate: `APPROVED` is forbidden with STRUCT_ASSIGNMENT_ALLOWLIST_GAP. Current-run assignments are missing, stale, or hash-invalid, so the complete structural scan cannot establish WorkUnit coverage.',
          { FINDINGS: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP' }));
      } else {
        const report = runFullStructureScan(projectRoot, runId, architecture);
        const errors = report.findings.filter((finding) => finding.severity === 'error');
        if (errors.length > 0) {
          const summary = structureFindingSummary(errors);
          violations.push(block('reviewer-structure-gate',
            `Reviewer gate: \`APPROVED\` is forbidden while the complete runtime structure report contains errors (${summary}). Review the compiled architecture and request fixes.`,
            { FINDINGS: summary }));
        }
      }
    }
    if (runId === currentRunId && violations.length === 0) {
      const refresh = refreshVerificationAfterImplementation(projectRoot, runId, state);
      if (refresh.error || refresh.changed) {
        const reason = refresh.error
          || 'runtime raised VerificationContractV2 from the final implementation diff; the current review bootstrap predates that contract';
        violations.push(block('verification-contract-refresh-gate',
          `Verification refresh gate: \`APPROVED\` is forbidden because ${reason}. Re-read the newly published bootstrap/verification hash and repeat the review under the final risk contract.`,
          { ERROR: reason }));
      }
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
    const runId = testerDigest[2] || '';
    if (runId === currentRunId && violations.length === 0) {
      const refresh = refreshVerificationAfterImplementation(projectRoot, runId, state);
      if (refresh.error || refresh.changed) {
        const reason = refresh.error
          || 'runtime raised VerificationContractV2 from the final implementation diff; the current QA report/bootstrap predates that contract';
        violations.push(block('verification-contract-refresh-gate',
          `Verification refresh gate: \`TESTS_GREEN\` is forbidden because ${reason}. Re-read the newly published verification hash, regenerate risk-proportional evidence, and retry the tester verdict.`,
          { ERROR: reason }));
      }
    }
    const verification = runId ? readVerificationContract(projectRoot, runId) : null;
    if (verification) {
      const result = readQaReportV2(projectRoot, runId);
      if (!result.ok) {
        violations.push(block('tester-qa-v2-gate',
          `Tester completion gate: VerificationContractV2 rejected this verdict (${result.code}: ${result.message}). Produce fresh risk-proportional evidence for uiImpact=${verification.uiImpact}; a blocked environment is not \`TESTS_GREEN\`.`,
          { ERROR: `${result.code}: ${result.message}` }));
      }
    }
    if (!verification) {
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
  }

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && openCodeDelegationActive(state, host) && missingOpenCodeDelegateBlock(content) && opencodeQueueBlocks(host)) {
    violations.push(block('plan-opencode-queue-gate',
      `Plan gate: OpenCode is enabled — \`.traffic-one/plan.md\` must include the machine-readable \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` block with at least ${OPENCODE_PLAN_MIN_UNITS} runnable bounded units (\`- id: <stable-unit-id> | role: frontend|backend|tester|docs | files: … | task: …\`). Prose-only or incomplete OpenCode lists are ignored by \`opencode_delegate_from_plan\`.`));
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
  if (isNewProject && planMissing && writingFeatureSource && !writingPlan && !writingDoc
  ) {
    if (usesMainAgentTeam(state)) {
      violations.push(block('plan-main-agent-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project in Low/main-agent mode. Do NOT call `run_subagent`, `Task`, `spawn_agent`, `task`, or another subagent tool. You are the architect in this thread: write `.traffic-one/plan.md` and required `.traffic-one/` project memory before root config, workspace scaffold, or feature-source writes; then resume the same ordered phases. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    } else if (writerRole === 'senior-architect') {
      // Never tell the architect to "run the senior-architect subagent" (B8) —
      // it IS that subagent. Tell it to write the plan itself.
      violations.push(block('plan-architect-self-gate',
        'Plan gate: .traffic-one/plan.md is missing on this new project. You ARE the `senior-architect` for this run — write `.traffic-one/plan.md`, project memory, and semantic ArchitectureInputV1; do not spawn another architect and do not scaffold implementation files.'));
    } else {
      violations.push(block('plan-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    }
  }

  return violations;
}
