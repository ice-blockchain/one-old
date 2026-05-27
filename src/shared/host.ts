// src/shared/host.ts
// Decide which host wire shape we're speaking. Claude and Codex share the nested
// hookSpecificOutput shape (and the raw→canonical tool mapping handles both tool
// vocabularies), so they use the same adapter; Cursor is the flat-JSON outlier
// and announces itself via `--host=cursor` from its own entry script.

import type { HostId } from '../core/types';

export function detectHost(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): HostId {
  if (argv.includes('--host=cursor') || env.CURSOR_PLUGIN_ROOT) return 'cursor';
  if (env.CODEX_PLUGIN_ROOT) return 'codex';
  return 'claude';
}
