import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { WINDSURF_AGENT_MARKER, WINDSURF_AGENTS_REL, writeWindsurfAgentFiles } from '../windsurf-agents';
import { roleContractsWritten } from '../role-contracts';

const FULL_STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-agents-'));
}

test('writeWindsurfAgentFiles writes model-agnostic contracts without local preferences', () => {
  const cwd = tmp();
  try {
    const outcome = writeWindsurfAgentFiles(cwd, FULL_STATE);
    assert.equal(outcome.kind, 'complete');
    assert.ok(roleContractsWritten(outcome) >= 6);
    const architect = fs.readFileSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-architect', 'AGENT.md'), 'utf8');
    assert.ok(architect.includes(WINDSURF_AGENT_MARKER));
    assert.doesNotMatch(architect, /^model:/m);
    assert.match(architect, /^  - write$/m);
    const reviewer = fs.readFileSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-reviewer', 'AGENT.md'), 'utf8');
    assert.match(reviewer, /^permissions:\n  deny:\n    - write\n    - edit$/m);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeWindsurfAgentFiles output is independent of local performance', () => {
  const low = tmp();
  const high = tmp();
  try {
    writeWindsurfAgentFiles(low, { ...FULL_STATE, team: { mode: 'main-agent' }, performance: { level: 'low' } });
    writeWindsurfAgentFiles(high, { ...FULL_STATE, team: { mode: 'subagents' }, performance: { level: 'high' } });
    assert.equal(
      fs.readFileSync(path.join(low, WINDSURF_AGENTS_REL, 'senior-tester', 'AGENT.md'), 'utf8'),
      fs.readFileSync(path.join(high, WINDSURF_AGENTS_REL, 'senior-tester', 'AGENT.md'), 'utf8'),
    );
  } finally {
    fs.rmSync(low, { recursive: true, force: true });
    fs.rmSync(high, { recursive: true, force: true });
  }
});

test('writeWindsurfAgentFiles preserves user-authored Devin Local profiles', () => {
  const cwd = tmp();
  try {
    const dir = path.join(cwd, WINDSURF_AGENTS_REL, 'senior-architect');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'AGENT.md');
    fs.writeFileSync(target, '---\nname: custom\n---\nuser profile\n', 'utf8');
    writeWindsurfAgentFiles(cwd, FULL_STATE);
    assert.equal(fs.readFileSync(target, 'utf8'), '---\nname: custom\n---\nuser profile\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeWindsurfAgentFiles keeps generated contracts when switching to main-agent mode', () => {
  const cwd = tmp();
  try {
    writeWindsurfAgentFiles(cwd, { ...FULL_STATE, team: { mode: 'subagents' }, performance: { level: 'balanced' } });
    assert.equal(fs.existsSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-frontend', 'AGENT.md')), true);
    writeWindsurfAgentFiles(cwd, { ...FULL_STATE, team: { mode: 'main-agent' }, performance: { level: 'low' } });
    assert.equal(fs.existsSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-frontend', 'AGENT.md')), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
