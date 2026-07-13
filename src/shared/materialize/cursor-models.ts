// Cursor's exact Task/Subagent model list is machine/user state, not project
// configuration. It lives under the active project's local preferences at
// hosts.cursor.availableModels and is invalidated by plan changes, catalog date
// changes, or a seven-day TTL.

import * as fs from 'fs';
import * as path from 'path';

import { currentHostModelSnapshot } from '../current-model-tiers';
import { canonicalPlan, modelMatchesExpected } from '../model-tiers';
import { obj } from '../obj';
import { mergeProjectHostPrefs, readProjectPrefs } from '../state/local-prefs';

export const LEGACY_CURSOR_MODELS_REL = path.join('.traffic-one', 'cursor-models.json');
/** @deprecated Legacy cleanup only. New captures never use a project file. */
export const CURSOR_MODELS_REL = LEGACY_CURSOR_MODELS_REL;

export const CURSOR_MODELS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CursorModelsCapture {
  models: string[];
  plan: string | null;
  modelsUpdatedAt: string | null;
  capturedAt: string | null;
}

function emptyCapture(): CursorModelsCapture {
  return { models: [], plan: null, modelsUpdatedAt: null, capturedAt: null };
}

function readRaw(cwd: string, env: NodeJS.ProcessEnv = process.env): CursorModelsCapture {
  try {
    const prefs = readProjectPrefs(cwd, env);
    const capture = obj(obj(obj(prefs.hosts)?.cursor)?.availableModels);
    if (!capture || !Array.isArray(capture.models)) return emptyCapture();
    return {
      models: capture.models.filter((model): model is string => typeof model === 'string' && model.trim().length > 0),
      plan: typeof capture.plan === 'string' ? capture.plan : null,
      modelsUpdatedAt: typeof capture.modelsUpdatedAt === 'string' ? capture.modelsUpdatedAt : null,
      capturedAt: typeof capture.capturedAt === 'string' ? capture.capturedAt : null,
    };
  } catch {
    return emptyCapture();
  }
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= 256
    && !/^(?:EXACT_MODEL_ID_\d+|MORE_EXACT_MODEL_IDS)$/.test(value.trim())
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function captureCursorModels(
  cwd: string,
  modelsInput: readonly unknown[],
  currentPlan: unknown,
  capturedAtIso: string = new Date().toISOString(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const plan = canonicalPlan('cursor', currentPlan);
  const models = [...new Set(modelsInput.filter(validModelId).map((model) => model.trim()))];
  if (!models.length || !Number.isFinite(Date.parse(capturedAtIso))) return false;
  try {
    const catalog = currentHostModelSnapshot('cursor', plan, env);
    mergeProjectHostPrefs(cwd, 'cursor', {
      availableModels: {
        models,
        plan,
        modelsUpdatedAt: catalog.updatedAt,
        capturedAt: capturedAtIso,
      },
    }, env);
    return readRaw(cwd, env).models.length > 0;
  } catch {
    return false;
  }
}

export function readCursorModels(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return readRaw(cwd, env).models;
}

export function cursorModelsFresh(
  cwd: string,
  currentPlan: unknown,
  nowMs: number = Date.now(),
  ttlMs: number = CURSOR_MODELS_TTL_MS,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const capture = readRaw(cwd, env);
  if (!capture.models.length || !capture.plan || !capture.modelsUpdatedAt || !capture.capturedAt) return false;
  const plan = canonicalPlan('cursor', currentPlan);
  if (capture.plan !== plan) return false;
  const catalog = currentHostModelSnapshot('cursor', plan, env);
  if (capture.modelsUpdatedAt !== catalog.updatedAt) return false;
  const capturedAt = Date.parse(capture.capturedAt);
  return Number.isFinite(capturedAt) && nowMs - capturedAt <= ttlMs;
}

export function freshCursorModels(
  cwd: string,
  currentPlan: unknown,
  nowMs?: number,
  ttlMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return cursorModelsFresh(cwd, currentPlan, nowMs, ttlMs, env) ? readRaw(cwd, env).models : [];
}

export function hasFreshCursorModels(
  cwd: string,
  currentPlan: unknown,
  nowMs?: number,
  ttlMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return cursorModelsFresh(cwd, currentPlan, nowMs, ttlMs, env);
}

// Hard-cutover hygiene. Never import the legacy project file. Delete it only
// when every key and value matches the Traffic One capture shape; an extra key
// is treated as user-authored and preserved.
export function cleanupLegacyCursorModels(cwd: string): boolean {
  const file = path.join(cwd, LEGACY_CURSOR_MODELS_REL);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const allowed = new Set(['models', 'plan', 'capturedAt', 'modelsUpdatedAt']);
    if (Object.keys(raw).some((key) => !allowed.has(key))) return false;
    if (!Array.isArray(raw.models) || !raw.models.every(validModelId)) return false;
    if (raw.plan !== undefined && typeof raw.plan !== 'string') return false;
    if (raw.capturedAt !== undefined && typeof raw.capturedAt !== 'string') return false;
    if (raw.modelsUpdatedAt !== undefined && typeof raw.modelsUpdatedAt !== 'string') return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function pickCursorSlug(acceptableFamilies: readonly string[], models: readonly string[]): string | null {
  for (const family of acceptableFamilies) {
    const hit = models.find((model) => modelMatchesExpected(model, family));
    if (hit) return hit;
  }
  return null;
}

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
    const marker = capturePromptedPath(cwd, runId);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '', 'utf8');
  } catch {
    // Best effort; a missing marker only risks one extra capture request.
  }
}
