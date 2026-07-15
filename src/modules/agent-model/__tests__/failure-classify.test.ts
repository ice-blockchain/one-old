import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyModelFailureText,
  isApiUsageLimitText,
  isModelUnavailableText,
} from '../failure-classify';

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
