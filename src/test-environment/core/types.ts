// src/test-environment/core/types.ts
// Shared types for the Traffic One multi-host test environment. This is a
// MAINTAINER tool: it is never compiled into dist (see tsconfig.build.json
// exclude) and never shipped. It is run via `tsx src/test-environment/run.ts`.

export type HostId = 'claude' | 'codex' | 'cursor';
export type VerdictHost = HostId | 'none';

export type Category =
  | 'new-project'
  | 'project-lifecycle'
  | 'existing-project'
  | 'feature-auth'
  | 'feature-onboarding';

// pure-node  → fully deterministic, no host CLI, reuses src/ functions directly.
// host-e2e   → drives a real host CLI headlessly against a seeded temp project.
export type RunLayer = 'host-e2e' | 'pure-node';

export type ProjectMode = 'new-project' | 'existing-codebase';

export type FixtureKind =
  | 'empty'
  | 'react-vite'
  | 'existing-react-vite'
  | 'existing-node-api';

// The onboarding selection a case declares. preseed.ts turns this into an
// AUTHENTIC .one.json + preferences.json by calling the real source writers,
// so "onboarding is pre-completed" without ever popping the wizard.
export interface PreSeed {
  mode: ProjectMode;
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
  prompt?: string; // host-e2e: inline build/edit prompt
  promptFile?: string; // host-e2e: alt, path relative to the case file's dir
  phase2Prompt?: string; // host-e2e lifecycle: a follow-up edit in the same project
  assertions: AssertionSpec[];
  notes?: string;
}

// Per-host command template. Everything a driver needs is data here, so the
// maintainer can fix a flag without touching code. Tokens substituted at run
// time: {PROMPT} {PROMPT_FILE} {CWD} {MODEL} {OUTPUT_FORMAT} {DIST}.
export interface HostCommandConfig {
  bin: string; // 'claude' | 'codex' | 'cursor-agent'
  promptVia: 'arg' | 'stdin' | 'file';
  runArgs: string[]; // DEFAULTS-TO-VERIFY per host
  outputFormat?: string;
  probeArgs?: string[]; // presence probe; default ['--version']
  installArgs?: string[][]; // idempotent install/update commands, run in order
  defaultModelByTier?: Partial<Record<'highest' | 'balanced' | 'cheapest', string>>;
  // Fixed model for harness runs, bypassing tier resolution. Use when the
  // plugin's model-tiers table may be stale for this host (e.g. 'auto' for
  // Cursor) so e2e tests plugin BEHAVIOR, not a specific model slug.
  testModel?: string;
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
  strict: boolean; // SKIP/INCONCLUSIVE count as failure
  dryRun: boolean;
  caseFilter?: string[]; // explicit case ids
  hosts: Record<HostId, HostCommandConfig>;
  envOverrides: Record<string, string>;
}

export type AssertionStatus = 'PASS' | 'FAIL' | 'SKIP' | 'INCONCLUSIVE';

export interface AssertionResult {
  id: string;
  title: string;
  status: AssertionStatus;
  detail: string;
  expected?: unknown;
  actual?: unknown;
}

export type HostRunStatus = 'COMPLETED' | 'TIMEOUT' | 'ERROR' | 'SKIPPED' | 'NOT_RUN';

export interface HostRunResult {
  status: HostRunStatus;
  exitCode: number | null;
  durationMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  command?: string;
  skippedReason?: string;
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
  isAvailable(cfg: HostCommandConfig): boolean;
  run(cfg: HostCommandConfig, ctx: HostRunContext): Promise<HostRunResult>;
}

export interface AssertionContext {
  cwd: string; // temp project root
  env: Record<string, string>; // per-case env (PREFS_PATH, XDG_STATE_HOME, ...)
  host: HostId | 'pure-node';
  testCase: Case;
  spec: AssertionSpec;
  hostResult: HostRunResult;
}

export interface Assertion {
  id: string;
  title: string;
  appliesTo(c: Case): boolean;
  run(ctx: AssertionContext): AssertionResult | Promise<AssertionResult>;
}
