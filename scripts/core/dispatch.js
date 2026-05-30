"use strict";
// src/core/dispatch.ts
// The request path: raw host invocation → adapter.parse → buildContext →
// runPipeline → adapter.serialize. The host entry scripts pick an adapter
// (adapters/select) and a handler set (registry) and call this.
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatch = dispatch;
exports.handlersForSubcommand = handlersForSubcommand;
exports.dispatchSubcommand = dispatchSubcommand;
const context_1 = require("./context");
const pipeline_1 = require("./pipeline");
const hook_trace_1 = require("../shared/hook-trace");
async function dispatch(adapter, handlers, raw) {
    const input = adapter.parse(raw);
    (0, hook_trace_1.maybeTraceHook)(input, raw.stdin); // off-by-default; gated by TRAFFIC_ONE_HOOK_TRACE
    const ctx = (0, context_1.buildContext)(input);
    const result = await (0, pipeline_1.runPipeline)(handlers, ctx);
    return adapter.serialize(result, input);
}
// The handlers a given hook subcommand invokes — those that declared the
// subcommand in their `subcommands`. runPipeline still re-filters by (event,
// tool class) + orders by priority, so the auth gate (priority 0) runs first
// for the gate subcommands it participates in, then short-circuits on deny.
// Reproduces the legacy 1:1 subcommand→handler dispatch (each legacy gate
// checked auth first) while keeping routing module-local (no central map).
function handlersForSubcommand(handlers, subcommand) {
    return handlers.filter((handler) => handler.subcommands?.includes(subcommand));
}
// Route a raw host invocation for a specific subcommand through the pipeline.
// The host entry resolves argv→subcommand, picks the adapter, and calls this.
async function dispatchSubcommand(adapter, handlers, subcommand, raw) {
    return dispatch(adapter, handlersForSubcommand(handlers, subcommand), raw);
}
