import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCursorAdapter } from '../cursor';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';

const cursor = makeCursorAdapter();

function inv(sub: string, payload: object) {
  return { stdin: JSON.stringify(payload), argv: ['node', 'cursor-hook-runtime', sub] };
}

test('cursor: before-shell-execution → PreToolUse/shell; deny → flat permission shape', async () => {
  const handlers: Handler[] = [
    {
      id: 'g',
      event: 'PreToolUse',
      tools: ['shell'],
      priority: 0,
      run: (ctx) => (ctx.input.tool?.command === 'rm' ? deny('nope') : noop()),
    },
  ];
  const parsed = JSON.parse(await dispatch(cursor, handlers, inv('before-shell-execution', { command: 'rm' })));
  assert.equal(parsed.permission, 'deny');
  assert.equal(parsed.user_message, 'nope');
  assert.equal(parsed.agent_message, 'nope');
});

test('cursor: a PostToolUse deny downgrades to a warning (no permission key — the action already ran)', async () => {
  // Cursor can only block a PreToolUse; afterShellExecution/afterFileEdit are POST,
  // so a deny there must become a warning, not a no-op permission:'deny'.
  const denyHandlers: Handler[] = [
    { id: 'd', event: 'PostToolUse', tools: ['shell'], priority: 0, run: () => deny('too late, but heed this') },
  ];
  const parsed = JSON.parse(await dispatch(cursor, denyHandlers, inv('after-shell-execution', { command: 'rm x' })));
  assert.equal(parsed.permission, undefined); // NOT 'deny' on a POST event
  assert.equal(parsed.user_message, 'too late, but heed this');
  assert.equal(parsed.agent_message, 'too late, but heed this');
});

test('cursor: a PreToolUse deny still blocks (permission:deny)', async () => {
  const denyHandlers: Handler[] = [
    { id: 'd', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('blocked') },
  ];
  const parsed = JSON.parse(await dispatch(cursor, denyHandlers, inv('before-shell-execution', { command: 'rm x' })));
  assert.equal(parsed.permission, 'deny');
  assert.equal(parsed.user_message, 'blocked');
});

test('cursor: after-file-edit content is synthesized from new_string / edits[]', () => {
  const fromNewString = cursor.parse(inv('after-file-edit', { file_path: '/a.ts', new_string: 'hello' }));
  assert.equal(fromNewString.tool?.content, 'hello');
  const fromEdits = cursor.parse(inv('after-file-edit', { file_path: '/a.ts', edits: [{ new_string: 'l1' }, { new_string: 'l2' }] }));
  assert.equal(fromEdits.tool?.content, 'l1\nl2');
});

test('cursor: session-start context → flat additional_context', async () => {
  const handlers: Handler[] = [{ id: 's', event: 'SessionStart', priority: 0, run: () => context('ctx!') }];
  assert.deepEqual(JSON.parse(await dispatch(cursor, handlers, inv('session-start', {}))), {
    additional_context: 'ctx!',
  });
});

test('cursor: noop → {} (Cursor always wants a JSON object)', async () => {
  assert.equal(await dispatch(cursor, [], inv('after-shell-execution', { command: 'ls' })), '{}');
});

test('cursor: cwd is resolved from workspace_roots when no cwd field is sent (the real Cursor payload)', async () => {
  // Cursor sends workspace_roots, never cwd. Without this the gate inspects the
  // plugin dir (process.cwd()) and onboarding silently no-ops — the b90b49e9 bug.
  const echoCwd: Handler[] = [{ id: 'c', event: 'SessionStart', priority: 0, run: (ctx) => context(ctx.input.cwd) }];
  const r1 = JSON.parse(await dispatch(cursor, echoCwd, inv('session-start', { workspace_roots: ['/proj/x'] })));
  assert.equal(r1.additional_context, '/proj/x');
  // Object element form + file:// scheme stripping.
  const r2 = JSON.parse(await dispatch(cursor, echoCwd, inv('session-start', { workspace_roots: [{ path: '/proj/y' }] })));
  assert.equal(r2.additional_context, '/proj/y');
  const r3 = JSON.parse(await dispatch(cursor, echoCwd, inv('session-start', { workspace_roots: ['file:///proj/z'] })));
  assert.equal(r3.additional_context, '/proj/z');
  // Explicit cwd still wins over workspace_roots.
  const r4 = JSON.parse(await dispatch(cursor, echoCwd, inv('session-start', { cwd: '/explicit', workspace_roots: ['/proj/x'] })));
  assert.equal(r4.additional_context, '/explicit');
});

test('cursor: workspaceRoot is surfaced from workspace_roots as the authoritative ceiling', () => {
  // resolveProjectRoot uses this as an upper bound so a hook touching a path ABOVE the
  // opened workspace can't re-root Traffic One to the parent (the double-onboarding bug).
  const a = cursor.parse(inv('before-read-file', { workspace_roots: ['/proj/x'], file_path: '/proj/x/.traffic-one/x.md' }));
  assert.equal(a.workspaceRoot, '/proj/x');
  // file:// + object element forms normalize the same as cwd.
  assert.equal(cursor.parse(inv('session-start', { workspace_roots: ['file:///proj/z'] })).workspaceRoot, '/proj/z');
  assert.equal(cursor.parse(inv('session-start', { workspace_roots: [{ path: '/proj/y' }] })).workspaceRoot, '/proj/y');
  // A deeper shell cwd folds into cwd but must NOT move the workspace boundary: cwd
  // can drift into a sub-package, the ceiling stays the opened workspace root.
  const c = cursor.parse(inv('before-shell-execution', { cwd: '/proj/x/packages/ui', workspace_roots: ['/proj/x'] }));
  assert.equal(c.cwd, '/proj/x/packages/ui');
  assert.equal(c.workspaceRoot, '/proj/x');
  // No workspace_roots → unset (no ceiling; Claude/Codex monorepo climb unchanged).
  assert.equal(cursor.parse(inv('session-start', {})).workspaceRoot, undefined);
  // A RELATIVE workspace root is NOT a usable ceiling (would resolve against the
  // plugin dir) → left unset so we fall back to safe unbounded resolution.
  assert.equal(cursor.parse(inv('session-start', { workspace_roots: ['relative/proj'] })).workspaceRoot, undefined);
});

test('cursor: generic preToolUse derives tool class from tool_name (pre-write/search/spawn now reachable)', () => {
  const w = cursor.parse(inv('before-tool-use', { tool_name: 'Write', tool_input: { file_path: '/a.ts', content: 'hi' } }));
  assert.equal(w.event, 'PreToolUse');
  assert.equal(w.tool?.class, 'file-write');
  assert.equal(w.tool?.rawName, 'Write');
  assert.equal(w.tool?.filePath, '/a.ts');
  assert.equal(w.tool?.content, 'hi');
  assert.equal(cursor.parse(inv('before-tool-use', { tool_name: 'Edit', tool_input: { file_path: '/b', edits: [{ new_string: 'z' }] } })).tool?.class, 'file-edit');
  assert.equal(cursor.parse(inv('before-tool-use', { tool_name: 'Grep', tool_input: {} })).tool?.class, 'search');
  const task = cursor.parse(inv('before-tool-use', { tool_name: 'Task', tool_input: {} }));
  assert.equal(task.tool?.class, 'spawn-agent');
  assert.equal(task.tool?.rawName, 'Task'); // agentModelGate's Task|Agent regex needs the real name
});

test('cursor: generic preToolUse EXCLUDES fixed-event classes → class "other" (no double-fire), tool stays present', () => {
  const sh = cursor.parse(inv('before-tool-use', { tool_name: 'Shell', tool_input: { command: 'ls' } }));
  assert.equal(sh.tool?.class, 'other'); // before-shell-execution owns (PreToolUse, shell)
  assert.ok(sh.tool, 'tool present so the no-tools materialize-project gate stays a no-op');
  assert.equal(cursor.parse(inv('before-tool-use', { tool_name: 'Read', tool_input: { file_path: '/x' } })).tool?.class, 'other');
  // Unknown tool_name → other = FAIL CLOSED (no double-fire, new coverage simply doesn't fire).
  assert.equal(cursor.parse(inv('before-tool-use', { tool_name: 'Frobnicate' })).tool?.class, 'other');
});

test('cursor: generic postToolUse admits file-write/spawn-agent, excludes file-edit/shell (afterFileEdit/afterShell own them)', () => {
  assert.equal(cursor.parse(inv('after-tool-use', { tool_name: 'Write', tool_input: { file_path: '/a' } })).tool?.class, 'file-write');
  assert.equal(cursor.parse(inv('after-tool-use', { tool_name: 'Edit', tool_input: { file_path: '/a' } })).tool?.class, 'other');
  assert.equal(cursor.parse(inv('after-tool-use', { tool_name: 'Shell', tool_input: { command: 'ls' } })).tool?.class, 'other');
});

test('cursor: subagentStart → SubagentStart, no tool', () => {
  const s = cursor.parse(inv('subagent-start', { subagent_id: 'a', subagent_type: 'general' }));
  assert.equal(s.event, 'SubagentStart');
  assert.equal(s.tool, undefined);
});

test('cursor: NET-NEW — generic preToolUse(Write) fires a PreToolUse/file-write gate (pre-write deny works)', async () => {
  const writeGate: Handler[] = [{ id: 'w', event: 'PreToolUse', tools: ['file-write'], priority: 0, run: () => deny('write blocked') }];
  const out = JSON.parse(await dispatch(cursor, writeGate, inv('before-tool-use', { tool_name: 'Write', tool_input: { file_path: '/a.ts' } })));
  assert.equal(out.permission, 'deny');
});

test('cursor: DE-DUP — generic preToolUse(Shell) does NOT fire a PreToolUse/shell gate (before-shell-execution owns it)', async () => {
  const shellGate: Handler[] = [{ id: 's', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('shell blocked') }];
  const fixed = JSON.parse(await dispatch(cursor, shellGate, inv('before-shell-execution', { command: 'rm' })));
  assert.equal(fixed.permission, 'deny'); // the fixed event still fires it
  const generic = JSON.parse(await dispatch(cursor, shellGate, inv('before-tool-use', { tool_name: 'Shell', tool_input: { command: 'rm' } })));
  assert.equal(generic.permission, undefined); // the generic path does NOT (excluded → 'other')
});

test('cursor: before-read-file extracts the path from document.uri alias', async () => {
  const handlers: Handler[] = [
    { id: 'r', event: 'PreToolUse', tools: ['file-read'], priority: 0, run: (ctx) => context(ctx.input.tool?.filePath ?? 'none') },
  ];
  assert.deepEqual(JSON.parse(await dispatch(cursor, handlers, inv('before-read-file', { document: { uri: '/a/b.ts' } }))), {
    additional_context: '/a/b.ts',
  });
});
