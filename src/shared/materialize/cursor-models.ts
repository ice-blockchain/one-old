// Cursor's exact Task/Subagent model list is machine/user state, not project
// configuration. It lives under the active project's local preferences at
// hosts.cursor.availableModels and is invalidated by plan changes, semantic
// catalog fingerprint changes, or a seven-day TTL.

import { ONE_MCP_MAX_AVAILABLE_MODELS, isSafeOneMcpModelId } from '../../config/one-mcp';
import { currentHostModelTarget } from '../current-model-tiers';
import { canonicalPlan, modelMatchesExpected } from '../model-tiers';
import { obj } from '../obj';
import { mergeProjectHostPrefs, readProjectPrefs } from '../state/local-prefs';

export const CURSOR_MODELS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CURSOR_MODELS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

interface CursorModelsCapture {
  models: string[];
  capturedAt: string | null;
  target: {
    plan: string;
    appliedFingerprint: string;
  } | null;
}

function emptyCapture(): CursorModelsCapture {
  return {
    models: [],
    capturedAt: null,
    target: null,
  };
}

function readRaw(cwd: string, env: NodeJS.ProcessEnv = process.env): CursorModelsCapture {
  try {
    const prefs = readProjectPrefs(cwd, env);
    const capture = obj(obj(obj(prefs.hosts)?.cursor)?.availableModels);
    if (!capture || !Array.isArray(capture.models)) return emptyCapture();
    const target = obj(capture.target);
    return {
      models: capture.models.filter((model): model is string => typeof model === 'string' && model.trim().length > 0),
      capturedAt: typeof capture.capturedAt === 'string' ? capture.capturedAt : null,
      target: target
        && typeof target.plan === 'string'
        && typeof target.appliedFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(target.appliedFingerprint)
        ? { plan: target.plan, appliedFingerprint: target.appliedFingerprint }
        : null,
    };
  } catch {
    return emptyCapture();
  }
}

function validModelId(value: unknown): value is string {
  return isSafeOneMcpModelId(value)
    && !/^(?:EXACT_MODEL_ID_\d+|MORE_EXACT_MODEL_IDS)$/.test(value);
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
  const capturedAt = Date.parse(capturedAtIso);
  if (!models.length
    || models.length > ONE_MCP_MAX_AVAILABLE_MODELS
    || !Number.isFinite(capturedAt)
    || capturedAt > Date.now() + CURSOR_MODELS_MAX_FUTURE_SKEW_MS) return false;
  try {
    const target = currentHostModelTarget('cursor', plan, env);
    mergeProjectHostPrefs(cwd, 'cursor', {
      availableModels: {
        models,
        capturedAt: capturedAtIso,
        target: {
          plan,
          appliedFingerprint: target.appliedFingerprint,
        },
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
  if (!capture.models.length || !capture.target || !capture.capturedAt) return false;
  const plan = canonicalPlan('cursor', currentPlan);
  if (capture.target.plan !== plan) return false;
  const target = currentHostModelTarget('cursor', plan, env);
  const capturedAt = Date.parse(capture.capturedAt);
  if (!Number.isFinite(capturedAt)
    || capturedAt > nowMs + CURSOR_MODELS_MAX_FUTURE_SKEW_MS
    || nowMs - capturedAt > ttlMs) return false;
  return capture.target.appliedFingerprint === target.appliedFingerprint;
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

export function pickCursorSlug(acceptableFamilies: readonly string[], models: readonly string[]): string | null {
  for (const family of acceptableFamilies) {
    const hit = models.find((model) => modelMatchesExpected(model, family));
    if (hit) return hit;
  }
  return null;
}
