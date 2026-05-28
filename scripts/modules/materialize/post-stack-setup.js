"use strict";
// src/modules/materialize/post-stack-setup.ts
// PostToolUse dispatcher (priority ~60): auth gate → supabase function-edit
// auto-deploy → digest-size warning → write-triggered materialization (project
// memory / tool-input hints / generic convergence) → state-file write
// materialization. Ported 1:1 from runPostStackSetup (post.cjs). Runner
// couplings (token log, supabase deploy, one-mcp report) are INJECTED via deps
// (default no-op) — they wire to the compiled runners at the Step-7 cutover.
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const result_1 = require("../../core/result");
const auth_1 = require("../../shared/auth");
const authoring_root_1 = require("../../shared/authoring-root");
const paths_1 = require("../../shared/paths");
const token_logger_1 = require("../../shared/token-logger");
const skill_block_1 = require("../../shared/skill-block");
const tool_classify_1 = require("../../shared/tool-classify");
const materialize_1 = require("../../shared/materialize");
const converge_from_write_1 = require("./converge-from-write");
const post_helpers_1 = require("./post-helpers");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function outcomeToResult(out) {
    return out ? (0, result_1.context)(out.context, { systemMessage: out.systemMessage }) : (0, result_1.noop)();
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
function runPostStackSetup(ctx, deps = {}) {
    const cwd = ctx.cwd;
    if (!(0, auth_1.isAuthenticatedLocal)())
        return (0, result_1.noop)();
    const raw = obj(ctx.input.raw) || {};
    // Opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1). Real
    // logger by default; tests inject a spy/no-op via deps.
    (deps.logTokenUse ?? token_logger_1.logToolUse)(cwd, raw);
    const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
    const filePath = asString(toolInput.file_path);
    const cwdAbs = path.resolve(cwd);
    const targetPath = filePath ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath)) : '';
    const targetInsideCwd = Boolean(targetPath && (targetPath === cwdAbs || targetPath.startsWith(`${cwdAbs}${path.sep}`)));
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd) && (!targetPath || targetInsideCwd))
        return (0, result_1.noop)();
    const fp = filePath.replace(/\\/g, '/');
    // 1. Supabase Edge Function edit → auto-deploy (injected; skip when no hook).
    if (post_helpers_1.FUNCTION_PATH_RE.test(fp)) {
        const result = deps.functionEditDeploy ? deps.functionEditDeploy(filePath) : null;
        return result ? (0, result_1.context)(result) : (0, result_1.noop)();
    }
    // 2. Soft digest-size warning (never blocks the write).
    const digestMatch = fp.match(post_helpers_1.DIGEST_PATH_RE);
    if (digestMatch && fs.existsSync(filePath)) {
        let bytes = 0;
        try {
            bytes = fs.statSync(filePath).size;
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
    const reportOneMcp = deps.reportOneMcp;
    // 3. Non-state-file write → write-triggered convergence.
    if (!(0, tool_classify_1.isStateFilePath)(filePath)) {
        const mem = (0, converge_from_write_1.materializeFromProjectMemoryWrite)(cwd, filePath, { reportOneMcp });
        if (mem)
            return outcomeToResult(mem);
        const hint = (0, converge_from_write_1.materializeFromToolInputHints)(cwd, toolInput, { reportOneMcp });
        if (hint)
            return outcomeToResult(hint);
        return outcomeToResult((0, materialize_1.materializeProjectIfNeeded)(cwd, { trigger: 'generic post-tool convergence', reportOneMcp }));
    }
    // 4. State-file write → validate + materialize (writeState strips local prefs).
    if (!fs.existsSync(filePath))
        return (0, result_1.noop)();
    return outcomeToResult((0, materialize_1.materializeProjectFromState)((0, post_helpers_1.projectRootFromStateFilePath)(filePath), { trigger: 'post-stack-setup', reportOneMcp }));
}
