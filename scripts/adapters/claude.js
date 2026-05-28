"use strict";
// src/adapters/claude.ts
// Claude + Codex share the nested `hookSpecificOutput` wire shape, and the
// raw→canonical tool map already folds both tool vocabularies (Bash/Edit vs
// exec_command/apply_patch) into one set of tool classes — so one adapter serves
// both nested hosts. Cursor (flat JSON) is the separate outlier.
Object.defineProperty(exports, "__esModule", { value: true });
exports.codexAdapter = exports.claudeAdapter = void 0;
exports.makeClaudeAdapter = makeClaudeAdapter;
const events_1 = require("../core/events");
const fsjson_1 = require("../shared/fsjson");
const coerce_1 = require("./coerce");
function normalizeEvent(value) {
    switch ((0, coerce_1.asString)(value)) {
        case 'SessionStart':
            return 'SessionStart';
        case 'UserPromptSubmit':
            return 'UserPromptSubmit';
        case 'PostToolUse':
            return 'PostToolUse';
        default:
            return 'PreToolUse';
    }
}
function makeClaudeAdapter(id = 'claude') {
    return {
        id,
        parse(raw) {
            const data = (0, coerce_1.asRecord)((0, fsjson_1.parseJson)(raw.stdin, {}));
            const event = normalizeEvent(data.hook_event_name ?? data.hookEventName);
            const rawName = (0, coerce_1.asString)(data.tool_name ?? data.toolName);
            const toolInput = (0, coerce_1.asRecord)(data.tool_input ?? data.toolInput);
            let tool;
            if (rawName) {
                const command = (0, coerce_1.asString)(toolInput.command);
                const filePath = (0, coerce_1.asString)(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
                const content = (0, coerce_1.asString)(toolInput.content ?? toolInput.new_content ?? toolInput.newContent);
                tool = {
                    class: (0, events_1.toolClassForRawName)(rawName),
                    rawName,
                    ...(command ? { command } : {}),
                    ...(filePath ? { filePath } : {}),
                    ...(content ? { content } : {}),
                };
            }
            const prompt = (0, coerce_1.asString)(data.prompt);
            return {
                event,
                host: id,
                cwd: (0, coerce_1.asString)(data.cwd) || process.cwd(),
                raw: data,
                ...(tool ? { tool } : {}),
                ...(prompt ? { prompt } : {}),
            };
        },
        serialize(result, input) {
            if (result.kind === 'noop')
                return '';
            if (result.kind === 'context') {
                return JSON.stringify({
                    ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
                    ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
                    hookSpecificOutput: { hookEventName: input.event, additionalContext: result.context },
                });
            }
            return JSON.stringify({
                ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
                ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: result.reason,
                    ...(result.context ? { additionalContext: result.context } : {}),
                },
            });
        },
    };
}
exports.claudeAdapter = makeClaudeAdapter('claude');
exports.codexAdapter = makeClaudeAdapter('codex');
