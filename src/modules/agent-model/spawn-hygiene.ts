// src/modules/agent-model/spawn-hygiene.ts
// Path/session hygiene, the continuation recipe, and performance level.

import * as path from 'path';
import { obj, type Rec } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { PERFORMANCE_LEVEL_IDS } from '../../config/state';
import {
  captureClaimDebug,
  ensureCurrentRunId,
  ensureRunAgentClaim,
  continuationAgentId,
  type CodexLiveAgentValidation,
  hookSessionIdentity,
  isMaintenancePhase,
  isTeamApproved,
  liveRunAgent,
  markRunAgentReplaced,
  markRunAgentReplacedIfMatches,
  refreshCursorRunAgentFromTranscriptCache,
  readEffectiveState,
  readRunAssignmentsResilient,
  REPLACE_AGENT_MARKER,
  retireUnverifiedCodexRunAgent,
  subagentContinuationAvailable,
  validateCodexLiveRunAgent,
  verdictAgentConflict,
} from '../../shared/state';
import { recordMainOnboardingSession } from '../../shared/onboarding-server/onboarding-session';

import {
  block,
} from './handler-prose';

export function absoluteTrafficOnePathsOutsideProject(prompt: string, cwd: string): string[] {
  if (!prompt) return [];
  const root = path.resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\/[^\s'"`<>)]*?\.traffic-one\/(?:runs|digests|fix-cycles)\/[^\s'"`<>)]*/g;
  for (const match of prompt.matchAll(re)) {
    const value = match[0].replace(/\\/g, '/');
    if (value.startsWith(`${root}/`) || value === root) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function absoluteTrafficOnePathDeny(paths: string[], cwd: string): HookResult {
  return deny(block('absolute-traffic-one-path', {
    PROJECT_ROOT: cwd,
    BAD_PATHS: paths.join(', '),
  }));
}

// OpenCode/Kilo do not emit SubagentStart, so the only pre-child signal is the
// parent's Task spawn. Record that parent before staking its pending role claim.
// Later child writes that lack the first chat.message marker can then be safely
// attributed by their single assignment scope, while parent writes stay denied.
export function recordSpawnParentSession(cwd: string, raw: unknown): void {
  const parentSessionId = hookSessionIdentity(raw).sessionId;
  if (parentSessionId) recordMainOnboardingSession(cwd, parentSessionId);
}

// The per-role model-tier deny. Lists the acceptable same-tier ALTERNATES so the
// orchestrator can pass a model the runner actually offers when a Cursor build does
// not offer the preferred slug (Cursor rejects an unavailable slug as invalid). The
// gate stays strict — a wrong-FAMILY model is still denied; only fallback ids in
// the active local snapshot's preferred-first tier array widen what satisfies it.
// Host-specific "continue the live agent" recipe for the agent-reuse deny. The
// continuation primitive differs per host: Cursor RE-INVOKES the Task tool with
// `resume` (live Cursor builds surface this field; older docs/models may say
// `agentId`), Copilot reuses the background agent id through `task`, Codex uses
// collaboration follow-up/message tools, and Claude uses `SendMessage`. The agentId is interpolated here so the
// SKILL block stays a single host-agnostic template.
export function continuationRecipe(host: string, agentId: string, role: string): { call: string; tool: string } {
  if (host === 'cursor') {
    return {
      call: `Re-invoke the \`Task\` tool with \`resume: "${agentId}"\` and \`prompt\` = the NEW task only — Cursor resumes the SAME subagent with full context preserved. If your Cursor build exposes \`agentId\` instead, use the same id there.`,
      tool: 'the Task `resume` continuation',
    };
  }
  if (host === 'codex') {
    return {
      call: `Call \`followup_task\` with \`target: "${agentId}"\` and the NEW task as \`message\` to continue the SAME Codex agent. If that agent is still running and this is only an in-flight update, use \`send_message\` with the same target instead.`,
      tool: 'followup_task / send_message',
    };
  }
  if (host === 'copilot') {
    return {
      call: `Call Copilot's \`task\` tool for the SAME background agent with \`agent_id: "${agentId}"\` and \`prompt\` = the NEW task only. Do NOT substitute \`name: "${agentId}"\`: live Copilot builds treat \`name\` as a fresh background task and respawn the agent. If this Copilot build rejects \`agent_id\` as unsupported, STOP and report that Copilot did not expose a reusable continuation primitive; do not spawn another same-role task.`,
      tool: 'the Copilot `task` background-agent continuation',
    };
  }
  if (host === 'windsurf') {
    return {
      call: `Call \`read_subagent\` with agent id \`${agentId}\` while the existing role is running. If it completed and needs a follow-up, call \`run_subagent\` with profile \`subagent_general\`; put \`[t1-role: ${role}]\` on the FIRST line, \`${REPLACE_AGENT_MARKER}\` on the next line, and immediately tell it to read \`.devin/agents/${role}/AGENT.md\`.`,
      tool: 'read_subagent / run_subagent replacement',
    };
  }
  if (host === 'opencode') {
    return {
      call: `OpenCode does not expose a resumable Task field in current Traffic One builds. If the existing task \`${agentId}\` is still running, wait for it. If it has already completed and you need a follow-up/fix, re-spawn the SAME named OpenCode agent with \`${REPLACE_AGENT_MARKER}\` in the prompt, keep \`[t1-role: ${role}]\` as the FIRST line, and include only the new findings/file list inline. Do NOT use \`general\`, do NOT point at a missing fix-cycle file, and do NOT write scratch logs under \`/tmp\`.`,
      tool: 'OpenCode Task replacement',
    };
  }
  if (host === 'kilo') {
    return {
      call: `Kilo does not expose a resumable Task field. If task \`${agentId}\` is still running, wait for it. If it completed and needs a follow-up, call \`task\` with built-in \`general\`; put \`[t1-role: ${role}]\` on the FIRST line, \`${REPLACE_AGENT_MARKER}\` on the next line, immediately read \`.kilo/agents/${role}.md\`, and pass no \`model\` field.`,
      tool: 'Kilo general-task replacement',
    };
  }
  return {
    call: `Call \`SendMessage\` with \`to: "${agentId}"\` and \`message\` = the NEW task.`,
    tool: 'SendMessage',
  };
}

// API/usage-limit replacement handling for the reuse gate. When the orchestrator
// re-spawns a role because its subagent hit a provider limit, the retired model is
// exhausted for the session — record it, then if the new spawn tries to REUSE an
// already-exhausted model (or passes none, which inherits the parent), DENY and name
// the next same-tier fallback that is still untried. Returns null when the failure
// isn't a limit (a plain stop can reuse the same model) or the spawn already picked a
// fresh model (rotation satisfied → proceed). Cursor-and-Claude safe: the store is the
// same ledger the transcript reconciler and PostToolUse recorder write; this retry
// inspection is the backstop when Cursor omits its post-Task lifecycle events.
function performanceLevelFromState(state: Rec): string {
  const performance = obj(state.performance);
  return performance && typeof performance.level === 'string' && PERFORMANCE_LEVEL_IDS.has(performance.level)
    ? performance.level
    : 'current';
}

