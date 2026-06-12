// src/runners/opencode-mcp/delegate.ts
// The bridge from MCP tool calls to the shipped opencode-runner.cjs. The MCP
// server is host-launched and therefore runs OUTSIDE the per-tool-call sandbox,
// so any child IT spawns inherits full network + git — which is exactly why a
// delegation that fails from the orchestrator's own shell (Codex: no network,
// .git locked) succeeds here. We spawn the runner rather than re-implementing
// delegation so worktree isolation, digests, and the attempt markers the spawn
// gate depends on all stay in ONE place (runners/opencode/index.ts).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OPENCODE_RUNNER_OVERRIDE_ENV } from '../../config/opencode-mcp';

// The runner prints one JSON line. delegate() → {ok, action, digest, touched,
// error, model}; delegateFromPlan() → {total, delegated, units}. We keep the
// shape permissive and pass it straight through to the MCP tool result.
export interface RunnerResult {
  ok?: boolean;
  action?: string;
  digest?: string | null;
  touched?: string[];
  error?: string | null;
  model?: string;
  total?: number;
  delegated?: number;
  units?: Array<{ role: string; task: string; action: string; touched: string[] }>;
}

export interface DelegateArgs {
  role: string;
  task: string;
  runId: string;
  projectRoot?: string;
  model?: string;
}

export interface FromPlanArgs {
  runId: string;
  projectRoot?: string;
  model?: string;
}

// At runtime the compiled server lives at dist/scripts/runners/opencode-mcp/
// index.js and the runner shim at dist/scripts/opencode-runner.cjs — two levels
// up. Resolving from __dirname keeps the server independent of how the host
// launched it; the env override lets tests point at a stub runner.
export function resolveRunnerPath(): string {
  const override = (process.env[OPENCODE_RUNNER_OVERRIDE_ENV] || '').trim();
  if (override) return override;
  return path.resolve(__dirname, '..', '..', 'opencode-runner.cjs');
}

// Take the LAST line that parses as a JSON object — the runner emits exactly one
// such line, but this tolerates any stray stdout above it.
export function parseRunnerResult(stdout: string, stderr: string): RunnerResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RunnerResult;
    } catch {
      // not JSON — keep scanning upward
    }
  }
  const tail = stderr.trim().slice(-300);
  return { ok: false, action: 'failed', error: `runner produced no JSON result${tail ? `: ${tail}` : ''}` };
}

// Spawn the runner async (never spawnSync — a single delegation can take minutes
// and must not block the stdio read loop or other in-flight tool calls). No
// wall-clock ceiling here: the runner self-bounds each opencode attempt (8 min)
// and always terminates, and a --from-plan batch's duration scales with the
// queue, so a fixed wrapper timeout would wrongly kill large batches.
function runRunner(runnerArgs: string[], projectRoot: string, onChild?: (child: ReturnType<typeof spawn>) => void): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [resolveRunnerPath(), ...runnerArgs], {
      cwd: projectRoot,
      // The runner uses process.cwd() as the project root and pins PWD to its own
      // throwaway worktree internally; setting PWD=projectRoot here keeps its
      // top-level git ops unambiguous.
      env: { ...process.env, PWD: projectRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so an abandoned delegation can be killed as a GROUP —
      // SIGTERM to the runner alone would orphan the inner `opencode run` child.
      detached: true,
    });
    onChild?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      resolve({ ok: false, action: 'failed', error: `runner spawn failed: ${err.message}` });
    });
    child.on('close', () => { resolve(parseRunnerResult(stdout, stderr)); });
  });
}

// One bounded unit: opencode-runner.cjs --run-id <id> --role <r> --task-file <f>.
// The task is written to a throwaway temp file (not the project tree) so it never
// clobbers a concurrent call and leaves no artifact behind.
export async function runDelegate(a: DelegateArgs): Promise<RunnerResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const role = (a.role || '').trim();
  const task = a.task || '';
  const runId = (a.runId || '').trim();
  if (!role) return { ok: false, action: 'skipped', error: 'role is required' };
  if (!task.trim()) return { ok: false, action: 'skipped', error: 'task is required' };
  if (!runId) return { ok: false, action: 'skipped', error: 'runId is required' };

  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmcp-'));
    const taskFile = path.join(dir, 'task.md');
    fs.writeFileSync(taskFile, task, 'utf8');
    const args = ['--run-id', runId, '--role', role, '--task-file', taskFile];
    if ((a.model || '').trim()) args.push('--model', (a.model as string).trim());
    return await runRunner(args, projectRoot);
  } catch (err) {
    return { ok: false, action: 'failed', error: `delegate setup failed: ${(err as Error).message}` };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// Distinct normalized roles in the plan's delegation queue, in first-seen
// order. Empty on any read/parse problem (→ single-runner fallback).
export function planQueueRoles(projectRoot: string): string[] {
  let plan = '';
  try { plan = fs.readFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), 'utf8'); } catch { return []; }
  const start = plan.indexOf('opencode-delegate:start');
  const end = plan.indexOf('opencode-delegate:end');
  if (start < 0 || end < 0 || end < start) return [];
  const roles: string[] = [];
  for (const line of plan.slice(start, end).split('\n')) {
    const m = /^\s*-\s*role:\s*([a-z][a-z-]*)/i.exec(line);
    if (!m || !m[1]) continue;
    const role = m[1].toLowerCase().replace(/^senior-/, '');
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}

// Units within one role stay SEQUENTIAL (they share a digest file and often a
// package); different roles run as concurrent runner shards. Safe because the
// queue contract gives each unit exact, disjoint files; each shard applies only
// its own clean diff (`git apply` touches the working tree, never the index, so
// shards don't contend on .git locks). Capped to keep machine load sane.
const MAX_PLAN_SHARDS = 3;

function startFromPlan(projectRoot: string, runId: string, model: string | undefined, onChild?: (child: ReturnType<typeof spawn>) => void): Promise<RunnerResult> {
  const modelArgs = (model || '').trim() ? ['--model', (model as string).trim()] : [];
  const roles = planQueueRoles(projectRoot);
  if (roles.length <= 1) {
    return runRunner(['--run-id', runId, '--from-plan', ...modelArgs], projectRoot, onChild);
  }
  const shardCount = Math.min(MAX_PLAN_SHARDS, roles.length);
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  roles.forEach((role, i) => { (shards[i % shardCount] as string[]).push(role); });
  return Promise.all(shards.map((shardRoles) =>
    runRunner(['--run-id', runId, '--from-plan', '--roles', shardRoles.join(','), ...modelArgs], projectRoot, onChild),
  )).then((results) => {
    const merged: RunnerResult = { total: 0, delegated: 0, units: [] };
    const errors: string[] = [];
    for (const r of results) {
      merged.total = (merged.total || 0) + (typeof r.total === 'number' ? r.total : 0);
      merged.delegated = (merged.delegated || 0) + (typeof r.delegated === 'number' ? r.delegated : 0);
      if (Array.isArray(r.units)) (merged.units as NonNullable<RunnerResult['units']>).push(...r.units);
      if (r.error) errors.push(r.error);
    }
    if (errors.length) merged.error = errors.join('; ');
    return merged;
  });
}

// The batch path: opencode-runner.cjs --run-id <id> --from-plan [--roles csv].
// Reads the architect's queue from <projectRoot>/.traffic-one/plan.md, sharded
// by role across concurrent runners. Best-effort.
export async function runDelegateFromPlan(a: FromPlanArgs): Promise<RunnerResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  if (!runId) return { ok: false, error: 'runId is required' };
  return startFromPlan(projectRoot, runId, a.model);
}

// ── Resumable (background) delegation ────────────────────────────────────────
// Codex enforces a hard ~120s per-tool-call timeout (not configurable). A
// synchronous delegate that awaits the whole multi-minute opencode run blows past
// it. So the runner is launched in the BACKGROUND, decoupled from any single tool
// call: the first call starts it and waits a bounded window; if it hasn't finished
// we return {running:true} and the caller RE-INVOKES the same tool to keep
// waiting. The background run proceeds regardless of tool-call lifetimes, and the
// result is cached so a re-call after completion is idempotent. The MCP server is
// long-lived (stdio), so the registry survives across calls within a session.

export interface ResumableResult extends RunnerResult {
  running?: boolean;
  runId?: string;
  role?: string;
  message?: string;
}

interface BgRun {
  promise: Promise<RunnerResult>;
  status: 'running' | 'done';
  result?: RunnerResult;
  // Poll-liveness cancellation: the parent's re-polls are the keep-alive. When
  // it stops polling (gave up → paid fallback) the watchdog kills the runner
  // BEFORE it can apply a now-stale diff over the fallback's work.
  lastPolledAt: number;
  children: Array<ReturnType<typeof spawn>>;
  watchdog?: NodeJS.Timeout;
}

// Stay comfortably under the host tool-call timeout (Codex ~120s).
const RESUME_WAIT_MS = 90_000;
// Cancel a background delegation when the orchestrator hasn't polled for this
// long (= it moved on; the resumable protocol re-polls every ~90s, so 6 minutes
// is ~4 missed polls). Env-tunable for tests.
function abandonAfterMs(): number {
  const v = Number(process.env.T1_OC_ABANDON_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 1000;
}
function watchdogTickMs(): number {
  const v = Number(process.env.T1_OC_WATCHDOG_TICK_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}
const PLAN_KEY = '__plan__';
const runs = new Map<string, BgRun>();

function runKey(projectRoot: string, runId: string, key: string): string {
  return `${projectRoot} ${runId} ${key}`;
}

function getOrStart(key: string, start: (onChild: (child: ReturnType<typeof spawn>) => void) => Promise<RunnerResult>): BgRun {
  const existing = runs.get(key);
  if (existing) { existing.lastPolledAt = Date.now(); return existing; }
  const run: BgRun = { promise: Promise.resolve({} as RunnerResult), status: 'running', lastPolledAt: Date.now(), children: [] };
  run.promise = start((child) => { run.children.push(child); });
  const settle = (res: RunnerResult): void => {
    // An abandoned run already carries its verdict — the kill makes the child
    // close with partial output, which must not overwrite it.
    if (run.status === 'done') return;
    run.status = 'done';
    run.result = res;
    if (run.watchdog) clearInterval(run.watchdog);
  };
  run.promise.then(
    (res) => settle(res),
    (err) => settle({ ok: false, action: 'failed', error: `runner crashed: ${(err as Error)?.message || String(err)}` }),
  );
  run.watchdog = setInterval(() => {
    if (run.status !== 'running') { if (run.watchdog) clearInterval(run.watchdog); return; }
    if (Date.now() - run.lastPolledAt <= abandonAfterMs()) return;
    run.status = 'done';
    run.result = {
      ok: false,
      action: 'abandoned',
      error: `delegation cancelled: the orchestrator stopped polling for ${Math.round(abandonAfterMs() / 60000)}+ minutes (it moved on); the worker was killed BEFORE applying any diff`,
    };
    clearInterval(run.watchdog as NodeJS.Timeout);
    for (const child of run.children) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
  }, watchdogTickMs());
  run.watchdog.unref?.();
  runs.set(key, run);
  return run;
}

// Resolve with the result when the run finishes, or null when the bounded window
// elapses first (still running).
function waitBounded(run: BgRun, waitMs: number): Promise<RunnerResult | null> {
  if (run.status === 'done') return Promise.resolve(run.result ?? { ok: false, action: 'failed', error: 'no result' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: RunnerResult | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), waitMs);
    run.promise.then((res) => finish(res), () => finish(run.result ?? { ok: false, action: 'failed', error: 'runner crashed' }));
  });
}

function stillRunning(runId: string, role: string, tool: string): ResumableResult {
  return {
    running: true, runId, role, action: 'running', error: null,
    message: `OpenCode is still running for ${role} (run ${runId}). Call ${tool} again with the SAME arguments to keep waiting; it returns ok:true (delegated → review) or ok:false (declined → fall back) once finished.`,
  };
}

// Resumable single-unit delegation. First call starts the background run; each
// call waits up to waitMs then returns the result or {running:true}.
export async function delegateResumable(a: DelegateArgs, waitMs = RESUME_WAIT_MS): Promise<ResumableResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const role = (a.role || '').trim();
  const runId = (a.runId || '').trim();
  if (!role) return { ok: false, action: 'skipped', error: 'role is required' };
  if (!runId) return { ok: false, action: 'skipped', error: 'runId is required' };
  const key = runKey(projectRoot, runId, role);
  if (!runs.has(key) && !(a.task || '').trim()) return { ok: false, action: 'skipped', error: 'task is required to start a delegation' };

  const run = getOrStart(key, (onChild) => {
    let dir: string | null = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmcp-'));
      const taskFile = path.join(dir, 'task.md');
      fs.writeFileSync(taskFile, a.task || '', 'utf8');
      const args = ['--run-id', runId, '--role', role, '--task-file', taskFile];
      if ((a.model || '').trim()) args.push('--model', (a.model as string).trim());
      const p = runRunner(args, projectRoot, onChild);
      const cleanup = (): void => { try { fs.rmSync(dir as string, { recursive: true, force: true }); } catch { /* best-effort */ } };
      p.then(cleanup, cleanup); // task file must outlive the run, unlike the sync path
      return p;
    } catch (err) {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
      return Promise.resolve({ ok: false, action: 'failed', error: `delegate setup failed: ${(err as Error).message}` } as RunnerResult);
    }
  });

  const res = await waitBounded(run, waitMs);
  return res ?? stillRunning(runId, role, 'opencode_delegate');
}

// Resumable batch delegation (--from-plan).
export async function delegateFromPlanResumable(a: FromPlanArgs, waitMs = RESUME_WAIT_MS): Promise<ResumableResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  if (!runId) return { ok: false, error: 'runId is required' };
  const key = runKey(projectRoot, runId, PLAN_KEY);
  const run = getOrStart(key, (onChild) => startFromPlan(projectRoot, runId, a.model, onChild));
  const res = await waitBounded(run, waitMs);
  return res ?? stillRunning(runId, PLAN_KEY, 'opencode_delegate_from_plan');
}

export interface DelegateStatus { status: 'running' | 'done' | 'unknown'; runId: string; role: string; result?: RunnerResult; }

// Non-blocking status of a (runId, role) background run; role defaults to the
// plan-batch key.
export function delegateStatus(a: { projectRoot?: string; runId?: string; role?: string }): DelegateStatus {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  const role = (a.role || '').trim() || PLAN_KEY;
  const run = runs.get(runKey(projectRoot, runId, role));
  if (!run) return { status: 'unknown', runId, role };
  return run.status === 'done' ? { status: 'done', runId, role, result: run.result } : { status: 'running', runId, role };
}
