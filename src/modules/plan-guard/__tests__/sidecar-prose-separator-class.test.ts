// src/modules/plan-guard/__tests__/sidecar-prose-separator-class.test.ts
// The sidecar gate used to ship a multi-thousand-word deny paragraph that made
// ONE claim a machine can check against the code it describes: that a name
// below `.traffic-one/runs` is split where BASH splits it, "on a SPACE, a TAB
// or a NEWLINE". That sentence replaced a promise ("as is a non-ASCII name")
// which was false for U+00A0 in both spellings, because the splitting class had
// been spelled as JavaScript's `\s` — which matches nineteen Unicode space
// characters bash forms one word from.
//
// The deny T1BLOCK is now a short user-visible reason. The measured essay lives
// beside this file so the claim is still documented; this test asserts the TS
// behaviour the essay described, not the essay itself as deny prose.
//
// The fix was one shared fact, `SHELL_WORD_SEPARATORS` in shared/shell-
// vocabulary.ts, consumed at every site where `\s` had stood for "the shell
// splits here". So the prose and the class can now disagree in exactly one way:
// the class is widened or narrowed in code and the sentence keeps promising the
// old one. Nothing else would notice if this file only compared two copies of
// the sentence to each other.
//
// So the phrase is DERIVED here rather than typed twice. This is the lane rule
// about numbers ("a number copied into two files stops agreeing with itself")
// applied to a list: the sentence carries no count and the members come off the
// constant, so adding `\v` to the separators fails this test rather than
// shipping a paragraph that has quietly become false.
//
// `SHELL_WORD_SEPARATORS` is a module-private regex-class fragment, deliberately
// not exported — exporting a constant only to let a test read it widens the
// module's surface for the test's convenience. It is read out of the source text
// instead, the way the census tests in this repo read theirs, and the read is
// asserted to have found something before it is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'path';

import { extractBlock } from '../../../shared/skill-block';

const MODULE_DIR = path.join(__dirname, '..');
const SKILL = fs.readFileSync(path.join(MODULE_DIR, 'skill', 'SKILL.md'), 'utf8');
const FALLBACK_SOURCE = fs.readFileSync(path.join(MODULE_DIR, 'plan-readiness', 'index.ts'), 'utf8');
const ESSAY = fs.readFileSync(path.join(__dirname, 'runtime-sidecar-owner-gate.essay.md'), 'utf8');
const VOCABULARY = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'shared', 'shell-vocabulary.ts'), 'utf8',
);

/** The regex-class fragment the whole pipeline splits words on. */
function separatorClass(): string {
  const match = /const SHELL_WORD_SEPARATORS = String\.raw`([^`]*)`;/.exec(VOCABULARY);
  assert.ok(match, 'SHELL_WORD_SEPARATORS is no longer a `String.raw` literal in shared/shell-vocabulary.ts — this '
    + 'test reads it out of the source, so the read has to be fixed in the same change as the constant');
  return match[1]!;
}

// The English the prose spells each separator with. A separator with no name
// here is a FAILURE rather than a skip: it means the class grew a member and
// nobody decided how the shipped sentence should say it.
const SPELLED: Readonly<Record<string, string>> = {
  ' ': 'a SPACE',
  '\\t': 'a TAB',
  '\\n': 'a NEWLINE',
};

function expectedPhrase(): string {
  const members = [...separatorClass().matchAll(/\\[a-z]|./g)].map((m) => m[0]!);
  assert.ok(members.length >= 2, `the separator class parsed to ${members.length} member(s) — the parse is broken`);
  const named = members.map((member) => {
    const spelled = SPELLED[member];
    assert.ok(
      spelled,
      `SHELL_WORD_SEPARATORS gained ${JSON.stringify(member)} and the measured sidecar essay has no wording for `
      + 'it. Widening what counts as a word separator changes which names below `.traffic-one/runs` are refused, so '
      + 'the sentence has to move with it: add the spelling here and to the essay in the same change.',
    );
    return spelled!;
  });
  const last = named[named.length - 1]!;
  return `on ${named.slice(0, -1).join(', ')} or ${last}`;
}

test('the path-character classes interpolate SHELL_WORD_SEPARATORS', () => {
  // The deny T1BLOCK no longer restates the separator class. The load-bearing
  // claim is that every site that used to spell "the shell splits here" as `\s`
  // now interpolates this constant.
  assert.ok(
    VOCABULARY.includes('PATH_BODY_CHARACTER = String.raw`[^${SHELL_WORD_SEPARATORS}'),
    'PATH_BODY_CHARACTER must interpolate SHELL_WORD_SEPARATORS',
  );
  assert.ok(
    VOCABULARY.includes('PATH_PREFIX_CHARACTER = String.raw`[^${SHELL_WORD_SEPARATORS}'),
    'PATH_PREFIX_CHARACTER must interpolate SHELL_WORD_SEPARATORS',
  );
  assert.ok(
    VOCABULARY.includes('SHELL_WORD_SEPARATOR_RE = new RegExp(`[${SHELL_WORD_SEPARATORS}]`)'),
    'SHELL_WORD_SEPARATOR_RE must interpolate SHELL_WORD_SEPARATORS',
  );
});

test('the measured sidecar essay still names the separators the code splits on', () => {
  const phrase = expectedPhrase();
  assert.ok(
    ESSAY.includes(`A NAME IS SPLIT WHERE BASH SPLITS IT — ${phrase} —`),
    `the moved essay must keep the separator class as derived from SHELL_WORD_SEPARATORS: expected the phrase `
    + `${JSON.stringify(phrase)}. The class in shared/shell-vocabulary.ts and the promise in the measured essay are `
    + 'the two halves of one claim, and only this assertion pairs them.',
  );
});

test('the shipped sidecar deny is the short reason, not the measured essay', () => {
  const body = extractBlock(SKILL, 'runtime-sidecar-owner-gate');
  assert.ok(body, 'runtime-sidecar-owner-gate has no T1BLOCK in plan-guard/skill/SKILL.md');
  assert.ok(body!.includes('{{TARGET}}'), 'the short deny must keep the TARGET interpolation');
  assert.ok(
    !body!.includes('THE READ RULE') && !body!.includes('WHAT THIS COSTS') && !body!.includes('A NAME IS SPLIT'),
    'the user-visible T1BLOCK must not carry the measured essay',
  );
  assert.ok(
    FALLBACK_SOURCE.includes('is published by the runtime. Do not create, edit, delete, or repair it.'),
    'the TS fallback must stay the short deny, not the essay',
  );
  assert.ok(
    !FALLBACK_SOURCE.includes('THE READ RULE') && !FALLBACK_SOURCE.includes('WHAT THIS COSTS'),
    'the TS fallback must not carry the measured essay',
  );
});

test('a widened class fails rather than passing quietly', () => {
  // Non-vacuity, and the only failure path that matters: the assertions above
  // are satisfied by today's tree, so they cannot show that a NEW separator
  // would be caught. Driven through the same spelling table.
  assert.throws(
    () => {
      const members = [' ', '\\t', '\\n', '\\v'];
      for (const member of members) {
        assert.ok(SPELLED[member], `unspelled separator ${JSON.stringify(member)}`);
      }
    },
    /unspelled separator/,
    'a separator with no shipped wording must be an assertion failure, not a silently skipped row',
  );
});
