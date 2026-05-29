"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectAdapter = selectAdapter;
const claude_1 = require("./claude");
const cursor_1 = require("./cursor");
function selectAdapter(host) {
    if (host === 'cursor')
        return (0, cursor_1.makeCursorAdapter)();
    return (0, claude_1.makeClaudeAdapter)(host === 'codex' ? 'codex' : 'claude');
}
