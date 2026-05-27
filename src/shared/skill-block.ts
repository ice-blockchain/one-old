// src/shared/skill-block.ts
// Generalised auth `T1AUTH` bridge → `T1BLOCK`. Any module keeps its agent-facing
// directive PROSE in modules/<id>/skill/SKILL.md inside fenced markers:
//   <!-- T1BLOCK:BEGIN <name> -->  ...text, may contain {{VARS}}...  <!-- T1BLOCK:END <name> -->
// skillBlock(id, name, vars, fallback) returns that text with vars substituted,
// or `fallback` if the file/block is missing — so logic in code never embeds
// prose, and a missing block never breaks enforcement (logic lives in the gate).

import * as fs from 'fs';
import * as path from 'path';

import type { SkillBlockFn } from '../core/types';

const MARKER = 'T1BLOCK';

export function extractBlock(source: string, name: string): string | null {
  const begin = `<!-- ${MARKER}:BEGIN ${name} -->`;
  const end = `<!-- ${MARKER}:END ${name} -->`;
  const startIdx = source.indexOf(begin);
  if (startIdx === -1) return null;
  const bodyStart = startIdx + begin.length;
  const endIdx = source.indexOf(end, bodyStart);
  if (endIdx === -1) return null;
  return source.slice(bodyStart, endIdx).replace(/^\n/, '').replace(/\n$/, '');
}

export function applyVars(
  text: string,
  vars: Record<string, string | number | null | undefined> = {},
): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }
  return out;
}

export function makeSkillBlock(resolvePluginRoot: () => string): SkillBlockFn {
  const cache = new Map<string, string>();
  return (moduleId, blockName, vars, fallback = '') => {
    let source = cache.get(moduleId);
    if (source === undefined) {
      try {
        source = fs.readFileSync(
          path.join(resolvePluginRoot(), 'src', 'modules', moduleId, 'skill', 'SKILL.md'),
          'utf8',
        );
      } catch {
        source = '';
      }
      cache.set(moduleId, source);
    }
    const body = source ? extractBlock(source, blockName) : null;
    return applyVars(body == null ? fallback : body, vars);
  };
}
