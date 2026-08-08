// src/shared/exec.ts
// The ONE process/exec layer: a single which() (legacy had several) + run().
// Implements the Exec service consumed via Ctx.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { Exec, ExecOptions, ExecOutcome, ExecResult } from '../core/types';

/**
 * The bound every subprocess started through this layer gets when its caller
 * names none.
 *
 * BORROWED, not invented: 60_000 ms is the default of `git()` in
 * runners/opencode/git-sandbox.ts:10, this repo's existing bounded-git-exec
 * primitive, applied there to the same class of work — a git subprocess writing
 * a user's tree, whose cost scales with that tree. It is deliberately the most
 * PERMISSIVE of the two git bounds already in the tree (the other is the 3_000
 * ms read-probe bound repeated at twelve sites across
 * shared/verification-contract/git.ts, shared/architecture-contract/baseline.ts
 * and shared/maintenance/fallback.ts) because this is a floor under a hang, not
 * a performance budget: every existing caller must stay comfortably inside it
 * or the change would convert working code into failing code.
 *
 * Headroom against measurement, on this repo's own git-init.ts sequence: the
 * slowest single invocation was 58.83 ms on the 94-file scaffolded-greenfield
 * fixture and 1405.22 ms (`git add -A`) on a synthetic 3000-file tree — 42x
 * inside the bound at the stress point, and the observed 0.463 ms/file slope of
 * `git add -A` puts the crossing point near 130,000 files.
 */
export const EXEC_DEFAULT_TIMEOUT_MS = 60_000;

function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code ? code : 'unknown';
}

/**
 * The bound a given call actually gets.
 *
 * Named and exported because "there IS a default" is the whole change and is
 * otherwise unobservable: a correct 60 s bound and no bound at all are the same
 * observation for every command that finishes, so an assertion on BEHAVIOUR
 * could only tell them apart by running for over a minute. This is the seam
 * that makes the decision checkable in microseconds instead.
 */
export function execTimeoutMs(opts: ExecOptions = {}): number {
  return opts.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
}

function runResult(cmd: string, args: readonly string[], opts: ExecOptions = {}): ExecOutcome {
  const timeoutMs = execTimeoutMs(opts);
  const result = spawnSync(cmd, [...args], { cwd: opts.cwd, encoding: 'utf8', timeout: timeoutMs });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (typeof result.status === 'number') return { kind: 'exited', code: result.status, stdout, stderr };
  // Node reports a timeout kill as ETIMEDOUT on `error` AND as the kill signal
  // on `signal`, so the timeout test has to come first or every timeout would
  // read as an ordinary signal and lose the one fact that explains it.
  if (errnoOf(result.error) === 'ETIMEDOUT') return { kind: 'timed-out', timeoutMs, stdout, stderr };
  if (result.signal) return { kind: 'signalled', signal: String(result.signal), stdout, stderr };
  return { kind: 'not-run', errno: errnoOf(result.error) };
}

/**
 * Unchanged in shape and in what it answers, deliberately — the three non-test
 * call sites bind to this signature, and `readJson`'s relationship to
 * `readJsonResult` (shared/fsjson.ts) is the precedent for keeping it that way.
 * Every non-`exited` outcome maps to `code: 1`, which is precisely what the
 * `typeof result.status === 'number' ? … : 1` it replaced already did.
 *
 * The one behavioural difference is the point of the change: a call that used
 * to hang forever now ends at EXEC_DEFAULT_TIMEOUT_MS and reports `code: 1`.
 */
function run(cmd: string, args: readonly string[], opts: ExecOptions = {}): ExecResult {
  const outcome = runResult(cmd, args, opts);
  return {
    code: outcome.kind === 'exited' ? outcome.code : 1,
    stdout: outcome.kind === 'not-run' ? '' : outcome.stdout,
    stderr: outcome.kind === 'not-run' ? '' : outcome.stderr,
  };
}

export const exec: Exec = { which, run, runResult };
