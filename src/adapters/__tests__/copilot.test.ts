import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectCopilotWireSurface, makeCopilotAdapter, resolveCopilotSubcommand } from '../copilot';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler } from '../../core/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'copilot');

function inv(sub: string, payload: object, surface?: 'cli' | 'vscode') {
  const adapter = makeCopilotAdapter(surface);
  return { adapter, raw: { stdin: JSON.stringify(payload), argv: ['node', 'copilot-hook-runtime', sub] } };
}

function assertSingleWireShape(out: Record<string, unknown>, surface: 'cli' | 'vscode'): void {
  if (surface === 'cli') {
    assert.equal(out.hookSpecificOutput, undefined, 'CLI deny must not carry the VS Code wrapper');
  } else {
    assert.equal(out.permissionDecision, undefined, 'VS Code deny must not carry a flat CLI permissionDecision');
  }
}

test('copilot CLI: before-tool-use parses toolArgs JSON string', () => {
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'pre-tool-use-input.json'), 'utf8'));
  const { adapter, raw } = inv('before-tool-use', payload, 'cli');
  const parsed = adapter.parse(raw);
  assert.equal(parsed.host, 'copilot');
  assert.equal(parsed.tool?.class, 'shell');
  assert.equal(parsed.tool?.command, 'npm test');
  assert.equal(parsed.workspaceRoot, '/Users/dev/my-app');
  assert.deepEqual((parsed.raw as Record<string, unknown>).tool_input, { command: 'npm test' });
});

test('copilot: a MULTI-root VS Code window uses the folder the hook is in, not the first', () => {
  // VS Code multi-root workspaces send several `workspace_roots`. Taking the
  // first made the boundary name a sibling project whenever work happened in any
  // other folder — see the cursor.ts twin of this selector and the shared-block
  // parity test.
  const second = inv('before-tool-use', {
    workspace_roots: ['/w/alpha', '/w/beta'],
    cwd: '/w/beta/src',
    tool_name: 'view',
    tool_args: JSON.stringify({ path: '/w/beta/src/x.ts' }),
  }, 'vscode');
  const parsed = second.adapter.parse(second.raw);
  assert.equal(parsed.workspaceRoot, '/w/beta');
  assert.equal(parsed.cwd, '/w/beta/src');

  // Nested roots resolve OUTERMOST, so a sub-package never becomes its own root.
  const nested = inv('before-tool-use', {
    workspace_roots: ['/w/mono/packages/ui', '/w/mono'],
    cwd: '/w/mono/packages/ui',
    tool_name: 'view',
  }, 'vscode');
  assert.equal(nested.adapter.parse(nested.raw).workspaceRoot, '/w/mono');

  // Nothing contains the cwd → first element, unchanged.
  const outside = inv('before-tool-use', {
    workspace_roots: ['/w/alpha', '/w/beta'], cwd: '/elsewhere/tmp', tool_name: 'view',
  }, 'vscode');
  assert.equal(outside.adapter.parse(outside.raw).workspaceRoot, '/w/alpha');
});

test('copilot CLI: spawn toolArgs are visible to raw-input gates', () => {
  const { adapter, raw } = inv('before-tool-use', {
    tool_name: 'agent',
    tool_args: JSON.stringify({
      agentName: 'senior-frontend',
      model: 'claude-opus-4-8',
      prompt: '[t1-role: senior-frontend] build the UI',
    }),
  }, 'cli');
  const parsed = adapter.parse(raw);
  const toolInput = (parsed.raw as Record<string, unknown>).tool_input as Record<string, unknown>;
  assert.equal(parsed.tool?.class, 'spawn-agent');
  assert.equal(toolInput.agentName, 'senior-frontend');
  assert.equal(toolInput.model, 'claude-opus-4-8');
});

test('copilot CLI: apply_patch toolArgs are canonicalized', () => {
  const { adapter, raw } = inv('before-tool-use', {
    tool_name: 'apply_patch',
    tool_args: JSON.stringify({ patch_text: '*** Begin Patch' }),
  }, 'cli');
  assert.equal(adapter.parse(raw).tool?.patchText, '*** Begin Patch');
});

test('copilot VS Code: preToolUse toolCalls task is visible to spawn gates', () => {
  const { adapter, raw } = inv('before-tool-use', {
    sessionId: 'parent-session',
    cwd: '/repo',
    toolCalls: [{
      id: 'call_task_1',
      name: 'task',
      args: JSON.stringify({
        description: 'Apply reviewer-requested fixes',
        agent_type: 'traffic-one:senior-frontend',
        name: 'senior-frontend-fixes',
        mode: 'background',
        prompt: '[t1-role: senior-frontend] fix the frontend',
      }),
    }],
  }, 'vscode');
  const parsed = adapter.parse(raw);
  const rawParsed = parsed.raw as Record<string, unknown>;
  const toolInput = rawParsed.tool_input as Record<string, unknown>;
  assert.equal(parsed.tool?.class, 'spawn-agent');
  assert.equal(parsed.tool?.rawName, 'task');
  assert.equal(rawParsed.toolCallId, 'call_task_1');
  assert.equal(toolInput.agent_type, 'traffic-one:senior-frontend');
  assert.equal(toolInput.name, 'senior-frontend-fixes');
});

test('copilot CLI: PreToolUse deny → flat permissionDecision shape', async () => {
  const { adapter, raw } = inv('before-tool-use', { tool_name: 'bash', tool_args: '{"command":"rm -rf /"}' }, 'cli');
  const handlers: Handler[] = [
    {
      id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0,
      run: (ctx) => (ctx.input.tool?.command?.includes('rm') ? deny('blocked', { context: 'ctx' }) : noop()),
    },
  ];
  const out = JSON.parse(await dispatch(adapter, handlers, raw));
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(out.permissionDecisionReason, 'blocked');
  assert.equal(out.additionalContext, 'ctx');
});

test('copilot CLI + VS Code: deny userReason rides permissionDecisionReason; recipe joins additionalContext', async () => {
  const handlers: Handler[] = [
    {
      id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0,
      run: () => deny('no rm -rf', { userReason: 'Stay in this workspace.', context: 'ctx' }),
    },
  ];
  const cli = inv('before-tool-use', { tool_name: 'bash', tool_args: '{"command":"rm -rf /"}' }, 'cli');
  const cliOut = JSON.parse(await dispatch(cli.adapter, handlers, cli.raw));
  assert.equal(cliOut.permissionDecision, 'deny');
  assert.equal(cliOut.permissionDecisionReason, 'Stay in this workspace.');
  assert.match(String(cliOut.additionalContext), /ctx/);
  assert.match(String(cliOut.additionalContext), /no rm -rf/);
  const vscode = inv('before-tool-use', { tool_name: 'bash', tool_args: '{"command":"rm -rf /"}' }, 'vscode');
  const vsOut = JSON.parse(await dispatch(vscode.adapter, handlers, vscode.raw));
  assert.equal(vsOut.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(vsOut.hookSpecificOutput?.permissionDecisionReason, 'Stay in this workspace.');
  assert.match(String(vsOut.hookSpecificOutput?.additionalContext), /ctx/);
  assert.match(String(vsOut.hookSpecificOutput?.additionalContext), /no rm -rf/);
});

test('copilot CLI + VS Code: a deny carries systemMessage — the user-visible banner channel', async () => {
  const handlers: Handler[] = [
    {
      id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0,
      run: () => deny('blocked', { systemMessage: 'BANNER with setup link' }),
    },
  ];
  const cli = inv('before-tool-use', { tool_name: 'bash', tool_args: '{"command":"pwd"}' }, 'cli');
  const cliOut = JSON.parse(await dispatch(cli.adapter, handlers, cli.raw));
  assert.equal(cliOut.permissionDecision, 'deny');
  assert.equal(cliOut.systemMessage, 'BANNER with setup link');
  const vscode = inv('before-tool-use', { tool_name: 'bash', tool_args: '{"command":"pwd"}' }, 'vscode');
  const vsOut = JSON.parse(await dispatch(vscode.adapter, handlers, vscode.raw));
  assert.equal(vsOut.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(vsOut.systemMessage, 'BANNER with setup link');
});

test('copilot CLI: session-start context → flat additionalContext', async () => {
  const { adapter, raw } = inv('session-start', {}, 'cli');
  const handlers: Handler[] = [{ id: 's', event: 'SessionStart', priority: 0, run: () => context('auth!') }];
  const out = JSON.parse(await dispatch(adapter, handlers, raw));
  assert.equal(out.additionalContext, 'auth!');
});

test('copilot VS Code: session-start context → hookSpecificOutput', async () => {
  const { adapter, raw } = inv('session-start', {}, 'vscode');
  const handlers: Handler[] = [{ id: 's', event: 'SessionStart', priority: 0, run: () => context('auth!') }];
  const out = JSON.parse(await dispatch(adapter, handlers, raw));
  assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.equal(out.hookSpecificOutput?.additionalContext, 'auth!');
});

test('copilot fixtures match documented spike stdout shapes', () => {
  const cliDeny = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cli-pre-tool-deny-stdout.json'), 'utf8'));
  assert.equal(cliDeny.permissionDecision, 'deny');
  const cliStart = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cli-session-start-stdout.json'), 'utf8'));
  assert.ok(cliStart.additionalContext);
  const vscodeStart = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'vscode-session-start-stdout.json'), 'utf8'));
  assert.ok(vscodeStart.hookSpecificOutput?.additionalContext);
});

// ── wire-surface discriminator ───────────────────────────────────────────────
// CLI fixture pre-tool-use-input.json has hook_event_name AND is invoked with
// argv before-tool-use. TERM_PROGRAM=vscode / VSCODE_PID are inherited by CLI
// inside a VS Code terminal and must not select the nested shape.

test('detectCopilotWireSurface: TERM_PROGRAM=vscode + argv before-tool-use + no hook_event_name → cli', () => {
  assert.equal(
    detectCopilotWireSurface({ TERM_PROGRAM: 'vscode' }, {}, ['before-tool-use']),
    'cli',
  );
});

test('resolveCopilotSubcommand: payload event maps to SUB_TO_EVENT; argv known key wins', () => {
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'SessionStart' }), 'session-start');
  assert.equal(resolveCopilotSubcommand([], { hookEventName: 'sessionStart' }), 'session-start');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'UserPromptSubmit' }), 'user-prompt-submit');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'userPromptSubmitted' }), 'user-prompt-submit');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'userPromptSubmit' }), 'user-prompt-submit');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'PreToolUse' }), 'before-tool-use');
  assert.equal(resolveCopilotSubcommand([], { hookEventName: 'preToolUse' }), 'before-tool-use');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'PostToolUse' }), 'after-tool-use');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'postToolUse' }), 'after-tool-use');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'SubagentStart' }), 'subagent-start');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'subagentStart' }), 'subagent-start');
  assert.equal(resolveCopilotSubcommand([], { hook_event_name: 'UnknownEvent' }), 'before-tool-use');
  assert.equal(resolveCopilotSubcommand([], {}), undefined);
  assert.equal(resolveCopilotSubcommand(['session-start'], { hook_event_name: 'PreToolUse' }), 'session-start');
});

test('detectCopilotWireSurface: hook_event_name without override or argv → vscode', () => {
  assert.equal(
    detectCopilotWireSurface({}, { hook_event_name: 'PreToolUse' }),
    'vscode',
  );
  assert.equal(
    detectCopilotWireSurface({}, { hookEventName: 'sessionStart' }),
    'vscode',
  );
});

test('detectCopilotWireSurface: TRAFFIC_ONE_COPILOT_WIRE still wins', () => {
  assert.equal(
    detectCopilotWireSurface({ TRAFFIC_ONE_COPILOT_WIRE: 'cli' }, { hook_event_name: 'PreToolUse' }),
    'cli',
  );
  assert.equal(
    detectCopilotWireSurface({ TRAFFIC_ONE_COPILOT_WIRE: 'vscode' }, {}, ['before-tool-use']),
    'vscode',
  );
});

test('detectCopilotWireSurface: argv known subcommand beats hook_event_name and TERM_PROGRAM', () => {
  // Shared CLI input fixture: hook_event_name + argv before-tool-use.
  const cliFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'pre-tool-use-input.json'), 'utf8'));
  assert.equal(
    detectCopilotWireSurface({ TERM_PROGRAM: 'vscode', VSCODE_PID: '1' }, cliFixture, ['before-tool-use']),
    'cli',
  );
});

test('detectCopilotWireSurface: VSCODE_PID / TERM_PROGRAM alone are not vscode', () => {
  assert.equal(detectCopilotWireSurface({ VSCODE_PID: '1' }, {}), 'cli');
  assert.equal(detectCopilotWireSurface({ TERM_PROGRAM: 'vscode' }, {}), 'cli');
});

test('detectCopilotWireSurface: inbound hookSpecificOutput is vscode even with argv', () => {
  assert.equal(
    detectCopilotWireSurface({}, { hookSpecificOutput: { hookEventName: 'PreToolUse' } }, ['before-tool-use']),
    'vscode',
  );
});

test('unforced adapter: TERM_PROGRAM=vscode + argv before-tool-use serializes a CLI deny', async () => {
  const saved = { term: process.env.TERM_PROGRAM, pid: process.env.VSCODE_PID, wire: process.env.TRAFFIC_ONE_COPILOT_WIRE };
  process.env.TERM_PROGRAM = 'vscode';
  delete process.env.VSCODE_PID;
  delete process.env.TRAFFIC_ONE_COPILOT_WIRE;
  try {
    const adapter = makeCopilotAdapter();
    const raw = {
      stdin: JSON.stringify({ tool_name: 'bash', tool_args: '{"command":"rm -rf /"}' }),
      argv: ['before-tool-use'],
    };
    const handlers: Handler[] = [{
      id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0,
      run: () => deny('blocked'),
    }];
    const out = JSON.parse(await dispatch(adapter, handlers, raw));
    assert.equal(out.permissionDecision, 'deny');
    assertSingleWireShape(out, 'cli');
  } finally {
    if (saved.term === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.term;
    if (saved.pid === undefined) delete process.env.VSCODE_PID;
    else process.env.VSCODE_PID = saved.pid;
    if (saved.wire === undefined) delete process.env.TRAFFIC_ONE_COPILOT_WIRE;
    else process.env.TRAFFIC_ONE_COPILOT_WIRE = saved.wire;
  }
});

test('unforced adapter: hook_event_name without argv serializes a VS Code deny', async () => {
  const saved = process.env.TRAFFIC_ONE_COPILOT_WIRE;
  delete process.env.TRAFFIC_ONE_COPILOT_WIRE;
  try {
    const adapter = makeCopilotAdapter();
    const raw = {
      stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_args: '{"command":"rm -rf /"}' }),
      argv: [],
    };
    const handlers: Handler[] = [{
      id: 'g', event: 'PreToolUse', tools: ['shell'], priority: 0,
      run: () => deny('blocked'),
    }];
    const out = JSON.parse(await dispatch(adapter, handlers, raw));
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assertSingleWireShape(out, 'vscode');
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_COPILOT_WIRE;
    else process.env.TRAFFIC_ONE_COPILOT_WIRE = saved;
  }
});

// ── per-call batch gating ────────────────────────────────────────────────────
// `rm` is not a mapped Copilot tool name (class `other`, not admitted). The
// batch under test is write + bash-with-rm, which is the [write, rm] shape
// the host actually sends.

const batchHandlers: Handler[] = [
  {
    id: 'g', event: 'PreToolUse', tools: ['shell', 'file-write'], priority: 0,
    run: (ctx) => {
      if (ctx.input.tool?.class === 'file-write') return deny('blocked write');
      if (ctx.input.tool?.command?.includes('rm')) return deny('blocked rm');
      return noop();
    },
  },
];

test('copilot batch: [write, bash rm] denies if either call would deny', async () => {
  const { adapter, raw } = inv('before-tool-use', {
    cwd: '/repo',
    tool_calls: [
      { name: 'write', args: { path: '/repo/a.ts', content: 'x' } },
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
    ],
  }, 'cli');
  const out = JSON.parse(await dispatch(adapter, batchHandlers, raw));
  assert.equal(out.permissionDecision, 'deny');
  assert.match(String(out.permissionDecisionReason), /blocked write|blocked rm/);
  assertSingleWireShape(out, 'cli');
});

test('copilot batch: a benign first call does not hide a later deny', async () => {
  const { adapter, raw } = inv('before-tool-use', {
    cwd: '/repo',
    tool_calls: [
      { name: 'bash', args: { command: 'echo ok' } },
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
    ],
  }, 'cli');
  const out = JSON.parse(await dispatch(adapter, batchHandlers, raw));
  assert.equal(out.permissionDecision, 'deny');
  assert.match(String(out.permissionDecisionReason), /blocked rm/);
  assertSingleWireShape(out, 'cli');
});

test('copilot batch: two benign shell writes stay noop', async () => {
  const { adapter, raw } = inv('before-tool-use', {
    cwd: '/repo',
    tool_calls: [
      { name: 'bash', args: { command: 'echo one' } },
      { name: 'bash', args: { command: 'echo two' } },
    ],
  }, 'cli');
  assert.equal(await dispatch(adapter, batchHandlers, raw), '');
});

test('copilot batch: VS Code deny is nested only (no CLI+VS Code union)', async () => {
  const { adapter, raw } = inv('before-tool-use', {
    cwd: '/repo',
    tool_calls: [
      { name: 'write', args: { path: '/repo/a.ts', content: 'x' } },
      { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
    ],
  }, 'vscode');
  const out = JSON.parse(await dispatch(adapter, batchHandlers, raw));
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  assertSingleWireShape(out, 'vscode');
});

test('copilot batch: class other is not admitted; single admitted call still uses the one-call path', async () => {
  const { adapter, raw } = inv('before-tool-use', {
    cwd: '/repo',
    tool_calls: [
      { name: 'unknown-mcp-tool', args: { x: 1 } },
      { name: 'write', args: { path: '/repo/a.ts', content: 'x' } },
    ],
  }, 'cli');
  const out = JSON.parse(await dispatch(adapter, batchHandlers, raw));
  assert.equal(out.permissionDecision, 'deny');
  assert.match(String(out.permissionDecisionReason), /blocked write/);
});
