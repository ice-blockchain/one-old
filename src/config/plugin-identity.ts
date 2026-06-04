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

// ── Per-host manifest descriptions (verbatim; one place to edit) ─────────────

export const CLAUDE_PLUGIN_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin gated by mcp-auth authentication, with a browser-based onboarding wizard (local HTTP server, no chat popups), persistent .traffic-one project memory, token-economy handoff digests + a required codebase-graph provider choice at onboarding (GitNexus or graphify) with auto-install + auto-run, senior-engineer subagent team (architect / frontend / backend / reviewer / tester / shipper) with auto-orchestration, modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, Lighthouse mobile QA runner, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, Traffic One pre-deployment security scanner, WebSocket patterns, accessibility, Gitflow, plus adapted ECC development skills for backend, frontend, mobile, API, testing, security, and deployment work. Hooks enforce auth, plan gate, security-gated deploys, forbidden libraries, and plan gate violations; skills auto-trigger on semantic match.';

export const CLAUDE_MARKETPLACE_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin gated by mcp-auth authentication, with a senior-engineer subagent team (architect / frontend / backend / reviewer / tester / shipper) and auto-orchestration, a browser-based onboarding wizard (local HTTP server, no chat popups), plus a token-economy layer (per-phase handoff digests + required codebase-graph provider choice at onboarding — GitNexus or graphify — with auto-install + auto-run) that cuts redundant codebase reads across the team by an estimated 50–70%. Modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, Lighthouse mobile QA runner, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, WebSocket patterns, accessibility, Gitflow. Auth gate + plan gate + deploy gate enforced via hooks where supported. Compatible with Claude Code, Codex CLI, and Cursor.';

export const CODEX_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin gated by mcp-auth authentication, with a browser-based onboarding wizard (local HTTP server, no chat popups), project memory under .traffic-one/, token-economy handoff digests + a required codebase-graph provider choice at onboarding (GitNexus or graphify) with auto-install + auto-run, senior-engineer subagent team (architect / frontend / backend / reviewer / tester / shipper) mirrored into AGENTS.md, modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, Lighthouse mobile QA runner, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, Traffic One pre-deployment security scanner, WebSocket patterns, accessibility, Gitflow, plus adapted ECC development skills for backend, frontend, mobile, API, testing, security, and deployment work. Rules auto-load via AGENTS.md; skills auto-trigger; hooks enforce auth, plan gate, security-gated deploys, forbidden installs.';

export const CODEX_LONG_DESCRIPTION = 'Traffic One adds an mcp-auth authentication gate, a browser-based onboarding wizard (local HTTP server), opinionated React, Ionic/Capacitor mobile packaging, explicit React Native, TypeScript, Turborepo, persistent .traffic-one project memory, modern clean UI design gates, visual QA, testing, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, pre-deployment security scanning, and Gitflow rules with project-specific Codex skills and hooks.';

export const CURSOR_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin with mcp-auth authentication guidance, a browser-based onboarding wizard (local HTTP server, no chat popups), persistent .traffic-one project memory, token-economy handoff digests + a required codebase-graph provider choice at onboarding (GitNexus or graphify) with auto-install + auto-run, senior-engineer role rules (architect / frontend / backend / reviewer / tester / shipper) auto-attached, modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, Traffic One pre-deployment security scanner, WebSocket patterns, accessibility, Gitflow. Rules auto-attach via globs; skills auto-trigger on semantic match.';

// ── Codex/Cursor manifest interface metadata ─────────────────────────────────
// Verbatim; key + array-element order is preserved so the generated manifests
// stay byte-identical. The builders in gen/sources/product.ts consume these.

export const DISPLAY_NAME = 'Traffic One';

export const CODEX_INTERFACE = {
  displayName: DISPLAY_NAME,
  shortDescription: 'Authenticated React, Ionic/Capacitor, RN, TypeScript, modern UI, and security-gated deploys.',
  longDescription: CODEX_LONG_DESCRIPTION,
  developerName: 'Traffic-One',
  category: 'Engineering',
  capabilities: ['Interactive', 'Read', 'Write'],
  defaultPrompt: [
    'Authenticate Traffic One',
    'Create a React feature',
    'Make this UI modern and clean',
    'Run visual QA for this route',
    'Create project memory',
    'Run the app launch checklist',
    'Add post-deploy observability',
    'Run the Traffic One Security Check',
  ],
  brandColor: '#2563EB',
  screenshots: [] as string[],
};

export const CURSOR_KEYWORDS = [
  'react', 'ionic', 'capacitor', 'react-native', 'typescript', 'turborepo',
  'rtk-query', 'launch-checklist', 'observability', 'design-quality', 'cursor-rules',
];

export const CURSOR_TAGS = [
  'react', 'ionic', 'capacitor', 'react-native', 'typescript',
  'design-quality', 'launch-checklist', 'observability', 'testing', 'security',
];
