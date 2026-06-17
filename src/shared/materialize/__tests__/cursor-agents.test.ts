import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeCursorAgentFiles } from '../cursor-agents';
import { cursorAgentModel } from '../cursor-agent-model';

type Rec = Record<string, unknown>;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-agents-'));
}

test('writeCursorAgentFiles writes a .cursor/agents/<role>.md per team role with the resolved tier model', () => {
  const dir = tmp();
  try {
    const n = writeCursorAgentFiles(dir, { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } } as Rec);
    assert.ok(n >= 1, 'wrote at least one agent file');
    const agentsDir = path.join(dir, '.cursor', 'agents');
    assert.ok(fs.existsSync(path.join(agentsDir, 'senior-architect.md')), 'architect agent file exists');
    const body = fs.readFileSync(path.join(agentsDir, 'senior-architect.md'), 'utf8');
    assert.match(body, /^name: senior-architect$/m);
    assert.match(body, /^description: .+$/m);
    assert.match(body, /^model: \S+$/m);
    // The gate's reader returns the same model the file pins.
    const model = cursorAgentModel(dir, 'senior-architect');
    assert.ok(model && model.length > 0, 'cursorAgentModel reads the model');
    assert.ok(body.includes(`model: ${model}`), 'reader matches the written frontmatter');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCursorAgentFiles no-ops without a subagents team (no .cursor/agents dir)', () => {
  const dir = tmp();
  try {
    assert.equal(writeCursorAgentFiles(dir, { team: { mode: 'main-agent' }, performance: { level: 'low' } } as Rec), 0);
    assert.equal(fs.existsSync(path.join(dir, '.cursor', 'agents')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cursorAgentModel returns null when there is no agent file', () => {
  const dir = tmp();
  try {
    assert.equal(cursorAgentModel(dir, 'senior-architect'), null);
    assert.equal(cursorAgentModel(dir, ''), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
