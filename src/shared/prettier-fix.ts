// src/shared/prettier-fix.ts
// Deterministic collapse auto-fix: resolve the PROJECT'S OWN prettier binary
// from a file's package scope (nearest `node_modules/.bin` walking up to the
// project root — the same nearest-package resolution the OpenCode post-apply
// verifier uses) and run it. Shared by the structural write gate, the frontend
// completion gate, and the OpenCode post-apply quality check so all three give
// the same answer to "can the formatter fix this instead of a deny?". A missing
// binary (pre-install) simply returns null — absence of a formatter is the
// status quo and the caller keeps its deny.

import * as fs from 'fs';
import * as path from 'path';

import { spawnTool } from './spawn-tool';

const FORMAT_TIMEOUT_MS = 30_000;

function prettierBinName(): string {
  return process.platform === 'win32' ? 'prettier.cmd' : 'prettier';
}

/**
 * The project-local prettier binary governing `relFile`, or null when none is
 * reachable (pre-install). Walks from the file's directory up to the project
 * root so a workspace package's own toolchain wins over a hoisted root one.
 */
export function resolveProjectPrettier(projectRoot: string, relFile: string): string | null {
  const root = path.resolve(projectRoot);
  let dir = path.resolve(root, path.dirname(relFile));
  if (!dir.startsWith(root)) dir = root;
  while (true) {
    const bin = path.join(dir, 'node_modules', '.bin', prettierBinName());
    if (fs.existsSync(bin)) return bin;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

// There is deliberately NO "format the proposed write content" helper here.
// One existed and the write gate used it to wave `STRUCT_COLLAPSED_LINE`
// through: it formatted the pending text in memory, used the result only as a
// predicate, discarded it, and let the ORIGINAL collapsed content land. Two
// things make that unfixable in place — the gate has no content-substitution
// channel (`updatedToolInput` is Claude-only, so Codex could never use it), and
// resolution below depends on install state, which would make the same
// byte-identical write denied pre-install and allowed post-install. Collapse is
// now an unconditional deny at write time; formatting happens on disk, after the
// file exists, through `formatFileWithPrettier`.

/** `prettier --write` on a file already on disk. True only on a clean exit. */
export function formatFileWithPrettier(
  bin: string,
  projectRoot: string,
  relFile: string,
): boolean {
  try {
    const run = spawnTool(bin, ['--write', path.resolve(projectRoot, relFile)], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FORMAT_TIMEOUT_MS,
    });
    return !run.error && run.status === 0;
  } catch {
    return false;
  }
}
