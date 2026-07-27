// Risk-derived verification contract. UI impact is computed from the immutable
// architecture baseline plus runtime-observed paths; an agent may only raise it.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  canonicalTrafficOneContextLink,
  contextAliasHash,
  stableContractJson,
  type ArchitectureBaselineV1,
  type CompiledArchitectureV1,
} from './architecture-contract';
import {
  capabilityProfileForProject,
  profileHasNativeUi,
  profileHasWebUi,
  type CapabilityProfileV1,
} from './capabilities';
import { readJson, writeJson } from './fsjson';
import { sha256 } from './text';

export const VERIFICATION_CONTRACT_SCHEMA_VERSION = 2 as const;
export const VERIFICATION_SCAN_MAX_FILES = 10_000;

export type UiImpact = 'none' | 'nonvisual' | 'behavioral' | 'visual' | 'native-ui';

export interface LighthouseThresholdsV1 {
  performanceMin?: number;
  accessibilityMin?: number;
  bestPracticesMin?: number;
  seoMin?: number;
  lcpMaxMs?: number;
  clsMax?: number;
  inpMaxMs?: number;
}

export interface PerformanceContractV1 {
  required: boolean;
  reason: 'not-required' | 'redesign' | 'visual-risk' | 'performance-risk' | 'explicit';
  explicitThresholds?: LighthouseThresholdsV1;
  advisoryThresholds?: LighthouseThresholdsV1;
  advisoryTolerancePercent: 3;
}

export interface VerificationContractV2 {
  schemaVersion: typeof VERIFICATION_CONTRACT_SCHEMA_VERSION;
  runId: string;
  architectureHash: string;
  baseline: ArchitectureBaselineV1;
  uiImpact: UiImpact;
  uiImpactSource: 'runtime' | 'agent-raised';
  uiImpactReason?: string;
  changedPaths: string[];
  changedRoutes: string[];
  scanComplete: boolean;
  scanReason?: string;
  requiredChecks: string[];
  browserRequired: boolean;
  nativeAdapter: string | null;
  requiredScreenshotWidths: number[];
  tabletRisk: boolean;
  buildIdentityRequired: boolean;
  performance: PerformanceContractV1;
  generatedAt: string;
  contractHash: string;
}

export interface VerificationCompileOptions {
  agentRaisedImpact?: UiImpact;
  explicitLighthouse?: LighthouseThresholdsV1;
  advisoryLighthouse?: LighthouseThresholdsV1;
  redesign?: boolean;
  performanceRisk?: boolean;
  changedPaths?: string[];
  scanComplete?: boolean;
  scanReason?: string;
}

export interface ChangedPathSnapshot {
  paths: string[];
  complete: boolean;
  reason?: string;
}

const SKIP_RE = /(^|\/)(?:\.git|\.traffic-one|node_modules|dist|build|coverage|out|\.next|\.turbo|generated|__generated__)(?:\/|$)/;
const VISUAL_RE = /\.(?:css|scss|sass|less|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i;
const MARKUP_RE = /\.(?:tsx|jsx|vue|svelte|astro|html|blade\.php)$/i;
const VISUAL_PATH_RE = /(?:^|\/)(?:styles?|theme|tokens?|assets?|layout)(?:\/|[.-])/i;
const VISUAL_CONFIG_RE = /(?:^|\/)(?:tailwind|uno|windi)\.config\.(?:[cm]?[jt]s|ts)$/i;
const NONVISUAL_RE = /(?:^|\/)(?:types?|mappers?|schemas?|data|config|constants?|utils?|lib)(?:\/|[.-])|\.d\.ts$|(?:^|\/)[^/]+\.config\.[^.]+$/i;
const BEHAVIOR_RE = /(?:^|\/)(?:routes?|router|navigation|forms?|state|stores?|features?)(?:\/|[.-])|(?:route|router|navigation|handler|controller)\.[^.]+$/i;
const TABLET_RISK_RE = /(?:tablet|breakpoint|@media|768|md:|min-width|max-width)/i;
const IMPORTANT_VISUAL_PATH_RE =
  /(?:^|\/)(?:packages\/ui|design-system|theme|tokens?|layouts?)(?:\/|[.-])|(?:^|\/)(?:globals?|app|styles?)\.(?:css|scss|sass|less)$|(?:^|\/)(?:tailwind|uno|windi)\.config\.(?:[cm]?[jt]s|ts)$/i;
const GIT_OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function normalizeRel(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

interface GitProjectContext {
  worktreeRoot: string;
  projectPrefix: string;
}

function gitProjectContext(projectRoot: string): { context?: GitProjectContext; reason?: string } {
  const absoluteProjectRoot = path.resolve(projectRoot);
  try {
    const projectStat = fs.lstatSync(absoluteProjectRoot);
    if (projectStat.isSymbolicLink()) {
      return { reason: 'Git project root is a symbolic link' };
    }
    if (!projectStat.isDirectory()) {
      return { reason: 'Git project root is not a directory' };
    }
    const worktreeOutput = execFileSync('git', [
      '-C', absoluteProjectRoot, 'rev-parse', '--show-toplevel',
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const prefixOutput = execFileSync('git', [
      '-C', absoluteProjectRoot, 'rev-parse', '--show-prefix',
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const worktreeRoot = worktreeOutput.replace(/\r?\n$/, '');
    const rawPrefix = prefixOutput.replace(/\r?\n$/, '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!worktreeRoot || /[\r\n\0]/.test(worktreeRoot) || /[\r\n\0]/.test(rawPrefix)) {
      return { reason: 'Git worktree location is ambiguous' };
    }
    const realWorktreeRoot = fs.realpathSync(worktreeRoot);
    const realProjectRoot = fs.realpathSync(absoluteProjectRoot);
    const relativeProject = path.relative(realWorktreeRoot, realProjectRoot).replace(/\\/g, '/');
    if (relativeProject === '..'
      || relativeProject.startsWith('../')
      || path.isAbsolute(relativeProject)) {
      return { reason: 'project root is outside the Git worktree' };
    }
    const projectPrefix = relativeProject.replace(/\/+$/, '');
    if ((rawPrefix && normalizeRel(rawPrefix) !== rawPrefix)
      || rawPrefix !== projectPrefix) {
      return { reason: 'Git project prefix is ambiguous' };
    }
    return { context: { worktreeRoot: realWorktreeRoot, projectPrefix } };
  } catch {
    return { reason: 'Git worktree context could not be resolved' };
  }
}

function gitPathForProjectPath(context: GitProjectContext, relPath: string): string | null {
  const normalized = normalizeRel(relPath);
  if (!normalized || normalized !== relPath || /[\r\n\0]/.test(normalized)) return null;
  return context.projectPrefix ? `${context.projectPrefix}/${normalized}` : normalized;
}

function projectPathFromGitPath(context: GitProjectContext, gitPath: string): string | null {
  const normalized = normalizeRel(gitPath);
  if (!normalized || normalized !== gitPath || /[\r\n\0]/.test(normalized)) return null;
  if (!context.projectPrefix) return normalized;
  const prefix = `${context.projectPrefix}/`;
  if (!normalized.startsWith(prefix)) return null;
  return normalizeRel(normalized.slice(prefix.length));
}

function nulDelimitedGitPaths(command: string[]): string[] {
  const output = execFileSync('git', command, {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (output.includes('\uFFFD')) throw new Error('Git path encoding is ambiguous');
  return output.split('\0').filter(Boolean);
}

function projectPathInspectionIssue(projectRoot: string, relPath: string): string | null {
  const normalized = normalizeRel(relPath);
  if (!normalized || normalized !== relPath || /[\r\n\0]/.test(normalized)) {
    return `cannot inspect invalid project path ${relPath || '<empty>'}`;
  }
  let cursor = path.resolve(projectRoot);
  for (const segment of normalized.split('/')) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // Deleted paths are valid diff entries. ENOTDIR likewise means a later
      // path segment cannot exist and will be represented as deleted.
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      return `cannot inspect project path ${normalized}`;
    }
    if (stat.isSymbolicLink()) {
      const symbolic = normalizeRel(path.relative(projectRoot, cursor)) || normalized;
      // The canonical `CLAUDE.md` → `AGENTS.md` alias is materialization's own
      // output and is identity-tracked in the immutable baseline. Failing the
      // scan closed on it meant the plugin blocked its own `PLAN_READY`.
      if (canonicalTrafficOneContextLink(projectRoot, cursor, symbolic)) continue;
      return `symbolic link makes verification scan incomplete: ${symbolic}`;
    }
  }
  return null;
}

function boundedGitPaths(projectRoot: string, baselineHash: string): ChangedPathSnapshot {
  if (!GIT_OBJECT_ID_RE.test(baselineHash)) {
    return { paths: [], complete: false, reason: 'Git baseline identity is invalid' };
  }
  const resolved = gitProjectContext(projectRoot);
  if (!resolved.context) {
    return { paths: [], complete: false, reason: resolved.reason || 'Git worktree context could not be resolved' };
  }
  const { context } = resolved;
  const projectPathspec = context.projectPrefix || '.';
  try {
    const tracked = nulDelimitedGitPaths([
      '-C', context.worktreeRoot, 'diff', '--name-only', '-z',
      '--diff-filter=ACDMRTUXB', baselineHash, '--', projectPathspec,
    ]);
    const untracked = nulDelimitedGitPaths([
      '-C', context.worktreeRoot, 'ls-files', '--others', '--exclude-standard',
      '-z', '--', projectPathspec,
    ]);
    const raw = [...tracked, ...untracked];
    if (raw.length > VERIFICATION_SCAN_MAX_FILES) {
      return { paths: [], complete: false, reason: `diff exceeds ${VERIFICATION_SCAN_MAX_FILES} files` };
    }
    const paths: string[] = [];
    for (const item of raw) {
      const normalized = projectPathFromGitPath(context, item);
      if (!normalized) {
        return {
          paths,
          complete: false,
          reason: `Git diff returned an ambiguous or outside-project path`,
        };
      }
      if (SKIP_RE.test(`/${normalized}`)) continue;
      const issue = projectPathInspectionIssue(projectRoot, normalized);
      if (issue) return { paths, complete: false, reason: issue };
      paths.push(normalized);
    }
    return { paths: unique(paths), complete: true };
  } catch {
    return { paths: [], complete: false, reason: 'git baseline diff could not be completed' };
  }
}

function walkCurrentFiles(projectRoot: string, roots: string[]): ChangedPathSnapshot {
  const files: string[] = [];
  const seen = new Set<string>();
  const stack = roots.map((root) => path.resolve(projectRoot, root));
  while (stack.length > 0) {
    const current = stack.pop()!;
    let real: string;
    try { real = fs.realpathSync(current); } catch {
      return {
        paths: files,
        complete: false,
        reason: `cannot resolve ${path.relative(projectRoot, current) || '.'}`,
      };
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch {
      return { paths: files, complete: false, reason: `cannot read ${path.relative(projectRoot, current)}` };
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const rel = normalizeRel(path.relative(projectRoot, absolute));
      if (!rel || SKIP_RE.test(`/${rel}`)) continue;
      if (entry.isSymbolicLink()) {
        // Same canonical alias exception as the immutable baseline, which keeps
        // a `symbolic-link:<target>` identity row for it (see fileHash below).
        if (canonicalTrafficOneContextLink(projectRoot, absolute, rel)) {
          if (files.length >= VERIFICATION_SCAN_MAX_FILES) {
            return { paths: files, complete: false, reason: `source scan exceeds ${VERIFICATION_SCAN_MAX_FILES} files` };
          }
          files.push(rel);
          continue;
        }
        return {
          paths: files,
          complete: false,
          reason: `symbolic link makes verification scan incomplete: ${rel}`,
        };
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      // The non-Git baseline snapshots the whole project (subject to SKIP_RE),
      // so the comparison must use the identical scope. Restricting this side
      // to source extensions or architecture roots invents deletions and misses
      // new test/config/build-input files outside those roots.
      if (!entry.isFile()) continue;
      if (files.length >= VERIFICATION_SCAN_MAX_FILES) {
        return { paths: files, complete: false, reason: `source scan exceeds ${VERIFICATION_SCAN_MAX_FILES} files` };
      }
      files.push(rel);
    }
  }
  return { paths: unique(files), complete: true };
}

function fileHash(projectRoot: string, relPath: string): string {
  const filePath = path.join(projectRoot, relPath);
  // Mirror the immutable baseline's identity row for the canonical context
  // alias — hashing the LINK TARGET's bytes here would report `CLAUDE.md` as
  // changed on every single scan.
  const aliasTarget = canonicalTrafficOneContextLink(projectRoot, filePath, relPath);
  if (aliasTarget) return contextAliasHash(aliasTarget);
  try { return sha256(fs.readFileSync(filePath).toString('base64')); } catch { return '<deleted>'; }
}

function changedPathsFromImmutableBaseline(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
): ChangedPathSnapshot {
  if (baseline.kind === 'git-head' && baseline.identity.startsWith('git:')) {
    return boundedGitPaths(projectRoot, baseline.identity.slice(4));
  }
  const current = walkCurrentFiles(projectRoot, ['.']);
  if (!current.complete) return current;
  const before = new Map((baseline.files || []).map((entry) => [entry.path, entry.hash]));
  const after = new Map(current.paths.map((file) => [file, fileHash(projectRoot, file)]));
  const changed = new Set<string>();
  for (const [file, hash] of before) {
    if (after.get(file) !== hash) changed.add(file);
  }
  for (const [file, hash] of after) {
    if (before.get(file) !== hash) changed.add(file);
  }
  return { paths: [...changed].sort(), complete: true };
}

export function changedPathsFromBaseline(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): ChangedPathSnapshot {
  return changedPathsFromImmutableBaseline(projectRoot, architecture.baseline);
}

function safeRead(projectRoot: string, relPath: string): string {
  try { return fs.readFileSync(path.join(projectRoot, relPath), 'utf8').slice(0, 512_000); } catch { return ''; }
}

interface ChangedHunkEvidence {
  available: boolean;
  before: string;
  after: string;
  changedText: string;
  reason?: string;
}

function gitTextAtBaseline(
  projectRoot: string,
  baselineHash: string,
  relPath: string,
): { exists: boolean; text: string; readable: boolean } {
  if (!GIT_OBJECT_ID_RE.test(baselineHash)) {
    return { exists: false, text: '', readable: false };
  }
  const resolved = gitProjectContext(projectRoot);
  const gitPath = resolved.context
    ? gitPathForProjectPath(resolved.context, relPath)
    : null;
  if (!resolved.context || !gitPath) {
    return { exists: false, text: '', readable: false };
  }
  try {
    const text = execFileSync('git', [
      '-C', resolved.context.worktreeRoot, 'show', `${baselineHash}:${gitPath}`,
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { exists: true, text: text.slice(0, 512_000), readable: true };
  } catch {
    try {
      execFileSync('git', [
        '-C', resolved.context.worktreeRoot, 'cat-file', '-e', `${baselineHash}:${gitPath}`,
      ], {
        timeout: 3_000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return { exists: true, text: '', readable: false };
    } catch {
      return { exists: false, text: '', readable: true };
    }
  }
}

function gitChangedText(
  projectRoot: string,
  baselineHash: string,
  relPath: string,
): string | null {
  if (!GIT_OBJECT_ID_RE.test(baselineHash)) return null;
  const resolved = gitProjectContext(projectRoot);
  const gitPath = resolved.context
    ? gitPathForProjectPath(resolved.context, relPath)
    : null;
  if (!resolved.context || !gitPath) return null;
  try {
    const diff = execFileSync('git', [
      '-C', resolved.context.worktreeRoot, 'diff', '--no-ext-diff', '--no-color', '--unified=0',
      baselineHash, '--', gitPath,
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return diff
      .split(/\r?\n/)
      .filter((line) => (
        (line.startsWith('+') && !line.startsWith('+++'))
        || (line.startsWith('-') && !line.startsWith('---'))
      ))
      .map((line) => line.slice(1))
      .join('\n')
      .slice(0, 512_000);
  } catch {
    return null;
  }
}

function changedHunkEvidence(
  projectRoot: string,
  baseline: ArchitectureBaselineV1 | undefined,
  relPath: string,
): ChangedHunkEvidence {
  const after = safeRead(projectRoot, relPath);
  if (!baseline) {
    return {
      available: false,
      before: '',
      after,
      changedText: after,
      reason: 'immutable baseline content was not provided',
    };
  }
  if (baseline.kind === 'git-head' && baseline.identity.startsWith('git:')) {
    const baselineHash = baseline.identity.slice(4);
    const before = gitTextAtBaseline(projectRoot, baselineHash, relPath);
    if (!before.readable) {
      return {
        available: false,
        before: '',
        after,
        changedText: after,
        reason: 'baseline file is not readable as text',
      };
    }
    if (!before.exists) return { available: true, before: '', after, changedText: after };
    const changedText = gitChangedText(projectRoot, baselineHash, relPath);
    if (changedText === null) {
      return {
        available: false,
        before: before.text,
        after,
        changedText: after,
        reason: 'Git changed hunks could not be read',
      };
    }
    return { available: true, before: before.text, after, changedText };
  }
  const baselineFile = (baseline.files || []).find((entry) => entry.path === relPath);
  if (!baselineFile) return { available: true, before: '', after, changedText: after };
  // Manifest baselines retain hashes, not source bodies. They can prove that a
  // TSX file changed, but cannot distinguish handler-only edits from markup.
  return {
    available: false,
    before: '',
    after,
    changedText: after,
    reason: 'file-manifest baseline has no changed-hunk bodies',
  };
}

function stripEventHandlers(tag: string): string {
  let output = '';
  for (let cursor = 0; cursor < tag.length;) {
    const event = /\bon[A-Z][A-Za-z0-9_$]*\s*=/.exec(tag.slice(cursor));
    if (!event) {
      output += tag.slice(cursor);
      break;
    }
    const start = cursor + event.index;
    output += tag.slice(cursor, start);
    let valueStart = start + event[0].length;
    while (valueStart < tag.length && /\s/.test(tag[valueStart] || '')) valueStart += 1;
    if (tag[valueStart] !== '{') {
      cursor = valueStart;
      while (cursor < tag.length && !/[\s>]/.test(tag[cursor] || '')) cursor += 1;
      continue;
    }
    let depth = 0;
    cursor = valueStart;
    for (; cursor < tag.length; cursor += 1) {
      if (tag[cursor] === '{') depth += 1;
      else if (tag[cursor] === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
  }
  return output;
}

function jsxTags(source: string): Array<{ start: number; end: number; value: string }> {
  const tags: Array<{ start: number; end: number; value: string }> = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '<' || !/(?:[A-Za-z]|\/[A-Za-z]|>|\/>)/.test(source.slice(start + 1, start + 3))) {
      continue;
    }
    let curly = 0;
    let quote: '\'' | '"' | '`' | null = null;
    let escaped = false;
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const current = source[cursor]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) quote = null;
        continue;
      }
      if (current === '\'' || current === '"' || current === '`') {
        quote = current;
        continue;
      }
      if (current === '{') curly += 1;
      else if (current === '}' && curly > 0) curly -= 1;
      else if (current === '>' && curly === 0) {
        tags.push({ start, end: cursor + 1, value: source.slice(start, cursor + 1) });
        start = cursor;
        break;
      }
    }
  }
  return tags;
}

function visualProjection(source: string): string {
  const parts: string[] = [];
  const tags = jsxTags(source);
  let depth = 0;
  let previousEnd = 0;
  for (const tag of tags) {
    if (depth > 0) {
      const childText = source.slice(previousEnd, tag.start).replace(/\s+/g, ' ').trim();
      if (childText) parts.push(`text:${childText}`);
    }
    parts.push(`tag:${stripEventHandlers(tag.value).replace(/\s+/g, ' ').trim()}`);
    const closing = /^<\//.test(tag.value);
    const selfClosing = /\/>$/.test(tag.value);
    if (closing) depth = Math.max(0, depth - 1);
    else if (!selfClosing) depth += 1;
    previousEnd = tag.end;
  }
  return parts.join('\n');
}

function changedCodeIsVisual(evidence: ChangedHunkEvidence): boolean {
  if (visualProjection(evidence.before) !== visualProjection(evidence.after)) return true;
  return /\b(?:className|style|css|theme|token|palette|color|background|font|spacing|gap|grid|flex|width|height|margin|padding|asset|icon|image|layout)\b/i
    .test(evidence.changedText);
}

function baseImpact(profile: CapabilityProfileV1): UiImpact {
  if (profile.architectureTarget === 'web-ui') return 'nonvisual';
  if (profile.architectureTarget === 'native-ui') return 'native-ui';
  if (profileHasNativeUi(profile)) return 'native-ui';
  if (!profileHasWebUi(profile)) return 'none';
  return 'nonvisual';
}

function rank(impact: UiImpact): number {
  if (impact === 'none') return 0;
  if (impact === 'nonvisual') return 1;
  if (impact === 'behavioral') return 2;
  if (impact === 'visual') return 3;
  return 4;
}

function raiseImpact(current: UiImpact, candidate: UiImpact): UiImpact {
  if (current === 'native-ui' || candidate === 'native-ui') return 'native-ui';
  return rank(candidate) > rank(current) ? candidate : current;
}

function validateAgentRaisedImpact(
  profile: CapabilityProfileV1,
  candidate: UiImpact | undefined,
): void {
  if (!candidate) return;
  const domain = baseImpact(profile);
  if (domain === 'none' && candidate !== 'none') {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a project without a UI surface`);
  }
  if (domain === 'native-ui' && candidate !== 'native-ui') {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a native-ui profile`);
  }
  if (domain === 'nonvisual' && !['none', 'nonvisual', 'behavioral', 'visual'].includes(candidate)) {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a web-ui profile`);
  }
}

function baselineContainsPath(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
  relPath: string,
): boolean {
  if (baseline.kind === 'git-head' && baseline.identity.startsWith('git:')) {
    return gitTextAtBaseline(projectRoot, baseline.identity.slice(4), relPath).exists;
  }
  return (baseline.files || []).some((entry) => entry.path === relPath);
}

function plannedUiImpactFloor(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): UiImpact {
  if (!profileHasWebUi(architecture.profile)) return baseImpact(architecture.profile);
  let floor: UiImpact = 'nonvisual';
  for (const module of architecture.modules) {
    if (baselineContainsPath(projectRoot, architecture.baseline, module.output)) continue;
    if (['app-shell', 'page', 'component'].includes(module.kind)) return 'visual';
    if (module.kind === 'feature') floor = raiseImpact(floor, 'behavioral');
  }
  for (const output of architecture.scaffoldOutputs || []) {
    if (output.ownerRole === 'senior-tester'
      || baselineContainsPath(projectRoot, architecture.baseline, output.path)) continue;
    if (VISUAL_RE.test(output.path)
      || VISUAL_PATH_RE.test(output.path)
      || MARKUP_RE.test(output.path)) return 'visual';
    if (BEHAVIOR_RE.test(output.path)) floor = raiseImpact(floor, 'behavioral');
  }
  return floor;
}

function plannedImportantVisualChange(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): boolean {
  return architecture.modules.some((module) => (
    ['app-shell', 'page'].includes(module.kind)
    && !baselineContainsPath(projectRoot, architecture.baseline, module.output)
  )) || (architecture.scaffoldOutputs || []).some((output) => (
    output.ownerRole !== 'senior-tester'
    && IMPORTANT_VISUAL_PATH_RE.test(output.path)
    && !baselineContainsPath(projectRoot, architecture.baseline, output.path)
  ));
}

export function deriveUiImpact(
  projectRoot: string,
  profile: CapabilityProfileV1,
  changedPaths: readonly string[],
  baseline?: ArchitectureBaselineV1,
): { impact: UiImpact; tabletRisk: boolean; reason?: string } {
  let impact = baseImpact(profile);
  let tabletRisk = false;
  const fallbackReasons: string[] = [];
  if (impact === 'none' || impact === 'native-ui') return { impact, tabletRisk };
  for (const file of changedPaths) {
    const normalized = normalizeRel(file);
    if (!normalized) continue;
    const content = safeRead(projectRoot, normalized);
    let changedContent = content;
    if (VISUAL_RE.test(normalized) || VISUAL_PATH_RE.test(normalized) || VISUAL_CONFIG_RE.test(normalized)) {
      impact = raiseImpact(impact, 'visual');
    } else if (MARKUP_RE.test(normalized)) {
      const evidence = changedHunkEvidence(projectRoot, baseline, normalized);
      changedContent = evidence.changedText;
      if (!evidence.available) {
        impact = raiseImpact(impact, 'visual');
        fallbackReasons.push(`${normalized}: ${evidence.reason || 'changed-hunk evidence unavailable'}`);
      } else if (changedCodeIsVisual(evidence)) {
        impact = raiseImpact(impact, 'visual');
      } else if (evidence.changedText.trim()) {
        impact = raiseImpact(impact, 'behavioral');
      }
    } else if (BEHAVIOR_RE.test(normalized) || /\b(?:onClick|onSubmit|navigate|router|hydrateRoot|createBrowserRouter)\b/.test(content)) {
      impact = raiseImpact(impact, 'behavioral');
    } else if (NONVISUAL_RE.test(normalized)) {
      impact = raiseImpact(impact, 'nonvisual');
    } else if (/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(normalized)) {
      impact = raiseImpact(impact, 'behavioral');
    }
    if (TABLET_RISK_RE.test(changedContent) || /(?:^|[-_.])tablet(?:[-_.]|$)/i.test(normalized)) tabletRisk = true;
  }
  return {
    impact,
    tabletRisk,
    ...(fallbackReasons.length > 0
      ? { reason: `Conservative visual classification because diff evidence was unavailable (${fallbackReasons.join('; ')}).` }
      : {}),
  };
}

function changedRoutes(
  architecture: CompiledArchitectureV1,
  paths: readonly string[],
  impact: UiImpact,
): string[] {
  const changed = new Set(paths);
  const globalVisualChange = impact === 'visual' && paths.some((file) => (
    VISUAL_RE.test(file)
    || VISUAL_CONFIG_RE.test(file)
    || /(?:^|\/)(?:styles?|theme|tokens?|assets?|layouts?|components?|packages\/ui)(?:\/|[.-])/i.test(file)
  ));
  if (globalVisualChange) {
    const allRoutes = architecture.routes
      .filter((route) => !route.redirect)
      .map((route) => route.path);
    if (allRoutes.length > 0) return unique(allRoutes);
  }
  const routes = architecture.routes
    .filter((route) => route.redirect || changed.has(route.moduleOutput))
    .map((route) => route.path);
  if (routes.length > 0) return unique(routes);
  return architecture.profile.surfaces.includes('web-ui') ? ['/'] : [];
}

function requiredChecks(impact: UiImpact, stackPerformanceRisk = false): string[] {
  const withStackPerformance = (checks: string[]): string[] => (
    stackPerformanceRisk ? [...checks, 'stack-performance'] : checks
  );
  if (impact === 'none') return withStackPerformance(['stack-build', 'stack-test', 'stack-lint']);
  if (impact === 'nonvisual') return ['stack-build', 'unit-or-component-tests', 'axe-when-dom'];
  if (impact === 'behavioral') {
    return [
      'stack-build', 'playwright-local', 'dom-assertions', 'actions', 'routing',
      'hydration', 'console-errors', 'network-errors',
    ];
  }
  if (impact === 'visual') {
    return [
      'stack-build', 'playwright-local', 'dom-assertions', 'actions', 'routing',
      'hydration', 'console-errors', 'network-errors', 'responsive-screenshots',
    ];
  }
  return withStackPerformance(['stack-build', 'native-unit-tests', 'simulator-or-emulator']);
}

function thresholdsValid(thresholds: LighthouseThresholdsV1 | undefined): boolean {
  if (!thresholds) return true;
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || Number(value) < 0) return false;
    if (key.endsWith('Min') && Number(value) > 100) return false;
  }
  return true;
}

function verificationHash(value: unknown): string {
  return sha256(stableContractJson(value));
}

export function verificationContractPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', runId, 'verification-v2.json');
}

export function buildVerificationContract(
  projectRoot: string,
  runId: string,
  state: unknown,
  architecture: CompiledArchitectureV1,
  options: VerificationCompileOptions = {},
): VerificationContractV2 {
  if (!runId || /[\\/]/.test(runId)) throw new Error('runId is invalid');
  if (!thresholdsValid(options.explicitLighthouse) || !thresholdsValid(options.advisoryLighthouse)) {
    throw new Error('Lighthouse thresholds are invalid');
  }
  validateAgentRaisedImpact(architecture.profile, options.agentRaisedImpact);
  const webUi = profileHasWebUi(architecture.profile);
  if (!webUi && (
    (options.explicitLighthouse && Object.keys(options.explicitLighthouse).length > 0)
    || (options.advisoryLighthouse && Object.keys(options.advisoryLighthouse).length > 0)
  )) {
    throw new Error('Lighthouse options require a web-ui capability profile');
  }
  const baselineDiff = options.changedPaths
    ? {
        paths: options.changedPaths.map(normalizeRel).filter((value): value is string => Boolean(value)),
        complete: options.scanComplete !== false,
        ...(options.scanReason ? { reason: options.scanReason } : {}),
      }
    : changedPathsFromBaseline(projectRoot, architecture);
  // Every runtime-compiled output is part of the verification identity before
  // implementation: sources, entrypoints, scaffold/config, tests and test
  // infrastructure. Using modules alone would make the final whole-project
  // diff reject the very scaffold/tests the work-unit contract authorized.
  const paths = unique([...baselineDiff.paths, ...architecture.allowedOutputs]);
  // QA impact comes from the immutable-baseline diff. Planned production
  // modules/scaffold are handled separately by plannedUiImpactFloor; test
  // infrastructure must be part of the source identity without inflating a
  // mapper-only change into behavioral or visual UI work.
  const derived = deriveUiImpact(
    projectRoot,
    architecture.profile,
    baselineDiff.paths,
    architecture.baseline,
  );
  const runtimeImpact = raiseImpact(
    derived.impact,
    plannedUiImpactFloor(projectRoot, architecture),
  );
  const raised = options.agentRaisedImpact && rank(options.agentRaisedImpact) > rank(runtimeImpact)
    ? options.agentRaisedImpact
    : runtimeImpact;
  const impact = runtimeImpact === 'native-ui' ? 'native-ui' : raised;
  const tabletRisk = impact === 'visual' && derived.tabletRisk;
  const explicit = options.explicitLighthouse && Object.keys(options.explicitLighthouse).length
    ? options.explicitLighthouse
    : undefined;
  const visualRisk = impact === 'visual' && (
    Boolean(options.advisoryLighthouse && Object.keys(options.advisoryLighthouse).length > 0)
    || plannedImportantVisualChange(projectRoot, architecture)
    || baselineDiff.paths.some((file) => IMPORTANT_VISUAL_PATH_RE.test(file))
  );
  const performanceRequired = webUi
    && Boolean(explicit || options.redesign || options.performanceRisk || visualRisk);
  const performanceReason: PerformanceContractV1['reason'] = explicit
    ? 'explicit'
    : options.redesign
      ? 'redesign'
      : options.performanceRisk
        ? 'performance-risk'
        : visualRisk
          ? 'visual-risk'
          : 'not-required';
  const semanticContract = {
    schemaVersion: VERIFICATION_CONTRACT_SCHEMA_VERSION,
    runId,
    architectureHash: architecture.contractHash,
    baseline: architecture.baseline,
    uiImpact: impact,
    uiImpactSource: impact !== runtimeImpact ? 'agent-raised' as const : 'runtime' as const,
    ...(derived.reason ? { uiImpactReason: derived.reason } : {}),
    changedPaths: paths,
    changedRoutes: changedRoutes(architecture, paths, impact),
    scanComplete: baselineDiff.complete,
    ...(baselineDiff.reason ? { scanReason: baselineDiff.reason } : {}),
    requiredChecks: requiredChecks(impact, !webUi && Boolean(options.performanceRisk)),
    browserRequired: impact === 'behavioral' || impact === 'visual',
    nativeAdapter: impact === 'native-ui' ? (architecture.profile.qaAdapters[0] || null) : null,
    requiredScreenshotWidths: impact === 'visual' ? [390, ...(tabletRisk ? [768] : []), 1440] : [],
    tabletRisk,
    buildIdentityRequired: impact === 'behavioral' || impact === 'visual',
    performance: {
      required: performanceRequired,
      reason: performanceRequired ? performanceReason : 'not-required' as const,
      ...(explicit ? { explicitThresholds: explicit } : {}),
      ...(options.advisoryLighthouse ? { advisoryThresholds: options.advisoryLighthouse } : {}),
      advisoryTolerancePercent: 3 as const,
    },
  };
  // PLAN_READY publishes the first contract, then IMPLEMENTED refreshes it
  // against the real immutable-baseline diff. Repeated pre-tool retries with no
  // semantic change must not churn the contract hash and invalidate every
  // already-published WorkUnit/bootstrap merely because wall-clock time moved.
  const existing = readVerificationContract(projectRoot, runId);
  if (existing) {
    const {
      contractHash: _existingHash,
      generatedAt: _existingGeneratedAt,
      ...existingSemantic
    } = existing;
    if (stableContractJson(existingSemantic) === stableContractJson(semanticContract)) {
      return existing;
    }
  }
  const withoutHash = {
    ...semanticContract,
    generatedAt: new Date().toISOString(),
  };
  const contract: VerificationContractV2 = {
    ...withoutHash,
    contractHash: verificationHash(withoutHash),
  };
  return contract;
}

export function publishVerificationContract(
  projectRoot: string,
  contract: VerificationContractV2,
): VerificationContractV2 {
  writeJson(verificationContractPath(projectRoot, contract.runId), contract);
  return contract;
}

export function compileVerificationContract(
  projectRoot: string,
  runId: string,
  state: unknown,
  architecture: CompiledArchitectureV1,
  options: VerificationCompileOptions = {},
): VerificationContractV2 {
  const contract = buildVerificationContract(projectRoot, runId, state, architecture, options);
  const existing = readVerificationContract(projectRoot, runId);
  if (existing?.contractHash === contract.contractHash) return existing;
  return publishVerificationContract(projectRoot, contract);
}

export function readVerificationContract(
  projectRoot: string,
  runId: string,
): VerificationContractV2 | null {
  const raw = readJson<VerificationContractV2 | null>(verificationContractPath(projectRoot, runId), null);
  if (!raw || raw.schemaVersion !== VERIFICATION_CONTRACT_SCHEMA_VERSION || raw.runId !== runId) return null;
  const { contractHash, ...withoutHash } = raw;
  if (!contractHash || verificationHash(withoutHash) !== contractHash) return null;
  return raw;
}

export function currentVerificationSourceHash(
  projectRoot: string,
  contract: VerificationContractV2,
): { hash: string; complete: boolean; reason?: string } {
  if (!contract.scanComplete) {
    return { hash: '', complete: false, reason: contract.scanReason || 'verification scan is incomplete' };
  }
  const currentDiff = changedPathsFromImmutableBaseline(projectRoot, contract.baseline);
  if (!currentDiff.complete) {
    return {
      hash: '',
      complete: false,
      reason: currentDiff.reason || 'baseline diff could not be recomputed',
    };
  }
  const contracted = new Set(contract.changedPaths);
  const extraPaths = currentDiff.paths.filter((file) => !contracted.has(file));
  if (extraPaths.length > 0) {
    return {
      hash: '',
      complete: false,
      reason: `changed paths outside verification contract: ${extraPaths.slice(0, 20).join(', ')}${extraPaths.length > 20 ? ` (+${extraPaths.length - 20} more)` : ''}`,
    };
  }
  for (const file of contract.changedPaths) {
    const issue = projectPathInspectionIssue(projectRoot, file);
    if (issue) return { hash: '', complete: false, reason: issue };
  }
  const rows = contract.changedPaths.map((file) => [
    file,
    fileHash(projectRoot, file),
  ]);
  return {
    hash: sha256(stableContractJson({
      baseline: contract.baseline.identity,
      architectureHash: contract.architectureHash,
      rows,
    })),
    complete: true,
  };
}
