import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRE_TOOL_REMEDIATION,
  copilotPreToolDeny,
  cursorPreToolDeny,
  devinPreToolDeny,
  hasValidHookObjectPayload,
  isCursorPreToolSubcommand,
  isGatePreToolSubcommand,
  isWindsurfPreToolAction,
  nestedPreToolDeny,
  preToolFailureReason,
  wrapperPreToolDeny,
} from '../fail-closed';

test('hook payload validation accepts only JSON objects', () => {
  assert.equal(hasValidHookObjectPayload('{"tool_name":"x"}'), true);
  assert.equal(hasValidHookObjectPayload('{'), false);
  assert.equal(hasValidHookObjectPayload('[]'), false);
  assert.equal(hasValidHookObjectPayload('null'), false);
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
