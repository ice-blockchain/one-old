'use strict';

const fs   = require('fs');
const path = require('path');

const { pluginRoot, isInPluginCache } = require('../config.cjs');
const {
  SKILLS_TEMPLATES_DIR,
  SKILLS_ACTIVE_DIR,
  BOOTSTRAP_SKILLS,
  copyDirSync,
} = require('./_helpers.cjs');
const { activeSkillsFor } = require('./activeSkillsFor.cjs');

// Copy the active skill set for the given stack from skills-templates/ into
// skills/. Idempotent: already-present dirs are skipped. Returns count copied.
function copyActiveSkills(stackOrState) {
  if (!isInPluginCache()) return 0;
  const templatesDir = path.join(pluginRoot(), SKILLS_TEMPLATES_DIR);
  const activeDir    = path.join(pluginRoot(), SKILLS_ACTIVE_DIR);
  if (!fs.existsSync(templatesDir)) return 0;
  if (!fs.existsSync(activeDir)) {
    try { fs.mkdirSync(activeDir, { recursive: true }); } catch { return 0; }
  }
  const active = activeSkillsFor(stackOrState);
  let copied = 0;
  for (const name of active) {
    if (BOOTSTRAP_SKILLS.has(name)) continue;
    const src = path.join(templatesDir, name);
    const dst = path.join(activeDir, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) continue;
    try {
      copyDirSync(src, dst);
      copied += 1;
    } catch {
      // best-effort; prefer partial copy over failure
    }
  }
  return copied;
}

module.exports = { copyActiveSkills };
