"use strict";
// src/modules/materialize/post-stack-setup.ts
// PostToolUse dispatcher (priority ~60): auth gate → supabase function-edit
// auto-deploy → digest-size warning → write-triggered materialization (project
// memory / tool-input hints / generic convergence) → state-file write
// materialization. Ported from runPostStackSetup (post.cjs). The token-log and
// one-mcp-report couplings are wired (default logger import + materialize/index.ts);
// the supabase function-edit auto-deploy coupling is injected via deps and is not
// yet wired (functionEditDeploy defaults to a no-op — to be wired separately).
//
// TODO (cutover reconcile): the legacy state-file branch emits per-validation-
// issue systemMessages + a gitnexus node-warning + the exact "rules loaded for
// stack X" wording. Here it delegates to materializeProjectFromState (which
// strips local prefs via writeState + validates + materializes); reconcile the
// exact wording against the legacy when both are side-by-side.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPostStackSetup = runPostStackSetup;
const coerce_1 = require("../../adapters/coerce");
const obj_1 = require("../../shared/obj");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const result_1 = require("../../core/result");
const auth_1 = require("../../shared/auth");
const authoring_root_1 = require("../../shared/authoring-root");
const paths_1 = require("../../shared/paths");
const token_logger_1 = require("../../shared/token-logger");
const skill_block_1 = require("../../shared/skill-block");
const tool_classify_1 = require("../../shared/tool-classify");
const state_1 = require("../../shared/state");
const onboarding_1 = require("../../runners/toolchain/onboarding");
const role_infer_1 = require("../agent-model/role-infer");
const materialize_1 = require("../../shared/materialize");
const converge_from_write_1 = require("./converge-from-write");
const post_helpers_1 = require("./post-helpers");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const PLAN_READY_RE = /(?:^|\n)\s*(?:verdict:\s*)?PLAN_READY\s*(?:\n|$)/i;
const SPAWN_TOOL_RE = /^(Task|Agent|spawn_agent|send_input|wait_agent)$/i;
function stringifySearchValue(value) {
    if (value == null)
        return '';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    try {
        return JSON.stringify(value);
    }
    catch {
        return '';
    }
}
function outcomeToResult(out, extraContext = null) {
    if (!out)
        return extraContext ? (0, result_1.context)(extraContext, { systemMessage: 'traffic-one — toolchain checked' }) : (0, result_1.noop)();
    const body = extraContext ? `${out.context}\n\n${extraContext}` : out.context;
    return (0, result_1.context)(body, { systemMessage: out.systemMessage });
}
function digestWarning(role, kb) {
    const verbatim = [
        `[digest-size] Your \`${role}.md\` digest is ${kb} KB; the spec target is ≤2 KB (see \`rules/common/agent-handoff-digests.md\`). Re-write before completing your turn:`,
        '  1. Use repo-relative paths, never absolute (drop `/Users/.../` prefixes).',
        '  2. Touched: file paths only, no parenthetical annotations.',
        '  3. Public contracts: delta-only — what changed vs the plan, not the full surface.',
        '  4. Open questions: at most 3 bullets; link to plan §, do not inline rationale.',
        'Reviewer / tester / shipper read this digest INSTEAD of the diff; bloated digests defeat the token-economy layer.',
    ].join('\n');
    return skillBlock('materialize', 'digest-size', { ROLE: role, KB: kb }, verbatim);
}
function planReadyText(value) {
    return PLAN_READY_RE.test(stringifySearchValue(value));
}
function architectDigestProjectRoot(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/^(.*)\/\.traffic-one\/digests\/[^/]+\/architect\.md$/);
    return match?.[1] ?? null;
}
function isArchitectPlanReadyDigest(filePath) {
    if (!filePath || !architectDigestProjectRoot(filePath))
        return false;
    try {
        return planReadyText(fs.readFileSync(filePath, 'utf8'));
    }
    catch {
        return false;
    }
}
function agentResponseText(raw) {
    return [
        raw.tool_response,
        raw.tool_result,
        raw.toolResponse,
        raw.toolResult,
        raw.response,
        raw.result,
        raw.output,
    ].map(stringifySearchValue).filter(Boolean).join('\n');
}
function isArchitectPlanReadyAgentResult(ctx, raw, toolInput) {
    const toolName = ctx.input.tool?.rawName || (0, coerce_1.asString)(raw.tool_name ?? raw.toolName);
    if (!SPAWN_TOOL_RE.test(toolName))
        return false;
    const responseText = agentResponseText(raw);
    if (!PLAN_READY_RE.test(responseText))
        return false;
    const role = (0, role_infer_1.inferTrafficOneSpawnRole)(toolInput);
    if (role)
        return role === 'senior-architect';
    // `wait_agent` returns may not carry the original spawn prompt, so the
    // terminal PLAN_READY token is enough to identify the architect phase.
    return /^wait_agent$/i.test(toolName);
}
function triggerArchitectPlanReadyReport(cwd, state, reportOneMcp) {
    if (!reportOneMcp)
        return;
    reportOneMcp(cwd, state, 'architect PLAN_READY');
}
function runPostStackSetup(ctx, deps = {}) {
    const cwd = ctx.cwd;
    const raw = (0, obj_1.obj)(ctx.input.raw) || {};
    const toolInput = (0, obj_1.obj)(raw.tool_input) || (0, obj_1.obj)(raw.toolInput) || {};
    const filePath = ctx.input.tool?.filePath || (0, coerce_1.asString)(toolInput.file_path);
    const workdir = ctx.input.tool?.workdir || (0, coerce_1.asString)(toolInput.workdir ?? toolInput.cwd);
    const pathBase = workdir
        ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(ctx.input.cwd, workdir))
        : ctx.input.cwd;
    const cwdAbs = path.resolve(cwd);
    const targetPath = filePath ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(pathBase, filePath)) : '';
    const targetInsideCwd = Boolean(targetPath && (targetPath === cwdAbs || targetPath.startsWith(`${cwdAbs}${path.sep}`)));
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd) && (!targetPath || targetInsideCwd))
        return (0, result_1.noop)();
    const fp = filePath.replace(/\\/g, '/');
    const reportOneMcp = deps.reportOneMcp;
    const digestRoot = architectDigestProjectRoot(targetPath || filePath);
    const reportRoot = digestRoot || cwd;
    const state = (0, state_1.readEffectiveState)(reportRoot);
    const isSpawnAgentLifecycleTool = ctx.input.tool?.class === 'spawn-agent' || SPAWN_TOOL_RE.test((0, coerce_1.asString)(raw.tool_name ?? raw.toolName));
    if (isArchitectPlanReadyDigest(targetPath || filePath) || isArchitectPlanReadyAgentResult(ctx, raw, toolInput)) {
        triggerArchitectPlanReadyReport(reportRoot, state, reportOneMcp);
    }
    if (!(0, auth_1.isAuthenticatedLocal)())
        return (0, result_1.noop)();
    // Opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1). Real
    // logger by default; tests inject a spy/no-op via deps.
    (deps.logTokenUse ?? token_logger_1.logToolUse)(cwd, raw);
    if (isSpawnAgentLifecycleTool)
        return (0, result_1.noop)();
    // 1. Supabase Edge Function edit → auto-deploy (injected; skip when no hook).
    if (post_helpers_1.FUNCTION_PATH_RE.test(fp)) {
        const result = deps.functionEditDeploy ? deps.functionEditDeploy(targetPath || filePath) : null;
        return result ? (0, result_1.context)(result) : (0, result_1.noop)();
    }
    // 2. Soft digest-size warning (never blocks the write).
    const digestMatch = fp.match(post_helpers_1.DIGEST_PATH_RE);
    if (digestMatch && targetPath && fs.existsSync(targetPath)) {
        let bytes = 0;
        try {
            bytes = fs.statSync(targetPath).size;
        }
        catch {
            bytes = 0;
        }
        if (bytes > post_helpers_1.DIGEST_HARD_BYTES) {
            const role = digestMatch[1];
            const kb = Math.round((bytes / 1024) * 10) / 10;
            return (0, result_1.context)(digestWarning(role, kb), { systemMessage: `traffic-one — digest ${role}.md is ${kb} KB; trim to ≤2 KB` });
        }
        return (0, result_1.noop)();
    }
    // 3. Non-state-file write → write-triggered convergence.
    if (!(0, tool_classify_1.isStateFilePath)(filePath)) {
        const mem = (0, converge_from_write_1.materializeFromProjectMemoryWrite)(cwd, targetPath || filePath, { reportOneMcp });
        if (mem)
            return outcomeToResult(mem);
        const hintInput = targetPath ? { ...toolInput, file_path: targetPath } : toolInput;
        const hint = (0, converge_from_write_1.materializeFromToolInputHints)(cwd, hintInput, { reportOneMcp });
        if (hint)
            return outcomeToResult(hint);
        return outcomeToResult((0, materialize_1.materializeProjectIfNeeded)(cwd, { trigger: 'generic post-tool convergence', reportOneMcp }));
    }
    // 4. State-file write → validate + materialize (writeState strips local prefs).
    if (!targetPath || !fs.existsSync(targetPath))
        return (0, result_1.noop)();
    const projectRoot = (0, post_helpers_1.projectRootFromStateFilePath)(targetPath);
    const out = (0, materialize_1.materializeProjectFromState)(projectRoot, { trigger: 'post-stack-setup', reportOneMcp });
    let toolchainContext = null;
    try {
        toolchainContext = (deps.ensureToolchain ?? onboarding_1.ensureOnboardingToolchainContext)(projectRoot);
    }
    catch (error) {
        const detail = error && error.message ? error.message : String(error || 'unknown error');
        toolchainContext = `[toolchain] hook-owned install/upgrade failed: ${detail}.`;
    }
    return outcomeToResult(out, toolchainContext);
}
