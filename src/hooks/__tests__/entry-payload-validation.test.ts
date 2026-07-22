import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runClaudeHook } from '../claude-entry';
import { runDevinHook } from '../devin-entry';
import { runKiloHook } from '../kilo-entry';
import { runOpenCodeHook } from '../opencode-entry';

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
