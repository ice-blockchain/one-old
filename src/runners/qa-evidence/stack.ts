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
import { spawnTool } from '../../shared/spawn-tool';
import { CHECK_INCONCLUSIVE_PREFIX, type QaReportV2 } from '../../shared/qa-report-v2';

import { MAX_TIMEOUT_MS } from './cli';
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
 * How much of a stack command's combined output is retained. Unchanged from the
 * inline literal this replaced; named because the overflow arm below now has to
 * quote it in a summary a human reads.
 */
export const MAX_STACK_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The errno on `spawnSync`'s `error`, or '' when there is none.
 *
 * Same shape and same purpose as `errnoOf` in shared/exec.ts:50 — the repo's
 * existing precedent for reading a cause off a spawnSync result rather than
 * collapsing every non-numeric status into one bucket.
 */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code ? code : '';
}

/**
 * Why a command that produced no exit status produced none — measured on node
 * v26.5.0/darwin against this file's own spawnSync options:
 *
 *   timeout fired     -> status null, signal SIGTERM, error.code ETIMEDOUT
 *   maxBuffer exceeded-> status null, signal SIGTERM, error.code ENOBUFS
 *   binary absent     -> status null, signal null,    error.code ENOENT
 *
 * The first two mean the command STARTED and was killed mid-flight; the third
 * means it never started. Those are opposite facts and this arm used to report
 * them identically, as `not-applicable / "could not be executed"` — the exact
 * prose `validateQaReportV2` accepts as a justified exemption for stack-test.
 * A hung test suite therefore settled the run green with no test evidence.
 */
function cutShortCause(error: unknown, timeoutMs: number): string | null {
  const errno = errnoOf(error);
  if (errno === 'ETIMEDOUT') return `it was still running at its ${timeoutMs} ms bound and was killed`;
  if (errno === 'ENOBUFS') return `its output passed the ${MAX_STACK_OUTPUT_BYTES} byte bound and it was killed`;
  return null;
}

/**
 * Run the resolved commands and map each to a v2 check. A missing command is
 * `not-applicable` with its reason; a present command's exit code decides; a
 * command that ran but was cut short is `not-applicable` marked INCONCLUSIVE,
 * which no exemption covers, so the run is rejectable rather than green.
 */
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
 * carry no bound at all, which spawnSync reads as "no timeout"; such a caller
 * gets the whole-command bound rather than an unbounded run.
 */
export function stackBoundMs(args: RunnerArgs): number {
  if (args.timeoutMsExplicit && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0) {
    return args.timeoutMs;
  }
  return MAX_TIMEOUT_MS;
}

export function runStackChecks(
  args: RunnerArgs,
  required: readonly string[],
): QaReportV2['checks'] {
  return required.map((id) => {
    const resolved = resolveStackCommand(args.projectRoot, id as StackCheckId, args.serverCwd);
    if ('unavailable' in resolved) {
      emitProgress(`stack ${id}: not applicable — ${resolved.unavailable}`);
      return { id, status: 'not-applicable' as const, summary: truncate(`not run: ${resolved.unavailable}`) };
    }
    const label = `${resolved.command} ${resolved.args.join(' ')}`;
    // The bound and the deadline are announced BEFORE the command starts, and
    // this is the only heartbeat this path can honestly offer: spawnTool is
    // spawnSync, so the one thread that could emit progress is the one blocked
    // inside the command. What the announcement buys is the thing silence
    // otherwise destroys — an observer who knows when the silence must end can
    // tell a working runner from a dead one. A multi-minute silent run reads as
    // dead and gets relaunched (observed 8co: four concurrent runners over one
    // run directory), and the bound below is now minutes by default.
    const startedAtMs = Date.now();
    const boundMs = stackBoundMs(args);
    emitProgress(
      `stack ${id}: ${label} (${resolved.source}) — bound ${boundMs} ms, `
      + `no output until it finishes or ${new Date(startedAtMs + boundMs).toISOString()}`,
    );
    const run = spawnTool(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      encoding: 'utf8',
      timeout: boundMs,
      maxBuffer: MAX_STACK_OUTPUT_BYTES,
      env: { ...process.env, CI: '1' },
    });
    const elapsedMs = Date.now() - startedAtMs;
    if (run.error || typeof run.status !== 'number') {
      const cutShort = cutShortCause(run.error, boundMs);
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
          summary: truncate(
            `${CHECK_INCONCLUSIVE_PREFIX} \`${label}\` produced no verdict because ${cutShort} `
            + `after ${elapsedMs} ms (${resolved.source}). No evidence exists in either direction; `
            + 're-run it, or raise --timeout-ms if the command legitimately needs longer.',
          ),
        };
      }
      // The command exists in the manifest but could not be executed at all —
      // an environment gap, not a product failure, and never a silent pass.
      const detail = run.error ? run.error.message : 'the runner could not be spawned';
      emitProgress(`stack ${id}: blocked — ${detail}`);
      return {
        id,
        status: 'not-applicable' as const,
        summary: truncate(`not run: \`${label}\` could not be executed (${detail})`),
      };
    }
    if (run.status === 0) {
      emitProgress(`stack ${id}: passed in ${elapsedMs} ms`);
      return { id, status: 'passed' as const, summary: truncate(`\`${label}\` exited 0 (${resolved.source})`) };
    }
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
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
    if (run.status === 127) {
      emitProgress(`stack ${id}: blocked — ${label} is declared but its binary is absent`);
      return {
        id,
        status: 'not-applicable' as const,
        summary: truncate(`not run: \`${label}\` could not be executed (declared but its binary is absent: ${output})`),
      };
    }
    return {
      id,
      status: 'failed' as const,
      summary: truncate(`\`${label}\` exited ${run.status}: ${output}`),
    };
  });
}

export function stackReportStatus(checks: QaReportV2['checks']): QaReportV2['status'] {
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  return 'passed';
}

export type { LoadedStackRun };
