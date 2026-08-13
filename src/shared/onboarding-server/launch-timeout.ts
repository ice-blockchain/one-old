// src/shared/onboarding-server/launch-timeout.ts
// The BOUND on the retry a launch timeout is allowed to prescribe.
//
// A launch timeout must be retryable — it is a fact about time, not about the
// installation, and the routine cause (a concurrent hook holding the launch
// lock) is documented as NORMAL in ensure.ts. But "just try again" with no bound
// is the retry loop the terminal classification was written to prevent, and the
// prose alone is not a bound: an agent can ignore "retry ONCE". So the runtime
// holds the budget and the second timeout renders TERMINAL instead.
//
// The claim lives next to the launch lock and the server record, under the
// user-local runtime dir (`~/.traffic-one/projects/<hash>/onboarding/<host>/`),
// NOT in the project. That is deliberate: the project write fence
// (shared/fsjson.ts) refuses project writes while the use-plugin question is
// unanswered, and a bound that silently fails to persist is not a bound — it
// would prescribe an unbounded retry in exactly the pre-consent state where the
// gate is loudest. Everything this file writes is beside state ensure.ts already
// creates on the same path, so it adds no new location and no project bytes.
//
// Keyed by (project, host) rather than by session: hooks are one process per
// event, two hosts can drive the same project, and the thing being bounded is
// attempts against ONE launcher.

import * as fs from 'fs';
import * as path from 'path';

import { serverLockPath } from './registry';
import { readRegularFileOrThrow } from '../bounded-read';

/**
 * How long one spent retry suppresses the next. Ten minutes: an onboarding turn
 * cycle (post the link, the user opens the wizard, the waiter blocks) is minutes,
 * while a server start is under a second (measured: 290ms median idle, 2.1s worst
 * under eight-way concurrent load), so a fresh timeout this much later is a new
 * event rather than the same loop. Inside any window at most ONE retry is ever
 * prescribed, which is comfortably below DENY_REPEAT_ESCALATE_AT (3) — the
 * prescribed recovery can therefore never trip the deny-repeat escalation that
 * would tell the agent to report BLOCKED for doing what it was told.
 */
export const LAUNCH_TIMEOUT_RETRY_TTL_MS = 10 * 60 * 1000;

function claimPath(cwd: string, env: NodeJS.ProcessEnv, host?: unknown): string {
  return path.join(path.dirname(serverLockPath(cwd, env, host)), 'launch-timeout.claim');
}

type ClaimOutcome = 'claimed' | 'held' | 'unavailable';

// O_EXCL, like the launch lock: existence IS the claim, so an atomic
// create-if-absent is the whole protocol and two concurrent hooks cannot both
// spend the one retry.
function tryCreate(file: string, now: number): ClaimOutcome {
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, `${JSON.stringify({ at: now, pid: process.pid })}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return 'claimed';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'held' : 'unavailable';
  }
}

/**
 * May THIS launch timeout prescribe a retry?
 *
 * True at most once per (project, host) per LAUNCH_TIMEOUT_RETRY_TTL_MS. Every
 * other answer is false, and every failure answers false rather than true: an
 * unwritable runtime dir, a refused create, an unreadable claim we cannot date.
 * That direction is the safe one — a wrongly-terminal timeout costs the user one
 * retry they have to type themselves, while a wrongly-retryable one is the
 * unbounded loop this file exists to make unreachable.
 */
export function claimLaunchTimeoutRetry(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
  now: number = Date.now(),
): boolean {
  const file = claimPath(cwd, env, host);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return false; // cannot persist a bound ⇒ do not hand out a retry
  }
  const first = tryCreate(file, now);
  if (first !== 'held') return first === 'claimed';

  // A claim already exists. Inside the TTL it means this project+host has spent
  // its retry; outside it, the window has re-armed.
  let claimedAt = 0;
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(file)) as { at?: unknown };
    claimedAt = Number(parsed?.at);
  } catch {
    claimedAt = 0;
  }
  if (!Number.isFinite(claimedAt) || claimedAt <= 0) {
    // Torn or planted content: fall back to the file's own mtime rather than
    // treating an undateable claim as expired, which would re-arm the retry on
    // every attempt and reinstate the unbounded loop.
    try {
      claimedAt = fs.statSync(file).mtimeMs;
    } catch {
      return false;
    }
  }
  if (now - claimedAt < LAUNCH_TIMEOUT_RETRY_TTL_MS) return false;
  try {
    fs.unlinkSync(file);
  } catch {
    return false;
  }
  return tryCreate(file, now) === 'claimed';
}
