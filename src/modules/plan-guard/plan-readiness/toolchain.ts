// src/modules/plan-guard/plan-readiness/toolchain.ts
// Toolchain parity: emit-config, prettier format parity/coverage, typecheck
// ownership, crawl-origin, test-runner gaps, and self-reported skips.

import * as path from 'path';
import {
  webPackageRoot,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import {  type CapabilityProfileV1 } from '../../../shared/capabilities';
import { obj } from '../../../shared/obj';
import { matchesPattern,  normalizeRelPath } from '../../../shared/scope';

import {
  type Rec,
  exists,
  readTrimmed,
} from './context';

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

export function emitConfigProblems(projectRoot: string, profile: CapabilityProfileV1): string[] {
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

export function compiledFormatToolchainForRole(
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

export function formatParityViolation(
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
export function compiledOutputPaths(
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

export function roleOwnedTsOutputs(
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
export function typecheckParityViolation(
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

export function crawlOriginProblem(
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

export function testToolchainGaps(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
  ownerRole: string,
  performanceRequired = false,
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
  // A performance-required verification contract runs project-local Lighthouse
  // (the canonical runner refuses a global binary). Nothing compiled the
  // dependency in 8co, so the tester — who does NOT own the manifest — was
  // blocked and had to route a review finding at the implementer. The manifest
  // owner ships it up front instead.
  if (performanceRequired && typeof deps.lighthouse !== 'string') {
    missing.push('`lighthouse` dependency (performance-required QA)');
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

export function skippedVerificationLine(content: string): string | null {
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
