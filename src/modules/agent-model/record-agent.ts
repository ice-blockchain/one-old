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
import { context, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { exhaustedModelsForRole, markModelExhaustionTerminal, recordExhaustedModel } from './exhausted-models';
import { classifyModelFailureText, type ModelFailureKind } from './failure-classify';
import { modelMatchesExpected } from '../../shared/model-tiers';
import { modelUnavailablePromptRequest } from '../../shared/prompt-request';
import {
  REPLACE_AGENT_MARKER,
  hookSessionIdentity,
  isCursorToolSubagentId,
  isResumeCapableAgentId,
  markRunAgentReplaced,
  readEffectiveState,
  recordRunAgent,
  subagentContinuationAvailable,
} from '../../shared/state';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';
import { markModelChoicePrompted, readModelChoice } from './model-choice';
import { persistCorrelatedCursorPostToolFailure } from './cursor-failures';
import { readRunModelPolicy, resolveRunPolicyFallback } from '../../shared/run-model-policy';

// The id Claude prints in the Agent tool result footer (`agentId: <id>`), ALSO
// matching the structured-JSON spelling (`"agentId":"<id>"`) since the payload
// is scanned as serialized JSON. Anchored on the labelled form only — a bare
// hex scan would false-positive on shas in the agent's reply.
// `agent_?id` covers Codex's snake_case spawn result (`{"agent_id":"…"}`) —
// camelCase-only matching left the registry empty on Codex, disabling the
// duplicate-spawn gate exactly where collaboration continuation is native.
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

// Conservative mid-run failure classifier for a spawn-tool RESULT. A successful
// summary can casually contain the word "stopped", so bare verbs only count via
// the structured status field; free text must name a limit/quota explicitly.
const RESULT_STOP_STATUSES = new Set(['stopped', 'aborted', 'cancelled', 'canceled', 'failed', 'error', 'errored']);
const RESULT_SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'ok']);

function structuredFailureEvidence(response: unknown): boolean {
  const direct = obj(response);
  if (!direct) return false;
  const status = direct && typeof direct.status === 'string' ? direct.status.trim().toLowerCase()
    : direct && typeof direct.state === 'string' ? direct.state.trim().toLowerCase() : '';
  if (status && RESULT_STOP_STATUSES.has(status)) return true;
  if (direct.is_error === true || direct.isError === true || direct.success === false || direct.ok === false) return true;
  return direct.error !== undefined && direct.error !== null && direct.error !== false && direct.error !== '';
}

export function classifySubagentStop(
  response: unknown,
  requireStructuredFailure: boolean = true,
): ModelFailureKind | 'stopped' | null {
  const direct = obj(response);
  const status = direct && typeof direct.status === 'string' ? direct.status.trim().toLowerCase()
    : direct && typeof direct.state === 'string' ? direct.state.trim().toLowerCase() : '';
  // Every host may return an arbitrary successful subagent report. An explicit
  // success envelope wins over incident vocabulary quoted inside that report;
  // legacy hosts that return only an unstructured failure string still retain
  // the text-classification fallback below.
  if ((status && RESULT_SUCCESS_STATUSES.has(status))
    || direct?.success === true || direct?.ok === true) return null;
  const structuredFailure = structuredFailureEvidence(response);
  // Cursor's successful Task report is arbitrary model-written prose. It may
  // quote an incident, a test fixture, or "model not enabled" instructions; none
  // of that is a runtime failure unless Cursor marks the result failed/error.
  if (requireStructuredFailure && !structuredFailure) return null;
  const text = collectResponseText(response);
  const classified = classifyModelFailureText(text);
  if (classified !== 'generic') return classified;
  if (structuredFailure || (status && RESULT_STOP_STATUSES.has(status))) return 'stopped';
  return null;
}

function composerFloorChoice(
  ctx: Ctx,
  cwd: string,
  runId: string,
  role: string,
  recommended: string,
  composer: string,
): HookResult {
  const choice = readModelChoice(cwd, runId);
  if (choice === 'use-fallback') {
    return context(
      `traffic-one — ${role} API/usage limit. React NOW; do not wait for other running subagents. `
      + `Re-send the ${role} task with ${REPLACE_AGENT_MARKER} on the FIRST line of the prompt and model="${composer}" `
      + `(the Composer fallback explicitly accepted by the user). Resume from whatever the stopped agent already completed instead of restarting from scratch.`,
      { systemMessage: `traffic-one: ${role} API/usage limit — respawning on ${composer}` },
    );
  }
  if (choice === 'enable-retry') {
    return context(
      `traffic-one — ${role} API/usage limit. Do not proceed on the Composer fallback. `
      + `Restore API budget for **${recommended}**, then re-send the same ${role} task with ${REPLACE_AGENT_MARKER} on the FIRST line and model="${recommended}". `
      + 'Resume from whatever the stopped agent already completed instead of restarting from scratch.',
      { systemMessage: `traffic-one: restore API budget for ${recommended}, then retry ${role}` },
    );
  }

  markModelChoicePrompted(cwd, runId);
  const prose = `traffic-one — ${role} hit an API/usage limit and the next eligible model in its original tier is the Composer floor.\n\n`
    + `**enable** — Restore API budget for **${recommended}**, then reply **enable**; I’ll retry on the recommended model.\n\n`
    + `**fallback** — Proceed now on **${composer}**.`;
  return context(prose, {
    systemMessage: `traffic-one: ${role} needs your enable/fallback choice before Composer`,
    promptRequest: modelUnavailablePromptRequest(recommended, composer, prose),
  });
}

export function recordSpawnedAgent(ctx: Ctx): HookResult {
  // Without continuation the registry is dead weight — skip the write entirely
  // so non-teams hosts keep byte-identical run dirs.
  if (!subagentContinuationAvailable(process.env, ctx.host)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  if (toolName && !/^(Task|Agent|spawn_agent|run_subagent|spawn_subagent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const roleResolution = inferTrafficOneSpawnRoleEvidence(toolInput);
  if (roleResolution.kind !== 'evidence') return noop();
  const role = roleResolution.evidence.role;

  // Codex spawn results do not reliably contain the child id (live responses
  // may return only task_name). Requested tool_input.model is intent, not proof
  // of the runtime model. SubagentStart/child PreToolUse own the verified claim
  // and registry write; never let this parent-side event create a reusable row.
  if (ctx.host === 'codex') return noop();

  // Prefer the named response fields; when a host uses a different field name
  // for the spawn result, fall back to scanning the whole payload — the
  // extractor's regex is anchored on the labelled `agent[_]id:` form, so input
  // text cannot false-positive unless it literally quotes a labelled id.
  const response = raw.tool_response ?? raw.toolResponse ?? raw.tool_result ?? raw.toolResult;
  const stateCwd = ctx.host === 'cursor'
    ? resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot })
    : ctx.cwd;

  // MID-RUN FAILURE (api limit / stopped): when PostToolUse is delivered, its
  // result is the earliest synchronous signal a parallel subagent died. Without
  // this branch the recorder RE-RECORDS the dead agent as live (Cursor prints
  // `Agent ID:` even for a stopped run) and the reuse gate then demands
  // continuation of a dead agent while the orchestrator idles until the sibling
  // finishes. Retire the agent and tell the orchestrator to respawn NOW on the
  // next same-tier fallback model.
  const classifiedStopKind = classifySubagentStop(response, ctx.host === 'cursor');
  if (classifiedStopKind) {
    if (ctx.host === 'cursor') {
      const outcome: ModelFailureKind = classifiedStopKind === 'stopped' ? 'generic' : classifiedStopKind;
      persistCorrelatedCursorPostToolFailure(
        ctx,
        role,
        asString(toolInput.model),
        outcome,
        collectResponseText(response),
      );
      // Only a matching immutable SubagentStart proves which model actually
      // ran. An uncorrelated result may be surfaced by Cursor itself, but it may
      // not condemn a model or retire an arbitrary same-role agent here.
      // Persist only: returning this role's directive here would bypass the
      // complete-parent delivery CAS. Parallel PostToolUse results could then
      // fragment sibling roles, and the next Stop/prompt pass would deliver the
      // same still-unclaimed result again. Lifecycle/prompt reconciliation owns
      // the one aggregated, at-most-once continuation for the parent.
      return noop();
    }

    // Runtime Settings guidance is Cursor-specific. Other hosts retain their
    // established generic stopped-agent recovery for explicit availability text.
    const stopKind: 'api-limit' | 'stopped' = classifiedStopKind === 'api-limit'
      ? 'api-limit'
      : 'stopped';
    // Resolve host-scoped performance/team preferences from the hook's canonical
    // host, even in embedded/test runners that do not carry Cursor's env marker.
    const stopState = readEffectiveState(stateCwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
    const stopRunId = stopState && typeof stopState.currentRunId === 'string' ? stopState.currentRunId.trim() : '';
    if (stopRunId) markRunAgentReplaced(stateCwd, stopRunId, role);
    const exhausted = asString(toolInput.model);
    // Remember the dead model for this run+role so the respawn (and any later
    // retry) rotates OFF it — the same store the Cursor PreToolUse gate reads,
    // keeping both hosts on one exhaustion ledger.
    const allExhausted = stopKind === 'api-limit' && stopRunId && exhausted
      ? recordExhaustedModel(stateCwd, stopRunId, role, exhausted)
      : (stopRunId ? exhaustedModelsForRole(stateCwd, stopRunId, role) : []);
    const policy = stopRunId ? readRunModelPolicy(stateCwd, stopRunId) : null;
    if (stopRunId && !policy) {
      return context(
        `traffic-one — ${role} stopped, but immutable model-policy.json is missing for run ${stopRunId}. `
        + 'Do not select a retry model from mutable global configuration; start a repaired parent run.',
      );
    }
    const originalTier = policy?.roles[role]?.tier || null;
    const capturedModels = policy?.host === 'cursor' ? policy.cursorAvailableModels : undefined;
    const fallbackCandidate = stopKind === 'api-limit' && originalTier
      ? resolveRunPolicyFallback(policy!, {
        tier: originalTier,
        exhaustedModels: allExhausted,
        capturedModels,
      })
      : null;
    const fallback = fallbackCandidate?.model || '';
    // Composer is the normal first candidate for a cheapest-tier worker. For a
    // highest/balanced role it is a real floor drop and stays user-owned.
    if (stopKind === 'api-limit'
      && stopRunId
      && originalTier
      && originalTier !== 'cheapest'
      && fallbackCandidate
      && /^composer/i.test(fallbackCandidate.family)) {
      const preferred = policy!.tiers[originalTier][0] || '';
      const recommended = preferred || exhausted;
      return composerFloorChoice(ctx, stateCwd, stopRunId, role, recommended, fallbackCandidate.model);
    }
    if (stopKind === 'api-limit' && stopRunId && originalTier && !fallbackCandidate) {
      const row = policy!.tiers[originalTier];
      const allActuallyLimited = row.length > 0 && row.every((family) => (
        allExhausted.some((model) => modelMatchesExpected(model, family) || modelMatchesExpected(family, model))
      ));
      const composerAccepted = originalTier === 'cheapest' || readModelChoice(stateCwd, stopRunId) === 'use-fallback';
      if (allActuallyLimited && composerAccepted) {
        markModelExhaustionTerminal(stateCwd, stopRunId, role);
        return context(
          `traffic-one — model rotation is terminal for ${role}: every eligible model actually started from the role's original ${originalTier} tier reached an API/usage limit (${allExhausted.join(', ')}). Stop retrying this role until the user restores API budget.`,
          { systemMessage: `traffic-one: ${role} exhausted every ${originalTier}-tier model` },
        );
      }
    }
    const modelStep = fallback
      ? ` Respawn with model: "${fallback}" (next same-tier fallback — "${exhausted}" is exhausted for this session; do not re-use it).`
      : ' Respawn with the next same-tier fallback model from the announced lineup if the failure was an API/usage limit.';
    const reason = stopKind === 'api-limit' ? 'API/usage limit' : 'stopped mid-run';
    return context(
      `traffic-one — ${role} ${reason}. React NOW; do not wait for other running subagents. `
      + `Re-send the ${role} task with ${REPLACE_AGENT_MARKER} on the FIRST line of the prompt (the stopped agent was retired from the reuse registry).${modelStep} `
      + 'Resume from whatever the stopped agent already completed instead of restarting the work from scratch.',
      { systemMessage: `traffic-one: ${role} ${reason}${fallback ? ` — respawning on ${fallback}` : ' — respawning'}` },
    );
  }

  let agentId = extractSpawnedAgentId(response) ?? (response === undefined ? extractSpawnedAgentId(raw) : null);
  // Never fabricate a Windsurf agent id from the requested profile. Devin emits
  // PostToolUse even when `run_subagent` fails (for example, an unregistered
  // custom profile); treating the profile as live poisons the corrective retry.
  if (!agentId || !isResumeCapableAgentId(agentId)) return noop();

  const state = readEffectiveState(stateCwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const runId = state && typeof state.currentRunId === 'string' && state.currentRunId.trim() ? state.currentRunId.trim() : null;
  if (!runId) return noop();

  recordRunAgent(stateCwd, runId, role, {
    agentId,
    resumeId: agentId,
    model: asString(toolInput.model) || null,
    agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || null,
    parentSessionId: hookSessionIdentity(raw).sessionId,
    roleSource: roleResolution.evidence.source,
  });
  return noop();
}
