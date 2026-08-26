// Fix-cycle and envelope-null SessionStart header: fallback hosts
// (`typedSubagents === false`) must still receive the write-gate kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { subagentRoleContext } from '../session-start-setup';
import { pluginRoot } from '../../../shared/paths';
import { HOST_CAPABILITIES } from '../../../shared/host/capability-schema';
import type { Ctx, HostId } from '../../../core/types';

const STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  onboardingComplete: true,
  mobile: { framework: 'none' },
};

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sstart-setup-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function ctx(host: HostId, cwd: string): Ctx {
  return { host, cwd, input: { raw: {}, event: 'SessionStart', host, cwd }, now: () => 'x' } as Ctx;
}

function header(host: HostId, cwd: string, spawnIndex: number): string {
  const res = subagentRoleContext(
    ctx(host, cwd),
    STATE as never,
    { role: 'senior-frontend', runId: 'R', spawnIndex } as never,
    pluginRoot(),
  );
  assert.equal(res.kind, 'context');
  return res.kind === 'context' ? res.context : '';
}

test('capability contract: Codex/Kilo/Windsurf/Copilot have no native agent-doc; Claude/Cursor/OpenCode do', () => {
  assert.equal(HOST_CAPABILITIES.codex.typedSubagents, false);
  assert.equal(HOST_CAPABILITIES.kilo.typedSubagents, false);
  assert.equal(HOST_CAPABILITIES.windsurf.typedSubagents, false);
  assert.equal(HOST_CAPABILITIES.copilot.typedSubagents, false);
  assert.equal(HOST_CAPABILITIES.claude.typedSubagents, true);
  assert.equal(HOST_CAPABILITIES.cursor.typedSubagents, true);
  assert.equal(HOST_CAPABILITIES.opencode.typedSubagents, true);
});

test('fix-cycle SessionStart injects the write-gate kernel on fallback hosts even with no envelope', () => {
  withProject((cwd) => {
    for (const host of ['codex', 'kilo', 'windsurf', 'copilot'] as const) {
      const body = header(host, cwd, 2);
      assert.ok(body.includes('FIX-CYCLE'), `${host} fix-cycle header`);
      assert.ok(
        body.includes('## Contract kernel'),
        `${host} typedSubagents:false still gets the kernel when the envelope is missing`,
      );
      assert.ok(body.includes('Do not skip write-gate rules'));
      assert.ok(!body.includes('If you only received a contract kernel this spawn'));
      assert.ok(
        !body.includes('Integration requirements'),
        `${host} has no envelope so no requirements section`,
      );
    }
  });
});

test('fix-cycle SessionStart does not inject the kernel on native-agent-doc hosts when the envelope is missing', () => {
  withProject((cwd) => {
    for (const host of ['claude', 'cursor'] as const) {
      const body = header(host, cwd, 2);
      assert.ok(body.includes('FIX-CYCLE'), `${host} fix-cycle header`);
      assert.ok(!body.includes('## Contract kernel'), `${host} typedSubagents:true does not invent a kernel`);
      assert.ok(
        !body.includes('predicates in your kernel'),
        `${host} must not claim a kernel that was not injected`,
      );
    }
  });
});

test('first-spawn envelope-null on a fallback host still injects the kernel', () => {
  withProject((cwd) => {
    const body = header('codex', cwd, 1);
    assert.ok(body.includes('## Contract kernel'));
    assert.ok(body.includes('write-gate predicates in your kernel'));
  });
});

test('first-spawn envelope-null on a native host does not claim kernel predicates', () => {
  withProject((cwd) => {
    const body = header('claude', cwd, 1);
    assert.ok(!body.includes('## Contract kernel'));
    assert.ok(!body.includes('predicates in your kernel'));
  });
});

test('fix-cycle names the contract path when that file exists on disk', () => {
  withProject((cwd) => {
    const rel = path.join('.traffic-one', 'agents', 'senior-frontend.md');
    fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), '# contract\n', 'utf8');
    const body = header('codex', cwd, 2);
    assert.ok(body.includes('.traffic-one/agents/senior-frontend.md'));
    assert.ok(body.includes('Read it once before your first write'));
    assert.ok(body.includes('## Contract kernel'));
    assert.ok(body.includes('The kernel above summarizes it'));
  });
});
