// The false-positive corpus as a permanent regression inside `npm test`.
// Mirrors run-sim's split: the corpus also runs as a test-environment case
// (`npm run test:env --category=lint-corpus`); this file is the cheap CI copy
// that fails a gate change the moment it starts denying legitimate idioms —
// BEFORE a live run does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  corpusGateFamiliesWithKnownBad,
  runLintCorpus,
  type CorpusReport,
} from './index';

let cached: CorpusReport | null = null;
function report(): CorpusReport {
  if (!cached) cached = runLintCorpus();
  return cached;
}

test('known-good idiomatic code produces ZERO blocking findings from every write-time gate', () => {
  // Each entry here is a real pre-existing false positive: fix the gate, not
  // the fixture.
  assert.deepEqual(report().falsePositives, []);
});

test('known-bad fixtures still trip the gate they name — gates cannot be satisfied away', () => {
  assert.deepEqual(report().missedDetections, []);
});

test('every gate family keeps at least one known-bad fixture', () => {
  const families = corpusGateFamiliesWithKnownBad();
  for (const gate of [
    'plan-static',
    'structure',
    'i18n',
    'catalog',
    'collapse',
    'tailwind',
    'forbidden-install',
  ] as const) {
    assert.ok(families.has(gate), `gate family ${gate} has no known-bad fixture`);
  }
});

test('the dense Tailwind fixture passes BECAUSE the toolchain is present, not from an undercount', () => {
  const fixture = report().fixtures.find((entry) => entry.id === 'fx-react-tailwind-dense');
  assert.ok(fixture, 'fx-react-tailwind-dense missing from the corpus');
  const tailwind = fixture!.gates.find((gate) => gate.gate === 'tailwind');
  assert.equal(tailwind!.blocking.length, 0);
  assert.equal(tailwind!.advisory.length, 1, 'the utility count must still register as deliberate styling');
  assert.match(tailwind!.advisory[0]!, /toolchain present/);
});

test('a route-table constant still records the unresolved-route advisory (the 14cl narrowing must not swallow the 1co class)', () => {
  const fixture = report().fixtures.find((entry) => entry.id === 'fx-react-route-constant-advisory');
  assert.ok(fixture, 'fx-react-route-constant-advisory missing from the corpus');
  const structure = fixture!.gates.find((gate) => gate.gate === 'structure');
  assert.ok(structure, 'structure gate result missing');
  assert.equal(structure!.blocking.length, 0, 'a real route table with a constant path never hard-blocks on its own');
  assert.ok(
    structure!.advisory.some((message) => message.includes('STRUCT_ROUTE_PATH_UNRESOLVED')),
    `path: CONSTANT inside createBrowserRouter must stay visible: ${JSON.stringify(structure!.advisory)}`,
  );
});

test('the intermediate catalog parity state registers as advisory, never blocking (13cl oscillation)', () => {
  const fixture = report().fixtures.find((entry) => entry.id === 'fx-catalog-en-intermediate-key');
  assert.ok(fixture, 'fx-catalog-en-intermediate-key missing from the corpus');
  const catalog = fixture!.gates.find((gate) => gate.gate === 'catalog');
  assert.ok(catalog, 'catalog gate result missing');
  assert.equal(catalog!.blocking.length, 0, 'the en-first key addition must not deny the write');
  assert.ok(
    catalog!.advisory.some((message) => message.includes('installLabel')),
    `the cross-locale parity gap must still be reported: ${JSON.stringify(catalog!.advisory)}`,
  );
});

test('advisory findings are reported, not silently dropped', () => {
  // The test-file fixture legitimately carries an advisory copy finding (test
  // scope demotes copy findings; the completion scan skips tests entirely).
  const fixture = report().fixtures.find((entry) => entry.id === 'fx-test-inline-snapshot');
  assert.ok(fixture, 'fx-test-inline-snapshot missing from the corpus');
  const i18n = fixture!.gates.find((gate) => gate.gate === 'i18n');
  assert.ok(i18n, 'i18n gate result missing');
  assert.equal(i18n!.blocking.length, 0, 'test-scope copy findings must never block');
});
