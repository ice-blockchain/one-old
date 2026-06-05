// src/gen/emit/manifests.ts
// Emits the five host manifests + .mcp.json from product.ts + the single
// version source (config/plugin-identity → package.json) + the single endpoint source
// (config/auth DEFAULT_ENDPOINT). One version bump → all manifests in lockstep.

import { DEFAULT_ENDPOINT } from '../../config/auth';
import { pluginVersion } from '../../config/plugin-identity';
import type { GenRun } from '../lib/run';
import {
  agentsMarketplaceManifest,
  claudeMarketplaceManifest,
  claudePluginManifest,
  codexPluginManifest,
  cursorPluginManifest,
} from '../sources/product';

export function emitManifests(run: GenRun): void {
  const version = pluginVersion(run.sourceRoot);
  run.json('.claude-plugin/plugin.json', claudePluginManifest(version));
  run.json('.claude-plugin/marketplace.json', claudeMarketplaceManifest(version));
  run.json('.codex-plugin/plugin.json', codexPluginManifest(version));
  run.json('.cursor-plugin/plugin.json', cursorPluginManifest(version));
  run.json('.agents/plugins/marketplace.json', agentsMarketplaceManifest());
}

export function emitMcp(run: GenRun): void {
  run.json('.mcp.json', {
    mcpServers: {
      'mcp-auth': {
        type: 'http',
        url: DEFAULT_ENDPOINT,
      },
    },
  });
}
