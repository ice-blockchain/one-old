// src/shared/state/delegated-model-observation.ts
// Model provenance for DELEGATED work — the counterpart to
// codex-model-observation.ts, which only ever sees HOST subagents.
//
// Observed live: five Codex children were each recorded with a verified tier,
// while the free model the delegation runner actually ran — the one that wrote
// twelve source/locale files plus a test file — appeared in ZERO model
// observation records. Provenance was enforced for spawned children and
// entirely absent for the worker that produced most of the diff.
//
// Deliberately a SEPARATE store: `codex-model-observations.json` is identity-
// bound gate state (its rows drive claim resolution and the immutable per-run
// model policy), and a delegated worker has no child thread, no claim and no
// role policy entry — folding it in there would evaluate a free model against a
// role's acceptable-model list and wedge the role. Like claim-capture.ts this
// is a durable diagnostic ledger: it never changes a gate decision and never
// throws.

import * as fs from 'fs';
import * as path from 'path';

import { RUNS_REL_DIR } from '../../config/state';
import { isNonProjectRoot } from '../authoring-root';
import { writeJson } from '../fsjson';
import { obj } from '../obj';

import { withProjectStateLock } from './project-state-lock';

const STORE_FILE = 'delegated-model-observations.json';
const MAX_OBSERVATIONS = 200;
const MAX_TOUCHED = 40;
const MAX_ERROR = 300;

export interface DelegatedModelObservation {
  /** Delegation role label as the runner received it (e.g. `senior-frontend`). */
  role: string;
  /** The model the delegation actually ran on — the whole point of the record. */
  model: string;
  /** Terminal delegate action: delegated | failed | no-changes | skipped. */
  action: string;
  /** Plan-queue unit id, or the synthesized id of a direct delegation. */
  unitId: string | null;
  touched: string[];
  digest: string | null;
  error: string | null;
  observedAt: string;
}

function safeSegment(value: string): string {
  return (value || 'run').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'run';
}

function storePath(cwd: string, runId: string): string {
  return path.join(cwd, RUNS_REL_DIR, safeSegment(runId), STORE_FILE);
}

function parseObservation(value: unknown): DelegatedModelObservation | null {
  const raw = obj(value);
  if (!raw || typeof raw.role !== 'string' || typeof raw.model !== 'string' || typeof raw.observedAt !== 'string') {
    return null;
  }
  return {
    role: raw.role,
    model: raw.model,
    action: typeof raw.action === 'string' ? raw.action : 'unknown',
    unitId: typeof raw.unitId === 'string' ? raw.unitId : null,
    touched: Array.isArray(raw.touched) ? raw.touched.filter((f): f is string => typeof f === 'string') : [],
    digest: typeof raw.digest === 'string' ? raw.digest : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    observedAt: raw.observedAt,
  };
}

export function readDelegatedModelObservations(cwd: string, runId: string): DelegatedModelObservation[] {
  if (!runId) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath(cwd, runId), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseObservation).filter((o): o is DelegatedModelObservation => Boolean(o));
  } catch {
    return [];
  }
}

/**
 * Append one delegated-model observation. Called for every delegation attempt
 * that reached a resolved model, whatever the role and whatever the outcome —
 * a failed attempt is provenance too (it names the model that was tried).
 */
export function recordDelegatedModelObservation(
  cwd: string,
  runId: string,
  input: {
    role: string;
    model: string | null | undefined;
    action: string;
    unitId?: string | null;
    touched?: readonly string[];
    digest?: string | null;
    error?: string | null;
  },
): void {
  const role = String(input.role || '').trim();
  const model = String(input.model || '').trim();
  if (!runId || !role || !model) return;
  if (isNonProjectRoot(cwd)) return; // never write run state in the plugin's own repo
  try {
    withProjectStateLock(cwd, () => {
      const observations = readDelegatedModelObservations(cwd, runId);
      observations.push({
        role,
        model,
        action: String(input.action || 'unknown'),
        unitId: input.unitId ? String(input.unitId) : null,
        touched: (input.touched || []).slice(0, MAX_TOUCHED).map((f) => String(f)),
        digest: input.digest ?? null,
        error: input.error ? String(input.error).slice(0, MAX_ERROR) : null,
        observedAt: new Date().toISOString(),
      });
      writeJson(storePath(cwd, runId), observations.slice(-MAX_OBSERVATIONS));
    });
  } catch {
    // best-effort provenance; never block or fail a delegation
  }
}
