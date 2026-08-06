import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runClaudeHook } from '../claude-entry';
import { runCursorHook } from '../cursor-entry';
import { runDevinHook } from '../devin-entry';
import { runKiloHook } from '../kilo-entry';
import { runOpenCodeHook } from '../opencode-entry';
import { doctorScriptPath } from '../../shared/doctor-command';

const INVALID_HOOK_PAYLOADS = ['{', '[]', '{}', JSON.stringify({ cwd: process.cwd() })] as const;
const INVALID_LIFECYCLE_PAYLOADS = ['{', '[]'] as const;

test('malformed and non-object pre-tool payloads fail closed on every affected entry point', async () => {
  for (const stdin of INVALID_HOOK_PAYLOADS) {
    const claude = JSON.parse((await runClaudeHook('check-plan-write', stdin, {
      ...process.env,
      TRAFFIC_ONE_HOST: 'claude',
    })).stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(claude.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(claude.hookSpecificOutput?.permissionDecisionReason ?? '', /Traffic One Claude pre-tool gate.*fail-closed/);

    const codex = JSON.parse((await runClaudeHook('check-plan-write', stdin, {
      ...process.env,
      TRAFFIC_ONE_HOST: 'codex',
    })).stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(codex.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(codex.hookSpecificOutput?.permissionDecisionReason ?? '', /Traffic One Codex pre-tool gate.*fail-closed/);

    const opencode = JSON.parse((await runOpenCodeHook('before-tool-use', stdin)).stdout) as { kind?: string; reason?: string };
    assert.equal(opencode.kind, 'deny');
    assert.match(opencode.reason ?? '', /Traffic One OpenCode pre-tool gate.*fail-closed/);

    const kilo = JSON.parse((await runKiloHook('before-tool-use', stdin)).stdout) as { kind?: string; reason?: string };
    assert.equal(kilo.kind, 'deny');
    assert.match(kilo.reason ?? '', /Traffic One Kilo pre-tool gate.*fail-closed/);

    const devin = JSON.parse((await runDevinHook('check-plan-write', stdin)).stdout) as { decision?: string; reason?: string };
    assert.equal(devin.decision, 'block');
    assert.match(devin.reason ?? '', /Traffic One Windsurf\/Devin pre-tool gate.*fail-closed/);
  }
});

test('the doctor recovery command survives the early payload-validation fail-closed check, on every entry point', async () => {
  // These payloads carry NO workspace identity (no cwd/projectRoot/…), which
  // hasValidPreToolPayload requires and would otherwise deny outright — proving
  // this is the doctor exemption firing, not merely "the payload was valid".
  const script = doctorScriptPath();

  const claude = await runClaudeHook('check-plan-write', JSON.stringify({
    tool_name: 'Bash', tool_input: { command: `node ${script} --bundle` },
  }), { ...process.env, TRAFFIC_ONE_HOST: 'claude' });
  assert.equal(claude.stdout, '', 'claude: exempt payload never dispatches, so no deny is emitted');

  const cursor = await runCursorHook('before-shell-execution', JSON.stringify({
    command: `node ${script} --run 123`,
  }));
  assert.equal(JSON.parse(cursor.stdout).permission, undefined, 'cursor: exempt payload is not the deny envelope');

  const opencode = await runOpenCodeHook('before-tool-use', JSON.stringify({
    tool_name: 'Bash', tool_input: { command: `node ${script}` },
  }));
  assert.equal(JSON.parse(opencode.stdout).kind, 'noop');

  const kilo = await runKiloHook('before-tool-use', JSON.stringify({
    tool: { name: 'Bash', args: { command: `node ${script} --bundle` } },
  }));
  assert.equal(JSON.parse(kilo.stdout).kind, 'noop');

  const devin = await runDevinHook('check-plan-write', JSON.stringify({
    tool_name: 'Bash', tool_input: { command: `node ${script} --run 456` },
  }));
  assert.equal(devin.stdout, '');
});

test('a shell command that only resembles doctor (wrong path/argv) stays denied with no workspace identity', async () => {
  const claude = await runClaudeHook('check-plan-write', JSON.stringify({
    tool_name: 'Bash', tool_input: { command: 'node /tmp/evil/doctor.cjs' },
  }), { ...process.env, TRAFFIC_ONE_HOST: 'claude' });
  const out = JSON.parse(claude.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
});

test('malformed and non-object lifecycle payloads remain fail open', async () => {
  for (const stdin of INVALID_LIFECYCLE_PAYLOADS) {
    assert.equal((await runClaudeHook('post-stack-setup', stdin, {
      ...process.env,
      TRAFFIC_ONE_HOST: 'claude',
    })).stdout, '');
    assert.equal((await runClaudeHook('post-stack-setup', stdin, {
      ...process.env,
      TRAFFIC_ONE_HOST: 'codex',
    })).stdout, '');

    assert.equal(JSON.parse((await runOpenCodeHook('after-tool-use', stdin)).stdout).kind, 'noop');
    assert.equal(JSON.parse((await runKiloHook('after-tool-use', stdin)).stdout).kind, 'noop');
    assert.equal((await runDevinHook('post-stack-setup', stdin, {
      ...process.env,
      TRAFFIC_ONE_AUTH: 'off',
    })).stdout, '');
  }
});
