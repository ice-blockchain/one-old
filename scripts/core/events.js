"use strict";
// src/core/events.ts
// Canonical event/tool-class helpers. The raw→canonical tool mapping is the
// single source that lets one gate match Claude's `Bash`, Codex's `exec_command`,
// and Cursor's shell event without any host branching in feature code.
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolClassForRawName = toolClassForRawName;
exports.handlerMatches = handlerMatches;
const RAW_TOOL_CLASS = {
    // shell
    Bash: 'shell',
    exec_command: 'shell',
    // write (create / bulk)
    Write: 'file-write',
    MultiEdit: 'file-write',
    apply_patch: 'file-write',
    // edit (modify existing)
    Edit: 'file-edit',
    // read
    Read: 'file-read',
    // subagents
    Task: 'spawn-agent',
    Agent: 'spawn-agent',
    spawn_agent: 'spawn-agent',
    send_input: 'spawn-agent',
    wait_agent: 'spawn-agent',
    // search
    Glob: 'search',
    Grep: 'search',
};
function toolClassForRawName(rawName) {
    return RAW_TOOL_CLASS[rawName] ?? 'other';
}
// Does a handler apply to this input? Same event, and (for tool-scoped handlers)
// the input's tool class is in the handler's list. No `tools` ⇒ all tools.
function handlerMatches(handler, input) {
    if (handler.event !== input.event)
        return false;
    if (!handler.tools || handler.tools.length === 0)
        return true;
    const cls = input.tool?.class;
    return cls != null && handler.tools.includes(cls);
}
