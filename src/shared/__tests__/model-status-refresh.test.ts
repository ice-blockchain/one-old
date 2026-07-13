import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostModelSnapshot,
  type HostModelSnapshot,
} from '../model-tiers';
import { refreshHostModelStatus } from '../model-status-refresh';

function harness(current: HostModelSnapshot | null, fetched: unknown | Error, plan = 'pro') {
  const writes: HostModelSnapshot[] = [];
  return {
    writes,
    run: () => refreshHostModelStatus('cursor', {
      env: { TRAFFIC_ONE_USER_PLAN: plan } as NodeJS.ProcessEnv,
      readHost: () => current,
      writeHost: (_host, snapshot) => { writes.push(snapshot); },
      fetchStatus: async () => {
        if (fetched instanceof Error) throw fetched;
        return fetched;
      },
    }),
  };
}

test('refreshHostModelStatus performs zero writes for an exact plan/catalog match', async () => {
  const current = hostModelSnapshot('cursor', 'pro');
  const h = harness(current, hostModelSnapshot('cursor', 'pro'));
  const result = await h.run();
  assert.equal(result.outcome, 'unchanged');
  assert.equal(result.changed, false);
  assert.deepEqual(h.writes, []);
});

test('refreshHostModelStatus stores a valid API catalog with a newer date', async () => {
  const current = hostModelSnapshot('cursor', 'pro');
  const remote = { ...hostModelSnapshot('cursor', 'pro'), updatedAt: '2026-07-14' };
  const h = harness(current, remote);
  const result = await h.run();
  assert.equal(result.outcome, 'remote-updated');
  assert.equal(result.changed, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.updatedAt, '2026-07-14');
});

test('same-date tier drift is invalid and preserves the last configuration', async () => {
  const current = hostModelSnapshot('cursor', 'pro');
  const remote = hostModelSnapshot('cursor', 'pro');
  const invalid = {
    ...remote,
    tiers: { ...remote.tiers, balanced: ['unexpected-model'] },
  };
  const h = harness(current, invalid);
  const result = await h.run();
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.changed, false);
  assert.deepEqual(h.writes, []);
});

test('same-date tier drift on first use is rejected in favor of the bundled target-plan snapshot', async () => {
  const remote = hostModelSnapshot('cursor', 'pro');
  const drifted = {
    ...remote,
    tiers: { ...remote.tiers, balanced: ['unexpected-model'] },
  };
  const h = harness(null, drifted);

  const result = await h.run();

  assert.equal(result.outcome, 'bundled-plan-updated');
  assert.equal(result.changed, true);
  assert.deepEqual(h.writes, [hostModelSnapshot('cursor', 'pro')]);
});

test('same-date tier drift during a plan transition is rejected against the bundled target plan', async () => {
  const current = hostModelSnapshot('cursor', 'free');
  const remote = hostModelSnapshot('cursor', 'pro');
  const drifted = {
    ...remote,
    tiers: { ...remote.tiers, balanced: ['unexpected-model'] },
  };
  const h = harness(current, drifted, 'pro');

  const result = await h.run();

  assert.equal(result.outcome, 'bundled-plan-updated');
  assert.equal(result.changed, true);
  assert.deepEqual(h.writes, [hostModelSnapshot('cursor', 'pro')]);
});

test('timeout is fail-open when the detected plan is unchanged', async () => {
  const current = hostModelSnapshot('cursor', 'pro');
  const h = harness(current, new Error('request timeout'));
  const result = await h.run();
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.changed, false);
  assert.deepEqual(h.writes, []);
});

test('a newer bundled snapshot replaces an older same-plan local snapshot while offline', async () => {
  const bundled = hostModelSnapshot('cursor', 'pro');
  const current = { ...bundled, updatedAt: '2026-07-11' };
  const h = harness(current, new Error('offline'));

  const result = await h.run();

  assert.equal(result.outcome, 'bundled-plan-updated');
  assert.equal(result.changed, true);
  assert.deepEqual(h.writes, [bundled]);
});

test('a newer bundled snapshot wins over an older valid API response', async () => {
  const bundled = hostModelSnapshot('cursor', 'pro');
  const current = { ...bundled, updatedAt: '2026-07-10' };
  const remote = { ...bundled, updatedAt: '2026-07-11' };
  const h = harness(current, remote);

  const result = await h.run();

  assert.equal(result.outcome, 'bundled-plan-updated');
  assert.equal(result.changed, true);
  assert.deepEqual(h.writes, [bundled]);
});

test('a newer same-plan local snapshot is never downgraded by bundled or API data', async () => {
  const bundled = hostModelSnapshot('cursor', 'pro');
  const current = { ...bundled, updatedAt: '2026-07-14' };
  const remote = { ...bundled, updatedAt: '2026-07-13' };
  const h = harness(current, remote);

  const result = await h.run();

  assert.equal(result.outcome, 'unchanged');
  assert.equal(result.changed, false);
  assert.equal(result.snapshot?.updatedAt, '2026-07-14');
  assert.deepEqual(h.writes, []);
});

test('a newer API snapshot survives a later timeout without being downgraded', async () => {
  const bundled = hostModelSnapshot('cursor', 'pro');
  const remote = { ...bundled, updatedAt: '2026-07-14' };
  const first = harness(bundled, remote);
  const firstResult = await first.run();
  assert.equal(firstResult.outcome, 'remote-updated');

  const persisted = first.writes[0] ?? null;
  const second = harness(persisted, new Error('offline'));
  const secondResult = await second.run();

  assert.equal(secondResult.outcome, 'unavailable');
  assert.equal(secondResult.changed, false);
  assert.equal(secondResult.snapshot?.updatedAt, '2026-07-14');
  assert.deepEqual(second.writes, []);
});

test('an offline plan change writes the bundled snapshot for the fresh plan', async () => {
  const current = hostModelSnapshot('cursor', 'free');
  const h = harness(current, new Error('offline'), 'pro');
  const result = await h.run();
  assert.equal(result.outcome, 'bundled-plan-updated');
  assert.equal(result.changed, true);
  assert.deepEqual(h.writes, [hostModelSnapshot('cursor', 'pro')]);
});
