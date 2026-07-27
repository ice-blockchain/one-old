// src/config/plugin-identity.ts
// Plugin identity: THE single source for the product name, author, version, and
// the per-host manifest descriptions stamped into the five generated manifests.
// Edit a description here and it flows to the manifest via the builders in
// gen/sources/product.ts (which import this data). The version VALUE stays in
// package.json (the npm-canonical source); pluginVersion() reads it so a single
// bump there flows to every manifest + the runtime state/security reports.
//
// Note: this is the one config file that imports shared utils (fsjson/paths) —
// resolving the version needs an fs read. It is acyclic (those utils never import
// config), so config stays a dependency leaf in practice.

import * as path from 'path';

import { readJson } from '../shared/fsjson';
import { pluginRoot } from '../shared/paths';

export const NAME = 'traffic-one';
export const AUTHOR = { name: 'Traffic-One' } as const;

// Single source of the plugin version: package.json. The generator stamps this
// into all 5 manifests; runtime reads the same value.
export function pluginVersion(root: string = pluginRoot()): string {
  const pkg = readJson<{ version?: string }>(path.join(root, 'package.json'), {});
  return pkg.version ?? '0.0.0';
}

export function pluginNodeEngine(root: string = pluginRoot()): string {
  const pkg = readJson<{ engines?: { node?: string } }>(path.join(root, 'package.json'), {});
  return pkg.engines?.node ?? '>=22';
}

// ── Per-host manifest descriptions (verbatim; one place to edit) ─────────────

export const CLAUDE_PLUGIN_DESCRIPTION = 'Capability-driven senior-engineer workflow for web, native, API, CLI, worker, and data projects: runtime-compiled architecture/work-unit/verification contracts, structural enforcement, persistent .traffic-one project memory, scoped handoff digests, risk-proportional QA, and pre-deploy security gates. Hooks enforce policy before tools run; roles and skills are materialized only for the detected stack.';

export const CLAUDE_MARKETPLACE_DESCRIPTION = 'Capability-driven senior-engineer plugin for React/Vite, Next.js, Nuxt, Laravel, Go, Python, native, API-only, CLI, worker, data, and custom stacks. The runtime derives surfaces and framework conventions, compiles immutable architecture/work-unit/verification contracts, enforces role and output scope before tools run, blocks structurally invalid UI modules, and materializes only applicable rules and skills. Functional UI QA uses local Playwright or native adapters according to mechanically derived risk; screenshots and Lighthouse are conditional. Includes persistent project memory, handoff digests, codebase graph integration, security/deploy gates, and cross-host adapters for Claude, Codex, Cursor, OpenCode, Kilo, Copilot, and Windsurf.';

export const CODEX_DESCRIPTION = 'Capability-driven senior-engineer workflow for web, native, API, CLI, worker, and data projects. Runtime hooks compile and enforce architecture, role, output, model, and risk-proportional QA contracts; project-materialized AGENTS.md exposes only stack-applicable roles, rules, and skills.';

export const CODEX_LONG_DESCRIPTION = 'Traffic One derives project capabilities for web, native, API, CLI, worker, and data surfaces; compiles immutable architecture, work-unit, model-policy, and verification contracts; and enforces them through host hooks before tools run. It supports React/Vite, Next.js, Nuxt, Laravel, Go, Python, native platforms, API-only services, and custom stacks without assigning frontend roles or browser QA to non-UI projects. UI verification is risk-proportional: local Playwright for behavioral browser work, screenshots only for visual work, native simulator/emulator adapters for native UI, and Lighthouse only when performance risk or an explicit requirement demands it. Persistent .traffic-one memory, scoped handoff digests, security/deploy gates, and stack-filtered rules and skills remain available across supported hosts.';

export const CURSOR_DESCRIPTION = 'Capability-driven senior-engineer workflow for web, native, API, CLI, worker, and data projects. Generic pre-tool hooks enforce runtime-compiled architecture, role, model, output, and QA contracts; only stack-applicable rules and skills are materialized.';

export const COPILOT_DESCRIPTION = 'Capability-driven senior-engineer workflow for web, native, API, CLI, worker, and data projects. Host PreToolUse hooks enforce runtime-compiled architecture, role, model, output, and QA contracts; AGENTS.md receives only stack-applicable rules and skills.';

// ── Codex/Cursor manifest interface metadata ─────────────────────────────────
// Verbatim; key + array-element order is preserved so the generated manifests
// stay byte-identical. The builders in gen/sources/product.ts consume these.

export const DISPLAY_NAME = 'Traffic One';

export const CODEX_INTERFACE = {
  displayName: DISPLAY_NAME,
  shortDescription: 'Production engineering team',
  longDescription: CODEX_LONG_DESCRIPTION,
  developerName: 'Traffic-One',
  category: 'Developer Tools',
  capabilities: ['Interactive', 'Read', 'Write'],
  defaultPrompt: [
    'Build a production-ready application with Traffic One',
    'Run risk-proportional UI QA for this change',
    'Run the Traffic One Security Check',
  ],
  brandColor: '#2563EB',
  screenshots: [] as string[],
};

export const CURSOR_KEYWORDS = [
  'react', 'nextjs', 'nuxt', 'laravel', 'go', 'python', 'ionic', 'capacitor',
  'react-native', 'swift', 'kotlin', 'api', 'cli', 'observability',
  'design-quality', 'cursor-rules',
];

export const CURSOR_TAGS = [
  'web', 'native', 'backend', 'api', 'react', 'nextjs', 'nuxt', 'laravel',
  'go', 'python', 'testing', 'security', 'observability',
];
