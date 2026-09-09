// src/test-environment/core/run-sim/types.ts
// Transcript shape for a simulated run. The transcript IS the evidence: every
// scripted write records the gate's verdict at the moment a competent role would
// have made it, so "no false deny anywhere in the chain" is a readable artifact
// rather than an inference from a green/red bit.

export interface WriteOutcome {
  ordinal: number;
  phase: string;
  role: string | null;
  path: string;
  bytes: number;
  denied: boolean;
  // The verbatim deny text the model would have seen. Kept in full: a truncated
  // reason is exactly what made past run failures undiagnosable.
  reason?: string;
  // Set when the case EXPECTED this deny (negative-gate rows). An expected deny
  // is not a failure; an unexpected one is.
  expected?: boolean;
  /** The phrase the deny was required to contain, echoed for the assertion. */
  denyMatch?: string;
  /**
   * The handler id the row required (`ScriptedWrite.expectHandler`), echoed so
   * assertions can pin the producer without re-deriving it.
   */
  expectHandler?: string;
  // Recorded from HookResult after runPipeline(stampDeny): denyId is the gate's
  // declared id (or the pipeline crash id), and gateId is the producing handler.
  denyId?: string;
  // The handler `id` stampDeny set. Absent on an allow. A crash deny still
  // names the handler that threw — denyId is then `pipeline-handler-crashed`.
  gateId?: string;
  // Runtime spawnIndex is 1-based (`nextSpawnIndex` uses Math.max(..., 1)).
  // The plan's "spawnIndex 0" means first spawn / first attempt, which is
  // `spawnIndex === 1` here, or the first write of this role in the transcript.
  // Parent writes without a role omit this.
  spawnIndex?: number;
  // The host passed to writeCtx (applyScriptedWrite defaults to 'claude').
  host?: string;
}

// One agentModelGate call from the maintenance spawn-gate composition. A scoped
// deny already fails the run; denyId is still recorded so the briefing ratchet
// can see `performance-model-param`.
export interface SpawnOutcome {
  ordinal: number;
  phase: string;
  role: string;
  denied: boolean;
  denyId?: string;
  // Same 1-based convention as WriteOutcome.spawnIndex.
  spawnIndex?: number;
  host?: string;
  expected?: boolean;
  reason?: string;
}

// A fact snapshot taken between phases. Assertions read these rather than
// re-deriving state, so a transcript is self-describing when read months later.
export interface RunSimFacts {
  materialization?: { status: string; rules: number; skills: number };
  baselineKind?: string;
  modelPolicy?: boolean;
  architectureHash?: string;
  verificationHash?: string;
  assignmentsHash?: string;
  settlementStatus?: string;
  uiImpact?: string;
  browserRequired?: boolean;
  requiredChecks?: string[];
  bootstrapRoles?: string[];
  scaffoldOutputs?: string[];
  sourceFileCount?: number;
  [key: string]: unknown;
}

export interface RunSimTranscript {
  ok: boolean;
  caseId: string;
  runId: string;
  mode: string;
  durationMs: number;
  phasesCompleted: string[];
  writes: WriteOutcome[];
  spawns?: SpawnOutcome[];
  facts: RunSimFacts;
  // Set when the run stopped early. Names the phase and the cause, so a failing
  // case says WHICH link of the chain broke without opening the project dir.
  failure?: string;
  /**
   * Set INSTEAD of nothing when the run stopped because a required TOOLCHAIN is
   * absent on this machine (the QA runner's own `blocked-environment` verdict).
   * `failure` is still set — the run really did not finish — but assertions read
   * this to report INCONCLUSIVE rather than FAIL.
   *
   * AGENTS.md has always promised that a missing toolchain is INCONCLUSIVE, not a
   * pass; the browser half never delivered it. On a machine with no
   * project-local Playwright, 48 assertions read "Project-local Playwright is
   * unavailable" as a PRODUCT failure. Confusing "the answer is no" with "I could
   * not look" is the exact inversion this suite exists to prevent, and it was
   * happening in the suite itself.
   */
  environmentBlock?: string;
}

export interface ScriptedWrite {
  path: string;
  content: string;
  // Defaults to 'Write'. An edit-shaped tool exercises a different gate branch.
  tool?: 'Write' | 'Edit';
  // Negative-gate rows set this: the write MUST be denied, and the transcript
  // records the deny as expected rather than as a failure.
  expectDeny?: boolean;
  /**
   * A distinctive phrase the deny must contain. Without it a row proves only
   * that SOMETHING refused the write — the wrong gate firing for the wrong
   * reason would still look green.
   */
  denyMatch?: string;
  /**
   * The handler id that must produce the deny (e.g. `plan-guard.write`).
   * Presence of a deny is not enough: a crash or a different pipeline handler
   * must not satisfy the row.
   */
  expectHandler?: string;
}

// One 'prompt' maintenance leg as it actually routed. The assertion reads these
// instead of re-deriving, so a months-old transcript still explains itself.
export interface MaintenanceLegFact {
  ordinal: number;
  kind: 'prompt' | 'open-run' | 'resolve-run';
  prompt?: string;
  // What the case pinned vs what the real router did.
  expectedRouting?: string;
  routing?: string;
  expectedTier?: string;
  tier?: string;
  confidence?: string;
  signals?: string[];
  runIdBefore: string;
  runIdAfter: string;
  rotated: boolean;
  // model-policy.json existed for runIdAfter when the leg finished — pins the
  // beginFreshMaintenanceRun freeze (observed 11c: a missing policy denied the
  // first followup to a retained implementer thread).
  modelPolicyFrozen?: boolean;
  // resolve-run: the canonical settlement status after settling.
  settlementStatus?: string;
}
