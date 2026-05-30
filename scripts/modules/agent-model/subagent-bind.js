"use strict";
// src/modules/agent-model/subagent-bind.ts
// SubagentStart handler (Codex). Best-effort EARLY claim: Codex fires no PreToolUse
// for spawns, so the agent-model gate never stakes a claim. SubagentStart hands us the
// child thread id (`agent_id`) but no role, so we read the child's rollout
// (`transcript_path`) and infer the senior-* role from its spawn prompt, then claim the
// thread. SubagentStart can fire before the rollout is flushed — if the role isn't
// readable yet this is a silent no-op, and resolveRunAgentContext re-attempts the same
// inference at the child's first gated write (when the transcript is populated).
Object.defineProperty(exports, "__esModule", { value: true });
exports.subagentStartBind = subagentStartBind;
const coerce_1 = require("../../adapters/coerce");
const obj_1 = require("../../shared/obj");
const result_1 = require("../../core/result");
const state_1 = require("../../shared/state");
const auth_choice_1 = require("../session/auth-choice");
function subagentStartBind(ctx) {
    if ((0, auth_choice_1.authChoiceAllowsContinue)(ctx.cwd))
        return (0, result_1.noop)();
    const raw = (0, obj_1.obj)(ctx.input.raw) || {};
    const transcriptPath = (0, coerce_1.asString)(raw.transcript_path ?? raw.transcriptPath);
    const threadId = (0, coerce_1.asString)(raw.agent_id ?? raw.agentId) || (0, state_1.transcriptThreadId)(transcriptPath);
    if (!threadId || !transcriptPath)
        return (0, result_1.noop)();
    const state = (0, state_1.readEffectiveState)(ctx.cwd);
    const team = (0, obj_1.obj)((0, obj_1.obj)(state)?.team);
    if (!team || team.mode !== 'subagents')
        return (0, result_1.noop)();
    const role = (0, state_1.inferRoleFromTranscript)(transcriptPath);
    if (!role)
        return (0, result_1.noop)();
    // SubagentStart fires in the spawner's context, so session_id is the parent id.
    const identity = (0, state_1.hookSessionIdentity)(raw);
    (0, state_1.claimThreadRole)(ctx.cwd, state, threadId, role, { parentSessionId: identity.sessionId });
    return (0, result_1.noop)();
}
