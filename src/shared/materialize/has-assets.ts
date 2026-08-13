// src/shared/materialize/has-assets.ts
// Materialization presence checks. Ported 1:1 from
// scripts/hook-runtime/materialize/{hasMaterializedProjectAssets,isLeanMaterialization}.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { BOOTSTRAP_SKILLS, PROJECT_UNAVAILABLE_SKILLS } from '../../config/skill-filters';
import { capabilityStateForRun } from '../architecture-contract';
import { readRegularFileOrThrow } from '../bounded-read';
import { toPosix } from '../fs-text';
import { detectHost } from '../host';
import { activeSkillsForProject } from '../skill-filters';
import { stackSpecForState } from '../stacks';
import { isGenerated } from './generated';
import { pluginContentHash } from '../build-provenance';

type Rec = Record<string, unknown>;

function readManifest(cwd: string): Rec | null {
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(path.join(cwd, '.traffic-one', 'manifest.json')));
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

/**
 * THE UPGRADE SIGNAL: were these bytes copied from the plugin build that is
 * installed right now?
 *
 * The fourth condition in materializeProjectIfNeeded's conjunction, and — like
 * `materializedContentIsIncomplete` above — a sibling of `isMaterialized`
 * rather than a refinement of it. It has to be: the answer lives on DISK (the
 * project's manifest and the plugin root's `build-provenance.json`), and
 * `isMaterialized(state)` is a pure function of state consulted from five call
 * sites and from gates that must not start doing file IO. Same shape, same
 * reason, as the incompleteness check.
 *
 * What it replaces is the version comparison inside `isMaterialized`, which is
 * a number a human has to remember to bump and measurably did not: 11 of the
 * last 14 content commits in this repo shipped without one (see
 * shared/build-provenance.ts). The version check is LEFT IN PLACE — it is free, it is
 * already stamped, and it catches the one case a source hash cannot (a release
 * whose only change is package.json's version, which a dirty-tree `sourceHash`
 * does not cover because it hashes `src/**` only). Two stamped signals, either
 * of which can say "stale"; neither can say "fresh" on its own.
 *
 * THREE ways to be quiet, and each is deliberate:
 *   - the plugin root cannot state a build identity (`null`) — a source
 *     checkout, a fixture root, a partial tree. Answering "stale" there would
 *     re-converge on every hook against a root materializeProjectAssets refuses
 *     anyway, and would never self-heal because a refusal writes no manifest.
 *   - no manifest, or a manifest this product did not write. Not ours to judge;
 *     `hasMaterializedProjectAssets` already answers that question.
 *   - the manifest's stamp equals the root's. The steady state.
 *
 * An ABSENT `pluginContentHash` on a real Traffic One manifest is stale, and
 * that is the transition: every project already on disk was materialized before
 * this field existed, so each one re-converges EXACTLY ONCE against a healthy
 * root. The pass rewrites the manifest — the new field alone changes its bytes,
 * so `manifestUnchanged` in materialize.ts is false even when every rule and
 * skill is byte-identical — and the stamp lands, after which this goes quiet
 * for that build. Treating the absent field as fresh instead would leave every
 * existing install carrying the defect forever, which is the whole reason this
 * exists.
 *
 * Answering true is permission to try again, not a repair, and it disturbs no
 * refusal: materializeProjectAssets still refuses a source checkout, an
 * unverified root, an empty resolved set, and a TORN one (the refusal that kept
 * 46 of 47 skills alive), and a refused run stamps nothing.
 */
export function materializedFromDifferentPluginBuild(cwd: string): boolean {
  const installed = pluginContentHash();
  if (!installed) return false;
  const manifest = readManifest(cwd);
  if (!manifest || manifest.generatedBy !== 'traffic-one') return false;
  const stamped = typeof manifest.pluginContentHash === 'string' ? manifest.pluginContentHash.trim() : '';
  return stamped !== installed;
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
