import { createHash } from 'crypto';

import { PLAN_IDS, type UserPlan } from '../../config/model-tiers';
import type {
  OneMcpAppliedTiers,
  OneMcpModelConfigPayloadV2,
  OneMcpRemoteTiersV2,
} from './types';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function mapOneMcpTiers(tiers: OneMcpRemoteTiersV2): OneMcpAppliedTiers {
  return Object.freeze({
    highest: Object.freeze([...tiers.high]),
    balanced: Object.freeze([...tiers.balanced]),
    cheapest: Object.freeze([...tiers.low]),
  });
}

export function oneMcpRemoteTiersForPlan(
  payload: OneMcpModelConfigPayloadV2,
  plan: UserPlan,
): OneMcpRemoteTiersV2 {
  return payload.plans?.[plan] ?? payload.tiers;
}

// Fingerprint the entire validated operator payload. `auto` deliberately lives
// here so a cache can observe every semantic API change even though Traffic One
// does not bind that tier to Performance or subagents.
export function oneMcpPayloadFingerprint(payload: OneMcpModelConfigPayloadV2): string {
  const plans: Partial<Record<UserPlan, {
    high: readonly string[];
    balanced: readonly string[];
    low: readonly string[];
    auto: readonly string[];
  }>> = {};
  for (const plan of PLAN_IDS) {
    const tiers = payload.plans?.[plan];
    if (!tiers) continue;
    plans[plan] = {
      high: [...tiers.high],
      balanced: [...tiers.balanced],
      low: [...tiers.low],
      auto: [...tiers.auto],
    };
  }
  return sha256(JSON.stringify({
    payloadSchemaVersion: payload.payloadSchemaVersion,
    tiers: {
      high: [...payload.tiers.high],
      balanced: [...payload.tiers.balanced],
      low: [...payload.tiers.low],
      auto: [...payload.tiers.auto],
    },
    plans,
  }));
}

// Fingerprint only what Traffic One actually applies. A row-version bump,
// timestamp update, or auto-only edit therefore cannot spuriously reopen the
// user's Performance choice.
export function oneMcpAppliedFingerprint(tiers: OneMcpAppliedTiers): string {
  return sha256(JSON.stringify({
    highest: [...tiers.highest],
    balanced: [...tiers.balanced],
    cheapest: [...tiers.cheapest],
  }));
}

export function oneMcpAppliedFingerprintForPlan(
  payload: OneMcpModelConfigPayloadV2,
  plan: UserPlan,
): string {
  return oneMcpAppliedFingerprint(mapOneMcpTiers(oneMcpRemoteTiersForPlan(payload, plan)));
}
