'use strict';

const fs = require('fs');
const path = require('path');

const { pluginRoot } = require('../config.cjs');
const { stackSpecForState, templatePath } = require('../stacks/stacks.cjs');
const { activeSkillsFor } = require('../skill-filters/skill-filters.cjs');
const { isPluginAuthoringRoot } = require('./isPluginAuthoringRoot.cjs');
const { isLeanMaterialization } = require('./isLeanMaterialization.cjs');
const {
  GENERATED_MARKER,
  toPosix,
  writeTextIfChanged,
  copySkillDir,
  loadPreviousManifest,
  cleanupPrevious,
  preserveManualRootContext,
  renderAgentsWithLocalContext,
  writeRootAgents,
  writeRootClaude,
  unique,
  modeRulesForState,
} = require('./_helpers.cjs');

function materializeProjectAssets(cwd, state) {
  if (isPluginAuthoringRoot(cwd)) {
    return {
      rules: 0,
      skills: 0,
      written: 0,
      removed: 0,
      contextProfile: 'plugin-authoring',
      skipped: 'plugin-authoring-root',
    };
  }

  const root = pluginRoot();
  const leanMode = isLeanMaterialization(cwd, state);
  const spec = stackSpecForState(state);
  const mandatoryRules = unique([
    ...spec.mandatory,
    ...modeRulesForState(root, state),
  ]).filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
  const referenceRules = unique(spec.optional)
    .filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
  const rules = unique([
    ...mandatoryRules,
    ...referenceRules,
  ]);
  const skills = [...activeSkillsFor(state)].filter((name) => fs.existsSync(path.join(root, 'skills-templates', name, 'SKILL.md'))).sort();
  const nextRulePaths = new Set(rules);
  const nextSkillNames = new Set(skills);
  const previous = loadPreviousManifest(cwd);
  const removed = cleanupPrevious(cwd, previous, nextRulePaths, nextSkillNames);

  let written = 0;
  const projectMemoryRoot = path.join(cwd, '.traffic-one');
  for (const relPath of rules) {
    const src = path.join(root, templatePath(relPath));
    const dst = path.join(projectMemoryRoot, relPath);
    const source = fs.readFileSync(src, 'utf8').trimEnd();
    const content = `${GENERATED_MARKER}\n<!-- SOURCE: ${templatePath(relPath)} -->\n\n${source}\n`;
    if (writeTextIfChanged(dst, content)) written += 1;
  }

  const skillsRoot = path.join(cwd, '.traffic-one', 'skills');
  for (const name of skills) {
    if (copySkillDir(path.join(root, 'skills-templates', name), path.join(skillsRoot, name))) {
      written += 1;
    }
  }

  if (preserveManualRootContext(cwd, 'AGENTS.md', state)) written += 1;
  if (preserveManualRootContext(cwd, 'CLAUDE.md', state)) written += 1;

  const localAgents = renderAgentsWithLocalContext(cwd, state, rules, skills, {
    mandatoryRules,
    referenceRules,
  });
  if (writeRootAgents(cwd, localAgents)) written += 1;
  if (writeRootClaude(cwd)) written += 1;

  const manifest = {
    generatedBy: 'traffic-one',
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    contextProfile: leanMode ? 'lean' : 'full',
    stack: state.stack || 'minimal',
    frontend: state.frontend || 'none',
    backend: state.backend || 'none',
    mobile: (state.mobile && state.mobile.framework) || 'none',
    rules: rules.map(toPosix),
    skills,
  };
  if (writeTextIfChanged(
    path.join(cwd, '.traffic-one', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )) {
    written += 1;
  }

  return { rules: rules.length, skills: skills.length, written, removed, contextProfile: leanMode ? 'lean' : 'full' };
}

module.exports = { materializeProjectAssets };
