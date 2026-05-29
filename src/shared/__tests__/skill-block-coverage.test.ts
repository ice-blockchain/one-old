import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { extractBlock } from '../skill-block';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Single source of truth: the onboarding wording lives only in the onboarding-gate
// SKILL.md. The TS assemblers read it via a bound `block('<name>', …)` and no
// longer carry verbatim fallbacks — so a missing/renamed block would silently
// degrade to an empty string at runtime. This test fails the build instead: every
// block referenced in code must exist in the SKILL.md.
const ONBOARDING_SOURCES = [
  'src/shared/onboarding/fallbacks.ts',
  'src/shared/onboarding/directives.ts',
  'src/shared/onboarding/perf-directives.ts',
  'src/shared/onboarding/session-directive.ts',
  'src/shared/onboarding/local-prefs.ts',
  'src/modules/onboarding-gate/handler.ts',
  'src/modules/session/prompt-submit.ts',
];

function referencedOnboardingBlocks(): Set<string> {
  const names = new Set<string>();
  // Match the bound `block('name'` calls (not sessionBlock/planBlock/makeSkillBlock).
  const re = /(?<![A-Za-z0-9_])block\(\s*'([a-z0-9-]+)'/g;
  for (const rel of ONBOARDING_SOURCES) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const match of text.matchAll(re)) names.add(match[1]!);
  }
  return names;
}

test('every onboarding-gate block referenced in code exists in its SKILL.md', () => {
  const skill = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'modules', 'onboarding-gate', 'skill', 'SKILL.md'),
    'utf8',
  );
  const referenced = referencedOnboardingBlocks();
  assert.ok(referenced.size >= 15, `expected to discover the onboarding block refs, found ${referenced.size}`);
  const missing = [...referenced].filter((name) => extractBlock(skill, name) === null);
  assert.deepEqual(missing, [], `onboarding-gate SKILL.md is missing referenced blocks:\n${missing.join('\n')}`);
});
