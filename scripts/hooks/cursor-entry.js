"use strict";
// src/hooks/cursor-entry.ts
// Thin host entry for Cursor. Compiles to scripts/cursor-hook-runtime.cjs at
// cutover — the path Cursor's hooks-cursor.json already invokes:
//   node ./scripts/cursor-hook-runtime.cjs <subcommand>
//
// Cursor exposes COARSE events (one hook per event), so unlike the Claude entry
// (which routes its fine-grained subcommands to specific handlers), this runs
// the full pipeline: the cursor adapter maps the subcommand → canonical
// (event, tool class), and runPipeline fans out to every handler that matches —
// the coarse-event fan-out the legacy mergeCursorOutputs did by hand. Merged
// context becomes one Cursor output, so there is no double-emit to guard.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCursorHook = runCursorHook;
exports.main = main;
const dispatch_1 = require("../core/dispatch");
const registry_1 = require("../core/registry");
const cursor_1 = require("../adapters/cursor");
const auth_1 = require("../shared/auth");
// Cursor's empty/no-op output is the empty JSON object (not an empty string).
const CURSOR_NOOP = '{}';
function sessionStartFallback(env) {
    return JSON.stringify({ additional_context: (0, auth_1.authRequiredMessage)(env) });
}
async function runCursorHook(subcommand, stdin, env = process.env) {
    if (!subcommand)
        return { stdout: CURSOR_NOOP, exitCode: 0 };
    const adapter = (0, cursor_1.makeCursorAdapter)();
    try {
        const handlers = (0, registry_1.collectHandlers)((0, registry_1.loadModules)((0, registry_1.defaultModulesDir)()));
        const stdout = await (0, dispatch_1.dispatch)(adapter, handlers, { stdin, argv: [subcommand] });
        return { stdout: stdout || CURSOR_NOOP, exitCode: 0 };
    }
    catch {
        if (subcommand === 'session-start') {
            return { stdout: sessionStartFallback(env), exitCode: 0 };
        }
        return { stdout: CURSOR_NOOP, exitCode: 0 };
    }
}
function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        const stdin = process.stdin;
        let settled = false;
        const done = () => { if (!settled) {
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        } };
        stdin.on('data', (chunk) => chunks.push(chunk));
        stdin.on('end', done);
        stdin.on('error', done);
        if (stdin.isTTY)
            done();
    });
}
async function main() {
    const subcommand = process.argv[2];
    const stdin = await readStdin();
    const { stdout } = await runCursorHook(subcommand, stdin);
    process.stdout.write(stdout);
    process.exitCode = 0;
}
if (require.main === module) {
    void main();
}
