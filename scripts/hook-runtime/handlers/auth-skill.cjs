'use strict';

// scripts/hook-runtime/handlers/auth-skill.cjs
// Reads the editable `traffic-one:auth` skill markdown and extracts the
// per-branch directive text the auth gate emits. This is the bridge that lets
// the auth FLOW WORDING live in the `skills/auth/SKILL.md` default skill (easily
// customised) while the deterministic decision + enforcement stays in auth.cjs.
//
// The skill carries the verbatim directive text inside fenced markers:
//   <!-- T1AUTH:BEGIN <name> -->
//   ...exact text, may contain {{PLACEHOLDER}} tokens...
//   <!-- T1AUTH:END <name> -->
// `authSkillBlock(name, vars, fallback)` returns that text with placeholders
// substituted. If the skill file or block is missing/malformed it returns the
// supplied fallback (the gate stays functional and enforcement is unaffected,
// since blocking lives in auth.cjs, not here).

const fs = require('fs');
const path = require('path');

const { pluginRoot } = require('../config.cjs');

// The auth skill is a DEFAULT (registered + bootstrap) plugin skill, so it
// lives in the plugin's `skills/` dir (declared via plugin.json "skills":
// "./skills/") and is always present — including before any project
// materialization, which is exactly when the auth gate first fires. It is NOT
// in skills-templates/ (that library only becomes active post-materialization).
const SKILL_REL_PATH = path.join('skills', 'auth', 'SKILL.md');

let cachedSource;

function authSkillSource() {
  if (cachedSource !== undefined) return cachedSource;
  try {
    cachedSource = fs.readFileSync(path.join(pluginRoot(), SKILL_REL_PATH), 'utf8');
  } catch {
    cachedSource = '';
  }
  return cachedSource;
}

// Extract the verbatim text between the BEGIN/END markers for `name`. Strips
// exactly one newline immediately after BEGIN and one immediately before END
// (the marker-adjacent line breaks), leaving the authored block body intact.
function extractBlock(source, name) {
  const begin = `<!-- T1AUTH:BEGIN ${name} -->`;
  const end = `<!-- T1AUTH:END ${name} -->`;
  const startIdx = source.indexOf(begin);
  if (startIdx === -1) return null;
  const bodyStart = startIdx + begin.length;
  const endIdx = source.indexOf(end, bodyStart);
  if (endIdx === -1) return null;
  return source.slice(bodyStart, endIdx).replace(/^\n/, '').replace(/\n$/, '');
}

function applyVars(text, vars) {
  let out = text;
  for (const [key, value] of Object.entries(vars || {})) {
    out = out.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }
  return out;
}

function authSkillBlock(name, vars = {}, fallback = '') {
  const source = authSkillSource();
  const body = source ? extractBlock(source, name) : null;
  return applyVars(body == null ? fallback : body, vars);
}

module.exports = { authSkillBlock, authSkillSource, extractBlock };
