import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { bootstrap, ensureGraphifyTool, graphifyGraphIsEmpty } from '../index';
import { toolInstallSpec, toolRuntime } from '../../toolchain';
import { runtimeMissingMessage } from '../../../shared/runtime-resolve';

const EMPTY_GRAPH = JSON.stringify({ directed: false, multigraph: false, graph: {}, nodes: [], links: [], hyperedges: [] });
const POPULATED_GRAPH = JSON.stringify({ directed: false, multigraph: false, graph: {}, nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b' }] });

function writeGraphifyOut(cwd: string, files: Record<string, string>): void {
  const out = path.join(cwd, '.traffic-one', 'graphify-out');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(out, name), body, 'utf8');
}

// A current bare-PATH graphify stub whose `update` subcommand prints to
// stdout/stderr and exits with `code`.
function stubGraphify(cwd: string, body: { stdout?: string; stderr?: string; code: number }): string {
  const bin = path.join(cwd, 'gbin');
  fs.mkdirSync(bin, { recursive: true });
  const out = body.stdout ? `echo ${JSON.stringify(body.stdout)}` : ':';
  const err = body.stderr ? `echo ${JSON.stringify(body.stderr)} >&2` : ':';
  fs.writeFileSync(
    path.join(bin, 'graphify'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "graphify 0.9.13"; exit 0; fi\nif [ "$1" = "update" ]; then ${out}; ${err}; exit ${body.code}; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  return bin;
}

function withProject(fn: (cwd: string, prefs: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gfboot-'));
  const saved = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const savedRoot = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  const prefs = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
  process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed-tools');
  try {
    fn(dir, prefs);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved;
    if (savedRoot === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('graphify installs the LATEST graphifyy (unpinned, no ==<recommended>)', () => {
  // The runner now targets latest via the shared toolchain contract. graphify is
  // flagged installLatest with pipxPackage `graphifyy`, so the spec is the bare
  // package name — never a `graphifyy==<recommended>` pin.
  const spec = toolInstallSpec('graphify');
  assert.equal(spec, 'graphifyy');
  assert.equal(spec?.includes('=='), false);
});

test('graphify declares the python >=3.10 runtime requirement', () => {
  const { runtime, minMajor, minMinor } = toolRuntime('graphify');
  assert.equal(runtime, 'python');
  assert.equal(minMajor, 3);
  assert.equal(minMinor, 10);
});

test('a missing >=3.10 python yields the beginner-friendly runtime message', () => {
  // When the resolver finds no satisfying interpreter (stock-macOS Python 3.9.6),
  // installWithManagedVenv returns this exact message — no raw pip output.
  const { minMajor, minMinor } = toolRuntime('graphify');
  const msg = runtimeMissingMessage('graphify', 'python', minMajor, minMinor);
  assert.match(msg, /graphify needs Python >=3\.10/);
  assert.match(msg, /none was found on this machine/);
  // Caller appends the prior pipx error verbatim under "pipx attempt:".
  const composed = msg + ` pipx attempt: \`pipx\` is not on PATH`;
  assert.match(composed, /pipx attempt: `pipx` is not on PATH/);
});

test('graphify bootstrap honours the graphifyAutoRun:false opt-out', () => {
  withProject((cwd, prefs) => {
    fs.writeFileSync(prefs, JSON.stringify({ graphifyAutoRun: false }), 'utf8');
    const r = bootstrap(cwd);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'install-skipped');
    assert.match(r.error || '', /graphifyAutoRun is false/);
  });
});

test('graphify bootstrap short-circuits on a fresh GRAPH_REPORT.md', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '# graph\n', 'utf8');
    const r = bootstrap(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh');
    assert.ok(r.report?.endsWith(path.join('graphify-out', 'GRAPH_REPORT.md')));
  });
});

test('graphifyGraphIsEmpty: true for a 0-node graph.json, false for populated/missing/unparseable', () => {
  withProject((cwd) => {
    // Missing graph.json → can't tell → NOT empty (don't force a needless rebuild).
    assert.equal(graphifyGraphIsEmpty(cwd), false);
    // Empty node-link document → empty.
    writeGraphifyOut(cwd, { 'graph.json': EMPTY_GRAPH });
    assert.equal(graphifyGraphIsEmpty(cwd), true);
    // Populated → not empty.
    writeGraphifyOut(cwd, { 'graph.json': POPULATED_GRAPH });
    assert.equal(graphifyGraphIsEmpty(cwd), false);
    // Unparseable → can't tell → NOT empty (matches gitnexus catch behaviour).
    writeGraphifyOut(cwd, { 'graph.json': '{ not valid json' });
    assert.equal(graphifyGraphIsEmpty(cwd), false);
    // >64KB → far too large to be an empty (~110-byte) graph → NOT empty without
    // parsing (keeps the freshness fast-path cheap; never misreads a real graph).
    writeGraphifyOut(cwd, { 'graph.json': JSON.stringify({ graph: { pad: 'x'.repeat(70 * 1024) }, nodes: [], links: [] }) });
    assert.equal(graphifyGraphIsEmpty(cwd), false);
  });
});

test('graphify bootstrap does NOT short-circuit a fresh-but-EMPTY graph (forces rebuild)', () => {
  withProject((cwd) => {
    // Fresh report mtime + 0-node graph.json = the frozen onboarding scan. The
    // 7-day window alone would call this "fresh"; the empty-guard must defeat it.
    writeGraphifyOut(cwd, { 'GRAPH_REPORT.md': '# graph\n', 'graph.json': EMPTY_GRAPH });
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin'); // graphify absent → deterministic
    try {
      const r = bootstrap(cwd, { skipInstall: true });
      assert.notEqual(r.action, 'fresh'); // empty-guard defeated the 7-day window
      assert.equal(r.action, 'install-skipped'); // proceeded past the short-circuit to ensure
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('graphify bootstrap still short-circuits fresh when graph.json has nodes', () => {
  withProject((cwd) => {
    writeGraphifyOut(cwd, { 'GRAPH_REPORT.md': '# graph\n', 'graph.json': POPULATED_GRAPH });
    const r = bootstrap(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh'); // non-empty fresh graph is left alone
  });
});

test('graphify bootstrap does NOT short-circuit when a source file is newer than the index (stale → rebuild)', () => {
  withProject((cwd) => {
    // Non-empty, mtime-fresh report, but a project source file landed AFTER it
    // (fix-cycle / post-index edit) — the index is stale and must rebuild.
    writeGraphifyOut(cwd, { 'GRAPH_REPORT.md': '# graph\n', 'graph.json': POPULATED_GRAPH });
    const reportPath = path.join(cwd, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md');
    const reportSec = Math.floor(fs.statSync(reportPath).mtimeMs / 1000);
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'late.ts'), 'export const x = 1;\n', 'utf8');
    fs.utimesSync(path.join(cwd, 'src', 'late.ts'), reportSec + 60, reportSec + 60); // newer than the index
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin'); // graphify absent → deterministic
    try {
      const r = bootstrap(cwd, { skipInstall: true });
      assert.notEqual(r.action, 'fresh'); // staleness defeated the 7-day window
      assert.equal(r.action, 'install-skipped'); // proceeded past the short-circuit
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('graphify bootstrap SWEEPS a stray root graphify-out/ when the scan exits non-zero (no root pollution; good graph preserved)', () => {
  withProject((cwd) => {
    // Pre-existing GOOD graph under .traffic-one (must survive the failed re-scan).
    writeGraphifyOut(cwd, { 'GRAPH_REPORT.md': '# graph\n', 'graph.json': POPULATED_GRAPH });
    // Stub graphify on PATH that writes a PARTIAL root graphify-out/cache then exits
    // NON-ZERO (graphify's "Nothing to update or rebuild failed"). The current
    // PATH binary reports its version, so bootstrap runs it directly. The fix
    // must sweep the stray root output.
    const bin = path.join(cwd, 'gbin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'graphify'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "graphify 0.9.13"; exit 0; fi\nif [ "$1" = "update" ]; then mkdir -p graphify-out/cache; echo "Nothing to update or rebuild failed" >&2; exit 1; fi\nexit 0\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = bootstrap(cwd, { force: true }); // force → skip fresh short-circuit → run the stub
      assert.equal(r.ok, false); // graphify exited non-zero
      assert.equal(fs.existsSync(path.join(cwd, 'graphify-out')), false, 'stray root graphify-out/ swept');
      assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'graphify-out', 'graph.json')), 'good relocated graph preserved');
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('a "No code files found" failure becomes a graceful skip, not an alarming graphifyLastError', () => {
  withProject((cwd, prefs) => {
    // graphify 0.8.x prints the real cause to STDOUT and only the opaque summary to
    // STDERR. An all-source-ignored / empty project is not a tool failure.
    const bin = stubGraphify(cwd, {
      stdout: '[graphify watch] No code files found - nothing to rebuild.',
      stderr: 'Nothing to update or rebuild failed — check output above.',
      code: 1,
    });
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = bootstrap(cwd, { force: true });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'install-skipped');
      assert.match(r.error || '', /no source files to index/);
      // The scary error must NOT be persisted for a benign no-source case.
      const saved = JSON.parse(fs.readFileSync(prefs, 'utf8'));
      assert.equal(saved.graphifyLastError, undefined);
      assert.equal(saved.graphifyLastErrorAt, undefined);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('a "No code files found" emitted on STDERR is also a graceful skip (graphify uses either stream by path)', () => {
  withProject((cwd, prefs) => {
    // The non-watch update path emits the "no code files" line to STDERR, with the
    // opaque summary on stdout. The graceful-skip classification must match the
    // COMBINED output, not stdout alone, or this benign case reverts to a scary
    // graphifyLastError that doctor surfaces as LAST_RUN_FAILED.
    const bin = stubGraphify(cwd, {
      stdout: 'Nothing to update or rebuild failed — check output above.',
      stderr: 'No code files found - nothing to rebuild.',
      code: 1,
    });
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = bootstrap(cwd, { force: true });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'install-skipped');
      assert.match(r.error || '', /no source files to index/);
      const saved = JSON.parse(fs.readFileSync(prefs, 'utf8'));
      assert.equal(saved.graphifyLastError, undefined);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('a genuine graphify failure surfaces the STDOUT diagnostic, not just the opaque stderr summary', () => {
  withProject((cwd, prefs) => {
    // The real cause lives on stdout; stderr is the useless summary. graphifyLastError
    // must carry the stdout line so the failure is debuggable (regression lock).
    const bin = stubGraphify(cwd, {
      stdout: 'Rebuild failed: boom in extractor',
      stderr: 'Nothing to update or rebuild failed — check output above.',
      code: 1,
    });
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = bootstrap(cwd, { force: true });
      assert.equal(r.ok, false);
      assert.match(r.error || '', /Rebuild failed: boom in extractor/);
      const saved = JSON.parse(fs.readFileSync(prefs, 'utf8'));
      assert.match(saved.graphifyLastError || '', /Rebuild failed: boom in extractor/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('a project whose .gitignore covers all source still produces a graph (degenerate seed dropped)', () => {
  withProject((cwd) => {
    // Source lives under src/, and the project .gitignore ignores src/ — seeding that
    // into .graphifyignore would make graphify scan zero files ("No code files found").
    // The degenerate-seed guard must drop the seed so the scan still sees the source.
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'src/\n', 'utf8');
    // Stub graphify that HONORS .graphifyignore: if it would exclude src, exit 1 with
    // graphify's "No code files found"; otherwise write the graph and exit 0.
    const bin = path.join(cwd, 'gbin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'graphify'),
      '#!/bin/sh\n'
      + 'if [ "$1" = "--version" ]; then echo "graphify 0.9.13"; exit 0; fi\n'
      + 'if [ "$1" = "update" ]; then\n'
      + '  if grep -qE "^src/?$" .graphifyignore 2>/dev/null; then echo "No code files found - nothing to rebuild."; exit 1; fi\n'
      + '  mkdir -p graphify-out; printf "{\\"nodes\\":[{\\"id\\":\\"a\\"}],\\"links\\":[]}" > graphify-out/graph.json; printf "# graph\\n" > graphify-out/GRAPH_REPORT.md; exit 0\n'
      + 'fi\nexit 0\n',
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = bootstrap(cwd, { force: true });
      assert.equal(r.ok, true, 'scan succeeds because the source-hiding seed was dropped');
      assert.ok(r.report?.endsWith(path.join('graphify-out', 'GRAPH_REPORT.md')));
      assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'graphify-out', 'graph.json')), 'graph relocated under .traffic-one');
      assert.equal(fs.existsSync(path.join(cwd, '.graphifyignore')), false, 'scoped ignore removed after the scan');
      assert.equal(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'), 'src/\n', '.gitignore untouched');
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('graphify bootstrap returns install-skipped when graphify is absent + skipInstall', () => {
  withProject((cwd) => {
    // Force the "not on PATH" branch deterministically by pointing PATH at an
    // empty dir, so which('graphify') fails regardless of the host machine.
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin');
    try {
      const r = bootstrap(cwd, { skipInstall: true });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'install-skipped');
      assert.match(r.error || '', /missing or below the minimum supported version and skipInstall=true/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

test('an unversioned PATH graphify is not assumed current', () => {
  withProject((cwd) => {
    const bin = path.join(cwd, 'unknown-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'graphify'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const result = ensureGraphifyTool(cwd, { skipInstall: true });
      assert.equal(result.ok, false);
      assert.match(result.error || '', /missing or below the minimum supported version/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});

test('graphify ensure falls back to a managed venv without pip --user', () => {
  withProject((cwd, prefs) => {
    // Stub a python3.12 (a name the resolver probes for a >=3.10 interpreter
    // before the generic python3) that answers the version probe with a
    // satisfying version and fakes `-m venv`. The venv python it drops answers
    // the best-effort `pip install --upgrade pip` (no-op exit 0) and, on the
    // graphifyy install, drops a graphify bin. pipx is absent on PATH, so the
    // installer must take the managed-venv path — never `pip install --user`.
    const bin = path.join(cwd, 'bin');
    const log = path.join(cwd, 'python-args.log');
    fs.mkdirSync(bin, { recursive: true });
    const pyStub = `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  -c) echo "3.12"; exit 0 ;;
esac
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  cat > "$venv/bin/python" <<'PY'
#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  # Best-effort pip self-upgrade: no-op success, drop no graphify bin.
  if [ "$4" = "pip" ]; then exit 0; fi
  dir=$(dirname "$0")
  cat > "$dir/graphify" <<'G'
#!/bin/sh
exit 0
G
  chmod +x "$dir/graphify"
  exit 0
fi
exit 1
PY
  chmod +x "$venv/bin/python"
  exit 0
fi
exit 1
`;
    // The resolver probes for an explicit minor name (python3.12) ahead of the
    // generic python3; provide both so `which('python3.12')` resolves the stub.
    fs.writeFileSync(path.join(bin, 'python3.12'), pyStub, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'python3'), pyStub, { mode: 0o755 });

    const savedPath = process.env.PATH;
    process.env.PATH = [bin, '/bin', '/usr/bin'].join(path.delimiter);
    try {
      const r = ensureGraphifyTool(cwd);
      assert.equal(r.ok, true);
      assert.equal(r.action, 'installed-venv');
      assert.equal(r.installedVersion, '0.9.13');
      assert.ok(r.binPath?.includes(path.join('graphify', 'venv', 'bin', 'graphify')));
      const logged = fs.readFileSync(log, 'utf8');
      assert.equal(logged.includes('--user'), false);
      // pip was upgraded inside the venv before the graphifyy install.
      assert.match(logged, /-m pip install --upgrade pip --quiet/);
      const saved = JSON.parse(fs.readFileSync(prefs, 'utf8'));
      assert.equal(saved.toolchain?.graphify?.installedVersion, '0.9.13');
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});
