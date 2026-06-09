// src/shared/codegraph.ts
// Single source of truth for WHERE code-graph artifacts live. They live UNDER
// .traffic-one/ (gitignored) instead of polluting the project root. The provider
// CLIs have no output-dir flag (graphify always writes ./graphify-out, gitnexus
// always writes ./.gitnexus), so the runners run the tool as usual and then
// RELOCATE its root-level output under .traffic-one/ after a successful scan.

import * as fs from 'fs';
import * as path from 'path';

// Where the tools write (project root) — no output-dir flag exists.
export const GRAPHIFY_OUT_ROOT_DIRNAME = 'graphify-out';
export const GITNEXUS_ROOT_DIRNAME = '.gitnexus';

// Where Traffic One keeps them (relative to the project root).
export const GRAPHIFY_OUT_REL = path.join('.traffic-one', 'graphify-out');
export const GRAPHIFY_REPORT_REL = path.join(GRAPHIFY_OUT_REL, 'GRAPH_REPORT.md');
export const GITNEXUS_REL = path.join('.traffic-one', '.gitnexus');

// Move a tool's root-level output dir under .traffic-one/. No-op if the source
// is missing. cwd and cwd/.traffic-one are the same filesystem → rename is atomic.
// Best-effort: a relocation failure leaves the artifact in root rather than
// throwing (the caller's "produced?" check then reports it).
export function relocateUnderTrafficOne(cwd: string, rootDirname: string, destRel: string): void {
  const src = path.join(cwd, rootDirname);
  if (!fs.existsSync(src)) return;
  const dest = path.join(cwd, destRel);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
  } catch {
    // best-effort; leave the artifact in place rather than throw
  }
}
