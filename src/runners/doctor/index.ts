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

import { buildFindings } from './findings';
import { parseArgs } from './lib';
import { resolveProjectRoot } from '../../shared/hook-paths';
import {
  probeCodexHooks,
  probeGitnexus,
  probeMcpAuth,
  probeNode,
  probeNvm,
  probeProject,
  probeSessionDiagnostics,
} from './probes';

export { buildFindings } from './findings';
export type { Finding, BuildFindingsInput } from './findings';
export { parseArgs } from './lib';
export {
  analyzeCodexSessionFile,
  probeCodexHooks,
  probeGitnexus,
  probeMcpAuth,
  probeNode,
  probeNvm,
  probeProject,
  probeSessionDiagnostics,
  resolveCodexSession,
} from './probes';

export function main(): void {
  const args = parseArgs();
  const cwd = resolveProjectRoot(process.cwd());
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

  const version = project.state && typeof project.state.version === 'string' ? project.state.version : null;
  process.stdout.write(`${JSON.stringify({
    summary,
    findings,
    probes: { node, nvm, gitnexus, project, codexHooks, mcpAuth, sessionDiagnostics },
    version,
  }, null, 2)}\n`);
}

if (require.main === module) main();
