// src/runners/opencode/types.ts
// Delegation constants, the hardened run env, and the public result types.

import * as path from 'path';
import { gatewayBreakerMs, maxConsecutiveStalls, opencodeUnitTimeoutMs } from '../../config/opencode-timeouts';
import { exec } from '../../shared/exec';
import {
  hasFreshArchitectQueueForRun,
  markOpenCodeGatewayOutage,
  markOpenCodePlanRoleCompleted,
  markOpenCodeRoleAttempted,
  openCodeGatewayOutageActive,
  type PlanDelegationUnit,
  parsePlanDelegationUnits,
  recordOpenCodeAttemptOutcome,
} from '../../shared/opencode-roles';

export type Rec = Record<string, unknown>;
export const which = exec.which;
export const T1_DIR = '.traffic' + '-one';

// Absolute backstop only — NOT the routine bound. Bounded units finish in
// ~2 min; long-but-alive runs keep going while the orchestrator keeps polling,
// and the MCP server's poll-liveness watchdog cancels abandoned runs (parent
// stopped polling) long before this. This ceiling exists for the non-MCP shell
// path and as machine hygiene against a truly hung CLI.
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const DIGEST_HARD_BYTES = 3072;
// The free gateway models are non-deterministic and sometimes "chat" without
// editing. Allow ONE bounded retry (still free) on a clean no-op before falling
// back to a paid subagent — this measurably raises the delegation hit-rate.
export const MAX_DELEGATE_ATTEMPTS = 2;
// A stalled model (spawn timeout with no gateway response — observed live as
// `spawnSync … opencode ETIMEDOUT` on the chain head) advances the chain like a
// retired promo id, so one hung free model no longer kills the whole delegation.
// But each stall burns the FULL unit timeout, so maxConsecutiveStalls()
// back-to-back stalls are treated as a gateway/network-wide outage: the walk
// stops AND the run-scoped gateway breaker trips (markOpenCodeGatewayOutage),
// so later units/role shards in the same run fast-fail instead of re-burning
// full-ceiling probes that would only delay the paid fallback the orchestrator has.

// Headless hardening for the spawned CLI (verified against the pinned 1.15.13
// binary, which supports all three env vars): never self-update mid-run, never
// share sessions, don't inject the user's global ~/.claude/CLAUDE.md into the
// delegation context, and pin the two ask-default permissions to a deterministic
// `deny`. `opencode run` already auto-rejects permission asks headlessly on the
// pinned version, but resolveBin() can fall back to an unpinned PATH binary —
// and an allowed `external_directory` would let the model write OUTSIDE the
// throwaway worktree, escaping the diff-capture sandbox entirely. Config layers
// merge key-by-key, so this overrides only these keys, not the user's config.
export const OPENCODE_RUN_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    autoupdate: false,
    share: 'disabled',
    permission: { external_directory: 'deny', doom_loop: 'deny' },
  }),
};


export interface DelegateOpts {
  role?: string;
  task?: string;
  runId?: string;
  model?: string;
  allowedFiles?: string;
  unitId?: string;
  expectedAssignmentHash?: string | null;
  fallbackAllowed?: boolean;
}

export type FailureKind =
  | 'provider-timeout'
  | 'verification-failed'
  | 'no-changes'
  | 'diff-rejected'
  | 'opencode-error'
  | 'environment'
  | 'skipped';

export interface DelegateResult {
  ok: boolean;
  // delegated = applied to the tree; skipped = precondition not met (fall back);
  // failed/no-changes = opencode could not deliver (fall back).
  action: 'delegated' | 'skipped' | 'failed' | 'no-changes';
  digest: string | null;
  touched: string[];
  error: string | null;
  model?: string;
  failureKind?: FailureKind;
}
