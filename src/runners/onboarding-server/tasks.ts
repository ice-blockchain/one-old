// src/runners/onboarding-server/tasks.ts
// Per-question deterministic task runner. The code-graph answer (the last
// question in both the new-project and existing-project flows) kicks the
// consolidated onboarding install — the chosen graph provider's bootstrap
// (install + first scan) plus the OpenCode CLI when enabled, ~30-60s — which
// would block the single-threaded server if run inline, so it runs as an async
// child process and the wizard polls /task/:id for the loading state. The runner
// CLI bootstraps process.cwd(), so the child's cwd is the project root. The
// runner exits non-zero ONLY when the required graph provider fails, which the
// wizard treats as a blocking error. While it runs, the runner emits NDJSON
// progress snapshots ({"t1Progress":{steps}}) on stdout; the latest snapshot is
// exposed on the polled task so the wizard AND the traffic.io dashboard can show
// a real progress bar instead of an indeterminate spinner. Tests inject a fast
// command via TRAFFIC_ONE_ONBOARDING_TASK_CMD ('noop' | 'fail' | <script>).

import { spawn } from 'child_process';
import * as path from 'path';

import { pluginRoot } from '../../shared/paths';

type TaskStatus = 'running' | 'done' | 'error';

// Mirrors the runner's ProgressStep (src/runners/onboarding-toolchain): the
// runner emits `{"t1Progress":{"steps":[…]}}` NDJSON snapshots on stdout and the
// latest one is folded into the polled task state below. Additive field — the
// traffic.io dashboard and wizard.html both tolerate its absence (test override
// commands and older runners emit no progress at all).
interface TaskProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'warn';
  weight: number;
}

interface TaskProgress {
  steps: TaskProgressStep[];
}

interface TaskState {
  id: string;
  status: TaskStatus;
  action?: string;
  error?: string | null;
  progress?: TaskProgress;
  startedAt: number;
  finishedAt?: number;
}

const tasks = new Map<string, TaskState>();
let counter = 0;

interface Spec {
  command: string;
  args: string[];
}

function resolveSpec(cwd: string, env: NodeJS.ProcessEnv): Spec {
  const override = env.TRAFFIC_ONE_ONBOARDING_TASK_CMD;
  if (override === 'noop') return { command: process.execPath, args: ['-e', ''] };
  if (override === 'fail') return { command: process.execPath, args: ['-e', 'process.exit(3)'] };
  if (override) return { command: process.execPath, args: [override, cwd] };
  return { command: process.execPath, args: [path.join(pluginRoot(), 'scripts', 'onboarding-toolchain-runner.cjs')] };
}

// The runner interleaves NDJSON progress lines with the final result summary,
// so the result is the LAST parseable stdout line carrying an `action` (a bare
// whole-stdout JSON.parse would choke on the progress lines).
function actionFrom(stdout: string): string {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { action?: unknown };
      if (typeof parsed.action === 'string') return parsed.action;
    } catch { /* not this line */ }
  }
  return 'onboarding-toolchain';
}

// A stdout line is a progress snapshot when it parses to {t1Progress:{steps:[…]}}.
function progressFrom(line: string): TaskProgress | null {
  try {
    const parsed = JSON.parse(line) as { t1Progress?: { steps?: unknown } };
    const steps = parsed?.t1Progress?.steps;
    if (Array.isArray(steps)) return { steps: steps as TaskProgressStep[] };
  } catch { /* not a progress line */ }
  return null;
}

function finish(id: string, status: TaskStatus, extra: Partial<TaskState>): void {
  const current = tasks.get(id);
  if (!current) return;
  tasks.set(id, { ...current, status, finishedAt: Date.now(), ...extra });
}

export function startInstallTask(cwd: string, env: NodeJS.ProcessEnv): string {
  const id = `task-${++counter}`;
  tasks.set(id, { id, status: 'running', startedAt: Date.now() });
  const spec = resolveSpec(cwd, env);
  let stdout = '';
  let stderr = '';
  // Complete stdout lines are scanned for progress snapshots AS THEY ARRIVE so
  // /task/:id polls see live install progress; the trailing partial line stays
  // buffered in `stdout` until its newline (or exit) completes it.
  let scanned = 0;
  const scanProgress = (): void => {
    const end = stdout.lastIndexOf('\n');
    if (end < scanned) return;
    const lines = stdout.slice(scanned, end).split('\n');
    scanned = end + 1;
    for (const line of lines) {
      const progress = progressFrom(line);
      if (!progress) continue;
      const current = tasks.get(id);
      if (current && current.status === 'running') tasks.set(id, { ...current, progress });
    }
  };
  try {
    const child = spawn(spec.command, spec.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      scanProgress();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => finish(id, 'error', { error: err.message }));
    child.on('exit', (code) => {
      if (code === 0) finish(id, 'done', { action: actionFrom(stdout) });
      else finish(id, 'error', { error: stderr.trim() || `exited ${code}` });
    });
  } catch (err) {
    finish(id, 'error', { error: (err as Error).message });
  }
  return id;
}

export function getTask(id: string): TaskState | null {
  return tasks.get(id) || null;
}
