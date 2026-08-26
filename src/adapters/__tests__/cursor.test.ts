import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCursorAdapter } from '../cursor';
import { dispatch } from '../../core/dispatch';
import { askUser, context, deny, followup, noop } from '../../core/result';
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
  // Verbatim: core/pipeline.ts echoes its "(traffic-one ref: ...)" correlation
  // suffix only when a decision record is actually written, on the same fence
  // as the write itself (stampDeny / projectWritesPermitted) — this fixture
  // project never answered the use-plugin question.
  assert.equal(parsed.user_message, 'nope');
  assert.equal(parsed.agent_message, 'nope');
});

test('cursor: askUser on a PreToolUse (beforeShellExecution) → permission:"ask" (user approve/reject dialog)', async () => {
  // The only hook-driven user prompt Cursor supports — used for the pre-spawn model-gate.
  const handlers: Handler[] = [
    {
      id: 'ask', event: 'PreToolUse', tools: ['shell'], priority: 0,
      run: (ctx) => (ctx.input.tool?.command === 'gate'
        ? askUser('Sonnet not available — approve fallback or reject to enable?', 'on approve proceed; on reject stop')
        : noop()),
    },
  ];
  const parsed = JSON.parse(await dispatch(cursor, handlers, inv('before-shell-execution', { command: 'gate' })));
  assert.equal(parsed.permission, 'ask', 'emits permission:ask, not deny');
  // The question reaches the modal verbatim. An askUser reason NEVER carries
  // the correlation suffix, in any project: it is the text of a yes/no dialog,
  // not agent-facing prose, and its `agent_message` half is never stamped
  // either — see the dedicated pipeline test (which asserts this inside a
  // consented, actively-logging project, where a plain deny WOULD get a ref).
  assert.equal(parsed.user_message, 'Sonnet not available — approve fallback or reject to enable?');
  assert.equal(parsed.agent_message, 'on approve proceed; on reject stop', 'agent_message carries the per-branch instructions');
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
  // Explicit cwd still wins when it is inside workspace_roots.
  const r4 = JSON.parse(await dispatch(cursor, echoCwd, inv('session-start', { cwd: '/proj/x/packages/ui', workspace_roots: ['/proj/x'] })));
  assert.equal(r4.additional_context, '/proj/x/packages/ui');
  // Cursor may report an internal metadata cwd (for example terminals/) outside
  // the opened workspace. That must not re-root Traffic One to the metadata dir.
  const echoShellCwd: Handler[] = [{ id: 'shell-cwd', event: 'PreToolUse', tools: ['shell'], priority: 0, run: (ctx) => context(ctx.input.cwd) }];
  const r5 = JSON.parse(await dispatch(cursor, echoShellCwd, inv('before-shell-execution', {
    cwd: '/Users/u/.cursor/projects/Users-u-Projects-app/terminals',
    workspace_roots: ['/proj/x'],
    command: 'head -n 12 *.txt',
  })));
  assert.equal(r5.additional_context, '/proj/x');
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
  // A shell cwd outside the workspace is ignored in favor of the workspace root.
  const d = cursor.parse(inv('before-shell-execution', {
    cwd: '/Users/u/.cursor/projects/Users-u-Projects-x/terminals',
    workspace_roots: ['/proj/x'],
  }));
  assert.equal(d.cwd, '/proj/x');
  assert.equal(d.workspaceRoot, '/proj/x');
  // No workspace_roots → unset (no ceiling; Claude/Codex monorepo climb unchanged).
  assert.equal(cursor.parse(inv('session-start', {})).workspaceRoot, undefined);
  // A RELATIVE workspace root is NOT a usable ceiling (would resolve against the
  // plugin dir) → left unset so we fall back to safe unbounded resolution.
  assert.equal(cursor.parse(inv('session-start', { workspace_roots: ['relative/proj'] })).workspaceRoot, undefined);
});

test('cursor: a MULTI-root window uses the folder the hook is in, not the first in the list', () => {
  // Cursor supports several folders in one window. Returning workspace_roots[0]
  // named a DIFFERENT project whenever work happened anywhere but the first
  // folder: resolveProjectRoot's bounded walks all break on the foreign ceiling
  // and it returns the ceiling itself, and the cwd fold below then replaces the
  // genuine cwd with that foreign root too.
  const second = cursor.parse(inv('before-read-file', {
    workspace_roots: ['/w/alpha', '/w/beta'],
    cwd: '/w/beta',
    file_path: '/w/beta/src/x.ts',
  }));
  assert.equal(second.workspaceRoot, '/w/beta', 'the ceiling must name the folder being worked in');
  assert.equal(second.cwd, '/w/beta', 'the genuine cwd must survive');

  // …including when the cwd is DEEPER than the root it belongs to.
  const deep = cursor.parse(inv('before-shell-execution', {
    workspace_roots: ['/w/alpha', '/w/beta'],
    cwd: '/w/beta/src',
    command: 'ls',
  }));
  assert.equal(deep.workspaceRoot, '/w/beta');
  assert.equal(deep.cwd, '/w/beta/src');

  // The first folder still wins when the cwd is actually in it.
  assert.equal(cursor.parse(inv('before-shell-execution', {
    workspace_roots: ['/w/alpha', '/w/beta'], cwd: '/w/alpha/src', command: 'ls',
  })).workspaceRoot, '/w/alpha');

  // NESTED roots (a monorepo and one of its packages both opened) resolve to the
  // OUTERMOST containing root. The ceiling is an upper BOUND, not a selection —
  // an innermost ceiling would pin resolution to the sub-package and mint a stray
  // .traffic-one there (the packages/ui incident, reintroduced via the ceiling).
  assert.equal(cursor.parse(inv('before-read-file', {
    workspace_roots: ['/w/mono/packages/ui', '/w/mono'],
    cwd: '/w/mono/packages/ui',
    file_path: '/w/mono/packages/ui/src/x.ts',
  })).workspaceRoot, '/w/mono');

  // Segment-aware containment: /w/alpha must not claim a cwd in /w/alpha2.
  assert.equal(cursor.parse(inv('before-shell-execution', {
    workspace_roots: ['/w/alpha', '/w/alpha2'], cwd: '/w/alpha2/src', command: 'ls',
  })).workspaceRoot, '/w/alpha2');

  // No root contains the cwd (Cursor's internal terminals metadata dir) → the
  // first element, exactly as before, so the out-of-tree fallback is unchanged.
  assert.equal(cursor.parse(inv('before-shell-execution', {
    workspace_roots: ['/w/alpha', '/w/beta'],
    cwd: '/Users/u/.cursor/projects/Users-u-Projects-x/terminals',
    command: 'ls',
  })).workspaceRoot, '/w/alpha');
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

test('cursor: generic apply_patch preserves nested patch_text on canonical ToolInput', () => {
  const parsed = cursor.parse(inv('before-tool-use', {
    tool_name: 'apply_patch',
    tool_input: { patch_text: '*** Begin Patch' },
  }));
  assert.equal(parsed.tool?.class, 'file-write');
  assert.equal(parsed.tool?.patchText, '*** Begin Patch');
});

test('cursor: beforeMCPExecution composes the config key and bare tool name exactly', () => {
  const managed = cursor.parse(inv('before-mcp-execution', {
    command: 'traffic-one-mcp',
    tool_name: 'get_config',
    tool_input: { version: 1 },
  }));
  assert.equal(managed.event, 'PreToolUse');
  assert.equal(managed.tool?.class, 'other');
  assert.equal(managed.tool?.rawName, 'traffic-one-mcp.get_config');

  const explicit = cursor.parse(inv('before-mcp-execution', {
    mcp_server_name: 'traffic-one-mcp',
    command: 'https://example.invalid/mcp',
    mcp_tool_name: 'report_codebase_metadata',
  }));
  assert.equal(explicit.tool?.rawName, 'traffic-one-mcp.report_codebase_metadata');

  const fixedCommand = cursor.parse(inv('before-mcp-execution', {
    command: 'https://otxgutlmatdihqkbsvvh.supabase.co/functions/v1/traffic-one-mcp/public-mcp',
    tool_name: 'get_config',
  }));
  assert.equal(fixedCommand.tool?.rawName, 'traffic-one-mcp.get_config');
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

test('cursor: stop/subagentStop subcommands map to dedicated lifecycle events', () => {
  assert.equal(cursor.parse(inv('cursor-stop', { status: 'completed', loop_count: 0 })).event, 'Stop');
  assert.equal(cursor.parse(inv('cursor-subagent-stop', {
    status: 'error',
    subagent_id: 'tool_1',
    loop_count: 0,
  })).event, 'SubagentStop');
});

test('cursor: stop/subagentStop serialize a continuation as exact followup_message JSON', async () => {
  const stopHandlers: Handler[] = [
    { id: 'continue-parent', event: 'Stop', priority: 0, run: () => followup('retry parent') },
  ];
  assert.deepEqual(JSON.parse(await dispatch(cursor, stopHandlers, inv('cursor-stop', {
    status: 'completed',
    loop_count: 0,
  }))), { followup_message: 'retry parent' });

  const subagentHandlers: Handler[] = [
    { id: 'continue-child', event: 'SubagentStop', priority: 0, run: () => followup('retry child') },
  ];
  assert.deepEqual(JSON.parse(await dispatch(cursor, subagentHandlers, inv('cursor-subagent-stop', {
    status: 'error',
    loop_count: 0,
  }))), { followup_message: 'retry child' });
});

test('cursor: followupMessage is inert outside stop/subagentStop', async () => {
  const handlers: Handler[] = [
    { id: 'wrong-event', event: 'SessionStart', priority: 0, run: () => followup('must not leak') },
  ];
  assert.deepEqual(JSON.parse(await dispatch(cursor, handlers, inv('session-start', {}))), {});
});

test('cursor: NET-NEW — generic preToolUse(Write) fires a PreToolUse/file-write gate (pre-write deny works)', async () => {
  const writeGate: Handler[] = [{ id: 'w', event: 'PreToolUse', tools: ['file-write'], priority: 0, run: () => deny('write blocked') }];
  const out = JSON.parse(await dispatch(cursor, writeGate, inv('before-tool-use', { tool_name: 'Write', tool_input: { file_path: '/a.ts' } })));
  assert.equal(out.permission, 'deny');
});

const SPAWN_PRETOOLUSE_DENY_PREFIX =
  'TRAFFIC ONE GATE (not a host crash). Do not retry this Task unchanged. Next action:';

test('cursor: spawn-agent PreToolUse deny prefixes user/agent messages (not a host crash)', async () => {
  const spawnGate: Handler[] = [
    { id: 'spawn', event: 'PreToolUse', tools: ['spawn-agent'], priority: 0, run: () => deny('architect first') },
  ];
  const out = JSON.parse(await dispatch(cursor, spawnGate, inv('before-tool-use', {
    tool_name: 'Task',
    tool_input: { subagent_type: 'senior-frontend' },
  })));
  assert.equal(out.permission, 'deny');
  const expected = `${SPAWN_PRETOOLUSE_DENY_PREFIX}\n\narchitect first`;
  assert.equal(out.user_message, expected);
  assert.equal(out.agent_message, expected);
  assert.ok(out.user_message.startsWith(SPAWN_PRETOOLUSE_DENY_PREFIX));
});

test('cursor: deny userReason rides user_message; agent_message stays the recipe', async () => {
  const handlers: Handler[] = [
    { id: 'd', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('nope', { userReason: 'Stay in this workspace.' }) },
  ];
  const parsed = JSON.parse(await dispatch(cursor, handlers, inv('before-shell-execution', { command: 'rm' })));
  assert.equal(parsed.permission, 'deny');
  assert.equal(parsed.user_message, 'Stay in this workspace.');
  assert.equal(parsed.agent_message, 'nope');
  assert.equal(parsed.user_message.startsWith(SPAWN_PRETOOLUSE_DENY_PREFIX), false);
});

test('cursor: spawn-agent PreToolUse deny with userReason keeps the prefix on agent_message only', async () => {
  const spawnGate: Handler[] = [
    { id: 'spawn', event: 'PreToolUse', tools: ['spawn-agent'], priority: 0, run: () => deny('architect first', { userReason: 'Stay in this workspace.' }) },
  ];
  const out = JSON.parse(await dispatch(cursor, spawnGate, inv('before-tool-use', {
    tool_name: 'Task',
    tool_input: { subagent_type: 'senior-frontend' },
  })));
  assert.equal(out.permission, 'deny');
  assert.equal(out.user_message, 'Stay in this workspace.');
  assert.ok(out.agent_message.startsWith(SPAWN_PRETOOLUSE_DENY_PREFIX));
  assert.ok(out.agent_message.includes('architect first'));
  assert.equal(out.user_message.startsWith(SPAWN_PRETOOLUSE_DENY_PREFIX), false);
});

test('cursor: file-write PreToolUse deny is NOT spawn-prefixed', async () => {
  const writeGate: Handler[] = [
    { id: 'w', event: 'PreToolUse', tools: ['file-write'], priority: 0, run: () => deny('write blocked') },
  ];
  const out = JSON.parse(await dispatch(cursor, writeGate, inv('before-tool-use', {
    tool_name: 'Write',
    tool_input: { file_path: '/a.ts' },
  })));
  assert.equal(out.permission, 'deny');
  assert.equal(out.user_message, 'write blocked');
  assert.equal(out.agent_message, 'write blocked');
  assert.equal(out.user_message.startsWith(SPAWN_PRETOOLUSE_DENY_PREFIX), false);
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
