"use strict";
// src/hooks/claude-entry.ts
// Thin host entry for Claude Code + Codex (both speak the nested
// hookSpecificOutput wire shape). Compiles to scripts/hook-runtime.cjs at
// cutover — the path every Claude/Codex hook command already invokes:
//   node "${TRAFFIC_ONE_PLUGIN_ROOT:-…}/scripts/hook-runtime.cjs" <subcommand>
//
// Responsibilities: resolve argv→subcommand, detect host, discover module
// handlers (registry readdir), route the subcommand through the pipeline, and
// uphold the always-exit-0 contract with a SessionStart fail-closed fallback.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runClaudeHook = runClaudeHook;
exports.main = main;
const dispatch_1 = require("../core/dispatch");
const registry_1 = require("../core/registry");
const select_1 = require("../adapters/select");
const auth_1 = require("../shared/auth");
const host_1 = require("../shared/host");
// Fail-closed SessionStart fallback: a crashed session-start must still surface
// the auth gate (fail toward "unverified") rather than emit nothing.
function sessionStartFallback(env) {
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: (0, auth_1.authRequiredMessage)(env),
        },
    });
}
// Testable core: given a subcommand + raw stdin, produce the host stdout string.
// Never throws — upholds the always-exit-0 contract.
async function runClaudeHook(subcommand, stdin, env = process.env) {
    if (!subcommand)
        return { stdout: '', exitCode: 0 };
    const host = (0, host_1.detectHost)(env, ['--host', subcommand]); // never cursor here
    const adapter = (0, select_1.selectAdapter)(host === 'codex' ? 'codex' : 'claude');
    try {
        const handlers = (0, registry_1.collectHandlers)((0, registry_1.loadModules)((0, registry_1.defaultModulesDir)()));
        const stdout = await (0, dispatch_1.dispatchSubcommand)(adapter, handlers, subcommand, { stdin, argv: [subcommand] });
        return { stdout, exitCode: 0 };
    }
    catch {
        if (subcommand === 'session-start') {
            return { stdout: sessionStartFallback(env), exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
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
        // No piped stdin (interactive/no input) — don't hang.
        if (stdin.isTTY)
            done();
    });
}
async function main() {
    const subcommand = process.argv[2];
    const stdin = await readStdin();
    const { stdout } = await runClaudeHook(subcommand, stdin);
    if (stdout)
        process.stdout.write(stdout);
    process.exitCode = 0;
}
if (require.main === module) {
    void main();
}
