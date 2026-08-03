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
export function logToolUse(cwd: string, payloadInput: unknown): void {
  if (!isEnabled()) return;
  if (!payloadInput || typeof payloadInput !== 'object') return;
  const payload = payloadInput as Rec;
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const toolResp = payload.tool_response || payload.tool_result;
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
