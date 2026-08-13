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

import { buildDoctorBundle, redactProjectProbe } from './bundle';
import { buildFindings, doctorSummary } from './findings';
import { parseArgs, type DoctorArgs } from './lib';
import { probeOverrides } from './override-probe';
import { probePluginIdentity } from './plugin-identity';
import { probePluginRoot } from './plugin-root-probe';
import { probeRunDiagnostic } from './run-diagnostic';
import { formatRunDiagnosticReport } from './run-diagnostic-report';
import { reconcileMain, unblockMain, wantsOverrideReconcile } from './unblock';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { readDecisions } from '../../shared/state/decision-log';
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
  type ProjectProbe,
  type SessionDiagnosticsResult,
} from './probes';
export {
  CODEX_HOOK_EXPECTED_COUNT,
  CODEX_TRAFFIC_ONE_HOOK_KEYS,
  CODEX_TRAFFIC_ONE_PLUGIN_ID,
  probeCodexHookTrust,
  resolveCodexBinary,
} from './codex-hook-trust';
export type { CodexHookTrustProbe, CodexHookTrustProbeOptions, CodexHookTrustStatus } from './codex-hook-trust';

export { buildDoctorBundle, looksLikeSecretValue, redactProjectProbe } from './bundle';
export type { BuildDoctorBundleInput, DoctorBundle, RedactedDecisionRecord, RedactedProjectProbe } from './bundle';
export { buildFindings, doctorSummary } from './findings';
export type { DoctorSummary, Finding, BuildFindingsInput } from './findings';
export { parseArgs } from './lib';
export type { DoctorArgs } from './lib';
export { probePluginIdentity } from './plugin-identity';
export type { PluginIdentity } from './plugin-identity';
export { probePluginRoot } from './plugin-root-probe';
export type { PluginRootProbe } from './plugin-root-probe';
export { probeRunDiagnostic } from './run-diagnostic';
export type {
  ClaimDiagnostic,
  ClaimStateDiagnostic,
  DenyTally,
  LedgerDiagnostic,
  LiveAgentDiagnostic,
  RunDiagnosticProbe,
} from './run-diagnostic';
export { formatRunDiagnosticReport } from './run-diagnostic-report';
export { OVERRIDE_RECONCILE_FLAG, overrideReconcileCommand, probeOverrides } from './override-probe';
export type { OverrideProbe } from './override-probe';
export {
  buildOverrideSnapshot,
  isInteractiveTerminal,
  overrideConfirmationNonce,
  projectRunIds,
  runOverrideReconcile,
  runUnblock,
  wantsOverrideReconcile,
} from './unblock';
export type { ReconcileOutcome, ReconcileRefusal, UnblockOutcome, UnblockRefusal, UnblockRequest } from './unblock';
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

// `--run <id>` diagnoses one run explicitly; every other invocation falls back
// to whichever run the project state currently points at, so plain `doctor` —
// the first command anyone runs, and the one the skill prescribes when "the run
// is stuck" — captures the live wedge instead of an empty runDiagnostic.
// Restricting the fallback to `--bundle` was strictly worse than useless on the
// default path: it produced none of the RUN_* findings AND left
// GHOST_CURRENT_RUN_ID free to advise clearing the id of a run that `--run`
// reports as active with registered agents.
export function resolveDoctorRunId(args: DoctorArgs, runState: ProjectProbe['runState']): string | null {
  return args.run ?? runState.currentRunId ?? null;
}

export function selectDoctorProjectCwd(invocationCwd: string, sessionDiagnostics: SessionDiagnosticsResult): string {
  const recordedCwd = sessionDiagnostics && sessionDiagnostics.found === true
    && typeof sessionDiagnostics.cwd === 'string' && sessionDiagnostics.cwd.trim()
    ? sessionDiagnostics.cwd
    : invocationCwd;
  return resolveProjectRoot(recordedCwd);
}

export async function main(): Promise<void> {
  const args = parseArgs();

  // `--unblock` is a MINT, not a diagnostic. It runs before — and instead of —
  // the probe suite: none of the findings inform the decision, the operator is
  // answering a question about one gate, and burying an irreversible,
  // interactive prompt after a page of unrelated JSON is how a confirmation
  // gets clicked through. `--session` is deliberately ignored here: a mint is
  // about the project you are standing in, never about a transcript's recorded
  // cwd, which the operator confirming it may never have seen.
  if (args.unblock !== null) {
    const projectRoot = resolveProjectRoot(process.cwd());
    process.exitCode = await unblockMain({
      projectRoot,
      gateId: args.unblock,
      runId: resolveDoctorRunId(args, probeProject(projectRoot).runState),
      ttl: args.ttl,
    });
    return;
  }

  // The other operator write, and it runs ahead of the probes for the same
  // reasons: it is interactive, irreversible, and about the project you are
  // standing in. Read straight off argv rather than through parseArgs because
  // it takes no value and belongs to the override command — see
  // wantsOverrideReconcile.
  if (wantsOverrideReconcile()) {
    process.exitCode = await reconcileMain(resolveProjectRoot(process.cwd()));
    return;
  }

  // Resolve the incident first: `doctor --session` must not combine a target
  // transcript with project prefs/trust from whichever directory invoked it.
  const sessionDiagnostics = probeSessionDiagnostics(args.session);
  const cwd = selectDoctorProjectCwd(process.cwd(), sessionDiagnostics);
  const node = probeNode();
  const nvm = probeNvm();
  const gitnexus = probeGitnexus();
  const project = probeProject(cwd);
  const codexHooks = await probeCodexHooks(cwd);
  const auth = probeCanonicalAuth();
  const oneMcp = probeOneMcp();
  const openCodeMcp = probeOpenCodeMcp();
  const pluginRoot = probePluginRoot();
  const plugin = probePluginIdentity(pluginRoot);

  // Probed BEFORE buildFindings — a wedged run has to be able to reach
  // `summary`, or the JSON an agent parses reads HEALTHY while the operator
  // report on stderr says the run is stuck.
  const runId = resolveDoctorRunId(args, project.runState);
  const runDiagnostic = runId ? probeRunDiagnostic(cwd, runId) : null;

  // Hoisted out of the buildFindings call so it can also be PRINTED. It was
  // computed inline and consumed only by findings, which is how a report with
  // an override-evidence refusal behind it could still print `HEALTHY` with no
  // trace of the probe that knew better.
  const overrides = probeOverrides(cwd, runId);
  const findings = buildFindings({
    node, nvm, gitnexus, project, codexHooks, auth, oneMcp, openCodeMcp, sessionDiagnostics, pluginRoot, runDiagnostic,
    overrides,
  });
  const summary = doctorSummary(findings);

  if (args.bundle) {
    const decisions = runId ? readDecisions(cwd, runId) : [];
    const bundle = buildDoctorBundle({
      summary,
      plugin,
      node,
      nvm,
      gitnexus,
      project,
      codexHooks,
      auth,
      oneMcp,
      openCodeMcp,
      pluginRoot,
      sessionDiagnostics,
      overrides,
      findings,
      runId,
      runDiagnostic,
      decisions,
    });
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return;
  }

  const version = project.state && typeof project.state.version === 'string' ? project.state.version : null;
  // Same redaction as `--bundle`. This stdout is not the private half of the
  // pair: the traffic-one-doctor skill instructs the agent to PARSE it, so
  // whatever it prints lands in model context and in the host transcript on
  // disk. Before this, plain `doctor` printed `probes.project.state.apiKey`,
  // `localPreferences.personalAccessToken` and the full
  // `projectContext.originalPrompt` verbatim — every category `--bundle` goes
  // to the trouble of removing.
  process.stdout.write(`${JSON.stringify({
    summary,
    findings,
    plugin,
    probes: {
      node,
      nvm,
      gitnexus,
      project: redactProjectProbe(project),
      codexHooks,
      auth,
      oneMcp,
      openCodeMcp,
      sessionDiagnostics,
      pluginRoot,
      runDiagnostic,
      // No redaction pass: every field is a count, a status word, a check id,
      // a token id or an ISO timestamp minted by this runtime. The one string
      // an operator supplied is a gate id, which the findings already print.
      overrides,
    },
    version,
  }, null, 2)}\n`);

  // The operator-facing render goes to STDERR, not stdout: stdout stays pure
  // JSON (what the traffic-one-doctor skill/an agent parses), while a human
  // running `doctor --run <id>` directly at a terminal still gets the
  // "why is this stuck" answer legibly, without needing to pipe through jq.
  if (runDiagnostic) {
    process.stderr.write(`\n${formatRunDiagnosticReport(runDiagnostic)}\n`);
  }
}

if (require.main === module) {
  void main().catch(() => { process.exitCode = 1; });
}
