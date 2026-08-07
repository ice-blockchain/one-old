// The two copies of the machine-state-root expression that CANNOT import
// shared/state-root.ts, because they are `node -e` SOURCE for a process that runs
// standalone with no module resolution:
//   - src/config/opencode-mcp.ts        — the MCP server bootstrap the host spawns
//   - src/shared/windsurf-hook-command.ts — the launcher committed into a project's
//                                           `.windsurf/hooks.json`
// __tests__/state-root.test.ts pins the four IMPORTABLE resolvers by replacing the
// base with a function that throws. That technique cannot reach these two: there is
// no binding to replace in a string. Until now they were protected by comments only.
//
// What is asserted here is not "the strings look right today" — a test that greps
// for a substring it also hardcodes proves exactly nothing, since the substring in
// the test and the substring in the launcher are two more copies of the same
// expression that agree by coincidence. Instead:
//
//   1. The environment keys the base READS are discovered from the base's own
//      SOURCE. A precedence step added at the base introduces a key, the key
//      becomes a new cell in the matrix below, and the launcher — which cannot
//      have anticipated it — resolves the old location.
//   2. The expected path for each cell is produced by CALLING the real resolvers
//      (globalTrafficOneDir for the MCP bootstrap; stableBinDir for the Windsurf
//      one, which owes consistency to stableBinDir's composition as well as to the
//      base). Nothing about the answer is written down in this file.
//   3. The launchers are then EXECUTED, in a child process, per cell, and observed
//      by which file they actually loaded. A launcher that resolves the right
//      string by a different route still passes; one that resolves the wrong
//      directory fails no matter how it is spelled.
//
// What this does NOT close, deliberately: a SEVENTH inlined copy in a file this
// test has never heard of. See the note above the last test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { globalTrafficOneDir } from '../state-root';
import { documentedBinDir, stableBinDir } from '../runner-shims';
import { windsurfWorkspaceHookCommand } from '../windsurf-hook-command';
import { openCodeMcpServerEntry } from '../../config/opencode-mcp';
import { PLUGIN_ROOT_ENV_KEYS } from '../../gen/sources/hooks';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP_PREFIX = 't1-lane-launcher-';
const WINDSURF_SHIM = 'windsurf-hook-runtime.cjs';
const MCP_SHIM = 'opencode-mcp.cjs';

// ── derivation: what does the source of truth actually read? ─────────────────

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// The body of one named function, by brace matching. Callers assert a marker
// they expect inside the result, so a failed extraction cannot silently yield an
// empty body and an empty (vacuous) key set.
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is no longer declared as a function — this extraction needs updating`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Every process-environment key a function reads, taken from its source. */
function envKeysReadBy(rel: string, fnName: string, marker: string): string[] {
  const source = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  const body = functionBody(source, fnName);
  assert.ok(body.includes(marker), `${rel}#${fnName} no longer contains ${marker}; the extraction below is reading the wrong text`);
  const keys = new Set<string>();
  for (const match of body.matchAll(/(?:\benv|\bprocess\.env)\.([A-Z][A-Z0-9_]+)/g)) keys.add(match[1] as string);
  assert.ok(keys.size > 0, `${rel}#${fnName} appears to read no environment key at all`);
  return [...keys].sort();
}

// The base itself. A precedence step added here adds a key here.
const BASE_KEYS = envKeysReadBy('src/shared/state-root.ts', 'globalTrafficOneDir', 'traffic-one');
// The second source of truth the Windsurf launcher mirrors: stableBinDir() is
// path.join(path.dirname(toolchainRoot()), 'bin'), so toolchainRoot's own
// precedence is owed to that launcher too.
const TOOLCHAIN_KEYS = envKeysReadBy('src/shared/toolchain-paths.ts', 'toolchainRoot', 'toolchains');

test('the base\'s environment keys are discovered from its source, not listed here', () => {
  // Non-vacuity for every matrix below: if extraction silently degraded to one
  // key or none, the cells stop discriminating and every case passes empty.
  assert.ok(BASE_KEYS.includes('XDG_STATE_HOME'), `state-root.ts no longer reads XDG_STATE_HOME (found ${BASE_KEYS.join(', ')})`);
  assert.ok(BASE_KEYS.includes('HOME'), `state-root.ts no longer reads HOME (found ${BASE_KEYS.join(', ')})`);
  assert.ok(
    TOOLCHAIN_KEYS.includes('TRAFFIC_ONE_TOOLCHAIN_ROOT'),
    `toolchain-paths.ts no longer reads TRAFFIC_ONE_TOOLCHAIN_ROOT (found ${TOOLCHAIN_KEYS.join(', ')})`,
  );
});

// ── the cell matrix ──────────────────────────────────────────────────────────

interface Cell {
  readonly label: string;
  readonly env: Record<string, string>;
}

// Every key any of the resolvers reads, so a cell that does not set a key has it
// genuinely UNSET rather than inherited (the suite's own preload pins
// XDG_STATE_HOME, which would otherwise decide every outcome).
const ALL_KEYS = [...new Set([...BASE_KEYS, ...TOOLCHAIN_KEYS, 'USERPROFILE'])];

/**
 * One cell per discovered key, each pointing that key at its own directory.
 *
 * Deliberately key-AGNOSTIC: the value is always a fresh absolute directory, so
 * a key nobody has written yet gets a cell with no code change here. That is the
 * whole mechanism — a precedence step at the base grows the matrix by itself.
 */
function cells(root: string, keys: readonly string[]): Cell[] {
  const home = path.join(root, 'home');
  const out: Cell[] = [{ label: 'HOME only (the shipped default)', env: { HOME: home } }];
  for (const key of keys) {
    out.push({
      label: `${key} set`,
      env: key === 'HOME'
        ? { HOME: path.join(root, 'cell-HOME') }
        : { HOME: home, [key]: path.join(root, `cell-${key}`) },
    });
  }
  return out;
}

// stableBinDir()/toolchainRoot() read process.env directly (no env parameter), so
// a cell has to be installed on the process to ask them about it.
function withProcessEnv<T>(env: Record<string, string>, body: () => T): T {
  const saved = ALL_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of ALL_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The child's environment: PATH (both launchers start with `node`) plus the cell,
// and nothing else this suite injected.
function childEnv(cell: Cell): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', ...cell.env };
}

// A stand-in for the real shim that reports WHICH copy of itself ran.
function writeMarker(file: string, tag: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `process.stdout.write(JSON.stringify({tag:${JSON.stringify(tag)},file:require('fs').realpathSync(__filename)}));\n`,
    'utf8',
  );
  return fs.realpathSync(file);
}

// Compared through realpath on BOTH sides, after creating each: on macOS
// os.tmpdir() is a /var symlink to /private/var, so comparing a realpath against
// a merely resolved path reports two spellings of ONE directory as different —
// and the decoy below would then be written over the marker, failing every case
// with the two identical paths printed side by side.
function sameDir(left: string, right: string): boolean {
  fs.mkdirSync(left, { recursive: true });
  fs.mkdirSync(right, { recursive: true });
  return fs.realpathSync(left) === fs.realpathSync(right);
}

interface MarkerReport { tag: string; file: string }

function parseMarker(stdout: string, context: string): MarkerReport {
  try {
    return JSON.parse(stdout) as MarkerReport;
  } catch {
    throw new Error(`${context}: launcher produced no marker report; stdout was ${JSON.stringify(stdout)}`);
  }
}

// ── the MCP bootstrap: owes consistency to the BASE ──────────────────────────

// Its fallback is `<base>/bin/opencode-mcp.cjs` and its `<base>` is
// globalTrafficOneDir's expression, verbatim. Note it mirrors ONLY the base —
// TRAFFIC_ONE_TOOLCHAIN_ROOT is deliberately absent from it — so the matrix here
// is the base's keys and no more.
test('the opencode-worker bootstrap resolves the state root the shared base resolves, per discovered key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}mcp-`));
  try {
    const entry = openCodeMcpServerEntry(PLUGIN_ROOT_ENV_KEYS);
    const matrix = cells(root, BASE_KEYS);
    const baseline = globalTrafficOneDir(matrix[0]!.env as NodeJS.ProcessEnv);
    const discriminating: string[] = [];

    for (const cell of matrix) {
      const expectedBase = globalTrafficOneDir(cell.env as NodeJS.ProcessEnv);
      assert.ok(path.isAbsolute(expectedBase), `${cell.label}: the base resolved a relative path, so the fixture below is meaningless`);
      if (cell !== matrix[0]) {
        // A cell whose key does not move the base cannot detect anything. Recorded
        // rather than silently passing, and asserted on as a set below.
        if (expectedBase !== baseline) discriminating.push(cell.label);
      }

      const markerDir = path.join(expectedBase, 'bin');
      const marker = writeMarker(path.join(markerDir, MCP_SHIM), 'derived');
      // A decoy wherever the pre-step base would have been, so a launcher that
      // ignored the cell reports the wrong file instead of merely failing.
      const decoyDir = path.join(cell.env.HOME as string, '.traffic-one', 'bin');
      if (!sameDir(markerDir, decoyDir)) {
        const decoy = writeMarker(path.join(decoyDir, MCP_SHIM), 'decoy');
        assert.ok(fs.existsSync(decoy), `${cell.label}: the decoy was not written, so a miss could pass as a fail-to-launch`);
      }

      const result = spawnSync(entry.command, [...entry.args], {
        cwd: root,
        encoding: 'utf8',
        env: childEnv(cell),
      });
      assert.equal(result.status, 0, `${cell.label}: ${result.stderr}`);
      const report = parseMarker(result.stdout, cell.label);
      assert.equal(report.tag, 'derived', `${cell.label}: the bootstrap loaded the decoy at ${report.file}, not ${marker}`);
      assert.equal(report.file, marker, `${cell.label}: the bootstrap resolved ${report.file}, the base resolves ${marker}`);
    }

    assert.equal(
      discriminating.length,
      BASE_KEYS.length,
      `only ${discriminating.length} of ${BASE_KEYS.length} discovered keys moved the base (${discriminating.join(', ')})`
        + ' — a key that does not move the base cannot detect a launcher that ignores it',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('with nothing at the derived location the opencode-worker bootstrap FAILS — the case above is not satisfied by luck', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}mcp-empty-`));
  try {
    const entry = openCodeMcpServerEntry(PLUGIN_ROOT_ENV_KEYS);
    const cell: Cell = { label: 'nothing written', env: { HOME: path.join(root, 'home') } };
    fs.mkdirSync(cell.env.HOME as string, { recursive: true });
    const result = spawnSync(entry.command, [...entry.args], { cwd: root, encoding: 'utf8', env: childEnv(cell) });
    assert.equal(result.status, 1, 'a bootstrap that finds no shim must exit non-zero');
    assert.match(result.stderr, /server script not found in plugin roots or stable bin/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the Windsurf launcher: owes consistency to TWO sources ───────────────────

function runWindsurf(cell: Cell, command: string): MarkerReport {
  const result = spawnSync(command, {
    cwd: cell.env.HOME as string,
    encoding: 'utf8',
    env: childEnv(cell),
    shell: true,
  });
  assert.equal(result.status, 0, `${cell.label}: ${result.stderr}`);
  return parseMarker(result.stdout, cell.label);
}

// The harder copy: its bytes are COMMITTED into the user's repository, so a stale
// spelling strands every teammate who clones rather than one machine. Its tail is
// the base verbatim, nested inside a mirror of stableBinDir()'s composition — so
// the expectation is stableBinDir() ITSELF, called under each cell. That covers
// both obligations at once: a precedence step at the base moves it (through
// toolchainRoot), and a change to stableBinDir's own composition moves it directly.
test('the committed Windsurf launcher resolves the shim dir stableBinDir composes, per discovered key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}windsurf-`));
  try {
    const command = windsurfWorkspaceHookCommand('pre_run_command');
    const matrix = cells(root, [...new Set([...BASE_KEYS, ...TOOLCHAIN_KEYS])]);
    const baseline = withProcessEnv(matrix[0]!.env, stableBinDir);
    const discriminating: string[] = [];

    for (const cell of matrix) {
      const expectedBinDir = withProcessEnv(cell.env, stableBinDir);
      const fallbackBinDir = withProcessEnv(cell.env, documentedBinDir);
      assert.ok(path.isAbsolute(expectedBinDir), `${cell.label}: stableBinDir returned a relative path`);
      if (cell !== matrix[0] && expectedBinDir !== baseline) discriminating.push(cell.label);

      fs.mkdirSync(cell.env.HOME as string, { recursive: true });
      const marker = writeMarker(path.join(expectedBinDir, WINDSURF_SHIM), 'derived');
      // The documented fallback is a real candidate in this launcher, so a decoy
      // there is what turns "resolved the wrong dir" into a visible wrong answer
      // instead of a require() failure.
      if (!sameDir(expectedBinDir, fallbackBinDir)) {
        const decoy = writeMarker(path.join(fallbackBinDir, WINDSURF_SHIM), 'decoy');
        assert.ok(fs.existsSync(decoy), `${cell.label}: the decoy was not written`);
      }

      const report = runWindsurf(cell, command);
      assert.equal(report.tag, 'derived', `${cell.label}: the launcher loaded the decoy at ${report.file}, not ${marker}`);
      assert.equal(report.file, marker, `${cell.label}: the launcher resolved ${report.file}, stableBinDir composes ${marker}`);
    }

    assert.ok(
      discriminating.length >= BASE_KEYS.length + TOOLCHAIN_KEYS.length - 1,
      `only ${discriminating.length} cells moved stableBinDir (${discriminating.join(', ')}) — the rest cannot detect a launcher that ignores them`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the constraints the emitted strings must never lose ──────────────────────

// Re-asserted here, next to the derivation that will keep editing these strings:
// the Windsurf command is embedded in ONE double-quoted shell argument that has
// to survive `sh -c` and `cmd /c`, and the array that builds it is joined with NO
// separator — so a `//` line comment placed among its elements would comment out
// every element after it, silently, while the string still parsed.
test('both emitted launchers stay shell-inert, comment-free, and syntactically whole', () => {
  const windsurf = windsurfWorkspaceHookCommand('pre_run_command');
  const inner = /^node -e "(.*)" [^"]*$/.exec(windsurf)?.[1];
  assert.ok(inner, 'the Windsurf launcher must be one double-quoted node -e argument');
  for (const meta of ['"', '\\', '$', '`', '|', '&', '<', '>', '%', '!', '\n', '\r']) {
    assert.equal(inner.includes(meta), false, `the Windsurf launcher must not contain ${JSON.stringify(meta)}`);
  }

  const mcp = openCodeMcpServerEntry(PLUGIN_ROOT_ENV_KEYS).args[1] as string;
  for (const [label, source, tail] of [
    ['windsurf', inner, /require\(p\.join\(t,n\)\);$/],
    ['opencode-mcp', mcp, /require\(target\);$/],
  ] as const) {
    assert.equal(source.includes('//'), false, `a line comment leaked into the joined ${label} launcher`);
    assert.equal(source.includes('/*'), false, `a block comment leaked into the joined ${label} launcher`);
    assert.equal(source.includes('\n'), false, `the joined ${label} launcher must be one line`);
    assert.doesNotThrow(() => new vm.Script(source), `the joined ${label} launcher is not valid JavaScript`);
    // The LAST statement, which the cases above could not see the loss of: an
    // element dropped or commented out after the resolution would leave a
    // launcher that computes a path and never loads it. A `//` among the array
    // elements does exactly that and still parses.
    assert.match(source, tail, `the ${label} launcher no longer ends in a require of the resolved path`);
  }
});

// ── the seventh copy: named, not half-closed ─────────────────────────────────

// A NEW inlined copy of the base, in a file that did not exist when this test was
// written, is not closable by a test — and the approximation is worse than
// nothing, so none is built here.
//
// The only mechanism available is a source scan for the expression's shape, and
// this repository already contains the idiom that defeats it: probes-toolchain.ts
// builds the directory name as `'.traffic' + '-one'`. A scanner strict enough to
// pass today's tree cannot see a copy spelled that way, and one loose enough to
// see it flags prose. Registering launchers in a list would not help either — the
// failure mode is a contributor who does not know the list exists, which is the
// same contributor who does not know this file exists.
//
// So what IS enforced is bounded and stated: the two launchers named above track
// their sources of truth. Closing the general case needs a lint rule over the
// AST at review time, not a test in the suite — recorded here so the gap is
// visible rather than assumed closed.
test('the enforced set is exactly the two launchers that cannot import the base', () => {
  // A cheap floor under the claim above: both launchers really do carry the
  // base's spelling inline (i.e. this file is testing inlined copies, not
  // importers that would be covered by state-root.test.ts instead).
  for (const [label, source] of [
    ['windsurf-hook-command.ts', 'src/shared/windsurf-hook-command.ts'],
    ['opencode-mcp.ts', 'src/config/opencode-mcp.ts'],
  ] as const) {
    const text = fs.readFileSync(path.join(REPO_ROOT, source), 'utf8');
    assert.doesNotMatch(
      text,
      /from '\.\.?\/(?:\.\.\/)*(?:shared\/)?state-root'/,
      `${label} now imports the base — move its coverage to state-root.test.ts and drop it here`,
    );
    for (const key of BASE_KEYS) {
      assert.ok(text.includes(key), `${label} no longer mentions ${key}, which the base reads`);
    }
  }
});
