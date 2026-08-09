import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  clearPluginUseChoice,
  pluginUseDeclined,
  pluginUseEnabled,
  readPluginUseChoice,
  recordPluginUseChoice,
  removeDeclinedProjectArtifacts,
} from '../plugin-use';

/**
 * Run `fn` with stderr captured, handing BOTH the value and the text back.
 * Returned rather than assigned into an outer `let`: TypeScript cannot see that
 * a callback ran, so an outer binding stays narrowed to its initializer.
 */
function capturedStderr<T>(fn: () => T): { value: T; stderr: string } {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    return { value: fn(), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-plugin-use-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(path.join(dir, 'project'));
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('plugin-use choice: record → read → clear roundtrip, stored OUTSIDE the project', () => {
  withProject((cwd) => {
    fs.mkdirSync(cwd, { recursive: true });
    assert.equal(readPluginUseChoice(cwd), null);
    assert.equal(pluginUseDeclined(cwd), false);
    assert.equal(pluginUseEnabled(cwd), false);

    recordPluginUseChoice(cwd, false, 'command');
    assert.equal(pluginUseDeclined(cwd), true);
    assert.equal(pluginUseEnabled(cwd), false);
    assert.equal(readPluginUseChoice(cwd)?.enabled, false);
    assert.equal(readPluginUseChoice(cwd)?.source, 'command');
    // The choice never creates project files.
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false);

    recordPluginUseChoice(cwd, true, 'command');
    assert.equal(pluginUseDeclined(cwd), false);
    assert.equal(pluginUseEnabled(cwd), true);
    assert.equal(readPluginUseChoice(cwd)?.enabled, true);

    clearPluginUseChoice(cwd);
    assert.equal(readPluginUseChoice(cwd), null);
  });
});

test('decline sweeps a never-onboarded .traffic-one but preserves real onboarded state', () => {
  withProject((cwd) => {
    // Runtime junk only (once-markers) — swept on decline.
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', '.once'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', '.once', 'marker'), 'x', 'utf8');
    recordPluginUseChoice(cwd, false, 'command');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'runtime-only dir swept');

    // A mode-bearing .one.json is REAL state — never deleted by a decline.
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    removeDeclinedProjectArtifacts(cwd);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), true, 'onboarded state preserved');
  });
});

// Per-project prefs live OUTSIDE the repo, keyed by a hash of the directory — so a
// mis-resolved root leaves an INVISIBLE stray. Observed live: a Go package
// (`mercury/strategies`) accrued its own consent and completed wizard answers, with
// nothing in the repo to show for it.
test('consent is never recorded for a directory that belongs to an enclosing project', () => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-veto-')));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  try {
    const repo = path.join(container, 'mercury');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module mercury\n', 'utf8');
    const pkg = path.join(repo, 'strategies');
    fs.mkdirSync(pkg, { recursive: true });

    // Let the real hash-keyed path resolve so this exercises production behavior.
    delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;

    // The veto is correct and stays. What is asserted alongside it is that the
    // caller can now SEE it: this used to return `void`, so the wizard recorded
    // the user's answer, was told nothing, and asked again next session — and on
    // the decline path `removeDeclinedProjectArtifacts` has already run by then,
    // so the artifacts are gone AND the "no" is unrecorded.
    const vetoed = capturedStderr(() => recordPluginUseChoice(pkg, true, 'command'));
    assert.equal(readPluginUseChoice(pkg), null, 'a package inside a repo gets no prefs root');
    assert.equal(vetoed.value, false, 'and the caller is TOLD the answer did not land');
    assert.match(
      vetoed.stderr,
      /plugin-use: the "use" answer for .* was NOT recorded/,
      'fail-open, not fail-silent: the discarded answer names itself',
    );

    // WRITABLE BASELINE: the same call at the repo root records, and says so.
    const landed = capturedStderr(() => recordPluginUseChoice(repo, true, 'command'));
    assert.equal(readPluginUseChoice(repo)?.enabled, true, 'the repo root records consent');
    assert.equal(landed.value, true, 'a recorded answer reports true');
    assert.equal(landed.stderr, '', 'and says nothing — the diagnostic is for the anomaly only');
    clearPluginUseChoice(repo);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(container, { recursive: true, force: true });
  }
});
