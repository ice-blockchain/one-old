import type { UserPlan } from '../../config/model-tiers';

export interface OneMcpRemoteTiersV2 {
  readonly high: readonly string[];
  readonly balanced: readonly string[];
  readonly low: readonly string[];
  readonly auto: readonly string[];
}

export interface OneMcpModelConfigPayloadV2 {
  readonly payloadSchemaVersion: 2;
  readonly tiers: OneMcpRemoteTiersV2;
  readonly plans?: Readonly<Partial<Record<UserPlan, OneMcpRemoteTiersV2>>>;
}

export interface OneMcpAppliedTiers {
  readonly highest: readonly string[];
  readonly balanced: readonly string[];
  readonly cheapest: readonly string[];
}

export interface OneMcpCanonicalFullConfig {
  readonly payload: OneMcpModelConfigPayloadV2;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type OneMcpInvalidResponseReason =
  | 'unsafe-object-graph'
  | 'invalid-json-rpc-envelope'
  | 'unexpected-json-rpc-error'
  | 'invalid-tool-result'
  | 'invalid-up-to-date-sentinel'
  | 'invalid-full-config'
  | 'unsupported-payload-schema';

export interface OneMcpFullConfigOutcome {
  readonly kind: 'full';
  readonly config: OneMcpCanonicalFullConfig;
  readonly payloadFingerprint: string;
}

export interface OneMcpUpToDateOutcome {
  readonly kind: 'up-to-date';
  readonly version: number;
}

export interface OneMcpConfigNotFoundOutcome {
  readonly kind: 'config-not-found';
}

export interface OneMcpTemporaryErrorOutcome {
  readonly kind: 'temporary-error';
}

export interface OneMcpInvalidResponseOutcome {
  readonly kind: 'invalid-response';
  readonly reason: OneMcpInvalidResponseReason;
  /** Valid server row version observed before the remaining body was rejected. */
  readonly observedVersion?: number;
}

export type OneMcpGetConfigOutcome =
  | OneMcpFullConfigOutcome
  | OneMcpUpToDateOutcome
  | OneMcpConfigNotFoundOutcome
  | OneMcpTemporaryErrorOutcome
  | OneMcpInvalidResponseOutcome;
