"use strict";
// src/shared/materialize/converge.ts
// Materialization convergence: the `materialize-project` body and the
// hook-time "materialize if needed" guard. Ported 1:1 from
// materializeProjectFromState + materializeProjectIfNeeded (_helpers.cjs).
//
// Returns a plain MaterializeOutcome (domain result) instead of host-shaped
// stdout — the calling module maps it to a canonical HookResult. The one-mcp
// background reporter is injected (default no-op) so this service stays free of
// the runner layer.
Object.defineProperty(exports, "__esModule", { value: true });
exports.materializeProjectFromState = materializeProjectFromState;
exports.materializeProjectIfNeeded = materializeProjectIfNeeded;
const config_1 = require("../config");
const directives_1 = require("../directives");
const authoring_root_1 = require("../authoring-root");
const detection_1 = require("../detection");
const stacks_1 = require("../stacks");
const text_1 = require("../text");
const state_1 = require("../state");
const has_assets_1 = require("./has-assets");
const materialize_1 = require("./materialize");
const plan_migration_1 = require("./plan-migration");
const noopReporter = () => { };
function outcome(status, systemMessage, context, result = null) {
    return { status, systemMessage, context, result };
}
// The `materialize-project` subcommand body: validate state, write
// .traffic-one/** rules+skills + root AGENTS.md/CLAUDE.md, stamp the state, and
// kick the background reporter.
function materializeProjectFromState(cwd, opts = {}) {
    const trigger = opts.trigger || 'manual materialize-project';
    const reportOneMcp = opts.reportOneMcp || noopReporter;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd)) {
        return outcome('authoring-root', 'traffic-one — plugin authoring root detected; project materialization skipped', 'This directory is the Traffic One plugin source, not a generated Traffic One project. `materialize-project` only rewrites `.traffic-one/**`, root `AGENTS.md`, and root `CLAUDE.md` inside projects created with the plugin.');
    }
    const state = (0, state_1.readEffectiveState)(cwd);
    const validStackIds = Object.keys(stacks_1.STACKS);
    const validCodeGraphProviders = ['gitnexus', 'graphify'];
    if (!state || typeof state !== 'object') {
        return outcome('missing-state', 'traffic-one — `.traffic-one/.one.json` is missing or invalid; cannot materialize project rules', 'Write the complete Traffic One state file first, then run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project` from the project root.');
    }
    const normalizedBeforeValidation = (0, state_1.normalizeState)(state, state.mode || (0, detection_1.detectMode)(cwd));
    const cgProvider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
    const validationIssues = (0, state_1.trafficOneStateValidationIssues)(state, validCodeGraphProviders);
    if (validationIssues.length > 0) {
        const context = (0, directives_1.postWriteIncompleteWarning)({
            stack: state.stack || null,
            validStackIds,
            codeGraphProvider: cgProvider,
            validCodeGraphProviders,
            validationIssues,
        });
        return outcome('incomplete', 'traffic-one — `.traffic-one/.one.json` is incomplete; cannot materialize project rules yet', context);
    }
    if (normalizedBeforeValidation) {
        try {
            (0, state_1.writeState)(cwd, state);
        }
        catch {
            // best-effort; materialization can still proceed with the normalized object.
        }
    }
    (0, plan_migration_1.migrateArchitectureDocsToPlan)(cwd);
    let materialized = null;
    try {
        materialized = (0, materialize_1.materializeProjectAssets)(cwd, state);
    }
    catch (error) {
        const detail = error && error.message ? error.message : String(error || 'unknown error');
        return outcome('failed', 'traffic-one — project-local materialization failed', `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`);
    }
    try {
        state.materializedStack = (0, state_1.stackFingerprint)(state);
        state.materializedAt = (0, text_1.nowIsoNoMs)();
        state.materializedVersion = (0, state_1.stateVersion)();
        (0, state_1.writeState)(cwd, state);
    }
    catch {
        // best-effort; the copied local assets are still usable.
    }
    reportOneMcp(cwd, state, trigger);
    if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
        return outcome('current', 'traffic-one — project-local rules/skills already materialized', `Project-local rules/skills are current for ${(0, state_1.stackFingerprint)(state)}. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`, materialized);
    }
    return outcome('materialized', 'traffic-one — project-local rules/skills materialized', `Project-local rules/skills materialized after ${trigger}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/manifest.json. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`, materialized);
}
// Hook-time convergence guard: ensure a project's .traffic-one/** is current
// for its state, materializing on demand. Returns null when nothing is needed
// (the common case); callers that only want the side-effect ignore the return.
function materializeProjectIfNeeded(cwd, opts = {}) {
    const trigger = opts.trigger || 'generic hook convergence';
    const reportOneMcp = opts.reportOneMcp || noopReporter;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return null;
    const state = (0, state_1.readEffectiveState)(cwd);
    if (!state || typeof state !== 'object')
        return null;
    (0, plan_migration_1.migrateArchitectureDocsToPlan)(cwd);
    const normalized = (0, state_1.normalizeState)(state, state.mode || (0, detection_1.detectMode)(cwd));
    if (normalized) {
        try {
            (0, state_1.writeState)(cwd, state);
        }
        catch {
            // Let the materializer surface a validation or write failure below.
        }
    }
    if (!state.stack || !(0, config_1.isKnownStack)(state.stack)) {
        if (state.mode === 'new-project' || state.onboardingComplete === true) {
            return materializeProjectFromState(cwd, { trigger, reportOneMcp });
        }
        return null;
    }
    if (state.onboardingComplete !== true)
        return null;
    if ((0, state_1.isMaterialized)(state) && (0, has_assets_1.hasMaterializedProjectAssets)(cwd, state)) {
        reportOneMcp(cwd, state, trigger);
        return null;
    }
    return materializeProjectFromState(cwd, { trigger, reportOneMcp });
}
