// src/shared/materialize/cursor-models.ts
// Dependency-free (fs-only) reader + resolver for the Cursor subagent model list the
// in-Cursor orchestrator reports its Task tool offers, captured to
// `.traffic-one/cursor-models.json` ({ "models": string[], "plan": string, "capturedAt": iso }).
// Cursor's offered subagent model set is plan/build-specific and there is NO plan-scoped API —
// but the agent CAN see the list (it surfaces it when the gate asks), so the agent is the source.
//
// SELF-HEALING on plan change: the capture is stamped with the plan it was taken under. When the
// detected plan later differs (upgrade/downgrade), the list is STALE → consumers ignore it and
// the gate re-prompts for capture, so the subagent models stay current. A TTL catches catalog
// drift (new model releases) within the same plan. Shared by the materializer (writes real slugs
// into .cursor/agents/<role>.md) and the spawn gate. Kept light so it imports cleanly into the
// hook runtime. Mirrors cursor-agent-model.ts.

import * as fs from 'fs';
import * as path from 'path';

import { modelMatchesExpected } from '../model-tiers';

export const CURSOR_MODELS_REL = path.join('.traffic-one', 'cursor-models.json');

// Re-capture after this long even if the plan is unchanged, to catch model-catalog drift
// (new releases / build changes). Plan upgrade/downgrade invalidates immediately (plan-keyed).
export const CURSOR_MODELS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CursorModelsFile {
  models: string[];
  plan: string | null;
  capturedAt: string | null;
}

function readRaw(cwd: string): CursorModelsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, CURSOR_MODELS_REL), 'utf8')) as Record<string, unknown>;
    const models = Array.isArray(raw?.models)
      ? raw.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
      : [];
    const plan = typeof raw?.plan === 'string' && raw.plan.trim() ? raw.plan.trim() : null;
    const capturedAt = typeof raw?.capturedAt === 'string' && raw.capturedAt.trim() ? raw.capturedAt.trim() : null;
    return { models, plan, capturedAt };
  } catch {
    return { models: [], plan: null, capturedAt: null };
  }
}

// The captured model ids, regardless of freshness (low-level). [] when absent/malformed.
export function readCursorModels(cwd: string): string[] {
  return readRaw(cwd).models;
}

// FRESH = has models AND (no plan stamp yet [just captured by the agent, not stamped] OR the
// stamp matches the current plan) AND (no capturedAt OR within TTL). A plan change (stamp !=
// currentPlan) or an expired TTL makes it stale → re-capture.
export function cursorModelsFresh(
  cwd: string,
  currentPlan: unknown,
  nowMs: number = Date.now(),
  ttlMs: number = CURSOR_MODELS_TTL_MS,
): boolean {
  const { models, plan, capturedAt } = readRaw(cwd);
  if (!models.length) return false;
  const cur = typeof currentPlan === 'string' && currentPlan.trim() ? currentPlan.trim() : '';
  if (plan && cur && plan !== cur) return false; // plan upgraded/downgraded
  if (capturedAt) {
    const t = Date.parse(capturedAt);
    if (Number.isFinite(t) && nowMs - t > ttlMs) return false; // catalog drift TTL
  }
  return true;
}

// The captured models if FRESH for the current plan, else [] (so consumers fall back to the
// bare family and the gate re-prompts for capture).
export function freshCursorModels(cwd: string, currentPlan: unknown, nowMs?: number, ttlMs?: number): string[] {
  return cursorModelsFresh(cwd, currentPlan, nowMs, ttlMs) ? readRaw(cwd).models : [];
}

// True when a FRESH capture exists for the current plan.
export function hasFreshCursorModels(cwd: string, currentPlan: unknown): boolean {
  return cursorModelsFresh(cwd, currentPlan);
}

// Stamp the capture-time plan + timestamp onto the agent-written list (called by the PostToolUse
// re-materialize the moment the agent writes the file). Records the plan AS IT WAS at capture so
// a later plan change is detectable. Preserves the agent's models; no-op if no models present.
export function stampCursorModels(cwd: string, plan: string, capturedAtIso: string): boolean {
  const { models } = readRaw(cwd);
  if (!models.length) return false;
  try {
    const p = path.join(cwd, CURSOR_MODELS_REL);
    fs.writeFileSync(p, `${JSON.stringify({ models, plan, capturedAt: capturedAtIso }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// From the captured build models, pick the first concrete slug whose FAMILY matches one of
// `acceptableFamilies` (preferred-first). Family match is modelMatchesExpected(slug, family),
// so a reasoning variant (`claude-opus-4-8-thinking-max-fast`) matches its family
// (`claude-opus-4-8`). Returns null when the build offers nothing in the acceptable chain.
export function pickCursorSlug(acceptableFamilies: readonly string[], models: readonly string[]): string | null {
  for (const family of acceptableFamilies) {
    const hit = models.find((m) => modelMatchesExpected(m, family));
    if (hit) return hit;
  }
  return null;
}

// ── Capture precondition once-marker (run-scoped, project-local) ──────────────
// Mirrors the opencode-roles / model-choice marker style: tiny files under
// `.traffic-one/runs/<runId>/`, best-effort, never throwing. Guarantees the gate asks the
// orchestrator to capture the model list AT MOST ONCE per run (no-deadlock: after one ask
// the gate proceeds and family-aware matching covers the spawn).
function capturePromptedPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'cursor-models-capture-prompted');
}

export function cursorModelsCapturePrompted(cwd: string, runId: string): boolean {
  if (!runId) return false;
  try {
    return fs.existsSync(capturePromptedPath(cwd, runId));
  } catch {
    return false;
  }
}

export function markCursorModelsCapturePrompted(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    const p = capturePromptedPath(cwd, runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only risks one extra (harmless) capture ask
  }
}
