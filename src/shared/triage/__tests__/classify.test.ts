import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPromptComplexity } from '../classify';

function tier(prompt: string): string {
  return classifyPromptComplexity(prompt).tier;
}

test('clear trivial edits → trivial/high', () => {
  for (const p of [
    'fix a typo in the header',
    'change the button color to blue',
    'update the copy on the landing page',
    'rename the UserCard component',
    'reword the error message',
    'run prettier / fix the indentation',
  ]) {
    const hint = classifyPromptComplexity(p);
    assert.equal(hint.tier, 'trivial', `expected trivial for: ${p}`);
    assert.equal(hint.confidence, 'high', `expected high confidence for: ${p}`);
  }
});

test('strong domain work → complex/high', () => {
  for (const p of [
    'add user authentication with OAuth',
    'add Stripe checkout',
    'create a new migration for the orders table',
    'build a reporting dashboard',
    'integrate the Slack webhook',
    'add real-time presence to the chat',
  ]) {
    const hint = classifyPromptComplexity(p);
    assert.equal(hint.tier, 'complex', `expected complex for: ${p}`);
    assert.equal(hint.confidence, 'high', `expected high confidence for: ${p}`);
  }
});

test('weak feature/refactor signals → complex/low (escalate, uncertain)', () => {
  for (const p of [
    'add a new feature for exporting CSV',
    'build a new feature to manage tags',
    'refactor the data layer',
  ]) {
    const hint = classifyPromptComplexity(p);
    assert.equal(hint.tier, 'complex', `expected complex for: ${p}`);
    assert.equal(hint.confidence, 'low', `expected low confidence for: ${p}`);
  }
});

test('a single new page is small unless another signal makes it cross-cutting', () => {
  const page = classifyPromptComplexity('create a new page named news using the existing data seam');
  assert.equal(page.tier, 'small');
  assert.equal(page.confidence, 'high');
  assert.ok(page.signals.includes('new-page'));

  const schemaPage = classifyPromptComplexity('create a new news page with a new table and migration');
  assert.equal(schemaPage.tier, 'complex');
  assert.ok(schemaPage.signals.includes('data-model'));

  const featurePage = classifyPromptComplexity('create a new page as part of a new feature');
  assert.equal(featurePage.tier, 'complex');
  assert.ok(featurePage.signals.includes('feature'));
});

test('escalation bias: a strong signal overrides trivial-looking words', () => {
  // "login" anchors auth even though it mentions color — the hint biases complex;
  // the agent decides authoritatively.
  assert.equal(tier('fix the login button color'), 'complex');
  assert.equal(tier('refactor the auth module'), 'complex');
});

test('subscription billing fires the payments signal in verb form too', () => {
  // Regression: `subscriptions?` missed the verb, so a billing feature fell to the
  // ambiguous residual (small) — the one dangerous under-route in the battery.
  for (const p of [
    'users should be able to subscribe to a monthly plan',
    'let people manage their subscription',
    'cancel subscriptions from settings',
  ]) {
    const hint = classifyPromptComplexity(p);
    assert.equal(hint.tier, 'complex', `expected complex for: ${p}`);
    assert.ok(hint.signals.includes('payments'), `payments signal for: ${p}`);
  }
});

test('a copy change with the text-noun after a long phrase is trivial (headline rewrite)', () => {
  // Regression: the real prompt "change the <long hero headline> text with X" — the
  // text-noun sits well past the change-verb, so the tight 24-char window missed it
  // and it fell to the `small` residual. The widened window catches it as trivial.
  for (const p of [
    'we need to change the Master Web Development, One Project at a Time text with software development',
    'update the hero headline to something punchier',
    'reword the tagline on the pricing page',
  ]) {
    assert.equal(tier(p), 'trivial', `expected trivial for: ${p}`);
  }
});

test('mixed evidence demotes confidence and surfaces the trivial co-signals', () => {
  // A strong domain word used as a page/column NAME next to trivial signals must
  // not anchor the agent with a confident complex label.
  const signup = classifyPromptComplexity('just change the text on the signup page');
  assert.equal(signup.tier, 'complex');
  assert.equal(signup.confidence, 'low');
  assert.ok(signup.signals.includes('auth') && signup.signals.includes('copy'), 'both sides of the evidence surface');

  const color = classifyPromptComplexity('fix the login button color');
  assert.equal(color.confidence, 'low');
  assert.ok(color.signals.includes('styling'), 'trivial co-signal surfaces');

  // Pure domain work stays high confidence.
  assert.equal(classifyPromptComplexity('add user authentication with OAuth').confidence, 'high');
});

test('ambiguous prompts resolve to small, never trivial', () => {
  for (const p of ['', 'make the homepage look nicer', 'add a button to the toolbar', 'improve the page']) {
    assert.equal(tier(p), 'small', `expected small for: ${JSON.stringify(p)}`);
  }
});

test('explicit smallness downgrades a weak-complex + trivial prompt to trivial', () => {
  // weak signal (refactor) + concrete trivial signal (copy) + explicit "small"
  const hint = classifyPromptComplexity('just a small refactor to fix the label text');
  assert.equal(hint.tier, 'trivial');
  assert.equal(hint.confidence, 'low');
});

test('non-string input is handled', () => {
  assert.equal(classifyPromptComplexity(undefined).tier, 'small');
  assert.equal(classifyPromptComplexity(null).tier, 'small');
  assert.equal(classifyPromptComplexity(42 as unknown).tier, 'small');
});
