// The report-id mint against an ILLEGIBLE `.one.json`.
//
// createReportId is a one-field patch (`state[ONE_UID_FIELD] = id`) whose base
// came from readProjectState, and lib.ts writeProjectState then re-read the same
// file for preserveCurrentRunId/preserveOneMcpReportId. Both reads collapsed an
// unparseable or unreadable file to `{}`, so the mint published one key over the
// whole state — measured at 868 bytes and 18 keys in, 46 bytes and 1 key out,
// with the durable one-uid and the live currentRunId among the casualties and
// the two rescues that exist to prevent exactly that preserving nothing.
//
// Each test below is the mutation proof for one half of the fix: revert the
// `read.kind === 'corrupt' || read.kind === 'unreadable'` refusal in
// writeProjectState and the byte-identity assertions fail; revert createReportId's
// consumption of its boolean and the `unpersisted` assertions fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createReportId } from '../report-id-mint';
import { prepareReport } from '../prepareReport';
import { readProjectState } from '../lib';
import { STATE_FILE } from '../../../config/paths';
import { recordPluginUseChoice, resetPluginUseCache } from '../../../shared/state/plugin-use';
import { readState, writeState } from '../../../shared/state/normalize';

const TMP_PREFIX = 't1-w8a-illegible-';

// A realistic post-onboarding state: what a user actually loses.
const POPULATED = {
  version: 7,
  mode: 'existing-codebase',
  stack: 'default',
  confirmed: true,
  onboardingComplete: true,
  confirmedAt: '2026-08-01T09:00:00Z',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' },
  technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: ['react-native', 'expo'] },
  projectContext: 'Ecommerce storefront + admin console',
  supabaseAddons: { auth: 'approved', storage: 'skipped' },
  currentRunId: '1754500000000',
  'one-uid': '0197f0aa-1111-7abc-8def-0123456789ab',
};

interface Project {
  readonly cwd: string;
  readonly statePath: string;
}

/**
 * A consented project with a populated `.one.json`, its own XDG state home so
 * the recorded answer never touches the real machine dir.
 */
function withProject(body: (project: Project) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const savedXdg = process.env.XDG_STATE_HOME;
  const cwd = path.join(base, 'project');
  const statePath = path.join(cwd, STATE_FILE);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"shop"}\n', 'utf8');
  fs.writeFileSync(statePath, `${JSON.stringify(POPULATED, null, 2)}\n`, 'utf8');
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  resetPluginUseCache();
  recordPluginUseChoice(cwd, true, 'test');
  try {
    body({ cwd, statePath });
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
    resetPluginUseCache();
    // Restore access before the sweep: a 0000 file and a 0600 directory both
    // defeat rmSync, and a leaked fixture is the next lane's problem.
    try {
      fs.chmodSync(statePath, fs.lstatSync(statePath).isDirectory() ? 0o700 : 0o600);
    } catch { /* already gone */ }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** The errno a plain read of `filePath` produces, or 'OK' when it succeeds. */
function readErrno(filePath: string): string {
  try {
    fs.readFileSync(filePath, 'utf8');
    return 'OK';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown';
  }
}

/** Truncated bytes: the file READS fine and does not PARSE. */
function makeCorrupt(statePath: string): string {
  const full = fs.readFileSync(statePath, 'utf8');
  const torn = full.slice(0, Math.floor(full.length * 0.6));
  fs.writeFileSync(statePath, torn, 'utf8');
  // Fixture guard. Without it a fixture that quietly stayed parseable would let
  // every assertion below pass for the wrong reason.
  assert.equal(readErrno(statePath), 'OK', 'the corrupt fixture must still be READABLE');
  assert.throws(() => JSON.parse(fs.readFileSync(statePath, 'utf8')), SyntaxError,
    'the corrupt fixture must not parse');
  return torn;
}

/**
 * chmod 000: the file READS as EACCES and — unlike a directory at the path —
 * throws nothing on the write path, so an unfixed mint destroys it silently.
 *
 * The guard is not optional. root reads a 0000 file straight through, and this
 * whole test would then be measuring a perfectly legible file.
 */
function makeUnreadable(statePath: string): string {
  const before = fs.readFileSync(statePath, 'utf8');
  fs.chmodSync(statePath, 0o000);
  assert.equal(readErrno(statePath), 'EACCES',
    'the unreadable fixture must really be unreadable to THIS process (running as root?)');
  return before;
}

/** Read the bytes back regardless of mode, so the post-state can be seen. */
function bytesAfter(statePath: string): string {
  try {
    return fs.readFileSync(statePath, 'utf8');
  } catch {
    fs.chmodSync(statePath, 0o600);
    return fs.readFileSync(statePath, 'utf8');
  }
}

test('createReportId refuses to publish over an UNPARSEABLE .one.json', () => {
  withProject(({ cwd, statePath }) => {
    const torn = makeCorrupt(statePath);

    const minted = createReportId(cwd);

    assert.equal(fs.readFileSync(statePath, 'utf8'), torn,
      'the unparseable bytes are still on disk, byte for byte');
    assert.equal(minted.created, false, 'a refused write is not a created id');
    assert.equal(minted.unpersisted, true, 'and the caller is told the id is nowhere');
    assert.equal(fs.existsSync(`${statePath}.corrupt`), false,
      'nothing is quarantined: the bytes were never moved, so there is nothing to move them from');
  });
});

test('createReportId refuses to publish over an UNREADABLE .one.json (EACCES)', () => {
  withProject(({ cwd, statePath }) => {
    const before = makeUnreadable(statePath);

    const minted = createReportId(cwd);

    assert.equal(bytesAfter(statePath), before,
      'the unreadable bytes are still on disk, byte for byte');
    assert.equal(minted.created, false, 'a refused write is not a created id');
    assert.equal(minted.unpersisted, true, 'and the caller is told the id is nowhere');
  });
});

// A directory at the path is the OTHER unreadable errno, and it used to leave
// the mint by THROWING out of renameSync rather than returning. Pinned because a
// throw is what an outer catch turns into a generic 'error', and because the
// refusal must reach the caller by the same channel EACCES does.
test('createReportId refuses rather than throws when a DIRECTORY sits at .one.json (EISDIR)', () => {
  withProject(({ cwd, statePath }) => {
    fs.rmSync(statePath, { force: true });
    fs.mkdirSync(statePath, { recursive: true });
    fs.writeFileSync(path.join(statePath, 'sentinel'), 'bytes nobody can name\n', 'utf8');
    assert.equal(readErrno(statePath), 'EISDIR', 'the fixture must really be a directory');

    const minted = createReportId(cwd);

    assert.equal(minted.unpersisted, true, 'EISDIR reports through the same channel as EACCES');
    assert.deepEqual(fs.readdirSync(statePath), ['sentinel'], 'the directory is untouched');
  });
});

test('an unpersisted mint is reported to prepareReport instead of authorizing a report', () => {
  withProject(({ cwd, statePath }) => {
    const torn = makeCorrupt(statePath);

    const result = prepareReport(cwd, { featureEnabled: true, spawn: false });

    assert.deepEqual(result, { started: false, reason: 'unreadable-project-state' },
      'the mint refusal is the reported reason, not already-registered and not started');
    assert.equal(fs.readFileSync(statePath, 'utf8'), torn, 'and the state file is still the torn bytes');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'one-mcp-report.json')), false,
      'no status file is queued for an id that is nowhere on disk');
  });
});

// The load-bearing justification for REFUSING rather than quarantining here.
// state/normalize.ts quarantines and heals because its caller has a whole state
// to publish; this caller has one field. Refusing is only the better answer if
// the real healer still reaches the same file — so that is asserted, not assumed.
test('refusing leaves the corrupt state for writeState, which quarantines AND heals it', () => {
  withProject(({ cwd, statePath }) => {
    const torn = makeCorrupt(statePath);
    assert.equal(createReportId(cwd).unpersisted, true);

    const healed = writeState(cwd, { ...POPULATED, projectContext: 'healed by the canonical writer' });

    assert.equal(healed, true, 'the canonical writer publishes a complete state');
    assert.equal(fs.readFileSync(`${statePath}.corrupt`, 'utf8'), torn,
      'and preserves the torn bytes the mint declined to overwrite');
    assert.equal(readState(cwd).projectContext, 'healed by the canonical writer');
    assert.equal(readState(cwd).stack, 'default', 'the whole state is back, not one key');
  });
});

// The unfixed path was not merely lossy, it was doubly blind: readProjectState
// collapsed the file to `{}` for the caller's BASE, and writeProjectState's own
// re-read collapsed it again for the two preserve helpers. This pins the first
// half, which the fix deliberately does NOT change — the refusal lives at the
// write, where the destruction was.
test('readProjectState still answers {} for an illegible file — the refusal lives at the write', () => {
  withProject(({ cwd, statePath }) => {
    makeCorrupt(statePath);
    assert.deepEqual(readProjectState(cwd), {},
      'the read is unchanged; nothing downstream may treat this {} as a base to publish');
  });
});
