// src/shared/override/token.ts
// The operator override token: its shape, its per-install HMAC, its TTL, and
// the two operations on it — MINT (doctor, once, interactively) and READ
// (gates, settlement, doctor's report). There is no third operation: nothing
// updates a token, nothing marks one "used", nothing extends one. That is not
// minimalism, it is the property the design rests on — a token is a signed
// statement about a fixed (project, run, target, window), so the only way to
// change any of those is to mint another one, which writes another audit line.
//
// ── What the HMAC is actually for ────────────────────────────────────────────
// It is NOT confidentiality and it is NOT protection from the machine's owner.
// It answers exactly one question: "did the doctor on this install issue this,
// or did something else write a JSON line into the file?" An agent can compose
// arbitrary JSON; it cannot compute a MAC over a key it has never read. So a
// fabricated ledger line reads as `forged` and is ignored — and, because that
// is a signal in its own right, REPORTED rather than silently dropped.
//
// The residual is honest and worth stating: an agent that can run arbitrary
// shell as the user can read the key file, and then it can forge tokens. That
// agent can also overwrite the plugin itself, so no primitive at this layer
// closes it. What this closes is the realistic path — an agent that reasons its
// way to "I'll just write the unblock file myself".

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { appendTextFile, readText, writeJson } from '../fsjson';
import { isSymlink } from '../fs-nofollow';
import { projectRootHash } from '../state/local-prefs/prefs-store';
import { overrideKeyPath, overrideLedgerPath, overrideProjectDir, overrideRoot, overrideSnapshotPath } from './paths';

/**
 * The two things an override may relax — ONE token type, per the plan's
 * "do not ship two overrides with different trust models".
 *
 *   'gate'     — a `gateId` whose deny the pipeline may skip (today's
 *                `doctor --unblock <gateId>`).
 *   'evidence' — a named verification/QA check a run may settle without. NOT
 *                yet minted by anything: this is the slot Phase 5's evidence
 *                waiver occupies, declared here so that item is a new `target`
 *                vocabulary rather than a second mechanism with its own key,
 *                its own audit trail and its own trust model.
 *
 * Both scopes already carry the abuse guard, because it keys on the ledger
 * line, not on the scope (see runOverrideRecords / run-settlement/io.ts).
 */
export type OverrideScope = 'gate' | 'evidence';

export const OVERRIDE_TOKEN_VERSION = 1 as const;

/**
 * Deliberately FLAT — every field a string or a number, no nested objects.
 * The MAC is computed over "every own key except `mac`" (see macPayload), and
 * a nested object would make that payload depend on JSON key order, i.e. on
 * something no format guarantees. Flat also means the audit file is readable
 * with `grep`, at the moment someone is reading it because something went
 * wrong.
 */
export interface OverrideToken {
  readonly v: typeof OVERRIDE_TOKEN_VERSION;
  readonly id: string;
  readonly scope: OverrideScope;
  /** The gateId (scope 'gate') or check id (scope 'evidence') being relaxed. */
  readonly target: string;
  /** projectRootHash of the project — the same key the prefs bucket uses. */
  readonly projectKey: string;
  /** The absolute project root, for the human reading this file. Signed, so it
   *  cannot be re-pointed, but `projectKey` is what matching compares. */
  readonly projectRoot: string;
  /** Always pinned, never null: see mintOverride for why `--run` being optional
   *  on the command line does not make the token project-wide. */
  readonly runId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuedByUser: string;
  readonly issuedByHostname: string;
  readonly issuedByPid: number;
  /** File name (not a path) of the pre-override snapshot beside this ledger. */
  readonly snapshot: string;
  readonly mac: string;
}

export type OverrideEntryOutcome = 'valid' | 'expired' | 'forged' | 'malformed';

export interface OverrideEntry {
  readonly outcome: OverrideEntryOutcome;
  /** Present for every outcome except 'malformed' (nothing parsed to report). */
  readonly token?: OverrideToken;
  /** The raw line, bounded, for a 'forged'/'malformed' report. */
  readonly raw: string;
}

export const OVERRIDE_DEFAULT_TTL_MS = 30 * 60 * 1000;
// A token is a hole in enforcement that nothing closes early, so the window has
// to be bounded by something other than the operator's typing. 24h is the point
// past which "I am fixing this right now" stops being the true description.
export const OVERRIDE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** `30m`, `90s`, `2h`. No bare numbers: `--ttl 30` is ambiguous enough that
 *  guessing minutes would eventually guess wrong in the permissive direction. */
export function parseOverrideTtl(value: string): number | null {
  const match = /^([1-9]\d{0,5})(s|m|h)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  const ms = amount * unit;
  return ms > 0 && ms <= OVERRIDE_MAX_TTL_MS ? ms : null;
}

// ── the per-install key ──────────────────────────────────────────────────────

const KEY_BYTES = 32;

function readKeyFile(keyPath: string): string | null {
  // A symlink AT the key path is refused rather than followed: the file's whole
  // job is to be a secret this install owns, and one that resolves somewhere
  // else is either not ours or is being aimed at a location an attacker can
  // read. Refusing degrades to "no key" → every token reads as forged → nothing
  // is honoured, which is the correct direction to fail.
  if (isSymlink(keyPath)) return null;
  const text = readText(keyPath);
  if (text === null) return null;
  const key = text.trim();
  return /^[0-9a-f]{64,}$/.test(key) ? key : null;
}

export function readOverrideKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return readKeyFile(overrideKeyPath(env));
}

/**
 * Read the key, creating it on first mint. ONLY the mint path calls this — a
 * gate that created a key would turn "no override has ever been minted on this
 * machine" (the common case, and one that should cost a single failed stat)
 * into a write from inside a pre-tool hook.
 *
 * `wx` + mode 0600, the same exclusive-create idiom local-prefs/prefs-store.ts
 * uses for its lock owner file: two doctors racing the first mint means one
 * creates and the other reads what the winner wrote, never two keys where the
 * second silently invalidates the first's freshly written token.
 */
export function ensureOverrideKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const keyPath = overrideKeyPath(env);
  const existing = readKeyFile(keyPath);
  if (existing) return existing;
  if (isSymlink(keyPath)) return null;
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyPath, `${crypto.randomBytes(KEY_BYTES).toString('hex')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    // EEXIST (a rival doctor won) or an unwritable HOME. Either way the answer
    // is whatever is on disk now.
  }
  return readKeyFile(keyPath);
}

// ── the MAC ──────────────────────────────────────────────────────────────────

/**
 * Every own key except `mac`, sorted, as `key=<json value>` lines.
 *
 * Derived from the object rather than an explicit field list on purpose: a
 * field added to OverrideToken is then authenticated the day it is added,
 * instead of the day someone remembers to extend a list. `JSON.stringify` on
 * each value (not the raw string) is what stops field-boundary confusion — a
 * `target` of `x\nrunId=y` cannot impersonate two fields.
 */
function macPayload(record: Record<string, unknown>): string {
  return Object.keys(record)
    .filter((key) => key !== 'mac')
    .sort()
    .map((key) => `${key}=${JSON.stringify(record[key])}`)
    .join('\n');
}

// Domain-separated: this key signs exactly one kind of statement today, and a
// second consumer that reuses it must not be able to produce a byte string this
// verifier accepts.
const MAC_DOMAIN = 'traffic-one/override/v1\n';

export function overrideMac(record: Record<string, unknown>, key: string): string {
  return crypto.createHmac('sha256', key).update(MAC_DOMAIN).update(macPayload(record)).digest('hex');
}

function macMatches(record: Record<string, unknown>, key: string, observed: string): boolean {
  const expected = overrideMac(record, key);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(String(observed || ''), 'utf8');
  // Length-checked before timingSafeEqual, which THROWS on a length mismatch —
  // an exception here would propagate out of a gate's deny path.
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// ── parsing + reading ────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseToken(value: unknown): OverrideToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== OVERRIDE_TOKEN_VERSION) return null;
  if (raw.scope !== 'gate' && raw.scope !== 'evidence') return null;
  if (!isNonEmptyString(raw.id)
    || !isNonEmptyString(raw.target)
    || !isNonEmptyString(raw.projectKey)
    || !isNonEmptyString(raw.projectRoot)
    || !isNonEmptyString(raw.runId)
    || !isNonEmptyString(raw.issuedAt)
    || !isNonEmptyString(raw.expiresAt)
    || !isNonEmptyString(raw.mac)) return null;
  if (!Number.isFinite(Date.parse(raw.expiresAt))) return null;
  return raw as unknown as OverrideToken;
}

const MAX_LEDGER_BYTES = 512 * 1024;
const MAX_RAW_LINE = 400;

/**
 * Every line of one project's ledger, each classified. Never throws, never
 * writes: this runs inside a pre-tool gate's deny path and inside settlement.
 *
 * Reads the WHOLE file rather than tailing it, and is therefore bounded: a
 * ledger past MAX_LEDGER_BYTES is refused outright rather than half-parsed,
 * because a half-parsed audit trail could drop exactly the line that makes a
 * run ineligible.
 */
export function readOverrideLedger(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideEntry[] {
  const file = overrideLedgerPath(projectRoot, env);
  let text: string | null = null;
  try {
    if (fs.statSync(file).size > MAX_LEDGER_BYTES) return [];
    text = readText(file);
  } catch {
    return [];
  }
  if (text === null) return [];
  const key = readOverrideKey(env);
  const projectKey = projectRootHash(projectRoot);
  const now = Date.now();
  const entries: OverrideEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const raw = trimmed.slice(0, MAX_RAW_LINE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      entries.push({ outcome: 'malformed', raw });
      continue;
    }
    const token = parseToken(parsed);
    if (!token) {
      entries.push({ outcome: 'malformed', raw });
      continue;
    }
    // No key, wrong project, or a MAC that does not verify are ONE outcome on
    // purpose. All three mean "this install cannot vouch for this line", and a
    // consumer that treated them differently would have to decide which kind of
    // unvouchable line to trust.
    if (!key || token.projectKey !== projectKey || !macMatches(parsed as Record<string, unknown>, key, token.mac)) {
      entries.push({ outcome: 'forged', token, raw });
      continue;
    }
    entries.push({ outcome: Date.parse(token.expiresAt) > now ? 'valid' : 'expired', token, raw });
  }
  return entries;
}

/**
 * The live token covering (run, scope, target), or null.
 *
 * The read every GATE does. Expiry is applied here and nowhere else, which is
 * what makes "a token past its TTL is treated as absent" true by construction
 * rather than by every caller remembering to check.
 */
export function activeOverrideToken(
  projectRoot: string,
  runId: string | null,
  scope: OverrideScope,
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideToken | null {
  if (!runId || !target) return null;
  for (const entry of readOverrideLedger(projectRoot, env)) {
    if (entry.outcome !== 'valid' || !entry.token) continue;
    if (entry.token.scope !== scope || entry.token.target !== target) continue;
    if (entry.token.runId !== runId) continue;
    return entry.token;
  }
  return null;
}

/**
 * Every override ever minted for this run, TTL IGNORED.
 *
 * The read SETTLEMENT does, and the difference from activeOverrideToken is the
 * whole abuse guard: an override expiring restores enforcement, it does not
 * restore the run's eligibility for `verified`/`shipped`. Otherwise waiting out
 * 30 minutes would launder the run.
 *
 * Keyed on MINTING, not on a gate observing the token in use, because gates are
 * read-only here — a "used" flag would need a gate to write, on the hot path,
 * to a file the same operator could then edit. Minting is also the honest event
 * to punish: an operator who mints an override for a run has declared that the
 * run's enforcement record is no longer complete, whether or not the token
 * happened to fire.
 */
export function runOverrideRecords(
  projectRoot: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideToken[] {
  if (!runId) return [];
  return readOverrideLedger(projectRoot, env)
    .filter((entry) => (entry.outcome === 'valid' || entry.outcome === 'expired') && entry.token?.runId === runId)
    .map((entry) => entry.token as OverrideToken);
}

/** Lines this install cannot vouch for. Never affects a verdict; exists so the
 *  doctor report can say so out loud, which is the only way anyone finds out. */
export function unvouchableOverrideEntries(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideEntry[] {
  return readOverrideLedger(projectRoot, env)
    .filter((entry) => entry.outcome === 'forged' || entry.outcome === 'malformed');
}

// ── minting ──────────────────────────────────────────────────────────────────

export interface MintOverrideInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly scope: OverrideScope;
  readonly target: string;
  readonly ttlMs?: number;
  /** The pre-override state this token will let past, captured by the caller
   *  (runners/doctor/unblock.ts) — a plain JSON value, written verbatim. */
  readonly snapshot: unknown;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}

export type MintOverrideFailure = 'no-key' | 'snapshot-write-failed' | 'ledger-write-failed';

export type MintOverrideResult =
  | { readonly ok: true; readonly token: OverrideToken; readonly snapshotPath: string }
  | { readonly ok: false; readonly reason: MintOverrideFailure };

/**
 * Write the token + its snapshot. A pure library call: the INTERACTIVITY
 * requirement ("minted only interactively") lives in the doctor CLI that calls
 * this, not here.
 *
 * That split is deliberate and is what keeps the confirmation un-bypassable.
 * The alternative — enforcing the TTY inside this function — would need an
 * escape hatch for its own tests, and a test-only escape hatch in a security
 * primitive is a bypass with a comment on it. Here the tests call the library
 * and the confirmation has no off switch at all.
 *
 * Snapshot BEFORE ledger, deliberately: a crash between the two leaves a
 * snapshot with no token (inert, an orphan file) rather than a live token whose
 * "what did this let past" evidence never landed.
 */
export function mintOverride(input: MintOverrideInput): MintOverrideResult {
  const env = input.env ?? process.env;
  const key = ensureOverrideKey(env);
  if (!key) return { ok: false, reason: 'no-key' };

  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs && input.ttlMs > 0
    ? Math.min(input.ttlMs, OVERRIDE_MAX_TTL_MS)
    : OVERRIDE_DEFAULT_TTL_MS;
  const id = crypto.randomBytes(12).toString('hex');
  const projectRoot = path.resolve(input.projectRoot);

  try {
    fs.mkdirSync(overrideRoot(env), { recursive: true, mode: 0o700 });
    fs.mkdirSync(overrideProjectDir(projectRoot, env), { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, reason: 'ledger-write-failed' };
  }

  const snapshotPath = overrideSnapshotPath(projectRoot, id, env);
  if (!writeJson(snapshotPath, input.snapshot)) return { ok: false, reason: 'snapshot-write-failed' };

  const unsigned = {
    v: OVERRIDE_TOKEN_VERSION,
    id,
    scope: input.scope,
    target: input.target,
    projectKey: projectRootHash(projectRoot),
    projectRoot,
    runId: input.runId,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    issuedByUser: safeUser(),
    issuedByHostname: safeHostname(),
    issuedByPid: process.pid,
    snapshot: path.basename(snapshotPath),
  };
  const token: OverrideToken = { ...unsigned, mac: overrideMac(unsigned, key) };
  if (!appendTextFile(overrideLedgerPath(projectRoot, env), `${JSON.stringify(token)}\n`)) {
    return { ok: false, reason: 'ledger-write-failed' };
  }
  return { ok: true, token, snapshotPath };
}

function safeUser(): string {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

function safeHostname(): string {
  try {
    return os.hostname() || '';
  } catch {
    return '';
  }
}
