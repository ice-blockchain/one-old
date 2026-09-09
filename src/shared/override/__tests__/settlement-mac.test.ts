import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeRunSettlement } from '../../run-settlement';
import { projectRootHash } from '../../state/local-prefs/prefs-store';
import { settlementHash } from '../../run-settlement/types';
import {
  OVERRIDE_RECONCILIATION_MAC_DOMAIN,
  OVERRIDE_SETTLEMENT_MAC_DOMAIN,
  OVERRIDE_TOKEN_MAC_DOMAIN,
  overrideMac,
  readOverrideKey,
} from '../keys';
import { settlementMacPayload, signVerifiedSettlement, verifiedSettlementAuthentic } from '../settlement-mac';

const TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function withMachine(body: (projectRoot: string) => void): void {
  const saved = process.env.XDG_STATE_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-settlement-mac-')));
  TEMP_DIRS.push(base);
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  try {
    body(projectRoot);
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
  }
}

function verifiedRecord(runId = 'R') {
  const withoutHash = {
    schemaVersion: 2 as const,
    runId,
    runtimeVersion: '1.0.20',
    minimumRuntimeVersion: '1.0.20',
    status: 'verified' as const,
    activeClaims: 0,
    incompleteChecks: [] as string[],
    revision: 1,
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
  return { ...withoutHash, settlementHash: settlementHash(withoutHash) };
}

test('this install can sign a verified settlement, and only that MAC authenticates it', () => {
  withMachine((projectRoot) => {
    const settlement = verifiedRecord();
    const mac = signVerifiedSettlement(projectRoot, settlement);
    assert.ok(mac);
    assert.ok(readOverrideKey(), 'signing creates the install key when none exists');
    assert.equal(verifiedSettlementAuthentic(projectRoot, { ...settlement, settlementMac: mac }), true);
    assert.equal(verifiedSettlementAuthentic(projectRoot, settlement), false, 'unsigned is not authentic');
    assert.equal(
      verifiedSettlementAuthentic(projectRoot, { ...settlement, settlementMac: '00'.repeat(32) }),
      false,
      'a wrong MAC is not authentic',
    );
    assert.equal(
      verifiedSettlementAuthentic(projectRoot, { ...settlement, status: 'failed', settlementMac: mac }),
      false,
      'only verified is a certificate',
    );
  });
});

test('a MAC from another override domain is not a settlement certificate', () => {
  withMachine((projectRoot) => {
    const settlement = verifiedRecord();
    const mac = signVerifiedSettlement(projectRoot, settlement);
    assert.ok(mac);
    const key = readOverrideKey();
    assert.ok(key);
    const payload = settlementMacPayload(projectRoot, settlement);
    assert.equal(payload.projectKey, projectRootHash(projectRoot));
    for (const domain of [OVERRIDE_TOKEN_MAC_DOMAIN, OVERRIDE_RECONCILIATION_MAC_DOMAIN]) {
      const replayed = overrideMac(payload, key, domain);
      assert.notEqual(replayed, mac, `${domain.trim()} must not equal the settlement MAC`);
    }
    assert.equal(overrideMac(payload, key, OVERRIDE_SETTLEMENT_MAC_DOMAIN), mac);
  });
});

test('a non-verified settlement is not signed', () => {
  withMachine((projectRoot) => {
    fs.mkdirSync(path.join(projectRoot, '.traffic-one', 'runs', 'R'), { recursive: true });
    const settlement = writeRunSettlement(projectRoot, 'R', { status: 'active' });
    assert.equal(settlement?.status, 'active');
    assert.equal(settlement?.settlementMac, undefined);
  });
});
