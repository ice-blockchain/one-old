// src/modules/agent-model/model-choice.ts
// Run-scoped, project-local store for the "recommended model is disabled/unavailable"
// spawn decision, plus the one-time proactive-advisory marker. Cursor gives NO runtime
// signal that a model is disabled (it silently falls back), so this can't be triggered
// by detecting a failure — the agent-model gate prompts when it cannot VALIDATE the
// spawn model against the tier, and the user's reply (parsed in prompt-submit) lands
// here. The "models disabled" toggle is account-wide, so the decision is a RUN-level
// policy (one prompt per build; every role honors it), not per-role.
//
// Storage mirrors the opencode-roles marker style: tiny files under
// `.traffic-one/runs/<runId>/`, best-effort, never throwing. Run-scoped means a new
// build re-prompts naturally (no cross-run staleness).

import * as fs from 'fs';
import * as path from 'path';

import { cursorUnavailablePicks } from '../../shared/materialize/cursor-eligibility';

export type ModelChoiceStatus = 'use-fallback' | 'enable-retry';
const VALID: ReadonlySet<string> = new Set<string>(['use-fallback', 'enable-retry']);
const MODEL_GATE_PROMPT_TTL_MS = 5 * 60 * 1000;

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId);
}
function choicePath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'model-choice.json');
}
function promptedPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'model-choice-prompted');
}
function advisoryPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'model-advisory');
}
function modelGatePromptPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'model-gate-prompted.json');
}

// True while a run still needs an explicit user reply before fallback spawns proceed.
// Covers unavailable picked models (capture list) and the Composer-floor degradation path
// (modelChoicePrompted marker set by the spawn gate on first deny).
export function modelChoiceReplyPending(cwd: string, state: Record<string, unknown>): boolean {
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId || readModelChoice(cwd, runId)) return false;
  if (cursorUnavailablePicks(cwd, state).length > 0) return true;
  return modelChoicePrompted(cwd, runId);
}

// The recorded user choice for this run, or null when none/invalid.
export function readModelChoice(cwd: string, runId: string): ModelChoiceStatus | null {
  if (!runId) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(choicePath(cwd, runId), 'utf8')) as { status?: unknown };
    const s = typeof raw?.status === 'string' ? raw.status : '';
    return VALID.has(s) ? (s as ModelChoiceStatus) : null;
  } catch {
    return null;
  }
}

export function writeModelChoice(cwd: string, runId: string, status: ModelChoiceStatus): boolean {
  if (!runId || !VALID.has(status)) return false;
  try {
    const p = choicePath(cwd, runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ status, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function clearModelChoice(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    fs.unlinkSync(choicePath(cwd, runId));
  } catch {
    // already absent / best-effort
  }
}

// Whether the gate has ALREADY asked the user the disabled-model question this run.
// Guarantees the no-deadlock invariant: the gate prompts at most once per run, then
// reverts to the orchestrator-facing fallback deny.
export function modelChoicePrompted(cwd: string, runId: string): boolean {
  if (!runId) return false;
  try {
    return fs.existsSync(promptedPath(cwd, runId));
  } catch {
    return false;
  }
}

export function markModelChoicePrompted(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    const p = promptedPath(cwd, runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only risks one extra (harmless) prompt
  }
}

// One-time per-run proactive advisory (B2): true once it has been shown.
export function modelAdvisoryShown(cwd: string, runId: string): boolean {
  if (!runId) return false;
  try {
    return fs.existsSync(advisoryPath(cwd, runId));
  } catch {
    return false;
  }
}

export function markModelAdvisoryShown(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    const p = advisoryPath(cwd, runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a failed write only risks the advisory showing again
  }
}

export function markModelGatePrompted(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    const p = modelGatePromptPath(cwd, runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ promptedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort; without the marker the runner fails closed instead of assuming approval
  }
}

export function modelGatePromptFresh(
  cwd: string,
  runId: string,
  nowMs: number = Date.now(),
  ttlMs: number = MODEL_GATE_PROMPT_TTL_MS,
): boolean {
  if (!runId) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(modelGatePromptPath(cwd, runId), 'utf8')) as { promptedAt?: unknown };
    const t = typeof raw?.promptedAt === 'string' ? Date.parse(raw.promptedAt) : NaN;
    return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= ttlMs;
  } catch {
    return false;
  }
}

export function clearModelGatePrompted(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    fs.unlinkSync(modelGatePromptPath(cwd, runId));
  } catch {
    // already absent / best-effort
  }
}

// Parse a user reply to the disabled-model question. Returns null when the reply
// doesn't clearly pick an option (caller falls through to normal handling). Checks
// the fallback option first so "use fallback" isn't caught by a generic verb.
// Intentionally strict: diagnostic questions like "why wasn't I asked about fallback?"
// must never be interpreted as consent to run on fallback models.
export function parseModelChoice(prompt: string): ModelChoiceStatus | null {
  const text = String(prompt || '').trim().toLowerCase();
  if (!text) return null;
  if (/[?]/.test(text)) return null;
  const compact = text
    .replace(/[`"'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^please\s+/, '')
    .replace(/\s+please$/, '');
  if (!compact) return null;
  if (/^(?:2|two|option 2|option two|fallback|use fallback|use the fallback|use fallback model|use the fallback model|next eligible|next eligible model|use next eligible|use the next eligible|use next eligible model|use the next eligible model|proceed with fallback|continue with fallback)$/.test(compact)) {
    return 'use-fallback';
  }
  if (/^(?:1|one|option 1|option one|enable|enable retry|enable and retry|enable model|enable models|turn on model|turn on models|retry after enable)$/.test(compact)) {
    return 'enable-retry';
  }
  return null;
}
