import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyModelFailureText,
  isApiUsageLimitText,
  isModelUnavailableText,
} from '../failure-classify';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// The documents that TELL an agent how to name a limit. Every one of these was
// shipping `API/usage limit`, a spelling the classifier did not recognise, so
// `replacementJustified` refused a replacement spawn to an orchestrator quoting
// the product's own directive back at it.
const SHIPPED_DIRECTIVE_SOURCES = [
  'src/modules/agent-model/record-agent.ts',
  'src/modules/agent-model/model-rotation.ts',
  'src/modules/agent-model/cursor-failure-prose.ts',
  'src/modules/agent-model/skill/SKILL.md',
  'src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md',
];

// Any separator the product puts between `api`, `usage` and `limit`. Deliberately
// looser than the classifier: the point is to FIND a spelling the classifier
// misses, so this must be able to match one.
const SHIPPED_LIMIT_PHRASE_RE = /\bapi[\s/_-]*(?:usage[\s/_-]*)?limit\b/gi;

test('API-limit classifier recognizes Cursor incident and structured/common limit shapes', () => {
  const positives = [
    'API usage limit reached Switched to composer-2.5 after reaching API limit.',
    'api_limit_exceeded',
    'rate_limit_exceeded',
    'HTTP 429',
    'request failed with status code 429',
    '429 Too Many Requests',
    'Too Many Requests',
    'RESOURCE_EXHAUSTED',
    'ERROR_RATE_LIMITED_CHANGEABLE',
    'Your quota has been exceeded.',
    'Quota reached for this billing period.',
    'You hit your quota limit.',
    'The rate limit was reached.',
    'The request was rate-limited.',
    'Previous agent failed (API limit).',
  ];
  for (const value of positives) {
    assert.equal(isApiUsageLimitText(value), true, value);
    assert.equal(classifyModelFailureText(value), 'api-limit', value);
  }
});

test('API-limit classifier rejects generic API/auth/network/context/abort failures', () => {
  const negatives = [
    'API error while creating the request',
    'ERROR_UNAUTHORIZED: token expired',
    'Network unavailable while loading model metadata',
    'Connection reset by peer',
    'Context window exhausted',
    'User aborted request',
    'Request cancelled',
    'The docs explain how to handle rate limits.',
    'Quota information could not be loaded.',
    'The response status was 500.',
    'No API limit was reached.',
    'The API usage limit was not exceeded.',
    'The request completed without hitting the rate limit.',
    'No quota was exceeded.',
  ];
  for (const value of negatives) {
    assert.equal(isApiUsageLimitText(value), false, value);
    assert.equal(classifyModelFailureText(value), 'generic', value);
  }
});

// Derived rather than literal, because the defect was a DIVERGENCE between the
// spelling the product ships and the spelling the classifier reads, and a literal
// corpus cannot notice the next divergence. A directive introducing a separator
// this classifier does not admit reds here on the day it lands.
test('every api-limit spelling the product itself ships is recognised as a limit', () => {
  const found = new Set<string>();
  for (const rel of SHIPPED_DIRECTIVE_SOURCES) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const match of text.matchAll(SHIPPED_LIMIT_PHRASE_RE)) found.add(match[0]);
  }

  // Guards the instrument: a scan that matches nothing would pass vacuously, and
  // the slash spelling in particular must be among what it finds.
  assert.ok(found.size >= 2, `expected several shipped spellings, found ${[...found].join(', ')}`);
  assert.ok(
    [...found].some((phrase) => phrase.includes('/')),
    `expected a slash-separated shipped spelling, found ${[...found].join(', ')}`,
  );

  for (const phrase of found) {
    assert.equal(isApiUsageLimitText(phrase), true, phrase);
    assert.equal(classifyModelFailureText(phrase), 'api-limit', phrase);
  }
});

// The auxiliary run was an alternation of SINGLE words, so it admitted the
// ungrammatical `limit been exceeded` and refused the grammatical `limit has been
// exceeded`. Only subjects lacking the word `api` were affected, because `api …
// limit` classifies on the subject alone.
test('api-limit classifier reads multi-word auxiliaries, and their negations still strip', () => {
  for (const value of [
    'usage limit has been exceeded',
    'rate limit has been reached',
    'rate limits have been exceeded',
    'your rate limit is being hit',
    'API/usage limit has been reached',
  ]) {
    assert.equal(isApiUsageLimitText(value), true, value);
  }

  // The symmetry that makes the widening safe: the negation stripper reads the
  // same subjects and auxiliaries, so a report of SUCCESS cannot condemn a model.
  for (const value of [
    'no rate limit has been exceeded',
    'no API/usage limit was reached',
    'rate limits have not been reached',
    'the usage limit has not been hit',
  ]) {
    assert.equal(isApiUsageLimitText(value), false, value);
  }
});

test('model-unavailable classifier requires positive vocabulary linked to model', () => {
  const positives = [
    'The requested model gpt-5.6-terra-medium is not enabled.',
    'Model is disabled in Cursor Settings.',
    'MODEL_UNAVAILABLE',
    'Invalid model: gpt-5.6-terra',
    'Unsupported model',
    'Unknown model gpt-next',
    'Model not found',
    'Unavailable requested model',
  ];
  for (const value of positives) {
    assert.equal(isModelUnavailableText(value), true, value);
    assert.equal(classifyModelFailureText(value), 'model-unavailable', value);
  }

  const negatives = [
    'Network unavailable while loading model metadata',
    'Invalid credentials for the model provider',
    'Unknown server error while invoking the model',
    'The model request was aborted by the user',
    'Context exhausted for model gpt-5.6-terra',
    'API error for model gpt-5.6-terra',
  ];
  for (const value of negatives) {
    assert.equal(isModelUnavailableText(value), false, value);
    assert.equal(classifyModelFailureText(value), 'generic', value);
  }
});
