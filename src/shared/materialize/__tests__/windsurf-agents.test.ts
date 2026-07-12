import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { WINDSURF_FREE_MODEL, WINDSURF_PAID_MODELS } from '../../../config/model-tiers';
import { WINDSURF_AGENT_MARKER, WINDSURF_AGENTS_REL, writeWindsurfAgentFiles } from '../windsurf-agents';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-agents-'));
}

function withPlan(plan: string, fn: () => void): void {
  const prev = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_USER_PLAN = plan;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prev;
  }
}

test('writeWindsurfAgentFiles writes .devin/agents/<role>/AGENT.md with Free SWE model', () => {
  withPlan('free', () => {
    const cwd = tmp();
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    const written = writeWindsurfAgentFiles(cwd, state);
    assert.ok(written >= 6);
    const architect = fs.readFileSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-architect', 'AGENT.md'), 'utf8');
    assert.ok(architect.includes(WINDSURF_AGENT_MARKER));
    assert.match(architect, new RegExp(`^model: ${JSON.stringify(WINDSURF_FREE_MODEL)}$`, 'm'));
    assert.match(architect, /^  - write$/m);
    const reviewer = fs.readFileSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-reviewer', 'AGENT.md'), 'utf8');
    assert.match(reviewer, /^permissions:\n  deny:\n    - write\n    - edit$/m);
  });
});

test('writeWindsurfAgentFiles pins paid profiles to the selected verified tier model', () => {
  withPlan('pro', () => {
    const cwd = tmp();
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    writeWindsurfAgentFiles(cwd, state);
    const architect = fs.readFileSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-architect', 'AGENT.md'), 'utf8');
    const tester = fs.readFileSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-tester', 'AGENT.md'), 'utf8');
    assert.match(architect, new RegExp(`^model: ${JSON.stringify(WINDSURF_PAID_MODELS.balanced)}$`, 'm'));
    assert.match(tester, new RegExp(`^model: ${JSON.stringify(WINDSURF_PAID_MODELS.cheapest)}$`, 'm'));
  });
});

test('writeWindsurfAgentFiles preserves user-authored Devin Local profiles', () => {
  withPlan('free', () => {
    const cwd = tmp();
    const dir = path.join(cwd, WINDSURF_AGENTS_REL, 'senior-architect');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'AGENT.md');
    fs.writeFileSync(target, '---\nname: custom\n---\nuser profile\n', 'utf8');
    const state = { team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' } };
    writeWindsurfAgentFiles(cwd, state);
    assert.equal(fs.readFileSync(target, 'utf8'), '---\nname: custom\n---\nuser profile\n');
  });
});

test('writeWindsurfAgentFiles removes generated profiles when switching to main-agent mode', () => {
  withPlan('free', () => {
    const cwd = tmp();
    writeWindsurfAgentFiles(cwd, { team: { mode: 'subagents' }, performance: { level: 'balanced' } });
    assert.equal(fs.existsSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-frontend', 'AGENT.md')), true);
    writeWindsurfAgentFiles(cwd, { team: { mode: 'main-agent' }, performance: { level: 'low' } });
    assert.equal(fs.existsSync(path.join(cwd, WINDSURF_AGENTS_REL, 'senior-frontend', 'AGENT.md')), false);
  });
});
