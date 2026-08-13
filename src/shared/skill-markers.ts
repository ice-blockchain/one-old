// src/shared/skill-markers.ts
// The `T1BLOCK` marker grammar and nothing else: how a block is delimited, how
// its body is sliced out, how the names in a SKILL.md are enumerated, and how
// `{{VARS}}` are substituted.
//
// It is a separate module from skill-block.ts for ONE structural reason. The
// assembler in skill-block.ts imports the GENERATED fallback table
// (skill-fallbacks.generated.ts), and that table is produced by
// build/gen-skill-fallbacks.ts, which needs exactly the four functions below to
// read the blocks it emits. Had they stayed in skill-block.ts the generator
// would import its own output transitively, so deleting the generated file
// would break the one command that recreates it. Here, the generator depends on
// the grammar and the grammar depends on nothing.
//
// skill-block.ts re-exports `extractBlock` and `applyVars`, so every existing
// importer keeps its spelling.

export const MARKER = 'T1BLOCK';

const begin = (name: string): string => `<!-- ${MARKER}:BEGIN ${name} -->`;
const end = (name: string): string => `<!-- ${MARKER}:END ${name} -->`;

export function extractBlock(source: string, name: string): string | null {
  const startIdx = source.indexOf(begin(name));
  if (startIdx === -1) return null;
  const bodyStart = startIdx + begin(name).length;
  const endIdx = source.indexOf(end(name), bodyStart);
  if (endIdx === -1) return null;
  return source.slice(bodyStart, endIdx).replace(/^\n/, '').replace(/\n$/, '');
}

/**
 * Every block name in `source` that `extractBlock` can actually resolve, in
 * document order.
 *
 * The END marker is REQUIRED, matching the runtime: an unterminated BEGIN is
 * not a block, it is a typo that `extractBlock` returns null for. Enumerating
 * on BEGIN alone would put a name in the generated table whose body the runtime
 * cannot read — the exact drift the table exists to remove.
 */
export function listBlockNames(source: string): string[] {
  const names: string[] = [];
  const pattern = new RegExp(`<!-- ${MARKER}:BEGIN ([^\\s>]+) -->`, 'g');
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined && extractBlock(source, name) !== null) names.push(name);
  }
  return names;
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

/** The key both the generated table and the census label a block with. */
export function fallbackKey(moduleId: string, blockName: string): string {
  return `${moduleId} :: ${blockName}`;
}
