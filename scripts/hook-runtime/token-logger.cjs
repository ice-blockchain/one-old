'use strict';

// scripts/hook-runtime/token-logger.cjs
// In-flight per-tool token-usage logger. OFF by default; opt in by setting
// TRAFFIC_ONE_TOKEN_LOG=1 in the environment. When enabled, hooks append one
// JSONL line per tool call to .traffic-one/token-log.jsonl with size + phase
// context. The log complements scripts/token-report.cjs: the report parses
// Claude Code's authoritative transcripts for billed-token counts; this log
// gives per-tool byte counts and role attribution that the transcripts don't.
//
// File format (one JSON object per line):
//   { ts, runId, role, hookEvent, toolName, inputBytes, outputBytes, estTokens, action }
//
// Designed to be a no-op when the env var is unset — zero overhead for users
// who never opt in.

const fs = require('fs');
const path = require('path');
const {
  safeReadJson,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
} = require('./state.cjs');

const ENV_FLAG = 'TRAFFIC_ONE_TOKEN_LOG';
const LOG_REL_PATH = path.join('.traffic-one', 'token-log.jsonl');

function isEnabled() {
  const v = process.env[ENV_FLAG];
  return v === '1' || v === 'true' || v === 'yes';
}

function estimateTokens(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}

function readSizeFromValue(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

// Best-effort phase lookup from .traffic-one.json in cwd. Returns
// { runId, role } when state is present and onboarded.
function readPhase(cwd, payload = null) {
  const statePath = path.join(cwd, '.traffic-one.json');
  if (!fs.existsSync(statePath)) return { runId: null, role: null };
  try {
    const state = safeReadJson(statePath, {});
    const agentContext = resolveRunAgentContext(cwd, state, payload || {}, { claimPending: false })
      || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
    return {
      runId: agentContext && agentContext.runId
        ? agentContext.runId
        : typeof state.currentRunId === 'string'
          ? state.currentRunId
          : null,
      role: agentContext && agentContext.role
        ? agentContext.role
        : typeof state.activeAgentRole === 'string'
          ? state.activeAgentRole
          : null,
    };
  } catch {
    return { runId: null, role: null };
  }
}

// Append one entry. Safe to call from any hook; silently no-ops when disabled
// or when the write fails. Never throws.
function logToolUse(cwd, payload) {
  if (!isEnabled()) return;
  if (!payload || typeof payload !== 'object') return;
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const toolResp  = payload.tool_response || payload.tool_result;
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

// Log a hook-injected context block (SessionStart / UserPromptSubmit /
// PostToolUse). Mirrors logToolUse but used for our own injected bytes.
function logHookContext(cwd, hookEvent, additionalContext) {
  if (!isEnabled()) return;
  const bytes = readSizeFromValue(additionalContext);
  if (bytes === 0) return;
  const phase = readPhase(cwd, { hook_event_name: hookEvent });
  const entry = {
    ts: new Date().toISOString(),
    runId: phase.runId,
    role: phase.role,
    hookEvent: hookEvent || null,
    toolName: null,
    inputBytes: 0,
    outputBytes: bytes,
    estTokens: estimateTokens(bytes),
    action: 'hook-context-injection',
  };
  const dst = path.join(cwd, LOG_REL_PATH);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.appendFileSync(dst, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

module.exports = {
  isEnabled,
  estimateTokens,
  readSizeFromValue,
  readPhase,
  logToolUse,
  logHookContext,
  ENV_FLAG,
  LOG_REL_PATH,
};
