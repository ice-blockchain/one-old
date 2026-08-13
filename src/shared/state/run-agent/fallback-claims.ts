// src/shared/state/run-agent/fallback-claims.ts
// Legacy fallback claims over the owned-dir lock.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import { readRegularFileResult } from '../../bounded-read';
import { readJsonResult, writeJson } from '../../fsjson';
import { normalizeRelPath } from '../../scope';
import {
  SUBAGENT_STALE_MS,
} from '../../../config/state';
import { stateTimestamp } from '../io';

import {
  fallbackClaimFile,
  fallbackClaimsDir,
  runDir,
} from './run-paths';
import {
  withOwnedDirLock,
  withOwnedDirLockResult,
} from './locks';
import {
  type MutationResult,
} from './mutation-result';
import {
  isFreshTimestamp,
} from './session-identity';
import {
  type RunAgentContext,
} from './context-resolve';

const FALLBACK_CLAIMS_LOCK_TIMEOUT_MS = 2_000;
const FALLBACK_CLAIMS_LOCK_STALE_MS = 15_000;
const FALLBACK_CLAIMS_LOCK_RETRY_MS = 10;
const FALLBACK_CLAIMS_WAIT = new Int32Array(new SharedArrayBuffer(4));


function fallbackClaimsLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.claims.lock');
}

export function withFallbackClaimsLock(cwd: string, runId: string, mutate: () => void): boolean {
  return withOwnedDirLock(
    fallbackClaimsLockDir(cwd, runId),
    FALLBACK_CLAIMS_LOCK_TIMEOUT_MS,
    FALLBACK_CLAIMS_LOCK_STALE_MS,
    FALLBACK_CLAIMS_LOCK_RETRY_MS,
    FALLBACK_CLAIMS_WAIT,
    mutate,
  );
}

export function withFallbackClaimsLockResult<T>(
  cwd: string,
  runId: string,
  mutate: () => MutationResult<T>,
): MutationResult<T> {
  return withOwnedDirLockResult(
    fallbackClaimsLockDir(cwd, runId),
    FALLBACK_CLAIMS_LOCK_TIMEOUT_MS,
    FALLBACK_CLAIMS_LOCK_STALE_MS,
    FALLBACK_CLAIMS_LOCK_RETRY_MS,
    FALLBACK_CLAIMS_WAIT,
    mutate,
  );
}

interface FallbackClaimBackup {
  filePath: string;
  raw: string;
}

export function releaseFallbackClaimsForHolderUnlocked(
  cwd: string,
  runId: string,
  holder: string,
): { ok: boolean; removed: FallbackClaimBackup[] } {
  const dir = fallbackClaimsDir(cwd, runId);
  const removed: FallbackClaimBackup[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return obj(error)?.code === 'ENOENT'
      ? { ok: true, removed }
      : { ok: false, removed };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    // ONE READ, BOUNDED, AND THE BYTES THAT DECIDED ARE THE BYTES KEPT.
    //
    // This was a bounded `readJson(file, null)` followed three lines later by a
    // BARE `fs.readFileSync(file, 'utf8')` — so the site the census excused as
    // "a fallback-claims record under the project run directory" was in fact the
    // lstat-then-read window bounded-read.ts spends a paragraph arguing the
    // descriptor exists to close, reproduced as bounded-read-then-bare-read.
    // The second read was the one that reached the kernel with a path, and it
    // was the unbounded one: anybody who can write in this directory — which is
    // the population a claim file exists to arbitrate between — could substitute
    // the name between the two calls, and a FIFO or a device node put there
    // wedged the release with no deny and nothing logged.
    //
    // Reading once fixes both halves at their root. `raw` is the backup the
    // durable rebind journal replays, so it MUST be the bytes this decision was
    // made on; deriving it from a second read could have preserved a different
    // file than the one removed. An unreadable entry still falls through to the
    // next one, exactly as the `readJson` fallback already made it.
    const read = readRegularFileResult(file);
    if (read.kind !== 'text') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(read.text); } catch { continue; }
    const claim = obj(parsed);
    if (!claim || String(claim.runId || '') !== runId || claim.holder !== holder) continue;
    try {
      fs.rmSync(file, { force: true });
      removed.push({ filePath: file, raw: read.text });
    } catch {
      // The durable rebind journal owns forward recovery. Report the exact
      // partial deletion set instead of attempting rollback: restoring a subset
      // can itself fail and would erase the accounting needed for a safe retry.
      return { ok: false, removed };
    }
  }
  return { ok: true, removed };
}

// What the deny names when a claim file holds the path and cannot say who holds
// it. The prose it lands in ("already being written by `…` in this run") is
// authored in plan-guard/plan-runteam.ts and reads the holder verbatim, so this
// has to be a phrase rather than a token.
const UNIDENTIFIED_CLAIM_HOLDER = 'another writer (unreadable claim record)';

/**
 * A claim file whose bytes could not be PARSED (`corrupt`) or read at all
 * (`unreadable`) still OCCUPIES the path — and the lease it represents still
 * ages. `createdAt` is stamped by the write that created the file, so the file's
 * own mtime is the same clock read from outside the bytes: fresh by it means
 * somebody staked this path recently and we cannot see who; older than the same
 * SUBAGENT_STALE_MS bound the parsed branch applies means the lease expired
 * exactly as a readable one would have, and the next writer may take the path
 * (and, by writing, repair the file).
 *
 * `corrupt` and `unreadable` get the SAME answer here, unlike normalize.ts's
 * quarantine rule where they are opposites. The discriminator there is "can the
 * bytes be preserved before they are replaced", and a claim has no content worth
 * preserving — it is a lease, not a record. The only question this site asks is
 * whether the lease is live, and mtime answers it identically for both.
 */
function unreadableClaimStillHolds(file: string): boolean {
  try {
    return isFreshTimestamp(fs.statSync(file).mtime.toISOString(), SUBAGENT_STALE_MS);
  } catch {
    // Nothing stattable at the path any more (it was removed between the read
    // and here, or it is a dangling link): no evidence of a holder, so this
    // falls through to the ordinary claim write, which is itself fenced.
    return false;
  }
}

/**
 * TWO QUESTIONS, AND A CALLER MAY WANT ONLY THE FIRST. "Who holds this path?"
 * is a CHECK; "this session now holds it" is a RECORD. They travelled together
 * until a caller appeared that must ask one without the other: plan-guard's
 * dispatcher judges a write it is going to REFUSE, and a refused write may not
 * stake a lease that locks the path to this session for the rest of the run —
 * while the ownership conflict itself is exactly what that write's author needs
 * to be told.
 *
 * Suppressing the whole call to suppress the record is what conflated them, and
 * it was MEASURED as a withheld deny: a path already held by one child, written
 * by another with an unrelated static violation, reported the static rule alone
 * where the same fixture with clean content reported the conflict — so the
 * conflict went missing precisely when another violation coexisted, the author
 * fixed the static rule and only then learned the path belongs to somebody
 * else, and the two denies landed in different repeat-escalation buckets
 * (shared/state/deny-repeat.ts signs a refusal with the whole rendered reason).
 *
 * `record: false` therefore changes NOTHING about the answer — the same lock,
 * the same read, the same holder test, the same `blocked`/`holder` pair — and
 * only declines to write the claim file when the path is free.
 */
export function tryFallbackClaim(
  cwd: string,
  ctx: RunAgentContext,
  target: string,
  options: { record?: boolean } = {},
): { blocked: boolean; holder?: string } {
  const record = options.record !== false;
  const runId = ctx && ctx.runId != null ? String(ctx.runId) : '';
  if (!runId) return { blocked: false };
  if (isNonProjectRoot(cwd)) return { blocked: false }; // no claim files in the plugin's own repo
  const myKey = String(ctx.sessionId || ctx.claimId || ctx.role || '');
  const file = fallbackClaimFile(cwd, runId, normalizeRelPath(target));
  let result: { blocked: boolean; holder?: string } = { blocked: false };
  const locked = withFallbackClaimsLock(cwd, runId, () => {
    const read = readJsonResult<Rec>(file);
    const existing = read.kind === 'ok' ? obj(read.value) : null;
    if (existing
      && isFreshTimestamp(existing.createdAt, SUBAGENT_STALE_MS)
      && typeof existing.holder === 'string' && existing.holder
      && existing.holder !== myKey) {
      result = { blocked: true, holder: existing.holder };
      return;
    }
    // The `null` fallback this used to read through collapsed "nobody holds
    // this path" into "I cannot tell who holds this path", and only the first
    // of those licenses a claim. A corrupt or unreadable claim file made
    // `existing` falsy, so the holder check above was SKIPPED entirely and the
    // caller overwrote a lease it never inspected: the thief was allowed to
    // write, and the original holder — still writing, never told — was denied on
    // its own path the next time it asked. Two roles on one file, with the deny
    // pointing at the wrong one.
    if (read.kind !== 'ok' && read.kind !== 'absent' && unreadableClaimStillHolds(file)) {
      result = { blocked: true, holder: UNIDENTIFIED_CLAIM_HOLDER };
      return;
    }
    // The path is free. A caller that only asked WHO holds it stops here: it has
    // its answer, and taking the lease would be an authority this write is not
    // going to earn.
    if (!record) return;
    const claim: Rec = {
      version: 1,
      runId,
      path: normalizeRelPath(target),
      holder: myKey,
      role: typeof ctx.role === 'string' ? ctx.role : null,
      sessionId: ctx.sessionId || null,
      createdAt: stateTimestamp(),
    };
    try {
      fs.mkdirSync(fallbackClaimsDir(cwd, runId), { recursive: true });
      writeJson(file, claim);
    } catch {
      // best-effort lock; never block the writer on a lock-write failure
    }
  });
  return locked ? result : { blocked: false };
}

