import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modelUnavailablePromptRequest } from '../prompt-request';

test('modelUnavailablePromptRequest remains a blocking two-option selector', () => {
  const request = modelUnavailablePromptRequest('best-model', 'fallback-model', 'fallback prose');
  assert.equal(request.kind, 'single_select');
  assert.equal(request.blocking, true);
  assert.equal(request.id, 'traffic-one.agent-model.model-unavailable-choice');
  assert.deepEqual(request.options?.map((option) => option.id), ['enable-retry', 'use-fallback']);
  assert.equal(request.fallbackText, 'fallback prose');
});
