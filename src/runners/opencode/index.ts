// src/runners/opencode/index.ts
// Headless OpenCode delegation runner (compiles to scripts/opencode-runner.cjs).
// The senior-eng-orchestrator calls this to hand a bounded, low-risk coding task
// to the installed OpenCode CLI (a free `opencode/*` gateway model — runs headless
// via `opencode run --format json`, NO sign-in/API key) INSTEAD of spawning a paid
// Traffic One subagent.
//
// Safety model: the task runs inside a throwaway git WORKTREE (sandbox cut from
// HEAD). Only a clean, error-free, non-empty result is applied back to the real
// working tree; then a handoff digest is written for the reviewer. ANY problem
// (not enabled, not installed, no git HEAD, opencode error/throttle/timeout, no
// changes, or a failed apply) returns ok:false with the main tree untouched, so
// the orchestrator falls back to a normal subagent.
//
// IMPORTANT: `opencode run` exits 0 even on errors (e.g. "Model not found",
// server errors) — failures surface as {"type":"error",...} events in the JSON
// stream. We detect failure by parsing the stream, never by exit code.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { exec } from '../../shared/exec';
import { readEffectiveState } from '../../shared/state';
import { nowIso } from '../../shared/text';
import { getToolSpec, managedNpmBin } from '../toolchain';

type Rec = Record<string, unknown>;
const which = exec.which;

const DEFAULT_MODEL = 'opencode/deepseek-v4-flash-free';
const RUN_TIMEOUT_MS = 8 * 60 * 1000;
const DIGEST_HARD_BYTES = 3072;
// The free gateway model is non-deterministic and sometimes "chats" without
// editing. Allow ONE bounded retry (still free) on a clean no-op before falling
// back to a paid subagent — this measurably raises the delegation hit-rate.
const MAX_DELEGATE_ATTEMPTS = 2;

export interface DelegateOpts {
  role?: string;
  task?: string;
  runId?: string;
  model?: string;
}

export interface DelegateResult {
  ok: boolean;
  // delegated = applied to the tree; skipped = precondition not met (fall back);
  // failed/no-changes = opencode could not deliver (fall back).
  action: 'delegated' | 'skipped' | 'failed' | 'no-changes';
  digest: string | null;
  touched: string[];
  error: string | null;
  model?: string;
}

function git(cwd: string, args: string[], timeout = 60_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  return { status: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
}

function resolveBin(): string | null {
  const managed = managedNpmBin('opencode', 'opencode');
  if (fs.existsSync(managed)) return managed;
  return which('opencode');
}

function resolveModel(state: Rec, opts: DelegateOpts): string {
  if (opts.model) return opts.model;
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode && typeof openCode.model === 'string' && openCode.model) return openCode.model;
  const spec = getToolSpec('opencode');
  return typeof spec?.delegateModel === 'string' && spec.delegateModel ? spec.delegateModel : DEFAULT_MODEL;
}

// `opencode run` emits NDJSON. Pull out error events + the assistant text.
// Non-JSON lines (e.g. a first-run DB-migration banner) are ignored.
function parseStream(stdout: string): { errored: boolean; errorMsg: string | null; summary: string } {
  let errored = false;
  let errorMsg: string | null = null;
  const texts: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj: Rec;
    try { obj = JSON.parse(line) as Rec; } catch { continue; }
    if (obj.type === 'error') {
      errored = true;
      const err = obj.error && typeof obj.error === 'object' ? (obj.error as Rec) : {};
      const data = err.data && typeof err.data === 'object' ? (err.data as Rec) : {};
      errorMsg = (typeof data.message === 'string' && data.message)
        || (typeof err.name === 'string' && err.name)
        || 'opencode reported an error';
    }
    if (obj.type === 'text') {
      const part = obj.part && typeof obj.part === 'object' ? (obj.part as Rec) : {};
      const txt = typeof part.text === 'string' ? part.text : (typeof obj.text === 'string' ? obj.text : '');
      if (txt) texts.push(txt);
    }
  }
  return { errored, errorMsg, summary: texts.join(' ').replace(/\s+/g, ' ').trim() };
}

function runStamp(): string {
  // Matches the orchestrator's run-id shape (YYYY-MM-DDTHH-MM-SSZ); only used
  // when the caller doesn't pass --run-id (standalone/tests).
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

function writeDigest(cwd: string, runId: string, role: string, model: string, touched: string[], summary: string): string {
  const dir = path.join(cwd, '.traffic-one', 'digests', runId);
  fs.mkdirSync(dir, { recursive: true });
  const touchedLines = touched.slice(0, 20).map((f) => `- ${f}        # delegated edit`).join('\n')
    + (touched.length > 20 ? `\n- … +${touched.length - 20} more` : '');
  const body = [
    `# ${role} digest — run ${runId}`,
    '',
    'verdict: DELEGATED_OK',
    `finished_at: ${nowIso()}`,
    `delegated_to: opencode (${model})`,
    '',
    '## Touched',
    touchedLines || '- (none)',
    '',
    '## Summary',
    (summary || 'OpenCode applied the delegated change.').slice(0, 400),
    '',
    '## Open questions / blockers / assumptions',
    '- Changes produced by OpenCode (free model). Reviewer MUST verify the diff before commit.',
    '',
  ].join('\n');
  const p = path.join(dir, `${role}.md`);
  fs.writeFileSync(p, body.slice(0, DIGEST_HARD_BYTES), 'utf8');
  return p;
}

function removeWorktree(cwd: string, parent: string, wt: string): void {
  try { git(cwd, ['worktree', 'remove', '--force', wt]); } catch { /* best-effort */ }
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export function delegate(cwd: string = process.cwd(), opts: DelegateOpts = {}): DelegateResult {
  const state = readEffectiveState(cwd);
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode?.enabled !== true) {
    return { ok: false, action: 'skipped', digest: null, touched: [], error: 'OpenCode delegation is not enabled' };
  }
  const bin = resolveBin();
  if (!bin) {
    return { ok: false, action: 'skipped', digest: null, touched: [], error: 'OpenCode CLI is not installed' };
  }
  const task = (opts.task || '').trim();
  if (!task) {
    return { ok: false, action: 'skipped', digest: null, touched: [], error: 'No task provided to delegate' };
  }
  // Sandbox requires a committed HEAD to branch the worktree from.
  if (git(cwd, ['rev-parse', '--verify', 'HEAD']).status !== 0) {
    return { ok: false, action: 'skipped', digest: null, touched: [], error: 'No git HEAD to sandbox the delegation; run a normal subagent' };
  }

  const model = resolveModel(state, opts);
  const role = (opts.role || 'opencode').trim() || 'opencode';
  const runId = (opts.runId || '').trim() || runStamp();

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oc-'));
  const wt = path.join(parent, 'wt');
  const added = git(cwd, ['worktree', 'add', '--detach', wt, 'HEAD'], 60_000);
  if (added.status !== 0) {
    removeWorktree(cwd, parent, wt);
    return { ok: false, action: 'failed', digest: null, touched: [], error: `git worktree add failed: ${added.stderr || 'non-zero exit'}`, model };
  }

  try {
    // `opencode run` resolves its project directory from $PWD, NOT the spawn cwd:
    // Node's spawnSync sets the child's real cwd but leaves PWD pointing at the
    // parent (only a shell `cd` updates PWD). Without pinning the directory,
    // opencode edits the CALLER's tree (the user's real repo) instead of the
    // sandbox worktree, the worktree diff comes back empty, and EVERY delegation
    // falsely returns "no-changes" while stray edits leak into the real tree.
    // Pin both the explicit --dir flag and PWD to the worktree so the sandbox
    // actually contains the work.
    const runArgs = ['run', task, '--dir', wt, '-m', model, '--format', 'json'];
    let summary = '';
    // Retry only a CLEAN no-op (the weak model occasionally produces nothing). A
    // gateway error or process failure won't fix itself on retry, so bail at once.
    for (let attempt = 1; attempt <= MAX_DELEGATE_ATTEMPTS; attempt++) {
      const run = spawnSync(bin, runArgs, {
        cwd: wt,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, PWD: wt },
      });
      if (run.error || run.status === null) {
        return { ok: false, action: 'failed', digest: null, touched: [], error: `opencode run failed: ${run.error ? run.error.message : 'timed out'}`, model };
      }
      const parsed = parseStream(run.stdout || '');
      if (parsed.errored) {
        return { ok: false, action: 'failed', digest: null, touched: [], error: `opencode: ${parsed.errorMsg || 'error'}`, model };
      }
      // Stage everything opencode changed; non-empty staged diff ⇒ we have work.
      git(wt, ['add', '-A']);
      if (git(wt, ['diff', '--cached', '--quiet']).status !== 0) { summary = parsed.summary; break; }
      if (attempt >= MAX_DELEGATE_ATTEMPTS) {
        return { ok: false, action: 'no-changes', digest: null, touched: [], error: 'OpenCode produced no file changes', model };
      }
      // Reset the throwaway worktree to pristine HEAD before the free retry.
      git(wt, ['reset', '--hard', '-q', 'HEAD']);
      git(wt, ['clean', '-fdq']);
    }

    // Capture the patch + touched list from the winning attempt.
    const touched = git(wt, ['diff', '--cached', '--name-only']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const patch = git(wt, ['diff', '--cached', '--binary']).stdout;
    const patchPath = path.join(parent, 'delegated.patch');
    fs.writeFileSync(patchPath, patch, 'utf8');

    // Apply to the real working tree (unstaged, like a subagent edit). Same HEAD,
    // so a clean tree applies cleanly; a conflict → fail → fallback.
    let applied = git(cwd, ['apply', '--whitespace=nowarn', patchPath]);
    if (applied.status !== 0) applied = git(cwd, ['apply', '--3way', patchPath]);
    if (applied.status !== 0) {
      return { ok: false, action: 'failed', digest: null, touched, error: `could not apply delegated diff to the working tree: ${applied.stderr || 'apply failed'}`, model };
    }

    const digest = writeDigest(cwd, runId, role, model, touched, summary);
    return { ok: true, action: 'delegated', digest, touched, error: null, model };
  } finally {
    removeWorktree(cwd, parent, wt);
  }
}

// CLI entry. Args: --run-id <id> --role <role> (--task "<t>" | --task-file <path>)
// [--model <provider/model>]. Prints a one-line JSON result; exit 1 → orchestrator
// falls back to a normal subagent.
export function main(): number {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const taskFile = get('--task-file');
  let task = get('--task');
  if (!task && taskFile && fs.existsSync(taskFile)) task = fs.readFileSync(taskFile, 'utf8');

  const result = delegate(process.cwd(), { role: get('--role'), task, runId: get('--run-id'), model: get('--model') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  const code = main();
  if (typeof code === 'number') process.exitCode = code;
}
