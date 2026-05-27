'use strict';

const fs   = require('fs');
const path = require('path');

const { pluginRoot, isInPluginCache } = require('../config.cjs');
const { SKILLS_ACTIVE_DIR, BOOTSTRAP_SKILLS } = require('./_helpers.cjs');

// Remove every non-bootstrap skill directory from skills/ (plugin cache only).
// Called at the start of every SessionStart to reset cross-project leftovers.
function cleanActiveSkills() {
  if (!isInPluginCache()) return 0;
  const skillsDir = path.join(pluginRoot(), SKILLS_ACTIVE_DIR);
  if (!fs.existsSync(skillsDir)) return 0;
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (BOOTSTRAP_SKILLS.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort; prefer partial cleanup over failure
    }
  }
  return removed;
}

module.exports = { cleanActiveSkills };
