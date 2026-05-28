"use strict";
// src/adapters/cursor.ts
// Cursor is the flat-JSON outlier: camelCase event names, output keys
// additional_context / permission / user_message / agent_message, and coarse
// events. This adapter translates ONLY the I/O boundary — the coarse-event
// fan-out (one Cursor event → several gates) is handled by the pipeline running
// every handler that matches the canonical (event, tool class), driven by the
// generated dispatch table. Field extraction mirrors the legacy cursor runtime.
Object.defineProperty(exports, "__esModule", { value: true });
exports.cursorAdapter = void 0;
exports.makeCursorAdapter = makeCursorAdapter;
const fsjson_1 = require("../shared/fsjson");
const coerce_1 = require("./coerce");
// Cursor subcommand (argv) → canonical event + tool class. Edits/shell-after are
// POST events on Cursor (no pre-edit hook exists), which is why a file-edit deny
// can only warn there.
const SUB_TO_EVENT = {
    'session-start': { event: 'SessionStart' },
    'user-prompt-submit': { event: 'UserPromptSubmit' },
    'before-shell-execution': { event: 'PreToolUse', tool: 'shell' },
    'after-shell-execution': { event: 'PostToolUse', tool: 'shell' },
    'before-read-file': { event: 'PreToolUse', tool: 'file-read' },
    'after-file-edit': { event: 'PostToolUse', tool: 'file-edit' },
};
function subcommandOf(argv) {
    const known = argv.filter((arg) => Object.prototype.hasOwnProperty.call(SUB_TO_EVENT, arg));
    return known.length > 0 ? known[known.length - 1] : '';
}
function makeCursorAdapter() {
    return {
        id: 'cursor',
        parse(raw) {
            const sub = subcommandOf(raw.argv);
            const mapping = SUB_TO_EVENT[sub] ?? { event: 'PreToolUse' };
            const data = (0, coerce_1.asRecord)((0, fsjson_1.parseJson)(raw.stdin, {}));
            const input = (0, coerce_1.asRecord)(data.input ?? data.tool_input ?? data.toolInput);
            const document = (0, coerce_1.asRecord)(data.document);
            let tool;
            if (mapping.tool) {
                const command = (0, coerce_1.firstString)(data.command, data.cmd, data.shell_command, data.shellCommand, input.command, input.cmd);
                const filePath = (0, coerce_1.firstString)(data.file_path, data.filePath, data.path, data.uri, input.file_path, input.filePath, input.path, input.uri, document.path, document.uri);
                const content = (0, coerce_1.firstString)(data.content, data.new_content, data.newContent, data.text, input.content, input.new_content, input.newContent, input.text);
                tool = {
                    class: mapping.tool,
                    rawName: sub,
                    ...(command ? { command } : {}),
                    ...(filePath ? { filePath } : {}),
                    ...(content ? { content } : {}),
                };
            }
            const prompt = (0, coerce_1.firstString)(data.prompt, data.user_prompt, data.userPrompt, data.message, data.text);
            return {
                event: mapping.event,
                host: 'cursor',
                cwd: (0, coerce_1.firstString)(data.cwd) || process.cwd(),
                raw: data,
                ...(tool ? { tool } : {}),
                ...(prompt ? { prompt } : {}),
            };
        },
        serialize(result) {
            // Cursor has no promptRequest equivalent — drop it; map systemMessage → user_message.
            if (result.kind === 'noop')
                return '{}';
            if (result.kind === 'context') {
                return JSON.stringify({
                    ...(result.context && result.context.trim() ? { additional_context: result.context } : {}),
                    ...(result.systemMessage !== undefined ? { user_message: result.systemMessage } : {}),
                });
            }
            return JSON.stringify({
                ...(result.context ? { additional_context: result.context } : {}),
                permission: 'deny',
                user_message: result.reason,
                agent_message: result.reason,
            });
        },
    };
}
exports.cursorAdapter = makeCursorAdapter();
