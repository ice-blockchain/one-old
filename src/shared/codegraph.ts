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

// Graph providers (gitnexus today) also auto-write agent skills under
// .claude/skills/ — sometimes grouped (e.g. .claude/skills/gitnexus/<name>/).
// Those belong with Traffic One's per-project skills: move every LEAF skill dir
// (a dir containing SKILL.md) into .traffic-one/skills/<name>/ so they live
// beside the materialized set (the materializer's cleanup never touches them —
// they are not manifest-tracked). Existing destinations are preserved; emptied
// group dirs (and an emptied .claude/skills) are removed. Returns the relocated
// skill names. Best-effort: never throws.
export function relocateProviderSkills(cwd: string): string[] {
  const sourceRoot = path.join(cwd, '.claude', 'skills');
  const destRoot = path.join(cwd, '.traffic-one', 'skills');
  const relocated: string[] = [];
  try {
    if (!fs.existsSync(sourceRoot)) return relocated;

    const leafSkillDirs: string[] = [];
    const collect = (dir: string): void => {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        leafSkillDirs.push(dir);
        return;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) collect(path.join(dir, entry.name));
      }
    };
    collect(sourceRoot);

    for (const skillDir of leafSkillDirs) {
      const name = path.basename(skillDir);
      const dest = path.join(destRoot, name);
      try {
        if (fs.existsSync(dest)) continue; // never clobber an existing skill
        fs.mkdirSync(destRoot, { recursive: true });
        fs.renameSync(skillDir, dest);
        relocated.push(name);
      } catch {
        // best-effort per skill
      }
    }

    // Sweep now-empty group dirs, then .claude/skills (and .claude) if emptied.
    const removeIfEmpty = (dir: string): void => {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // best-effort
      }
    };
    try {
      for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) removeIfEmpty(path.join(sourceRoot, entry.name));
      }
    } catch {
      // best-effort
    }
    removeIfEmpty(sourceRoot);
    removeIfEmpty(path.join(cwd, '.claude'));
  } catch {
    // best-effort
  }
  return relocated.sort();
}
