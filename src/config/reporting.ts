// src/config/reporting.ts
// One MCP anonymous codebase-report configuration. The endpoint itself is the
// shared DEFAULT_PUBLIC_ENDPOINT in one-mcp.ts; this module owns only reporter
// behavior and persistence knobs.

import * as path from 'path';

// Master switch for collection + POST. Tests may override it through the
// runner's featureEnabled option; production callers use this compiled value.
export const ONE_MCP_REPORT = true;

// When true, the reporter reads and writes the `one-mcp-report.json` status
// file (pending/ok/failed plus retry timing), so a queued report survives the
// session and retries on its own schedule. When false it is fire-and-forget,
// deduplicated only by the one-uid in `.one.json`.
export const SAVE_MCP_REPORT = true;

export const ONE_UID_FIELD = 'one-uid';
export const STATUS_FILE = path.join('.traffic-one', 'one-mcp-report.json');
export const QUEUED_RETRY_MS = 5 * 60 * 1000;
export const FAILED_RETRY_MS = 60 * 60 * 1000;
export const ONE_MCP_REPORT_TIMEOUT_MS = 15_000;

const ONE_MCP_REPORT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidOneMcpReportId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && ONE_MCP_REPORT_ID_RE.test(value);
}

export const ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS = 1_000;
export const ONE_MCP_REPORT_ID_LOCK_RETRY_MS = 10;
export const ONE_MCP_REPORT_ID_LOCK_STALE_MS = 10_000;

// Only finite, structural identifiers may be copied from project-owned state
// into the anonymous report. Dependency/file inference adds values from this
// same vocabulary; unknown state prose is ignored instead of transmitted.
export const ONE_MCP_REPORTED_TECHNOLOGY_IDS: ReadonlySet<string> = new Set([
  'alpine', 'angular', 'astro', 'capacitor', 'dart', 'django', 'dotnet', 'ember',
  'expo', 'fastapi', 'firebase', 'gatsby', 'go', 'ionic', 'java', 'javascript',
  'kotlin', 'laravel', 'lit', 'marko', 'mongo', 'nestjs', 'next.js', 'nextjs',
  'node', 'npm', 'php', 'pnpm', 'posthog', 'postgres', 'preact', 'prisma', 'python',
  'qwik', 'react', 'react-native', 'redux', 'remix', 'rust', 'solid', 'stencil',
  'supabase', 'svelte', 'swift', 'tailwindcss', 'tanstack-query', 'turborepo',
  'typescript', 'vite', 'vue', 'yarn', 'zustand',
]);

// Extension labels are project-controlled filenames. A finite vocabulary keeps
// aggregate line counts useful without allowing a crafted suffix to carry an
// email, repository name, Unicode text, or other arbitrary identifier.
export const ONE_MCP_REPORTED_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'astro', 'bash', 'c', 'cc', 'cjs', 'clj', 'cljc', 'cljs', 'cpp', 'cs', 'css',
  'csv', 'cxx', 'dart', 'dockerfile', 'eex', 'ex', 'exs', 'fish', 'fs', 'fsx',
  'go', 'gql', 'gradle', 'graphql', 'groovy', 'h', 'hbs', 'hcl', 'hh', 'hpp',
  'hrl', 'htm', 'html', 'java', 'js', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less',
  'lua', 'm', 'md', 'mdx', 'mjs', 'mm', 'nix', 'php', 'pl', 'pm', 'prisma',
  'proto', 'ps1', 'py', 'r', 'rb', 'rs', 'sass', 'scala', 'scss', 'sh', 'sol',
  'sql', 'svelte', 'swift', 'tf', 'tfvars', 'toml', 'ts', 'tsv', 'tsx', 'txt',
  'vb', 'vue', 'xml', 'yaml', 'yml', 'zig', 'zsh',
]);

// Dependency, build-output, cache, and host/editor directories across every
// ecosystem Traffic One supports. This is the SINGLE skip authority: the code
// graph, the immutable baseline capture, and every baseline-derived diff all
// read it, so the two scan sides can never disagree about a derived artifact
// (see `isScanSkippedPath` in shared/architecture-contract/baseline.ts).
//
// Deliberately conservative — a name here becomes invisible to the verification
// diff, so over-skipping would HIDE real changes. `bin` and bare `lib` are
// excluded for exactly that reason: both are ordinary source directories in
// enough ecosystems to make the trade a net loss.
export const SKIP_DIRS = new Set([
  // Git, Traffic One, and its own generated caches
  '.git', '.gitnexus', '.traffic-one', 'graphify-out',
  // JS/TS dependency + build output + tooling caches
  '.astro', '.cache', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.vite',
  'build', 'coverage', 'dist', 'node_modules', 'out',
  '__generated__', 'generated', 'playwright-report', 'test-results',
  // PHP (Composer) and Go — the Laravel run hashed 8,569 `vendor/**` files
  // into a 1.63 MB baseline, 400 short of the hard scan cap.
  'vendor',
  // Python
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.venv', 'venv',
  // JVM / Android / Rust — `target` is Cargo and Maven
  '.gradle', 'target',
  // Dart / Flutter
  '.dart_tool',
  // Ruby
  '.bundle',
  // Elixir / OCaml
  '_build', 'deps',
  // .NET — `obj` only; `bin` is too often real source
  'obj',
  // Swift / iOS
  'Carthage', 'Pods',
  // Haskell
  '.stack-work',
  // Terraform
  '.terraform',
  // Agent host and editor local config. These are written by tooling — the
  // plugin itself writes `.claude/settings.local.json` — and a single one
  // appearing after baseline capture blocked ALL QA settlement on a green run.
  '.claude', '.codex', '.cursor', '.devin', '.kilo', '.idea', '.vscode',
]);

// The SKIP_DIRS names that are USUALLY derived and sometimes not. A repository
// may hold authored code in `generated/` (checked-in codegen a human then
// edits), in `out/` or `build/` (ordinary directory names in enough ecosystems
// to have been argued over), and `dist` and `coverage` are one `git add` away
// from the same thing. `node_modules`, `.git`, `vendor` and the tool caches are
// NOT here: nothing in them is this project's authored source however git is
// configured, so a visible path under one of those is never worth reporting.
//
// Read by `nameSkippedProjectSource`, which is the only project-input test the
// static name sets have. Keep it a strict subset of SKIP_DIRS.
export const AMBIGUOUS_SKIP_DIRS: ReadonlySet<string> = new Set([
  '__generated__', '_build', 'build', 'coverage', 'dist', 'generated', 'obj', 'out', 'target',
]);

// Extensions that carry AUTHORED behavior — the ones whose silent disappearance
// from a diff can delete a real finding. Deliberately much narrower than
// `ONE_MCP_REPORTED_FILE_EXTENSIONS`: `json`, `md` and `txt` are excluded
// because a build writes hundreds of those and a `test-results/.last-run.json`
// appearing after capture already deadlocked one green run.
export const AUTHORED_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'astro', 'cjs', 'js', 'jsx', 'mjs', 'svelte', 'ts', 'tsx', 'vue',
]);

// OS/editor droppings. Noise for every consumer, git included.
export const SKIP_OS_FILES = new Set([
  '.DS_Store', 'Thumbs.db',
]);

// Lockfiles. A lockfile appears the moment an implementer installs the
// dependency a completion gate itself demanded, so it must never read as an
// unauthorized changed path.
//
// SCAN-ONLY. Git must TRACK these: a project that does not commit its lockfile
// cannot reproduce its install. Kept separate from `SKIP_OS_FILES` so the
// generated `.gitignore` can reuse this authority without inheriting a rule
// that is only correct for the verifier (observed 10co: the emitted
// `.gitignore` hid a 175 KB `pnpm-lock.yaml` from git entirely).
export const SKIP_LOCKFILES = new Set([
  'bun.lockb', 'bun.lock', 'Cargo.lock', 'composer.lock', 'deno.lock', 'Gemfile.lock',
  'package-lock.json', 'pnpm-lock.yaml', 'poetry.lock', 'uv.lock', 'yarn.lock',
]);

export const SKIP_FILES = new Set([...SKIP_OS_FILES, ...SKIP_LOCKFILES]);
