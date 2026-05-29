"use strict";
// src/core/result.ts
// Builders + merge for the canonical HookResult (now carrying optional
// systemMessage / promptRequest). Handlers never assemble host-shaped output.
Object.defineProperty(exports, "__esModule", { value: true });
exports.noop = void 0;
exports.context = context;
exports.deny = deny;
exports.isDeny = isDeny;
exports.mergeResults = mergeResults;
const noop = () => ({ kind: 'noop' });
exports.noop = noop;
function context(text, meta = {}) {
    const hasText = Boolean(text && text.trim());
    if (!hasText && meta.systemMessage === undefined && meta.promptRequest === undefined) {
        return { kind: 'noop' };
    }
    return { kind: 'context', context: text || '', ...meta };
}
function deny(reason, opts = {}) {
    const { context: extraContext, ...meta } = opts;
    return {
        kind: 'deny',
        reason,
        ...(extraContext && extraContext.trim() ? { context: extraContext } : {}),
        ...meta,
    };
}
function isDeny(result) {
    return result.kind === 'deny';
}
// Merge results: the first deny wins (short-circuit). Otherwise concatenate
// context strings and keep the first systemMessage / promptRequest seen.
function mergeResults(results) {
    for (const result of results) {
        if (isDeny(result))
            return result;
    }
    const contexts = [];
    let systemMessage;
    let promptRequest;
    for (const result of results) {
        if (result.kind !== 'context')
            continue;
        if (result.context && result.context.trim())
            contexts.push(result.context);
        if (systemMessage === undefined && result.systemMessage !== undefined)
            systemMessage = result.systemMessage;
        if (promptRequest === undefined && result.promptRequest !== undefined)
            promptRequest = result.promptRequest;
    }
    if (contexts.length === 0 && systemMessage === undefined && promptRequest === undefined) {
        return { kind: 'noop' };
    }
    return {
        kind: 'context',
        context: contexts.join('\n\n'),
        ...(systemMessage !== undefined ? { systemMessage } : {}),
        ...(promptRequest !== undefined ? { promptRequest } : {}),
    };
}
