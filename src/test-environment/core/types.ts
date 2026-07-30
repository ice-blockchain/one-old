// src/test-environment/core/types.ts
// Shared types for the Traffic One multi-host test environment. This is a
// MAINTAINER tool: it is never compiled into dist (see tsconfig.build.json
// exclude) and never shipped. It is run via `tsx src/test-environment/run.ts`.

import type { ArchitectureInputV1 } from '../../shared/architecture-contract';
import type { HostModelObservation } from '../../shared/host/capabilities';

export type HostId = 'claude' | 'codex' | 'cursor' | 'opencode' | 'copilot' | 'windsurf' | 'kilo';
export type VerdictHost = HostId | 'none';

export type Category =
  | 'new-project'
  | 'project-lifecycle'
  | 'existing-project'
  | 'feature-auth'
  | 'feature-onboarding'
  | 'run-sim';

// pure-node  → fully deterministic, no host CLI, reuses src/ functions directly.
// host-e2e   → drives a real host CLI headlessly against a seeded temp project.
// run-sim    → pure-node too, but drives a FULL post-onboarding run: scripted role
//              writes go through the real plan-write gate and the real runtime
//              reacts, so the composition of the chain is exercised without an LLM.
export type RunLayer = 'host-e2e' | 'pure-node' | 'run-sim';

// How a host-e2e run proves that it is exercising the freshly built dist.
// `host-install` runs installArgs against a content-addressed marketplace before
// the suite; `session-plugin-dir` loads the selected dist directly for the host
// process; `case-wrapper` installs it into each isolated case environment;
// `manual-live-pointer` is reserved for Cursor, whose editor-only `/add-plugin`
// flow cannot be automated and therefore needs an on-disk runtime fingerprint.
export type CurrentDistProof = 'host-install' | 'session-plugin-dir' | 'case-wrapper' | 'manual-live-pointer';

// Some headless host entrypoints cannot expose the interactive host's subagent
// primitive. That is a host capability gap, not evidence that a loaded plugin
// failed. Runtime fingerprint/materialization assertions independently prove
// that the plugin loaded before this exemption can apply.
export type HeadlessSubagentSupport = 'supported' | 'unsupported' | 'unknown';

export type ProjectMode = 'new-project' | 'existing-codebase';

export type FixtureKind =
  | 'empty'
  | 'empty-git'
  | 'react-vite'
  | 'existing-react-vite'
  | 'existing-node-api'
  | 'existing-go-api';

// The onboarding selection a case declares. preseed.ts turns this into an
// AUTHENTIC .one.json + preferences.json by calling the real source writers,
// so "onboarding is pre-completed" without ever popping the wizard.
export interface PreSeed {
  mode: ProjectMode;
  // Optional deterministic run identity for live enforcement probes. Ordinary
  // business cases leave this unset and let the runtime mint the run.
  currentRunId?: string;
  stack?: string; // e.g. 'default' | 'custom-frontend' | 'minimal'
  frontend?: string; // 'react-vite' | 'none' | 'vue' | ...
  backend?: string; // 'supabase' | 'node' | 'none' | ...
  mobile?: { enabled: boolean; framework: 'none' | 'ionic-capacitor' | 'react-native-expo' };
  performance?: 'low' | 'balanced' | 'high';
  team?: { mode?: 'main-agent' | 'subagents'; approved?: boolean; overrides?: Record<string, string> };
  openCode?: boolean; // enabled flag
  openCodeInstalled?: boolean; // stamp toolchain.opencode.installedVersion (delegation needs BOTH)
  codeGraphProvider?: 'gitnexus' | 'graphify'; // machine-wide
  projectContext?: { originalPrompt: string; summary?: string };
}

export interface ScriptedAnswer {
  step: string;
  value: unknown;
}

// What a `layer: 'run-sim'` case declares. The case supplies SEMANTICS (the
// brief, the semantic architecture input, per-module content overrides); the
// compiled contract supplies every PATH. Nothing here may name a compiled
// output — those are born inside the PLAN_READY transaction, so hardcoding one
// would make every compiler change an N-case edit.
export interface RunSimSpec {
  // The user-facing brief this shape simulates. Also seeds projectContext.
  brief: string;
  // Semantic routes/modules only — runtime owns roots, roles, outputs, hashes.
  architecture: ArchitectureInputV1;
  // Optional overrides for the architect's project-memory bodies. Anything not
  // named here gets a generated body that satisfies missingProjectMemoryBaseline.
  memory?: Record<string, string>;
  // Optional `.traffic-one/plan.md` body (generated when absent).
  plan?: string;
  // How QA evidence is produced. Cross-checked against the PUBLISHED
  // contract.browserRequired so a shape can never silently take the cheap path.
  qa: QaExpectation;
}

export interface QaExpectation {
  mode: 'stack' | 'browser';
  // Pins each required check's status. `stackReportStatus` returns `passed`
  // whenever nothing FAILED, so an all-`not-applicable` report would otherwise
  // read as a pass.
  expectChecks?: Record<string, 'passed' | 'not-applicable'>;
}

export interface AssertionSpec {
  id: string;
  params?: Record<string, unknown>;
}

export interface Case {
  id: string;
  category: Category;
  layer: RunLayer;
  hostFilter?: HostId[]; // restrict to a subset of enabled hosts; default all
  fixture: FixtureKind;
  preSeed: PreSeed;
  // pure-node onboarding-flow simulation: scripted answers fed to applyAnswer().
  scriptedAnswers?: ScriptedAnswer[];
  // Required when layer === 'run-sim': the shape this simulated run builds.
  runSim?: RunSimSpec;
  prompt?: string; // host-e2e: inline build/edit prompt
  promptFile?: string; // host-e2e: alt, path relative to the case file's dir
  phase2Prompt?: string; // host-e2e lifecycle: a follow-up edit in the same project
  assertions: AssertionSpec[];
  notes?: string;
}

// Per-host command template. Everything a driver needs is data here, so the
// maintainer can fix a flag without touching code. Tokens substituted at run
// time: {PROMPT} {PROMPT_FILE} {CWD} {MODEL} {OUTPUT_FORMAT} {DIST}; install
// commands may additionally use {MARKETPLACE_ROOT} and {MARKETPLACE}.
export interface HostCommandConfig {
  bin: string; // 'claude' | 'codex' | 'cursor-agent'
  promptVia: 'arg' | 'stdin' | 'file';
  runArgs: string[]; // DEFAULTS-TO-VERIFY per host
  outputFormat?: string;
  probeArgs?: string[]; // presence probe; default ['--version']
  installArgs?: string[][]; // idempotent install/update commands, run in order
  // Required for every host selected for E2E. Missing/invalid proof is a
  // release-gate failure rather than an implicit best-effort skip.
  currentDistProof?: CurrentDistProof;
  headlessSubagents?: HeadlessSubagentSupport;
  defaultModelByTier?: Partial<Record<'highest' | 'balanced' | 'cheapest', string>>;
  // Fixed model for harness runs, bypassing tier resolution. Use when the
  // plugin's model-tiers table may be stale for this host (e.g. 'auto' for
  // Cursor) so e2e tests plugin BEHAVIOR, not a specific model slug.
  testModel?: string;
  // Test-only, complete tier catalog written to the case-local One MCP sidecar.
  // This never changes the production registry. A live host preflight must
  // prove every slug before the case may invoke the CLI.
  testModelByTier?: Readonly<Record<'highest' | 'balanced' | 'cheapest', string>>;
  // Populated only by a live harness preflight. Cases report this as an
  // environment block and do not invoke the host; strict mode remains non-green.
  e2eBlockedReason?: string;
  // Per-run host environment owned by the harness. Codex uses this only for
  // its disposable CODEX_HOME; it is never read from release/plugin config.
  e2eEnv?: NodeJS.ProcessEnv;
  // Some desktop-only hosts have deterministic adapter/onboarding coverage but
  // no supported unattended CLI entrypoint. Keep them in the seven-host matrix
  // while making an explicit E2E request skip cleanly instead of inventing flags.
  e2eSupported?: boolean;
  verified?: boolean; // true once a maintainer has confirmed the flags work
}

export interface RootTestConfig {
  enabledHosts: HostId[];
  enabledCategories: Category[];
  includeHostE2E: boolean; // false = fast deterministic default (pure-node only)
  build: { refreshDist: boolean; updateHosts: boolean };
  auth: 'off' | 'on';
  verdictHost: VerdictHost;
  concurrency: number;
  defaultTimeoutMs: number;
  // Parent dir holding one timestamped folder per run. MUST be outside the repo
  // (the authoring-root rule makes in-repo project writes no-op). Default
  // ~/traffic-one-test-runs. All runs are kept; clear them manually.
  runsRoot: string;
  isolateStateHome: boolean;
  strict: boolean; // SKIP/INCONCLUSIVE/UNSUPPORTED all block a certification claim
  dryRun: boolean;
  caseFilter?: string[]; // explicit case ids
  // External evidence for hosts classified as contract+manual-e2e. The CLI
  // accepts only an absolute directory and reads <host>-manual-e2e.json.
  manualCertDir?: string;
  hosts: Record<HostId, HostCommandConfig>;
  envOverrides: Record<string, string>;
}

export type AssertionStatus = 'PASS' | 'FAIL' | 'SKIP' | 'INCONCLUSIVE' | 'UNSUPPORTED';

export interface AssertionResult {
  id: string;
  title: string;
  status: AssertionStatus;
  detail: string;
  expected?: unknown;
  actual?: unknown;
}

export type HostRunStatus =
  | 'COMPLETED'
  | 'TIMEOUT'
  | 'ERROR'
  | 'BLOCKED_ENVIRONMENT'
  | 'SKIPPED'
  | 'NOT_RUN';

export type HostCapabilityEvidenceStatus =
  | 'OBSERVED'
  | 'NO_RUN'
  | 'NOT_RUN'
  | 'MISSING'
  | 'INVALID';

/**
 * Reporting projection of the per-run HostCapabilityV1 sidecar. Contract
 * fields are expectations from the static registry; only the observed fields
 * are evidence about the host version that actually ran.
 */
export interface HostCapabilityReport {
  evidenceStatus: HostCapabilityEvidenceStatus;
  runId: string | null;
  contractExpectedPrevention: 'pre-tool' | 'completion-only';
  contractPrimaryBlockingPoint: string;
  contractRequiredBlockingPoints: string[];
  modelObservation: HostModelObservation;
  authoritativeModelObserved: boolean;
  observedPrevention: 'pre-tool' | 'completion-only' | 'unknown';
  observedBlockingPoint: string | null;
  observedEnforcementPoints: string[];
  observedDeniedEnforcementPoints: string[];
  primaryBlockingPointObserved: boolean;
  primaryBlockingPointDenied: boolean;
  requiredBlockingPointsObserved: boolean;
  capabilityHash: string | null;
  evidenceHash: string | null;
  hostVersion: string | null;
  preventionCertified: boolean;
  detail: string;
}

export interface HostRunResult {
  status: HostRunStatus;
  exitCode: number | null;
  durationMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  command?: string;
  skippedReason?: string;
  hostCapability?: HostCapabilityReport;
}

export interface CaseRunResult {
  caseId: string;
  category: Category;
  layer: RunLayer;
  host: HostId | 'pure-node';
  runFolder: string;
  hostResult: HostRunResult;
  assertions: AssertionResult[];
  startedAt: string;
  finishedAt: string;
}

export interface HostRunContext {
  cwd: string;
  prompt: string;
  promptFile?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  model?: string;
  distRoot: string;
  runFolder: string;
}

export interface HostDriver {
  id: HostId;
  isAvailable(cfg: HostCommandConfig, env?: NodeJS.ProcessEnv): boolean;
  run(cfg: HostCommandConfig, ctx: HostRunContext): Promise<HostRunResult>;
}

export interface AssertionContext {
  cwd: string; // temp project root
  // The per-case folder that OWNS `cwd` (<runDir>/projects/<caseId>__<target>).
  // Holds isolated state, logs, and the run-sim transcript. Passing it explicitly
  // — rather than resolving `cwd/..` — is what makes `--reassert` work for
  // transcript-reading assertions.
  caseFolder: string;
  env: Record<string, string>; // per-case env (PREFS_PATH, XDG_STATE_HOME, ...)
  host: HostId | 'pure-node';
  testCase: Case;
  spec: AssertionSpec;
  hostResult: HostRunResult;
  hostConfig?: HostCommandConfig;
}

export interface Assertion {
  id: string;
  title: string;
  appliesTo(c: Case): boolean;
  run(ctx: AssertionContext): AssertionResult | Promise<AssertionResult>;
}
