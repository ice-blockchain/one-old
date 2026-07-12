// src/modules/agent-model/record-agent.ts
// PostToolUse spawn recorder: capture the agent id the host's spawn tool
// returned and persist it in the per-run registry
// (.traffic-one/runs/<runId>/agents.json). The PreToolUse reuse gate reads the
// registry to deny duplicate same-role spawns, so a role's later tasks continue
// the SAME agent instead of re-loading rules+skills per spawn.
// Claude's Agent tool result footer prints `agentId: <id> (use SendMessage …)`;
// Copilot reports `agent_id` in tool telemetry; the payload is matched tolerantly
// (string, content blocks, or nested object).

import { asString } from '../../adapters/coerce';
import { obj } from '../../shared/obj';
import { noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import {
  hookSessionIdentity,
  isCursorToolSubagentId,
  isResumeCapableAgentId,
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
// Leading `\b` so `subagent_id`/`subagentId` (a spawn-INPUT key Cursor may echo in the
// post payload) cannot match via the `agent_id` substring and capture the wrong id.
const AGENT_ID_RE = /\bagent[_ ]?id['"]?\s*[:=]\s*['"`]?([A-Za-z0-9][A-Za-z0-9._-]{5,63})/i;
const CURSOR_AGENT_UUID_RE = /\bAgent ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CURSOR_LINK_UUID_RE = /\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i;

function collectResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  const direct = obj(response);
  if (!direct) {
    if (response == null) return '';
    try { return JSON.stringify(response); } catch { return ''; }
  }
  const chunks: string[] = [];
  if (typeof direct.text === 'string') chunks.push(direct.text);
  const content = direct.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = obj(block);
      if (b && typeof b.text === 'string') chunks.push(b.text);
    }
  }
  try { chunks.push(JSON.stringify(direct)); } catch { /* ignore */ }
  return chunks.join('\n');
}

export function extractSpawnedAgentId(response: unknown): string | null {
  // Claude's PostToolUse payload carries the id as a STRUCTURED field:
  // tool_response = { status, agentId, agentType, content: [...], usage }.
  // Read it directly; the serialized-text regex below is the fallback for
  // hosts that only surface the `agentId: <id>` footer as text.
  const direct = obj(response);
  if (direct && typeof direct.agentId === 'string' && direct.agentId.trim()) {
    const id = direct.agentId.trim();
    return isCursorToolSubagentId(id) ? null : id;
  }
  // Codex spawn_agent returns snake_case: { agent_id, nickname }.
  if (direct && typeof direct.agent_id === 'string' && direct.agent_id.trim()) {
    return direct.agent_id.trim();
  }
  const text = collectResponseText(response);
  if (!text) return null;
  const cursorUuid = CURSOR_AGENT_UUID_RE.exec(text)?.[1]
    || CURSOR_LINK_UUID_RE.exec(text)?.[1];
  if (cursorUuid) return cursorUuid;
  const match = AGENT_ID_RE.exec(text);
  if (!match?.[1]) return null;
  const id = match[1];
  return isCursorToolSubagentId(id) ? null : id;
}

export function recordSpawnedAgent(ctx: Ctx): HookResult {
  // Without continuation the registry is dead weight — skip the write entirely
  // so non-teams hosts keep byte-identical run dirs.
  if (!subagentContinuationAvailable(process.env, ctx.host)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  if (toolName && !/^(Task|Agent|spawn_agent|run_subagent|spawn_subagent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const role = inferTrafficOneSpawnRole(toolInput);
  if (!role) return noop();

  // Prefer the named response fields; when a host uses a different field name
  // for the spawn result, fall back to scanning the whole payload — the
  // extractor's regex is anchored on the labelled `agent[_]id:` form, so input
  // text cannot false-positive unless it literally quotes a labelled id.
  const response = raw.tool_response ?? raw.toolResponse ?? raw.tool_result ?? raw.toolResult;
  let agentId = extractSpawnedAgentId(response) ?? (response === undefined ? extractSpawnedAgentId(raw) : null);
  // Never fabricate a Windsurf agent id from the requested profile. Devin emits
  // PostToolUse even when `run_subagent` fails (for example, an unregistered
  // custom profile); treating the profile as live poisons the corrective retry.
  if (!agentId || !isResumeCapableAgentId(agentId)) return noop();

  const state = readEffectiveState(ctx.cwd);
  const runId = state && typeof state.currentRunId === 'string' && state.currentRunId.trim() ? state.currentRunId.trim() : null;
  if (!runId) return noop();

  recordRunAgent(ctx.cwd, runId, role, {
    agentId,
    resumeId: agentId,
    model: asString(toolInput.model) || null,
    agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || null,
    parentSessionId: hookSessionIdentity(raw).sessionId,
  });
  return noop();
}
