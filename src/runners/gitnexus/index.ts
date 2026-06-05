// src/runners/gitnexus/index.ts
// CLI entry + public surface for the foreground GitNexus bootstrap (compiles to
// scripts/gitnexus-runner.cjs). Re-exports the nvm discovery helpers (consumed
// by doctor) and the bootstrap (consumed by the post-build code-graph hint and
// the orchestrator's Phase 5). Ported 1:1 from scripts/gitnexus-runner.cjs.

import { exec } from '../../shared/exec';
import { nowIso } from '../../shared/text';
import { bootstrap } from './bootstrap';

export { bootstrap, ensureGitnexusTool, gitnexusGraphIsEmpty } from './bootstrap';
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
  const result = bootstrap(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

if (require.main === module) main();
