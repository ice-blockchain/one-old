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
import {
  abandonAfterMs,
  childKeepAliveEnabled,
  pollAfterMs,
  RESUME_WAIT_MS,
  watchdogTickMs,
} from '../../config/opencode-timeouts';
import { planDelegationQueueRoles } from '../../shared/opencode-roles';
import {
  finalizePlanBatch,
  markPlanBatchRunningIfNeeded,
  mergeMissingQueueUnits,
  type PlanBatchResult,
} from '../../shared/opencode-plan-batch';
import {
  finalizeOpenCodeUnitsForBatch,
  hasRunningOpenCodeUnits,
  normalizeOpenCodeRole,
  persistBatchUnitsToStatus,
  readOpenCodeQueue,
  reconcileAllRunningUnits,
} from '../../shared/opencode-queue';
import { markOpenCodePlanBatchTerminal, markOpenCodePlanRoleCompleted } from '../../shared/opencode-roles';

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
  units?: Array<{ id?: string; role: string; task: string; action: string; status?: string; touched: string[]; error?: string | null }>;
}

export interface DelegateArgs {
  role: string;
  task: string;
  runId: string;
  allowedFiles?: string;
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

function killChildGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
}

function childAlive(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
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
  const allowedFiles = (a.allowedFiles || '').trim();
  if (!role) return { ok: false, action: 'skipped', error: 'role is required' };
  if (!task.trim()) return { ok: false, action: 'skipped', error: 'task is required' };
  if (!runId) return { ok: false, action: 'skipped', error: 'runId is required' };
  if (!allowedFiles) return { ok: false, action: 'skipped', error: 'allowedFiles is required' };

  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmcp-'));
    const taskFile = path.join(dir, 'task.md');
    fs.writeFileSync(taskFile, task, 'utf8');
    const args = ['--run-id', runId, '--role', role, '--task-file', taskFile, '--allowed-files', allowedFiles];
    if ((a.model || '').trim()) args.push('--model', (a.model as string).trim());
    return await runRunner(args, projectRoot);
  } catch (err) {
    return { ok: false, action: 'failed', error: `delegate setup failed: ${(err as Error).message}` };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// Distinct normalized roles in the plan's delegation queue, in first-seen order
// (empty on any read/parse problem → single-runner fallback). Single source lives in
// shared/opencode-roles so the spawn gate (roleHasQueuedUnits) reads the SAME queue
// without depending on this runner module; aliased here for the MCP surface/tests and
// used by startFromPlan above.
export const planQueueRoles = planDelegationQueueRoles;

function synthesizeFailedUnitsForRole(
  projectRoot: string,
  runId: string,
  role: string,
  error: string,
): NonNullable<RunnerResult['units']> {
  const queue = readOpenCodeQueue(projectRoot, runId);
  if (!queue) return [];
  const normalized = normalizeOpenCodeRole(role);
  return queue.units
    .filter((u) => u.role === normalized)
    .map((u) => ({
      id: u.id,
      role: u.role,
      task: u.task,
      action: 'failed',
      status: 'failed',
      touched: [] as string[],
      error,
    }));
}

function finalizePlanBatchResult(projectRoot: string, runId: string, merged: RunnerResult): RunnerResult {
  return finalizePlanBatch(projectRoot, runId, merged as PlanBatchResult) as RunnerResult;
}

// Run the plan's queued roles as ONE runner each, SEQUENTIALLY — never concurrently.
async function startFromPlan(projectRoot: string, runId: string, model: string | undefined, onChild?: (child: ReturnType<typeof spawn>) => void): Promise<RunnerResult> {
  markPlanBatchRunningIfNeeded(projectRoot, runId);
  const modelArgs = (model || '').trim() ? ['--model', (model as string).trim()] : [];
  const roles = planQueueRoles(projectRoot);
  if (roles.length <= 1) {
    const r = await runRunner(['--run-id', runId, '--from-plan', ...modelArgs], projectRoot, onChild);
    return finalizePlanBatchResult(projectRoot, runId, r);
  }
  const merged: RunnerResult = { total: 0, delegated: 0, units: [] };
  const errors: string[] = [];
  for (const role of roles) {
    const r = await runRunner(['--run-id', runId, '--from-plan', '--roles', role, ...modelArgs], projectRoot, onChild);
    if (Array.isArray(r.units) && r.units.length > 0) {
      (merged.units as NonNullable<RunnerResult['units']>).push(...r.units);
      merged.total = (merged.total || 0) + (typeof r.total === 'number' ? r.total : r.units.length);
      merged.delegated = (merged.delegated || 0) + (typeof r.delegated === 'number' ? r.delegated : r.units.filter((u) => u.action === 'delegated').length);
    } else {
      const error = r.error || 'runner produced no JSON result';
      const synthesized = synthesizeFailedUnitsForRole(projectRoot, runId, role, error);
      (merged.units as NonNullable<RunnerResult['units']>).push(...synthesized);
      merged.total = (merged.total || 0) + synthesized.length;
      errors.push(error);
    }
    if (r.error && Array.isArray(r.units) && r.units.length > 0) errors.push(r.error);
  }
  if (errors.length) merged.error = errors.join('; ');
  return finalizePlanBatchResult(projectRoot, runId, merged);
}

// The batch path: opencode-runner.cjs --run-id <id> --from-plan [--roles csv].
// Reads the architect's queue from <projectRoot>/.traffic-one/plan.md, processed
// one role per runner, sequentially. Best-effort.
export async function runDelegateFromPlan(a: FromPlanArgs): Promise<RunnerResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  if (!runId) return { ok: false, error: 'runId is required' };
  return startFromPlan(projectRoot, runId, a.model);
}

// ── Resumable (background) delegation ────────────────────────────────────────

export interface ResumableResult extends RunnerResult {
  running?: boolean;
  runId?: string;
  role?: string;
  message?: string;
  pollAfterMs?: number;
}

interface TrackedChild {
  child: ReturnType<typeof spawn>;
  startedAt: number;
}

interface BgRun {
  promise: Promise<RunnerResult>;
  status: 'running' | 'done';
  result?: RunnerResult;
  projectRoot: string;
  runId: string;
  batchKey: string;
  lastPolledAt: number;
  children: TrackedChild[];
  watchdog?: NodeJS.Timeout;
}

const PLAN_KEY = '__plan__';
const runs = new Map<string, BgRun>();

function runKey(projectRoot: string, runId: string, key: string): string {
  return `${projectRoot}\0${runId}\0${key}`;
}

function parseRunKey(key: string): { projectRoot: string; runId: string; batchKey: string } | null {
  const parts = key.split('\0');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { projectRoot: parts[0], runId: parts[1], batchKey: parts[2] };
}

function refreshChildKeepAlive(run: BgRun): void {
  if (!childKeepAliveEnabled()) return;
  const now = Date.now();
  let anyAlive = false;
  for (const tracked of run.children) {
    if (!childAlive(tracked.child)) continue;
    anyAlive = true;
    run.lastPolledAt = now;
  }
  if (anyAlive) run.lastPolledAt = now;
}

function abandonPlanBatch(run: BgRun, abandonError: string): void {
  for (const tracked of run.children) killChildGroup(tracked.child);
  const merged: RunnerResult = { ok: false, action: 'abandoned', error: abandonError, units: [] };
  mergeMissingQueueUnits(run.projectRoot, run.runId, merged);
  finalizeOpenCodeUnitsForBatch(run.projectRoot, run.runId, abandonError);
  if (hasRunningOpenCodeUnits(run.projectRoot, run.runId)) {
    reconcileAllRunningUnits(run.projectRoot, run.runId, abandonError);
  }
  persistBatchUnitsToStatus(run.projectRoot, run.runId, merged.units || []);
  markOpenCodePlanBatchTerminal(run.projectRoot, run.runId, 'abandoned', abandonError);
  for (const role of planQueueRoles(run.projectRoot)) {
    markOpenCodePlanRoleCompleted(run.projectRoot, run.runId, role);
  }
  merged.total = merged.units?.length ?? 0;
  merged.delegated = 0;
  run.result = merged;
}

function getOrStart(key: string, meta: { projectRoot: string; runId: string; batchKey: string }, start: (onChild: (child: ReturnType<typeof spawn>) => void) => Promise<RunnerResult>): BgRun {
  const existing = runs.get(key);
  if (existing) { existing.lastPolledAt = Date.now(); return existing; }
  const run: BgRun = {
    promise: Promise.resolve({} as RunnerResult),
    status: 'running',
    projectRoot: meta.projectRoot,
    runId: meta.runId,
    batchKey: meta.batchKey,
    lastPolledAt: Date.now(),
    children: [],
  };
  run.promise = start((child) => { run.children.push({ child, startedAt: Date.now() }); });
  const settle = (res: RunnerResult): void => {
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
    refreshChildKeepAlive(run);
    if (Date.now() - run.lastPolledAt <= abandonAfterMs()) return;
    const abandonError = `delegation cancelled: the orchestrator stopped polling for ${Math.round(abandonAfterMs() / 60000)}+ minutes (it moved on); the worker was killed BEFORE applying any diff`;
    run.status = 'done';
    clearInterval(run.watchdog as NodeJS.Timeout);
    if (run.batchKey === PLAN_KEY) {
      abandonPlanBatch(run, abandonError);
    } else {
      for (const tracked of run.children) killChildGroup(tracked.child);
      run.result = { ok: false, action: 'abandoned', error: abandonError };
    }
  }, watchdogTickMs());
  run.watchdog.unref?.();
  runs.set(key, run);
  return run;
}

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
    pollAfterMs: pollAfterMs(),
    message: `OpenCode is still running for ${role} (run ${runId}). Call ${tool} again with the SAME arguments to keep waiting; it returns ok:true (delegated → review) or ok:false (declined → fall back) once finished.`,
  };
}

export async function delegateResumable(a: DelegateArgs, waitMs = RESUME_WAIT_MS): Promise<ResumableResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const role = (a.role || '').trim();
  const runId = (a.runId || '').trim();
  const allowedFiles = (a.allowedFiles || '').trim();
  if (!role) return { ok: false, action: 'skipped', error: 'role is required' };
  if (!runId) return { ok: false, action: 'skipped', error: 'runId is required' };
  const key = runKey(projectRoot, runId, role);
  if (!runs.has(key) && !(a.task || '').trim()) return { ok: false, action: 'skipped', error: 'task is required to start a delegation' };
  if (!runs.has(key) && !allowedFiles) return { ok: false, action: 'skipped', error: 'allowedFiles is required to start a delegation' };

  const run = getOrStart(key, { projectRoot, runId, batchKey: role }, (onChild) => {
    let dir: string | null = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmcp-'));
      const taskFile = path.join(dir, 'task.md');
      fs.writeFileSync(taskFile, a.task || '', 'utf8');
      const args = ['--run-id', runId, '--role', role, '--task-file', taskFile, '--allowed-files', allowedFiles];
      if ((a.model || '').trim()) args.push('--model', (a.model as string).trim());
      const p = runRunner(args, projectRoot, onChild);
      const cleanup = (): void => { try { fs.rmSync(dir as string, { recursive: true, force: true }); } catch { /* best-effort */ } };
      p.then(cleanup, cleanup);
      return p;
    } catch (err) {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
      return Promise.resolve({ ok: false, action: 'failed', error: `delegate setup failed: ${(err as Error).message}` } as RunnerResult);
    }
  });

  const res = await waitBounded(run, waitMs);
  return res ?? stillRunning(runId, role, 'opencode_delegate');
}

export async function delegateFromPlanResumable(a: FromPlanArgs, waitMs = RESUME_WAIT_MS): Promise<ResumableResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  if (!runId) return { ok: false, error: 'runId is required' };
  const key = runKey(projectRoot, runId, PLAN_KEY);
  const run = getOrStart(key, { projectRoot, runId, batchKey: PLAN_KEY }, (onChild) => startFromPlan(projectRoot, runId, a.model, onChild));
  const res = await waitBounded(run, waitMs);
  return res ?? stillRunning(runId, PLAN_KEY, 'opencode_delegate_from_plan');
}

export interface DelegateStatus { status: 'running' | 'done' | 'unknown'; runId: string; role: string; result?: RunnerResult; }

export function delegateStatus(a: { projectRoot?: string; runId?: string; role?: string }): DelegateStatus {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  const role = (a.role || '').trim() || PLAN_KEY;
  const run = runs.get(runKey(projectRoot, runId, role));
  if (!run) return { status: 'unknown', runId, role };
  return run.status === 'done' ? { status: 'done', runId, role, result: run.result } : { status: 'running', runId, role };
}

// Exported for tests that need to inspect run-key parsing.
export const _parseRunKey = parseRunKey;
