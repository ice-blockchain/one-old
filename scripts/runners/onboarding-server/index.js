"use strict";
// src/runners/onboarding-server/index.ts
// CLI entry for the detached onboarding wizard server (compiles to
// scripts/onboarding-server.cjs, invoked via the build SHIM). main() starts the
// listening server and returns; the live socket keeps the process alive until the
// wizard completes or the idle timer fires. Never throws on the top level.
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOnboardingServer = void 0;
exports.main = main;
const server_1 = require("./server");
var server_2 = require("./server");
Object.defineProperty(exports, "startOnboardingServer", { enumerable: true, get: function () { return server_2.startOnboardingServer; } });
async function main() {
    const cwd = process.argv[2] || process.cwd();
    await (0, server_1.startOnboardingServer)({ cwd, standalone: true });
}
if (require.main === module) {
    main().catch(() => {
        process.exitCode = 0;
    });
}
