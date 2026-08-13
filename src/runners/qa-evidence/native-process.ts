// src/runners/qa-evidence/native-process.ts
// Bounded native process execution and artifact collection.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  contentHash,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import { escapeCmdArgument, escapeCmdCommand, resolveWindowsCommand } from '../../shared/spawn-tool';
import { sha256 } from '../../shared/text';

import {
  type RunnerArgs,
} from './types';
import { emitProgress } from './report-publish';
import {
  GROUP_KILLS_AVAILABLE,
  killProcessGroup,
  reapOnInterrupt,
  spawnedGroupId,
} from './process-group';
import {
  safeProjectRelative,
  strictRelative,
} from './run-context';
import {
  parseBoundedArgv,
} from './bounded-argv';

/**
 * Every way a bounded run can END, as ONE list.
 *
 * The type is derived from the array rather than written beside it, because the
 * two consumers that matter — `cutShortCause` in stack.ts and
 * `nativeRunCutShort` in native.ts — decide between "cut short, so no verdict
 * exists" and "ran to a verdict", and the second of those arms reads a zero
 * exit code as a PASS. Both were `if`-chains ending in a null return, so a new
 * member landed on the pass arm with no compile error and no test failure:
 * measured, a sixth kind added to the union produced ZERO errors from
 * `tsc --noEmit` (checked against a deliberate type error in the same file, so
 * the check was not vacuous). Both are now exhaustive switches over this list,
 * which makes a missing arm a compile error, and the enumeration test in
 * __tests__/inconclusive-evidence.test.ts walks this array so the runtime half
 * is pinned too — a compile-time guard and a runtime guard fail in different
 * circumstances.
 *
 * `start-failed` is here because NEITHER guard could see the hole it closes.
 * The exhaustion refusals below arrived as `completed` with a null exit code,
 * so both switches were exhaustive, both answered "not cut short", and the
 * false green was decided one layer up in a branch keyed on `exitCode` — a
 * place the `never` assertion structurally cannot reach. A new distinction on
 * this path therefore belongs in this LIST, where both classifiers are forced
 * to decide it, and not in a wider mapping at one call site: the mapping can be
 * changed to any value that happens to be green, and nothing fails.
 */
export const BOUNDED_PROCESS_KINDS = [
  'completed', 'unavailable', 'start-failed', 'timeout', 'output-limit', 'abandoned',
] as const;

export type BoundedProcessKind = typeof BOUNDED_PROCESS_KINDS[number];

/**
 * Which kind an ASYNCHRONOUS spawn refusal is — and the whole reason there are
 * two of them.
 *
 * Node delivers exactly five errnos on the child rather than throwing them out
 * of `spawn`: ENOENT, EACCES, EAGAIN, EMFILE, ENFILE (internal/child_process.js
 * hands those to `process.nextTick`; everything else, the UV_EINVAL a `.cmd`
 * earns among it, is thrown). This file used to map ENOENT to `unavailable` and
 * the other four to `completed` — "ran to a verdict", with `signal: null` — so
 * both cut-short classifiers answered "not cut short" and `runStackCheck` fell
 * into its "could not be executed" branch. Measured end to end by exhausting
 * the runner's own fd table and then asking it to run a command that works:
 * `kind: 'completed'`, `exitCode: null`, empty stdout, `spawn go EMFILE` on
 * stderr, `justifiedNoStackCommand: TRUE`, `stack-test` excused, run GREEN. A
 * run that measured nothing reported a pass, wearing the exact prose the
 * validator describes as the most expensive shape it can accept.
 *
 * The line is NOT the errno list, it is WHOSE fault the refusal is, because
 * that decides whether re-running can change the answer:
 *
 *   the TARGET  — ENOENT (nothing at that path), EACCES (present, and not
 *                 executable by us: no execute bit, a `noexec` mount, a path
 *                 component we cannot search). Static properties of the
 *                 declared command. Re-running produces the identical refusal,
 *                 and the repair is to the project or its toolchain. This is
 *                 the same fact as "declared but its binary is absent", which
 *                 this runner already excuses deliberately on the 127 arm in
 *                 stack.ts, and it is what `unavailable` has always meant.
 *   the RUNNER  — EAGAIN (no process slot), EMFILE (our own fd table),
 *                 ENFILE (the machine's). The command exists, is executable,
 *                 and WOULD have produced a verdict; this process could not
 *                 start it. Calling that "the command could not be executed" is
 *                 a category error, and it is the everyday failure of a runner
 *                 that holds a process group, a dev server and a Chrome under a
 *                 CI `ulimit`. Nothing was measured, so the only honest answer
 *                 is the INCONCLUSIVE one, and that is `start-failed`.
 *
 * `unavailable` was not enough on its own, and this is why the fix is a union
 * member rather than a wider ternary: `unavailable` is ALSO green here — it is
 * the arm the justified exemption is built on — so mapping all five to it
 * changes no verdict at all (a peer mutated exactly that and no test failed).
 * The distinction has to EXIST before either classifier can act on it.
 *
 * Anything else that reaches a child's `error` listener — an EPERM from a
 * `child.kill` on a teardown path is the reachable one — is `start-failed`
 * too. That is the fail-closed direction: an error this runner cannot name,
 * arriving while a run is still in flight, must not be read as a verdict.
 */
export function spawnRefusalKind(code: string | undefined): BoundedProcessKind {
  return code === 'ENOENT' || code === 'EACCES' ? 'unavailable' : 'start-failed';
}

/**
 * The arm a classifier reaches for a kind that did not exist when it was
 * written. Unreachable while both switches are exhaustive — the parameter is
 * `never`, so adding a member to the list above is a compile error at every
 * call site — and it still answers, rather than throwing, for the case where
 * some future caller reaches it through a cast: an unrecognized ending is CUT
 * SHORT, which is rejectable, and that is the fail-closed direction. The
 * alternative default (null) is the false green this lane exists to close.
 */
export function unclassifiedProcessKind(kind: never): string {
  return `ended in a way this runner cannot classify (${String(kind)}), so no verdict can be read from it`;
}

export interface BoundedProcessResult {
  /**
   * How the run ENDED, which is not the same question as what it produced.
   *
   * `start-failed` is the one that never began: the operating system refused
   * this process a descriptor or a process slot, so a command that exists and
   * would have produced a verdict was never started. It is deliberately NOT
   * `unavailable` — see `spawnRefusalKind` — because `unavailable` means "there
   * is nothing to run here", which is exempt, and this means "we could not run
   * it", which is inconclusive and rejectable.
   *
   * `abandoned` is the shape a bound cannot express any other way: the command
   * itself exited, but something it started outlived it still holding the
   * inherited stdout, so no `close` was ever coming and the run reached its
   * bound with the leader already reaped. The forgotten `&` in an integration
   * `test` script is the everyday form of it. Reporting that as `timeout`
   * would claim the command was still running — contradicted by its own exit
   * code — and reporting the exit code as a verdict would certify a suite
   * whose output was truncated and whose leftovers will answer the NEXT run's
   * checks. Both classifiers treat it as cut short, so it is rejectable.
   *
   * A SUB-MILLISECOND RACE is reachable here and deliberately left alone:
   * `exited` is set by the leader's own `exit` event while the bound runs on
   * its own timer, so a bound that lands in the gap between `exit` and `close`
   * reports a run that finished on time as `abandoned`. Recorded so nobody
   * rediscovers it as a flake. It is not worth closing, in either sense: the
   * window is the microseconds a pipe takes to drain after its writer exits,
   * and "cut short" remains the honest answer inside it — the pipes had NOT
   * drained, so the output behind that exit code really is truncated, and the
   * next thing this reports is that the run was abandoned rather than passing.
   */
  kind: BoundedProcessKind;
  exitCode: number | null;
  /**
   * The signal that killed the child, or null when it exited on its own.
   *
   * Without it a child that died from SIGKILL, SIGSEGV, SIGBUS, SIGABRT or an
   * external SIGTERM is indistinguishable from one that never started: both
   * report `exitCode: null` and no error. That collapse is what let a killed
   * test suite reach `validateQaReportV2` wearing the prose of a justified
   * "the command could not be executed" exemption — see `cutShortCause` in
   * stack.ts.
   */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface NativeMachineResult {
  parser: 'xcode-xcresult-summary-v1' | 'android-junit-xml-v1';
  summary: QaNativeTestSummaryV1;
  artifacts: QaNativeArtifactV1[];
}

export const MAX_NATIVE_PROCESS_OUTPUT = 8 * 1024 * 1024;
const MAX_NATIVE_ARTIFACTS = 25_000;
const MAX_NATIVE_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How often a running native adapter says it is still alive.
 *
 * BORROWED: 10 s is `REFRESH_INTERVAL_MS` in
 * shared/onboarding-server/browser-arrival.ts:39, this repo's existing cadence
 * for the same job — periodically re-asserting liveness to an observer who
 * would otherwise read silence as death. It is available to anything bounded
 * here because `runBoundedProcess` is promise-based, so the event loop stays
 * free while the child runs; the stack commands took the same cadence when
 * they moved onto it.
 *
 * It matters most here. `xcodebuild test` and `./gradlew connectedAndroidTest`
 * are the longest steps this runner has, they emit nothing to the caller (their
 * stdout is captured, not inherited), and their bound is now five minutes.
 */
export const NATIVE_HEARTBEAT_MS = 10 * 1000;

export interface SpawnPlan {
  file: string;
  args: string[];
  /** `windowsVerbatimArguments`: the args below are a pre-assembled command line. */
  verbatim: boolean;
}

/**
 * What `spawn` must be handed for a command whose resolved target may be a
 * Windows batch shim.
 *
 * Node >= 22 (the CVE-2024-27980 fix this repo's engines pin) REFUSES to spawn
 * a `.cmd`/`.bat` without a shell and throws EINVAL, and the callers here
 * invoke `npm`, `pnpm`, `yarn` and `gradlew` by bare name. On POSIX this is a
 * passthrough — the exact `(command[0], command.slice(1))` pair this file
 * spawned before Windows was considered at all — and on Windows it is the same
 * resolve-then-`cmd /c` shape as shared/spawn-tool.ts, whose escaping is
 * IMPORTED rather than re-derived: libuv's argv quoting is generic
 * CommandLineToArgvW quoting and does not neutralize cmd.exe metacharacters,
 * so an argument carrying `&` or `^` would otherwise be re-parsed as syntax.
 *
 * ONE OF THE TWO FACTS HERE IS VERSIONED and the other is not, which decides
 * what a future reader should re-check. The batch-file refusal is a Node
 * behaviour introduced by a CVE fix: `IsWindowsBatchFile` in
 * src/process_wrap.cc, matching any last extension `cmd` or `bat`, ahead of
 * `uv_spawn` and indifferent to the shell option. libuv's PATH search appending
 * only `.com` and `.exe` — deliberately, in the source's own word — is an
 * invariant of the platform layer. So if Node ever teaches `spawn` to resolve
 * PATHEXT itself, the resolve-then-`cmd /c` routing below becomes a redundant
 * quoting layer rather than a fix: no correctness is lost, but these comments
 * become archaeology and should be reread against the version in `engines`
 * rather than trusted.
 *
 * Getting this wrong is not a loud failure, which is why `platform` and
 * `resolve` are parameters: an EINVAL arrives as "the command could not be
 * executed", the arm `validateQaReportV2` excuses, so a Windows regression
 * here would settle runs GREEN — the exact defect class this lane exists to
 * close — and it would do it on a platform no test machine here runs. The
 * default resolver is spawn-tool's own, IMPORTED for the same reason its
 * escaping is: a copy of either half is a copy that can drift, and neither
 * half fails loudly enough to notice.
 */
export function spawnPlan(
  command: readonly string[],
  platform: NodeJS.Platform = process.platform,
  resolve: (file: string) => string = resolveWindowsCommand,
): SpawnPlan {
  const file = command[0]!;
  const args = command.slice(1).map(String);
  if (platform !== 'win32') return { file, args, verbatim: false };
  const resolved = resolve(file);
  const lower = resolved.toLowerCase();
  // Only batch shims need the shell. A `.exe` — a managed node.exe, git.exe —
  // spawns directly, and routing it through cmd.exe would add a quoting layer
  // for nothing.
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return { file: resolved, args, verbatim: false };
  const line = [escapeCmdCommand(resolved), ...args.map((arg) => escapeCmdArgument(arg))].join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    // `/d` skips AutoRun, `/s` strips the outer quote pair, `/c` runs and exits.
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

/**
 * How long a forcibly-killed run is given to CLOSE before it is settled anyway.
 *
 * `close` fires only once the child has exited AND every pipe it handed down is
 * closed, which makes it unusable as a bound's only resolution path: a
 * descendant that left the process group still holds the inherited stdout, and
 * no signal this runner can address will make it let go. Measured, on a 2000 ms
 * bound: 20 s and still pending, with the heartbeat printing "10s of a 2s
 * bound" — the runner announcing a deadline it then ran past forever. A second
 * timer is what makes the bound a BOUND rather than a best effort, so the worst
 * case a caller can observe is its own bound plus this.
 *
 * 500 ms is picked from both ends. It must never PRE-EMPT a kill that worked,
 * or a run whose group really did die would lose its exit signal and the tail
 * of its output to a race — measured on darwin, an in-group SIGKILL closes the
 * pipes in single-digit milliseconds, so this is roughly 100x the latency it
 * covers. And it must never dominate a run: it is half of MIN_TIMEOUT_MS
 * (cli.ts:28), the smallest bound the CLI admits, so even the shortest
 * possible run is bounded at 1.5x what its caller asked for, and the default
 * five-minute bound at 1.002x.
 */
export const FORCED_KILL_GRACE_MS = 500;

export function runBoundedProcess(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
  heartbeat?: { label: string; intervalMs?: number },
  /** Merged over the parent environment — `CI: '1'` for the stack commands. */
  envOverrides?: NodeJS.ProcessEnv,
): Promise<BoundedProcessResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    const plan = spawnPlan(command);
    // Its own process group, so the kills below can address `-pgid`. POSIX
    // only: Windows has no group to signal, and `detached` there only changes
    // which console the child attaches to.
    const detached = GROUP_KILLS_AVAILABLE;
    try {
      child = spawn(plan.file, plan.args, {
        cwd,
        env: { ...process.env, ...envOverrides },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      resolvePromise({
        kind: 'unavailable',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const pgid = spawnedGroupId(child, detached);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let forced: BoundedProcessResult['kind'] | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exited = false;
    let groupEmpty = false;
    const startedAtMs = Date.now();
    /**
     * Sweep the group, and stop sweeping once it has been observed EMPTY.
     *
     * There are three callers (the bound, the capture bound, and settlement
     * itself), plus the interrupt reaper, and a run can plausibly reach two of
     * them: a forced run still inside its grace window when a Ctrl-C arrives.
     * The latch here used to be "have we signalled yet", on the argument that a
     * second SIGKILL could not reach anything the first had missed. It can: see
     * `REAP_SWEEPS`, where a single sweep left survivors in 15 of 24 trials
     * against a leader forking flat out, and in 3 of 24 against one forking
     * every 2 ms. (This comment carried "13 of 24 ... every 2 ms" — a splice of
     * those two rows, retracted at `REAP_SWEEPS` and, until now, still asserted
     * here. A corrected claim has to be corrected in every copy, and a figure
     * quoted from another site has to be re-read from it.)
     *
     * Latching on the ANSWER instead — `false` while the group still has
     * members, `true` once a sweep has been told ESRCH — keeps the pid-reuse
     * budget of the old latch (one draw at an id that could have been
     * recycled, per run) without suppressing the retry that the measurement
     * says is load-bearing.
     */
    const reapGroup = (): void => {
      if (groupEmpty) return;
      groupEmpty = killProcessGroup(pgid, child);
    };
    const stopReaping = reapOnInterrupt(reapGroup);
    /**
     * Settle once — and take the group with us WHATEVER the verdict.
     *
     * The reap had exactly two callers before this line existed: `forceStop`,
     * and the interrupt reaper, which deregisters the moment a run settles. So
     * a command that exited 0 while leaving a descendant behind was never
     * reaped at all, and nothing in this lane could see it, because every shape
     * it had built was a HANG. The everyday form is
     * `node server.js >/dev/null 2>&1 & exit 0` in a `test` script: the
     * leftover holds no inherited pipe, so `close` fires at once and the check
     * is a prompt, correct `passed` with a live server still on its port.
     * Measured: `passed in 121 ms`, leftover alive. That is the survivor
     * incident at plan-guard/plan-readiness/completion.ts:636 exactly — one
     * run's server answering the next run's checks — reached through the one
     * door a bound cannot watch, because on that path nothing is ever late.
     *
     * `detached` had made it strictly WORSE than the leader-only kill it
     * replaced. Measured both ways on the same fixture: without it the leftover
     * shares the runner's own process group (pgid 36919, the runner's own), so a
     * CI harness's `kill -TERM -<pgid>` and a terminal Ctrl-C both reach it;
     * with it the leftover sits alone in a group (36439, against the runner's
     * 36428) that this reaper dropped at settle and that no host signal will
     * ever address.
     *
     * A well-behaved command pays nothing measurable: its group is empty by the
     * time this runs, so the signal reaches nobody and `process.kill` answers
     * ESRCH. The only runs whose behaviour changes are the ones that left
     * something running.
     */
    const finish = (result: BoundedProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (pulse) clearInterval(pulse);
      reapGroup();
      stopReaping();
      resolvePromise(result);
    };
    /**
     * Kill the group and guarantee a verdict, whatever the kill reaches.
     *
     * The kill is UNCONDITIONAL on the leader's liveness, which inverts the
     * guard this replaced. `if (child.exitCode === null …) kill` was correct
     * while the kill was `child.kill()` — you cannot signal a reaped child —
     * but a process GROUP outlives its leader, and "leader gone, descendants
     * alive holding the inherited stdout" is precisely the case the group kill
     * exists for. Guarding on the leader suppressed the kill exactly there, and
     * since `close` cannot fire while that pipe is held, the run never settled
     * at all: the announced bound became no bound. `killProcessGroup` already
     * tolerates an empty group, so there is nothing for the guard to protect.
     *
     * The KIND is decided here too, with the kill rather than before it. It was
     * previously assigned first, so a command that had exited cleanly and was
     * merely waiting on a pipe-holder was reported `timeout` — a claim about
     * the leader that its own exit code contradicts.
     */
    const forceStop = (kind: BoundedProcessResult['kind']): void => {
      if (settled || forced) return;
      forced = kind;
      // The timer is ARMED BEFORE THE KILL. It is the only thing that can
      // settle a run whose `close` is never coming, so a kill that threw on its
      // way out would leave the run with neither — the original hang, through a
      // narrower door. `killProcessGroup` catches everything it can raise
      // today, so this closes a path rather than a defect, and it costs one
      // statement's ordering.
      grace = setTimeout(() => {
        // Nothing answered the kill, so `close` is never coming: a descendant
        // outside the group still holds the inherited stdout. Settle on what
        // was captured, and let the pipes go — an orphan holding them would
        // otherwise keep THIS process alive too, turning a bounded run into a
        // wedged job that has already produced its verdict.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish({
          kind,
          exitCode,
          signal: exitSignal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      }, FORCED_KILL_GRACE_MS);
      reapGroup();
    };
    /**
     * Keep capturing until the pipes close, INCLUDING through the grace window.
     *
     * Bailing on `forced` discarded exactly the bytes a reader most wants — the
     * tail a killed command wrote on its way out, which is what the native
     * path's inconclusive summary quotes (`result.process.stderr`) — and froze
     * `bytes` one chunk before the kill, which the heartbeat quotes at every
     * pulse. Neither is worth throwing away for a window this runner already
     * bounds at `FORCED_KILL_GRACE_MS`.
     *
     * The cap still holds the memory: past it a chunk is COUNTED and dropped
     * rather than retained, so the count stays honest and a runaway writer
     * cannot trade a bounded run for an OOM during the grace window.
     */
    const capture = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_NATIVE_PROCESS_OUTPUT) {
        if (!forced) forceStop('output-limit');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
    // The refusal is delivered ON THE CHILD, one tick after `spawn` returned,
    // and `spawnRefusalKind` is the SHARED decision — server.ts's own listener
    // calls the same function, so the runner's long-lived spawns cannot acquire
    // two answers for one state. They had two: this site mapped ENOENT and
    // called everything else a completed run.
    child.once('error', (error: NodeJS.ErrnoException) => finish({
      kind: spawnRefusalKind(error.code),
      exitCode: null,
      signal: null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}`,
    }));
    // `exit` is the leader's own end; `close` additionally waits for every pipe
    // it handed down. Recorded separately because a run that has to be settled
    // on the grace timer never gets a `close`, and the leader's status is then
    // the only thing known about how it ended.
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = typeof code === 'number' ? code : null;
      exitSignal = signal ?? null;
    });
    child.once('close', (code, signal) => finish({
      kind: forced || 'completed',
      exitCode: typeof code === 'number' ? code : null,
      signal: signal ?? null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    const timer = setTimeout(() => forceStop(exited ? 'abandoned' : 'timeout'), timeoutMs);
    // `unref` so a heartbeat can never be the reason a process stays alive: it
    // reports on work, it is not work.
    const pulse = heartbeat
      ? setInterval(() => {
          emitProgress(
            `${heartbeat.label}: still running, ${Math.round((Date.now() - startedAtMs) / 1000)}s `
            + `of a ${Math.round(timeoutMs / 1000)}s bound, ${bytes} byte(s) captured`,
          );
        }, Math.max(1, heartbeat.intervalMs ?? NATIVE_HEARTBEAT_MS)).unref()
      : null;
  });
}

function nativeWorkingDirectory(args: RunnerArgs): string | null {
  if (!args.nativeCwd) return fs.realpathSync(args.projectRoot);
  const relative = safeProjectRelative(args.projectRoot, args.nativeCwd);
  if (!relative) return null;
  try {
    const project = fs.realpathSync(args.projectRoot);
    const cwd = fs.realpathSync(path.join(args.projectRoot, relative));
    const boundary = path.relative(project, cwd);
    return !boundary.startsWith('..') && !path.isAbsolute(boundary) && fs.statSync(cwd).isDirectory()
      ? cwd
      : null;
  } catch {
    return null;
  }
}

export function configuredNativeCommand(
  args: RunnerArgs,
  adapter: string,
): { command: string[]; cwd: string } | null {
  const command = parseBoundedArgv(args.nativeCommandJson);
  const cwd = nativeWorkingDirectory(args);
  if (!command || !cwd) return null;
  if (adapter === 'xcode-simulator') {
    if (command[0] !== 'xcodebuild'
      || !command.slice(1).some((arg) => arg === 'test' || arg === 'test-without-building')
      || !command.slice(1).some((arg) => /^platform=iOS Simulator(?:,|$)/.test(arg))
      || command.some((arg) => ['-resultBundlePath', '-resultStreamPath'].includes(arg))) return null;
    return { command, cwd };
  }
  if (adapter === 'android-emulator') {
    const executable = command[0];
    const task = command.slice(1).find((arg) => (
      /^(?::[A-Za-z0-9_.-]+)*:?connected[A-Za-z0-9_.-]*AndroidTest$/.test(arg)
    ));
    if (!executable
      || !['./gradlew', 'gradlew.bat'].includes(executable)
      || !task
      || command.some((arg) => [
        '--init-script', '-I', '--project-dir', '-p', '--settings-file', '-c', '--build-file', '-b',
      ].includes(arg))) return null;
    return { command, cwd };
  }
  return null;
}

export function nativeArtifact(
  qaRoot: string,
  absolute: string,
  startedAtMs: number,
): QaNativeArtifactV1 | null {
  try {
    const realQa = fs.realpathSync(qaRoot);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1
      || stat.mtimeMs + 1_000 < startedAtMs) return null;
    const real = fs.realpathSync(absolute);
    const boundary = path.relative(realQa, real);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) return null;
    const relative = path.relative(realQa, real).replace(/\\/g, '/');
    if (!strictRelative(relative)) return null;
    const sha256Value = contentHash(real);
    if (!sha256Value) return null;
    return {
      path: relative,
      size: stat.size,
      sha256: sha256Value,
      artifactAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

export function collectNativeArtifacts(
  qaRoot: string,
  root: string,
  startedAtMs: number,
): QaNativeArtifactV1[] | null {
  const artifacts: QaNativeArtifactV1[] = [];
  let bytes = 0;
  const visit = (current: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!visit(absolute)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      const artifact = nativeArtifact(qaRoot, absolute, startedAtMs);
      if (!artifact) return false;
      bytes += artifact.size;
      artifacts.push(artifact);
      if (artifacts.length > MAX_NATIVE_ARTIFACTS || bytes > MAX_NATIVE_ARTIFACT_BYTES) return false;
    }
    return true;
  };
  return visit(root) && artifacts.length > 0 ? artifacts : null;
}

export function androidResultRoots(cwd: string): string[] | null {
  const roots: string[] = [];
  let visited = 0;
  const visit = (current: string, depth: number): boolean => {
    if (depth > 8 || visited > 20_000) return false;
    visited += 1;
    const candidate = path.join(current, 'build', 'outputs', 'androidTest-results', 'connected');
    try {
      if (fs.statSync(candidate).isDirectory()) roots.push(fs.realpathSync(candidate));
    } catch {
      // This module has no connected-test result root.
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || ['.git', '.traffic-one', 'node_modules', 'build'].includes(entry.name)) continue;
      if (!visit(path.join(current, entry.name), depth + 1)) return false;
    }
    return true;
  };
  return visit(cwd, 0) ? [...new Set(roots)].sort() : null;
}

export function androidResultFiles(roots: readonly string[]): string[] | null {
  const files: string[] = [];
  let visited = 0;
  const visit = (current: string): boolean => {
    if (visited > 50_000) return false;
    visited += 1;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!visit(absolute)) return false;
      } else if (entry.isFile() && /\.xml$/i.test(entry.name)) {
        files.push(absolute);
        if (files.length > MAX_NATIVE_ARTIFACTS) return false;
      }
    }
    return true;
  };
  for (const root of roots) {
    if (!visit(root)) return null;
  }
  return files.sort();
}

export function fileSnapshot(files: readonly string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const file of files) {
    try {
      const hash = contentHash(file);
      if (hash) snapshot.set(fs.realpathSync(file), hash);
    } catch { /* incomplete input is ignored */ }
  }
  return snapshot;
}
