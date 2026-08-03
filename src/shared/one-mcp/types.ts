import type { UserPlan } from '../../config/model-tiers';

export interface OneMcpRemoteTiers {
  readonly high: readonly string[];
  readonly balanced: readonly string[];
  readonly low: readonly string[];
  readonly auto: readonly string[];
}

export interface OneMcpModelConfigPayload {
  readonly tiers: OneMcpRemoteTiers;
  readonly plans?: Readonly<Partial<Record<UserPlan, OneMcpRemoteTiers>>>;
}

export interface OneMcpAppliedTiers {
  readonly highest: readonly string[];
  readonly balanced: readonly string[];
  readonly cheapest: readonly string[];
}

export interface OneMcpCanonicalFullConfig {
  readonly payload: OneMcpModelConfigPayload;
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
  | 'invalid-full-config';

export interface OneMcpFullConfigOutcome {
  readonly kind: 'full';
  readonly config: OneMcpCanonicalFullConfig;
  readonly payloadFingerprint: string;
}

interface OneMcpUpToDateOutcome {
  readonly kind: 'up-to-date';
  readonly version: number;
}

interface OneMcpConfigNotFoundOutcome {
  readonly kind: 'config-not-found';
}

interface OneMcpTemporaryErrorOutcome {
  readonly kind: 'temporary-error';
}

interface OneMcpInvalidResponseOutcome {
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
