// Codex is a `plugin-injected-fallback` host whose children used to receive the
// FULL agent doc through the per-run context pack. 9cc08b53 removed the pack and
// replaced it with the ~7-bullet T1KERNEL excerpt — but unlike kilo/copilot/
// windsurf, Codex had no materialized role file to fall back on, so every
// invariant outside the kernel markers stopped reaching the role (observed 15co:
// senior-frontend wrote collapsed source repeatedly while the rule forbidding it
// sat ~186 lines outside its kernel).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_AGENTS_REL,
  CODEX_AGENT_MARKER,
  codexAgentRelPath,
  isGeneratedCodexAgent,
  writeCodexAgentFiles,
} from '../codex-agents';
import { roleContractsWritten } from '../role-contracts';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';

const FULL_STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

// Codex contracts live under `.traffic-one/agents/`, so the consent fence must
// be open. Prefs stay inside the fixture home — never `~/.traffic-one`.
function withConsentedProject(prefix: string, fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(cwd, '_home');
  fs.mkdirSync(home, { recursive: true });
  const saved = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
  };
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  resetPluginUseCache();
  try {
    recordPluginUseChoice(cwd, true, 'test');
    fn(cwd);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.XDG_STATE_HOME;
    if (saved.TRAFFIC_ONE_PROJECT_PREFS_PATH === undefined) {
      delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    } else {
      process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    }
    resetPluginUseCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('writeCodexAgentFiles materializes the full role contract, not the kernel excerpt', () => {
  withConsentedProject('t1-codex-agents-', (cwd) => {
    assert.ok(roleContractsWritten(writeCodexAgentFiles(cwd, FULL_STATE)) > 0);
    const frontend = path.join(cwd, CODEX_AGENTS_REL, 'senior-frontend.md');
    const text = fs.readFileSync(frontend, 'utf8');
    assert.ok(text.includes(CODEX_AGENT_MARKER));
    assert.equal(isGeneratedCodexAgent(frontend), true);
    // The point of the file: body the kernel cannot carry. The kernel is capped
    // at 2.5k chars, so a contract this size proves the full doc landed.
    assert.ok(text.length > 4000, `expected the full role contract, got ${text.length} chars`);
    // And the path the child is told to read must be the path we wrote.
    assert.equal(codexAgentRelPath('senior-frontend'), '.traffic-one/agents/senior-frontend.md');
    assert.ok(fs.existsSync(path.join(cwd, codexAgentRelPath('senior-frontend'))));
  });
});

test('writeCodexAgentFiles never overwrites a user-authored contract', () => {
  withConsentedProject('t1-codex-agents-user-', (cwd) => {
    const dir = path.join(cwd, CODEX_AGENTS_REL);
    fs.mkdirSync(dir, { recursive: true });
    const userFile = path.join(dir, 'senior-architect.md');
    fs.writeFileSync(userFile, '# my own architect contract\n', 'utf8');
    writeCodexAgentFiles(cwd, FULL_STATE);
    assert.equal(fs.readFileSync(userFile, 'utf8'), '# my own architect contract\n');
    assert.equal(isGeneratedCodexAgent(userFile), false);
  });
});

test('writeCodexAgentFiles sweeps a generated contract whose role fell out of eligibility', () => {
  withConsentedProject('t1-codex-agents-sweep-', (cwd) => {
    writeCodexAgentFiles(cwd, FULL_STATE);
    const frontend = path.join(cwd, CODEX_AGENTS_REL, 'senior-frontend.md');
    assert.ok(fs.existsSync(frontend), 'a web profile must have a frontend contract');
    // Backend-only: the frontend role is no longer eligible, so its generated
    // contract must go — a stale role file is an invitation to spawn that role.
    writeCodexAgentFiles(cwd, {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    });
    assert.equal(fs.existsSync(frontend), false);
    assert.ok(fs.existsSync(path.join(cwd, CODEX_AGENTS_REL, 'senior-backend.md')));
  });
});
