import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRE_TOOL_REMEDIATION,
  copilotPreToolDeny,
  cursorPreToolDeny,
  devinPreToolDeny,
  hasValidHookObjectPayload,
  hasValidPreToolPayload,
  isCursorPreToolSubcommand,
  isFailClosedRecoveryExemption,
  isGatePreToolSubcommand,
  isWindsurfPreToolAction,
  nestedPreToolDeny,
  preToolFailureReason,
  wrapperPreToolDeny,
} from '../fail-closed';
import { doctorScriptPath } from '../../shared/doctor-command';

test('hook payload validation accepts only JSON objects', () => {
  assert.equal(hasValidHookObjectPayload('{"tool_name":"x"}'), true);
  assert.equal(hasValidHookObjectPayload('{'), false);
  assert.equal(hasValidHookObjectPayload('[]'), false);
  assert.equal(hasValidHookObjectPayload('null'), false);
});

test('pre-tool payload validation requires the host-specific tool and project identity', () => {
  assert.equal(hasValidPreToolPayload('{"cwd":"/tmp"}', 'check-plan-write', 'nested'), false);
  assert.equal(hasValidPreToolPayload(JSON.stringify({
    cwd: '/tmp', tool_name: 'Write', tool_input: { file_path: 'x.ts', content: 'x' },
  }), 'check-plan-write', 'nested'), true);

  assert.equal(hasValidPreToolPayload(JSON.stringify({
    workspaceRoot: '/tmp', tool: { name: 'write', args: { file_path: 'x.ts' } },
  }), 'before-tool-use', 'wrapper'), true);
  assert.equal(hasValidPreToolPayload(JSON.stringify({ cwd: '/tmp', command: 'npm test' }), 'before-shell-execution', 'cursor'), true);
  assert.equal(hasValidPreToolPayload(JSON.stringify({
    workspace_roots: ['/tmp'], command: 'traffic-one-mcp', tool_name: 'get_config',
  }), 'before-mcp-execution', 'cursor'), true);
  assert.equal(hasValidPreToolPayload(JSON.stringify({
    cwd: '/tmp', tool_calls: [{ name: 'bash', args: { command: 'npm test' } }],
  }), 'before-tool-use', 'copilot'), true);
  assert.equal(hasValidPreToolPayload(JSON.stringify({
    workspace_root: '/tmp', tool_info: { cwd: '/tmp', command_line: 'npm test' },
  }), 'pre_run_command', 'windsurf'), true);
  assert.equal(hasValidPreToolPayload(JSON.stringify({
    tool_info: { file_path: '/tmp/src/a.ts', edits: [{ new_string: 'x' }] },
  }), 'pre_write_code', 'windsurf'), true,
  'Cascade file hooks can derive project identity from an absolute target path');
});

test('pre-tool fallback classifiers cover every host gate surface but not lifecycle/post hooks', () => {
  for (const subcommand of ['check-onboarding-gate', 'check-model-choice-gate', 'check-agent-model', 'check-plan-write', 'check-library-allowlist', 'pre-graphify-hint']) {
    assert.equal(isGatePreToolSubcommand(subcommand), true, subcommand);
  }
  for (const subcommand of ['session-start', 'user-prompt-submit', 'post-stack-setup', 'post-build-graphify']) {
    assert.equal(isGatePreToolSubcommand(subcommand), false, subcommand);
  }
  for (const subcommand of ['before-shell-execution', 'before-read-file', 'before-tool-use']) {
    assert.equal(isCursorPreToolSubcommand(subcommand), true, subcommand);
  }
  assert.equal(isCursorPreToolSubcommand('after-shell-execution'), false);
  for (const action of ['pre_read_code', 'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use']) {
    assert.equal(isWindsurfPreToolAction(action), true, action);
  }
  assert.equal(isWindsurfPreToolAction('pre_user_prompt'), false);
  assert.equal(isWindsurfPreToolAction('post_run_command'), false);
});

test('last-resort payloads deny in every host wire format', () => {
  const nested = JSON.parse(nestedPreToolDeny('Codex'));
  assert.equal(nested.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(nested.hookSpecificOutput.permissionDecisionReason, /fail-closed/);
  assert.equal(
    nested.hookSpecificOutput.additionalContext,
    '<!-- traffic-one-hook-context:v1 event=PreToolUse -->',
  );

  const claudeNested = JSON.parse(nestedPreToolDeny('Claude'));
  assert.equal(claudeNested.hookSpecificOutput.additionalContext, undefined);

  const cursor = JSON.parse(cursorPreToolDeny());
  assert.equal(cursor.permission, 'deny');
  assert.match(cursor.user_message, /fail-closed/);

  const copilotCli = JSON.parse(copilotPreToolDeny('cli'));
  assert.equal(copilotCli.permissionDecision, 'deny');
  const copilotVsCode = JSON.parse(copilotPreToolDeny('vscode'));
  assert.equal(copilotVsCode.hookSpecificOutput.permissionDecision, 'deny');

  for (const host of ['OpenCode', 'Kilo']) {
    const wrapped = JSON.parse(wrapperPreToolDeny(host));
    assert.equal(wrapped.kind, 'deny');
  }
  const devin = JSON.parse(devinPreToolDeny());
  assert.equal(devin.decision, 'block');
  assert.match(devin.reason, /fail-closed/);
});

test('every fail-closed reason ends with the shared remediation sentence', () => {
  assert.ok(preToolFailureReason('Kilo').endsWith(PRE_TOOL_REMEDIATION));
  assert.ok(preToolFailureReason('Cursor').includes('blocked fail-closed'));
});

// ── isFailClosedRecoveryExemption: the diagnostic must survive its own failure ──
// One case per host wire surface: the exact doctor recovery command is
// exempt, but nothing else that merely LOOKS like a shell call is.

test('the fail-closed doctor exemption recognizes the recovery command on the nested surface (Claude/Codex/Devin)', () => {
  const script = doctorScriptPath();
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command: `node ${script} --bundle` } }),
    'check-plan-write',
    'nested',
  ), true);
  // exec_command (Codex's tool name) also qualifies as a shell tool.
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'exec_command', tool_input: { command: `node ${script} --run 123` } }),
    'check-plan-write',
    'nested',
  ), true);
  // A non-shell tool never qualifies, however it is shaped.
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Write', tool_input: { file_path: 'x', content: `node ${script}` } }),
    'check-plan-write',
    'nested',
  ), false);
  // A shell command that is not doctor never qualifies.
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    'check-plan-write',
    'nested',
  ), false);
});

test('the fail-closed doctor exemption recognizes the recovery command on the cursor surface', () => {
  const script = doctorScriptPath();
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', command: `node ${script} --bundle` }),
    'before-shell-execution',
    'cursor',
  ), true);
  // Only the shell subcommand is ever eligible — a read/mcp subcommand never is,
  // even carrying the same command text under a different field.
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', file_path: `node ${script}` }),
    'before-read-file',
    'cursor',
  ), false);
});

test('the fail-closed doctor exemption recognizes the recovery command on the copilot surface (both call shapes)', () => {
  const script = doctorScriptPath();
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_calls: [{ name: 'bash', args: { command: `node ${script} --bundle` } }] }),
    'before-tool-use',
    'copilot',
  ), true);
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command: `node ${script}` } }),
    'before-tool-use',
    'copilot',
  ), true);
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_calls: [{ name: 'write', args: { file_path: 'x' } }] }),
    'before-tool-use',
    'copilot',
  ), false);
});

test('the fail-closed doctor exemption recognizes the recovery command on the windsurf surface', () => {
  const script = doctorScriptPath();
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ workspace_root: '/tmp', tool_info: { command_line: `node ${script} --run 123` } }),
    'pre_run_command',
    'windsurf',
  ), true);
  // A different pre-tool action (file write) is never eligible.
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ tool_info: { file_path: '/tmp/a.ts', command_line: `node ${script}` } }),
    'pre_write_code',
    'windsurf',
  ), false);
});

test('the fail-closed doctor exemption recognizes the recovery command on the wrapper surface (Kilo/OpenCode)', () => {
  const script = doctorScriptPath();
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool: { name: 'Bash', args: { command: `node ${script} --bundle` } } }),
    'before-tool-use',
    'wrapper',
  ), true);
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool: { name: 'write', args: { file_path: 'x' } } }),
    'before-tool-use',
    'wrapper',
  ), false);
});

// BLOCKER 3: the Copilot branch returned the FIRST shell command it found and
// exempted the WHOLE payload on it, so a batch whose first entry was doctor
// carried everything else through. A batch is exempt only if there is nothing
// in it but doctor.
test('a copilot tool_calls batch is exempt only when EVERY call is doctor', () => {
  const script = doctorScriptPath();
  const doctorCall = { name: 'bash', args: { command: `node ${script}` } };
  const rmCall = { name: 'bash', args: { command: 'rm -rf /' } };
  const exempt = (calls: unknown[]): boolean => isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_calls: calls }),
    'before-tool-use',
    'copilot',
  );
  assert.equal(exempt([doctorCall, rmCall]), false, 'doctor first, rm second');
  assert.equal(exempt([rmCall, doctorCall]), false, 'rm first, doctor second');
  assert.equal(exempt([doctorCall, doctorCall]), true, 'every call is doctor');
  assert.equal(exempt([doctorCall]), true, 'single doctor call');
  assert.equal(exempt([]), false, 'an empty batch is not a doctor invocation');
  // A non-shell sibling is not "not a shell command we can ignore" — it is an
  // unrelated action riding the same payload, so the batch is not exempt.
  assert.equal(exempt([doctorCall, { name: 'write', args: { file_path: 'x', content: 'y' } }]), false, 'doctor + a file write');
  // Copilot may send args as a JSON STRING (its adapter parses both), so the
  // exemption must read the same shape rather than silently under-matching.
  assert.equal(exempt([{ name: 'bash', args: JSON.stringify({ command: `node ${script}` }) }]), true, 'stringified args');
  assert.equal(
    exempt([{ name: 'bash', args: JSON.stringify({ command: `node ${script}` }) }, { name: 'bash', args: JSON.stringify({ command: 'rm -rf /' }) }]),
    false,
    'stringified args, second call is rm',
  );
});

// The other half of BLOCKER 3: judge the payload on the field the surface
// actually EXECUTES. The old shared reader put top-level `data.command` ahead
// of everything, which diverges from the Windsurf adapter (tool_info only).
test('each surface is judged on the command field its own adapter executes', () => {
  const script = doctorScriptPath();
  // Windsurf executes tool_info.command_line. A doctor string parked on a
  // top-level `command` sibling must NOT exempt an rm the host would run.
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ workspace_root: '/tmp', command: `node ${script}`, tool_info: { command_line: 'rm -rf /' } }),
    'pre_run_command',
    'windsurf',
  ), false, 'windsurf: doctor on the ignored field, rm on the executed one');
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ workspace_root: '/tmp', command: 'rm -rf /', tool_info: { command_line: `node ${script}` } }),
    'pre_run_command',
    'windsurf',
  ), true, 'windsurf: doctor on the executed field');
  // Claude/Codex execute tool_input.command; nothing top-level.
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', command: `node ${script}`, tool_input: { command: 'rm -rf /' } }),
    'check-plan-write',
    'nested',
  ), false, 'nested: doctor on the ignored field, rm on the executed one');
  assert.equal(isFailClosedRecoveryExemption(
    JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', command: 'rm -rf /', tool_input: { command: `node ${script}` } }),
    'check-plan-write',
    'nested',
  ), true, 'nested: doctor on the executed field');
});

test('the fail-closed doctor exemption never fires on unparseable stdin', () => {
  assert.equal(isFailClosedRecoveryExemption('{', 'check-plan-write', 'nested'), false);
  assert.equal(isFailClosedRecoveryExemption('not json', 'before-tool-use', 'wrapper'), false);
});
