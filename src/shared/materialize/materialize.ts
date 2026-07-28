// src/shared/materialize/materialize.ts
// The materialization writer: copies the active rules + skills into the project's
// .traffic-one/, renders AGENTS.md/CLAUDE.md, writes the manifest, and cleans up
// stale generated assets. Ported 1:1 from materializeProjectAssets.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { toPosix, writeTextIfChanged } from '../fs-text';
import { readText } from '../fsjson';
import { pluginRoot } from '../paths';
import { BOOTSTRAP_SKILLS, PROJECT_UNAVAILABLE_SKILLS } from '../../config/skill-filters';
import { activeSkillsForProject } from '../skill-filters';
import { capabilityProfileForRun, capabilityStateForRun } from '../architecture-contract';
import {
  capabilityProfileForProject,
  eligibleRolesForProfile,
  runtimeCapabilityStateFromProfile,
} from '../capabilities';
import { roleScopedRuleUnion, stackSpecForState, templatePath } from '../stacks';
import { nowIsoNoMs } from '../text';
import { detectHost } from '../host';
import {
  cleanupPrevious,
  loadPreviousManifest,
  modeReferenceRulesForState,
  modeRulesForState,
} from './cleanup';
import { writeCursorAgentFiles } from './cursor-agents';
import { writeCopilotAgentFiles } from './copilot-agents';
import { GENERATED_MARKER, copySkillDir } from './generated';
import { isLeanMaterialization } from './has-assets';
import { writeKiloAgentFiles } from './kilo-agents';
import { cleanupLegacyOpenCodeProjectAssets, refreshOpenCodeGlobalAgentFiles } from './opencode-assets';
import { preserveManualRootContext, renderAgentsWithLocalContext, writeRootAgents, writeRootClaude } from './render-agents';
import { writeWindsurfAgentFiles } from './windsurf-agents';
import { writeWindsurfHostAssets } from './windsurf-assets';

type Rec = Record<string, unknown>;

// Maintainer-only catalog tooling is classified centrally and must never be
// copied into a user's shared project artifacts, even if a future bucket is
// configured incorrectly.
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
  if (isNonProjectRoot(cwd)) {
    return { rules: 0, skills: 0, written: 0, removed: 0, contextProfile: 'plugin-authoring', skipped: 'plugin-authoring-root' };
  }

  const root = pluginRoot();
  const capabilityProfile = capabilityProfileForRun(cwd, state);
  const capabilityState = capabilityStateForRun(cwd, state);
  const leanMode = isLeanMaterialization(cwd, state);
  const spec = stackSpecForState(capabilityState);
  const mandatoryRules = unique([
    ...spec.mandatory,
    ...modeRulesForState(root, capabilityState, capabilityProfile.profileId),
  ])
    .filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
  const referenceRules = unique([
    ...spec.optional,
    ...modeReferenceRulesForState(root, capabilityState, capabilityProfile.profileId),
  ])
    .filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
  // Envelope-referenced rules: hash-only bootstrap envelopes carry no bodies,
  // so every rule id a role envelope can reference must stay readable under
  // .traffic-one/rules/**. capabilityProfile is already the active run's frozen
  // snapshot profile when a run is in flight (capabilityProfileForRun); union
  // in the live project profile so the NEXT run's envelopes are covered too.
  // Both resolve with frozen state={}, mirroring resolvedRoleMaterials
  // (run-bootstrap-policy.ts). Bodies for superseded non-current runs may
  // lapse after a profile change — gate validation is unaffected (it reads the
  // plugin), only the local copy.
  const envelopeProfiles = [capabilityProfile, capabilityProfileForProject(cwd, state)];
  const envelopeRules = unique(envelopeProfiles.flatMap((profile) => roleScopedRuleUnion(
    [...eligibleRolesForProfile(profile), 'quick-fix'],
    runtimeCapabilityStateFromProfile(profile, {}),
  ))).filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
  const rules = unique([...mandatoryRules, ...referenceRules, ...envelopeRules]);
  const host = detectHost();
  const skills = [...activeSkillsForProject(cwd, state, host)]
    .filter((name) => !BOOTSTRAP_SKILLS.has(name)) // bootstrap skills live in the host skills/ dir, not per-project
    .filter((name) => !PROJECT_UNAVAILABLE_SKILLS.has(name))
    .filter((name) => fs.existsSync(path.join(root, 'skills-catalog', name, 'SKILL.md')))
    .sort();

  const previous = loadPreviousManifest(cwd);
  let removed = cleanupPrevious(cwd, previous, new Set(rules), new Set(skills));

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
  const localAgents = renderAgentsWithLocalContext(cwd, capabilityState, rules, indexSkills, {
    mandatoryRules,
    referenceRules: unique([...referenceRules, ...envelopeRules]),
  });
  if (writeRootAgents(cwd, localAgents)) written += 1;
  if (writeRootClaude(cwd)) written += 1;

  // Host-native project role files are model-agnostic contracts. The active
  // user's plan, performance choice, and model lineup are injected at runtime
  // from local preferences rather than persisted in the shared project.
  if (detectHost() === 'cursor') written += writeCursorAgentFiles(cwd, capabilityState);
  if (detectHost() === 'copilot') written += writeCopilotAgentFiles(cwd, capabilityState);
  if (detectHost() === 'kilo') written += writeKiloAgentFiles(cwd, capabilityState);
  // Legacy project-local OpenCode assets are shared, so every host removes only
  // Traffic One-generated copies. Model-pinned replacements are user-local and
  // are written exclusively by the active OpenCode host.
  removed += cleanupLegacyOpenCodeProjectAssets(cwd);
  if (detectHost() === 'opencode') written += refreshOpenCodeGlobalAgentFiles(cwd, capabilityState);
  let windsurfAssets: ReturnType<typeof writeWindsurfHostAssets> | null = null;
  let windsurfAgents = 0;
  if (detectHost() === 'windsurf') {
    windsurfAssets = writeWindsurfHostAssets(cwd, rules);
    windsurfAgents = writeWindsurfAgentFiles(cwd, capabilityState);
    written += windsurfAssets.written;
    written += windsurfAgents;
    removed += windsurfAssets.removed;
  }

  const mobile = capabilityState.mobile as Rec | undefined;
  const manifestJson = (generatedAt: string): string => `${JSON.stringify({
    generatedBy: 'traffic-one',
    generatedAt,
    contextProfile: leanMode ? 'lean' : 'full',
    stack: (capabilityState.stack as string) || 'minimal',
    frontend: (capabilityState.frontend as string) || 'none',
    backend: (capabilityState.backend as string) || 'none',
    mobile: (mobile && (mobile.framework as string)) || 'none',
    rules: rules.map(toPosix),
    skills,
    ...(windsurfAssets ? { windsurf: { rules: windsurfAssets.rules, skills: windsurfAssets.skills, agents: windsurfAgents } } : {}),
  }, null, 2)}\n`;
  // `generatedAt` refreshes only when the manifest CONTENT changed — otherwise a
  // repeat materialization would rewrite the file every wall-clock second and
  // defeat writeTextIfChanged. Compare against the canonical path only (a
  // legacy rules/manifest.json simply rewrites once).
  const manifestPath = path.join(cwd, '.traffic-one', 'manifest.json');
  const prevGeneratedAt = typeof previous.generatedAt === 'string' ? previous.generatedAt : '';
  const manifestUnchanged = Boolean(prevGeneratedAt) && readText(manifestPath) === manifestJson(prevGeneratedAt);
  if (!manifestUnchanged && writeTextIfChanged(manifestPath, manifestJson(nowIsoNoMs()))) {
    written += 1;
  }

  return { rules: rules.length, skills: skills.length, written, removed, contextProfile: leanMode ? 'lean' : 'full' };
}
