// src/config/reporting.ts
// One MCP anonymous codebase-report configuration. The endpoint itself is the
// shared DEFAULT_PUBLIC_ENDPOINT in one-mcp.ts; this module owns only reporter
// behavior and persistence knobs.

import * as path from 'path';

// Master switch for collection + POST. Tests may override it through the
// runner's featureEnabled option; production callers use this compiled value.
export const ONE_MCP_REPORT = true;

// When false, reporting stays fire-and-forget and is deduplicated by one-uid in
// .one.json, without reading or writing one-mcp-report.json.
export const SAVE_MCP_REPORT = true;

export const ONE_UID_FIELD = 'one-uid';
export const STATUS_FILE = path.join('.traffic-one', 'one-mcp-report.json');
export const QUEUED_RETRY_MS = 5 * 60 * 1000;
export const FAILED_RETRY_MS = 60 * 60 * 1000;
export const ONE_MCP_REPORT_TIMEOUT_MS = 15_000;

export const ONE_MCP_REPORT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

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

export const SKIP_DIRS = new Set([
  '.cache', '.git', '.gitnexus', '.next', '.nuxt', '.traffic-one', '.turbo',
  'build', 'coverage', 'dist', 'graphify-out', 'node_modules', 'out', 'Pods', 'target', 'vendor',
]);
export const SKIP_FILES = new Set(['.DS_Store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
