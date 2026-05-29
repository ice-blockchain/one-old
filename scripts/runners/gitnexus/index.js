"use strict";
// src/runners/gitnexus/index.ts
// CLI entry + public surface for the foreground GitNexus bootstrap (compiles to
// scripts/gitnexus-runner.cjs). Re-exports the nvm discovery helpers (consumed
// by doctor) and the bootstrap (consumed by the post-build code-graph hint and
// the orchestrator's Phase 5). Ported 1:1 from scripts/gitnexus-runner.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowIso = exports.which = exports.nvmPresent = exports.nvmInstallCommand = exports.nodeVersionMismatchMessage = exports.findNvmNode22 = exports.currentNodeMajor = exports.GITNEXUS_MIN_NODE_MAJOR = exports.CONFLICT_PATHS = exports.bootstrap = void 0;
exports.main = main;
const exec_1 = require("../../shared/exec");
const text_1 = require("../../shared/text");
Object.defineProperty(exports, "nowIso", { enumerable: true, get: function () { return text_1.nowIso; } });
const bootstrap_1 = require("./bootstrap");
var bootstrap_2 = require("./bootstrap");
Object.defineProperty(exports, "bootstrap", { enumerable: true, get: function () { return bootstrap_2.bootstrap; } });
Object.defineProperty(exports, "CONFLICT_PATHS", { enumerable: true, get: function () { return bootstrap_2.CONFLICT_PATHS; } });
var nvm_1 = require("./nvm");
Object.defineProperty(exports, "GITNEXUS_MIN_NODE_MAJOR", { enumerable: true, get: function () { return nvm_1.GITNEXUS_MIN_NODE_MAJOR; } });
Object.defineProperty(exports, "currentNodeMajor", { enumerable: true, get: function () { return nvm_1.currentNodeMajor; } });
Object.defineProperty(exports, "findNvmNode22", { enumerable: true, get: function () { return nvm_1.findNvmNode22; } });
Object.defineProperty(exports, "nodeVersionMismatchMessage", { enumerable: true, get: function () { return nvm_1.nodeVersionMismatchMessage; } });
Object.defineProperty(exports, "nvmInstallCommand", { enumerable: true, get: function () { return nvm_1.nvmInstallCommand; } });
Object.defineProperty(exports, "nvmPresent", { enumerable: true, get: function () { return nvm_1.nvmPresent; } });
// Legacy public surface re-exported the shared which()/nowIso() too.
exports.which = exec_1.exec.which;
function main() {
    const result = (0, bootstrap_1.bootstrap)(process.cwd());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 0;
}
if (require.main === module)
    main();
