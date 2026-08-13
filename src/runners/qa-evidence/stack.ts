// src/runners/qa-evidence/stack.ts
// The `stack` command: build/test/lint evidence for runs with no browser or
// native surface.
//
// `requiredChecks` asks for `stack-build`, `stack-test`, and `stack-lint` when
// `uiImpact === 'none'`, but nothing in the repo ever produced them. The default
// arm of `computeBrowserCheckStatuses` fails unknown ids, `validateQaReportV2`
// then rejects `required-check-failed`, and settlement refuses to close — so
// every api-only run (Go, Python, Rust, Java, Laravel API) was unfinishable.
//
// That fix was not generalized, and the class survived in the neighbouring
// branch: `nonvisual` — the base impact of every project with a web surface —
// required `unit-or-component-tests` and `axe-when-dom`, neither of which any
// producer had an arm for. STACK_COMMAND_CHECK_IDS below is now the exported
// registry the contract is checked against, so the two lists cannot drift again.
//
// The rule here is: NEVER invent a command. Either the project declares it (a
// manifest script) or the language has exactly one canonical form and its
// manifest is present. Anything else is `not-applicable` WITH the reason
// recorded — a check that did not run must never read as covered.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from '../../shared/fsjson';
import {
  CHECK_INCONCLUSIVE_PREFIX,
  inconclusiveCheckSummary,
  notApplicableDisposition,
  recordStackResolution,
  type QaReportV2,
  type QaStackResolutionOutcome,
} from '../../shared/qa-report-v2';

import { MAX_TIMEOUT_MS } from './cli';
import { runBoundedProcess, unclassifiedProcessKind, type BoundedProcessResult } from './native-process';
import { emitProgress } from './report-publish';
import { type LoadedStackRun } from './run-context';
import { type RunnerArgs } from './types';

/**
 * The ids this file can resolve to a real command, i.e. the whole producible set
 * for a contract with no browser and no native surface.
 *
 * Exported because the required-check list and this registry are two
 * independent authorities that nobody used to cross-check, which produced both
 * failure directions at once — an id missing here deadlocks the run, an id here
 * with no arm is unfailable. The invariant test PROBES every entry for a path to
 * `passed` instead of retyping the list, so neither a missing arm nor a stale
 * entry can survive.
 */
export const STACK_COMMAND_CHECK_IDS = [
  'stack-build', 'stack-test', 'stack-lint', 'stack-format', 'stack-performance',
] as const;

export type StackCheckId = typeof STACK_COMMAND_CHECK_IDS[number];

interface ResolvedCommand {
  command: string;
  args: string[];
  cwd: string;
  /** Where the authority for this command came from, quoted in the evidence. */
  source: string;
}

type Resolution = ResolvedCommand | { unavailable: string };

/** Exported so the invariant test can declare every name a probe project needs. */
export const NODE_SCRIPT_BY_CHECK: Record<StackCheckId, string[]> = {
  'stack-build': ['build'],
  'stack-test': ['test'],
  'stack-lint': ['lint'],
  // Formatting was verified by CONFIGURATION only — the gate checked that a
  // formatter was declared and never ran it. Two runs shipped with
  // `pnpm format:check` red for their whole length (14co: 25 unformatted source
  // files at the tester; 15co: red from the first implementer turn to the last).
  // A declared script is the project's own answer, so running it is not an
  // invented command.
  'stack-format': ['format:check', 'format-check'],
  // `stack-performance` is only required when the architect declared a
  // performanceRisk — and it had no arm here at all, so it always resolved
  // unavailable, and it is on JUSTIFIED_NO_STACK_COMMAND_CHECK_IDS, so that
  // not-applicable was always excused. A required check whose only reachable
  // outcome is an exemption can never fail, and it was decorating exactly the
  // runs where someone had said performance mattered. No language has ONE
  // canonical benchmark form the never-invent rule would admit (`go test -bench`
  // exits 0 vacuously when a package declares no benchmarks, `cargo bench` needs
  // nightly or criterion, pytest needs a plugin), so the project's own declared
  // script is the only honest producer.
  'stack-performance': ['bench', 'benchmark'],
};

function readManifest(file: string): Record<string, unknown> | null {
  const parsed = readJson<unknown>(file, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function scriptsOf(manifest: Record<string, unknown> | null): Record<string, unknown> {
  const scripts = manifest?.scripts;
  return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
    ? scripts as Record<string, unknown>
    : {};
}

/** npm unless a competing lockfile says otherwise. Never guessed from prose. */
function nodePackageManager(projectRoot: string): string {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

function exists(projectRoot: string, rel: string): boolean {
  return fs.existsSync(path.join(projectRoot, rel));
}

/**
 * Where `go build` throws its object away.
 *
 * `go build ./...` discards the result when the pattern matches several packages
 * OR a single non-main one — but when it matches EXACTLY ONE main package it
 * writes a binary named after that package's directory. The compiled backend-only
 * Go layout puts every module in `internal/`, so the moment the role writes
 * `func main()` there the output name is `internal`, which collides with the
 * directory and `go` exits 1 (`cmd/go/internal/work/build.go:513`, "build output
 * %q already exists and is a directory"). Observed live in 15cl: `stack-build`
 * could never pass, so no Go backend-only run could reach TESTS_GREEN.
 *
 * `-o <devnull>` is Go's own compile-check form: `base.IsNull` blanks the target
 * and the object is discarded for ANY package count. Deliberately NOT Node's
 * `os.devNull` — that yields `\\.\nul` on Windows, which Go's `base.IsNull`
 * (which accepts only `os.DevNull` or a case-insensitive `NUL`) rejects.
 */
function goBuildSink(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * Resolve one check to a command, or explain why the project offers none.
 *
 * Ordered so a project's OWN declaration always wins over a language default:
 * a Go service with a `Makefile`-driven `package.json` script is still that
 * project's chosen build.
 */
export function resolveStackCommand(
  projectRoot: string,
  check: StackCheckId,
  serverCwd?: string,
): Resolution {
  const cwd = serverCwd ? path.resolve(projectRoot, serverCwd) : projectRoot;
  const wanted = NODE_SCRIPT_BY_CHECK[check] || [];

  const manifestPath = path.join(cwd, 'package.json');
  if (fs.existsSync(manifestPath)) {
    const scripts = scriptsOf(readManifest(manifestPath));
    const named = wanted.find((name) => typeof scripts[name] === 'string' && String(scripts[name]).trim());
    if (named) {
      const pm = nodePackageManager(cwd);
      return {
        command: pm,
        args: pm === 'npm' ? ['run', named, '--silent'] : ['run', named],
        cwd,
        source: `package.json scripts.${named}`,
      };
    }
  }

  // Go: `./...` over the module is the canonical whole-project form.
  if (exists(cwd, 'go.mod')) {
    if (check === 'stack-build') return { command: 'go', args: ['build', '-o', goBuildSink(), './...'], cwd, source: 'go.mod' };
    if (check === 'stack-test') return { command: 'go', args: ['test', './...'], cwd, source: 'go.mod' };
    if (check === 'stack-lint') return { command: 'go', args: ['vet', './...'], cwd, source: 'go.mod' };
  }

  if (exists(cwd, 'Cargo.toml')) {
    if (check === 'stack-build') return { command: 'cargo', args: ['build', '--locked'], cwd, source: 'Cargo.toml' };
    if (check === 'stack-test') return { command: 'cargo', args: ['test', '--locked'], cwd, source: 'Cargo.toml' };
    // clippy is a separate component and may not be installed; only claim it
    // when the project pinned it.
    if (check === 'stack-lint' && exists(cwd, 'clippy.toml')) {
      return { command: 'cargo', args: ['clippy', '--locked'], cwd, source: 'clippy.toml' };
    }
  }

  // PHP / Laravel. `artisan test` is Laravel's own runner; plain PHP projects
  // that declare composer scripts are handled by the composer branch below.
  const composerPath = path.join(cwd, 'composer.json');
  if (fs.existsSync(composerPath)) {
    const scripts = scriptsOf(readManifest(composerPath));
    const named = wanted.find((name) => scripts[name] !== undefined);
    if (named) {
      return { command: 'composer', args: ['run', named], cwd, source: `composer.json scripts.${named}` };
    }
    if (check === 'stack-test' && exists(cwd, 'artisan')) {
      return { command: 'php', args: ['artisan', 'test'], cwd, source: 'artisan' };
    }
  }

  // Python. `validateQaReportV2` deliberately refuses a justified
  // `not-applicable` for stack-build — "a backend that does not build is broken,
  // and every supported backend has a build form" — but no Python build form was
  // resolved here, so an api-only Python project could never satisfy the check
  // and could never settle. Byte-compiling the tree IS Python's build: it is the
  // step that turns source into the artifact the interpreter runs, and it fails
  // loudly on a syntax error anywhere in the project.
  if (check === 'stack-build'
    && (exists(cwd, 'pyproject.toml') || exists(cwd, 'setup.py') || exists(cwd, 'setup.cfg'))) {
    return {
      command: 'python3',
      // `-q` keeps the output to errors only; the trailing `.` compiles the
      // whole project tree, which is the equivalent of `go build ./...`.
      args: ['-m', 'compileall', '-q', '.'],
      cwd,
      source: 'python byte-compile',
    };
  }
  if (check === 'stack-test' && (exists(cwd, 'pytest.ini') || exists(cwd, 'pyproject.toml') || exists(cwd, 'tox.ini'))) {
    return { command: 'pytest', args: ['-q'], cwd, source: 'pytest configuration' };
  }
  if (check === 'stack-lint' && (exists(cwd, 'ruff.toml') || exists(cwd, '.ruff.toml'))) {
    return { command: 'ruff', args: ['check', '.'], cwd, source: 'ruff.toml' };
  }

  // JVM. The wrapper is required: invoking a machine-wide gradle/maven would run
  // a different toolchain than the project pinned.
  if (exists(cwd, 'gradlew') && (exists(cwd, 'build.gradle') || exists(cwd, 'build.gradle.kts'))) {
    if (check === 'stack-build') return { command: './gradlew', args: ['build', '-x', 'test'], cwd, source: 'gradlew' };
    if (check === 'stack-test') return { command: './gradlew', args: ['test'], cwd, source: 'gradlew' };
  }
  if (exists(cwd, 'mvnw') && exists(cwd, 'pom.xml')) {
    if (check === 'stack-build') return { command: './mvnw', args: ['-q', '-DskipTests', 'package'], cwd, source: 'mvnw' };
    if (check === 'stack-test') return { command: './mvnw', args: ['-q', 'test'], cwd, source: 'mvnw' };
  }

  return {
    unavailable: `the project declares no ${check.replace('stack-', '')} command `
      + '(no matching manifest script and no pinned language default)',
  };
}

// This text becomes a check `summary`, which the QaReportV2 schema constrains to
// a safe string — NO control characters. `\s` collapses whitespace but leaves
// ESC, NUL and the rest of C0 intact, so a toolchain that colourizes despite
// `CI=1` (or emits a NUL) produced a report that failed its own schema. That
// failure code is `invalid-schema`, which has no entry in GATE_ID_FOR_FAILURE,
// so persistGateRejection no-ops and the file LEFT ON DISK cannot be parsed on
// the next read. Strip by char code, exactly like `bounded()` in
// report-publish.ts — no control character may appear in this source either.
function truncate(value: string, max = 400): string {
  let stripped = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    stripped += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const text = stripped.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * How much of a stack command's combined output is retained.
 *
 * The bound is now ENFORCED one module over, by `runBoundedProcess`, and this
 * constant only quotes it in a summary a human reads — a summary naming a bound
 * the runner does not actually apply is worse than one naming none. It is a
 * literal rather than a re-export of `MAX_NATIVE_PROCESS_OUTPUT` because that
 * import would be a load-time edge in a require cycle (run-context imports this
 * file, native-process imports run-context) and would leave the value
 * undefined at module init. The two are pinned equal by a drift guard in
 * __tests__/process-group.test.ts instead.
 */
export const MAX_STACK_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Why a command that produced no exit code produced none — the whole set of
 * ways a stack check can be CUT SHORT, measured on node v26.5.0/darwin:
 *
 *   bound fired        -> kind 'timeout',      exitCode null, signal SIGKILL
 *   output overflowed  -> kind 'output-limit', exitCode null, signal SIGKILL
 *   pipe held past bound-> kind 'abandoned',   exitCode 0/n,  signal null
 *   killed from outside-> kind 'completed',    exitCode null, signal SIG*
 *   runner exhausted   -> kind 'start-failed', exitCode null, signal null
 *   binary absent      -> kind 'unavailable',  exitCode null, signal null
 *
 * The first four mean the command STARTED and was cut short. The last means it
 * never started and there was nothing to start — the honest exemption. The
 * fifth means it never started FOR A REASON THAT IS OURS: an EMFILE, ENFILE or
 * EAGAIN at the spawn, where the command exists, is executable, and would have
 * produced a verdict if this process had had a descriptor to give it.
 *
 * Those last two are OPPOSITE FACTS and used to be one arm. Every kind here
 * that produces no exit code once landed on `not-applicable` with "could not be
 * executed" — the exact prose `validateQaReportV2` accepts as a justified
 * exemption for stack-test — so a killed suite and an exhausted runner both
 * settled the run green. Measured end to end: a `go test ./...` refused a
 * descriptor reported `not run: could not be executed`, satisfied
 * `justifiedNoStackCommand`, and closed the run `passed` with no test evidence
 * at all. The same was true of an OOM kill, a cgroup cancellation, a
 * segfaulting native extension and an assertion's SIGABRT — all arrive with
 * `exitCode: null` and no error object, so a classifier reading only the errno
 * could not see them, and a suite that ran 412 tests and was then SIGKILLed
 * reported `passed`.
 *
 * The exhaustion half of that was invisible to the enumeration test as well as
 * to this switch, because the old classification was `completed`: the union
 * forces a decision per KIND, and a spawn refused for EMFILE did not have a
 * kind of its own to force one. Giving it a name here is the repair — the
 * `never` assertion below now cannot compile until both classifiers decide.
 *
 * A SWITCH over `BOUNDED_PROCESS_KINDS`, so a member added to that union
 * without an arm here is a COMPILE ERROR. While this was an `if`-chain ending
 * in `return null` it was not: a sixth kind was added and `tsc` reported
 * nothing, and the arm it fell through to is the one below that reads exit 0 as
 * a pass. The switch also dissolves the ordering hazard the chain had to be
 * careful about — this runner kills with SIGKILL, so a timeout and an overflow
 * BOTH also carry a signal, and testing the signal first would have reported
 * every bound as an anonymous kill and lost the one fact that explains it. One
 * arm per kind cannot be mis-ordered.
 *
 * The honest "declared but its binary is absent" exemption carries neither a
 * forced kind nor a signal, which is exactly what keeps it green.
 *
 * Exported so the enumeration test can walk every member of the union against
 * it rather than sampling the four this comment happens to describe.
 *
 * WHERE THIS DELIBERATELY STOPS: an exit CODE is never read as a kill, even
 * when it encodes one. The dominant real-world OOM shape on this path is an
 * `npm test` whose suite the kernel killed: the package manager survives, sees
 * `128 + SIGKILL` from its shell, and exits 137, so the run arrives here with a
 * number and is reported `failed`. Widening to 128+n would be wrong more often
 * than right — 137, 139 and 143 are also perfectly ordinary application exit
 * codes, and several test runners return them deliberately — and the cost of
 * being wrong is asymmetric: mapping a genuine red to INCONCLUSIVE tells a
 * human to re-run a suite that will fail again identically, which is how a
 * gate becomes noise. `failed` for a killed-grandchild OOM is not a false
 * green; it is a real red with the wrong explanation attached, and the
 * explanation is recoverable from the output this reports. The three arms
 * below all key on facts the KERNEL reported about the process this runner
 * itself spawned, and that is the line.
 */
export function cutShortCause(run: BoundedProcessResult, timeoutMs: number): string | null {
  switch (run.kind) {
    case 'timeout':
      return `it was still running at its ${timeoutMs} ms bound and was killed`;
    case 'output-limit':
      return `its output passed the ${MAX_STACK_OUTPUT_BYTES} byte bound and it was killed`;
    case 'abandoned':
      return `it exited ${run.exitCode === null ? 'without a code' : String(run.exitCode)} but something it `
        + `started outlived it holding its output open past the ${timeoutMs} ms bound, so the run was `
        + 'abandoned and its process group killed';
    case 'start-failed':
      return `the runner could not start it (${run.stderr.trim() || 'the spawn was refused'}) — the command `
        + 'exists and this process could not spawn it, so nothing ran and nothing was measured';
    case 'completed':
      return run.signal ? `it was killed by ${run.signal} before it could report` : null;
    case 'unavailable':
      return null;
    default:
      return unclassifiedProcessKind(run.kind);
  }
}

/**
 * The bound for ONE stack check — a build, a test suite, a linter.
 *
 * It is deliberately not just `args.timeoutMs`. These commands also run as a
 * leg of the `browser` command, whose default is the PER-STEP thirty seconds
 * sized for a Playwright navigation; a repo-wide `prettier --check` or a cold
 * `go build` routinely outruns that. Before the cut-short classification below,
 * being killed there was laundered into a justified exemption and settled the
 * run green, so the under-sizing was invisible. Now it is loud — which makes an
 * under-sized default a manufactured INCONCLUSIVE, exactly the failure this
 * work is not allowed to introduce. So an INHERITED per-step default widens to
 * the whole-command bound, while a bound the caller explicitly asked for is
 * honoured verbatim in both directions.
 *
 * A directly-constructed RunnerArgs (tests, the test-environment harness) may
 * carry no bound at all. Neither of the two things that could then happen is
 * acceptable — spawnSync read a missing timeout as "no timeout", and the
 * `setTimeout` that now enforces the bound would fire IMMEDIATELY on a NaN —
 * so such a caller gets the whole-command bound instead of an unbounded run or
 * an instant manufactured inconclusive.
 */
export function stackBoundMs(args: RunnerArgs): number {
  if (args.timeoutMsExplicit && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0) {
    return args.timeoutMs;
  }
  return MAX_TIMEOUT_MS;
}

/**
 * Map one FINISHED bounded run to a v2 check: a missing command is
 * `not-applicable` with its reason; a present command's exit code decides; a
 * command that ran but was cut short is `not-applicable` marked INCONCLUSIVE,
 * which no exemption covers, so the run is rejectable rather than green.
 *
 * Split out of `runStackCheck` so the mapping can be driven over the whole
 * STATE SPACE of a `BoundedProcessResult` — every kind against every exit
 * code and signal — rather than only over the shapes a fixture happens to
 * produce. That is the test the blocker needed and did not have: the false
 * green was not a missing arm in the union (both switches were exhaustive) but
 * a kind arriving at a branch below that keys on `exitCode`, where no
 * enumeration of the union can reach it. See
 * __tests__/inconclusive-evidence.test.ts.
 *
 * NO ARM IN THIS FUNCTION IS EXCUSABLE ANY MORE, and that is the round's
 * repair rather than a restatement. Every check it returns carries a
 * `notApplicable` reason, and the only reason `validateQaReportV2` excuses —
 * `no-command-declared` — is emitted one function down in `runStackCheck`,
 * where a command was never resolved at all. What used to decide the exemption
 * was the PROSE: `not run: … could not be executed` is what the validator
 * matched, and both the `unavailable` arm and the 127 arm below write it about
 * a command the project DID declare. So a missing `pytest` and a missing
 * `node_modules` were excused exactly as an absent command was, with no kill,
 * no timeout and no marker anywhere for the cut-short work to catch.
 *
 * The kind still decides WHICH not-applicable this is — `unavailable` is the
 * declared-but-absent target, and keeping that keyed on the kind rather than on
 * "no exit code" is what stopped an EMFILE at the spawn walking into it — but
 * the exemption is no longer downstream of that distinction at all.
 */
export function stackCheckOutcome(
  id: string,
  label: string,
  source: string,
  run: BoundedProcessResult,
  boundMs: number,
  elapsedMs: number,
): QaReportV2['checks'][number] {
  const cutShort = cutShortCause(run, boundMs);
  if (cutShort) {
    // It ran. It was killed. There is no verdict here in EITHER direction,
    // and reporting one would be a lie whichever way it pointed: `passed`
    // certifies untested source, `failed` invents a red nobody observed.
    // The honest third value is "we could not tell", and the marker is what
    // stops the validator excusing it as an absent command.
    emitProgress(`stack ${id}: INCONCLUSIVE after ${elapsedMs} ms — ${cutShort}`);
    return {
      id,
      status: 'not-applicable' as const,
      notApplicable: 'cut-short' as const,
      summary: truncate(
        `${CHECK_INCONCLUSIVE_PREFIX} \`${label}\` produced no verdict because ${cutShort} `
        + `after ${elapsedMs} ms (${source}). No evidence exists in either direction; `
        + 're-run it, or raise --timeout-ms if the command legitimately needs longer.',
      ),
    };
  }
  if (run.kind === 'unavailable') {
    // The command is declared and its target is absent or unexecutable — an
    // environment gap, not a product failure, and never a silent pass. The
    // same fact as the 127 arm below, arriving one layer earlier.
    //
    // NOT EXCUSABLE, and until this round it was. The prose here satisfies both
    // halves of what the validator's old exemption predicate matched (`not
    // run:` and `could not be executed`), so a declared `pytest` that is absent
    // from the image — or present without its execute bit — reported
    // `stack-test: not-applicable`, was excused, and settled the run green with
    // zero tests run. The reason field is what the validator reads now, and
    // this is the arm it names as an environment gap rather than an absent
    // command.
    const detail = run.stderr.trim() || 'the runner could not be spawned';
    emitProgress(`stack ${id}: blocked — ${detail}`);
    return {
      id,
      status: 'not-applicable' as const,
      notApplicable: 'declared-not-runnable' as const,
      summary: truncate(`not run: \`${label}\` could not be executed (${detail})`),
    };
  }
  if (typeof run.exitCode !== 'number') {
    // Unreachable today: everything that produces no exit code is either cut
    // short above or `unavailable`. Kept as the FAIL-CLOSED backstop for the
    // exact defect class this file keeps meeting — a new ending that nobody
    // classified, arriving with a null exit code — because the alternative
    // reading of "no code" is the exemption one branch up.
    emitProgress(`stack ${id}: INCONCLUSIVE after ${elapsedMs} ms — it ended as '${run.kind}' with no exit code`);
    return {
      id,
      status: 'not-applicable' as const,
      notApplicable: 'cut-short' as const,
      summary: truncate(
        `${CHECK_INCONCLUSIVE_PREFIX} \`${label}\` ended as '${run.kind}' with no exit code after `
        + `${elapsedMs} ms (${source}), so this runner cannot say whether it passed or failed.`,
      ),
    };
  }
  if (run.exitCode === 0) {
    emitProgress(`stack ${id}: passed in ${elapsedMs} ms`);
    return { id, status: 'passed' as const, summary: truncate(`\`${label}\` exited 0 (${source})`) };
  }
  const output = `${run.stdout}\n${run.stderr}`;
  // 127 is the POSIX "command not found", and every package manager propagates
  // it verbatim from the shell. The project DECLARED the script, so the script
  // is not the problem — its binary is absent (pre-install, or a devDependency
  // nobody added). That is the same environment gap as a failed spawn one
  // branch up, not a product failure, and calling it `failed` would make a
  // missing formatter indistinguishable from unformatted source.
  // Exit code ONLY. Matching "command not found" in the OUTPUT looked like a
  // helpful widening and is a trap: a script that genuinely fails while its own
  // output happens to contain that phrase would be laundered into
  // `not-applicable` — caught by this file's own fixture, which failed with a
  // TypeError after a stray `sh: …: command not found` line.
  if (run.exitCode === 127) {
    emitProgress(`stack ${id}: blocked — ${label} is declared but its binary is absent`);
    return {
      id,
      // The DECLARED-BUT-ABSENT arm, and the everyday one: `npm test` in a
      // fresh clone before `npm install` exits 127 through the package
      // manager. It is not `failed` — the source is not what is wrong — and it
      // is emphatically not the exemption, which is why this carries the same
      // reason as the `unavailable` arm above rather than the prose they used
      // to share. Measured before the field existed: a Node api-only project
      // whose build passed and whose test exited 127 settled `passed`.
      status: 'not-applicable' as const,
      notApplicable: 'declared-not-runnable' as const,
      summary: truncate(`not run: \`${label}\` could not be executed (declared but its binary is absent: ${output})`),
    };
  }
  return {
    id,
    status: 'failed' as const,
    summary: truncate(`\`${label}\` exited ${run.exitCode}: ${output}`),
  };
}

/**
 * Resolve one check, run it under the stack bound, and map what came back.
 *
 * The resolution OUTCOME is handed back beside the check so `runStackChecks` can
 * record the whole set in one runtime-owned sidecar. It is the same fact the
 * check's `notApplicable` reason carries, written to a place the report's author
 * cannot reach — see shared/qa-report-v2/stack-resolution.ts for why the
 * validator cannot re-derive it instead.
 */
async function runStackCheck(
  args: RunnerArgs,
  id: string,
  heartbeatMs?: number,
): Promise<{ check: QaReportV2['checks'][number]; resolution: QaStackResolutionOutcome }> {
  const resolved = resolveStackCommand(args.projectRoot, id as StackCheckId, args.serverCwd);
  if ('unavailable' in resolved) {
    // THE ONE EXCUSABLE ARM, and the only place in this runner that may emit
    // `no-command-declared`. The fact is decided HERE, where it is known —
    // `resolveStackCommand` has just walked every manifest and language default
    // and found nothing — and travels to the validator in the report instead of
    // being reconstructed there from this sentence. Three arms in
    // `stackCheckOutcome` write prose the old predicate could not tell from
    // this one; none of them can reach this reason.
    emitProgress(`stack ${id}: not applicable — ${resolved.unavailable}`);
    return {
      check: {
        id,
        status: 'not-applicable' as const,
        notApplicable: 'no-command-declared' as const,
        summary: truncate(`not run: ${resolved.unavailable}`),
      },
      resolution: 'no-command-declared',
    };
  }
  const label = `${resolved.command} ${resolved.args.join(' ')}`;
  // The bound and the deadline are announced BEFORE the command starts, and the
  // heartbeat passed below keeps re-asserting liveness while it runs. This path
  // can now do both: `runBoundedProcess` is promise-based, so the event loop is
  // free — under the spawnSync it replaced, the one thread that could have
  // emitted progress was the one blocked inside the command, and the
  // announcement was all there was.
  //
  // The announcement is still the load-bearing half, because it is the only one
  // that arrives BEFORE the silence: an observer who knows when the silence
  // must end can tell a working runner from a dead one immediately, rather than
  // after a heartbeat interval. A multi-minute silent run reads as dead and
  // gets relaunched (observed 8co: four concurrent runners over one run
  // directory), and the bound below is now minutes by default.
  const startedAtMs = Date.now();
  const boundMs = stackBoundMs(args);
  emitProgress(
    `stack ${id}: ${label} (${resolved.source}) — bound ${boundMs} ms, `
    + `heartbeats only until it finishes or ${new Date(startedAtMs + boundMs).toISOString()}`,
  );
  const run = await runBoundedProcess(
    [resolved.command, ...resolved.args],
    resolved.cwd,
    boundMs,
    // `intervalMs: undefined` is the shared NATIVE_HEARTBEAT_MS, applied inside
    // runBoundedProcess. Deliberately not imported and defaulted here: that
    // import would be a load-time edge in a require cycle, and a second copy of
    // the cadence is a second thing to drift.
    { label: `stack ${id}`, intervalMs: heartbeatMs },
    { CI: '1' },
  );
  return {
    check: stackCheckOutcome(id, label, resolved.source, run, boundMs, Date.now() - startedAtMs),
    resolution: 'declared',
  };
}

/**
 * SEQUENTIAL, deliberately. These commands share one working tree, one lockfile
 * and one CPU — a build and a test suite racing each other over the same
 * `node_modules` is a failure mode the project never sees when it runs them
 * itself. The spawnSync shape this replaced could not do anything else; the
 * async one can, and must not.
 *
 * `heartbeatMs` overrides the pulse cadence, and exists for the same reason
 * `runBoundedProcess`'s own `intervalMs` does: the default is ten seconds, so a
 * test that could only observe the wire by waiting for it would cost more than
 * this whole file and would not be written. No production caller passes it, and
 * omitting it is not a different code path — `undefined` is what a caller that
 * has never heard of it produces either way.
 */
export async function runStackChecks(
  args: RunnerArgs,
  required: readonly string[],
  heartbeatMs?: number,
): Promise<QaReportV2['checks']> {
  const checks: QaReportV2['checks'] = [];
  const resolved: Record<string, QaStackResolutionOutcome> = {};
  for (const id of required) {
    const outcome = await runStackCheck(args, id, heartbeatMs);
    checks.push(outcome.check);
    resolved[id] = outcome.resolution;
  }
  // The runtime's own record of what it found, in the run directory no agent may
  // write. `validateQaReportV2` requires it to agree before it excuses a check,
  // so a report claiming `no-command-declared` for a command this run actually
  // resolved is refused however convincingly the report is written. A refused
  // write is announced rather than swallowed: the run still publishes, and the
  // validator then refuses every exemption for it, which is a diagnosable deny
  // rather than a silent loss of the binding.
  //
  // A directly-constructed `RunnerArgs` may carry no run id at all — the
  // producible-check invariant probes this function for a path to `passed` and
  // has no run to record against, the same shape `stackBoundMs` already
  // accommodates. There is no run directory to write into, so there is nothing
  // to record and nothing is announced; the validator is unaffected because it
  // only ever asks about a run that exists, and an absent record refuses the
  // exemption rather than granting it.
  if (!args.runId || !args.projectRoot) return checks;
  if (!recordStackResolution(args.projectRoot, args.runId, resolved)) {
    emitProgress(
      'stack: the runtime could not persist its command-resolution record, so no check may be '
      + 'excused for having no command; answer this project\'s "use Traffic One here?" question '
      + `and check that .traffic-one/runs/${args.runId}/ contains no symbolic links`,
    );
  }
  return checks;
}

/**
 * The report-level status of a stack run — the field that decides what the
 * DURABLE artifact says, and therefore the amplifier that turns a mislabelled
 * check into a green run. Three arms, and the middle one is new.
 *
 * A `failed` check reds the report. Uncontroversial.
 *
 * An INCONCLUSIVE check makes it `failed`, and that arm was missing. A
 * cut-short check is `not-applicable` with the marker, so under "red only on
 * `failed`" a report whose test suite was SIGKILLed — or never spawned — still
 * carried `status: 'passed'` on disk. The validator rejects it (through the
 * required-check loop and through its own blanket cut-short rule), and
 * `persistGateRejection` then rewrites that field to `failed`, so this was
 * never the last line of defence — but it was a producer certifying a status
 * its own checks contradict, and any consumer of a report that was not
 * validated reads the field verbatim.
 *
 * THAT MAKES THIS ARM DEFENCE IN DEPTH, NOT AN INDEPENDENT GUARD, and a round
 * summary counted it as one. Mutation says otherwise: delete this arm and the
 * producer publishes `passed` while the validator still rejects, so the only
 * thing the arm decides on its own is what an UNVALIDATED reader sees. Its
 * value is real and it is exactly that — the durable artifact — which is worth
 * having and is not a second reason to believe the run cannot settle.
 *
 * It asks the question the same two ways the validator does — the carried
 * reason, and the marker in the prose — for the same reason and with the same
 * status: one condition asked twice, so that a producer emitting one and
 * forgetting the other still cannot publish `passed` over a dead signal. Both
 * are written in one expression by every arm of `stackCheckOutcome`, so
 * neither can decide alone against any report this runner produces. A branch
 * census over the lane suite says the same thing in numbers, and adds one
 * correction to the sentence above: `cutShortProseOnly: 1, cutShortReasonOnly:
 * 0, cutShortBoth: 0`. The pair is never actually asked of a report carrying
 * both — the only report that reaches the rule is hand-authored, prose without
 * a reason — so "one condition asked twice" is right about this runner's
 * producers and is not the case the rule is exercised on.
 *
 * WHICH reason means what is now `notApplicableDisposition`'s answer rather than
 * a literal comparison here, and that is the fifth-reason repair. A member added
 * to `QA_NOT_APPLICABLE_REASONS` used to slip this function's cut-short arm
 * (which compared against `'cut-short'`) while being refused the validator's
 * exemption (which compared against `'no-command-declared'`) — fail open in one
 * place and closed in another, from two literals written in two files. The
 * disposition switch cannot compile until a new member is classified, and both
 * rules then follow from that one classification.
 *
 * A `not-applicable` check with NO reason at all now reds the producer status
 * too, where it used to publish `passed`. That is the same fail-closed answer
 * the validator has always given such a report — absence is not excusable — and
 * the durable artifact ended `failed` either way through
 * `persistGateRejection`; what changes is only what an UNVALIDATED reader sees
 * in the window before the correction, which is what this whole function is for.
 *
 * NOT `blocked-environment`, which is what the native path picks for exactly
 * this state and what "nobody observed a failure" argues for. It is invalid
 * here: `validateQaReportV2` refuses that status outright for a none/nonvisual
 * contract, and refuses it as `invalid-schema` — a code with no entry in
 * GATE_ID_FOR_FAILURE, so the rejection does not persist and the artifact keeps
 * whatever it said. Measured: routing an EMFILE'd stack-test that way turned a
 * clean `required-check-failed` into `invalid-schema`, which is a WORSE outcome
 * than the false green for a reader, because the failure stops naming the
 * check. The three-value status union is not per-producer, so on this path the
 * only spelling of "not a pass" is `failed`, and it agrees with what the
 * validator writes to the same field a moment later. The check-level verdict is
 * where the distinction lives and it is untouched: the check stays
 * `not-applicable` with the inconclusive prose, so nothing here claims the
 * command was observed to fail.
 *
 * A DECLARED COMMAND THAT COULD NOT BE RUN reds the report too, and that arm
 * exists because the three views disagreed without it. The validator rejects
 * such a run — `declared-not-runnable` is refused the exemption — and
 * `persistGateRejection` corrects the artifact, so the durable end state was
 * already right; but between `publishQaReportV2` and that correction the file
 * on disk said `passed`, and a crash, a kill or a reader in that window sees a
 * pass over a suite that never ran. This arm cannot manufacture a red the
 * validator would not produce: the only checks it fires on are ones the
 * required-check loop is about to refuse. Unlike the two arms above, which
 * exist for readers who never validate at all, this one exists for the
 * milliseconds before validation.
 *
 * A report whose every check is `not-applicable` and none of them inconclusive
 * is `passed`, DELIBERATELY — and the reason first written down here was the
 * wrong one. It said such a report means "this project declares no build,
 * test, lint or format command". It ALSO means the runner was pointed at a
 * directory with no manifest at all: measured, an empty directory with a
 * compiled contract produces exactly that report, four not-applicable checks
 * and `passed`, and nothing in this function can tell the two apart because
 * `resolveStackCommand` answers "no command" to both.
 *
 * The decision survives, contained by a different mechanism than the one
 * written down. What makes an empty directory unsettleable is not this
 * function's charity but `validateQaReportV2` rejecting on `stack-build`,
 * which is deliberately OFF the exemption allowlist — and the rejection is
 * durable, because `required-check-failed` has a `GATE_ID_FOR_FAILURE` entry,
 * so the artifact is corrected to `failed` on disk. Reddening here instead
 * would manufacture a red nobody observed for exactly the projects the
 * exemption was written for, while changing nothing about the runs that
 * matter, and it would do it in the durable artifact, where a red is the most
 * expensive thing to be wrong about. The shape that genuinely needed
 * distinguishing is the inconclusive one above, because that is the check that
 * RAN, or should have.
 */
export function stackReportStatus(checks: QaReportV2['checks']): QaReportV2['status'] {
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  const verdictless = checks.filter((check) => check.status === 'not-applicable');
  if (verdictless.some((check) => notApplicableDisposition(check.notApplicable) === 'no-verdict')
    || checks.some((check) => inconclusiveCheckSummary(check.summary))) {
    return 'failed';
  }
  if (verdictless.some((check) => notApplicableDisposition(check.notApplicable) === 'not-excusable')) {
    return 'failed';
  }
  return 'passed';
}

export type { LoadedStackRun };
