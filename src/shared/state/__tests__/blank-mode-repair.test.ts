import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeState, readState, writeState } from '../normalize';
import { isExistingProjectMode, isNewProjectMode, canonicalProjectMode } from '../lifecycle';

// `normalizeState` decided the mode with a truthiness test, and `' '` is truthy.
// An absent, empty or null mode was repaired to `new-project`; a whitespace-only
// one survived materialization untouched and read as NEITHER new nor existing —
// both predicates normalize, and neither answer matches — for the life of the
// project. These tests pin the repair AND its edges, because the same
// normalization is what a PLANTED state file passes through.

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-blank-mode-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  try { fn(dir); } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function published(cwd: string, state: Record<string, unknown>): Record<string, unknown> {
  assert.equal(writeState(cwd, state), true, 'the fixture must actually publish');
  return readState(cwd) as Record<string, unknown>;
}

function baseState(mode: unknown): Record<string, unknown> {
  return { mode, stack: 'default', frontend: 'react-vite', backend: 'supabase' } as Record<string, unknown>;
}

/**
 * The one clock `normalizeState` stamps, supplied by the fixture instead.
 *
 * `stateTimestamp()` deliberately drops milliseconds (state/io.ts keeps the
 * legacy `2026-05-27T12:00:00Z` shape), so two publishes taken microseconds
 * apart carry DIFFERENT stamps whenever a second boundary happens to fall
 * between them. The byte-identity row below publishes twice, so it was decided
 * by that coin flip roughly once per second of wall clock spent between the two
 * writes — observed failing at `confirmedAt` 09:35:19 against 09:35:20 inside
 * the full suite, and passing every time in isolation, where the two writes are
 * microseconds apart and almost never straddle a boundary.
 *
 * Pinning it removes the nondeterminism from the INPUT rather than excluding
 * the field from the comparison: the assertion stays a whole-file byte
 * equality, which is the claim the row is named for. `normalizeState` only
 * stamps when the field is absent (`if (!s.confirmedAt)`), and the row asserts
 * below that this value survived — so a future change that re-stamps
 * unconditionally reddens the row instead of quietly making it a coin flip
 * again.
 */
const PINNED_CONFIRMED_AT = '2026-05-27T12:00:00Z';

test('a whitespace-only mode is blank, and is repaired like every other blank spelling', () => {
  withProject((cwd) => {
    const state = published(cwd, baseState('   '));
    assert.equal(state.mode, 'new-project');
    assert.equal(isNewProjectMode(state), true);
  });
});

test('the repaired file is byte-identical to one that simply said new-project', () => {
  // The planted-state question, answered directly: the trim hands a hostile
  // `.one.json` NOTHING it could not claim more simply by writing the mode out.
  // A file spelling the mode `'  '` and a file spelling it `new-project` now
  // publish the same bytes — so the claim SET is unchanged, and only the
  // spelling that used to fall outside it now lands inside it.
  withProject((cwd) => {
    const blankState = published(cwd, { ...baseState(' \t '), confirmedAt: PINNED_CONFIRMED_AT });
    const blank = JSON.stringify(blankState);
    fs.rmSync(path.join(cwd, '.traffic-one', '.one.json'));
    const declaredState = published(cwd, { ...baseState('new-project'), confirmedAt: PINNED_CONFIRMED_AT });
    const declared = JSON.stringify(declaredState);
    // The premise of the equality, checked rather than assumed: if the publish
    // ever starts re-stamping `confirmedAt`, these bytes stop being comparable
    // and the row must say so here instead of failing at a second boundary.
    assert.equal(blankState.confirmedAt, PINNED_CONFIRMED_AT, 'the publish must not re-stamp a supplied confirmedAt');
    assert.equal(declaredState.confirmedAt, PINNED_CONFIRMED_AT, 'nor on the declared-mode publish');
    assert.equal(blank, declared);
  });
});

test('a whitespace-only mode previously read as NEITHER new nor existing', () => {
  // The condition being repaired, stated as the two predicates saw it.
  assert.equal(isNewProjectMode({ mode: '   ' }), false);
  assert.equal(isExistingProjectMode({ mode: '   ' }), false);
  assert.equal(canonicalProjectMode('   '), '');
});

// ── The edges: what the trim must NOT change ─────────────────────────────────

test('a padded but non-blank mode is left exactly as written', () => {
  // The trim repairs blank-ish modes; it does not canonicalize. ` New-Project `
  // already reads as new-project through the predicates, so rewriting it here
  // would be a second, unrelated change riding along.
  withProject((cwd) => {
    const state = published(cwd, baseState(' New-Project '));
    assert.equal(state.mode, ' New-Project ', 'the value survives verbatim');
    assert.equal(isNewProjectMode(state), true);
  });
});

test('an existing-codebase mode is never repaired into new-project', () => {
  withProject((cwd) => {
    const state = published(cwd, baseState(' Existing-Codebase '));
    assert.equal(state.mode, ' Existing-Codebase ');
    assert.equal(isExistingProjectMode(state), true);
    assert.equal(isNewProjectMode(state), false);
  });
});

test('a non-string mode is untouched, exactly as before', () => {
  // `modeBlank` falls back to the original `!s.mode` for anything that is not a
  // string, so numbers, objects and `false` keep whatever answer they had.
  for (const mode of [5, { a: 1 }, ['x'], true]) {
    const state: Record<string, unknown> = { ...baseState(mode), stack: 'default' };
    normalizeState(state, 'new-project');
    assert.deepEqual(state.mode, mode, `a ${typeof mode} mode is not a blank mode`);
  }
});

test('null / missing / empty modes still take the default, unchanged', () => {
  for (const mode of [undefined, null, '']) {
    const state: Record<string, unknown> = { ...baseState(mode), stack: 'default' };
    normalizeState(state, 'existing-codebase');
    assert.equal(state.mode, 'existing-codebase');
  }
});

test('a whitespace-only DEFAULT is not written over a blank mode', () => {
  // Most callers spell the default `state.mode || detectMode(cwd)`, so a
  // whitespace mode arrives as its own replacement. Repairing to it would leave
  // the file exactly as broken while reporting `changed` on every call.
  const state: Record<string, unknown> = { ...baseState(undefined), stack: 'default' };
  normalizeState(state, '  ');
  assert.equal(state.mode, undefined, 'blank in, blank out — never whitespace stamped as a mode');
});

test('the publish funnel heals a whitespace mode even when the caller normalized it in memory first', () => {
  // writeState derives its own default from the TRIMMED mode, so the on-disk
  // value is repaired whichever in-memory route the caller took.
  withProject((cwd) => {
    const state = baseState(' ');
    normalizeState(state, (state.mode as string) || 'new-project');
    assert.equal(state.mode, ' ', 'the caller-side normalize legitimately declines a blank default');
    assert.equal(published(cwd, state).mode, 'new-project');
  });
});
