// src/runners/opencode/index.ts
// Headless OpenCode delegation runner (compiles to scripts/opencode-runner.cjs).
// The senior-eng-orchestrator calls this to hand a bounded, low-risk coding task
// to the installed OpenCode CLI INSTEAD of spawning a paid Traffic One subagent.
// It runs headless via `opencode run --format json`. By default it walks the
// free `opencode/*` gateway chain, advancing to the next free model when the
// gateway rejects one (the free ids are promotional and rotate). When the
// project pins `openCode.model`, that explicit model is tried alone.
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

import { OPENCODE_FREE_MODELS } from '../../config/opencode';
import { exec } from '../../shared/exec';
import { ensureInitialCommit } from '../../shared/git-init';
import { markOpenCodeRoleAttempted } from '../../shared/opencode-roles';
import { readEffectiveState } from '../../shared/state';
import { nowIso } from '../../shared/text';
import { managedNpmBin, reconcileManagedToolStamp } from '../toolchain';

type Rec = Record<string, unknown>;
const which = exec.which;

const RUN_TIMEOUT_MS = 8 * 60 * 1000;
const DIGEST_HARD_BYTES = 3072;
// The free gateway models are non-deterministic and sometimes "chat" without
// editing. Allow ONE bounded retry (still free) on a clean no-op before falling
// back to a paid subagent — this measurably raises the delegation hit-rate.
const MAX_DELEGATE_ATTEMPTS = 2;

// Headless hardening for the spawned CLI (verified against the pinned 1.15.13
// binary, which supports all three env vars): never self-update mid-run, never
// share sessions, don't inject the user's global ~/.claude/CLAUDE.md into the
// delegation context, and pin the two ask-default permissions to a deterministic
// `deny`. `opencode run` already auto-rejects permission asks headlessly on the
// pinned version, but resolveBin() can fall back to an unpinned PATH binary —
// and an allowed `external_directory` would let the model write OUTSIDE the
// throwaway worktree, escaping the diff-capture sandbox entirely. Config layers
// merge key-by-key, so this overrides only these keys, not the user's config.
const OPENCODE_RUN_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    autoupdate: false,
    share: 'disabled',
    permission: { external_directory: 'deny', doom_loop: 'deny' },
  }),
};

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

// The free-model chain is walked per delegation; remember (for this process —
// the MCP server is long-lived, and --from-plan loops units in one process) how
// far we got, so a retired promo model is not re-tried on every single unit.
// Never persisted: a plugin update with a fresh chain resets it naturally.
let freeChainStart = 0;

// Test-only: the memo is module-level process state, so in-process tests must
// reset it between cases to stay order-independent.
export function resetOpenCodeModelMemo(): void {
  freeChainStart = 0;
}

// Model resolution. An EXPLICIT model (opts.model or openCode.model in local
// preferences) is the user's choice: it is tried alone, with NO fallback — we
// never silently swap a model someone pinned. Only the default free chain
// falls back, advancing on model-class errors.
function resolveModels(state: Rec, opts: DelegateOpts): { models: string[]; fromChain: boolean } {
  if (opts.model) return { models: [opts.model], fromChain: false };
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode && typeof openCode.model === 'string' && openCode.model) {
    return { models: [openCode.model], fromChain: false };
  }
  const start = Math.min(freeChainStart, OPENCODE_FREE_MODELS.length - 1);
  return { models: OPENCODE_FREE_MODELS.slice(start), fromChain: true };
}

// `opencode run` emits NDJSON. Pull out error events + the assistant text.
// Non-JSON lines (e.g. a first-run DB-migration banner) are ignored. The error
// name AND message are both kept: classification needs the raw class name
// (e.g. "ProviderModelNotFoundError") when the message is empty.
function parseStream(stdout: string): { errored: boolean; errName: string; errorMsg: string; summary: string } {
  let errored = false;
  let errName = '';
  let errorMsg = '';
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
      if (typeof data.message === 'string' && data.message) errorMsg = data.message;
      if (typeof err.name === 'string' && err.name) errName = err.name;
    }
    if (obj.type === 'text') {
      const part = obj.part && typeof obj.part === 'object' ? (obj.part as Rec) : {};
      const txt = typeof part.text === 'string' ? part.text : (typeof obj.text === 'string' ? obj.text : '');
      if (txt) texts.push(txt);
    }
  }
  return { errored, errName, errorMsg, summary: texts.join(' ').replace(/\s+/g, ' ').trim() };
}

// Decide whether the NEXT free model in the chain should be tried after an
// opencode-reported error. LIVE-VERIFIED on the pinned 1.15.13: a RETIRED or
// unknown gateway model is reported as a generic "Unexpected server error.
// Check server logs for details." — no model name, no "not found", no 401 in
// the message — so a positive match on model-error vocabulary would miss the
// exact case the chain exists for (promo rotation). Inverted policy instead:
// advance on EVERY server/model-side error, and fail fast ONLY on clearly
// environmental failures (DNS, refused/reset connections, TLS, proxy, offline)
// where a different model cannot possibly help. The asymmetry is deliberate:
// a false advance costs at most two fast-failing extra runs before the paid
// fallback; a false fail-fast kills delegation until the next plugin update.
const ENVIRONMENTAL_ERROR_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|network|socket|TLS|certificate|proxy|offline/i;
function shouldTryNextModel(errName: string, errorMsg: string): boolean {
  return !ENVIRONMENTAL_ERROR_RE.test(`${errName}: ${errorMsg}`);
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

type ApplyTargetBackup = {
  rel: string;
  abs: string;
  existed: boolean;
  backupPath?: string;
  createdParentDirs: string[];
};

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseNulPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

function parseNameStatusZ(stdout: string): string[] {
  const fields = parseNulPaths(stdout);
  const paths: string[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    const first = fields[i++];
    if (first) paths.push(first);
    if (/^[RC]/.test(status)) {
      const second = fields[i++];
      if (second) paths.push(second);
    }
  }
  return uniquePaths(paths);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function isInsideRoot(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

function resolveRepoPath(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs !== root && isInsideRoot(root, abs) ? abs : null;
}

function pathExists(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function copyPath(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return;
  }
  if (stat.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true, force: true });
    return;
  }
  fs.copyFileSync(src, dst);
}

function backupApplyTargets(cwd: string, targetPaths: string[], parent: string): ApplyTargetBackup[] {
  const root = path.resolve(cwd);
  const backupRoot = path.join(parent, 'pre-apply-backup');
  const backups: ApplyTargetBackup[] = [];
  for (const rel of uniquePaths(targetPaths)) {
    const abs = resolveRepoPath(root, rel);
    if (!abs) throw new Error(`unsafe patch path: ${rel}`);

    const createdParentDirs: string[] = [];
    if (!pathExists(abs)) {
      for (let cur = path.dirname(abs); cur !== root && isInsideRoot(root, cur) && !pathExists(cur); cur = path.dirname(cur)) {
        createdParentDirs.push(cur);
      }
      backups.push({ rel, abs, existed: false, createdParentDirs });
      continue;
    }

    const backupPath = path.join(backupRoot, String(backups.length));
    copyPath(abs, backupPath);
    backups.push({ rel, abs, existed: true, backupPath, createdParentDirs });
  }
  return backups;
}

function restoreApplyTargets(backups: ApplyTargetBackup[]): string | null {
  const errors: string[] = [];
  for (const backup of backups) {
    try {
      fs.rmSync(backup.abs, { recursive: true, force: true });
      if (backup.existed && backup.backupPath) {
        copyPath(backup.backupPath, backup.abs);
      } else {
        for (const dir of backup.createdParentDirs) {
          try { fs.rmdirSync(dir); } catch { /* non-empty or already gone */ }
        }
      }
    } catch (err) {
      errors.push(`${backup.rel}: ${formatError(err)}`);
    }
  }
  return errors.length ? errors.join('; ') : null;
}

// Outcome of trying ONE model in its own fresh worktree.
type ModelRunOutcome =
  | { kind: 'delegated'; touched: string[]; summary: string }
  | { kind: 'try-next'; error: string }      // server/model-side error → try the next model
  | { kind: 'failed'; error: string }        // terminal: environmental/process/apply failure
  | { kind: 'no-changes' };                  // terminal: model ran clean but produced nothing

// Run one model against the task in a FRESH throwaway worktree (created here,
// removed here). A fresh worktree per model — rather than resetting one — wipes
// every residue class at once: commits the model may have made, gitignored
// build output, lockfiles. On success the staged diff (vs baseSha) is applied
// to the real working tree before returning.
function runModel(cwd: string, bin: string, baseSha: string, model: string, task: string, onCliAttempt?: () => void): ModelRunOutcome {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oc-'));
  const wt = path.join(parent, 'wt');
  const added = git(cwd, ['worktree', 'add', '--detach', wt, baseSha], 60_000);
  if (added.status !== 0) {
    removeWorktree(cwd, parent, wt);
    return { kind: 'failed', error: `git worktree add failed: ${added.stderr || 'non-zero exit'}` };
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
      onCliAttempt?.();
      const run = spawnSync(bin, runArgs, {
        cwd: wt,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, ...OPENCODE_RUN_ENV, PWD: wt },
      });
      if (run.error || run.status === null) {
        // Process-level failure (incl. a deployment so slow it hits our timeout).
        // Deliberately NOT model-class: the chain does not advance on stalls.
        return { kind: 'failed', error: `opencode run failed: ${run.error ? run.error.message : 'timed out'}` };
      }
      const parsed = parseStream(run.stdout || '');
      if (parsed.errored) {
        const msg = parsed.errorMsg || parsed.errName || 'error';
        if (shouldTryNextModel(parsed.errName, parsed.errorMsg)) {
          return { kind: 'try-next', error: msg };
        }
        return { kind: 'failed', error: `opencode: ${msg}` };
      }
      // Stage everything opencode changed; non-empty staged diff vs the BASE sha
      // ⇒ we have work. Diffing against baseSha (not symbolic HEAD) keeps the
      // work visible even when the model `git commit`ed inside the detached
      // worktree (which moves HEAD and would make a HEAD-relative diff empty).
      git(wt, ['add', '-A']);
      if (git(wt, ['diff', '--cached', '--quiet', baseSha]).status !== 0) { summary = parsed.summary; break; }
      if (attempt >= MAX_DELEGATE_ATTEMPTS) {
        return { kind: 'no-changes' };
      }
      // Reset the throwaway worktree to the pristine base before the free retry
      // (-x also drops gitignored residue the first attempt may have written).
      git(wt, ['reset', '--hard', '-q', baseSha]);
      git(wt, ['clean', '-fdxq']);
    }

    // Capture the patch + touched list from the winning attempt (vs baseSha).
    const touched = parseNulPaths(git(wt, ['diff', '--cached', '--name-only', '-z', baseSha]).stdout);
    const applyTargets = uniquePaths([
      ...touched,
      ...parseNameStatusZ(git(wt, ['diff', '--cached', '--name-status', '-z', baseSha]).stdout),
    ]);
    const patch = git(wt, ['diff', '--cached', '--binary', baseSha]).stdout;
    const patchPath = path.join(parent, 'delegated.patch');
    fs.writeFileSync(patchPath, patch, 'utf8');

    // Apply to the real working tree (unstaged, like a subagent edit). Same base,
    // so a clean tree applies cleanly; a conflict → fail → fallback.
    let backups: ApplyTargetBackup[];
    try {
      backups = backupApplyTargets(cwd, applyTargets, parent);
    } catch (err) {
      return { kind: 'failed', error: `could not prepare atomic delegated diff apply: ${formatError(err)}` };
    }
    let applied = git(cwd, ['apply', '--whitespace=nowarn', patchPath]);
    if (applied.status !== 0) {
      const rollbackError = restoreApplyTargets(backups);
      if (rollbackError) {
        return {
          kind: 'failed',
          error: `could not roll back failed delegated diff apply: ${rollbackError}`,
        };
      }
      applied = git(cwd, ['apply', '--3way', patchPath]);
    }
    if (applied.status !== 0) {
      const rollbackError = restoreApplyTargets(backups);
      const rollbackSuffix = rollbackError ? `; rollback failed: ${rollbackError}` : '';
      return { kind: 'failed', error: `could not apply delegated diff to the working tree: ${applied.stderr || 'apply failed'}${rollbackSuffix}` };
    }
    return { kind: 'delegated', touched, summary };
  } finally {
    removeWorktree(cwd, parent, wt);
  }
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
  // We resolved a real binary — self-heal a stale/missing toolchain stamp so the
  // orchestrator + tier logic stop treating OpenCode as "not installed" on the
  // next run. Best-effort; never blocks delegation.
  reconcileManagedToolStamp(cwd, 'opencode');
  const task = (opts.task || '').trim();
  if (!task) {
    return { ok: false, action: 'skipped', digest: null, touched: [], error: 'No task provided to delegate' };
  }
  // Sandbox requires a committed HEAD to branch the worktree from. Pin the exact
  // sha once: every worktree, reset, and diff below is relative to it.
  let head = git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    // NEW-PROJECT case: a fresh scaffold has no commit (and may not be a git repo at
    // all) until the build-completion flip — but the orchestrator delegates to
    // OpenCode DURING the build, so declining here forces a paid fallback for the
    // whole build. Self-heal: initialize (new-project only) + initial-commit the
    // scaffold, then retry. Still skips when no HEAD can be produced (a non-git folder
    // outside new-project mode, or nothing to commit) → caller falls back as before.
    ensureInitialCommit(cwd, { initIfNeeded: state.mode === 'new-project' });
    head = git(cwd, ['rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0) {
      return { ok: false, action: 'skipped', digest: null, touched: [], error: 'No git HEAD to sandbox the delegation; run a normal subagent' };
    }
  }
  // Sandbox from the CURRENT WORKING TREE, not just committed HEAD. `git stash
  // create` snapshots uncommitted (tracked) changes into a throwaway commit without
  // touching the tree or the stash list; fall back to HEAD when the tree is clean
  // (it prints nothing). Without this, sequential delegations each branch the
  // worktree from the same stale HEAD and silently ignore the PREVIOUS delegation's
  // still-uncommitted edit — the 2nd+ task runs against a "cached" snapshot of the
  // repo, so its diff is computed off the wrong base and the change fails to land.
  const snapshot = git(cwd, ['stash', 'create']);
  const baseSha = (snapshot.status === 0 && snapshot.stdout.trim()) ? snapshot.stdout.trim() : head.stdout.trim();

  const { models, fromChain } = resolveModels(state, opts);
  const role = (opts.role || 'opencode').trim() || 'opencode';
  const runId = (opts.runId || '').trim() || runStamp();
  let markedAttempt = false;
  const markCliAttempt = (): void => {
    if (markedAttempt || !runId || !role) return;
    markedAttempt = true;
    markOpenCodeRoleAttempted(cwd, runId, role);
  };

  // Walk the models: a fresh worktree per model; advance on server/model-side
  // errors (see shouldTryNextModel). Environmental failures are terminal.
  const modelErrors: string[] = [];
  let lastModel = models[models.length - 1] as string;
  for (const model of models) {
    lastModel = model;
    const outcome = runModel(cwd, bin, baseSha, model, task, markCliAttempt);
    if (outcome.kind === 'delegated') {
      if (fromChain) {
        const idx = OPENCODE_FREE_MODELS.indexOf(model);
        if (idx >= 0) freeChainStart = idx;
      }
      const digest = writeDigest(cwd, runId, role, model, outcome.touched, outcome.summary);
      return { ok: true, action: 'delegated', digest, touched: outcome.touched, error: null, model };
    }
    if (outcome.kind === 'try-next') {
      modelErrors.push(`${model}: ${outcome.error}`);
      if (fromChain) {
        const idx = OPENCODE_FREE_MODELS.indexOf(model);
        // Skip the dead id for the rest of this process, but always keep at
        // least the LAST chain entry tryable so delegation degrades to one fast
        // failing probe per unit instead of disappearing silently.
        if (idx >= 0) freeChainStart = Math.min(idx + 1, OPENCODE_FREE_MODELS.length - 1);
      }
      continue;
    }
    if (outcome.kind === 'no-changes') {
      return { ok: false, action: 'no-changes', digest: null, touched: [], error: 'OpenCode produced no file changes', model };
    }
    return { ok: false, action: 'failed', digest: null, touched: [], error: outcome.error, model };
  }
  return {
    ok: false,
    action: 'failed',
    digest: null,
    touched: [],
    error: `no usable OpenCode model — ${modelErrors.join('; ')}`,
    model: lastModel,
  };
}

export interface PlanDelegationResult {
  total: number;
  delegated: number;
  units: Array<{ role: string; task: string; action: DelegateResult['action']; touched: string[]; model?: string }>;
}

// Parse the architect's plan.md delegation queue. The architect emits a
// machine-readable block listing ONLY bounded/low-risk units (senior work is
// never queued), so delegation does not depend on the orchestrator re-deciding
// per unit mid-flight:
//   <!-- opencode-delegate:start -->
//   - role: backend | files: src/lib/seed.ts | task: <self-contained task>
//   <!-- opencode-delegate:end -->
export function parsePlanDelegationQueue(planText: string): Array<{ role: string; files: string; task: string }> {
  const start = planText.indexOf('opencode-delegate:start');
  const end = planText.indexOf('opencode-delegate:end');
  if (start < 0 || end < 0 || end < start) return [];
  const units: Array<{ role: string; files: string; task: string }> = [];
  for (const raw of planText.slice(start, end).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const fields: Record<string, string> = {};
    for (const part of line.slice(2).split('|')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim().toLowerCase();
      if (key) fields[key] = part.slice(idx + 1).trim();
    }
    if (fields.task) units.push({ role: fields.role || 'opencode', files: fields.files || '', task: fields.task });
  }
  return units;
}

// Deterministically delegate EVERY queued bounded unit to OpenCode. Reuses
// delegate() per unit (each in its own worktree from HEAD); the free-model
// chain position is memoized across units, so a retired promo id is skipped
// after the first unit discovers it. A unit that opencode can't deliver
// (skipped/failed/no-changes) simply isn't applied — the orchestrator then
// spawns a normal subagent for it. Never throws.
export function delegateFromPlan(cwd: string = process.cwd(), opts: { runId?: string; model?: string } = {}): PlanDelegationResult {
  let planText = '';
  try { planText = fs.readFileSync(path.join(cwd, '.traffic-one', 'plan.md'), 'utf8'); } catch { /* no plan → empty queue */ }
  const queue = parsePlanDelegationQueue(planText);
  const units: PlanDelegationResult['units'] = [];
  let delegated = 0;
  for (const u of queue) {
    const task = u.files ? `${u.task}\n\nFiles/area: ${u.files}` : u.task;
    const r = delegate(cwd, { role: u.role, task, runId: opts.runId, model: opts.model });
    if (r.ok) delegated += 1;
    units.push({ role: u.role, task: u.task, action: r.action, touched: r.touched, model: r.model });
  }
  return { total: queue.length, delegated, units };
}

// CLI entry. Either:
//   --from-plan                         delegate every bounded unit in plan.md's queue
//   --role <r> (--task <t>|--task-file <p>)   delegate one explicit unit
// plus --run-id <id> [--model <provider/model>]. Prints a one-line JSON result.
export function main(): number {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  if (args.includes('--from-plan')) {
    const summary = delegateFromPlan(process.cwd(), { runId: get('--run-id'), model: get('--model') });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0; // batch is best-effort: un-delegated units fall back to subagents, never fail the run
  }

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
