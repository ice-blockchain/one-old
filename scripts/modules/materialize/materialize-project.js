"use strict";
// src/modules/materialize/materialize-project.ts
// The `materialize-project` manual subcommand: auth-gate, then converge the
// project's .traffic-one/** from its committed state. Ported 1:1 from
// runMaterializeProject (post.cjs:674). This is a manual CLI command (NOT wired
// into hooks.json), so it is not a pipeline gate — the host entry routes the
// subcommand straight to this action. The auth gate is reused from the session
// module (auth is a cross-cutting kernel concern shared by command actions).
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMaterializeProject = runMaterializeProject;
const result_1 = require("../../core/result");
const authoring_root_1 = require("../../shared/authoring-root");
const materialize_1 = require("../../shared/materialize");
const auth_choice_1 = require("../session/auth-choice");
const auth_gate_1 = require("../session/auth-gate");
function runMaterializeProject(ctx) {
    const cwd = ctx.cwd;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return (0, result_1.noop)();
    const authGate = (0, auth_gate_1.authGateForHook)();
    if (!authGate.authenticated) {
        if ((0, auth_choice_1.authChoiceAllowsContinue)(cwd))
            return (0, result_1.noop)();
        const writeResult = (0, auth_choice_1.tryWriteAuthChoice)('pending-choice', cwd);
        return (0, auth_gate_1.authRequiredHookResult)('PostToolUse', { authChoiceWrite: writeResult });
    }
    const out = (0, materialize_1.materializeProjectFromState)(cwd, { trigger: 'manual materialize-project' });
    return (0, result_1.context)(out.context, { systemMessage: out.systemMessage });
}
