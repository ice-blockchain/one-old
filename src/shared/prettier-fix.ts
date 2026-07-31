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

/**
 * Format proposed WRITE CONTENT (not yet on disk) through the resolved
 * prettier via `--stdin-filepath`, so the project's own config applies to the
 * exact target path. Returns the formatted text, or null when the formatter
 * errors/times out — the caller treats null as "auto-fix failed" and denies.
 */
export function formatTextWithPrettier(
  bin: string,
  projectRoot: string,
  relFile: string,
  text: string,
): string | null {
  try {
    const run = spawnTool(bin, ['--stdin-filepath', path.resolve(projectRoot, relFile)], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: text,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: FORMAT_TIMEOUT_MS,
    });
    if (run.error || run.status !== 0 || typeof run.stdout !== 'string' || !run.stdout) return null;
    return run.stdout;
  } catch {
    return null;
  }
}

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
