// src/shared/opencode-queue-types.ts
// Queue/status shapes, unsafe-pattern list, and attempt caps for OpenCode
// delegation. Logic lives in the -store/-policy siblings; the public surface
// is re-exported by opencode-queue.ts.

export const T1_DIR = '.traffic' + '-one';
export const UNIT_ID_RE = /^[a-zA-Z0-9._-]+$/;
export const UNSAFE_ALLOWED_FILE_PATTERNS = [
  '.traffic-one/**',
  '**/.traffic-one/**',
  'node_modules/**',
  '**/node_modules/**',
  'dist/**',
  '**/dist/**',
  'build/**',
  '**/build/**',
  '.turbo/**',
  '**/.turbo/**',
  '.next/**',
  '**/.next/**',
  '.vite/**',
  '**/.vite/**',
  '.cache/**',
  '**/.cache/**',
  'coverage/**',
  '**/coverage/**',
  'playwright-report/**',
  '**/playwright-report/**',
  'test-results/**',
  '**/test-results/**',
  '**/*.tsbuildinfo',
  '*.tsbuildinfo',
] as const;

export interface OpenCodeQueueUnit {
  id: string;
  role: string;
  kind: string | null;
  allowedFiles: string[];
  task: string;
  dependsOn: string[];
}

export interface OpenCodeQueue {
  version: 1;
  runId: string;
  assignmentHash: string | null;
  queueHash: string;
  units: OpenCodeQueueUnit[];
}

export type OpenCodeUnitStatus =
  | 'queued'
  | 'running'
  | 'delegated'
  | 'failed'
  | 'no_changes'
  | 'skipped_no_units'
  | 'skipped'
  | 'rejected_policy'
  | 'abandoned'
  | 'fallback_required';

export interface OpenCodeUnitStatusEntry {
  id: string;
  role: string;
  status: OpenCodeUnitStatus;
  action?: string;
  model?: string | null;
  failureKind?: string | null;
  error?: string | null;
  touched?: string[];
  allowedFiles?: string[];
  assignmentHash?: string | null;
  /**
   * Where the unit came from. Absent (or `plan-queue`) = a unit the architect
   * queued in plan.md; `direct` = a per-role `opencode_delegate` call, which
   * has no queue entry but must still be registered so no delegation is
   * invisible in the ledger.
   */
  source?: 'plan-queue' | 'direct';
  fallback?: {
    status: 'paid_spawned';
    role: string;
    agentId?: string | null;
    digest?: string | null;
    recordedAt: string;
  };
  updatedAt: string;
  /**
   * Bounded per-attempt history (last OPENCODE_UNIT_ATTEMPT_CAP). The full
   * current error/touched live at the entry level; an attempt stores `error`
   * only when it differs from the previous attempt ('(unchanged)' otherwise)
   * and never repeats `touched` — a 6-unit run was re-storing the same
   * multi-hundred-char deny message on every retry.
   */
  attempts?: Array<{
    status: OpenCodeUnitStatus;
    action?: string;
    model?: string | null;
    failureKind?: string | null;
    error?: string | null;
    updatedAt: string;
  }>;
}

export const OPENCODE_UNIT_ATTEMPT_CAP = 8;
export const OPENCODE_UNIT_ATTEMPT_ERROR_MAX = 2000;
