// src/runners/onboarding-server/tasks.ts
// Per-question deterministic task runner. The code-graph answer (the last
// question in both the new-project and existing-project flows) kicks the
// consolidated onboarding install — the chosen graph provider's bootstrap
// (install + first scan) plus the OpenCode CLI when enabled, ~30-60s — which
// would block the single-threaded server if run inline, so it runs as an async
// child process and the wizard polls /task/:id for the loading state. The runner
// CLI bootstraps process.cwd(), so the child's cwd is the project root. The
// runner exits non-zero ONLY when the required graph provider fails, which the
// wizard treats as a blocking error. Tests inject a fast command via
// TRAFFIC_ONE_ONBOARDING_TASK_CMD ('noop' | 'fail' | <script>).

import { spawn } from 'child_process';
import * as path from 'path';

import { pluginRoot } from '../../shared/paths';

type TaskStatus = 'running' | 'done' | 'error';

interface TaskState {
  id: string;
  status: TaskStatus;
  action?: string;
  error?: string | null;
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

function actionFrom(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout.trim()) as { action?: unknown };
    return typeof parsed.action === 'string' ? parsed.action : 'onboarding-toolchain';
  } catch {
    return 'onboarding-toolchain';
  }
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
  try {
    const child = spawn(spec.command, spec.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
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
