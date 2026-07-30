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
  facts: RunSimFacts;
  // Set when the run stopped early. Names the phase and the cause, so a failing
  // case says WHICH link of the chain broke without opening the project dir.
  failure?: string;
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
}
