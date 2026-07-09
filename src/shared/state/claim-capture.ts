// src/shared/state/claim-capture.ts
// Best-effort DIAGNOSTIC capture for the agent-teams run-team claim deadlock:
// Claude agent-teams role agents don't bind their per-run claim, so the run-team
// gate denies their feature-source writes. To fix the binding we need to see how
// those workers actually identify in the hook payload. This appends the STRUCTURAL
// shape of a payload (all keys preserved; long strings truncated) to
// .traffic-one/runs/<runId>/debug/claim-capture.jsonl. It NEVER changes any gate
// decision, NEVER throws, and is size-capped so it can't grow unbounded.

import * as fs from 'fs';
import * as path from 'path';

import { isPluginAuthoringRoot } from '../authoring-root';
import { stateTimestamp } from './io';

const MAX_CAPTURE_BYTES = 256 * 1024; // stop appending once the log gets this big
const MAX_STRING = 240; // truncate long prose (prompts/transcripts) — we want shape, not content
const MAX_DEPTH = 5;

// Recursively shrink a value: keep every object key (the identity fields we need),
// truncate long strings, and bound array length + recursion so a huge spawn prompt
// can't bloat the line.
function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return '[…]';
    return value.slice(0, 20).map((item) => shrink(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = shrink(val, depth + 1);
    return out;
  }
  return value;
}

// Append one capture line. `label` names the call site (e.g. 'subagent-start',
// 'runteam-write'); `extra` carries resolved metadata (filePath, resolved, role).
export function captureClaimDebug(
  cwd: string,
  runId: string | null | undefined,
  label: string,
  raw: unknown,
  extra: Record<string, unknown> = {},
): void {
  try {
    if (isPluginAuthoringRoot(cwd)) return; // never write run state in the plugin's own repo
    if (!runId) return;
    const dir = path.join(cwd, '.traffic-one', 'runs', String(runId), 'debug');
    const file = path.join(dir, 'claim-capture.jsonl');
    try {
      if (fs.statSync(file).size > MAX_CAPTURE_BYTES) return; // cap reached → stop, keep the early evidence
    } catch {
      // missing file → first capture
    }
    fs.mkdirSync(dir, { recursive: true });
    const entry = { at: stateTimestamp(), label, ...extra, raw: shrink(raw) };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // best-effort diagnostic; a capture failure must never affect the gate
  }
}

// Append one plan-guard deny line. Separate from claim-capture so memory/coordination
// path denials are visible even when run-team-write never fires.
export function capturePlanGuardDebug(
  cwd: string,
  runId: string | null | undefined,
  extra: Record<string, unknown> = {},
): void {
  try {
    if (isPluginAuthoringRoot(cwd)) return;
    if (!runId) return;
    const dir = path.join(cwd, '.traffic-one', 'runs', String(runId), 'debug');
    const file = path.join(dir, 'plan-guard-deny.jsonl');
    try {
      if (fs.statSync(file).size > MAX_CAPTURE_BYTES) return;
    } catch {
      // missing file → first capture
    }
    fs.mkdirSync(dir, { recursive: true });
    const entry = { at: stateTimestamp(), label: 'plan-guard-deny', ...extra };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // best-effort diagnostic
  }
}
