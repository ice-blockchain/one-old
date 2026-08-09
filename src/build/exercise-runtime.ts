// src/build/exercise-runtime.ts
// The shared runtime exercise: invoke a plugin's legacy-named .cjs shims under
// bare `node` and prove an UNAUTHENTICATED tool use is denied by the priority-0
// auth gate, in each supported host's own wire shape.
//
// Two callers, deliberately:
//   - `npm run smoke` (compiled-smoke.ts) runs it against the scratch cutover
//     build it has just produced — "the TypeScript engine compiles to a runtime
//     that dispatches", one of the two cutover risks that file exists for;
//   - `npm run plugin:sync`'s per-host verify() (sync-hosts.ts) runs it against
//     the bundle the host actually SERVES. That turns "install-verifiable" from
//     a package.json version this command stat'ed into a proof that the
//     installed runtime loads and reaches a named gate.
//
// THE ENVIRONMENT IS A REQUIRED PARAMETER, and the paths that decide where this
// exercise writes are separate REQUIRED FIELDS of it rather than keys a caller
// remembers to put on an env object. That is the entire reason this is a shared
// unit with a typed argument instead of a copied block: the smoke runs on a
// scratch tree where a missed pin costs nothing, while plugin:sync runs on the
// maintainer's own machine, where an unpinned HOME writes consent rows and
// onboarding state into the real ~/.traffic-one. A caller that forgets one must
// fail to COMPILE, not on someone's laptop.
//
// Nothing in this file reads `process.env`, including through a helper — see
// __tests__/exercise-runtime.test.ts, which asserts that textually, because a
// single ambient read anywhere in here restores exactly the hazard the required
// fields were introduced to remove.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The auth gate's own words. Asserting the DECISION alone is not enough: every
// branch that could answer one of these calls answers with a deny, so `deny` on
// its own says only "something objected", not "the unauthenticated gate
// objected".
export const AUTH_DENY = 'Traffic One setup is required before building';

/** The legacy-path shims this exercise invokes; all four must be present. */
export const EXERCISED_SHIMS = [
  'hook-runtime.cjs',
  'cursor-hook-runtime.cjs',
  'windsurf-hook-runtime.cjs',
  'devin-hook-runtime.cjs',
] as const;

export interface ShimResult { status: number | null; stdout: string; stderr: string; }

/**
 * Invoke a legacy-path shim (e.g. hook-runtime.cjs) at `scripts` and report
 * whatever it did, including a block. Never throws on a non-zero exit: two of
 * the four host wire shapes below signal a deny THROUGH the exit status.
 */
export function runShimAllowingBlock(
  scripts: string,
  shim: string,
  subcommand: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
): ShimResult {
  const result = spawnSync(process.execPath, [path.join(scripts, shim), subcommand], {
    input: stdin, encoding: 'utf8', env, timeout: 20000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/**
 * How this exercise reaches the auth gate — a REQUIRED choice, because the two
 * callers get there by different routes and neither one's route is a safe
 * default for the other.
 *
 * `recorded-consent`: the caller has already answered the "use Traffic One
 * here?" question for these projects, through the same compiled
 * recordPluginUseChoice call production's `--use` answer makes. The ask-first
 * flag is left at its SHIPPED default. This is the smoke's route, and it is why
 * the smoke's assertions are about authentication at all: on an unanswered
 * project the ask-first branch denies every one of these calls before auth is
 * ever consulted, so each host check passes off a deny that has nothing to do
 * with authentication.
 *
 * `ask-disabled`: no consent record exists and none is created —
 * TRAFFIC_ONE_ASK_USE_PLUGIN=off stands the question down so the auth gate is
 * again the first thing to speak. This is plugin:sync's route: recording
 * consent means an in-process require of the INSTALLED bundle plus a
 * process.env mutation to make its write fence read the fixture, and doing that
 * inside a command that runs on the maintainer's real machine is the ambient
 * read this file exists to refuse.
 */
export type ExerciseConsent = 'recorded-consent' | 'ask-disabled';

export interface RuntimeExercisePins {
  /**
   * Inherited environment for the child processes (PATH, TMPDIR, ...). Every
   * variable this exercise's verdict depends on is pinned below and overwrites
   * whatever is in here, so a base carrying stale Traffic One state cannot
   * change the answer — but a base carrying a host marker (CURSOR_PLUGIN_ROOT,
   * CODEX_THREAD_ID) still can, so callers outside a scratch fixture should
   * strip those first (sync-hosts.ts's exerciseBaseEnv).
   */
  readonly base: NodeJS.ProcessEnv;
  /** HOME for the children. Required: the per-user prefs that hold the consent
   *  answer live at ~/.traffic-one/projects/<hash>, so an unpinned HOME makes
   *  every one of these calls read — and on any path that records rather than
   *  reads, WRITE — the machine's real state. */
  readonly home: string;
  /** TRAFFIC_ONE_PLUGIN_ROOT: the plugin root `scripts` belongs to, so gate
   *  prose and generated recovery commands resolve against the same install. */
  readonly pluginRoot: string;
  /** TRAFFIC_ONE_STATE_PATH: the machine settings file. */
  readonly statePath: string;
  /** TRAFFIC_ONE_PROJECT_PREFS_PATH: ONE prefs file for every project below —
   *  projectPrefsPath() returns it without consulting cwd, which is what lets a
   *  single recorded answer cover all four host legs. */
  readonly projectPrefsPath: string;
  readonly consent: ExerciseConsent;
}

/**
 * The exact environment the exercised children receive. Exported because the
 * `recorded-consent` caller has to record its answer against the SAME prefs
 * file the children will read, and reading it back out of here is the only way
 * the two cannot drift.
 *
 * AUTH is forced on (the exercise is about the auth gate), NO_SPAWN is forced
 * on (the unauthenticated gate delegates to the onboarding gate, which would
 * otherwise launch a real wizard server), and XDG_STATE_HOME is deleted (it
 * relocates the whole per-user state dir out from under the pinned HOME).
 * Those three are invariants of the exercise rather than caller choices — a
 * caller cannot forget them because it is never asked for them.
 */
export function exerciseEnv(pins: RuntimeExercisePins): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...pins.base,
    HOME: pins.home,
    TRAFFIC_ONE_AUTH: 'on',
    TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1',
    TRAFFIC_ONE_STATE_PATH: pins.statePath,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: pins.projectPrefsPath,
    TRAFFIC_ONE_PLUGIN_ROOT: pins.pluginRoot,
  };
  delete env.XDG_STATE_HOME;
  if (pins.consent === 'ask-disabled') env.TRAFFIC_ONE_ASK_USE_PLUGIN = 'off';
  else delete env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  return env;
}

/**
 * One project cwd per host. The unauthenticated gate delegates to the
 * onboarding gate, which writes per-project session markers (the
 * once-per-session deny walkthrough); sharing one cwd across hosts would let
 * the first call's marker steer the next host's branch. A real session is one
 * host per project, so per-host cwds match reality and keep the four checks
 * independent.
 */
export interface RuntimeExerciseProjects {
  readonly claude: string;
  readonly cursor: string;
  readonly windsurf: string;
  readonly devin: string;
}

export interface RuntimeExercise {
  /** The directory holding the legacy-named .cjs shims: an install's scripts/. */
  readonly scripts: string;
  readonly pins: RuntimeExercisePins;
  readonly projects: RuntimeExerciseProjects;
}

export interface RuntimeExerciseReport {
  /**
   * The host legs that ran, in order — the POPULATION every assertion about
   * this exercise is really about. A test (or a caller) that only reads
   * `problem` certifies nothing when discovery breaks: "no leg objected" and
   * "no leg ran" are the same null.
   */
  readonly exercised: string[];
  /** The FIRST problem found, or null. Fail-fast, so `exercised` stops there. */
  readonly problem: string | null;
}

function exitProblem(shim: string, subcommand: string, result: ShimResult): string | null {
  if (result.status !== 0 && result.status !== null) {
    return `${shim} ${subcommand} exited ${result.status}: ${result.stderr || ''}`;
  }
  return null;
}

function authDenyProblem(host: string, reason: unknown): string | null {
  if (String(reason || '').includes(AUTH_DENY)) return null;
  return `${host} deny did not come from the unauthenticated gate (reason: ${String(reason || '(empty)').slice(0, 160)})`;
}

/**
 * Run the exercise. Returns the legs that ran and the first problem, rather
 * than throwing: the smoke turns a problem into its own fail() line (so the
 * wording a failing `npm run smoke` prints is unchanged), and plugin:sync turns
 * it into a per-host VerifyResult. A JSON parse of a shim's stdout is
 * deliberately NOT guarded — a host wrapper that emits unparseable output has
 * failed in a way neither caller should paper over as a tidy problem string.
 */
export function exerciseRuntime({ scripts, pins, projects }: RuntimeExercise): RuntimeExerciseReport {
  const exercised: string[] = [];
  const done = (problem: string | null): RuntimeExerciseReport => ({ exercised, problem });

  for (const shim of EXERCISED_SHIMS) {
    if (!fs.existsSync(path.join(scripts, shim))) return done(`missing shim ${shim}`);
  }

  const env = exerciseEnv(pins);

  // Claude. pluginRoot points at the install, so skillBlock reads the gate
  // prose that shipped with it rather than the TS fallback.
  exercised.push('claude');
  const claudeStdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: path.join(projects.claude, 'x.ts'), content: 'export const x = 1;' },
    cwd: projects.claude,
  });
  const claudeRun = runShimAllowingBlock(
    scripts, 'hook-runtime.cjs', 'check-plan-write', claudeStdin, { ...env, TRAFFIC_ONE_HOST: 'claude' },
  );
  const claudeExit = exitProblem('hook-runtime.cjs', 'check-plan-write', claudeRun);
  if (claudeExit) return done(claudeExit);
  const claudeOut = JSON.parse(claudeRun.stdout || '{}');
  if (claudeOut.hookSpecificOutput?.permissionDecision !== 'deny') {
    return done('hook-runtime.cjs shim did not deny an unauthed write');
  }
  const claudeDeny = authDenyProblem('Claude', claudeOut.hookSpecificOutput?.permissionDecisionReason);
  if (claudeDeny) return done(claudeDeny);
  if (String(claudeOut.hookSpecificOutput?.additionalContext || '').includes('traffic-one-hook-context:v1')) {
    return done('Claude hook context incorrectly carried the Codex-only provenance marker');
  }

  // Control: the SAME call with auth not enforced. This is what makes the
  // denies attributable — if they survive auth being switched off, they were
  // never the auth gate's. Deliberately not asserted as an allow: the claim is
  // only that this specific deny is auth's, so a future unrelated gate
  // objecting here must not read as an auth-gate regression.
  exercised.push('claude-auth-off-control');
  const controlRun = runShimAllowingBlock(
    scripts, 'hook-runtime.cjs', 'check-plan-write', claudeStdin,
    { ...env, TRAFFIC_ONE_AUTH: 'off', TRAFFIC_ONE_HOST: 'claude' },
  );
  const controlExit = exitProblem('hook-runtime.cjs', 'check-plan-write', controlRun);
  if (controlExit) return done(controlExit);
  const claudeAuthOff = JSON.parse(controlRun.stdout || '{}');
  if (String(claudeAuthOff.hookSpecificOutput?.permissionDecisionReason || '').includes(AUTH_DENY)) {
    return done('the unauthenticated deny fired with auth switched off — the checks above are not testing the auth gate');
  }

  // Cursor. Its wire shape carries the reason in user_message, so an empty one
  // is a real defect on its own — but non-emptiness cannot say WHERE the
  // wording came from: a resolved T1BLOCK and its verbatim TS fallback are
  // byte-identical by design, so the text check below is what names the gate.
  exercised.push('cursor');
  const cursorRun = runShimAllowingBlock(
    scripts, 'cursor-hook-runtime.cjs', 'before-shell-execution',
    JSON.stringify({ cwd: projects.cursor, command: 'npm run build' }), env,
  );
  const cursorExit = exitProblem('cursor-hook-runtime.cjs', 'before-shell-execution', cursorRun);
  if (cursorExit) return done(cursorExit);
  const cursorOut = JSON.parse(cursorRun.stdout || '{}');
  if (cursorOut.permission !== 'deny') return done('cursor-hook-runtime.cjs shim did not deny an unauthed shell');
  if (!cursorOut.user_message) return done('cursor deny had no user_message');
  const cursorDeny = authDenyProblem('Cursor', cursorOut.user_message);
  if (cursorDeny) return done(cursorDeny);

  // A MUTATING command, unlike Claude's and Cursor's calls above. Windsurf and
  // Devin are the hosts whose gate releases read-only orientation while setup
  // is pending (their recipe rides the native prompt-submit context instead),
  // and `npm run build` classifies as orientation — so these two legs pass only
  // on a command the gate cannot release.
  exercised.push('windsurf');
  const windsurfOut = runShimAllowingBlock(
    scripts, 'windsurf-hook-runtime.cjs', 'pre_run_command',
    JSON.stringify({ agent_action_name: 'pre_run_command', tool_info: { cwd: projects.windsurf, command_line: 'git push --force' } }),
    env,
  );
  if (windsurfOut.status !== 2) {
    return done(`windsurf-hook-runtime.cjs shim did not exit 2 on an unauthed shell (status ${windsurfOut.status})`);
  }
  if (!windsurfOut.stderr) return done('windsurf deny had no stderr message');
  const windsurfDeny = authDenyProblem('Windsurf', windsurfOut.stderr);
  if (windsurfDeny) return done(windsurfDeny);

  exercised.push('devin');
  const devinRun = runShimAllowingBlock(
    scripts, 'devin-hook-runtime.cjs', 'check-onboarding-gate',
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd: projects.devin,
      tool_name: 'exec',
      tool_input: { command: 'git push --force' },
    }),
    env,
  );
  const devinExit = exitProblem('devin-hook-runtime.cjs', 'check-onboarding-gate', devinRun);
  if (devinExit) return done(devinExit);
  const devinOut = JSON.parse(devinRun.stdout || '{}');
  if (devinOut.decision !== 'block') return done('devin-hook-runtime.cjs shim did not block an unauthed exec');
  return done(authDenyProblem('Devin', devinOut.reason));
}
