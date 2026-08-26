import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeClaudeAdapter } from '../claude';
import { dispatch } from '../../core/dispatch';
import { context, deny, noop } from '../../core/result';
import type { Handler, HookInput } from '../../core/types';

// These are adapter SERIALIZATION tests: they pin the wire shape each host
// receives, and nothing here is about the decision log. But core/pipeline.ts
// appends a `(traffic-one ref: …)` suffix to deny text whenever a record will
// actually be written, and several payloads below carry a project-shaped `cwd`
// (`/tmp/p`) — so whether that suffix appears would otherwise depend on ambient
// state (TRAFFIC_ONE_ASK_USE_PLUGIN, any recorded use-plugin answer). Pinned off
// so the reason text asserted below is the handler's own, deterministically, in
// any environment. Read at call time, so setting it here (after the imports,
// like the other test files that pin TRAFFIC_ONE_ASK_USE_PLUGIN) is in time.
// The suffix itself is covered where it belongs: core/__tests__/pipeline.test.ts.
process.env.T1_DECISION_LOG = 'off';

const claude = makeClaudeAdapter('claude');

const PATCH = '*** Begin Patch\n*** Add File: src/x.ts\n+x\n*** End Patch';

test('claude/codex: canonicalizes freeform apply_patch input separately from content', () => {
  const parsed = makeClaudeAdapter('codex').parse({
    stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: PATCH }),
    argv: [],
  });
  assert.equal(parsed.tool?.patchText, PATCH);
  assert.equal(parsed.tool?.content, undefined);
});

test('claude: PreToolUse Bash deny → nested permissionDecision JSON', async () => {
  const handlers: Handler[] = [
    {
      id: 'block-rm',
      event: 'PreToolUse',
      tools: ['shell'],
      priority: 0,
      run: (ctx) => (ctx.input.tool?.command?.includes('rm -rf') ? deny('no rm -rf') : noop()),
    },
  ];
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
    cwd: '/tmp/p',
  });
  const parsed = JSON.parse(await dispatch(claude, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  // The handler's own text, verbatim — see the T1_DECISION_LOG pin above.
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'no rm -rf');
  assert.equal(parsed.hookSpecificOutput.additionalContext, undefined);
});

test('claude: SessionStart context → additionalContext JSON', async () => {
  const handlers: Handler[] = [
    { id: 'greet', event: 'SessionStart', priority: 0, run: () => context('hello session') },
  ];
  const stdin = JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/tmp/p' });
  const parsed = JSON.parse(await dispatch(claude, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'hello session');
});

test('claude: PreToolUse updatedToolInput → hookSpecificOutput.updatedInput; codex never emits it', () => {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd: '/tmp/p', raw: {} };
  const updated = { subagent_type: 'senior-architect', model: 'opus', prompt: 'runs/123/x' };
  // Rewrite-only allow: updatedInput carried, empty additionalContext omitted,
  // and NO permissionDecision — the normal permission flow stays untouched.
  const out = JSON.parse(claude.serialize(context('', { updatedToolInput: updated }), input));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, updated);
  assert.equal('additionalContext' in out.hookSpecificOutput, false);
  assert.equal('permissionDecision' in out.hookSpecificOutput, false);
  // Context text and updatedInput can ride together.
  const both = JSON.parse(claude.serialize(context('note', { updatedToolInput: updated }), input));
  assert.equal(both.hookSpecificOutput.additionalContext, 'note');
  assert.deepEqual(both.hookSpecificOutput.updatedInput, updated);
  // Non-PreToolUse events never carry updatedInput.
  const post = JSON.parse(claude.serialize(
    context('note', { updatedToolInput: updated }),
    { ...input, event: 'PostToolUse' },
  ));
  assert.equal('updatedInput' in post.hookSpecificOutput, false);
  // Codex has no documented input rewrite — the meta is dropped, its evidence-marked
  // additionalContext channel stays intact.
  const codexOut = JSON.parse(makeClaudeAdapter('codex').serialize(
    context('note', { updatedToolInput: updated }),
    { ...input, host: 'codex' },
  ));
  assert.equal('updatedInput' in codexOut.hookSpecificOutput, false);
  assert.ok(String(codexOut.hookSpecificOutput.additionalContext).includes('note'));
});

test('codex: context carries versioned Traffic One provenance while Claude remains byte-for-byte unchanged', () => {
  const input = { event: 'SessionStart' as const, host: 'codex' as const, cwd: '/tmp/p', raw: {} };
  const codex = JSON.parse(makeClaudeAdapter('codex').serialize(context('hello session'), input));
  assert.equal(
    codex.hookSpecificOutput.additionalContext,
    '<!-- traffic-one-hook-context:v1 event=SessionStart -->\nhello session',
  );
  assert.equal(makeClaudeAdapter('codex').serialize(context(''), input), '');
  const metaOnly = JSON.parse(makeClaudeAdapter('codex').serialize(
    context('', { systemMessage: 'visible only', promptRequest: { id: 'confirm' } }),
    input,
  ));
  assert.equal(metaOnly.systemMessage, 'visible only');
  assert.deepEqual(metaOnly.promptRequest, { id: 'confirm' });
  assert.equal(metaOnly.hookSpecificOutput.additionalContext, '');
});

test('claude: no matching handler → empty stdout (noop)', async () => {
  const out = await dispatch(claude, [], {
    stdin: JSON.stringify({ hook_event_name: 'PostToolUse' }),
    argv: [],
  });
  assert.equal(out, '');
});

test('codex: exec_command hits the SAME canonical shell gate as Claude Bash', async () => {
  const codex = makeClaudeAdapter('codex');
  const handlers: Handler[] = [
    { id: 'shell-gate', event: 'PreToolUse', tools: ['shell'], priority: 0, run: () => deny('blocked') },
  ];
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    tool_input: { command: 'ls' },
  });
  const parsed = JSON.parse(await dispatch(codex, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'blocked');
  assert.equal(
    parsed.hookSpecificOutput.additionalContext,
    '<!-- traffic-one-hook-context:v1 event=PreToolUse -->',
  );
});

test('codex: namespaced multi-agent spawn hits spawn-agent gates', async () => {
  const codex = makeClaudeAdapter('codex');
  const handlers: Handler[] = [
    { id: 'spawn-gate', event: 'PreToolUse', tools: ['spawn-agent'], priority: 0, run: () => deny('claim required') },
  ];
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'multi_agent_v1.spawn_agent',
    tool_input: { agent_type: 'worker', message: 'You are the Traffic One senior-frontend role.' },
  });
  const parsed = JSON.parse(await dispatch(codex, handlers, { stdin, argv: [] }));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'claim required');
});

test('codex: exec_command parses cmd/workdir and routes context to the inner app', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-adapter-')));
  const child = path.join(root, 'one-nextjs');
  try {
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'package.json'), '{}', 'utf8');
    const codex = makeClaudeAdapter('codex');
    const handlers: Handler[] = [
      {
        id: 'inspect',
        event: 'PreToolUse',
        tools: ['shell'],
        priority: 0,
        run: (ctx) => context(`cwd=${ctx.cwd}\ncommand=${ctx.input.tool?.command || ''}`),
      },
    ];
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'exec_command',
      tool_input: { cmd: 'npm test', workdir: 'one-nextjs' },
      cwd: root,
    });
    const parsed = JSON.parse(await dispatch(codex, handlers, { stdin, argv: [] }));
    assert.equal(
      parsed.hookSpecificOutput.additionalContext,
      `<!-- traffic-one-hook-context:v1 event=PreToolUse -->\ncwd=${child}\ncommand=npm test`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claude: PreToolUse deny with userReason splits Error chrome from the agent recipe', () => {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd: '/tmp/p', raw: {} };
  const parsed = JSON.parse(claude.serialize(deny('no rm -rf', { userReason: 'Stay in this workspace.' }), input));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'Stay in this workspace.');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'no rm -rf');
});

test('claude: PreToolUse deny with userReason keeps existing context and joins the recipe', () => {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd: '/tmp/p', raw: {} };
  const parsed = JSON.parse(claude.serialize(
    deny('no rm -rf', { userReason: 'Stay in this workspace.', context: 'evidence marker' }),
    input,
  ));
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'Stay in this workspace.');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'evidence marker\n\nno rm -rf');
});

test('claude: Stop deny with userReason still uses result.reason as decision.reason', () => {
  const input: HookInput = { event: 'Stop', host: 'claude', cwd: '/tmp/p', raw: {} };
  const parsed = JSON.parse(claude.serialize(
    deny('post the setup link', { userReason: 'Stay in this workspace.' }),
    input,
  ));
  assert.equal(parsed.decision, 'block');
  assert.equal(parsed.reason, 'post the setup link');
  assert.equal('hookSpecificOutput' in parsed, false);
});

test('codex: deny WITH userReason keeps permissionDecisionReason as the recipe', () => {
  const codex = makeClaudeAdapter('codex');
  const input = { event: 'PreToolUse' as const, host: 'codex' as const, cwd: '/tmp/p', raw: {} };
  const parsed = JSON.parse(codex.serialize(deny('blocked', { userReason: 'Stay in this workspace.' }), input));
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'blocked');
  assert.notEqual(parsed.hookSpecificOutput.permissionDecisionReason, 'Stay in this workspace.');
  assert.equal(
    parsed.hookSpecificOutput.additionalContext,
    '<!-- traffic-one-hook-context:v1 event=PreToolUse -->',
  );
});

test('codex: deny context carries a PreToolUse provenance marker without changing the reason', () => {
  const codex = makeClaudeAdapter('codex');
  const input = { event: 'PreToolUse' as const, host: 'codex' as const, cwd: '/tmp/p', raw: {} };
  const parsed = JSON.parse(codex.serialize(deny('blocked', { context: 'repair this state' }), input));
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'blocked');
  assert.equal(
    parsed.hookSpecificOutput.additionalContext,
    '<!-- traffic-one-hook-context:v1 event=PreToolUse -->\nrepair this state',
  );
});

// ── Stop: a deny is a turn-end block ({"decision":"block","reason"}), not a
// tool permission. Codex additionally gets the marked additionalContext so a
// build that ignores Stop blocking still delivers the reason as context. ──

test('claude: Stop deny → {"decision":"block","reason"} (no PreToolUse permission shape)', async () => {
  const handlers: Handler[] = [
    { id: 'stop', event: 'Stop', priority: 0, run: () => deny('post the setup link') },
  ];
  const stdin = JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/p', session_id: 's' });
  const out = JSON.parse(await dispatch(claude, handlers, { stdin, argv: [] }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'post the setup link');
});

test('codex: Stop deny carries the block AND the marked additionalContext evidence channel', async () => {
  const handlers: Handler[] = [
    { id: 'stop', event: 'Stop', priority: 0, run: () => deny('post the setup link') },
  ];
  const stdin = JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/p', session_id: 's' });
  const out = JSON.parse(await dispatch(makeClaudeAdapter('codex'), handlers, { stdin, argv: [] }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'post the setup link');
  assert.equal(out.hookSpecificOutput?.hookEventName, 'Stop');
  assert.match(String(out.hookSpecificOutput?.additionalContext), /^<!-- traffic-one-hook-context:v1 event=Stop -->/);
});

test('claude: a Stop payload parses to the Stop event (never misparsed as PreToolUse)', () => {
  const parsed = claude.parse({
    stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/p', stop_hook_active: true }),
    argv: [],
  });
  assert.equal(parsed.event, 'Stop');
  assert.equal((parsed.raw as Record<string, unknown>).stop_hook_active, true);
});
