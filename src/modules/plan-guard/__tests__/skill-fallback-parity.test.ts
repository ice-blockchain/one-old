// src/modules/plan-guard/__tests__/skill-fallback-parity.test.ts
// Four plan-guard denies used to live only in TypeScript: the call site passed
// a verbatim fallback, no `T1BLOCK` existed, and SKILL.md — the operator-facing,
// product-owner-reviewable surface — did not describe them at all. They were
// authored into skill/SKILL.md as byte-exact transcriptions, so the rendered
// deny did not move: 25 cells across the four denies' full var grids hash
// identically before and after.
//
// Transcription is what creates the risk this file exists for. There are now
// TWO copies of each of these paragraphs — the T1BLOCK that ships and the TS
// fallback that renders when SKILL.md is unreachable — and nothing in the type
// system pairs them. Editing one is silent. So the pairing is asserted here,
// mechanically, in the only place the two can be compared: the SKILL.md body
// with `{{VAR}}` substituted back to the exact `${expression}` the TS template
// interpolates must be a SUBSTRING OF THE TS SOURCE, character for character.
//
// Deliberately not a "do these two look similar" check. The repo already has
// pairs that drifted into paraphrase — `no-any` ships "Avoid `any` — use
// `unknown` and narrow types" while its fallback says "Avoid the any type — use
// unknown and narrow types" — which reads fine and is exactly how a fallback
// stops being verbatim. An equality on the raw bytes is the only assertion that
// catches the first character of that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { extractBlock } from '../../../shared/skill-block';

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8');

interface Pair {
  /** The T1BLOCK name, which is also the name the call site asks for. */
  readonly block: string;
  /** The file whose fallback template must match, relative to modules/plan-guard. */
  readonly source: string;
  /**
   * `{{VAR}}` in SKILL.md → the exact `${…}` expression text in the TS
   * template literal. Read off the call site, because the var NAME and the
   * expression are unrelated: `{{TARGET}}` is `${filePath}`, `{{FILE}}` is
   * `${collapsed.file}`.
   */
  readonly vars: Readonly<Record<string, string>>;
}

const PAIRS: readonly Pair[] = [
  { block: 'runtime-sidecar-owner-gate', source: 'plan-readiness/index.ts', vars: { TARGET: '${filePath}' } },
  { block: 'implementer-collapse-gate', source: 'plan-readiness/completion.ts', vars: { FILE: '${collapsed.file}' } },
  { block: 'run-team-runtime-contract-invalid', source: 'plan-runteam.ts', vars: {} },
  { block: 'run-id-mismatch', source: 'plan-runid.ts', vars: { EXPECTED: '${currentRunId}', WRONG: '${stray}' } },
  // The two whose PROSE was rewritten before being transcribed (each prescribed
  // an action its own addressee could not take; the first also dropped the
  // `TARGETS` var its call site passes, so the deny never named the paths that
  // fell outside the allowlist). `${targets}` is a local hoisted at the call
  // site, guarded so the sentence cannot render an empty pair of backticks.
  { block: 'run-team-quick-fix-contract', source: 'plan-runteam.ts', vars: { TARGETS: '${targets}' } },
  { block: 'architecture-input-owner-gate', source: 'plan-readiness/index.ts', vars: { ROLE: '${writerRole}' } },
  // The seventh, and the only one whose fallback was a SINGLE-QUOTED string
  // rather than a template literal — so `asTemplateLiteralBody` below could not
  // match it at all until the call site was converted, escaped backticks and
  // all. It renders no placeholder, hence `vars: {}`.
  { block: 'reset-record-owner-gate', source: 'plan-readiness/index.ts', vars: {} },
];

// A TS template literal has exactly three characters it CANNOT hold as itself —
// a backtick, a backslash, and the two-character sequence `${` — and SKILL.md
// holds all three plainly. Undo those escapes and nothing else; anything else
// that differs is drift. The list is the language's, not a judgement call: a
// paragraph that spells a shell expansion (`${v%pat}`) or an ANSI-C escape
// (`\x73`) can only reach a fallback template escaped, so refusing to model
// that would mean the prose could never say either.
function asTemplateLiteralBody(markdown: string, vars: Readonly<Record<string, string>>): string {
  let out = markdown.split('\\').join('\\\\').split('`').join('\\`').split('${').join('\\${');
  for (const [name, expression] of Object.entries(vars)) out = out.split(`{{${name}}}`).join(expression);
  return out;
}

test('each transcribed plan-guard block is byte-identical to the TS fallback it was copied from', () => {
  const drifted: string[] = [];
  for (const pair of PAIRS) {
    const body = extractBlock(SKILL, pair.block);
    assert.ok(
      body,
      `${pair.block} has no T1BLOCK in plan-guard/skill/SKILL.md. It was authored on purpose — if it is being `
      + 'removed, delete its row here and restore it to TS_ONLY_PROSE in shared/__tests__/skill-block-coverage.test.ts '
      + 'in the same change.',
    );
    const source = fs.readFileSync(path.join(__dirname, '..', pair.source), 'utf8');
    const expected = asTemplateLiteralBody(body, pair.vars);
    if (!source.includes(expected)) drifted.push(`${pair.block} (${pair.source}):\n    expected in source: ${expected}`);
  }
  assert.deepEqual(
    drifted, [],
    `${drifted.length} deny paragraph(s) no longer match between skill/SKILL.md and the TS fallback. Whichever you `
    + 'edited, apply the same edit to the other: SKILL.md is what ships and what the operator reviews, the fallback is '
    + `what renders when SKILL.md cannot be read, and an agent must not be refused with two different reasons:\n  ${drifted.join('\n  ')}`,
  );
});

test('the var placeholders are real — every one is used by the block and named by the call site', () => {
  for (const pair of PAIRS) {
    const body = extractBlock(SKILL, pair.block)!;
    const placeholders = [...new Set([...body.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!))].sort();
    assert.deepEqual(
      placeholders, Object.keys(pair.vars).sort(),
      `${pair.block}: the block's {{VARS}} and the mapping above must agree exactly. An unmapped placeholder is `
      + 'substituted with nothing at deny time and the operator reads a sentence with a hole in it.',
    );
    // …and the call site must actually PASS them, or the same hole appears.
    const source = fs.readFileSync(path.join(__dirname, '..', pair.source), 'utf8');
    for (const name of placeholders) {
      assert.ok(
        new RegExp(`\\b${name}\\s*:`).test(source),
        `${pair.block}: SKILL.md interpolates {{${name}}} but ${pair.source} never passes a \`${name}:\` var`,
      );
    }
  }
});
