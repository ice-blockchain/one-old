"use strict";
// src/runners/doctor/index.ts
// Proactive diagnostic for traffic-one (compiles to scripts/doctor.cjs).
// Inspects the environment for the known-fragile spots (Node version, nvm
// default, gitnexus binary location, project `.nvmrc`, `.git/`, traffic-one
// state file, Codex hook trust, mcp-auth config, and — with `--session <id>` —
// a specific Codex transcript) and prints a structured JSON report.
//
// The report is purely informational: doctor never writes to the project,
// never installs anything, never modifies the state file. The
// `traffic-one-doctor` skill (or the user) decides what to do with the
// findings. Ported 1:1 from scripts/doctor.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCodexSession = exports.probeSessionDiagnostics = exports.probeProject = exports.probeNvm = exports.probeNode = exports.probeMcpAuth = exports.probeGitnexus = exports.probeCodexHooks = exports.analyzeCodexSessionFile = exports.parseArgs = exports.buildFindings = void 0;
exports.main = main;
const findings_1 = require("./findings");
const lib_1 = require("./lib");
const probes_1 = require("./probes");
var findings_2 = require("./findings");
Object.defineProperty(exports, "buildFindings", { enumerable: true, get: function () { return findings_2.buildFindings; } });
var lib_2 = require("./lib");
Object.defineProperty(exports, "parseArgs", { enumerable: true, get: function () { return lib_2.parseArgs; } });
var probes_2 = require("./probes");
Object.defineProperty(exports, "analyzeCodexSessionFile", { enumerable: true, get: function () { return probes_2.analyzeCodexSessionFile; } });
Object.defineProperty(exports, "probeCodexHooks", { enumerable: true, get: function () { return probes_2.probeCodexHooks; } });
Object.defineProperty(exports, "probeGitnexus", { enumerable: true, get: function () { return probes_2.probeGitnexus; } });
Object.defineProperty(exports, "probeMcpAuth", { enumerable: true, get: function () { return probes_2.probeMcpAuth; } });
Object.defineProperty(exports, "probeNode", { enumerable: true, get: function () { return probes_2.probeNode; } });
Object.defineProperty(exports, "probeNvm", { enumerable: true, get: function () { return probes_2.probeNvm; } });
Object.defineProperty(exports, "probeProject", { enumerable: true, get: function () { return probes_2.probeProject; } });
Object.defineProperty(exports, "probeSessionDiagnostics", { enumerable: true, get: function () { return probes_2.probeSessionDiagnostics; } });
Object.defineProperty(exports, "resolveCodexSession", { enumerable: true, get: function () { return probes_2.resolveCodexSession; } });
function main() {
    const args = (0, lib_1.parseArgs)();
    const cwd = process.cwd();
    const node = (0, probes_1.probeNode)();
    const nvm = (0, probes_1.probeNvm)();
    const gitnexus = (0, probes_1.probeGitnexus)();
    const project = (0, probes_1.probeProject)(cwd);
    const codexHooks = (0, probes_1.probeCodexHooks)(cwd);
    const mcpAuth = (0, probes_1.probeMcpAuth)();
    const sessionDiagnostics = (0, probes_1.probeSessionDiagnostics)(args.session);
    const findings = (0, findings_1.buildFindings)({ node, nvm, gitnexus, project, codexHooks, mcpAuth, sessionDiagnostics });
    const summary = findings.some((f) => f.severity === 'fix-needed')
        ? 'ACTION_NEEDED'
        : (findings.length > 0 ? 'INFO_ONLY' : 'HEALTHY');
    const version = project.state && typeof project.state.version === 'string' ? project.state.version : null;
    process.stdout.write(`${JSON.stringify({
        summary,
        findings,
        probes: { node, nvm, gitnexus, project, codexHooks, mcpAuth, sessionDiagnostics },
        version,
    }, null, 2)}\n`);
}
if (require.main === module)
    main();
