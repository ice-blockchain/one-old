// src/modules/agent-model/record-agent.ts
// PostToolUse spawn recorder: capture the agent id the host's spawn tool
// returned and persist it in the per-run registry
// (.traffic-one/runs/<runId>/agents.json). The PreToolUse reuse gate reads the
// registry to deny duplicate same-role spawns, so a role's later tasks continue
// the SAME agent (SendMessage) instead of re-loading rules+skills per spawn.
// Claude's Agent tool result footer prints `agentId: <id> (use SendMessage …)`;
// the payload is matched tolerantly (string, content blocks, or nested object).

import { asString } from '../../adapters/coerce';
import { obj } from '../../shared/obj';
import { noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import {
  hookSessionIdentity,
  readEffectiveState,
  recordRunAgent,
  subagentContinuationAvailable,
} from '../../shared/state';
import { inferTrafficOneSpawnRole } from './role-infer';

// The id Claude prints in the Agent tool result footer (`agentId: <id>`), ALSO
// matching the structured-JSON spelling (`"agentId":"<id>"`) since the payload
// is scanned as serialized JSON. Anchored on the labelled form only — a bare
// hex scan would false-positive on shas in the agent's reply.
// `agent_?id` covers Codex's snake_case spawn result (`{"agent_id":"…"}`) —
// camelCase-only matching left the registry empty on Codex, disabling the
// duplicate-spawn gate exactly where send_input continuation is native.
const AGENT_ID_RE = /agent_?id['"]?\s*[:=]\s*['"`]?([A-Za-z0-9][A-Za-z0-9._-]{5,63})/i;

export function extractSpawnedAgentId(response: unknown): string | null {
  // Claude's PostToolUse payload carries the id as a STRUCTURED field:
  // tool_response = { status, agentId, agentType, content: [...], usage }.
  // Read it directly; the serialized-text regex below is the fallback for
  // hosts that only surface the `agentId: <id>` footer as text.
  const direct = obj(response);
  if (direct && typeof direct.agentId === 'string' && direct.agentId.trim()) {
    return direct.agentId.trim();
  }
  // Codex spawn_agent returns snake_case: { agent_id, nickname }.
  if (direct && typeof direct.agent_id === 'string' && direct.agent_id.trim()) {
    return direct.agent_id.trim();
  }
  let text = '';
  if (typeof response === 'string') {
    text = response;
  } else if (response != null) {
    try { text = JSON.stringify(response); } catch { return null; }
  }
  if (!text) return null;
  const match = AGENT_ID_RE.exec(text);
  return match ? (match[1] as string) : null;
}

export function recordSpawnedAgent(ctx: Ctx): HookResult {
  // Without continuation the registry is dead weight — skip the write entirely
  // so non-teams hosts keep byte-identical run dirs.
  if (!subagentContinuationAvailable()) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  if (toolName && !/^(Task|Agent|spawn_agent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const role = inferTrafficOneSpawnRole(toolInput);
  if (!role) return noop();

  // Prefer the named response fields; when a host uses a different field name
  // for the spawn result, fall back to scanning the whole payload — the
  // extractor's regex is anchored on the labelled `agent[_]id:` form, so input
  // text cannot false-positive unless it literally quotes a labelled id.
  const response = raw.tool_response ?? raw.toolResponse ?? raw.tool_result ?? raw.toolResult;
  const agentId = extractSpawnedAgentId(response) ?? (response === undefined ? extractSpawnedAgentId(raw) : null);
  if (!agentId) return noop();

  const state = readEffectiveState(ctx.cwd);
  const runId = state && typeof state.currentRunId === 'string' && state.currentRunId.trim() ? state.currentRunId.trim() : null;
  if (!runId) return noop();

  recordRunAgent(ctx.cwd, runId, role, {
    agentId,
    model: asString(toolInput.model) || null,
    agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || null,
    parentSessionId: hookSessionIdentity(raw).sessionId,
  });
  return noop();
}
