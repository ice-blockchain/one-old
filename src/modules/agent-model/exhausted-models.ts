// src/modules/agent-model/exhausted-models.ts
// Run-scoped record of subagent models that hit an API/usage/rate limit this
// session, keyed by role. Correlated Cursor child-transcript reconciliation and
// synchronous spawn results populate it; the PreToolUse retry path remains the
// backstop when a host omits its post-Task/stop event. Keeping the evidence
// outside the live-agent registry lets reconciliation retire a false-active
// agent without losing the model/tier rotation anchor. The next spawn gate can
// then refuse the exhausted family instead of repeating the incident's loop on
// gpt-5.6-terra-medium.
//
// Entries EXPIRE (EXHAUSTED_MODEL_TTL_MS): a transient rate-limit/429 usually
// clears in minutes, and a permanent per-run condemnation would force the whole
// role off the user's picked model for the entire build over a momentary
// throttle. A model whose budget is genuinely gone simply re-trips the limit
// after expiry and is re-recorded — one extra failed spawn per TTL window is
// the cost of never permanently over-reacting to a transient.
//
// Storage mirrors model-choice.ts: a tiny JSON file under
// `.traffic-one/runs/<runId>/`, best-effort, never throwing. Run-scoped means a
// new build starts with a clean slate (no cross-run staleness).

import * as fs from 'fs';
import * as path from 'path';

import { isNonProjectRoot } from '../../shared/authoring-root';
import { trustworthyAgeSince } from '../../shared/clock-skew';
import { writeJson } from '../../shared/fsjson';
import { modelMatchesExpected } from '../../shared/model-tiers';

// Compatibility re-export: existing spawn gates imported the shared matcher
// from this module before failure-classify.ts became the single source of truth.
export { isApiUsageLimitText } from './failure-classify';

// How long a limit-hit model stays condemned. Long enough that an orchestrator
// retry loop cannot thrash back onto a dead model within one fix cycle; short
// enough that a transient throttle does not cost the model for the whole build.
export const EXHAUSTED_MODEL_TTL_MS = 10 * 60 * 1000;

interface ExhaustedEntry {
  model: string;
  // ISO timestamp of the recording. Legacy entries (bare strings from builds
  // ≤2.9.255) have no timestamp and never expire within the run — safer than
  // silently un-condemning them on upgrade.
  at?: string;
}

interface ExhaustionTerminalMarker {
  // Diagnostic only. Unlike model entries, a terminal marker does NOT expire:
  // otherwise a fully exhausted role would restart its rotation every 10 min.
  at?: string;
}

interface ExhaustedRoleState {
  entries: ExhaustedEntry[];
  terminal?: ExhaustionTerminalMarker;
}

interface ExhaustedStoreV2 {
  version: 2;
  roles: Record<string, ExhaustedRoleState>;
}

const STORE_LOCK_TIMEOUT_MS = 500;
const STORE_LOCK_RETRY_MS = 5;
const STORE_LOCK_STALE_MS = 10_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function exhaustedPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(WAIT_BUFFER, 0, 0, ms);
}

// Canonical definition: shared/state/run-agent/locks.ts. Copied rather than
// shared because consolidating this repo's liveness predicates is its own wave.
// The direction that must never be flipped: `kill(pid, 0)` raising EPERM means
// the process EXISTS but is owned by another uid — alive, and its lease may not
// be taken. Only ESRCH proves death. Pinned across every copy by
// shared/__tests__/process-liveness-eperm.test.ts.
function processDefinitelyDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// The lock file's single line, `<pid> <acquiredAtMs> [token]`. It was already
// being WRITTEN in this shape and never read back: the stale check below used to
// consult only the file's mtime, so a hook holding the lock for longer than
// STORE_LOCK_STALE_MS had it unlinked and a second writer walked in. The
// trailing token is new and absent from files written by earlier builds, which
// parse fine without it.
function readLockHolder(lockPath: string): { pid: number; at: number; token: string } | null {
  let parts: string[];
  try {
    parts = fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/);
  } catch {
    return null;
  }
  const pid = Number(parts[0]);
  const at = Number(parts[1]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at) || at <= 0) return null;
  return { pid, at, token: parts[2] ?? '' };
}

// Read-modify-write operations can run in parallel hook processes (for example,
// architect and backend failing together). Serialize them with a short, stale-
// recoverable lock; writeJson then publishes the complete JSON atomically.
//
// Reclaim demands BOTH an aged acquisition and a holder that is provably gone.
// The unlink is safe to race: whichever reaper wins it, every contender then
// goes back to the O_EXCL create, which is the real compare-and-swap and admits
// exactly one of them.
function withStoreLock<T>(cwd: string, runId: string, busyFallback: T, body: () => T): T {
  const filePath = exhaustedPath(cwd, runId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid} ${Date.now()} ${token}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Not contention — the path is unusable (no directory, read-only, …).
        // Deliberately NOT unlinking here any more: the old code removed a lock
        // it had just failed to create, which on a transient error destroyed a
        // healthy holder's lease as a side effect of our own failure.
        return busyFallback;
      }
      const holder = readLockHolder(lockPath);
      try {
        const ageMs = holder
          ? trustworthyAgeSince(holder.at, Date.now())
          // No parseable holder line at all: an empty or truncated file from a
          // writer that died between create and write. Nothing claims it, so
          // age alone is the only evidence available and is enough.
          : trustworthyAgeSince(fs.statSync(lockPath).mtimeMs, Date.now());
        // A stamp ahead of now makes `Date.now() - at` negative, and a negative
        // age is never `> STALE`, so a lock whose holder is provably dead could
        // never be reclaimed and every recorder silently returned busyFallback
        // for the rest of the run — the model ledger stops accepting writes. An
        // age no clock could have produced therefore counts as aged; the pid
        // check on the next line is still what refuses a LIVE holder's lease,
        // and for the holder-less branch the O_EXCL create below remains the CAS.
        const aged = ageMs === null || ageMs > STORE_LOCK_STALE_MS;
        if (aged && (!holder || processDefinitelyDead(holder.pid))) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // disappeared between stat/unlink; retry the exclusive create
      }
      const now = Date.now();
      if (now >= deadline) return busyFallback;
      sleepSync(Math.min(STORE_LOCK_RETRY_MS, deadline - now));
    }
  }

  try {
    return body();
  } finally {
    // Only remove a lease we can still prove is ours: a reaper may have taken it
    // and handed it on while we worked, and unlinking blindly would release a
    // lock some other process is holding.
    const held = readLockHolder(lockPath);
    if (held && held.token === token) {
      try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }
}

function normalizeEntry(value: unknown): ExhaustedEntry | null {
  if (typeof value === 'string' && value.trim()) return { model: value.trim() };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const e = value as Record<string, unknown>;
    if (typeof e.model === 'string' && e.model.trim()) {
      return { model: e.model.trim(), ...(typeof e.at === 'string' ? { at: e.at } : {}) };
    }
  }
  return null;
}

function entryFresh(entry: ExhaustedEntry, nowMs: number): boolean {
  if (!entry.at) return true; // legacy/no-timestamp → never expires within the run
  const t = Date.parse(entry.at);
  if (!Number.isFinite(t)) return true;
  // The MIRROR of the lock sites in this file, and it folds the opposite way.
  // Here freshness BLOCKS: a fresh entry keeps the model condemned. A stamp
  // ahead of now makes the age negative, which satisfies `<= TTL` forever, so a
  // single future-stamped record condemns that model for the whole run and can
  // drive the role to terminal exhaustion with no way back. An age no clock
  // could have produced therefore does NOT preserve the condemnation — it
  // expires it, and a model whose budget is genuinely gone re-trips the limit
  // and is re-recorded, which is the one-failed-spawn trade this TTL exists for.
  const ageMs = trustworthyAgeSince(t, nowMs);
  return ageMs !== null && ageMs <= EXHAUSTED_MODEL_TTL_MS;
}

function normalizeTerminal(value: unknown, fallbackAt?: unknown): ExhaustionTerminalMarker | undefined {
  if (value === true) return typeof fallbackAt === 'string' ? { at: fallbackAt } : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const marker = value as Record<string, unknown>;
  return typeof marker.at === 'string' ? { at: marker.at } : {};
}

function normalizeRoleState(value: unknown): ExhaustedRoleState | null {
  // v1/current legacy format: { "senior-backend": ["slug", {model, at}] }
  if (Array.isArray(value)) {
    const entries = value.map(normalizeEntry).filter((e): e is ExhaustedEntry => e !== null);
    return entries.length ? { entries } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const role = value as Record<string, unknown>;
  const rawEntries = Array.isArray(role.entries) ? role.entries
    : Array.isArray(role.models) ? role.models : [];
  const entries = rawEntries.map(normalizeEntry).filter((e): e is ExhaustedEntry => e !== null);
  const terminal = normalizeTerminal(role.terminal, role.terminalAt);
  return entries.length || terminal ? { entries, ...(terminal ? { terminal } : {}) } : null;
}

function readStore(cwd: string, runId: string): ExhaustedStoreV2 {
  try {
    const raw = JSON.parse(fs.readFileSync(exhaustedPath(cwd, runId), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 2, roles: {} };
    const record = raw as Record<string, unknown>;
    const source = record.version === 2 && record.roles && typeof record.roles === 'object' && !Array.isArray(record.roles)
      ? record.roles as Record<string, unknown>
      : record;
    const roles: Record<string, ExhaustedRoleState> = {};
    for (const [role, value] of Object.entries(source)) {
      if (role === 'version' || role === 'roles') continue;
      const normalized = normalizeRoleState(value);
      if (normalized) roles[role] = normalized;
    }
    return { version: 2, roles };
  } catch {
    return { version: 2, roles: {} };
  }
}

function pruneExpired(store: ExhaustedStoreV2, nowMs: number): void {
  for (const [role, state] of Object.entries(store.roles)) {
    state.entries = state.entries.filter((entry) => entryFresh(entry, nowMs));
    if (!state.entries.length && !state.terminal) delete store.roles[role];
  }
}

// The models still condemned for a role this run: recorded slugs/families whose
// TTL has not lapsed (e.g. `gpt-5.6-terra-medium`).
export function exhaustedModelsForRole(cwd: string, runId: string, role: string, nowMs: number = Date.now()): string[] {
  if (!runId || !role) return [];
  return (readStore(cwd, runId).roles[role]?.entries ?? [])
    .filter((e) => entryFresh(e, nowMs))
    .map((e) => e.model);
}

// Persistent run+role terminal state: all actual tier candidates were attempted
// and API-limited. It intentionally survives entry TTL and is cleared only by
// clearExhaustedModels (the user's enable/retry action) or a new run id.
export function modelExhaustionTerminalForRole(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  return Boolean(readStore(cwd, runId).roles[role]?.terminal);
}

// True when `model` matches (family-aware) any model still condemned for the role.
export function modelIsExhausted(cwd: string, runId: string, role: string, model: string, nowMs: number = Date.now()): boolean {
  const m = (model || '').trim();
  if (!m) return false;
  return exhaustedModelsForRole(cwd, runId, role, nowMs).some(
    (x) => modelMatchesExpected(x, m) || modelMatchesExpected(m, x),
  );
}

// Record `model` as exhausted for the role (idempotent — a family already present
// refreshes its timestamp instead of duplicating). Expired entries are pruned on
// write. Returns the fresh post-write list for the role — or, when the write
// chokepoint refused it, the list that is still ON DISK.
//
// The returned list is what the rotation deny renders as "TRIED: …" and what the
// caller compares the next candidate against, while the DISK is what the next
// hook invocation reads. Returning the optimistic in-memory list after a refused
// write put those two permanently out of step: the deny named a model as
// condemned, the ledger never carried it, and the following invocation resolved
// the same model as eligible again and prescribed the one that had just failed.
export function recordExhaustedModel(cwd: string, runId: string, role: string, model: string, nowMs: number = Date.now()): string[] {
  const m = (model || '').trim();
  if (!runId || !role || !m) return exhaustedModelsForRole(cwd, runId, role, nowMs);
  if (isNonProjectRoot(cwd)) return exhaustedModelsForRole(cwd, runId, role, nowMs);
  try {
    return withStoreLock(cwd, runId, exhaustedModelsForRole(cwd, runId, role, nowMs), () => {
      const store = readStore(cwd, runId);
      pruneExpired(store, nowMs);
      const state = store.roles[role] ?? { entries: [] };
      const at = new Date(nowMs).toISOString();
      const existing = state.entries.find((e) => modelMatchesExpected(e.model, m) || modelMatchesExpected(m, e.model));
      if (existing) existing.at = at;
      else state.entries.push({ model: m, at });
      store.roles[role] = state;
      if (!writeJson(exhaustedPath(cwd, runId), store)) {
        return exhaustedModelsForRole(cwd, runId, role, nowMs);
      }
      return state.entries.map((e) => e.model);
    });
  } catch {
    return exhaustedModelsForRole(cwd, runId, role, nowMs);
  }
}

export function markModelExhaustionTerminal(
  cwd: string,
  runId: string,
  role: string,
  nowMs: number = Date.now(),
): boolean {
  if (!runId || !role || isNonProjectRoot(cwd)) return false;
  try {
    // The boolean is the WRITE's verdict. It used to be a literal `true`, so a
    // refused write still told the caller the terminal marker was persisted —
    // and both callers render that as "model rotation is TERMINAL for this
    // role, stop retrying", a claim modelExhaustionTerminalForRole then
    // contradicts on the very next read.
    return withStoreLock(cwd, runId, false, () => {
      const store = readStore(cwd, runId);
      pruneExpired(store, nowMs);
      const state = store.roles[role] ?? { entries: [] };
      state.terminal = { at: new Date(nowMs).toISOString() };
      store.roles[role] = state;
      return writeJson(exhaustedPath(cwd, runId), store);
    });
  } catch {
    return false;
  }
}

// Forget every condemnation for the run. Called when the user answers
// `enable`(-retry) to the model choice: "I fixed the budget / re-enabled the
// model" makes the ledger stale by definition — keeping it would immediately
// re-rotate off the model the user just restored.
export function clearExhaustedModels(cwd: string, runId: string): void {
  if (!runId || isNonProjectRoot(cwd)) return;
  const p = exhaustedPath(cwd, runId);
  // Avoid creating a run directory just to clear an absent ledger, while still
  // waiting on a concurrent first writer that has published the run directory
  // and lock but not the JSON file yet.
  if (!fs.existsSync(path.dirname(p))) return;
  try {
    withStoreLock(cwd, runId, undefined, () => {
      try { fs.unlinkSync(p); } catch { /* already absent / best-effort */ }
    });
  } catch {
    // already absent / best-effort
  }
}
