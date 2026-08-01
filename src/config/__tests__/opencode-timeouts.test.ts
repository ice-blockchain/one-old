import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abandonAfterMs,
  clampStatusWaitMs,
  gatewayBreakerMs,
  maxConsecutiveStalls,
  opencodeUnitTimeoutMs,
  statusWaitMaxMs,
} from '../opencode-timeouts';

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  }
}

// REGRESSION: the per-attempt ceiling was 90s while a real delegated unit needs minutes.
// Measured on the cursor-14c News feature unit (6 files + i18n + routes + sitemap) with the
// warm-up already done: 467s, exit 0, real diff. At 90s the CLI was killed mid-work, the
// runner read that as a model stall, and the delegation always reported provider-timeout
// with delegated=0 — free delegation could never succeed in production, while trivial
// smoke probes (6-19s) kept passing.
test('the per-attempt OpenCode ceiling fits a real measured unit, not just a smoke probe', () => {
  withEnv('T1_OC_UNIT_TIMEOUT_MS', undefined, () => {
    const ceiling = opencodeUnitTimeoutMs();
    assert.ok(ceiling >= 467_000,
      `ceiling ${ceiling}ms must cover the 467s real-unit measurement; 90s made every real delegation impossible`);
    // Must stay UNDER the poll-liveness abandon window, or the MCP watchdog would kill a
    // unit that is legitimately still working.
    assert.ok(ceiling < abandonAfterMs(),
      `ceiling ${ceiling}ms must stay under abandonAfterMs ${abandonAfterMs()}ms`);
  });
});

// The try-the-next-model resilience is kept ON PURPOSE after the ceiling grew: one hung
// free model must not kill a delegation. This test pins that decision so a future ceiling
// change cannot quietly drop the second probe as a side effect (which is exactly what a
// draft of this change did — it broke the "stops after two back-to-back stalls" test).
test('a second stall probe is still attempted after the ceiling grew', () => {
  withEnv('T1_OC_MAX_STALLS', undefined, () => {
    assert.equal(maxConsecutiveStalls(), 2, 'one hung free model must still fall through to a second model');
  });
});

test('timeout env overrides are honoured and reject junk', () => {
  withEnv('T1_OC_UNIT_TIMEOUT_MS', '1500', () => assert.equal(opencodeUnitTimeoutMs(), 1500));
  withEnv('T1_OC_UNIT_TIMEOUT_MS', 'nonsense', () => assert.equal(opencodeUnitTimeoutMs(), 600_000));
  withEnv('T1_OC_UNIT_TIMEOUT_MS', '-5', () => assert.equal(opencodeUnitTimeoutMs(), 600_000));
  withEnv('T1_OC_MAX_STALLS', '3', () => assert.equal(maxConsecutiveStalls(), 3));
  withEnv('T1_OC_MAX_STALLS', '0', () => assert.equal(maxConsecutiveStalls(), 2));
  withEnv('T1_OC_GATEWAY_BREAKER_MS', '5000', () => assert.equal(gatewayBreakerMs(), 5000));
});

// A status long-wait that outlives the host's ~120s tool ceiling dies at the
// HOST as a tool error the orchestrator misreads as "fall back to paid" — so
// the clamp is a hard server-side property, whatever the caller asked for.
test('status waitMs is clamped under the host tool-call ceiling', () => {
  withEnv('T1_OC_STATUS_WAIT_MAX_MS', undefined, () => {
    assert.equal(statusWaitMaxMs(), 110_000);
    assert.equal(clampStatusWaitMs(90_000), 90_000);
    assert.equal(clampStatusWaitMs(600_000), 110_000, 'a request beyond the ceiling is clamped, not honoured');
    assert.equal(clampStatusWaitMs(0), 0);
    assert.equal(clampStatusWaitMs(-5), 0);
    assert.equal(clampStatusWaitMs('junk'), 0);
    assert.equal(clampStatusWaitMs(undefined), 0);
  });
  withEnv('T1_OC_STATUS_WAIT_MAX_MS', '30000', () => {
    assert.equal(clampStatusWaitMs(90_000), 30_000);
  });
});
