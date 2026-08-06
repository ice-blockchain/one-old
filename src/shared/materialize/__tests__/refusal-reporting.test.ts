// How the consent refusal is REPORTED.
//
// materializeProjectAssets now returns `skipped: 'plugin-use-not-permitted'` for a
// project whose use-plugin question is unanswered or answered no. Every existing
// reader of `skipped` was written for the three PLUGIN-ROOT refusals, which are
// operator problems with a fix ("run the doctor", "build the plugin"). Routing a
// consent refusal into that vocabulary would produce a false diagnostic — telling
// a user to repair a plugin tree that is perfectly healthy — so both readers get
// an explicit branch, and both are asserted here rather than left to the fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { materializeRefusedOutcome } from '../converge';
import { SILENT_MATERIALIZE_REFUSALS } from '../../../modules/materialize/converge-from-write';
import type { MaterializeResult } from '../materialize';

// A LITERAL, not a real refusal: every test here is about materializeRefusedOutcome,
// a pure formatter, so nothing in this file touches disk or the fence — it passes
// with the consent fence deleted outright, by design and not by omission.
//
// The cost of a literal is drift: this file would keep asserting the routing of a
// value the writer had stopped producing. What anchors it is materialize-writer.
// test.ts, which pins the REAL writer's refusal to exactly this shape — the
// `skipped` id and all four zero counts — against a live project. Measured in
// both directions: changing the writer's reported id, or giving the refusal
// non-zero counts, fails there and leaves this file green.
const CONSENT_REFUSAL: MaterializeResult = {
  rules: 0, skills: 0, written: 0, removed: 0, contextProfile: 'unresolved', skipped: 'plugin-use-not-permitted',
};

test('a consent refusal is never reported as a plugin-root problem', () => {
  const out = materializeRefusedOutcome(CONSENT_REFUSAL);

  assert.equal(out.status, 'skipped');
  assert.equal(out.result, CONSENT_REFUSAL);
  // The three plugin-root branches all name the resolved root and send the reader
  // to the doctor. None of that applies here, and saying it would be a lie.
  assert.equal(/doctor/i.test(out.context), false, 'the doctor has nothing to diagnose');
  assert.equal(/plugin root/i.test(out.systemMessage), false, 'nothing about the plugin tree needs fixing');
  assert.equal(/plugin root/i.test(out.context), false);
  // What it must say instead: whose decision this is and how to change it.
  assert.ok(/opted in/i.test(out.systemMessage));
  assert.ok(out.context.includes('plugin-use.ts'), 'points at the authority for the decision');
});

test('the plugin-root refusals still report as plugin-root problems', () => {
  // The guard on the test above: it passes trivially if the branch swallows
  // everything, so the neighbours must keep their own diagnostics.
  for (const skipped of [
    'plugin-root-source-checkout', 'resolved-content-empty', 'plugin-root-unverified', 'plugin-root-content-incomplete',
  ]) {
    const out = materializeRefusedOutcome({ ...CONSENT_REFUSAL, skipped });
    assert.equal(out.status, 'skipped', skipped);
    assert.ok(/doctor/i.test(out.context), `${skipped} still sends the operator to the doctor`);
    assert.ok(/plugin root/i.test(out.context), `${skipped} still names the plugin root`);
  }
});

test('a consent refusal is silent on the tool-write path, like the plugin-authoring one', () => {
  // converge-from-write runs on every project-memory write. A pending project is
  // being asked the use-plugin question by the onboarding gate already, so a
  // second "materialization skipped" line on each write would be noise about a
  // state the user is actively resolving — and on a DECLINED project it would be
  // Traffic One talking after being told not to.
  assert.equal(SILENT_MATERIALIZE_REFUSALS.has('plugin-use-not-permitted'), true);
  assert.equal(SILENT_MATERIALIZE_REFUSALS.has('plugin-authoring-root'), true);
  // The operator-actionable ones must still speak.
  for (const skipped of [
    'plugin-root-source-checkout', 'resolved-content-empty', 'plugin-root-unverified', 'plugin-root-content-incomplete',
  ]) {
    assert.equal(SILENT_MATERIALIZE_REFUSALS.has(skipped), false, skipped);
  }
});

// One `skipped` id serves three different facts, so the sentence has to be read
// off the counts. It used to hedge across all three ("resolved 0 rule file(s) and
// 0 skill(s)", "too few to be a real materialization"), which described a root
// that resolved the whole 45-rule spine and lost only `skills-catalog/` as having
// resolved zero rules — sending the reader to look for the wrong fault. The torn
// root is a fourth fact and gets its own id, because there the trees are present
// and merely short.
test('each content refusal says WHICH shape fired, in terms that are true of that shape', () => {
  const base = { written: 0, removed: 0, contextProfile: 'unresolved' } as const;
  const nothing = materializeRefusedOutcome({ ...base, rules: 0, skills: 0, skipped: 'resolved-content-empty' });
  const skillsEmpty = materializeRefusedOutcome({ ...base, rules: 45, skills: 0, skipped: 'resolved-content-empty' });
  const rulesEmpty = materializeRefusedOutcome({ ...base, rules: 0, skills: 48, skipped: 'resolved-content-empty' });
  const torn = materializeRefusedOutcome({
    ...base,
    rules: 45,
    skills: 1,
    skipped: 'plugin-root-content-incomplete',
    torn: {
      rules: { candidates: 45, resolved: 45, missing: [] },
      skills: { candidates: 47, resolved: 1, missing: ['accessibility', 'api-design', 'code-review', 'docs', 'e2e', 'perf'] },
    },
  });

  assert.ok(nothing.context.includes('resolved nothing at all — not one rule file, not one skill'));
  assert.ok(skillsEmpty.context.includes('resolved 45 rule files but not a single skill'));
  assert.ok(skillsEmpty.systemMessage.includes('resolved no skills'));
  assert.ok(rulesEmpty.context.includes('resolved 48 skills but not a single rule file'));
  assert.ok(rulesEmpty.systemMessage.includes('resolved no rules'));
  // Singular/plural is part of being accurate: "1 skills" is the tell of a
  // sentence assembled from a template nobody read.
  assert.ok(
    materializeRefusedOutcome({ ...base, rules: 1, skills: 0, skipped: 'resolved-content-empty' })
      .context.includes('resolved 1 rule file but not a single skill'),
  );

  // No two of them read alike, and none of them claims the others' fact.
  const messages = [nothing, skillsEmpty, rulesEmpty, torn].map((out) => out.context);
  assert.equal(new Set(messages).size, 4, 'four distinct diagnostics');
  assert.equal(skillsEmpty.context.includes('resolved nothing at all'), false);
  assert.equal(torn.context.includes('resolved nothing'), false);

  // The torn one names the shortfall per tree, with names to grep for, and does
  // not implicate the tree that was whole.
  assert.ok(torn.context.includes('`skills-catalog/` resolved 1 of the 47 entries this project needs'));
  assert.ok(torn.context.includes('accessibility, api-design, code-review, docs, e2e, … +1 more'));
  assert.equal(torn.context.includes('`rules/` resolved'), false, 'the whole rules/ tree is not blamed');
  assert.ok(/incomplete/i.test(torn.systemMessage));
});
