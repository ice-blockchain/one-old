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
  clampStatusWaitMs,
  pollAfterMs,
  RESUME_WAIT_MS,
  watchdogTickMs,
} from '../../config/opencode-timeouts';
import { openCodeApplyInProgress, planDelegationQueueRoles, touchPlanBatchHeartbeat } from '../../shared/opencode-roles';
import {
  finalizePlanBatch,
  markPlanBatchRunningIfNeeded,
  mergeMissingQueueUnits,
  type PlanBatchResult,
} from '../../shared/opencode-plan/batch';
import {
  finalizeOpenCodeUnitsForBatch,
  hasRunningOpenCodeUnits,
  normalizeOpenCodeRole,
  persistBatchUnitsToStatus,
  readOpenCodeQueue,
  reconcileAllRunningUnits,
  touchOpenCodeUnitRunning,
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
async function startFromPlan(projectRoot: string, runId: string, model: string | undefined, onChild?: (child: ReturnType<typeof spawn>) => void, isAborted?: () => boolean): Promise<RunnerResult> {
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
    // A cancel/abandon killed the current shard and finalized the batch on
    // disk; spawning the NEXT role's runner here would land diffs underneath
    // the paid fallback the orchestrator already moved to.
    if (isAborted?.()) break;
    touchPlanBatchHeartbeat(projectRoot, runId);
    const r = await runRunner(['--run-id', runId, '--from-plan', '--roles', role, ...modelArgs], projectRoot, onChild);
    if (isAborted?.()) break;
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
  reservedFiles?: string[];
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
  fingerprint: string;
  lastPolledAt: number;
  children: TrackedChild[];
  watchdog?: NodeJS.Timeout;
  /** Repo-relative files this delegation may write — surfaced while running so
   *  the orchestrator knows exactly what to leave alone in the meantime. */
  reservedFiles: string[];
  /** Set by cancel/abandon BEFORE killing: the sequential plan loop checks it
   *  between roles so a cancelled batch never spawns its NEXT role's runner
   *  (an adversarial review proved post-cancel shards kept landing diffs). */
  aborted?: boolean;
}

const PLAN_KEY = '__plan__';
// A finished run is kept so an identical re-call replays its terminal result
// instead of starting a second delegation (observed 1cu-cursor: seven
// delegations of one unit). Nothing evicts them otherwise, so cap the map.
const DONE_RUN_CAP = 64;
const runs = new Map<string, BgRun>();

function runKey(projectRoot: string, runId: string, key: string): string {
  return `${projectRoot}\0${runId}\0${key}`;
}

// Identity of the WORK a delegation was started with. The run key is only
// (projectRoot, runId, role), so without this a corrected re-call — new task or
// a fixed allowlist — silently replays the previous failure and the runner is
// never spawned (observed: a glob allowlist rejected, then two valid exact-file
// retries returned the byte-identical glob error). Allowlist entries are split,
// trimmed, de-duped and SORTED so the same set written comma- or newline-
// separated fingerprints equal and still replays rather than re-delegating.
function delegateFingerprint(task: unknown, allowedFiles: unknown, model: unknown): string {
  const files = String(allowedFiles ?? '')
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [
    String(task ?? '').trim(),
    [...new Set(files)].sort().join(','),
    String(model ?? '').trim(),
  ].join('\0');
}

// Drop the oldest FINISHED runs once the cache outgrows its cap. A `running`
// entry is never evicted: its promise, children, and watchdog are live.
function pruneFinishedRuns(): void {
  if (runs.size <= DONE_RUN_CAP) return;
  const done = [...runs.entries()]
    .filter(([, run]) => run.status === 'done')
    .sort((a, b) => a[1].lastPolledAt - b[1].lastPolledAt);
  for (const [key] of done.slice(0, runs.size - DONE_RUN_CAP)) runs.delete(key);
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
  run.aborted = true; // stop the sequential loop from spawning the NEXT role
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

function getOrStart(key: string, meta: { projectRoot: string; runId: string; batchKey: string; fingerprint: string; reservedFiles?: string[] }, start: (onChild: (child: ReturnType<typeof spawn>) => void, isAborted: () => boolean) => Promise<RunnerResult>): BgRun {
  const existing = runs.get(key);
  if (existing) { existing.lastPolledAt = Date.now(); return existing; }
  const run: BgRun = {
    promise: Promise.resolve({} as RunnerResult),
    status: 'running',
    projectRoot: meta.projectRoot,
    runId: meta.runId,
    batchKey: meta.batchKey,
    fingerprint: meta.fingerprint,
    lastPolledAt: Date.now(),
    children: [],
    reservedFiles: meta.reservedFiles ?? [],
  };
  run.promise = start((child) => { run.children.push({ child, startedAt: Date.now() }); }, () => run.aborted === true);
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
    // Disk-visible liveness: the batch heartbeat sidecar (never batch.json —
    // that would race the terminal writer) and the running units' updatedAt.
    // The runner itself is spawnSync end to end and cannot refresh either, so
    // this tick is what keeps a live batch distinguishable from a dead one.
    if (run.batchKey === PLAN_KEY) touchPlanBatchHeartbeat(run.projectRoot, run.runId);
    touchOpenCodeUnitRunning(run.projectRoot, run.runId);
    if (Date.now() - run.lastPolledAt <= abandonAfterMs()) return;
    // Never kill mid-apply: defer the abandon while the runner's apply-back
    // latch is live (pid-verified) — the next tick re-checks. The latch's own
    // hard cap bounds how long a hung runner can defer this.
    if (openCodeApplyInProgress(run.projectRoot, run.runId)) return;
    const abandonError = `delegation cancelled: the orchestrator stopped polling for ${Math.round(abandonAfterMs() / 60000)}+ minutes (it moved on); the worker was killed and no FURTHER diff will apply from it. If a unit had already completed its apply-and-verify, that diff remains in the tree — check the role digest and git status before the paid fallback`;
    run.status = 'done';
    clearInterval(run.watchdog as NodeJS.Timeout);
    if (run.batchKey === PLAN_KEY) {
      abandonPlanBatch(run, abandonError);
    } else {
      run.aborted = true;
      for (const tracked of run.children) killChildGroup(tracked.child);
      run.result = { ok: false, action: 'abandoned', error: abandonError };
    }
  }, watchdogTickMs());
  run.watchdog.unref?.();
  runs.set(key, run);
  pruneFinishedRuns();
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

function stillRunning(run: BgRun, role: string, tool: string): ResumableResult {
  const reserved = run.reservedFiles.length
    ? ` Files reserved by this delegation (leave them alone meanwhile): ${run.reservedFiles.join(', ')}.`
    : '';
  const idArgs = run.batchKey === PLAN_KEY ? '{runId' : '{runId, role';
  return {
    running: true, runId: run.runId, role, action: 'running', error: null,
    pollAfterMs: pollAfterMs(),
    reservedFiles: run.reservedFiles,
    message: `OpenCode is still running for ${role} (run ${run.runId}). The worker keeps itself alive — your calls are NOT its keep-alive, so do useful work now (transcribe digests, prepare fix-cycle context, update the ledger) instead of re-calling in a tight loop. To wait long in ONE turn, call opencode_status with ${idArgs}, waitMs: 90000}; it returns the terminal result the moment the run finishes.${reserved} To abandon this delegation and use the paid fallback, call opencode_status with ${idArgs}, cancel: true} — an explicit cancel, never just silence. Re-calling ${tool} with the SAME arguments also keeps waiting (ok:true → review; ok:false → fall back).`,
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
  const fingerprint = delegateFingerprint(a.task, allowedFiles, a.model);
  // A FINISHED run whose work no longer matches this call is stale: the caller
  // corrected the task or the allowlist and is asking for a real re-delegation.
  // Evicting here (before the guards below re-assert task/allowedFiles) is what
  // makes the retry actually spawn the runner. Only `done` runs are dropped, so
  // a {running:true} poll can never start a second concurrent delegation.
  const cached = runs.get(key);
  if (cached && cached.status === 'done' && (a.task || '').trim() && cached.fingerprint !== fingerprint) {
    runs.delete(key);
  }
  if (!runs.has(key) && !(a.task || '').trim()) return { ok: false, action: 'skipped', error: 'task is required to start a delegation' };
  if (!runs.has(key) && !allowedFiles) return { ok: false, action: 'skipped', error: 'allowedFiles is required to start a delegation' };

  const reservedFiles = [...new Set(allowedFiles.split(/[,;\n]+/).map((entry) => entry.trim()).filter(Boolean))].sort();
  const run = getOrStart(key, { projectRoot, runId, batchKey: role, fingerprint, reservedFiles }, (onChild) => {
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
  return res ?? stillRunning(run, role, 'opencode_delegate');
}

export async function delegateFromPlanResumable(a: FromPlanArgs, waitMs = RESUME_WAIT_MS): Promise<ResumableResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  if (!runId) return { ok: false, error: 'runId is required' };
  const key = runKey(projectRoot, runId, PLAN_KEY);
  // Every queued unit's allowlist, surfaced while the batch runs. Best-effort:
  // an unreadable queue just yields an empty reservation list.
  const reservedFiles = ((): string[] => {
    try {
      const queue = readOpenCodeQueue(projectRoot, runId);
      return [...new Set((queue?.units ?? []).flatMap((u) => u.allowedFiles))].sort();
    } catch {
      return [];
    }
  })();
  // The batch reads its units from the plan queue on disk, so a re-call carries
  // no per-call work to compare. A constant fingerprint keeps it out of the
  // staleness eviction above: batch behaviour is unchanged.
  const run = getOrStart(key, { projectRoot, runId, batchKey: PLAN_KEY, fingerprint: PLAN_KEY, reservedFiles }, (onChild, isAborted) => startFromPlan(projectRoot, runId, a.model, onChild, isAborted));
  const res = await waitBounded(run, waitMs);
  return res ?? stillRunning(run, PLAN_KEY, 'opencode_delegate_from_plan');
}

export interface DelegateStatus {
  status: 'running' | 'done' | 'unknown';
  runId: string;
  role: string;
  result?: RunnerResult;
  reservedFiles?: string[];
  /** Set on a refused cancel: a clean diff is being applied to the real tree. */
  applying?: boolean;
  message?: string;
}

export interface DelegateStatusArgs {
  projectRoot?: string;
  runId?: string;
  role?: string;
  /** Bounded long-wait: block up to this long for the terminal result (server-clamped under the ~120s host tool ceiling). */
  waitMs?: number;
  /** Explicitly cancel the delegation: kills the worker BEFORE any diff applies and marks it abandoned. */
  cancel?: boolean;
}

export async function delegateStatus(a: DelegateStatusArgs): Promise<DelegateStatus> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  const explicitRole = (a.role || '').trim();
  let role = explicitRole || PLAN_KEY;
  let run = runs.get(runKey(projectRoot, runId, role));
  if (!run && !explicitRole) {
    // A role-less call defaults to the plan batch, but the orchestrator prose
    // shows bare {cancel:true} for single-role delegations too — and a missed
    // lookup answered "nothing to cancel" while the worker kept running.
    // When exactly one delegation is tracked for this (projectRoot, runId),
    // target it; ambiguity still requires the explicit role.
    const matches = [...runs.entries()].filter(([, candidate]) => (
      candidate.projectRoot === projectRoot && candidate.runId === runId
    ));
    if (matches.length === 1) {
      run = matches[0]![1];
      role = run.batchKey;
    } else if (matches.length > 1) {
      return {
        status: 'unknown', runId, role,
        message: `multiple delegations are tracked for this run (${matches.map(([, candidate]) => candidate.batchKey).join(', ')}) — pass the exact \`role\` (or omit it only for the plan batch)`,
      };
    }
  }
  if (!run) {
    return {
      status: 'unknown', runId, role,
      ...(a.cancel ? { message: 'nothing to cancel: no delegation is tracked for this run/role (a restarted server forgets finished runs; a running worker would be tracked)' } : {}),
    };
  }
  run.lastPolledAt = Date.now();
  if (run.status === 'done') return { status: 'done', runId, role, result: run.result };

  if (a.cancel) {
    // Never kill mid-apply: run-model arms a pid-verified latch around the
    // apply-back critical section (patch + verifications on the REAL tree);
    // killing the group there strands a partial diff the backup/restore pair
    // would otherwise have rolled back.
    if (openCodeApplyInProgress(projectRoot, runId)) {
      return {
        status: 'running', runId, role, applying: true,
        message: 'cancel refused: a clean diff is being applied to the working tree right now; call opencode_status again (without cancel) to collect the imminent terminal result',
      };
    }
    const cancelError = 'delegation cancelled: the orchestrator explicitly cancelled via opencode_status {cancel:true}; the worker was killed and no FURTHER diff will apply from it. If a unit had already completed its apply-and-verify, that diff remains in the tree — check the role digest and git status before the paid fallback';
    run.status = 'done';
    if (run.watchdog) clearInterval(run.watchdog);
    if (run.batchKey === PLAN_KEY) {
      abandonPlanBatch(run, cancelError);
    } else {
      run.aborted = true;
      for (const tracked of run.children) killChildGroup(tracked.child);
      run.result = { ok: false, action: 'cancelled', error: cancelError };
    }
    return { status: 'done', runId, role, result: run.result };
  }

  const waitMs = clampStatusWaitMs(a.waitMs);
  if (waitMs > 0) {
    const res = await waitBounded(run, waitMs);
    run.lastPolledAt = Date.now();
    if (res) return { status: 'done', runId, role, result: res };
  }
  return { status: 'running', runId, role, reservedFiles: run.reservedFiles };
}

// Exported for tests that need to inspect run-key parsing.
export const _parseRunKey = parseRunKey;
