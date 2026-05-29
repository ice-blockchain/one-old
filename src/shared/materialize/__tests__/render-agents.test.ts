import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { renderAgents, renderAgentsWithLocalContext, writeRootAgents, writeRootClaude } from '../render-agents';
import { GENERATED_MARKER, isGenerated } from '../generated';

const STATE = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };

test('renderAgents (lean) lists active rules/skills + kernel + read-routing + index', () => {
  const out = renderAgents(STATE, ['rules/common/auth-gate.md', 'rules/core.md'], ['project-memory'], {
    leanMode: true, mandatoryRules: ['rules/common/auth-gate.md'], referenceRules: ['rules/core.md'],
  });
  assert.ok(out.includes(GENERATED_MARKER));
  assert.ok(out.includes('- Stack: default'));
  assert.ok(out.includes('- .traffic-one/rules/common/auth-gate.md'));
  assert.ok(out.includes('- .traffic-one/skills/project-memory/SKILL.md'));
  assert.ok(out.includes('## Active Rule Kernel'));
  assert.ok(out.includes('per-user local preferences'));
  assert.ok(out.includes('Existing projects skip new-project MVP/mobile prompts'));
  assert.ok(out.includes('## Read Rules When'));
  assert.ok(out.includes('### Mandatory Baseline'));
  assert.ok(out.includes('### Reference On Demand'));
});

test('writeRootAgents writes a generated AGENTS.md; writeRootClaude creates CLAUDE.md; manual files preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-render-'));
  try {
    const content = renderAgentsWithLocalContext(dir, STATE, ['rules/common/auth-gate.md'], ['project-memory'], { mandatoryRules: ['rules/common/auth-gate.md'] });
    assert.equal(writeRootAgents(dir, content), true);
    assert.equal(isGenerated(path.join(dir, 'AGENTS.md')), true);
    assert.equal(writeRootClaude(dir), true);
    assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 't1-render2-'));
  try {
    fs.writeFileSync(path.join(dir2, 'AGENTS.md'), 'MANUAL', 'utf8');
    assert.equal(writeRootAgents(dir2, 'generated content'), false);
    assert.equal(fs.readFileSync(path.join(dir2, 'AGENTS.md'), 'utf8'), 'MANUAL');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});
