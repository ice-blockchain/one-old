// The workspace-root selector exists TWICE — src/adapters/cursor.ts and
// src/adapters/copilot.ts — because both hosts read the same `workspace_roots`
// list from their own flat payload. Nothing in the language makes the two copies
// agree, so this file is what does, on the pattern
// src/shared/__tests__/launcher-state-root.test.ts established for the two
// `node -e` copies of the machine-state-root expression: pin the copies
// TEXTUALLY (so a fix applied to one is applied to both) and BEHAVIOURALLY (so a
// textual match that somehow diverges in effect still fails).
//
// Unlike those launchers, these two CAN import a shared helper — every adapter
// already imports ./coerce — so the duplication here is provisional, not
// principled. If the block is ever extracted, delete the textual half of this
// file and keep the behavioural half.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCursorAdapter } from '../cursor';
import { makeCopilotAdapter } from '../copilot';

const ADAPTERS = path.join(__dirname, '..');
const BEGIN = '// T1SHARED:workspace-root — byte-identical';
const END = '// T1SHARED:workspace-root END';

function sharedBlock(file: string): string {
  const source = fs.readFileSync(path.join(ADAPTERS, file), 'utf8');
  const start = source.indexOf(BEGIN);
  const stop = source.indexOf(END);
  assert.notEqual(start, -1, `${file} must carry the ${BEGIN.trim()} marker`);
  assert.notEqual(stop, -1, `${file} must carry the ${END} marker`);
  assert.ok(stop > start, `${file} markers must be in order`);
  return source.slice(start, stop);
}

test('workspace-root selector: the two copies are byte-identical', () => {
  const cursor = sharedBlock('cursor.ts');
  const copilot = sharedBlock('copilot.ts');
  // Non-vacuity: the block must actually contain the selector, not just markers.
  assert.match(cursor, /function activeWorkspaceRoot\(/);
  assert.match(cursor, /function workspaceRootList\(/);
  assert.equal(cursor, copilot,
    'cursor.ts and copilot.ts must carry the SAME workspace-root selector — fix both or extract it');
});

// Behavioural parity, driven through each adapter's real parse() on the one
// subcommand both hosts spell identically. `cwd` is echoed too because the
// selected root feeds cursorCwd/copilotCwd, which are themselves copies.
const CASES: Array<{ name: string; payload: Record<string, unknown>; root: string | undefined; cwd: string }> = [
  {
    name: 'single root, cwd inside it',
    payload: { workspace_roots: ['/w/alpha'], cwd: '/w/alpha/src' },
    root: '/w/alpha',
    cwd: '/w/alpha/src',
  },
  {
    name: 'multi-root, cwd in the SECOND folder',
    payload: { workspace_roots: ['/w/alpha', '/w/beta'], cwd: '/w/beta/src' },
    root: '/w/beta',
    cwd: '/w/beta/src',
  },
  {
    name: 'multi-root, cwd in the FIRST folder',
    payload: { workspace_roots: ['/w/alpha', '/w/beta'], cwd: '/w/alpha' },
    root: '/w/alpha',
    cwd: '/w/alpha',
  },
  {
    name: 'nested roots pick the OUTERMOST containing root',
    payload: { workspace_roots: ['/w/mono/packages/ui', '/w/mono'], cwd: '/w/mono/packages/ui/src' },
    root: '/w/mono',
    cwd: '/w/mono/packages/ui/src',
  },
  {
    name: 'no containing root falls back to the first element',
    payload: { workspace_roots: ['/w/alpha', '/w/beta'], cwd: '/Users/u/.cursor/projects/x/terminals' },
    root: '/w/alpha',
    cwd: '/w/alpha',
  },
  {
    name: 'sibling name prefix is not containment (/w/alpha vs /w/alpha2)',
    payload: { workspace_roots: ['/w/alpha', '/w/alpha2'], cwd: '/w/alpha2/src' },
    root: '/w/alpha2',
    cwd: '/w/alpha2/src',
  },
  {
    name: 'file:// and object elements normalize before matching',
    payload: { workspace_roots: [{ path: 'file:///w/alpha' }, 'file:///w/beta'], cwd: '/w/beta/src' },
    root: '/w/beta',
    cwd: '/w/beta/src',
  },
  {
    // The selector must key on where the agent IS, not on what it is pointing at.
    // A ceiling derived from the tool's target would by construction contain that
    // target, so workspaceBoundaryGuard — whose whole job is to ask whether the
    // target is inside the active workspace — could never refuse anything.
    name: 'the ceiling follows the cwd, never the tool target',
    payload: { workspace_roots: ['/w/alpha', '/w/beta'], cwd: '/w/alpha/src', file_path: '/w/beta/x.ts' },
    root: '/w/alpha',
    cwd: '/w/alpha/src',
  },
  {
    name: 'a relative root can never be selected as a ceiling',
    payload: { workspace_roots: ['relative/proj'], cwd: '/w/beta' },
    root: undefined,
    cwd: '/w/beta',
  },
  {
    name: 'no workspace_roots at all leaves the boundary unset',
    payload: { cwd: '/w/beta' },
    root: undefined,
    cwd: '/w/beta',
  },
];

test('workspace-root selector: cursor and copilot agree on every case', () => {
  const cursor = makeCursorAdapter();
  const copilot = makeCopilotAdapter('cli');
  for (const c of CASES) {
    const stdin = JSON.stringify(c.payload);
    const fromCursor = cursor.parse({ stdin, argv: ['node', 'cursor-hook-runtime', 'session-start'] });
    const fromCopilot = copilot.parse({ stdin, argv: ['node', 'copilot-hook-runtime', 'session-start'] });
    assert.equal(fromCursor.workspaceRoot, c.root, `cursor workspaceRoot — ${c.name}`);
    assert.equal(fromCopilot.workspaceRoot, c.root, `copilot workspaceRoot — ${c.name}`);
    assert.equal(fromCursor.cwd, c.cwd, `cursor cwd — ${c.name}`);
    assert.equal(fromCopilot.cwd, c.cwd, `copilot cwd — ${c.name}`);
  }
});
