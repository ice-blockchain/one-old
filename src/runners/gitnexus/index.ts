// src/runners/gitnexus/index.ts
// CLI entry + public surface for the foreground GitNexus bootstrap (compiles to
// scripts/gitnexus-runner.cjs). Re-exports the nvm discovery helpers (consumed
// by doctor) and the bootstrap (consumed by the post-build code-graph hint and
// the orchestrator's Phase 5). Ported 1:1 from scripts/gitnexus-runner.cjs.

import { exec } from '../../shared/exec';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { nowIso } from '../../shared/text';
import { bootstrap } from './bootstrap';

export { bootstrap, ensureGitnexusTool, gitnexusGraphIsEmpty, gitnexusPackageSpec } from './bootstrap';
export type { BootstrapResult, BootstrapOpts, GitnexusToolResult } from './bootstrap';
export { CONFLICT_PATHS, GITNEXUS_MIN_NODE_MAJOR } from '../../config/gitnexus';
export {
  currentNodeMajor,
  findNvmNode22,
  nodeVersionMismatchMessage,
  nvmPresent,
} from './nvm';
export type { NvmNode22 } from './nvm';

// Legacy public surface re-exported the shared which()/nowIso() too.
export const which = exec.which;
export { nowIso };

export function main(): void {
  // --force: bypass the fresh-cache short-circuit. The orchestrator's phase-3
  // pre-step rebuilds the graph right after implementers land code — at that
  // moment the index is recent AND non-empty (the onboarding scan saw a couple
  // of files) yet covers none of the new code, so the mtime freshness check
  // wrongly answers "fresh" (observed live: 2 files indexed vs ~60 on disk).
  const result = bootstrap(resolveProjectRoot(process.cwd()), { force: process.argv.includes('--force') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

if (require.main === module) main();
