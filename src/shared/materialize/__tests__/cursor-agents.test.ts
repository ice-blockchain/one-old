import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeCursorAgentFiles } from '../cursor-agents';
import { cursorAgentModel } from '../cursor-agent-model';

type Rec = Record<string, unknown>;
const FULL_STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-agents-'));
}

test('writeCursorAgentFiles writes model-agnostic role contracts without local preferences', () => {
  const dir = tmp();
  try {
    const n = writeCursorAgentFiles(dir, FULL_STATE as Rec);
    assert.ok(n >= 1, 'wrote at least one agent file');
    const agentsDir = path.join(dir, '.cursor', 'agents');
    assert.ok(fs.existsSync(path.join(agentsDir, 'senior-architect.md')), 'architect agent file exists');
    const body = fs.readFileSync(path.join(agentsDir, 'senior-architect.md'), 'utf8');
    assert.match(body, /^name: senior-architect$/m);
    assert.match(body, /^description: .+$/m);
    assert.doesNotMatch(body, /^model:/m);
    assert.equal(cursorAgentModel(dir, 'senior-architect'), null);

    // The Cursor architect must carry the FULL role contract (not a 17-line stub) so the
    // host-only "Required project-memory baseline" ls-verify gate — which previously lived only in
    // agent.md and reached Codex/Claude but never Cursor — binds Cursor's composer architect too.
    assert.match(body, /Required project-memory baseline/, 'architect agent inlines the full role contract');
    assert.match(body, /ls \.traffic-one/, 'architect agent carries the baseline ls-verify-or-incomplete gate');
    assert.match(body, /PLAN_READY/, 'architect agent carries the PLAN_READY completion contract');

    const frontend = fs.readFileSync(path.join(agentsDir, 'senior-frontend.md'), 'utf8');
    assert.match(frontend, /demo\/seed fixtures/, 'Cursor frontend agent carries demo fixture fallback');
    assert.match(frontend, /blank panels/, 'Cursor frontend agent forbids sparse missing-config UI');

    // Every role gets its full contract, not just the architect: the reviewer's verdict tokens and
    // the tester's must be present so their detailed rubrics bind Cursor as well.
    const reviewer = fs.readFileSync(path.join(agentsDir, 'senior-reviewer.md'), 'utf8');
    assert.match(reviewer, /CHANGES_REQUESTED/, 'Cursor reviewer carries its full review contract');
    const tester = fs.readFileSync(path.join(agentsDir, 'senior-tester.md'), 'utf8');
    assert.match(tester, /TESTS_GREEN/, 'Cursor tester carries its full test contract');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCursorAgentFiles output is independent of local performance and preserves user-authored roles', () => {
  const dir = tmp();
  const other = tmp();
  try {
    const agentsDir = path.join(dir, '.cursor', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const custom = path.join(agentsDir, 'senior-architect.md');
    fs.writeFileSync(custom, '---\nname: custom\n---\nuser profile\n', 'utf8');

    writeCursorAgentFiles(dir, { ...FULL_STATE, team: { mode: 'main-agent' }, performance: { level: 'low' } } as Rec);
    writeCursorAgentFiles(other, { ...FULL_STATE, team: { mode: 'subagents' }, performance: { level: 'high' } } as Rec);

    assert.equal(fs.readFileSync(custom, 'utf8'), '---\nname: custom\n---\nuser profile\n');
    assert.equal(
      fs.readFileSync(path.join(dir, '.cursor', 'agents', 'senior-reviewer.md'), 'utf8'),
      fs.readFileSync(path.join(other, '.cursor', 'agents', 'senior-reviewer.md'), 'utf8'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
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
