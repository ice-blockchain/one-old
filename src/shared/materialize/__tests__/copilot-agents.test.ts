import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COPILOT_AGENT_MARKER, isGeneratedCopilotAgent, writeCopilotAgentFiles } from '../copilot-agents';

test('writeCopilotAgentFiles skips user-authored agents without the generated marker', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-copilot-agents-'));
  const agentsDir = path.join(cwd, '.github', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const userFile = path.join(agentsDir, 'senior-architect.agent.md');
  fs.writeFileSync(userFile, '---\nname: senior-architect\n---\n\nUser-owned agent\n', 'utf8');
  const state = {
    team: { mode: 'subagents' },
    performance: { level: 'balanced' },
  };
  try {
    writeCopilotAgentFiles(cwd, state);
    assert.equal(fs.readFileSync(userFile, 'utf8').includes('User-owned agent'), true);
    assert.equal(isGeneratedCopilotAgent(userFile), false);
    const reviewer = path.join(agentsDir, 'senior-reviewer.agent.md');
    if (fs.existsSync(reviewer)) {
      const text = fs.readFileSync(reviewer, 'utf8');
      assert.ok(text.includes(COPILOT_AGENT_MARKER));
      assert.match(text, /^tools: \["view", "search", "bash"\]$/m);
      assert.doesNotMatch(text, /^model:/m);
    }
    const backend = path.join(agentsDir, 'senior-backend.agent.md');
    if (fs.existsSync(backend)) {
      assert.match(fs.readFileSync(backend, 'utf8'), /^tools: \["view", "search", "edit", "bash"\]$/m);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
