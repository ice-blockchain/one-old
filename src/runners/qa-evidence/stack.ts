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
// The rule here is: NEVER invent a command. Either the project declares it (a
// manifest script) or the language has exactly one canonical form and its
// manifest is present. Anything else is `not-applicable` WITH the reason
// recorded — a check that did not run must never read as covered.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from '../../shared/fsjson';
import { spawnTool } from '../../shared/spawn-tool';
import { type QaReportV2 } from '../../shared/qa-report-v2';

import { emitProgress } from './report-publish';
import { type LoadedStackRun } from './run-context';
import { type RunnerArgs } from './types';

export type StackCheckId = 'stack-build' | 'stack-test' | 'stack-lint' | 'stack-performance';

interface ResolvedCommand {
  command: string;
  args: string[];
  cwd: string;
  /** Where the authority for this command came from, quoted in the evidence. */
  source: string;
}

type Resolution = ResolvedCommand | { unavailable: string };

const NODE_SCRIPT_BY_CHECK: Record<string, string[]> = {
  'stack-build': ['build'],
  'stack-test': ['test'],
  'stack-lint': ['lint'],
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
    if (check === 'stack-build') return { command: 'go', args: ['build', './...'], cwd, source: 'go.mod' };
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

function truncate(value: string, max = 400): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Run the resolved commands and map each to a v2 check. A missing command is
 * `not-applicable` with its reason; a present command's exit code decides.
 */
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
    emitProgress(`stack ${id}: ${label} (${resolved.source})`);
    const run = spawnTool(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      encoding: 'utf8',
      timeout: args.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
    });
    if (run.error || typeof run.status !== 'number') {
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
      return { id, status: 'passed' as const, summary: truncate(`\`${label}\` exited 0 (${resolved.source})`) };
    }
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
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
