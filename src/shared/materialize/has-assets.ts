// src/shared/materialize/has-assets.ts
// Materialization presence checks. Ported 1:1 from
// scripts/hook-runtime/materialize/{hasMaterializedProjectAssets,isLeanMaterialization}.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { BOOTSTRAP_SKILLS, PROJECT_UNAVAILABLE_SKILLS } from '../../config/skill-filters';
import { capabilityStateForRun } from '../architecture-contract';
import { toPosix } from '../fs-text';
import { detectHost } from '../host';
import { activeSkillsForProject } from '../skill-filters';
import { stackSpecForState } from '../stacks';
import { isGenerated } from './generated';

type Rec = Record<string, unknown>;

function readManifest(cwd: string): Rec | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'manifest.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Rec) : null;
  } catch {
    return null;
  }
}

function trackedSet(manifest: Rec, key: 'rules' | 'skills'): Set<string> {
  const value = manifest[key];
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
}

/**
 * THE SELF-HEAL for a project whose manifest was already truncated.
 *
 * Every other check in this file asks "is what the manifest CLAIMS still on
 * disk". That is blind to the failure the tornRootRefusal in materialize.ts now
 * prevents but cannot undo: a project materialized from a partially copied
 * plugin root has a manifest listing 1 skill, that 1 skill on disk, a
 * `materializedAt` stamp, and nothing anywhere that looks wrong. From then on
 * `isMaterialized(state) && hasMaterializedProjectAssets(cwd)` short-circuits
 * every convergence attempt, so the other 46 skills never come back — the
 * refusal protects the remaining copy but a project that already lost it stays
 * lost, for the life of the plugin version.
 *
 * So the manifest is compared against the CONTENT SET THE RUNTIME DECLARES for
 * this project — the mandatory rule spine (stacks.ts) and the active skill
 * buckets (config/skill-filters.ts) — the same config-side authority
 * materializeProjectAssets resolves from, and deliberately not against the
 * plugin tree: this must answer "is the project short" even while the root that
 * shortchanged it is still broken, and it must cost no plugin-root stat on a
 * path that runs at every hook.
 *
 * Subset, never equality: a manifest may legitimately carry MORE than this (the
 * reference and envelope rule sets, setup-era rules a maintenance-phase
 * manifest no longer indexes, a provider-adopted skill). Only a project missing
 * something the runtime says it must have re-converges.
 *
 * Answering true is not a repair, it is permission to try again: convergence
 * calls the writer, which either materializes the full set (a healthy root) or
 * refuses and reports the torn one. Both are better than the silent
 * short-circuit, and both are self-limiting — a successful run rewrites the
 * manifest and this goes quiet.
 */
export function materializedContentIsIncomplete(cwd: string, state?: Rec): boolean {
  const manifest = readManifest(cwd);
  if (!manifest || manifest.generatedBy !== 'traffic-one') return false;

  const trackedRules = trackedSet(manifest, 'rules');
  const mandatory = stackSpecForState(capabilityStateForRun(cwd, state)).mandatory;
  if (mandatory.some((relPath) => !trackedRules.has(toPosix(relPath)))) return true;

  const trackedSkills = trackedSet(manifest, 'skills');
  for (const name of activeSkillsForProject(cwd, state, detectHost())) {
    if (BOOTSTRAP_SKILLS.has(name) || PROJECT_UNAVAILABLE_SKILLS.has(name)) continue;
    if (!trackedSkills.has(name)) return true;
  }
  return false;
}

export function hasMaterializedProjectAssets(cwd: string, state?: Rec): boolean {
  const manifest = readManifest(cwd);
  if (!manifest) return false;

  if (manifest.generatedBy !== 'traffic-one') return false;
  if (state && typeof manifest.stack === 'string' && state.stack && manifest.stack !== state.stack) return false;

  const rules = manifest.rules;
  const skills = manifest.skills;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  if (!Array.isArray(skills) || skills.length === 0) return false;

  if (!fs.existsSync(path.join(cwd, 'AGENTS.md')) || !isGenerated(path.join(cwd, 'AGENTS.md'))) return false;
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) return false;

  for (const relPath of rules as string[]) {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', relPath))) return false;
  }
  for (const name of skills as string[]) {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', 'skills', name, 'SKILL.md'))) return false;
  }
  return true;
}

export function isLeanMaterialization(_cwd: string, state?: Rec): boolean {
  if (state && (state.leanMode === false || state.contextMode === 'full' || state.tokenProfile === 'full')) {
    return false;
  }
  return true;
}
