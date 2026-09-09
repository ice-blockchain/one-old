// src/shared/override/settlement-mac.ts
// HMAC over a verified (and therefore shipped) settlement, using the per-user
// override key. `settlementHash` stays an unkeyed digest — anything that can
// write the project tree can still produce a record the parser accepts. The
// MAC is what `--unblock` consults: a valid signature is a certificate this
// install wrote; an unsigned `verified` is treated as planted.

import { projectRootHash } from '../state/local-prefs/prefs-store';
import {
  OVERRIDE_SETTLEMENT_MAC_DOMAIN,
  ensureOverrideKey,
  overrideMac,
  overrideMacMatches,
  readOverrideKey,
} from './keys';
import type { RunSettlementV2 } from '../run-settlement/types';

export function settlementMacPayload(
  projectRoot: string,
  settlement: Pick<RunSettlementV2, 'runId' | 'status' | 'settlementHash' | 'revision'>,
): Record<string, unknown> {
  return {
    runId: settlement.runId,
    status: settlement.status,
    settlementHash: settlement.settlementHash,
    projectKey: projectRootHash(projectRoot),
    revision: settlement.revision,
  };
}

/**
 * Sign a verified settlement. Creates the install key if this machine has
 * never minted an override — the third caller allowed to (keys.ts). A gate
 * still must not. Failure to sign is not a reason to withhold the record:
 * the writer publishes `verified` unsigned, and `--unblock` treats that as
 * planted (mint proceeds).
 */
export function signVerifiedSettlement(
  projectRoot: string,
  settlement: Pick<RunSettlementV2, 'runId' | 'status' | 'settlementHash' | 'revision'>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (settlement.status !== 'verified') return null;
  const key = ensureOverrideKey(env);
  if (!key) return null;
  return overrideMac(settlementMacPayload(projectRoot, settlement), key, OVERRIDE_SETTLEMENT_MAC_DOMAIN);
}

/**
 * Did THIS install sign this verified settlement? `false` for every other
 * status, for a missing/rotated key, and for a missing or mismatched MAC.
 * Same-uid remains the trust boundary: whoever can read the key can forge one.
 */
export function verifiedSettlementAuthentic(
  projectRoot: string,
  settlement: Pick<RunSettlementV2, 'runId' | 'status' | 'settlementHash' | 'revision' | 'settlementMac'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (settlement.status !== 'verified') return false;
  const key = readOverrideKey(env);
  if (!key) return false;
  return overrideMacMatches(
    settlementMacPayload(projectRoot, settlement),
    key,
    settlement.settlementMac,
    OVERRIDE_SETTLEMENT_MAC_DOMAIN,
  );
}
