// src/gen/sources/product.ts
// Single source of the product identity + the per-host manifest shapes. The
// version is injected from shared/version (package.json) so a bump flows to all
// five manifests at once; the descriptions/interface prose live here verbatim
// so there is exactly one place to edit them. The generator serializes these
// with canonical 2-space JSON, reproducing the hand-authored manifests
// byte-for-byte (golden-verified).

export const NAME = 'traffic-one';
export const AUTHOR = { name: 'Traffic-One' } as const;

const CLAUDE_PLUGIN_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin gated by mcp-auth authentication, with persistent .traffic-one project memory, token-economy handoff digests + a required codebase-graph provider choice at onboarding (GitNexus or graphify) with auto-install + auto-run, senior-engineer subagent team (architect / frontend / backend / reviewer / tester / shipper) with auto-orchestration, modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, Lighthouse mobile QA runner, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, Traffic One pre-deployment security scanner, WebSocket patterns, accessibility, Gitflow, plus adapted ECC development skills for backend, frontend, mobile, API, testing, security, and deployment work. Hooks enforce auth, plan gate, security-gated deploys, forbidden libraries, and architecture violations; skills auto-trigger on semantic match.';

const CLAUDE_MARKETPLACE_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin gated by mcp-auth authentication, with a senior-engineer subagent team (architect / frontend / backend / reviewer / tester / shipper) and auto-orchestration, plus a token-economy layer (per-phase handoff digests + required codebase-graph provider choice at onboarding — GitNexus or graphify — with auto-install + auto-run) that cuts redundant codebase reads across the team by an estimated 50–70%. Modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, Lighthouse mobile QA runner, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, WebSocket patterns, accessibility, Gitflow. Auth gate + plan gate + deploy gate enforced via hooks where supported. Compatible with Claude Code, Codex CLI, and Cursor.';

const CODEX_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin gated by mcp-auth authentication, with project memory under .traffic-one/, token-economy handoff digests + a required codebase-graph provider choice at onboarding (GitNexus or graphify) with auto-install + auto-run, senior-engineer subagent team (architect / frontend / backend / reviewer / tester / shipper) mirrored into AGENTS.md, modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, Lighthouse mobile QA runner, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, Traffic One pre-deployment security scanner, WebSocket patterns, accessibility, Gitflow, plus adapted ECC development skills for backend, frontend, mobile, API, testing, security, and deployment work. Rules auto-load via AGENTS.md; skills auto-trigger; hooks enforce auth, plan gate, security-gated deploys, forbidden installs.';

const CODEX_LONG_DESCRIPTION = 'Traffic One adds an mcp-auth authentication gate, opinionated React, Ionic/Capacitor mobile packaging, explicit React Native, TypeScript, Turborepo, persistent .traffic-one project memory, modern clean UI design gates, visual QA, testing, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, pre-deployment security scanning, and Gitflow rules with project-specific Codex skills and hooks.';

const CURSOR_DESCRIPTION = 'React + Ionic/Capacitor + explicit React Native TypeScript plugin with mcp-auth authentication guidance, persistent .traffic-one project memory, token-economy handoff digests + a required codebase-graph provider choice at onboarding (GitNexus or graphify) with auto-install + auto-run, senior-engineer role rules (architect / frontend / backend / reviewer / tester / shipper) auto-attached, modern clean UI design gates, Turborepo, RTK Query, Expo Router, Tailwind + shadcn/ui (web/Ionic), NativeWind + React Native Reusables (RN), Jest, Playwright/Maestro, app launch checklist guidance, post-deploy observability guidance, AI fix suggestions with approval gates, Traffic One pre-deployment security scanner, WebSocket patterns, accessibility, Gitflow. Rules auto-attach via globs; skills auto-trigger on semantic match.';

export function claudePluginManifest(version: string): Record<string, unknown> {
  return {
    name: NAME,
    version,
    description: CLAUDE_PLUGIN_DESCRIPTION,
    author: { ...AUTHOR },
    skills: './skills/',
    mcpServers: './.mcp.json',
  };
}

export function claudeMarketplaceManifest(version: string): Record<string, unknown> {
  return {
    name: NAME,
    owner: { ...AUTHOR },
    plugins: [
      {
        name: NAME,
        source: './',
        version,
        description: CLAUDE_MARKETPLACE_DESCRIPTION,
      },
    ],
  };
}

export function codexPluginManifest(version: string): Record<string, unknown> {
  return {
    name: NAME,
    version,
    description: CODEX_DESCRIPTION,
    author: { ...AUTHOR },
    skills: './skills-templates/',
    hooks: './hooks/hooks.json',
    instructions: './AGENTS.md',
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'Traffic One',
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
      screenshots: [],
    },
  };
}

export function cursorPluginManifest(version: string): Record<string, unknown> {
  return {
    name: NAME,
    displayName: 'Traffic One',
    description: CURSOR_DESCRIPTION,
    version,
    author: { ...AUTHOR },
    keywords: [
      'react', 'ionic', 'capacitor', 'react-native', 'typescript', 'turborepo',
      'rtk-query', 'launch-checklist', 'observability', 'design-quality', 'cursor-rules',
    ],
    category: 'engineering',
    tags: [
      'react', 'ionic', 'capacitor', 'react-native', 'typescript',
      'design-quality', 'launch-checklist', 'observability', 'testing', 'security',
    ],
    skills: './skills/',
    rules: './.cursor/rules/',
    hooks: './hooks/hooks-cursor.json',
    mcpServers: './.mcp.json',
  };
}

// The .agents marketplace manifest carries no version field.
export function agentsMarketplaceManifest(): Record<string, unknown> {
  return {
    name: 'traffic-one-local',
    interface: { displayName: 'Traffic One Local' },
    plugins: [
      {
        name: NAME,
        source: { source: 'local', path: './.' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Engineering',
      },
    ],
  };
}
