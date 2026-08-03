import { test } from 'node:test';
import assert from 'node:assert/strict';

import { type VerificationContractV2 } from '../../../shared/verification-contract';
import { loadScenario, scenarioStepsProveOutcome } from '../scenario';
import { type RunnerArgs, type ScenarioStep } from '../types';

const CONTRACT = { changedRoutes: ['/'] } as unknown as VerificationContractV2;

function load(steps: Array<Record<string, string>>): ReturnType<typeof loadScenario> {
  const args = {
    command: 'browser',
    projectRoot: '/nonexistent',
    runId: 'R',
    buildDir: 'dist',
    withLighthouse: false,
    timeoutMs: 1_000,
    scenarioJson: JSON.stringify({
      schemaVersion: 1,
      routes: [{ route: '/', finalPath: '/', stableSelector: 'main', steps }],
    }),
  } as unknown as RunnerArgs;
  return loadScenario(args, CONTRACT);
}

const steps = (...items: Array<[ScenarioStep['type'], string?, string?]>): ScenarioStep[] => (
  items.map(([type, selector, value]) => ({
    type,
    ...(selector === undefined ? {} : { selector }),
    ...(value === undefined ? {} : { value }),
  }))
);

test('a click-through scenario keeps the pre-existing contract', () => {
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', 'button'],
    ['expect-visible', 'main'],
  )), true);
  // Assertions alone were never enough, and still are not.
  assert.equal(scenarioStepsProveOutcome(steps(['expect-visible', 'main'])), false);
  assert.ok(load([
    { type: 'click', selector: 'button' },
    { type: 'expect-visible', selector: 'main' },
  ]));
});

test('filling a form without submitting it is not evidence the form works', () => {
  // The exact 10co-e2e shape: the generated scenario filled the contact form
  // and stopped. `actions: passed` was compatible with the form being
  // completely broken, because nothing was ever submitted or asserted.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['fill', 'input[name="email"]', 'a@b.co'],
    ['fill', 'textarea[name="message"]', 'hello'],
  )), false);
  assert.equal(load([
    { type: 'fill', selector: 'input[name="email"]', value: 'a@b.co' },
    { type: 'expect-visible', selector: 'main' },
  ]), null, 'an assertion that predates the submit is not a success path');

  // Submit with no result assertion is the same hole one step later.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['fill', 'input[name="email"]', 'a@b.co'],
    ['click', 'button[type="submit"]'],
  )), false);

  // Submit + a real success assertion passes.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['fill', 'input[name="email"]', 'a@b.co'],
    ['click', 'button[type="submit"]'],
    ['expect-text', '[data-testid="contact-result"]', 'Thanks'],
  )), true);
  assert.ok(load([
    { type: 'fill', selector: 'input[name="email"]', value: 'a@b.co' },
    { type: 'press', selector: 'input[name="email"]', value: 'Enter' },
    { type: 'expect-url', value: '/contact/sent' },
  ]));
});

test('a degraded-state affordance is never the pass condition', () => {
  // 10co-e2e asserted expect-visible on `a[href='https://traffic.io/']` — the
  // missing-configuration setup CTA a reviewer finding had flagged as wrongly
  // rendered. The scenario asserted the bug.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['fill', 'input[name="email"]', 'a@b.co'],
    ['click', 'button[type="submit"]'],
    ['expect-visible', "a[href='https://traffic.io/']"],
  )), false);
  assert.equal(load([
    { type: 'fill', selector: 'input[name="email"]', value: 'a@b.co' },
    { type: 'click', selector: 'button[type="submit"]' },
    { type: 'expect-visible', selector: "a[href='https://traffic.io/']" },
  ]), null);

  // Degraded TEXT is rejected on any route, form or not.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', 'button'],
    ['expect-text', 'main', 'Email is not configured yet'],
  )), false);
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', 'button'],
    ['expect-visible', '[data-testid="coming-soon"]'],
  )), false);

  // An off-site link on a non-form route stays legal: only the success path of
  // a submitted form is judged on it.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', 'button'],
    ['expect-visible', "a[href='https://docs.example.com/']"],
  )), true);
});

test('a CSS attribute NAME is not a degraded-state affordance', () => {
  // `input[placeholder="…"]` is the most ordinary selector idiom there is, and
  // reading the attribute name as content rejected the WHOLE scenario file
  // over it — on plain click-through routes that fill nothing.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', '[data-testid="search"]'],
    ['expect-visible', 'input[placeholder="Search courses"]'],
  )), true);
  assert.equal(scenarioStepsProveOutcome(steps(
    ['fill', 'input[placeholder="Email"]', 'a@b.co'],
    ['click', 'button[type="submit"]'],
    ['expect-visible', 'input[placeholder="Email"]'],
  )), true);
  assert.ok(load([
    { type: 'click', selector: '[data-testid="search"]' },
    { type: 'expect-visible', selector: 'input[placeholder="Search courses"]' },
  ]));

  // The attribute VALUE is still content, whichever attribute carries it.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', 'button'],
    ['expect-visible', '[placeholder="Coming soon"]'],
  )), false);
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', 'button'],
    ['expect-visible', '[aria-label="Setup required"]'],
  )), false);
  // …and a bare id/class token never went through the attribute path at all.
  assert.equal(scenarioStepsProveOutcome(steps(
    ['click', 'button'],
    ['expect-visible', '#setup_required'],
  )), false);
});
