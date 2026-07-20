// src/runners/doctor/index.ts
// Proactive diagnostic for traffic-one (compiles to scripts/doctor.cjs).
// Inspects the environment for the known-fragile spots (Node version, nvm
// default, gitnexus binary location, project `.nvmrc`, `.git/`, traffic-one
// state file, canonical API-key auth, Codex hook trust, and — with `--session <id>` —
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
  probeCanonicalAuth,
  probeNode,
  probeNvm,
  probeOneMcp,
  probeOpenCodeMcp,
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
  probeCanonicalAuth,
  probeNode,
  probeNvm,
  probeOneMcp,
  probeOpenCodeMcp,
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
  const auth = probeCanonicalAuth();
  const oneMcp = probeOneMcp();
  const openCodeMcp = probeOpenCodeMcp();
  const sessionDiagnostics = probeSessionDiagnostics(args.session);
  const findings = buildFindings({ node, nvm, gitnexus, project, codexHooks, auth, oneMcp, openCodeMcp, sessionDiagnostics });
  const summary = findings.some((f) => f.severity === 'fix-needed')
    ? 'ACTION_NEEDED'
    : (findings.length > 0 ? 'INFO_ONLY' : 'HEALTHY');

  const version = project.state && typeof project.state.version === 'string' ? project.state.version : null;
  process.stdout.write(`${JSON.stringify({
    summary,
    findings,
    probes: { node, nvm, gitnexus, project, codexHooks, auth, oneMcp, openCodeMcp, sessionDiagnostics },
    version,
  }, null, 2)}\n`);
}

if (require.main === module) main();
