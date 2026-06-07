import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrationEnabled, ORCHESTRATION_CONFIG } from '../orchestration';

test('orchestrationEnabled honors the env kill-switch over the const default', () => {
  const prev = process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION;
  try {
    delete process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION;
    assert.equal(orchestrationEnabled(), ORCHESTRATION_CONFIG.enabled);

    process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION = '1';
    assert.equal(orchestrationEnabled(), false);

    // Only the exact '1' disables; other values fall back to the const.
    process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION = '0';
    assert.equal(orchestrationEnabled(), ORCHESTRATION_CONFIG.enabled);
    process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION = 'true';
    assert.equal(orchestrationEnabled(), ORCHESTRATION_CONFIG.enabled);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION;
    else process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION = prev;
  }
});
