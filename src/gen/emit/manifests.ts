// src/gen/emit/manifests.ts
// Emits the host manifests + Copilot plugin.json + .mcp.json. One version bump
// updates every manifest in lockstep.

import { OPENCODE_MCP_SERVER_KEY, openCodeMcpServerEntry } from '../../config/opencode-mcp';
import {
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_REGISTRATION_ACTIVE,
  ONE_MCP_SERVER_NAME,
  assertOneMcpPublicReleaseReady,
} from '../../config/one-mcp';
import { pluginVersion } from '../../config/plugin-identity';
import type { GenRun } from '../lib/run';
import { generatedAgents } from './agents';
import { PLUGIN_ROOT_EXPR } from '../sources/hooks';
import {
  agentsMarketplaceManifest,
  claudeMarketplaceManifest,
  claudePluginManifest,
  codexPluginManifest,
  copilotPluginManifest,
  cursorPluginManifest,
} from '../sources/product';

export function emitManifests(run: GenRun): void {
  const version = pluginVersion(run.sourceRoot);
  // Sorted so the manifest bytes don't depend on module-directory read order.
  const claudeAgentPaths = generatedAgents(run.sourceRoot)
    .map((doc) => `./${doc.relPath.replace(/\\/g, '/')}`)
    .sort();
  run.json('.claude-plugin/plugin.json', claudePluginManifest(version, claudeAgentPaths));
  run.json('.claude-plugin/marketplace.json', claudeMarketplaceManifest(version));
  run.json('.codex-plugin/plugin.json', codexPluginManifest(version));
  run.json('.cursor-plugin/plugin.json', cursorPluginManifest(version));
  run.json('plugin.json', copilotPluginManifest(version));
  run.json('.agents/plugins/marketplace.json', agentsMarketplaceManifest());
}

export function emitMcp(
  run: GenRun,
  publicRegistrationActive = ONE_MCP_REGISTRATION_ACTIVE,
  publicEndpoint = DEFAULT_PUBLIC_ENDPOINT,
  liveManifestVerified = false,
): void {
  assertOneMcpPublicReleaseReady({
    sync: false,
    registration: publicRegistrationActive,
    reporting: false,
  }, publicEndpoint, liveManifestVerified);
  const bundledWorker = openCodeMcpServerEntry(PLUGIN_ROOT_EXPR);
  // Shared by Claude, Cursor, and Codex. The public server is deliberately
  // absent because those plugin formats cannot hide its AI-facing tools while
  // leaving the endpoint available to the hook runtime.
  run.json('.mcp.json', {
    mcpServers: {
      // The bundled OpenCode delegate. Launched via stdio (sh -c, so the shared
      // plugin-root chain expands) — a host-spawned subprocess runs OUTSIDE the
      // per-tool-call sandbox, which is what lets OpenCode reach the network +
      // git that the orchestrator's own (sandboxed) shell cannot.
      [OPENCODE_MCP_SERVER_KEY]: bundledWorker,
    },
  });
  // Copilot supports a server-level tool allowlist. Keep the registration for
  // discoverability/management but expose zero tools to the model.
  run.json('.mcp-copilot.json', {
    mcpServers: {
      [OPENCODE_MCP_SERVER_KEY]: bundledWorker,
      ...(publicRegistrationActive ? {
        [ONE_MCP_SERVER_NAME]: {
          type: 'http',
          url: publicEndpoint,
          tools: [],
        },
      } : {}),
    },
  });
}
