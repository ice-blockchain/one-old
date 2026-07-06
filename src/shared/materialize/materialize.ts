// src/shared/materialize/materialize.ts
// The materialization writer: copies the active rules + skills into the project's
// .traffic-one/, renders AGENTS.md/CLAUDE.md, writes the manifest, and cleans up
// stale generated assets. Ported 1:1 from materializeProjectAssets.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { isPluginAuthoringRoot } from '../authoring-root';
import { toPosix, writeTextIfChanged } from '../fs-text';
import { pluginRoot } from '../paths';
import { BOOTSTRAP_SKILLS } from '../../config/skill-filters';
import { activeSkillsFor } from '../skill-filters';
import { stackSpecForState, templatePath } from '../stacks';
import { nowIsoNoMs } from '../text';
import { detectHost } from '../host';
import { cleanupPrevious, loadPreviousManifest, modeRulesForState } from './cleanup';
import { writeCursorAgentFiles } from './cursor-agents';
import { writeCopilotAgentFiles } from './copilot-agents';
import { GENERATED_MARKER, copySkillDir } from './generated';
import { isLeanMaterialization } from './has-assets';
import { writeOpenCodeHostAssets } from './opencode-assets';
import { preserveManualRootContext, renderAgentsWithLocalContext, writeRootAgents, writeRootClaude } from './render-agents';

type Rec = Record<string, unknown>;

export interface MaterializeResult {
  rules: number;
  skills: number;
  written: number;
  removed: number;
  contextProfile: string;
  skipped?: string;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// On-disk skill dirs (containing SKILL.md) that the manifest doesn't track.
function extraSkillDirs(skillsRoot: string, tracked: ReadonlySet<string>): string[] {
  try {
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !tracked.has(entry.name))
      .filter((entry) => fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function materializeProjectAssets(cwd: string, state: Rec): MaterializeResult {
  if (isPluginAuthoringRoot(cwd)) {
    return { rules: 0, skills: 0, written: 0, removed: 0, contextProfile: 'plugin-authoring', skipped: 'plugin-authoring-root' };
  }

  const root = pluginRoot();
  const leanMode = isLeanMaterialization(cwd, state);
  const spec = stackSpecForState(state);
  const mandatoryRules = unique([...spec.mandatory, ...modeRulesForState(root, state)])
    .filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
  const referenceRules = unique(spec.optional)
    .filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
  const rules = unique([...mandatoryRules, ...referenceRules]);
  const skills = [...activeSkillsFor(state)]
    .filter((name) => !BOOTSTRAP_SKILLS.has(name)) // bootstrap skills live in the host skills/ dir, not per-project
    .filter((name) => fs.existsSync(path.join(root, 'skills-catalog', name, 'SKILL.md')))
    .sort();

  const previous = loadPreviousManifest(cwd);
  const removed = cleanupPrevious(cwd, previous, new Set(rules), new Set(skills));

  let written = 0;
  const projectMemoryRoot = path.join(cwd, '.traffic-one');
  for (const relPath of rules) {
    const source = fs.readFileSync(path.join(root, templatePath(relPath)), 'utf8').trimEnd();
    const content = `${GENERATED_MARKER}\n<!-- SOURCE: ${templatePath(relPath)} -->\n\n${source}\n`;
    if (writeTextIfChanged(path.join(projectMemoryRoot, relPath), content)) written += 1;
  }

  const skillsRoot = path.join(cwd, '.traffic-one', 'skills');
  for (const name of skills) {
    if (copySkillDir(path.join(root, 'skills-catalog', name), path.join(skillsRoot, name))) written += 1;
  }

  if (preserveManualRootContext(cwd, 'AGENTS.md', state)) written += 1;
  if (preserveManualRootContext(cwd, 'CLAUDE.md', state)) written += 1;

  // Provider-adopted skills (e.g. gitnexus's, relocated by the graph runners)
  // live on disk but are deliberately NOT manifest-tracked (cleanup never sweeps
  // them). List them in the Active Skills index so agents discover them.
  const indexSkills = [...skills, ...extraSkillDirs(skillsRoot, new Set(skills))].sort();
  const localAgents = renderAgentsWithLocalContext(cwd, state, rules, indexSkills, { mandatoryRules, referenceRules });
  if (writeRootAgents(cwd, localAgents)) written += 1;
  if (writeRootClaude(cwd)) written += 1;

  // Cursor-only: native per-role subagent files (.cursor/agents/<role>.md) with the
  // resolved tier model pinned in frontmatter. The frontmatter is a source for the
  // orchestrator to read and pass as the Task `model` parameter; Cursor does not reliably
  // auto-apply it, so the spawn gate still enforces the passed model arg.
  if (detectHost() === 'cursor') written += writeCursorAgentFiles(cwd, state);
  if (detectHost() === 'copilot') written += writeCopilotAgentFiles(cwd, state);
  if (detectHost() === 'opencode') written += writeOpenCodeHostAssets(cwd, state, skills);

  const mobile = state.mobile as Rec | undefined;
  const manifest = {
    generatedBy: 'traffic-one',
    generatedAt: nowIsoNoMs(),
    contextProfile: leanMode ? 'lean' : 'full',
    stack: (state.stack as string) || 'minimal',
    frontend: (state.frontend as string) || 'none',
    backend: (state.backend as string) || 'none',
    mobile: (mobile && (mobile.framework as string)) || 'none',
    rules: rules.map(toPosix),
    skills,
  };
  if (writeTextIfChanged(path.join(cwd, '.traffic-one', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)) {
    written += 1;
  }

  return { rules: rules.length, skills: skills.length, written, removed, contextProfile: leanMode ? 'lean' : 'full' };
}
