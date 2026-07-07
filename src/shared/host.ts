// src/shared/host.ts
// Decide which host wire shape we're speaking. Claude and Codex share the nested
// hookSpecificOutput shape (and the raw→canonical tool mapping handles both tool
// vocabularies), so they use the same adapter; Cursor and Windsurf are JSON
// outliers and announce themselves via host-stamped entry scripts.

import type { HostId } from '../core/types';

function knownHost(value: string): value is HostId {
  return value === 'cursor'
    || value === 'codex'
    || value === 'claude'
    || value === 'opencode'
    || value === 'copilot'
    || value === 'windsurf';
}

export function detectHost(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): HostId {
  // An explicit `--host=<id>` arg is AUTHORITATIVE — it is how a plugin-spawned runner
  // subprocess (e.g. onboarding-wait.cjs) learns the host, since the env markers below
  // (CURSOR_PLUGIN_ROOT / CODEX_*) are set for the hook process but NOT for arbitrary
  // terminal commands the agent runs. The plugin builds the command in a context where
  // the host IS known and stamps it on. Generalized from the original `--host=cursor`-only
  // check so Codex/Claude runners detect correctly too.
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith('--host=')) {
      const h = a.slice('--host='.length).trim();
      if (knownHost(h)) return h;
    }
  }
  const explicitEnvHost = typeof env.TRAFFIC_ONE_HOST === 'string' ? env.TRAFFIC_ONE_HOST.trim() : '';
  if (knownHost(explicitEnvHost)) return explicitEnvHost;
  if (env.CURSOR_PLUGIN_ROOT) return 'cursor';
  // Codex marks the hook subprocess at runtime. CODEX_PLUGIN_ROOT covers the CLI;
  // Codex Desktop instead sets CODEX_INTERNAL_ORIGINATOR_OVERRIDE (observed on every
  // Desktop hook invocation); CODEX_THREAD_ID is present on subagent threads. These
  // are process-scoped (not profile exports), so they don't misfire for Claude Code.
  // Getting this right matters: it selects the Codex model tier (gpt-5.x) for the
  // agent-model gate — host=claude here would wrongly demand opus/sonnet on Codex.
  if (env.CODEX_PLUGIN_ROOT || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || env.CODEX_THREAD_ID) return 'codex';
  return 'claude';
}
