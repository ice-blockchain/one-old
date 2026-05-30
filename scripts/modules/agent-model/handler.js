"use strict";
// src/modules/agent-model/handler.ts
// PreToolUse spawn-agent gate (priority 40): for new-project builds, enforce
// materialization → performance level → team approval → the per-role model
// parameter, then stake a run-agent claim. Ported 1:1 from runCheckAgentModel
// (gates.cjs). Spawn-specific fields (subagent_type, model, …) come from
// ctx.input.raw (the canonical ToolInput doesn't carry them). Deny PROSE → skill.
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentModelGate = agentModelGate;
const coerce_1 = require("../../adapters/coerce");
const obj_1 = require("../../shared/obj");
const result_1 = require("../../core/result");
const events_1 = require("../../core/events");
const paths_1 = require("../../shared/paths");
const performance_1 = require("../../shared/performance");
const performance_config_1 = require("../../shared/performance-config");
const skill_block_1 = require("../../shared/skill-block");
const state_1 = require("../../shared/state");
const auth_choice_1 = require("../session/auth-choice");
const converge_1 = require("./converge");
const role_infer_1 = require("./role-infer");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const block = (name, vars = {}) => skillBlock('agent-model', name, vars);
function agentModelGate(ctx) {
    if ((0, auth_choice_1.authChoiceAllowsContinue)(ctx.cwd))
        return (0, result_1.noop)();
    const raw = (0, obj_1.obj)(ctx.input.raw) || {};
    const toolName = ctx.input.tool?.rawName || (0, coerce_1.asString)(raw.tool_name ?? raw.toolName);
    // Normalize a host namespace (Codex `multi_agent_v1.spawn_agent`) to the bare name
    // before matching, so the gate can't silently bail on a qualified spawn tool.
    if (toolName && !/^(Task|Agent|spawn_agent)$/i.test((0, events_1.stripToolNamespace)(toolName)))
        return (0, result_1.noop)();
    const toolInput = (0, obj_1.obj)(raw.tool_input) || (0, obj_1.obj)(raw.toolInput) || {};
    const role = (0, role_infer_1.inferTrafficOneSpawnRole)(toolInput);
    if (!role)
        return (0, result_1.noop)();
    const cwd = ctx.cwd;
    const state = (0, state_1.readEffectiveState)(cwd);
    if (!state || typeof state !== 'object')
        return (0, result_1.noop)();
    if (state.mode !== 'new-project')
        return (0, result_1.noop)();
    if (!(0, converge_1.isCompletedTrafficOneMaterialization)(cwd, state)) {
        (0, converge_1.materializeIfNeeded)(cwd);
        if ((0, converge_1.isCompletedTrafficOneMaterialization)(cwd, (0, state_1.readEffectiveState)(cwd)))
            return (0, result_1.deny)(block('agent-materialization-deny'));
        return (0, result_1.deny)(block('agent-materialization-missing'));
    }
    const performance = (0, obj_1.obj)(state.performance);
    const level = performance && typeof performance.level === 'string' && performance_config_1.PERFORMANCE_LEVEL_IDS.has(performance.level)
        ? performance.level
        : null;
    if (!level)
        return (0, result_1.noop)();
    if ((0, performance_1.teamModeForLevel)(level) === 'main-agent') {
        return (0, result_1.deny)(block('performance-main-agent', { LEVEL: level, ROLE: role }));
    }
    if (!(0, state_1.isTeamApproved)(state.team)) {
        return (0, result_1.deny)(block('team-confirmation', { LEVEL: level }));
    }
    const team = (0, obj_1.obj)(state.team);
    const overrides = team && (0, obj_1.obj)(team.overrides) ? team.overrides : null;
    const expected = (0, performance_1.modelForRoleHost)(level, role, ctx.host, overrides);
    if (!expected)
        return (0, result_1.noop)();
    const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
    if (passedModel !== expected) {
        const passedNote = passedModel
            ? `You passed model="${passedModel}". `
            : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ';
        return (0, result_1.deny)(block('performance-model-param', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: expected, PASSED_NOTE: passedNote }));
    }
    (0, state_1.ensureRunAgentClaim)(cwd, state, role, raw, {
        toolName,
        agentType: (0, coerce_1.asString)(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || undefined,
        model: passedModel,
    });
    return (0, result_1.noop)();
}
