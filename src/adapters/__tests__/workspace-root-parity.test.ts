// The workspace-root selector used to exist TWICE — src/adapters/cursor.ts and
// src/adapters/copilot.ts — because both hosts read the same `workspace_roots`
// list from their own flat payload. This file pinned the two copies TEXTUALLY
// (so a fix applied to one was applied to both) and BEHAVIOURALLY (so a textual
// match that somehow diverged in effect still failed), and its header named the
// exit: the duplication was provisional, and once the block was extracted the
// textual half should go and the behavioural half should stay.
//
// The block now lives in src/adapters/workspace-root.ts, so the textual half is
// gone. What remains is NOT tautological, and that is the point — the cases below
// assert each adapter's real parse() against LITERAL expected values, never
// against the other adapter's answer. So they still fail on all three ways this
// can break:
//   - the shared selector itself regresses (both adapters fail);
//   - one adapter stops WIRING the selector into parse(), or wires it to the
//     wrong field (that adapter alone fails);
//   - the cwd fold diverges from the selected root.
// A test that only compared cursor to copilot would have survived the extraction
// by becoming a comparison of one function with itself. This one does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCursorAdapter } from '../cursor';
import { makeCopilotAdapter } from '../copilot';

// Behavioural parity, driven through each adapter's real parse() on the one
// subcommand both hosts spell identically. `cwd` is echoed too because the
// selected root feeds workspaceScopedCwd, whose fold-back is the other half of
// the contract.
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
