// src/shared/auth/machine-sidecar.ts
// Small versioned JSON files that live BESIDE one.json and belong to the
// machine, not to any project. Two of them exist: the revalidation cadence
// record (./revalidation-state.ts) and the update feed (./updates-store.ts).
//
// ── why beside one.json and not inside it ───────────────────────────────────
// The canonical envelope's `auth` section is validated by an EXACT key set —
// shared/one-settings.ts's isApiKeyAuthRecord requires
// `Object.keys(raw).length === 4` and rejects the record outright on a fifth
// field — so a `revalidatedAt` or a feed cursor added there would make every
// existing install's stored key unreadable, i.e. would log every user out. The
// envelope is also the SECRET file (0600, holds the key in plaintext); neither
// a cadence stamp nor a list of announcements is a secret, and neither should
// share the envelope's lifetime, since clearAuthentication deleting the `auth`
// section must not take them with it.
//
// Resolved from `oneSettingsPath` rather than from `globalTrafficOneDir`: the
// same override (TRAFFIC_ONE_STATE_PATH) that relocates the record these files
// are ABOUT must relocate them too, or a test that isolates one silently reads
// another machine's history.
//
// ── the write fence, and why these writes go around it ──────────────────────
// `<machine dir>/**` is not automatically machine-owned. state/plugin-use.ts's
// fence is addressed by PATH and is default-CLOSED, and for a session rooted at
// $HOME the machine dir IS that "project's" state dir — so a write here through
// shared/fsjson.ts would be governed by the $HOME project's use-plugin consent
// question, and refused while it is unanswered. That is the exact deadlock
// MACHINE_OWNED_ENTRIES exists to prevent, and the exact trap two earlier lanes
// fell into (the override store's paths.ts carries the note about it).
//
// This module's own writes go through plain `fs` — the codebase's sanctioned
// and documented way to opt out ("a writer that wants to bypass it has to reach
// past those helpers to raw `fs` and say so", state/plugin-use.ts) and exactly
// what shared/one-settings.ts, the other owner of this directory, already does
// for the very same reason. Saying so is what this comment is.
//
// Both file names are ALSO listed in MACHINE_OWNED_ENTRIES.files, so the raw-fs
// opt-out is belt and the declared exemption is braces. That second line is
// what a future reader or writer reaching for shared/fsjson.ts's guarded
// helpers instead of this module gets: without it, such a writer is silently
// fenced on a $HOME-rooted session, where the machine dir IS the "project's"
// state dir. Both names must move together if either file is ever renamed.

import * as fs from 'fs';
import * as path from 'path';

import { oneSettingsPath } from '../one-settings';
import { readJson } from '../fsjson';

/** The absolute path of a sidecar, beside the canonical settings envelope. */
export function machineSidecarPath(fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(oneSettingsPath(env)), fileName);
}

/**
 * `null` for absent, unreadable, malformed, or written by a different schema
 * version. All four mean "this machine has no usable state here", which every
 * caller already has to handle as its cold-start case. Never throws, and never
 * rewrites the file it could not read.
 */
export function readMachineSidecar(
  fileName: string,
  version: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | null {
  const raw = readJson<Record<string, unknown> | null>(machineSidecarPath(fileName, env), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw.version === version ? raw : null;
}

/**
 * Replace the file atomically. FALSE when the write was refused, and callers
 * are expected to SPEND that boolean rather than ignore it: a cadence that
 * cannot be recorded is a probe that fires on every session, and an outcome
 * that cannot be recorded must not read as a recorded one.
 *
 * Temp + rename, mode 0600, matching shared/one-settings.ts.
 */
export function writeMachineSidecar(
  fileName: string,
  version: number,
  state: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const filePath = machineSidecarPath(fileName, env);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify({ version, ...state }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    return false;
  }
}

/** Whole-second ISO, matching shared/text.ts's nowIsoNoMs — which every other
 *  timestamp in the auth record uses, and which takes no clock argument, so the
 *  same shape is produced here from a caller-supplied instant instead. */
export function isoNoMs(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
