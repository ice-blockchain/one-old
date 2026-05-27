#!/usr/bin/env node
'use strict';

// scripts/doctor.cjs
// Proactive diagnostic for traffic-one. Inspects the environment for the
// known-fragile spots (Node version, nvm default, gitnexus binary
// location, project `.nvmrc`, `.git/`, traffic-one state file) and
// produces a structured JSON report. The `traffic-one-doctor` skill
// runs this and surfaces the findings to the user with recommendations.
//
// Output: JSON to stdout. The report is purely informational — doctor.cjs
// never writes to the project, never installs anything, never modifies the
// state file. The skill (or user) decides what to do with the findings.

const { parseArgs } = require('./doctor/_helpers.cjs');
const { probeNode } = require('./doctor/probeNode.cjs');
const { probeNvm } = require('./doctor/probeNvm.cjs');
const { probeGitnexus } = require('./doctor/probeGitnexus.cjs');
const { probeProject } = require('./doctor/probeProject.cjs');
const { probeCodexHooks } = require('./doctor/probeCodexHooks.cjs');
const { probeMcpAuth } = require('./doctor/probeMcpAuth.cjs');
const { probeSessionDiagnostics } = require('./doctor/probeSessionDiagnostics.cjs');
const { analyzeCodexSessionFile } = require('./doctor/analyzeCodexSessionFile.cjs');
const { resolveCodexSession } = require('./doctor/resolveCodexSession.cjs');
const { buildFindings } = require('./doctor/buildFindings.cjs');

function main() {
  const args = parseArgs();
  const cwd = process.cwd();
  const node = probeNode();
  const nvm = probeNvm();
  const gitnexus = probeGitnexus();
  const project = probeProject(cwd);
  const codexHooks = probeCodexHooks(cwd);
  const mcpAuth = probeMcpAuth();
  const sessionDiagnostics = probeSessionDiagnostics(args.session);
  const findings = buildFindings({ node, nvm, gitnexus, project, codexHooks, mcpAuth, sessionDiagnostics });
  const summary = findings.some((f) => f.severity === 'fix-needed')
    ? 'ACTION_NEEDED'
    : (findings.length > 0 ? 'INFO_ONLY' : 'HEALTHY');

  process.stdout.write(JSON.stringify({
    summary,
    findings,
    probes: { node, nvm, gitnexus, project, codexHooks, mcpAuth, sessionDiagnostics },
    version: typeof project.state?.version === 'string' ? project.state.version : null,
  }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  probeNode,
  probeNvm,
  probeGitnexus,
  probeProject,
  probeCodexHooks,
  probeMcpAuth,
  probeSessionDiagnostics,
  analyzeCodexSessionFile,
  resolveCodexSession,
  buildFindings,
};
