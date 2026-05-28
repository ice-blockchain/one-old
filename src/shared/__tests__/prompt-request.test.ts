import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authApiKeyPromptRequest, authChoicePromptRequest } from '../prompt-request';

test('authChoicePromptRequest is a blocking single-select with two options', () => {
  const r = authChoicePromptRequest('fb');
  assert.equal(r.kind, 'single_select');
  assert.equal(r.blocking, true);
  assert.equal(r.id, 'traffic-one.auth.choice');
  assert.equal(r.options?.length, 2);
  assert.equal(r.fallbackText, 'fb');
});

test('authApiKeyPromptRequest is a sensitive secure-text prompt; no fallback when omitted', () => {
  const r = authApiKeyPromptRequest();
  assert.equal(r.kind, 'secure_text');
  assert.equal(r.sensitive, true);
  assert.equal('fallbackText' in r, false);
});
