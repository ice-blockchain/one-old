// src/shared/token-logger.ts
// In-flight per-tool token-usage logger. OFF by default; opt in with
// TRAFFIC_ONE_TOKEN_LOG=1. When enabled, PostToolUse handlers append one JSONL
// line per tool call to .traffic-one/token-log.jsonl with byte + phase context.
// Complements the token-report runner (which parses billed-token transcripts);
// this adds per-tool byte counts + role attribution. No-op when the flag is
// unset — zero overhead for users who never opt in. Ported 1:1 from
// scripts/hook-runtime/token-logger.cjs.

import * as fs from 'fs';
import * as path from 'path';

import {
  hasRunAgentState,
  legacyRunAgentContext,
  legacyStatePath,
  readState,
  resolveRunAgentContext,
  statePath,
} from './state';

import { LOG_REL_PATH, TOKEN_LOG_ENV_FLAG } from '../config/token-logger';
import { toolResultContainer } from './tool-result';

type Rec = Record<string, unknown>;

export function isEnabled(): boolean {
  const v = process.env[TOKEN_LOG_ENV_FLAG];
  return v === '1' || v === 'true' || v === 'yes';
}

export function estimateTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}

export function readSizeFromValue(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

export interface Phase { runId: string | null; role: string | null; }

// Best-effort phase lookup from .traffic-one/.one.json in cwd.
function readPhase(cwd: string, payload: Rec | null = null): Phase {
  if (!fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd))) {
    return { runId: null, role: null };
  }
  try {
    const state = readState(cwd);
    const agentContext = resolveRunAgentContext(cwd, state, payload || {}, {
      claimPending: false,
      host: process.env.TRAFFIC_ONE_HOST,
    })
      || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
    const ctxRunId = agentContext && typeof agentContext.runId === 'string' ? agentContext.runId : null;
    const ctxRole = agentContext && typeof agentContext.role === 'string' ? agentContext.role : null;
    return {
      runId: ctxRunId ?? (typeof state.currentRunId === 'string' ? state.currentRunId : null),
      role: ctxRole ?? (typeof state.activeAgentRole === 'string' ? state.activeAgentRole : null),
    };
  } catch {
    return { runId: null, role: null };
  }
}

// Append one entry. Safe to call from any hook; silently no-ops when disabled or
// on write failure. Never throws.
//
// `canonicalToolInput` is the adapter-parsed input (`parsedToolInput(ctx.input.tool)`)
// for hosts that do not put one in the payload — Cursor carries the command on the
// parsed tool and nowhere in `raw`, so without it every Cursor row logged
// `inputBytes: 0`. The payload's own field still wins where it exists, so the
// hosts that had a number keep exactly the number they had.
export function logToolUse(cwd: string, payloadInput: unknown, canonicalToolInput?: unknown): void {
  if (!isEnabled()) return;
  if (!payloadInput || typeof payloadInput !== 'object') return;
  const payload = payloadInput as Rec;
  const payloadToolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : null;
  const fallbackToolInput = canonicalToolInput && typeof canonicalToolInput === 'object' ? canonicalToolInput : null;
  const toolInput = payloadToolInput ?? fallbackToolInput ?? {};
  // The STRICT reader, because this is byte ACCOUNTING: `toolResultContainer`
  // returns null when no host in the known space named a result container, and
  // null must log 0 rather than fall back to the payload — the lenient reader
  // would count the tool INPUT into the output total, which is worse than a zero
  // because it looks like a measurement. Reading `tool_response || tool_result`
  // was two of the four wrapper spellings and no container at all, so measured on
  // one payload from each of the five host families only Claude's produced a
  // non-zero `outputBytes`; the other four logged a tool result of size 0 and an
  // `estTokens` short by the whole result.
  const toolResp = toolResultContainer(payload);
  const inputBytes = readSizeFromValue(toolInput);
  const outputBytes = readSizeFromValue(toolResp);
  const phase = readPhase(cwd, payload);
  const entry = {
    ts: new Date().toISOString(),
    runId: phase.runId,
    role: phase.role,
    hookEvent: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : null,
    toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
    inputBytes,
    outputBytes,
    estTokens: estimateTokens(inputBytes + outputBytes),
  };
  const dst = path.join(cwd, LOG_REL_PATH);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.appendFileSync(dst, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // best-effort; never block a hook on logging
  }
}

// Log a hook-injected context block (our own injected bytes).
