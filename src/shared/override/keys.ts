// src/shared/override/keys.ts
// The per-install HMAC key and the MAC over a flat record. Extracted from
// token.ts so that the SECOND thing this key signs — the mint counter in the
// machine-owned one.json (mint-counter.ts) — can reuse it without importing the
// ledger reader that would import the counter back.
//
// ── What the HMAC is actually for ────────────────────────────────────────────
// It is NOT confidentiality and it is NOT protection from the machine's owner.
// It answers exactly one question: "did the doctor on this install issue this,
// or did something else write the file?" An agent can compose arbitrary JSON;
// it cannot compute a MAC over a key it has never read. So a fabricated ledger
// line reads as `forged` and is ignored — and, because that is a signal in its
// own right, REPORTED rather than silently dropped.
//
// The residual is honest and worth stating: an agent that can run arbitrary
// shell as the user can read the key file, and then it can forge tokens and
// counters alike. That agent can also overwrite the plugin itself, so no
// primitive at this layer closes it. What this closes is the realistic path —
// an agent that reasons its way to "I'll just write the unblock file myself".

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { readText } from '../fsjson';
import { isSymlink } from '../fs-nofollow';
import { overrideKeyPath } from './paths';

const KEY_BYTES = 32;

function readKeyFile(keyPath: string): string | null {
  // A symlink AT the key path is refused rather than followed: the file's whole
  // job is to be a secret this install owns, and one that resolves somewhere
  // else is either not ours or is being aimed at a location an attacker can
  // read. Refusing degrades to "no key" → nothing verifies → nothing is
  // honoured, which is the correct direction to fail.
  //
  // The ledger (token.ts) and the snapshots directory (snapshots.ts) DO follow
  // links, and the asymmetry is deliberate rather than an oversight. This file
  // is a secret whose value is trusted, so a link is a way to make us read a
  // key an attacker chose; those two are evidence, read for content nobody
  // trusts and verified by MAC either way, so a link redirects a read to a file
  // the same attacker could have written in place. What refusing there WOULD
  // buy is a new wedge: a planted link at the ledger path would read as
  // illegible and refuse certification for the whole project, which is a
  // capability worth strictly more to an attacker than the redirect it denies.
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
 * field added to a signed record is then authenticated the day it is added,
 * instead of the day someone remembers to extend a list. `JSON.stringify` on
 * each value (not the raw string) is what stops field-boundary confusion — a
 * `target` of `x\nrunId=y` cannot impersonate two fields.
 *
 * Values must be scalars or ARRAYS of scalars, never nested objects: an array
 * serializes in its own order, which JSON preserves, while an object's key
 * order is guaranteed by nothing, so a record carrying one could verify here
 * and fail after a round trip through a different writer. The token and the
 * mint counter are all-scalar; the reconciliation's run list is the one array.
 */
function macPayload(record: Record<string, unknown>): string {
  return Object.keys(record)
    .filter((key) => key !== 'mac')
    .sort()
    .map((key) => `${key}=${JSON.stringify(record[key])}`)
    .join('\n');
}

/**
 * Domain separation, and why there are two constants rather than one key used
 * twice: a ledger token and a mint counter are both flat records signed with
 * the same per-install secret, so without a distinct prefix a counter record
 * could in principle be replayed where a token is expected (and the reverse).
 * The counter exists precisely to contradict a doctored ledger; it must not be
 * forgeable out of the ledger's own bytes.
 */
export const OVERRIDE_TOKEN_MAC_DOMAIN = 'traffic-one/override/v1\n';
export const OVERRIDE_MINT_COUNTER_MAC_DOMAIN = 'traffic-one/override-mint-counter/v1\n';
// The operator reconciliation (reconcile.ts). Third domain for the third record
// this key signs, and the separation matters most here: a reconciliation
// FORGIVES a finding, so a counter or a token replayable into that slot would
// be a forgiveness nobody signed.
export const OVERRIDE_RECONCILIATION_MAC_DOMAIN = 'traffic-one/override-reconciliation/v1\n';

export function overrideMac(
  record: Record<string, unknown>,
  key: string,
  domain: string = OVERRIDE_TOKEN_MAC_DOMAIN,
): string {
  return crypto.createHmac('sha256', key).update(domain).update(macPayload(record)).digest('hex');
}

export function overrideMacMatches(
  record: Record<string, unknown>,
  key: string,
  observed: unknown,
  domain: string = OVERRIDE_TOKEN_MAC_DOMAIN,
): boolean {
  const expected = overrideMac(record, key, domain);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(typeof observed === 'string' ? observed : '', 'utf8');
  // Length-checked before timingSafeEqual, which THROWS on a length mismatch —
  // an exception here would propagate out of a gate's deny path.
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
