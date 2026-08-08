// src/shared/auth/start-revalidation.ts
// The SessionStart side of revalidation: decide whether a probe is owed, charge
// it to the cadence, fire the worker DETACHED, and hand back whatever the last
// completed probe left for the user to see.
//
// ── why nothing here blocks ─────────────────────────────────────────────────
// SessionStart is a hook on the critical path with a 150 ms p95 in-process
// dispatch budget (tests/hook-timing/hook-timing.test.ts) that the busiest row
// meets with ~3.3x headroom. `validateApiKey`'s timeout is 10 000 ms — 220x the
// whole SessionStart budget — so a synchronous probe would not "slow the hook
// down", it would replace it. That is the exact defect the hooks-fast lane
// removed when it took the nested synchronous `spawnSync` to
// `scripts/one-mcp-sync.cjs` off this path (measured 927.91 ms -> 238.33 ms at
// the OS process boundary), and this lane follows that precedent rather than
// reintroducing its shape one file over: modules/session/one-mcp-sync.ts's
// `syncOneMcpDetached` is the model — same `detached: true` + `stdio: 'ignore'`
// + `unref()`, same "a missing runner is a REPORTED outcome, not a silent
// null", same discriminated result type.
//
// Two things make the cost smaller than that precedent's, and both are
// deliberate:
//
//   - The spawn is CADENCED, not per session. In steady state this function
//     reads one small JSON file, compares two numbers, and returns. It spawns
//     nothing at all on the overwhelming majority of sessions.
//   - The cadence is MACHINE-level (config/auth.ts AUTH_REVALIDATION_CADENCE_MS,
//     stored beside one.json), because the credential is machine-level. A
//     per-project cadence would multiply one machine-wide question by (projects
//     x sessions) — and the server rate-limits at 60 requests/min per USER
//     identity across every machine that user owns, so a per-project cadence is
//     not merely wasteful, it is a budget a busy user could actually spend.
//
// ── what the user sees between a revocation and the next session ────────────
// Nothing, and that is the design rather than a gap. The probe that discovers a
// revocation runs AFTER this hook has returned, so the session that started it
// is already running on a record that was still valid when it was read. The
// worker clears the record; the NEXT SessionStart's existing pure-local auth
// gate finds no record and routes to the api-key wizard step. One session of
// grace after a revocation, bounded by the cadence and by the session's own
// length, is the price of not putting a 10-second network call in front of
// every session start.
//
// The two states that are NOT self-resolving get a visible advisory instead of
// a silent wait — see revalidation.ts, which decides both.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { authEnforced } from './index';
import { readSimpleAuth } from './simple-auth';
import { pluginRoot } from '../paths';
import {
  readRevalidationState,
  stampRevalidationAttempt,
} from './revalidation-state';
import { sessionRevalidationPlan, type RevalidationDueReason } from './revalidation';

type SpawnDetached = typeof spawn;

/**
 * The compiled worker entry.
 *
 * A NESTED compiled path, not one of build-runtime.ts's flat `scripts/*.cjs`
 * shims, and that is a deliberate choice rather than an oversight. Those shims
 * exist to preserve LEGACY CLI PATHS — the file names host configs, shipped
 * skills, deploy gates and prose already invoke ("so host configs + skills +
 * spawns keep invoking scripts/hook-runtime.cjs", build-runtime.ts). This
 * worker is internal: it is spawned from exactly one place, this function, and
 * no shipped prose, host config or user-facing command names it, so it has no
 * legacy path to preserve and adding one would put a permanent public entry
 * point in the install for a private background task. `tsconfig.build.json`
 * emits the whole `src/` tree, so the path exists in any real install.
 *
 * The trade it accepts, stated: the flat shims carry the ES5 node-floor guard
 * (shared/node-floor.ts) above their require, and this path does not. On a node
 * below the floor this child dies with a SyntaxError into `stdio: 'ignore'` and
 * revalidation silently does not happen — while the hook process that spawned
 * it has already require()d the same ES2022 tree, so the floor was breached
 * before this file was reached and the product has a louder problem than a
 * missed revalidation.
 */
const WORKER_REL_PATH = path.join('scripts', 'runners', 'auth', 'revalidate.js');

export type AuthRevalidationStart =
  | { readonly kind: 'started'; readonly reason: RevalidationDueReason }
  | {
    readonly kind: 'skipped';
    readonly reason: 'auth-not-enforced' | 'not-authenticated' | 'within-cadence';
  }
  | { readonly kind: 'unavailable'; readonly reason: 'worker-missing' | 'stamp-refused' | 'spawn-refused' };

export interface AuthRevalidationResult {
  readonly start: AuthRevalidationStart;
  /** One line for the session header, or null. Independent of `start`: the
   *  advisory describes the last CONCLUDED probe, not the one just fired. */
  readonly advisory: string | null;
}

export interface StartAuthRevalidationDeps {
  readonly spawnDetached?: SpawnDetached;
  readonly workerPath?: string;
  readonly nowMs?: number;
}

/**
 * Read the machine's revalidation history, decide, and act.
 *
 * Every exit is a NAMED outcome. `syncOneMcpForSession` answered `null` for
 * four unrelated situations until modules/session/one-mcp-sync.ts split them
 * apart, and a damaged install was then indistinguishable from a deliberate
 * opt-out at every call site; this function is written on the other side of
 * that lesson from the start.
 */
export function startAuthRevalidation(
  env: NodeJS.ProcessEnv = process.env,
  deps: StartAuthRevalidationDeps = {},
): AuthRevalidationResult {
  const silent = (start: AuthRevalidationStart): AuthRevalidationResult => ({ start, advisory: null });
  if (!authEnforced(env)) return silent({ kind: 'skipped', reason: 'auth-not-enforced' });

  // No stored key means there is nothing to revalidate, and the existing
  // pure-local gate is already sending this session to the wizard.
  const record = readSimpleAuth(env);
  if (!record) return silent({ kind: 'skipped', reason: 'not-authenticated' });

  const nowMs = deps.nowMs ?? Date.now();
  const state = readRevalidationState(env);
  const plan = sessionRevalidationPlan(record.apiKey, state, nowMs, env);
  const withAdvisory = (start: AuthRevalidationStart): AuthRevalidationResult => ({ start, advisory: plan.advisory });
  if (!plan.due) return withAdvisory({ kind: 'skipped', reason: 'within-cadence' });

  const worker = deps.workerPath || path.join(pluginRoot(), WORKER_REL_PATH);
  if (!fs.existsSync(worker)) return withAdvisory({ kind: 'unavailable', reason: 'worker-missing' });

  // Charge the cadence BEFORE spawning, and refuse to spawn if the charge was
  // refused. The inverse order is the bug: a probe that cannot be recorded is a
  // probe that is owed again on the very next session, so an unwritable state
  // directory would turn a once-a-day background call into one per session, per
  // project, against a 60/min per-user budget shared with every other machine
  // that user owns.
  if (!stampRevalidationAttempt(nowMs, state, env)) {
    return withAdvisory({ kind: 'unavailable', reason: 'stamp-refused' });
  }

  const spawnDetached = deps.spawnDetached ?? spawn;
  try {
    const child = spawnDetached(process.execPath, [worker], {
      // The worker touches machine state only; the plugin root is a stable cwd
      // that cannot make it look like it belongs to whichever project happened
      // to start this session.
      cwd: path.dirname(worker),
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    return withAdvisory({ kind: 'unavailable', reason: 'spawn-refused' });
  }
  // `dueReason` rather than a bare 'started': "we probed because the cadence
  // elapsed" and "we probed because a revocation could not be applied" are the
  // same event with very different meanings in a diagnostic.
  return withAdvisory({ kind: 'started', reason: plan.dueReason as RevalidationDueReason });
}
