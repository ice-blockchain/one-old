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
function runRunner(runnerArgs: string[], projectRoot: string): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [resolveRunnerPath(), ...runnerArgs], {
      cwd: projectRoot,
      // The runner uses process.cwd() as the project root and pins PWD to its own
      // throwaway worktree internally; setting PWD=projectRoot here keeps its
      // top-level git ops unambiguous.
      env: { ...process.env, PWD: projectRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

// The batch path: opencode-runner.cjs --run-id <id> --from-plan. Reads the
// architect's queue from <projectRoot>/.traffic-one/plan.md. Best-effort.
export async function runDelegateFromPlan(a: FromPlanArgs): Promise<RunnerResult> {
  const projectRoot = (a.projectRoot || '').trim() || process.cwd();
  const runId = (a.runId || '').trim();
  if (!runId) return { ok: false, error: 'runId is required' };
  const args = ['--run-id', runId, '--from-plan'];
  if ((a.model || '').trim()) args.push('--model', (a.model as string).trim());
  return runRunner(args, projectRoot);
}
