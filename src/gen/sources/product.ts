// src/gen/sources/product.ts
// Per-host manifest SHAPES (the builder functions). The product identity (name,
// author, version) and the description prose live in config/plugin-identity.ts —
// one place to edit. The version is injected from config/plugin-identity's pluginVersion
// (package.json) so a bump flows to all five manifests at once. The generator
// serializes these with canonical 2-space JSON, reproducing the hand-authored
// manifests byte-for-byte (golden-verified).

import {
  AUTHOR,
  CLAUDE_MARKETPLACE_DESCRIPTION,
  CLAUDE_PLUGIN_DESCRIPTION,
  CODEX_DESCRIPTION,
  CODEX_INTERFACE,
  CURSOR_DESCRIPTION,
  CURSOR_KEYWORDS,
  CURSOR_TAGS,
  COPILOT_DESCRIPTION,
  DISPLAY_NAME,
  NAME,
} from '../../config/plugin-identity';

export function claudePluginManifest(version: string, agentPaths: string[]): Record<string, unknown> {
  return {
    name: NAME,
    version,
    description: CLAUDE_PLUGIN_DESCRIPTION,
    author: { ...AUTHOR },
    // Explicit file list, NOT './agents/': declaring `agents` suppresses Claude's
    // conventional agents/ directory scan, which would also pick up the Copilot
    // *.agent.md twins (they end in .md too) and register every role twice with
    // a load-order-dependent winner.
    agents: [...agentPaths],
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
    skills: './skills/',
    hooks: './hooks/hooks.json',
    instructions: './AGENTS.md',
    mcpServers: './.mcp.json',
    interface: { ...CODEX_INTERFACE },
  };
}

export function cursorPluginManifest(version: string): Record<string, unknown> {
  return {
    name: NAME,
    displayName: DISPLAY_NAME,
    description: CURSOR_DESCRIPTION,
    version,
    author: { ...AUTHOR },
    keywords: [...CURSOR_KEYWORDS],
    category: 'engineering',
    tags: [...CURSOR_TAGS],
    skills: './skills/',
    rules: './.cursor/rules/',
    hooks: './hooks/hooks-cursor.json',
    mcpServers: './.mcp.json',
  };
}

export function copilotPluginManifest(version: string): Record<string, unknown> {
  return {
    name: NAME,
    description: COPILOT_DESCRIPTION,
    version,
    author: { ...AUTHOR },
    skills: ['./skills/'],
    agents: './agents/',
    hooks: './hooks/hooks-copilot.json',
    mcpServers: './.mcp.json',
    instructions: './AGENTS.md',
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
        policy: { installation: 'AVAILABLE' },
        category: 'Engineering',
      },
    ],
  };
}
