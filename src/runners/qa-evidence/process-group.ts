// src/runners/qa-evidence/process-group.ts
// Group kills and the interrupt reaper, for every long-lived spawn this runner
// owns: the bounded command, the dev-server child, and Lighthouse's Chrome.
//
// A LEAF on purpose. This lived in native-process.ts, which imported
// `parseBoundedArgv` from server.ts, so the two sites that needed it most —
// server.ts and lighthouse.ts — could not import it back without a require
// cycle. The codebase already dodges one for this reason at stack.ts:407. That
// edge is gone (the parser moved to bounded-argv.ts, so server.ts can reach
// `spawnPlan`), and this stays a leaf regardless: it is imported by every
// teardown site, and a cycle re-formed at any one of them would put a
// load-time edge back under all of them.
// Nothing here imports anything from this runner, so all three importers are
// safe and stay safe.

import { spawnSync, type ChildProcess } from 'child_process';

/**
 * How many times one settling event may signal the same group.
 *
 * ONE was not enough, and the argument that it was is false. It ran: a second
 * SIGKILL buys nothing because SIGKILL cannot be blocked, so anything that
 * survived the first is outside the group, and "a member cannot be forked into
 * a group whose every member has already been killed". The last clause holds
 * only if the kill has COMPLETED before the fork. `kill(2)` on a negative pid
 * iterates the group's member list and queues a signal per member; a member
 * executing `fork(2)` on another core mid-iteration yields a child that
 * inherits the pgid and was never on the list the kernel walked. That child is
 * in the group and unsignalled.
 *
 * It is not theoretical, and it is worst on exactly the workloads this runner
 * exists to bound — `npm test`, `go test`, `gradlew`, all of which spawn
 * workers continuously. Survivors are counted by pgid from `ps` rather than
 * from the leader's own pid log (that log undercounts: a child killed between
 * `spawn` returning and its `appendFileSync` is never named), and the FORK RATE
 * is the whole detector, so every figure names one:
 *
 *                             1 sweep        3 sweeps, 5 ms gaps
 *   leader forking every 2 ms  3 of 24        —
 *   leader forking flat out   15 of 24        0 of 24 (over 48 trials)
 *
 * Both rows are the peer's independent reproduction, driven from the mechanism
 * rather than from this file's fixture, with a median surviving group of 584 at
 * the max-rate row. THE NUMBER THIS COMMENT USED TO CARRY — "13 of 24 against a
 * leader forking every 2 ms" — was a splice of the two rows: the direction and
 * the fix are exactly as recorded, the rate and the count were not measured
 * together, and the honest 2 ms figure is three times in twenty-four. An
 * earlier "2 sweeps, no gap: 0 of 24" reading belongs to the 2 ms row too,
 * where one sweep already leaks only 3 of 24.
 *
 * So the latch converted a recoverable miss into a permanent one, on the
 * majority of runs at the rate a worker pool actually forks at. What it bought
 * was one fewer draw at the residual pid-reuse window below, and what it cost
 * was the retry that closes a demonstrated hole; signalling an already dead
 * group is harmless, because `kill(-pgid, …)` answers ESRCH and the loop
 * swallows it.
 *
 * Three sweeps rather than two, because the third is nearly free: the loop stops
 * the moment a POST-GAP probe reports the group empty, so a group that died on
 * the first sweep costs one signal and one gap.
 *
 * THE CAP is what keeps this a sweep rather than a spin, and what it promises is
 * narrower than what was written here. A group still answering at the cap
 * leaves the latch open, so a LATER settling event may sweep again — but only
 * where a later settling event exists. A cut-short run has one (`forceStop`
 * reaps at the bound and `finish` reaps again when the grace window closes,
 * `FORCED_KILL_GRACE_MS` later), and so does an interrupt. A run that SUCCEEDS
 * has exactly one: `finish` reaps and then calls `stopReaping`, so on that path
 * `finish` IS the last settling event and the cap is final. That is the path
 * the fork race was measured on, and the honest statement is that the cap has
 * never been reached there — 48 max-rate trials, none of them getting past the
 * second sweep — so the open latch is a real property with no observed
 * consumer, not a second chance the successful path can rely on.
 */
export const REAP_SWEEPS = 3;

/**
 * How long to let the forks that were IN FLIGHT when the signal landed finish
 * joining the group, before asking whether the group is empty.
 *
 * Not decoration, and the first version of this loop did not have one. Sweeping
 * back-to-back looked clean at a leader forking every 2 ms and then leaked
 * against one forking twice per MILLISECOND, which is the rate a worker pool
 * actually forks at: survivors in 2 of 5 runs of the four-round fixture in
 * __tests__/process-group.test.ts, and 1 of 24 trials of the peer's independent
 * driver at gap 0. The mechanism is the same race one level down from
 * `REAP_SWEEPS`: the loop stops when `kill(-pgid, 0)` says the group is empty,
 * and a fork still in flight when the signal was delivered has not joined the
 * group yet, so a probe taken microseconds later is told ESRCH and the loop
 * believes it.
 *
 * CHOSEN, not derived, and that is as far as the evidence goes: what is
 * measured is that 0 leaks, that 5 does not (0 of 24 at the max fork rate,
 * across 48 trials), and that 30 does not either (the peer's independent run,
 * 0 of 12). Anything in that range is defensible; five is the small end of it
 * because the cost is paid on EVERY reap of every run — twice per cut-short
 * run, in a settling path that is holding a verdict — and only the escape path
 * needs more than one sweep at all.
 *
 * It is load-bearing rather than cosmetic, so it is pinned twice in
 * __tests__/process-group.test.ts: the sweep loop is asserted to actually SPEND
 * this between a signal and its probe (which is what a mutation to 0 removes,
 * and what no test could see before), and the constant is asserted to stay
 * inside the measured band. Neither is a re-typing of the number: the first is
 * behavioural, the second names the two readings that bound it.
 */
export const REAP_SWEEP_GAP_MS = 5;

/**
 * Block this thread for `ms` — deliberately, and only here.
 *
 * Every caller of the sweep is a settling or exit path, one of them a SIGINT
 * handler that has to finish its work before the process dies, so there is no
 * `await` available to any of them and an asynchronous gap would let the run
 * settle with the group still alive. `Atomics.wait` on a buffer nobody else can
 * reach is the cheapest exact sleep the platform has: no spin, no timer, no
 * event-loop turn.
 */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How long a tree kill may take before teardown stops waiting for it.
 *
 * The command is a `spawnSync` because every caller of the reap is a settling or
 * exit path and one of them is a SIGINT handler, so there is no `await`
 * available to any of them — see `blockFor`. An unbounded synchronous spawn on
 * that path would let a wedged `taskkill` hold the interrupt open forever, which
 * is a worse failure than the leak it is closing. Five seconds is a WEDGE GUARD
 * rather than a budget: the command walks a process list and returns in tens of
 * milliseconds, `spawnSync` terminates it at this bound, and the leader-only
 * kill below still runs either way.
 */
export const TREE_KILL_TIMEOUT_MS = 5_000;

/**
 * `process.kill`, as a parameter — for the sweep loop only.
 *
 * Two of the loop's states cannot be reached from a real machine, and both are
 * states a mutation survives silently. A group that is STILL ANSWERING after
 * `REAP_SWEEPS` signals is one: SIGKILL cannot be blocked, so producing it on
 * demand would need a leader forking faster than the kernel can tear the group
 * down, and 48 max-rate trials never once got there. The GAP is the other: it
 * is a few milliseconds inside a settling path, and nothing observable is
 * different afterwards except a race that shows up once in twenty-four runs.
 * With the signaller injected both become ordinary assertions — how many
 * signals, in what order, with how long between them — and the cap's return
 * value stops being a claim nobody can check.
 *
 * The default is the real one; only __tests__/process-group.test.ts passes
 * anything else. Wrapped rather than passed as `process.kill` directly so the
 * method keeps its receiver.
 */
export type ProcessSignaller = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * The one `spawnSync` shape this file uses, narrowed so a test can record the
 * call instead of performing it.
 */
export type TreeKillSpawn = (
  file: string,
  args: readonly string[],
  options: { stdio: 'ignore'; timeout: number; windowsHide: true },
) => unknown;

/**
 * End a process TREE on Windows, where there is no group to signal.
 *
 * The kernel-exact remedy is a Job Object created with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which tears the tree down when the last
 * handle closes; it needs a native addon, and this runtime ships no npm
 * packages. `taskkill /T` is the platform's own tree walk and needs nothing —
 * `/T` takes the descendants with the leader, and `/F` is not optional: without
 * it `taskkill` posts a window message, which a console process (every process
 * this runner spawns) has nothing to receive, and reports that the target can
 * only be terminated forcefully. It is no harsher than what already happened
 * here: libuv answers SIGTERM, SIGINT, SIGQUIT and SIGKILL alike with
 * `TerminateProcess`, so the leader was being force-killed at both of
 * `stopOwnedServer`'s phases before this existed. SIGQUIT is not quite a
 * synonym for the other three there — `uv__kill` walks the WER `LocalDumps`
 * registry key and writes a MINIDUMP of the target first, then terminates — so
 * a SIGQUIT on Windows costs a dump write on a machine configured for one. It
 * is prose rather than a caveat: this runner never sends SIGQUIT, and the two
 * signals it does send take the plain terminate. What changes is only the REACH, and that is the point — since
 * the Lighthouse audit's spawn started routing a `.cmd` shim through `cmd /d /s
 * /c`, the leader on Windows is the SHELL, so a leader-only kill ends the shell
 * and leaves the audit's Chrome, its renderers, its profile directory and its
 * remote debugging port running.
 *
 * A LIVE LEADER is required, and that is the one place this deliberately does
 * less than the POSIX path. `taskkill /T` builds the tree by parent pid from the
 * running process list, so a leader already reaped names no tree to walk — and
 * that pid is immediately recyclable, which would turn a `/F` at it into a
 * forced kill of a STRANGER'S tree. The POSIX residual needs a pid-space wrap
 * AND the recipient to have made itself a group leader; this one needs neither,
 * so the blast radius is not comparable. The consequence is that "leader gone,
 * descendants alive" — reapable through a group id, and the case `forceStop`
 * stopped guarding on the leader for — stays unreachable on Windows.
 */
function killWindowsTree(child: ChildProcess, runTreeKill: TreeKillSpawn): void {
  const pid = child.pid;
  // A failed spawn leaves `pid` undefined, and `taskkill /PID 0` is a syntax
  // error rather than a tree: neither is something to address.
  if (typeof pid !== 'number' || pid <= 0) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    runTreeKill('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: TREE_KILL_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch { /* a teardown path never throws — see the caller */ }
}

/**
 * Kill a whole process GROUP by the id captured when it was created, falling
 * back to the child alone when there is no group to address.
 *
 * The group is the whole point. Every command bounded here is a wrapper around
 * the work — `npm test` is a package manager wrapping a shell wrapping the
 * suite, `xcodebuild` owns a simulator, `gradlew` owns a daemon, `npm run dev`
 * wraps the listener that holds the port — so a signal to the leader alone
 * leaves the real process running at `ppid 1`, still holding its port. That is
 * the mechanism behind the incident recorded at
 * plan-guard/plan-readiness/completion.ts:636, where a previous project's
 * preview server answered every check for the next one. Measured on darwin:
 * after a leader-only kill the grandchild is still writing, and the dev-server
 * shapes that go through here leave a listener at `ppid 1` with the upstream
 * port still bound; after a group kill both are gone.
 *
 * The group id is a PARAMETER, snapshotted at spawn, rather than `-child.pid`
 * read at kill time. `delegate.ts:100`, where this shape came from, re-derives
 * it and guards with `!child.pid`, and that guard's stated mechanism —
 * "`process.kill(-0, …)` signals the CURRENT process group" — is not reachable:
 * a failed spawn leaves `child.pid` UNDEFINED, so `-child.pid` is `NaN` and
 * `process.kill` throws before it signals anything. The real hazard is the one
 * the guard cannot see. The kills here fire when the LEADER MAY ALREADY BE
 * REAPED (that is the bug they exist to fix), and a pid is only a stable name
 * for a process while that process is alive. Capturing the number at spawn,
 * only when that spawn actually created the group, and only for a `pid > 0`,
 * makes `-0` structurally impossible and keeps the runner from ever addressing
 * a group it did not start.
 *
 * `signal` exists for `stopOwnedServer`, which cannot use a bare SIGKILL: a dev
 * server is given a SIGTERM first so it can flush and RELEASE ITS PORT, which
 * is the thing the next run needs from it. It is threaded through the
 * single-process fallback too, so the distinction survives wherever the
 * platform HAS one. Windows does not: libuv answers SIGTERM, SIGINT and
 * SIGKILL alike with `TerminateProcess` (deps/uv, `uv__kill`), so
 * `child.kill('SIGTERM')` there is already a forced kill of the leader and no
 * polite stop is on offer to escalate away from.
 *
 * A RESIDUAL window remains and cannot be closed from user space: a group id
 * becomes recyclable once the group is EMPTY, so between the last member
 * exiting and a signal the kernel may hand the number to someone else. The
 * sweep above widens that window from one draw to at most `REAP_SWEEPS`, and
 * three properties keep it theoretical. The sweeps all belong to ONE settling
 * event and are separated by a liveness probe rather than by a wait, so the
 * whole sequence spans microseconds from the event that settled the run. Every
 * sweep after the first happens only while the group is still ANSWERING, which
 * is to say while its id cannot yet have been recycled — the only draw taken at
 * a possibly-recycled id is the first, exactly as before. And a recycled pid
 * only makes `-pgid` name a FOREIGN group if whoever received it also made
 * itself a group LEADER — an ordinary fork inherits its parent's group and is
 * unreachable by that number — so both have to happen, in a pid space that has
 * to wrap first.
 *
 * The RETURN VALUE is what `runBoundedProcess` latches on, and it is sound:
 * once a sweep has been told ESRCH there is provably nothing of ours left to
 * signal, so a later kill at that id could only ever reach a stranger. This
 * answers TRUE exactly when that has been observed. It replaced a latch on
 * "have we signalled yet" — the false premise above — which suppressed the
 * retry precisely when the group was still alive.
 *
 * "AND EVERY CALLER LATCHES ON IT" WAS FALSE, and the property it was offered
 * as an argument for — at most one draw at the pid-reuse window per run, per
 * group — holds for three different reasons at the three sites. ONE of the ten
 * product callers reads the value (native-process.ts's `reapGroup`); five in
 * server.ts and four in lighthouse.ts discard it. What actually bounds them:
 *
 *   lighthouse.ts   its four sites are mutually exclusive behind `settled` —
 *                   the timeout, the error and the exit each set it before
 *                   killing, and the interrupt reaper is deregistered by
 *                   whichever of them runs. Exactly one fires per audit.
 *   server.ts       `stopOwnedServer` latches on `treeIsGone`, not on this
 *                   return value: the SIGKILL after the SIGTERM is skipped
 *                   outright when the group has been observed empty, which is
 *                   the same observation reached through the other primitive.
 *                   Its remaining sites are a failed start (which then throws)
 *                   and the interrupt reaper, deregistered before both.
 *   native-process  the latch proper.
 *
 * So the budget is kept by construction at nine sites and by the latch at one.
 * Stating it as one mechanism made the other two look tested when nothing
 * examined them.
 *
 * That window is entered by every run rather than only by cut-short ones, which
 * is the price of reaping what a SUCCESSFUL run left behind; see `finish` in
 * native-process.ts. There is no bound, no kill and no late verdict on that
 * path, so this is the only defence it has.
 *
 * On Windows there is no signalling GROUP to address at all: `detached` there
 * only decides which console the child attaches to, so `GROUP_KILLS_AVAILABLE`
 * is false, every spawn site passes `detached: false`, `spawnedGroupId` answers
 * null, and the loop above is never entered. Nothing throws and nothing
 * silently no-ops — the primitive DEGRADES to the leader-only kill at the
 * bottom, which is the shape the whole file exists to reject. `killWindowsTree`
 * is what replaces the group there, and it is reached by every caller because it
 * lives here: the audit is not the only teardown site, and a second copy at one
 * of them is exactly the divergence this module was extracted as a leaf to
 * prevent.
 *
 * What Windows does NOT lose, and did not lose before this either, is the
 * VERDICT: `forceStop` decides the kind before it kills, so a cut-short run
 * there reports exactly the kind it would on POSIX and settles on the grace
 * timer — that timer DELIVERS the verdict, it does not decide it.
 */
export function killProcessGroup(
  pgid: number | null,
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL',
  /**
   * Platform and tree-killer as PARAMETERS, for the reason `spawnPlan`'s
   * platform is one: the Windows branch below cannot run on any machine in this
   * repo or in CI, and it fails in this lane's characteristic direction —
   * silently, leaving a browser and its profile directory alive behind a
   * cut-short audit that reported itself honestly. The defaults are the real
   * ones; only __tests__/windows-tree-kill.test.ts passes anything else.
   *
   * TEN product call sites take them — five in server.ts, four in
   * lighthouse.ts, one in native-process.ts — which is the whole reason the
   * platform is a parameter here rather than a branch at each site. A round
   * summary recorded that as "eleven sites": eleven is the count of `grep`
   * hits, which includes this declaration, and a declaration does not inherit
   * its own default.
   */
  platform: NodeJS.Platform = process.platform,
  runTreeKill: TreeKillSpawn = spawnSync,
  /** See `ProcessSignaller`: the two loop states no real machine can produce. */
  signalProcess: ProcessSignaller = (pid, value) => { process.kill(pid, value); },
): boolean {
  // Sweeping is for SIGKILL only. The fork race above is an argument about a
  // signal that cannot be blocked, delivered to a group that is being torn down;
  // a POLITE signal is a request, and repeating it is not free — the ordinary
  // convention is that a second SIGTERM or SIGINT means "stop asking", so a dev
  // server given three inside a microsecond would force-quit instead of
  // flushing, which is the one thing `stopOwnedServer` sends SIGTERM to get.
  // Anything a single SIGTERM misses is collected by the SIGKILL that follows
  // it, and that one does sweep.
  const sweeps = signal === 'SIGKILL' ? REAP_SWEEPS : 1;
  if (pgid !== null) {
    for (let sweep = 0; sweep < sweeps; sweep += 1) {
      let addressable = true;
      try {
        signalProcess(-pgid, signal);
      } catch {
        addressable = false;
      }
      if (!addressable) {
        // ESRCH, or EPERM for a group that was never ours. On the FIRST sweep
        // that leaves the single-process fallback as the only thing still worth
        // trying; on a later one it is the sweep before this having worked.
        if (sweep === 0) break;
        return true;
      }
      // The cap, with the group still answering. NOT known empty, so a later
      // settling event is still allowed its own sweep — where one exists; see
      // the cap paragraph on `REAP_SWEEPS`, which is narrower than it was.
      if (sweep + 1 >= sweeps) return false;
      // Let the forks that were in flight when the signal landed finish joining
      // the group, THEN ask. Probing without the gap is what made the loop
      // believe an emptiness that was three microseconds old.
      blockFor(REAP_SWEEP_GAP_MS);
      // Another sweep is only worth a draw at the pid-reuse window while
      // something in the group can still answer. Signal 0 delivers nothing.
      try {
        signalProcess(-pgid, 0);
      } catch {
        return true;
      }
    }
  }
  // BEFORE the leader-only kill, not after: `child.kill` is a `TerminateProcess`
  // on Windows, and a tree walk from a pid whose process has just been
  // terminated finds no children to take with it. Ordering is the whole
  // difference between reaping the tree and reaping the shell.
  if (platform === 'win32') killWindowsTree(child, runTreeKill);
  try { child.kill(signal); } catch { /* already gone */ }
  return true;
}

/**
 * The process groups this runner has created and not yet settled.
 *
 * `detached` is what makes the group kills above addressable, and it is also,
 * on its own, what stops a Ctrl-C from reaching them: a detached child no
 * longer shares the runner's foreground process group, so the terminal's
 * SIGINT and a host's group-level SIGTERM both stop at the runner. Fixing
 * timeout-orphans that way and stopping there would just move the orphan to
 * the interrupt path — the same survivor incident
 * (plan-guard/plan-readiness/completion.ts:636) through a different door, and
 * with a bigger tree behind it, because an interrupt can arrive while
 * `next start`, a Chrome and a simulator are all up. Every `detached` spawn in
 * this runner registers here for that reason, the dev server and Lighthouse's
 * Chrome included; the browser lane had no interrupt handling at all and was
 * covered only by the accident of a shared group that `detached` removes.
 *
 * The listeners are attached only while a child is live and removed when the
 * last one settles. This module is imported by the test suite and by
 * long-running hosts, and a permanently-installed SIGINT listener would
 * silently change THEIR disposition: a handled SIGINT no longer terminates by
 * default, so a runner that had merely once bounded a process would stop
 * answering Ctrl-C. `interruptReaper` restores that default the only way a
 * handler can — remove itself, then re-raise — so the runner still dies
 * exactly as its caller asked, with its tree already gone.
 *
 * BOTH halves of that are tested, and the detach half only after the fact:
 * `detachReapers` is what the paragraph above promises, and a refactor that
 * broke it would produce a process that silently stops answering Ctrl-C, which
 * is the one outcome this claims cannot happen. The pins are in
 * __tests__/process-group.test.ts — a listener-count delta across a settled run
 * for the bookkeeping, and a real child process that must still die BY SIGINT
 * after a run of its own has come and gone for the disposition.
 */
const liveGroupReapers = new Set<() => void>();

function reapLiveGroups(): void {
  for (const reap of [...liveGroupReapers]) reap();
  liveGroupReapers.clear();
}

/**
 * Reap, restore the default disposition, and re-raise only if that default is
 * what the signal would otherwise have met.
 *
 * The re-raise was unconditional, which made a host with its own interrupt
 * handler see ONE Ctrl-C twice — once from the terminal, once from here — and a
 * host on the ordinary press-twice-to-force-quit convention would have
 * force-quit on the first press. With nothing else listening the re-raise is
 * still mandatory: a handled SIGINT no longer terminates, so without it the
 * runner would swallow its own interrupt, which is a worse bug than the orphan
 * this prevents. `listenerCount` is read AFTER `detachReapers`, so it counts
 * only other people's handlers, and when there is one the decision is theirs.
 * Nothing in this repo installs such a handler today; the module comment above
 * asserts that long-lived hosts import this, and the in-process simulation
 * runner is one.
 *
 * It reaps WITHOUT settling, and for a host that traps its own interrupt and
 * keeps running that shows up in the report: the run it was in the middle of
 * reaches its bound with the group already dead, so it settles as
 * `completed` + `SIGKILL` and tells the reader their suite was SIGKILLed when
 * what actually happened is that somebody pressed Ctrl-C. Honest in direction —
 * the run really was cut short and really is rejectable — and wrong in cause.
 * Settling from here instead would mean resolving another module's promise from
 * a signal handler, which is a larger change than the misattribution is worth.
 *
 * For the runner's OWN process the re-raise means NO REPORT AT ALL: the raise
 * terminates before `main`'s `finally` runs, so an interrupted run leaves the
 * report path untouched, and that is a deliberate choice rather than an
 * oversight. An interrupt is the one outcome where the CALLER already knows
 * what happened, and the six modes that do produce a verdict all produce it
 * because something happened to the WORK. Writing one from here would have to
 * be synchronous inside a signal handler and would have to assert a verdict for
 * checks that were still running, which is the shape of fabrication this whole
 * lane exists to prevent — an inconclusive report is a claim about a run, and
 * there is no run left to claim about. Absence is not a false green: every
 * downstream gate treats a missing report as unproven, so the failure mode is
 * "prove it again", which is exactly right for a run the operator cancelled.
 * What is genuinely lost is the DISTINCTION between cancelled and crashed, and
 * a reader who needs it should reach for the run lock's holder record rather
 * than teach this handler to write.
 */
function interruptReaper(signal: NodeJS.Signals): void {
  reapLiveGroups();
  detachReapers();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function detachReapers(): void {
  process.removeListener('exit', reapLiveGroups);
  process.removeListener('SIGINT', interruptReaper);
  process.removeListener('SIGTERM', interruptReaper);
}

/** Register a group for reaping; the returned function deregisters it. */
export function reapOnInterrupt(reap: () => void): () => void {
  if (liveGroupReapers.size === 0) {
    process.on('exit', reapLiveGroups);
    process.on('SIGINT', interruptReaper);
    process.on('SIGTERM', interruptReaper);
  }
  liveGroupReapers.add(reap);
  return () => {
    liveGroupReapers.delete(reap);
    if (liveGroupReapers.size === 0) detachReapers();
  };
}

/**
 * Does anything still answer at this group id?
 *
 * Signal 0 delivers nothing, so this is a question rather than an act, and it is
 * the only way teardown can tell "the dev server has left" from "the leader has
 * exited and something it started has not". A leader-only check cannot: in every
 * wrapper shape that leaks, the leader exits promptly.
 *
 * It shares the pid-reuse caveat of every use of `-pgid`, and BOTH directions
 * are worth stating because they cost different things. A recycled id can make
 * this answer TRUE when the group is in fact gone, which costs teardown a wait
 * it did not need and never a signal to a stranger — harmless. The other
 * direction is not: an id recycled onto a group led by another uid answers
 * EPERM, and EPERM is what the arm below has to get right.
 *
 * EPERM IS "STILL THERE", not "gone", and the bare `catch` that folded it onto
 * ESRCH was a defect this file's own reader would not have found: the liveness
 * census in shared/__tests__/process-liveness-eperm.test.ts probes for
 * `kill(<identifier>, 0)`, and `-pgid` is not an identifier, so this — the
 * fifteenth copy of the predicate — sat outside a census that reported fourteen
 * and audited every one of them. The census is now taken on the shape it says it
 * is taken on, and this copy is inside it.
 *
 * WHAT THE FOLD COST, one caller down: `stopOwnedServer` (server.ts) latches on
 * `treeIsGone`, and the SIGKILL after the SIGTERM is SKIPPED OUTRIGHT once the
 * group has been observed empty. A group that exists and is not ours answering
 * "no members" therefore ends the teardown early — a leaked dev server the
 * teardown believes it reaped. Answering "still there" costs at most one extra
 * kill at an id we may not signal, which fails EPERM and is discarded.
 *
 * THE RUNTIME EXPOSURE IS NARROW AND IS NOT MEASURED HERE: reaching EPERM at
 * `-pgid` needs the id recycled onto a group LED by a process of another uid,
 * which an ordinary fork cannot produce. The honest probe for it signals every
 * process this uid may signal, which is not a thing to run on a shared machine,
 * so this arm is read from the errno contract rather than driven. The census
 * calls it with a stubbed `process` instead, which is exactly the substitute
 * that file exists to be.
 */
export function groupHasMembers(pgid: number | null): boolean {
  if (pgid === null) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The group id of a child this runner just spawned `detached`, or null when
 * there is no group to address.
 *
 * `detached` makes the child its own group leader, so its pid IS the group id.
 * Read once at spawn and never re-derived, for the reason `killProcessGroup`
 * gives: by the time a kill runs the leader may already be reaped, and a pid is
 * only a stable name while its process is alive.
 *
 * The `pid > 0` guard is UNREACHABLE and stays anyway, which is worth stating
 * plainly because its mutant is equivalent — deleting it changes no observable
 * behaviour on any platform, and no test can be written that fails for it.
 * Node gives a failed spawn `pid === undefined`, never 0, so the typeof check
 * alone already covers every shape this runner can produce. What the guard
 * documents is the cost of being wrong about that, and the cost is
 * platform-dependent in the direction nobody expects. On POSIX a leaked 0 makes
 * `kill(-0, SIGKILL)` signal the CURRENT PROCESS GROUP — the runner, its host,
 * and every sibling sharing that terminal's foreground group. On WINDOWS it is
 * strictly worse: `uv_kill` takes its `pid == 0` branch to
 * `GetCurrentProcess()` and terminates THE RUNNER ITSELF, with no negative-pid
 * meaning in play at all and no group to have aimed at. Two platforms, two
 * mechanisms, one outcome that ends the run it was trying to bound.
 */
export function spawnedGroupId(child: ChildProcess, detached: boolean): number | null {
  return detached && typeof child.pid === 'number' && child.pid > 0 ? child.pid : null;
}

/**
 * Whether this platform has a signalling process group to create at all.
 *
 * One authority, because the spawn option and the pgid snapshot have to agree:
 * a `detached: true` whose pgid came back null would kill leaders only, and a
 * pgid taken from a child that was not detached would name the RUNNER'S OWN
 * group and take the runner down with the tree.
 */
export const GROUP_KILLS_AVAILABLE = process.platform !== 'win32';
