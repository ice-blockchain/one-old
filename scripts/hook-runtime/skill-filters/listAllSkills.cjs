'use strict';

const fs   = require('fs');
const path = require('path');

const { pluginRoot } = require('../config.cjs');
const { SKILLS_ACTIVE_DIR } = require('./_helpers.cjs');

function listAllSkills() {
  const skillsDir = path.join(pluginRoot(), SKILLS_ACTIVE_DIR);
  if (!fs.existsSync(skillsDir)) {
    return new Set();
  }
  const out = new Set();
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      out.add(entry.name);
    }
  }
  return out;
}

module.exports = { listAllSkills };
