// src/shared/state/run-agent/run-paths.ts
// Run-id minting, runs/ path helpers, the ledger fingerprint cache
// (process singleton), and small value utilities.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { STATE_FILE } from '../../../config/paths';
import { parseJson, readJson, readText } from '../../fsjson';
import {
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
} from '../../../config/state';
import {
  stackFingerprint,
  UNKNOWN_STACK_FINGERPRINT,
} from '../materialization';
import { writeState } from '../normalize';
import { withProjectStateLock } from '../project-state-lock';
import {
  activeRunClaimCount,
  effectiveLegacyRunStatus,
} from '../../run-settlement';
import {
  ensureArchitectureRunSnapshot,
} from '../../architecture-contract';
import {
  ensureRunAgentClaim,
} from './claims-store';
import {
  ensureRunLedger,
} from './ledger';

export function runIdNow(): string {
  return Date.now().toString();
}

// True when `.one.json` EXISTS but cannot be parsed. `readJson` hides this by
// returning the same `{}` it returns for an absent file, and a caller that
// treats the two alike mints a fresh run id over live run state.
function stateFileDegraded(cwd: string): boolean {
  const rawText = readText(path.join(cwd, STATE_FILE));
  if (rawText === null) return false;
  if (!rawText.trim()) return false;
  return !obj(parseJson<Rec | null>(rawText, null));
}

// Ensure the project has a currentRunId, WITHOUT the full run-claim ceremony.
// The OpenCode delegation gate runs in all modes and scopes its per-role attempt
// marker by currentRunId, but ensureRunAgentClaim (which mints one) is reached
// only on the new-project path — so on existing-codebase projects a configured
// delegate role would slip past the gate whenever the orchestrator hasn't already
// persisted a run id (e.g. a fresh materialization, or an interrupted/resumed
// session that skipped Phase 0). Mirrors ensureRunAgentClaim's persist pattern;
// writeState splits local prefs back out, so .one.json stays canonical. Returns
// the existing or newly minted run id.
export function ensureCurrentRunId(cwd: string, state: unknown): string {
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  const existing = typeof source.currentRunId === 'string'
    ? source.currentRunId.trim()
    : (typeof source.currentRunId === 'number' && Number.isFinite(source.currentRunId) ? String(Math.trunc(source.currentRunId)) : '');
  if (existing) {
    // Reading/freezing policy for an existing id is not itself a resume. In
    // particular SessionStart calls this on every subagent-enabled project.
    // Actual worker claims and the unresolved-run continue path activate the
    // ledger and upgrade legacy evidence semantics at their action boundary.
    try {
      ensureArchitectureRunSnapshot(cwd, existing, source);
    } catch {
      // Spawn/PLAN_READY preflight retries fail-closed with a concrete error.
    }
    return existing;
  }
  // Mint-once: serialize the check-and-mint with every canonical .one.json
  // writer and RE-READ the on-disk state under the lock. Parallel first tool
  // calls each run their own hook process off a pre-mint state snapshot; each
  // minting independently produced three runs/<id>/ trees with divergent model
  // policies in one session (observed 13c-codex — the orchestrator then read an
  // orphan policy id and the run-id gate denied its first spawn). Late arrivals
  // must ADOPT the persisted id, not mint a sibling.
  let runId = '';
  let minted = false;
  // An id this function hands back is a promise that the NEXT disk read finds it:
  // every consumer that does not call back through here reads `currentRunId`
  // straight off `.one.json` (core/pipeline.ts's decision correlation,
  // plan-write's compiled-architecture lookup, codex-child-model, the doctor and
  // run-status runners, isSubagentSession). A refused persist breaks that promise
  // silently, and the id keeps being re-derived from `runs/` only for as long as
  // the run stays adoptable — after which the next call MINTS A SIBLING, which is
  // the 11c/14c incident this whole function exists to prevent. So a refused
  // persist clears the id and takes the documented fail-closed exit below
  // (`return ''`), which agent-model/handler.ts turns into a spawn deny rather
  // than letting a run proceed under an id nothing on disk carries.
  const mint = () => {
    const candidate = runIdNow();
    source.currentRunId = candidate;
    if (!writeState(cwd, source)) {
      delete source.currentRunId;
      return;
    }
    runId = candidate;
    minted = true;
  };
  try {
    withProjectStateLock(cwd, () => {
      // `readJson` collapses "absent", "torn", and "unparseable" into the same
      // `{}`. Only ABSENT means "new project, mint one"; an unreadable state
      // file must never mint, because the sibling run it creates strands every
      // live child and its ledger inherits a fabricated identity.
      const statePath = path.join(cwd, STATE_FILE);
      const rawText = readText(statePath);
      const parsed = rawText === null ? null : parseJson<Rec | null>(rawText, null);
      const degraded = rawText !== null && rawText.trim().length > 0 && !obj(parsed);
      const onDisk = obj(parsed) || {};
      const diskRaw = onDisk.currentRunId;
      const diskId = typeof diskRaw === 'string'
        ? diskRaw.trim()
        : (typeof diskRaw === 'number' && Number.isFinite(diskRaw) ? String(Math.trunc(diskRaw)) : '');
      if (diskId) {
        runId = diskId;
        source.currentRunId = diskId;
        return;
      }
      if (degraded) {
        // Fail closed: adopt a live run if one exists, otherwise return '' and
        // let the caller's gate refuse with a concrete error. Writing a fresh id
        // over a corrupt state file is how run state splits in the first place.
        runId = recentAdoptableRunId(cwd);
        if (runId) source.currentRunId = runId;
        return;
      }
      // Second line of defense against a re-mint: a writer that rewrote
      // .one.json WITHOUT currentRunId (blanking it — 11c F1 residual observed
      // 14c: a fresh id was minted 3.7s after the first while three spawn-gate
      // ledgers already existed) makes the disk read above miss the live run.
      // Adopt a recent planned spawn-gate ledger from runs/ and RE-PERSIST it
      // instead of minting a sibling. Bounded to a fresh window so an existing
      // project's ancient run is never resurrected (its currentRunId is set, so
      // it never reaches here anyway).
      const adoptable = recentAdoptableRunId(cwd);
      if (adoptable) {
        source.currentRunId = adoptable;
        // Re-persist the blanked id (re-enters the held lock). Adoption without
        // the re-persist is not adoption: `.one.json` still reads blank, so the
        // adoption has to be re-derived on every later call and stops working the
        // moment the run leaves recentAdoptableRunId's window. Fail closed instead.
        if (!writeState(cwd, source)) {
          delete source.currentRunId;
          return;
        }
        runId = adoptable;
        return;
      }
      mint(); // writeState re-enters the already-held project-state lock
    });
  } catch {
    // Lock acquisition failed (timeout/contention edge): keep the previous
    // unserialized behavior rather than failing the caller's hook outright —
    // but still never mint over an unreadable state file.
    //
    // The recovery needs a guard of its own because it RE-ENTERS what just
    // failed: `mint` publishes through `writeState`, and `writeState` takes this
    // same lock. There is no unserialized route to disk from here, so whatever
    // refused the acquisition refuses again one line later — and re-raises past
    // the `catch` written to stop exactly that. Measured twice, each beside a
    // writable control that mints normally: `.traffic-one/` at 0o555 raises
    // EACCES from the lock's staging mkdir, and a lock held by a live owner
    // spends a second full 1000 ms deadline and raises its own timeout — the
    // contention edge the sentence above names, which this arm has therefore
    // never once handled.
    //
    // Unguarded, PreToolUse turned that into `pipeline-handler-crashed` (a deny
    // no gate chose), and every other event dropped the throw out of the pipeline
    // entirely — including the SessionStart call every subagent project makes.
    // Guarded, the function reaches its designed `return ''` and the caller's own
    // fail-closed branch decides. Nothing is hidden that `mint` could have
    // reported: its only channel is persisted-or-not, and it already takes the
    // second branch silently when `writeState` answers `false`. WHEN a mint is
    // attempted does not move — both "never mint over an unreadable state file"
    // conjuncts still gate the call, and `stateFileDegraded` stays outside the
    // guard because it cannot throw.
    if (!runId && !stateFileDegraded(cwd)) {
      try {
        mint();
      } catch {
        // An id that cannot be persisted is the `return ''` below, not a throw.
      }
    }
  }
  // Fail closed: no id could be resolved without fabricating one. Callers gate
  // on the empty string and surface a concrete repair instead of proceeding.
  if (!runId) return '';
  if (minted) {
    ensureRunLedger(cwd, runId, { status: 'planned', kind: 'spawn-gate', ...stackFingerprintPatch(cwd, runId, source) });
  }
  // Freeze runtime-owned capabilities and the immutable baseline as soon as
  // the run id exists. Bootstrap preflight repeats this fail-closed; this early
  // capture also covers main-agent runs that never spawn a child.
  try {
    ensureArchitectureRunSnapshot(cwd, runId, source);
  } catch {
    // Run-id minting remains recoverable. Spawn/PLAN_READY preflight performs
    // the same capture and refuses progress with a concrete contract error.
  }
  // Keep the caller's in-memory `state` in sync so a later ensureRunAgentClaim (which
  // reads currentRunId off the SAME state object) reuses THIS id instead of minting a
  // second one. Without this the spawn's run markers (OpenCode attempts, model
  // advisory/choice) land under an orphaned id that never matches the persisted
  // currentRunId that subsequent gate calls read back.
  if (obj(state)) (state as Rec).currentRunId = runId;
  return runId;
}

export function safePathSegment(value: unknown): string {
  const segment = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
  // `.` and `..` survive the character allowlist but are never safe directory
  // names. Keep legacy sanitization behavior while preventing path traversal.
  if (segment === '.') return '_';
  if (segment === '..') return '__';
  return segment;
}

export function runsRoot(cwd: string): string {
  return path.join(cwd, RUNS_REL_DIR);
}
export function runDir(cwd: string, runId: string): string {
  return path.join(runsRoot(cwd), safePathSegment(runId));
}
export function runLedgerFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'run.json');
}

// A run's stack identity is frozen at ledger mint and never recomputed. Claims
// are validated against THIS, not against a live recompute of `.one.json`:
// detection derives the live fingerprint from the project's own files, so the
// team scaffolding the app it was told to build (empty dir -> Laravel adds
// `resources/views`, flipping `frontend: none -> other`) used to change the very
// identity that binds the team to its run, silently unbinding every role agent
// mid-build with no log and no repair. Frozen-to-frozen equality keeps the
// original intent — a claim from a different project identity still cannot leak
// in, because a different identity gets its own run with its own frozen value.
const RUN_LEDGER_FINGERPRINT_CACHE = new Map<string, string>();

function runLedgerFingerprintCacheKey(cwd: string, runId: string): string {
  return `${cwd}\u0000${runId}`;
}

export function invalidateRunLedgerFingerprint(cwd: string, runId: string): void {
  RUN_LEDGER_FINGERPRINT_CACHE.delete(runLedgerFingerprintCacheKey(cwd, runId));
}

export function runLedgerFingerprint(cwd: string, runId: unknown): string {
  if (typeof runId !== 'string' || !runId) return '';
  const key = runLedgerFingerprintCacheKey(cwd, runId);
  const cached = RUN_LEDGER_FINGERPRINT_CACHE.get(key);
  if (cached !== undefined) return cached;
  const ledger = obj(readJson(runLedgerFile(cwd, runId), null));
  const frozen = ledger && typeof ledger.stackFingerprint === 'string' ? ledger.stackFingerprint : '';
  RUN_LEDGER_FINGERPRINT_CACHE.set(key, frozen);
  return frozen;
}

// Stamp the run's frozen identity rather than inventing one from the caller's
// state: a degraded read must leave the field ABSENT (already tolerated by the
// claim check, which then falls back to run-id scoping) instead of persisting a
// fabricated `minimal|none|none|none` that mismatches forever after.
function identityForStamp(cwd: string, runId: unknown, state: unknown): string | undefined {
  const frozen = runLedgerFingerprint(cwd, runId);
  if (frozen) return frozen;
  const live = stackFingerprint(state);
  return live === UNKNOWN_STACK_FINGERPRINT ? undefined : live;
}

export function stackFingerprintPatch(cwd: string, runId: unknown, state: unknown): Rec {
  const fingerprint = identityForStamp(cwd, runId, state);
  return fingerprint ? { stackFingerprint: fingerprint } : {};
}

// Newest recently-minted planned spawn-gate run (or rollback-guarded in-flight
// V2 run) under runs/, or '' when none. Used only as the mint fallback when
// .one.json carries no currentRunId: adopt an in-flight run rather than mint a
// sibling. Bounded to a fresh window (and never a future id) so an existing
// project's older run is not resurrected.
const RUN_ADOPT_WINDOW_MS = 10 * 60 * 1000;
function recentAdoptableRunId(cwd: string, nowMs: number = Date.now()): string {
  let best = '';
  let bestVal = 0;
  try {
    for (const name of fs.readdirSync(runsRoot(cwd))) {
      if (!/^\d{13}$/.test(name)) continue; // epoch-ms mint ids only
      const val = Number(name);
      if (!Number.isFinite(val) || val <= bestVal) continue;
      if (val - nowMs > 60_000) continue; // never a future id
      const ledger = readJson<Rec>(runLedgerFile(cwd, name), null as unknown as Rec);
      if (!ledger) continue;
      const effectiveStatus = effectiveLegacyRunStatus(ledger);
      // A terminal run is never resurrected, whatever its kind.
      if (effectiveStatus && effectiveStatus !== 'planned' && effectiveStatus !== 'active') continue;
      // Live claims mean this is the run we are ALREADY in — the spawn-gate
      // kind filter used to exclude exactly that case, so a blanked
      // `currentRunId` minted a sibling run beside a working team and stranded
      // every live child in a run with no architecture, assignments, or
      // bootstraps (observed test-laravel: `1785169657252` had all of them and
      // two live claims; `1785172002942` was minted anyway). A truncated scan
      // reports a conservative >= 1, which biases toward adoption — the safe
      // direction here.
      const live = activeRunClaimCount(cwd, name) > 0;
      if (!live && ledger.kind !== 'spawn-gate') continue;
      if (!live && effectiveStatus === 'active' && ledger.qaContractVersion !== 2) continue;
      // Widen the window while claims are live: a build turn easily outlives
      // the 10-minute mint window, and adopting is strictly safer than minting.
      const windowMs = live ? SUBAGENT_STALE_MS : RUN_ADOPT_WINDOW_MS;
      if (nowMs - val > windowMs) continue;
      best = name;
      bestVal = val;
    }
  } catch {
    // runs/ absent or unreadable — nothing to adopt.
  }
  return best;
}
export function pendingDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'pending');
}
export function runAgentFile(cwd: string, runId: string, sessionId: string): string {
  return path.join(runDir(cwd, runId), `${safePathSegment(sessionId)}.json`);
}
export function assignmentsFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'assignments.json');
}
export function fallbackClaimsDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'claims');
}
export function fallbackClaimFile(cwd: string, runId: string, target: string): string {
  return path.join(fallbackClaimsDir(cwd, runId), `${safePathSegment(target)}.json`);
}
export function authoritativeRebindJournalFile(cwd: string, runId: string, threadId: string): string {
  return path.join(runDir(cwd, runId), 'transactions', `rebind-${safePathSegment(threadId)}.json`);
}


export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// Cursor 3.12.30 leaks an HTTP chunk-length line into the spawn identity: observed
// live as `subagent_id` AND `tool_call_id` = "16\nfc_otWVB6Z-…" on one spawn and
// "78\nfc_otWf1Ee-…" on another (the number varies, which is what identifies it as
// a chunk header rather than part of the id). Stored verbatim, such an id is a
// multi-LINE ledger key: it is not the documented `tool_<uuid>` shape, it corrupts
// any single-line log or message that embeds it, and two spellings of the same
// spawn (one sanitized upstream by the host, one not) would never compare equal.
// Keep the LAST non-empty line and drop a pure hex/decimal length prefix.
export function normalizeHostCallId(value: unknown): string | null {
  const raw = firstString(value);
  if (!raw) return null;
  if (!raw.includes('\n') && !raw.includes('\r')) return raw;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  // A leading bare length token is the chunk header; anything else we keep as-is
  // (last line wins) rather than guessing at an unknown multi-line shape.
  const last = lines[lines.length - 1]!;
  return last;
}

export function nestedValue(source: unknown, keys: string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Rec)[key];
  }
  return current;
}

export function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// Codex reports the orchestrator's session_id in every hook payload — even for
// subagent threads — so session_id can't tell threads apart. The only per-thread
// discriminator is transcript_path, whose rollout filename ends with the running
// thread's id (the child's `agent_id`). Parse that canonical UUID.
