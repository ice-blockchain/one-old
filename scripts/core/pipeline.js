"use strict";
// src/core/pipeline.ts
// Chain-of-responsibility gate/handler pipeline. Replaces the 5 separate
// PreToolUse processes + the 750-line gates.cjs: handlers matching the input's
// (event, tool class) run in ascending-priority order, a deny short-circuits the
// rest, and the surviving context results are merged.
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectHandlers = selectHandlers;
exports.runPipeline = runPipeline;
const events_1 = require("./events");
const result_1 = require("./result");
function selectHandlers(handlers, ctx) {
    return handlers
        .filter((handler) => (0, events_1.handlerMatches)(handler, ctx.input))
        .sort((a, b) => a.priority - b.priority);
}
async function runPipeline(handlers, ctx) {
    const collected = [];
    for (const handler of selectHandlers(handlers, ctx)) {
        const result = await handler.run(ctx);
        if ((0, result_1.isDeny)(result))
            return result; // short-circuit
        collected.push(result);
    }
    return (0, result_1.mergeResults)(collected);
}
