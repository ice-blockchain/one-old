import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_HOST_PLAN,
  HOST_IDS,
  HOST_MODELS,
  HOST_PLAN_IDS,
  PLAN_IDS,
  SINGLE_MODEL_ROW_ALLOWED_PLANS,
  allowsSingleModelTierRow,
  type HostModelsConfig,
} from '../../config/model-tiers';
import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_LIVE_RELEASE_SNAPSHOT_SCHEMA_VERSION,
  ONE_MCP_MAX_MODELS_PER_TIER,
  ONE_MCP_MAX_PUBLISHED_PAYLOAD_BYTES,
  ONE_MCP_OPERATOR_CAS_SQL_FILE,
  ONE_MCP_OPERATOR_MANIFEST_FILE,
} from '../../config/one-mcp';
import { modelTierSnapshot } from '../../shared/model-tiers';
import { bundledOneMcpPayload } from '../../shared/one-mcp/bundled-catalog';
import {
  mapOneMcpTiers,
  oneMcpPayloadFingerprint,
  oneMcpRemoteTiersForPlan,
} from '../../shared/one-mcp/fingerprint';
import { parseOneMcpModelConfigPayload } from '../../shared/one-mcp/get-config';
import { runGen } from '../index';
import {
  assertOneMcpLiveReleaseSnapshot,
  oneMcpOperatorCasSql,
  oneMcpOperatorManifest,
} from '../sources/one-mcp-operator';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('operator payload expands a sparse plan override and always mirrors balanced into auto', () => {
  const fixture: HostModelsConfig = {
    tiers: {
      highest: ['base-high'],
      balanced: ['base-balanced', 'base-balanced-fallback'],
      cheapest: ['base-low'],
    },
    plans: {
      pro: { balanced: ['pro-balanced'] },
    },
  };

  assert.deepEqual(bundledOneMcpPayload('codex', fixture), {
    tiers: {
      high: ['base-high'],
      balanced: ['base-balanced', 'base-balanced-fallback'],
      low: ['base-low'],
      auto: ['base-balanced', 'base-balanced-fallback'],
    },
    plans: {
      pro: {
        high: ['base-high'],
        balanced: ['pro-balanced'],
        low: ['base-low'],
        auto: ['pro-balanced'],
      },
    },
  });
});

test('operator payload fails generation for rows the shipped decoder cannot consume', () => {
  const base: HostModelsConfig = {
    tiers: {
      highest: ['high'],
      balanced: ['balanced'],
      cheapest: ['low'],
    },
  };
  assert.throws(() => bundledOneMcpPayload('codex', {
    ...base,
    tiers: { ...base.tiers, balanced: ['duplicate', 'duplicate'] },
  }), /duplicate model ids/);
  assert.throws(() => bundledOneMcpPayload('codex', {
    ...base,
    tiers: { ...base.tiers, balanced: ['prompt shaped model'] },
  }), /invalid model id/);
  assert.throws(() => bundledOneMcpPayload('opencode', {
    ...base,
    plans: { pro: { balanced: ['not-a-supported-opencode-plan'] } },
  }), /unsupported opencode plan override: pro/);

  const tooMany = Array.from(
    { length: ONE_MCP_MAX_MODELS_PER_TIER + 1 },
    (_, index) => `model-${index}`,
  ) as unknown as readonly [string, ...string[]];
  assert.throws(() => bundledOneMcpPayload('codex', {
    ...base,
    tiers: { ...base.tiers, highest: tooMany },
  }), new RegExp(`decoder allows ${ONE_MCP_MAX_MODELS_PER_TIER}`));
});

test('operator generation requires two models except for explicit single-choice host plans', () => {
  const twoModels: HostModelsConfig = {
    tiers: {
      highest: ['high', 'high-fallback'],
      balanced: ['balanced', 'balanced-fallback'],
      cheapest: ['low', 'low-fallback'],
    },
  };

  assert.deepEqual(SINGLE_MODEL_ROW_ALLOWED_PLANS, {
    codex: 'all',
    cursor: ['free'],
    copilot: ['free'],
  });
  assert.equal(allowsSingleModelTierRow('codex'), true);
  assert.equal(allowsSingleModelTierRow('cursor', 'free'), true);
  assert.equal(allowsSingleModelTierRow('copilot', 'free'), true);
  assert.equal(allowsSingleModelTierRow('cursor', 'pro'), false);
  assert.equal(allowsSingleModelTierRow('claude'), false);

  assert.throws(() => bundledOneMcpPayload('claude', {
    ...twoModels,
    tiers: { ...twoModels.tiers, highest: ['only-high'] },
  }), /claude\.highest has one model; at least 2 are required/);
  assert.throws(() => bundledOneMcpPayload('cursor', {
    ...twoModels,
    plans: { pro: { cheapest: ['only-low'] } },
  }), /cursor\.pro\.cheapest has one model; at least 2 are required/);

  assert.doesNotThrow(() => bundledOneMcpPayload('codex', {
    tiers: {
      highest: ['only-high'],
      balanced: ['only-balanced'],
      cheapest: ['only-low'],
    },
  }));
  assert.doesNotThrow(() => bundledOneMcpPayload('cursor', {
    ...twoModels,
    plans: {
      free: {
        highest: ['only-high'],
        balanced: ['only-balanced'],
        cheapest: ['only-low'],
      },
    },
  }));
  assert.doesNotThrow(() => bundledOneMcpPayload('copilot', {
    ...twoModels,
    plans: {
      free: {
        highest: ['auto'],
        balanced: ['auto'],
        cheapest: ['auto'],
      },
    },
  }));
});

test('operator manifest is a valid deterministic versionless projection of every host and plan', () => {
  const first = oneMcpOperatorManifest();
  const second = oneMcpOperatorManifest();
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(Object.hasOwn(first, 'payloadSchemaVersion'), false);
  assert.equal(Object.hasOwn(first, 'schemaVersion'), false);
  assert.equal(first.generatedFrom, 'src/config/model-tiers.ts#HOST_MODELS');
  assert.equal(first.versionPolicy, 'compare-and-swap-increment');
  assert.deepEqual(first.rows.map((row) => row.host), HOST_IDS);
  assert.equal(new Set(first.rows.map((row) => row.configName)).size, HOST_IDS.length);

  for (const row of first.rows) {
    const { host, payload } = row;
    assert.equal(Object.hasOwn(payload, 'payloadSchemaVersion'), false);
    assert.equal(row.configName, ONE_MCP_CONFIG_NAME_BY_HOST[host]);
    assert.equal(row.payloadFingerprint, oneMcpPayloadFingerprint(payload));
    assert.ok(
      Buffer.byteLength(JSON.stringify(payload), 'utf8') <= ONE_MCP_MAX_PUBLISHED_PAYLOAD_BYTES,
      `${host} operator payload exceeds the server DB cap`,
    );
    assert.deepEqual(parseOneMcpModelConfigPayload(payload, host), payload);
    assert.deepEqual(payload.tiers.auto, payload.tiers.balanced, `${host} base auto must mirror balanced`);

    const explicitPlans = PLAN_IDS.filter((plan) => Object.prototype.hasOwnProperty.call(
      HOST_MODELS[host].plans ?? {},
      plan,
    ));
    assert.deepEqual(Object.keys(payload.plans ?? {}), explicitPlans);
    for (const plan of explicitPlans) {
      const remote = payload.plans?.[plan];
      assert.ok(remote, `${host}.${plan} override must be complete`);
      assert.deepEqual(Object.keys(remote), ['high', 'balanced', 'low', 'auto']);
      assert.deepEqual(remote.auto, remote.balanced, `${host}.${plan} auto must mirror balanced`);
    }

    const plans = new Set([...HOST_PLAN_IDS[host], DEFAULT_HOST_PLAN[host]]);
    for (const plan of plans) {
      assert.deepEqual(
        mapOneMcpTiers(oneMcpRemoteTiersForPlan(payload, plan)),
        modelTierSnapshot(host, plan),
        `${host}.${plan} remote and bundled catalogs diverged`,
      );
    }
  }
});

test('Milestone-2 release snapshot must be fresh and match all seven live rows exactly', () => {
  const endpoint = 'https://mcp.traffic-one.example/public-mcp';
  const now = Date.parse('2026-07-17T12:00:00.000Z');
  const manifest = oneMcpOperatorManifest();
  const checkedAt = new Date(now).toISOString();
  const snapshot = {
    schemaVersion: ONE_MCP_LIVE_RELEASE_SNAPSHOT_SCHEMA_VERSION,
    endpoint,
    capturedAt: checkedAt,
    rows: manifest.rows.map((row) => ({
      host: row.host,
      configName: row.configName,
      version: 2,
      updatedAt: '2026-07-17T11:59:00.000Z',
      servedPublicly: true,
      payloadFingerprint: row.payloadFingerprint,
      payload: row.payload,
    })),
    evidence: {
      hostedOnboarding: {
        checkedAt,
        route: '/onboarding/agent',
        outcome: 'passed',
      },
      publicProbes: manifest.rows.map((row) => ({
        host: row.host,
        configName: row.configName,
        checkedAt,
        json: {
          outcome: 'full', requestedVersion: 0, observedVersion: 2, payloadFingerprint: row.payloadFingerprint,
        },
        sse: {
          outcome: 'full', requestedVersion: 0, observedVersion: 2, payloadFingerprint: row.payloadFingerprint,
        },
        upToDate: { outcome: 'up-to-date', requestedVersion: 2, observedVersion: 2 },
      })),
      codexHookObservation: {
        checkedAt,
        outcome: 'passed',
        observations: [
          { tier: 'highest', model: 'gpt-5.6-sol', hookEvent: 'SubagentStart' },
          { tier: 'balanced', model: 'gpt-5.6-terra', hookEvent: 'PreToolUse' },
        ],
      },
    },
  };
  assert.doesNotThrow(() => assertOneMcpLiveReleaseSnapshot(snapshot, endpoint, manifest, now));
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot({ ...snapshot, endpoint: 'https://stale.example/mcp' }, endpoint, manifest, now),
    /endpoint does not match/,
  );
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot({ ...snapshot, capturedAt: '2026-07-17T11:00:00.000Z' }, endpoint, manifest, now),
    /stale or from the future/,
  );
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot({ ...snapshot, rows: snapshot.rows.slice(1) }, endpoint, manifest, now),
    /exactly seven rows/,
  );
  const wrong = {
    ...snapshot,
    rows: snapshot.rows.map((row, index) => index === 0 ? {
      ...row,
      payload: {
        ...row.payload,
        tiers: { ...row.payload.tiers, high: ['cross-host-model'] },
      },
    } : row),
  };
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(wrong, endpoint, manifest, now),
    /payload fingerprint differs/,
  );
  const additive = structuredClone(snapshot);
  (additive.rows[0]!.payload as unknown as Record<string, unknown>).unexpected = 'not-reviewed';
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(additive, endpoint, manifest, now),
    /payload differs from HOST_MODELS/,
  );
  const legacyVersionFlag = structuredClone(snapshot);
  (legacyVersionFlag.rows[0]!.payload as unknown as Record<string, unknown>).payloadSchemaVersion = 2;
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(legacyVersionFlag, endpoint, manifest, now),
    /payload differs from HOST_MODELS/,
  );
  const unincremented = structuredClone(snapshot);
  unincremented.rows[0]!.version = 1;
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(unincremented, endpoint, manifest, now),
    /version was not incremented/,
  );
  const staleRow = structuredClone(snapshot);
  staleRow.rows[0]!.updatedAt = '2026-07-17T11:40:00.000Z';
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(staleRow, endpoint, manifest, now),
    /claude updatedAt is stale or from the future/,
  );
  const futureRow = structuredClone(snapshot);
  futureRow.rows[0]!.updatedAt = '2026-07-17T12:06:00.000Z';
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(futureRow, endpoint, manifest, now),
    /claude updatedAt is stale or from the future/,
  );

  const missingEvidence = { ...snapshot } as Record<string, unknown>;
  delete missingEvidence.evidence;
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(missingEvidence, endpoint, manifest, now),
    /unsupported schema/,
  );
  const failedSse = structuredClone(snapshot);
  failedSse.evidence.publicProbes[0]!.sse.observedVersion = 1;
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(failedSse, endpoint, manifest, now),
    /SSE probe did not observe the published version/,
  );
  const staleOnboarding = structuredClone(snapshot);
  staleOnboarding.evidence.hostedOnboarding.checkedAt = '2026-07-17T11:00:00.000Z';
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(staleOnboarding, endpoint, manifest, now),
    /hosted onboarding smoke evidence is stale/,
  );
  const wrongCodex = structuredClone(snapshot);
  wrongCodex.evidence.codexHookObservation.observations[0]!.model = 'gpt-5.6-terra';
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(wrongCodex, endpoint, manifest, now),
    /did not observe exact Sol and Terra models/,
  );
  const identityBearingEvidence = structuredClone(snapshot) as unknown as {
    evidence: { codexHookObservation: Record<string, unknown> };
  };
  identityBearingEvidence.evidence.codexHookObservation.sessionId = 'must-not-be-recorded';
  assert.throws(
    () => assertOneMcpLiveReleaseSnapshot(identityBearingEvidence, endpoint, manifest, now),
    /live Codex hook evidence is missing or failed/,
  );
});

test('operator CAS SQL is fail-closed, versioned, and carries exactly the generated rows', () => {
  const manifest = oneMcpOperatorManifest();
  const sql = oneMcpOperatorCasSql(manifest);
  assert.equal((sql.match(/null::integer/g) ?? []).length, HOST_IDS.length + 1);
  // One occurrence is the review instruction; every row carries one inert
  // placeholder that must be replaced with its observed live version.
  assert.match(sql, /expected_version is null/);
  assert.match(sql, /pc\.served_publicly is distinct from true/);
  assert.match(sql, /pc\.version is distinct from d\.expected_version/);
  assert.match(sql, /and pc\.version = d\.expected_version/);
  assert.match(sql, /version = pc\.version \+ 1/);
  assert.match(sql, /updated_at = now\(\)/);
  assert.match(sql, /get diagnostics changed_count = row_count/);
  assert.match(sql, /CAS update was partial; transaction rolled back/);
  assert.doesNotMatch(sql, /set\s+served_publicly\s*=/i);
  assert.doesNotMatch(sql, /payloadSchemaVersion/);

  for (const row of manifest.rows) {
    assert.match(sql, new RegExp(row.configName));
    assert.ok(sql.includes(JSON.stringify(row.payload)));
    assert.match(sql, new RegExp(row.payloadFingerprint));
  }
});

test('the existing gen pipeline emits and checks both operator artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-operator-gen-'));
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.ok(write.written.includes(ONE_MCP_OPERATOR_MANIFEST_FILE));
    assert.ok(write.written.includes(ONE_MCP_OPERATOR_CAS_SQL_FILE));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, ONE_MCP_OPERATOR_MANIFEST_FILE), 'utf8'),
    );
    assert.deepEqual(manifest, oneMcpOperatorManifest());
    assert.equal(
      fs.readFileSync(path.join(dir, ONE_MCP_OPERATOR_CAS_SQL_FILE), 'utf8'),
      oneMcpOperatorCasSql(),
    );

    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
