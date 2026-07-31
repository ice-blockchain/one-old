// src/runners/opencode/run-model.ts
// One model against one task in a fresh throwaway worktree, plus the digest
// writer for landed units.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {  maxConsecutiveStalls, opencodeUnitTimeoutMs } from '../../config/opencode-timeouts';
import { spawnTool } from '../../shared/spawn-tool';
import { roleDigestName } from '../../shared/packing';
import { nowIso } from '../../shared/text';

import {
  DIGEST_HARD_BYTES,
  MAX_DELEGATE_ATTEMPTS,
  OPENCODE_RUN_ENV,
  RUN_TIMEOUT_MS,
  T1_DIR,
  which,
} from './types';
import {
  backupApplyTargets,
  formatError,
  git,
  parseNameStatusZ,
  parseNulPaths,
  removeWorktree,
  restoreApplyTargets,
  stageExcludePathspecs,
  uniquePaths,
  type ApplyTargetBackup,
} from './git-sandbox';
import {
  postApplyQuality,
  postApplyI18n,
  postApplySize,
  postApplyStyling,
  postApplyTypecheck,
} from './verify';
import {
  parseStream,
  shouldTryNextModel,
} from './models';
import {
  validateDelegatedDiff,
  type DelegatedDiffPolicy,
} from './diff-policy';

export function runStamp(): string {
  // Matches the orchestrator's run-id shape (YYYY-MM-DDTHH-MM-SSZ); only used
  // when the caller doesn't pass --run-id (standalone/tests).
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

// One record per delegated model run, kept per digest role so a multi-unit
// batch renders ALL of its work. Units of the same role are processed
// sequentially inside a single role shard, so this read-modify-write is the
// only writer of a given file.
interface DelegatedDigestUnit {
  model: string;
  at: string;
  touched: string[];
  summary: string;
}

const MAX_DIGEST_UNITS = 20;
const DIGEST_SUMMARY_BUDGET = 900;
const DIGEST_TOUCHED_LINES = 20;

function digestUnitsPath(cwd: string, runId: string, digestRole: string): string {
  return path.join(cwd, T1_DIR, 'runs', runId, 'opencode-digest-units', `${digestRole}.json`);
}

function parseDigestUnit(value: unknown): DelegatedDigestUnit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.model !== 'string' || typeof rec.at !== 'string') return null;
  return {
    model: rec.model,
    at: rec.at,
    touched: Array.isArray(rec.touched) ? rec.touched.filter((f): f is string => typeof f === 'string') : [],
    summary: typeof rec.summary === 'string' ? rec.summary : '',
  };
}

// Every landed unit used to OVERWRITE the same digest path, so a four-unit
// frontend batch (12 files) shipped a digest naming only the last unit's three
// files and three units' work was invisible (observed live). Accumulate instead.
function accumulateDigestUnits(
  cwd: string,
  runId: string,
  digestRole: string,
  unit: DelegatedDigestUnit,
): DelegatedDigestUnit[] {
  const filePath = digestUnitsPath(cwd, runId, digestRole);
  let prior: DelegatedDigestUnit[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) {
      prior = parsed.map(parseDigestUnit).filter((u): u is DelegatedDigestUnit => Boolean(u));
    }
  } catch {
    // first unit for this role (or an unreadable ledger) — start fresh
  }
  const next = [...prior, unit].slice(-MAX_DIGEST_UNITS);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort ledger; the digest below still renders this unit
  }
  return next;
}

// Truncate on a WORD boundary and never mid-token inside a backticked
// identifier — the old raw `.slice(0, 400)` cut a summary in the middle of a
// `path/like.this` span and left an unbalanced backtick in the digest
// (observed live).
function clampSummary(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  if ((cut.match(/`/g) || []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('`'));
  return `${cut.replace(/[\s,;:]+$/, '')}…`;
}

export function writeDigest(cwd: string, runId: string, role: string, model: string, touched: string[], summary: string, opts?: { planUnit?: boolean }): string {
  const dir = path.join(cwd, '.traffic-one', 'digests', runId);
  fs.mkdirSync(dir, { recursive: true });
  // Same filename rule as every other digest writer/reader (senior-frontend →
  // frontend.md): successor roles and the build-complete verification heuristic
  // look for the stripped name, so the full role string would hide the digest.
  const planUnit = Boolean(opts?.planUnit);
  const digestRole = planUnit ? `opencode-${roleDigestName(role)}` : roleDigestName(role);
  const units = accumulateDigestUnits(cwd, runId, digestRole, {
    model,
    at: nowIso(),
    touched,
    summary: summary || 'OpenCode applied the delegated change.',
  });
  const allTouched: string[] = [];
  for (const unit of units) {
    for (const file of unit.touched) if (!allTouched.includes(file)) allTouched.push(file);
  }
  const touchedLines = allTouched.slice(0, DIGEST_TOUCHED_LINES).map((f) => `- ${f}        # delegated edit`).join('\n')
    + (allTouched.length > DIGEST_TOUCHED_LINES ? `\n- … +${allTouched.length - DIGEST_TOUCHED_LINES} more` : '');
  const perUnitBudget = Math.max(120, Math.floor(DIGEST_SUMMARY_BUDGET / units.length));
  const summaryLines = units.map((unit, index) => (
    `- unit ${index + 1} (${unit.model}, ${unit.touched.length} file${unit.touched.length === 1 ? '' : 's'}): ${clampSummary(unit.summary, perUnitBudget)}`
  )).join('\n');
  // The runner cannot honestly claim a role's canonical verdict (TESTS_GREEN /
  // IMPLEMENTED) — it applied a diff, it did not verify anything. A WHOLE-ROLE
  // delegation writes the role's own digest, so it carries DELEGATED_OK plus an
  // explicit normalization hint and the orchestrator does the one-line verdict
  // edit itself after ITS verification passes (observed live: without the hint
  // it spawned a whole paid agent just to rewrite this line). A PLAN-UNIT digest
  // is not the role's digest — it is this run's ledger of delegated units, and
  // the role's own `<role>.md` carries the verdict — so it deliberately carries
  // no normalize_to: the hint sat there unapplied on every run, and after
  // accumulation a single "normalize me" line cannot speak for N units.
  const canonical = roleDigestName(role) === 'tester' ? 'TESTS_GREEN' : 'IMPLEMENTED';
  const body = [
    `# ${role} digest — run ${runId}`,
    '',
    'verdict: DELEGATED_OK',
    ...(planUnit
      ? []
      : [`normalize_to: ${canonical} — once the orchestrator's own verification passes, edit the verdict line above to this canonical token (one-line edit; do NOT spawn an agent for it)`]),
    `finished_at: ${units[units.length - 1]!.at}`,
    `delegated_to: opencode (${[...new Set(units.map((u) => u.model))].join(', ')})`,
    `delegated_units: ${units.length}`,
    '',
    '## Touched',
    touchedLines || '- (none)',
    '',
    '## Summary',
    summaryLines,
    '',
    '## Open questions / blockers / assumptions',
    '- Changes produced by OpenCode (free model). Reviewer MUST verify the diff before commit.',
    ...(planUnit
      ? [`- Delegated plan units only — the run verdict for this role lives in \`${roleDigestName(role)}.md\`.`]
      : []),
    '',
  ].join('\n');
  const p = path.join(dir, `${digestRole}.md`);
  fs.writeFileSync(p, body.slice(0, DIGEST_HARD_BYTES), 'utf8');
  return p;
}

type ModelRunOutcome =
  | { kind: 'delegated'; touched: string[]; summary: string }
  | { kind: 'try-next'; error: string }      // server/model-side error → try the next model
  | { kind: 'stalled'; error: string }       // spawn timeout / killed CLI → try the next model, capped at maxConsecutiveStalls()
  | { kind: 'failed'; error: string }        // terminal: environmental/process/apply failure
  | { kind: 'no-changes' };                  // terminal: model ran clean but produced nothing

// Run one model against the task in a FRESH throwaway worktree (created here,
// removed here). A fresh worktree per model — rather than resetting one — wipes
// every residue class at once: commits the model may have made, gitignored
// build output, lockfiles. On success the staged diff (vs baseSha) is applied
// to the real working tree before returning.
export function runModel(cwd: string, bin: string, baseSha: string, model: string, task: string, policy: DelegatedDiffPolicy, onCliAttempt?: () => void): ModelRunOutcome {
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
    const timeoutMs = Math.min(opencodeUnitTimeoutMs(), RUN_TIMEOUT_MS);
    let summary = '';
    // Retry only a CLEAN no-op (the weak model occasionally produces nothing). A
    // gateway error or process failure won't fix itself on retry, so bail at once.
    for (let attempt = 1; attempt <= MAX_DELEGATE_ATTEMPTS; attempt++) {
      onCliAttempt?.();
      // spawnTool: `bin` is the managed opencode.cmd shim on Windows (Node >=22
      // refuses a bare .cmd without it); an absolute .exe/PATH bin passes through.
      const run = spawnTool(bin, runArgs, {
        cwd: wt,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        env: { ...process.env, ...OPENCODE_RUN_ENV, PWD: wt },
      });
      if (run.error || run.status === null) {
        // A stall — our spawn timeout fired (ETIMEDOUT) or the CLI died to a
        // signal without ever answering — is MODEL-CLASS: the hosted free models
        // hang individually (observed live: the chain head ETIMEDOUT while other
        // free models answered), so the walk must advance instead of failing the
        // whole delegation. delegate() caps back-to-back stalls at
        // maxConsecutiveStalls() because a stalled GATEWAY makes every probe
        // burn the full unit timeout.
        const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ETIMEDOUT' || (!run.error && run.status === null)) {
          const detail = run.error ? `ETIMEDOUT after ${timeoutMs}ms` : `killed with ${run.signal || 'unknown signal'}`;
          return { kind: 'stalled', error: `opencode run stalled: ${detail}` };
        }
        // Genuine spawn failure (ENOENT/EACCES/…): a different model cannot help.
        return { kind: 'failed', error: `opencode run failed: ${(run.error as Error).message}` };
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
      git(wt, ['add', '-A', '--', '.', ...stageExcludePathspecs(wt)]);
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
    const validationError = validateDelegatedDiff(applyTargets, policy);
    if (validationError) {
      return { kind: 'failed', error: validationError };
    }
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
    const i18nError = postApplyI18n(cwd, touched, policy.runId, policy.role);
    if (i18nError) {
      const rollbackError = restoreApplyTargets(backups);
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : ' — reverted, tree untouched';
      return { kind: 'failed', error: `delegated diff applied but violated the i18n contract${suffix}: ${i18nError}` };
    }
    const verifyError = postApplyTypecheck(cwd, touched);
    if (verifyError) {
      const rollbackError = restoreApplyTargets(backups);
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : ' — reverted, tree untouched';
      return { kind: 'failed', error: `delegated diff applied but typecheck failed${suffix}: ${verifyError}` };
    }
    const qualityError = postApplyQuality(cwd, touched);
    if (qualityError) {
      const rollbackError = restoreApplyTargets(backups);
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : ' — reverted, tree untouched';
      return { kind: 'failed', error: `delegated diff applied but landed collapsed source${suffix}: ${qualityError}` };
    }
    const stylingError = postApplyStyling(cwd, touched, policy.runId);
    if (stylingError) {
      const rollbackError = restoreApplyTargets(backups);
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : ' — reverted, tree untouched';
      return { kind: 'failed', error: `delegated diff applied but used a styling system the project does not have${suffix}: ${stylingError}` };
    }
    // Enforced here as well as at write time: a module Step-0 accepts but the
    // structural gate refuses leaves its owning role holding a file it cannot
    // legally edit.
    const sizeError = postApplySize(cwd, touched);
    if (sizeError) {
      const rollbackError = restoreApplyTargets(backups);
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : ' — reverted, tree untouched';
      return { kind: 'failed', error: `delegated diff applied but landed an oversized module${suffix}: ${sizeError}` };
    }
    return { kind: 'delegated', touched, summary };
  } finally {
    removeWorktree(cwd, parent, wt);
  }
}
