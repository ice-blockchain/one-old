// src/shared/one-settings.ts
// The single owner of ~/.traffic-one/one.json — the consolidated GLOBAL, per-user
// settings file holding the validated wizard API-key record (`auth`) and the
// machine-wide code-graph provider.
//
// Why consolidate: the code-graph provider becomes a machine-level setting so a
// provider already chosen/installed locally is reused across projects (onboarding
// stops re-prompting). Keeping auth alongside it means one secure (0o600)
// settings file for all Traffic One machine state.
//
// Concurrency: auth and code-graph writes can overlap. Every mutation takes a bounded
// cross-process lock, RE-READS the file while holding it, patches only the
// touched section, and writes atomically (temp + rename).

import * as fs from 'fs';
import * as path from 'path';

import { ONE_SETTINGS_VERSION } from '../config/one-settings';
import { readOwnerEntry, readRegularFile } from './bounded-read';
import { readJson } from './fsjson';
import { globalTrafficOneDir } from './state-root';

interface OneApiKeyAuth {
  version: 1;
  authenticated: true;
  apiKey: string;
  updatedAt: string;
}

interface OneSettings {
  schemaVersion: number;
  auth?: OneApiKeyAuth;
  codeGraphProvider?: string | null;
  /**
   * The signed operator-override mint counters, keyed by project hash. Opaque
   * here on purpose: the shape and its MAC belong to shared/override/
   * mint-counter.ts, and importing that module for a type would close a cycle
   * through fsjson.
   *
   * It lives in this envelope rather than beside the override ledger for one
   * reason — it has to survive `rm -rf` of the override bucket, which is the
   * erasure it exists to detect. It is not a secret and not auth state; it is
   * here because this is the machine-owned file that is neither the thing being
   * protected nor inside it.
   */
  overrideMints?: Record<string, unknown>;
  /**
   * The signed operator RECONCILIATIONS, keyed by project hash, each an
   * append-only array. Opaque here for the same reason as the counter above,
   * and in the same envelope for the same reason: it has to survive `rm -rf` of
   * the override bucket, since one of the states it acknowledges is that bucket
   * being unreadable. See shared/override/reconcile.ts.
   */
  overrideReconciliations?: Record<string, unknown>;
}

interface OneSectionValueMap {
  auth: OneApiKeyAuth;
  codeGraphProvider: string | null;
}

type OneSection = keyof OneSectionValueMap;

export type OneSettingsPatch = Pick<
  Partial<OneSettings>,
  'auth' | 'codeGraphProvider' | 'overrideMints' | 'overrideReconciliations'
>;

export const ONE_SETTINGS_LOCK_TIMEOUT_MS = 500;
/**
 * The wait for a machine-dir lock whose holder takes the settings lock INSIDE
 * it — `withMachineFileLock`'s default, and the override mint's ledger lock is
 * the only caller.
 *
 * IT CANNOT EQUAL THE INNER BUDGET, and it did. Both waits were
 * ONE_SETTINGS_LOCK_TIMEOUT_MS, so the outer hold — which CONTAINS a settings
 * write that is itself allowed to wait the full inner budget — could always
 * outlast the deadline a second holder was given to wait for it. That refuses
 * an honest concurrent mint by arithmetic rather than by contention policy: no
 * amount of patience helps, because the hold is structurally longer than the
 * wait. MEASURED (.tmp/override7/p5-lock.ts, load average 36–48, 1ms sampling
 * of the lock directory from another process): the ledger hold is 85–145 ms
 * uncontended over 5 samples, and 534–561 ms over 3 samples when the nested
 * settings write runs to its own deadline — already past the 500 ms a waiter
 * had.
 *
 * FOUR TIMES, not "bigger": the hold is bounded by one inner deadline plus the
 * reads and writes around it, so the outer budget has to clear that bound with
 * enough room for the waiter to also lose a retry sleep or two on a loaded
 * host. Four inner budgets is ~1.4 s of slack over the worst hold measured
 * above. The RELATIONSHIP is what matters, and it is pinned twice in
 * override/__tests__/integrity.test.ts — once as arithmetic and once
 * behaviourally, by a real cross-process hold longer than the inner budget that
 * a waiter must still get through. An edit that re-equalises the two goes red
 * rather than quietly making every concurrent mint impossible again.
 */
export const ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS = ONE_SETTINGS_LOCK_TIMEOUT_MS * 4;
const ONE_SETTINGS_LOCK_RETRY_MS = 10;
// There is deliberately NO staleness constant any more. Both reap arms decide on
// the holder's liveness and remove only what they observed, so an age is not a
// guard here — see `reapAbandonedLock`. What it was is a ten-second refusal of
// every settings write on the machine after any crash, measured at 656 ms of
// waiting and then a false accusation for a holder nobody had to guess about.

/**
 * The `code` on the error `acquireSettingsLock` throws at its deadline, and the
 * predicate a caller asks instead of matching the message text.
 *
 * A CALLER HAS TO BE ABLE TO TELL THIS APART FROM THE REST, because the two
 * failures have opposite fixes and one of them used to be reported as the
 * other: a settings write that could not take the lock is a TRANSIENT
 * contention (or, before the reap below, a crashed holder's leftovers), while
 * every other throw out of `updateOneSettings` is a fact about the file's
 * contents. `mintOverride` refused with `counter-unwritable`, and the operator
 * was told their `schemaVersion` was unsupported, their JSON was unparseable,
 * or something other than a file was at that path — three causes, none of them
 * what happened. See override/mint-counter.ts's `recordOverrideMint`.
 */
export const ONE_SETTINGS_LOCK_TIMEOUT_CODE = 'TRAFFIC_ONE_SETTINGS_LOCK_TIMEOUT';

export function isOneSettingsLockTimeout(error: unknown): boolean {
  return Boolean(error
    && typeof error === 'object'
    && (error as NodeJS.ErrnoException).code === ONE_SETTINGS_LOCK_TIMEOUT_CODE);
}

export function oneSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TRAFFIC_ONE_STATE_PATH;
  if (override) return path.resolve(override);
  return path.join(globalTrafficOneDir(env), 'one.json');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isApiKeyAuthRecord(value: unknown): value is OneApiKeyAuth {
  const raw = record(value);
  const allowedKeys = new Set(['version', 'authenticated', 'apiKey', 'updatedAt']);
  return Boolean(raw
    && Object.keys(raw).length === allowedKeys.size
    && Object.keys(raw).every((key) => allowedKeys.has(key))
    && raw.version === 1
    && raw.authenticated === true
    && typeof raw.apiKey === 'string'
    && raw.apiKey.trim().length > 0
    && raw.apiKey === raw.apiKey.trim()
    && typeof raw.updatedAt === 'string'
    && raw.updatedAt.trim().length > 0);
}

function apiKeyAuthRecord(value: unknown): OneApiKeyAuth | null {
  const raw = record(value);
  if (!isApiKeyAuthRecord(raw)) return null;
  return {
    version: 1,
    authenticated: raw.authenticated,
    apiKey: raw.apiKey,
    updatedAt: raw.updatedAt,
  };
}

function parseOneSettings(raw: Record<string, unknown> | null): OneSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      schemaVersion: ONE_SETTINGS_VERSION,
      codeGraphProvider: null,
    };
  }
  const auth = apiKeyAuthRecord(raw.auth);
  const settings: OneSettings = {
    schemaVersion: typeof raw.schemaVersion === 'number'
      ? raw.schemaVersion
      : ONE_SETTINGS_VERSION,
    codeGraphProvider: typeof raw.codeGraphProvider === 'string' ? raw.codeGraphProvider : null,
  };
  if (auth) settings.auth = auth;
  const overrideMints = record(raw.overrideMints);
  if (overrideMints) settings.overrideMints = overrideMints;
  const overrideReconciliations = record(raw.overrideReconciliations);
  if (overrideReconciliations) settings.overrideReconciliations = overrideReconciliations;
  return settings;
}

export function readOneSettings(env: NodeJS.ProcessEnv = process.env): OneSettings {
  const raw = readJson<Record<string, unknown> | null>(oneSettingsPath(env), null);
  return parseOneSettings(raw);
}

interface RawSettingsRead {
  valid: boolean;
  raw: Record<string, unknown> | null;
}

/**
 * Why the envelope below would refuse every write, or null when it would accept
 * one. Exported because a WRITE that throws and a READ that succeeds is exactly
 * how one integer in this file froze the override mint counter while the counter
 * kept reporting health: `updateOneSettings` throws on each of these, and
 * `readJsonResult` — which is what a reader inside settlement uses — is happy
 * with all of them. A reader that needs to know whether its own bookkeeping
 * write can land asks this, off the read it has already done, rather than
 * discovering the answer by failing. See override/mint-counter.ts.
 */
export function oneSettingsSchemaError(raw: Record<string, unknown> | null): string | null {
  return rawSchemaError(raw);
}

function rawSchemaError(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  if (!Object.prototype.hasOwnProperty.call(raw, 'schemaVersion')) {
    return 'Traffic One settings schemaVersion is missing';
  }
  if (!Number.isInteger(raw.schemaVersion)) {
    return 'Traffic One settings schemaVersion is malformed';
  }
  const schemaVersion = raw.schemaVersion as number;
  if (schemaVersion > ONE_SETTINGS_VERSION) {
    return `Traffic One settings schema ${schemaVersion} is newer than supported schema ${ONE_SETTINGS_VERSION}`;
  }
  if (schemaVersion < ONE_SETTINGS_VERSION) {
    return `Traffic One settings schema ${schemaVersion} is obsolete; schema ${ONE_SETTINGS_VERSION} is required`;
  }
  return null;
}

/**
 * THE SETTINGS FILE IS READ WITH THE SAME BOUND AS THE LOCK, and it needed it
 * for the same reason at a place no lock protects: this read runs BEFORE
 * `updateOneSettings` takes anything, so a FIFO planted at `one.json` hung every
 * write on the machine with the hardened lock still untouched — DRIVEN
 * (.tmp/override8/p1-drive.mjs, load 27.19): `updateOneSettings` SIGKILLed at
 * 12 068 ms, against a 7 ms control. The planting capability is identical to the
 * lock directory's, because it IS the same directory: anything that can write
 * under the machine dir can write both names.
 *
 * `readRegularFile`, not `readOwnerEntry` — a symlink here is FOLLOWED, and the
 * asymmetry is deliberate. An owner file is a record this protocol wrote at a
 * name it chose, so a link there is somebody else's evidence; `one.json` is an
 * operator's file at a documented path, and a dotfiles checkout linking it is a
 * configuration rather than an attack. Boundedness does not depend on the
 * refusal: the open is still non-blocking and the kind is still decided on the
 * DESCRIPTOR, so a link to a FIFO or to `/dev/zero` answers PRESENCE without a
 * byte being read.
 *
 * A NON-FILE IS `valid: false`, which is where a DIRECTORY at this path already
 * landed (EISDIR, caught below) — so the shapes that used to hang now take the
 * refusal the one shape that could not hang always took.
 */
function readRawSettings(filePath: string): RawSettingsRead {
  if (!fs.existsSync(filePath)) return { valid: true, raw: null };
  try {
    const bytes = readRegularFile(filePath);
    if (bytes === null) return { valid: false, raw: null };
    const raw = JSON.parse(bytes) as unknown;
    return record(raw)
      ? { valid: true, raw: raw as Record<string, unknown> }
      : { valid: false, raw: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { valid: true, raw: null };
    }
    return { valid: false, raw: null };
  }
}

function writeWholeFile(filePath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best-effort; some filesystems ignore chmod
    }
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // best-effort
    }
  } finally {
    // A failed rename must not strand another plaintext copy of the API key.
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }
}

interface SettingsLock {
  readonly dirPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

interface SettingsLockOwner {
  readonly ownerPath: string;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // SharedArrayBuffer can be unavailable in a constrained runtime. The lock is
    // still bounded by the deadline; the loop simply retries without sleeping.
  }
}

function observedLockOwner(lockPath: string): SettingsLockOwner | null {
  try {
    const entries = fs.readdirSync(lockPath).filter((name) => /^owner-[a-f0-9]+\.json$/.test(name));
    // An empty directory may be between mkdir and owner publication. Multiple
    // owners indicate corruption or a concurrent recovery; neither is safe to
    // reap by guessing.
    if (entries.length !== 1) return null;
    const ownerName = entries[0] as string;
    const ownerPath = path.join(lockPath, ownerName);
    // Anything but a regular file is not a record this protocol wrote, so the
    // strict reader refuses it exactly as it refuses unparseable bytes — and the
    // abandoned arm below is what then decides. See shared/bounded-read.ts for
    // why this is not `readFileSync`: a FIFO at this name hung the acquisition
    // outright, with no deadline able to bound it.
    const bytes = readOwnerEntry(ownerPath);
    if (bytes === null) return null;
    const raw = JSON.parse(bytes) as Record<string, unknown>;
    const token = typeof raw.token === 'string' ? raw.token : '';
    const pid = typeof raw.pid === 'number' ? raw.pid : Number.NaN;
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Number.NaN;
    if (!token || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAt)
      || ownerName !== `owner-${token}.json`) return null;
    return { ownerPath, token, pid, createdAt };
  } catch {
    return null;
  }
}

// Reap only the owner filename that was actually observed. If another process
// replaced the stale directory with a fresh lock in the meantime, the old
// owner filename is absent and unlink fails; rmdir also refuses the fresh,
// non-empty directory. This token-addressed directory protocol avoids the
// stale-check/unlink TOCTOU of a single pathname lock file.
function reapObservedLock(lockPath: string, owner: SettingsLockOwner): boolean {
  try {
    fs.unlinkSync(owner.ownerPath);
  } catch {
    return false;
  }
  try {
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove only the entries that were OBSERVED, then `rmdir`.
 *
 * The compare-and-swap this protocol reclaims through, ported from
 * state/project-state-lock.ts's `removeObservedDir`, and the reason no arm below
 * consults an age any more. Both halves are re-resolutions of the PATH, and both
 * are what makes landing in the unclosable window harmless: an owner name
 * carries a random token, so a lease minted after the listing is never a name
 * this removes; and `rmdir` REFUSES a non-empty directory, so that lease stops
 * the reclaim and this reports honestly that it did nothing.
 *
 * Recursive per entry rather than `unlink`, for the same reason the sibling
 * gives: the population here is entries no writer of this lock produced — a
 * `.DS_Store`, a backup sidecar, a crashed contender's second owner file — and
 * refusing the kinds `unlink` cannot take would re-open the permanent wedge for
 * a subdirectory exactly as the emptiness precondition did for a stray file.
 */
function removeObservedDir(dirPath: string, entries: readonly string[]): boolean {
  for (const name of entries) {
    try { fs.rmSync(path.join(dirPath, name), { recursive: true }); } catch { /* not ours to remove */ }
  }
  try {
    fs.rmdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim a lock directory no LEGIBLE owner is holding, without requiring it to
 * be empty.
 *
 * WHAT THE EMPTINESS PRECONDITION COST, and it needed no attacker:
 * `observedLockOwner` refuses any directory whose listing is not exactly one
 * correctly-named parseable owner file, so an abandoned lock that picked up one
 * stray entry fell through to a reaper that demanded the directory be EMPTY —
 * which it now never is. The product manufactures that state itself:
 * `reapObservedLock` unlinks the owner file and then `rmdir`s, so anything
 * landing between those two lines leaves a directory with no owner evidence,
 * one stray inside it, and a freshly stamped mtime that also re-arms the age.
 * Every settings write on the machine then throws at its deadline — the mint
 * counter, the reconciliations, and the wizard's API key — with no code path
 * that recovers it.
 *
 * A pid that answers `kill(pid, 0)` is still the only thing that refuses, read
 * from ANY owner-named file however malformed the rest of the record is: a lock
 * that picked up a stray beside a LIVE owner keeps it, which is what stops this
 * widening from stealing one.
 */
function reapAbandonedLock(lockPath: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(lockPath); } catch { return false; }
  for (const name of entries) {
    // THE PERMISSIVE GRAMMAR, and the difference from `observedLockOwner`'s is
    // the whole point rather than an oversight: that one identifies WHICH lease
    // to compare-and-swap away, so it must be exact, while this one asks whether
    // ANYONE is alive in here, so it must be generous. Reusing the strict
    // `owner-<hex>.json` here made the widening steal a live holder's lock the
    // moment its token was spelled with a letter outside [a-f] — caught by this
    // lane's own held-off-mint fixture, whose token is the word `concurrent`.
    if (!(name.startsWith('owner-') && name.endsWith('.json'))) continue;
    try {
      // A non-regular entry makes NO liveness claim, exactly like unparseable
      // bytes, and for a stronger reason than the strict reader's: this arm is
      // the one that hangs when the strict reader has already bailed on a stray
      // beside the FIFO (driven, SIGKILL at 12 015 ms). See bounded-read.ts.
      const bytes = readOwnerEntry(path.join(lockPath, name));
      if (bytes === null) continue;
      const raw = JSON.parse(bytes) as Record<string, unknown>;
      const pid = raw.pid;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && ownerHoldsLock(pid)) return false;
    } catch {
      // An unreadable owner file makes no liveness claim. It also cannot be
      // written by a live holder of THIS lock: the owner file is published into
      // the staging directory before the rename, so a lock at the canonical path
      // is complete from the instant it exists.
      continue;
    }
  }
  return removeObservedDir(lockPath, entries);
}

/**
 * Remove a NON-DIRECTORY planted at the lock path.
 *
 * Unconditional, and `unlink` is the scope rather than an accident of the
 * syscall: it refuses a directory, so this can never take a lock. A file here is
 * never a lock and never an in-flight acquisition — the handshake stages in a
 * sibling `.pending` DIRECTORY and renames a directory into place — but it is
 * not inert either. `rename(dir, non-dir)` fails ENOTDIR and neither reaper can
 * touch it (`reapObservedLock` needs a readable owner file, `reapAbandonedLock`
 * needs a readable directory), so every settings write spins its full deadline
 * and throws, forever, for one byte at `~/.traffic-one/one.json.lock`.
 */
function clearStrayLockObject(lockPath: string): boolean {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function nonDirectoryAt(lockPath: string): boolean {
  try { return !fs.lstatSync(lockPath).isDirectory(); } catch { return false; }
}

/**
 * Could the process named by an owner file still be HOLDING THIS LOCK?
 *
 * Three answers, not two, and the third used to be folded into the first — which
 * was a wedge anyone could plant with one file. `kill(pid, 0)` reports EPERM for
 * a process that exists and belongs to another user, and reading that as "alive"
 * meant an owner file naming PID 1 was accepted as a live holder forever: the
 * stale-reap arm never fired, and every settings write in this file — the mint
 * counter, the reconciliations AND the wizard's API key — threw at the deadline
 * until a human found the directory. MEASURED from a clean install, one planted
 * file, no key and no privileges.
 *
 * EPERM is therefore `not-ours`, and `not-ours` cannot be a holder of THIS lock.
 * The argument is the lock's location rather than a guess about the process: it
 * lives inside the per-user machine dir, created 0700 by `writeWholeFile`'s own
 * `mkdirSync`, and every writer of it runs as that user. A pid this process may
 * not signal is either somebody else's unrelated program or a recycled number;
 * neither ever took this lock. A live holder we CAN signal still answers `alive`
 * and still keeps its lock, which is the case this check exists for.
 *
 * The reap it unblocks is no longer gated on a staleness floor — see the note at
 * the reap itself for why the age was never the thing protecting a holder. A
 * planted file therefore costs one retry rather than a ten-second refusal, and a
 * live holder's young lock is still never stolen, because liveness is what is
 * asked.
 */
type OwnerLiveness = 'alive' | 'dead' | 'not-ours';

function ownerLiveness(pid: number): OwnerLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'not-ours' : 'dead';
  }
}

function ownerHoldsLock(pid: number): boolean {
  return ownerLiveness(pid) === 'alive';
}

function acquireSettingsLock(filePath: string, timeoutMs: number): SettingsLock {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + timeoutMs;

  // Publish a fully formed, non-empty directory with one atomic rename. The
  // canonical lock path is therefore never observable between mkdir and owner
  // creation, eliminating the empty-directory recovery race entirely.
  try {
    fs.mkdirSync(pendingPath, { mode: 0o700 });
    fs.writeFileSync(
      path.join(pendingPath, ownerName),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  let acquired = false;
  try {
    while (true) {
      try {
        fs.renameSync(pendingPath, lockPath);
        acquired = true;
        return { dirPath: lockPath, ownerPath: path.join(lockPath, ownerName), token };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // EACCES joins the contended set, one errno over from EPERM and left out
        // of it: `rename` onto a lock directory has to read it to decide it is
        // non-empty, so a lock directory this uid may not read raises EACCES
        // rather than EEXIST. Without the word here it leaves this function as a
        // raw errno instead of the timeout every caller is written against.
        // Ported from state/project-state-lock.ts, which measured it at 2 ms
        // from a hook.
        const contended = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR'
          || code === 'EACCES' || (code === 'EPERM' && fs.existsSync(lockPath));
        if (!contended) throw error;
        // Before anything is read out of the path: a planted non-directory has
        // no protocol meaning, and leaving it to be asked about twice is what
        // wedges the lock permanently.
        if (nonDirectoryAt(lockPath) && clearStrayLockObject(lockPath)) {
          if (Date.now() < deadline) continue;
        }
        const owner = observedLockOwner(lockPath);
        // NO AGE IS CONSULTED for an owner we can read, and the deletion of that
        // guard is this protocol's one behavioural change since it was ported.
        // What an OOM-kill or a SIGKILL leaves is a lock whose holder is
        // provably gone and whose stamp is SECONDS old, and the staleness floor
        // refused it for the rest of its ten-second window: MEASURED
        // (.tmp/override7/p5-lock.ts) — with a dead owner and a 2s-old stamp an
        // honest override mint was refused in 656 ms, and the identical fixture
        // at 30s succeeded in 329 ms. Ten seconds of refusing every settings
        // write on this machine, for a holder nobody has to guess about.
        //
        // The age was never what protected a holder; `ownerLiveness` is, and it
        // still governs — a pid that answers `kill(pid, 0)` keeps its lock at
        // any age. What the age was protecting against is a reap that could
        // destroy a lease it had not seen, and this reap cannot: it unlinks the
        // owner FILENAME it observed (which carries a random token, so a
        // replacement lease is never that name) and then `rmdir`s, which refuses
        // a directory a replacement has already landed in. The same argument the
        // deviations lane wrote down for state/project-state-lock.ts's
        // `reapAbandonedLock`, reached here from a different measurement. And a
        // live holder is never missing its owner file: the file is written into
        // the staging directory BEFORE the rename that publishes it, so a lock
        // at the canonical path is complete from the instant it exists.
        if (owner && !ownerHoldsLock(owner.pid) && reapObservedLock(lockPath, owner)) {
          continue;
        }
        if (!owner && reapAbandonedLock(lockPath)) continue;
        const now = Date.now();
        if (now >= deadline) {
          const error: NodeJS.ErrnoException = new Error(
            `traffic-one settings lock timed out after ${timeoutMs}ms`,
          );
          // Named so a caller can say what actually happened instead of
          // guessing at the file's contents. See ONE_SETTINGS_LOCK_TIMEOUT_CODE.
          error.code = ONE_SETTINGS_LOCK_TIMEOUT_CODE;
          throw error;
        }
        sleepSync(Math.min(ONE_SETTINGS_LOCK_RETRY_MS, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function releaseSettingsLock(lock: SettingsLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    // The RELEASE reads through the bound too, and it is a third blocking reader
    // rather than a consistency edit: the proof of ownership below is a read of
    // a path inside the lock directory, so anybody who can write there can
    // replace our own owner file with a FIFO while we hold it — which would hang
    // the release, leaving the lock published forever. The same argument
    // state/project-state-lock.ts's release records.
    const bytes = readOwnerEntry(lock.ownerPath);
    if (bytes === null) return;
    const raw = JSON.parse(bytes) as Record<string, unknown>;
    if (raw.token !== lock.token) return;
    // Release ownership by atomically moving the whole, verified directory off
    // the canonical path. A cleanup failure cannot wedge future settings writes.
    fs.renameSync(lock.dirPath, releasedPath);
  } catch {
    // Already removed/replaced. Never unlink a lock we cannot prove we own.
    return;
  }
  try { fs.rmSync(releasedPath, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function withSettingsLock<T>(filePath: string, body: () => T, timeoutMs = ONE_SETTINGS_LOCK_TIMEOUT_MS): T {
  const lock = acquireSettingsLock(filePath, timeoutMs);
  try {
    return body();
  } finally {
    releaseSettingsLock(lock);
  }
}

/**
 * The same lock, over another file under the same machine dir — for a caller
 * whose file is not `one.json` but whose concurrency problem is identical.
 *
 * EXPORTED RATHER THAN COPIED. The protocol above is not a `mkdir` and a stale
 * check: it publishes a fully formed directory with one atomic rename (so the
 * canonical path is never observable half-built), reaps only the owner FILENAME
 * it observed (so a fresh lock cannot be stolen by a slow reaper), reads EPERM
 * as `not-ours` rather than as a live holder (the wedge anyone could plant with
 * one file), BOUNDS every read of an owner entry (shared/bounded-read.ts — a
 * FIFO at one of those names made this function never return, measured at this
 * lock's own callers), and tolerates an owner timestamp from the future. A
 * second copy of that would be a second place to get it wrong — and the bound
 * is precisely the property that did NOT travel with the two earlier ports of
 * this protocol, which is how this file kept a defect its sibling had already
 * repaired. The census in `__tests__/process-liveness-eperm.test.ts` exists
 * because copies of exactly this predicate have gone wrong before.
 *
 * THE ARGUMENT FOR `not-ours` TRAVELS WITH IT, and a caller must check that it
 * holds for their file too: it rests on the lock living inside the 0700
 * per-user machine dir, so a pid this process may not signal never took it. The
 * override ledger's bucket is created 0700 under the same root
 * (override/paths.ts), which is why this is safe there.
 *
 * THROWS at the deadline, like every other write in this file, and the error
 * carries ONE_SETTINGS_LOCK_TIMEOUT_CODE so the caller can name that cause
 * rather than one of the file's. A caller who cannot proceed without the lock
 * must decide what its own failure means — `mintOverride` refuses the mint; its
 * rollback leaves the line alone.
 *
 * ITS DEFAULT DEADLINE IS THE NESTED ONE, and that is the point of the
 * parameter rather than a convenience: the caller this exists for holds this
 * lock ACROSS a settings write, so a budget equal to the settings lock's own
 * cannot admit a waiter (see ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS). A future
 * caller that nests nothing may pass the inner budget; one that nests may not
 * pass anything smaller, and the relationship is pinned by a test.
 */
export function withMachineFileLock<T>(
  filePath: string,
  body: () => T,
  timeoutMs: number = ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS,
): T {
  return withSettingsLock(filePath, body, timeoutMs);
}

interface CanonicalOneSettingsRead {
  ok: boolean;
  settings: OneSettings;
  error?: string;
}

// Read and validate only the canonical one.json envelope. Authentication fails
// closed for malformed or unsupported settings without rewriting the file.
export function readCanonicalOneSettings(
  env: NodeJS.ProcessEnv = process.env,
): CanonicalOneSettingsRead {
  const filePath = oneSettingsPath(env);
  const source = readRawSettings(filePath);
  if (!source.valid) {
    return { ok: false, settings: parseOneSettings(null), error: 'Traffic One settings are malformed' };
  }
  const schemaError = rawSchemaError(source.raw);
  if (schemaError) {
    return { ok: false, settings: parseOneSettings(null), error: schemaError };
  }
  return { ok: true, settings: parseOneSettings(source.raw) };
}

// Apply a typed patch to the RAW envelope instead of serializing the typed read
// model. The typed model intentionally exposes only fields this runtime
// understands; using it as the write substrate would erase additive fields
// written by a newer runtime.
//
// Known fields supplied by the patch are still canonicalized. Unknown
// top-level fields survive byte-for-byte semantically. The retired pre-release
// `hosts` model mirror is the sole exception and is deleted on the first write;
// model catalogs now live only in one-mcp.json.
function mergeRawSettings(
  raw: Record<string, unknown> | null,
  patch: OneSettingsPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = raw ? { ...raw } : {};
  next.schemaVersion = ONE_SETTINGS_VERSION;
  if (!Object.prototype.hasOwnProperty.call(next, 'codeGraphProvider')) next.codeGraphProvider = null;
  delete next.hosts;

  if (Object.prototype.hasOwnProperty.call(patch, 'auth')) next.auth = patch.auth;
  if (Object.prototype.hasOwnProperty.call(patch, 'codeGraphProvider')) {
    next.codeGraphProvider = patch.codeGraphProvider;
  }
  // MERGED per key, not replaced, and the only section here that is. Its keys
  // are per-project counters written by whichever doctor is minting right now,
  // and a patch built outside the lock necessarily carries a stale view of
  // every OTHER project's entry — replacing the section would drop them. Merging
  // under the lock also means the section can only ever grow, which is what a
  // monotone audit counter wants.
  if (Object.prototype.hasOwnProperty.call(patch, 'overrideMints')) {
    next.overrideMints = { ...(record(next.overrideMints) || {}), ...patch.overrideMints };
  }
  // Same per-key merge, same reason, plus one of its own: each project's value
  // is an APPEND-ONLY array of operator acknowledgements, and replacing the
  // section wholesale would drop another project's history on a write that has
  // nothing to do with it. The caller assembles its own project's array by
  // reading and appending (reconcile.ts), which is where that array's
  // append-only property is enforced.
  if (Object.prototype.hasOwnProperty.call(patch, 'overrideReconciliations')) {
    next.overrideReconciliations = {
      ...(record(next.overrideReconciliations) || {}),
      ...patch.overrideReconciliations,
    };
  }
  return next;
}

// Atomically apply a partial patch (read-merge-write + temp/rename). This is the
// single low-level mutator everything goes through. A codeGraphProvider set to
// null is retained as null; use deleteOneSection to drop a key entirely.
export function updateOneSettings(patch: OneSettingsPatch, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = oneSettingsPath(env);
  const canonical = readCanonicalOneSettings(env);
  if (!canonical.ok) throw new Error(canonical.error || 'Traffic One settings are invalid');
  withSettingsLock(filePath, () => {
    const source = readRawSettings(filePath);
    if (!source.valid) throw new Error('Traffic One settings are malformed');
    const schemaError = rawSchemaError(source.raw);
    if (schemaError) throw new Error(schemaError);
    writeWholeFile(filePath, mergeRawSettings(source.raw, patch));
  });
  return filePath;
}

export function writeOneSection<K extends OneSection>(
  section: K,
  value: OneSectionValueMap[K],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return updateOneSettings({ [section]: value } as OneSettingsPatch, env);
}

// Remove ONE section (used by auth invalidation/clear). No-op if the file is absent.
export function deleteOneSection(section: OneSection, env: NodeJS.ProcessEnv = process.env): boolean {
  const filePath = oneSettingsPath(env);
  if (!readCanonicalOneSettings(env).ok) return false;
  if (!fs.existsSync(filePath)) return true;
  try {
    withSettingsLock(filePath, () => {
      const source = readRawSettings(filePath);
      if (!source.valid) throw new Error('Traffic One settings are malformed');
      const schemaError = rawSchemaError(source.raw);
      if (schemaError) throw new Error(schemaError);
      const current: Record<string, unknown> = source.raw ? { ...source.raw } : {};
      delete current[section];
      current.schemaVersion = ONE_SETTINGS_VERSION;
      delete current.hosts;
      writeWholeFile(filePath, current);
    });
    return true;
  } catch {
    return false;
  }
}
