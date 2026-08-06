// src/shared/materialize/__tests__/fixtures/materialized-content.ts
// What a FULLY materialized project's content half looks like, for the fixtures
// across the suite that need one.
//
// Hand-rolling `manifest.json` with one rule and one skill used to be enough to
// make isMaterialized() + hasMaterializedProjectAssets() true, and a dozen
// fixtures did exactly that. It is no longer an honest fixture: that shape is
// indistinguishable from a project truncated by a partially copied plugin root
// (materialize.ts tornRootRefusal describes the incident), and
// materializedContentIsIncomplete (has-assets.ts) deliberately re-converges it so
// the content it lost can come back. A fixture that stayed short would assert the
// OPPOSITE of the product behaviour, and would do it by short-circuiting the very
// writer the test claims to be exercising.
//
// So the declared set is derived from the same config-side authority the writer
// resolves from — the stack's mandatory rule spine (shared/stacks) and the active
// skill buckets (config/skill-filters) — which also keeps these fixtures correct
// as that set evolves.

import * as fs from 'fs';
import * as path from 'path';

import { BOOTSTRAP_SKILLS, PROJECT_UNAVAILABLE_SKILLS } from '../../../../config/skill-filters';
import { capabilityStateForRun } from '../../../architecture-contract';
import { detectHost } from '../../../host';
import { activeSkillsForProject } from '../../../skill-filters';
import { stackSpecForState } from '../../../stacks';
import { GENERATED_MARKER } from '../../generated';

type Rec = Record<string, unknown>;

export interface ProjectContent {
  rules: string[];
  skills: string[];
}

// The project's own shared state, which is what the hooks read. Callers that have
// the object in hand may pass it; the ones that wrote it to disk a moment ago do
// not have to keep it around.
function projectState(cwd: string, state?: Rec): Rec {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Rec) : {};
  } catch {
    return {};
  }
}

export function declaredProjectContent(cwd: string, state?: Rec): ProjectContent {
  const resolved = projectState(cwd, state);
  return {
    rules: stackSpecForState(capabilityStateForRun(cwd, resolved)).mandatory,
    skills: [...activeSkillsForProject(cwd, resolved, detectHost())]
      .filter((name) => !BOOTSTRAP_SKILLS.has(name) && !PROJECT_UNAVAILABLE_SKILLS.has(name))
      .sort(),
  };
}

export interface MaterializedContentOptions {
  // Defaults to the project's own `.traffic-one/.one.json`.
  state?: Rec;
  // The manifest's `stack` field, which hasMaterializedProjectAssets compares
  // against the state's. Defaults to the resolved state's stack.
  stack?: string;
  // Entries the CURRENT config does not declare — the shape of a project
  // materialized by an older release that has since retired them, which is what a
  // legitimate upgrade looks like from the project's side.
  extra?: Partial<ProjectContent>;
}

/**
 * Writes `.traffic-one/manifest.json` plus every declared rule file and skill dir,
 * each carrying the GENERATED marker so the cleanup path is willing to sweep them
 * (a fixture without it makes "nothing was deleted" prove nothing).
 *
 * Returns what it wrote, so a caller can assert against the same set.
 */
export function writeMaterializedContent(cwd: string, opts?: MaterializedContentOptions): ProjectContent {
  const state = projectState(cwd, opts?.state);
  const declared = declaredProjectContent(cwd, state);
  const rules = [...declared.rules, ...(opts?.extra?.rules ?? [])];
  const skills = [...declared.skills, ...(opts?.extra?.skills ?? [])];
  const t1 = path.join(cwd, '.traffic-one');
  for (const relPath of rules) {
    const target = path.join(t1, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${GENERATED_MARKER}\n\n# ${relPath}\n`, 'utf8');
  }
  for (const name of skills) {
    fs.mkdirSync(path.join(t1, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(t1, 'skills', name, 'SKILL.md'), `# ${name}\n\n${GENERATED_MARKER}\n`, 'utf8');
  }
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(path.join(t1, 'manifest.json'), `${JSON.stringify({
    generatedBy: 'traffic-one', stack: opts?.stack ?? ((state.stack as string) || 'default'), rules, skills,
  }, null, 2)}\n`, 'utf8');
  return { rules, skills };
}
