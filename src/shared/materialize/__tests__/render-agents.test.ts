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
  // Skills are a compact name list with a single read-pattern line, not one
  // path per line — the list rides in every session's context.
  assert.ok(out.includes('Read `.traffic-one/skills/<name>/SKILL.md` when a task matches that skill.'));
  assert.ok(out.includes('project-memory'));
  assert.ok(!out.includes('- .traffic-one/skills/project-memory/SKILL.md'));
  assert.ok(out.includes('## Active Rule Kernel'));
  assert.ok(out.includes('never re-read root `AGENTS.md`'));
  assert.ok(out.includes('AUTO-RUN the senior role team'));
  assert.ok(out.includes('never probe package registries'));
  assert.ok(out.includes('per-user local preferences'));
  assert.ok(out.includes('Existing projects skip new-project MVP/mobile prompts'));
  assert.ok(out.includes('## Read Rules When'));
  assert.ok(out.includes('### Mandatory Baseline'));
  assert.ok(out.includes('### Reference On Demand'));
  // Lean mode must list each rule path EXACTLY ONCE (in the index), not also in a
  // redundant top "## Active Rules" block — that duplicated paths every session.
  const occurrences = out.split('- .traffic-one/rules/common/auth-gate.md').length - 1;
  assert.equal(occurrences, 1, 'rule path should appear once in lean mode');
  assert.ok(!out.includes('## Active Rules'), 'lean mode should not emit the redundant top rule list');
});

test('renderAgents (non-lean) keeps the Active Rules list + inlines rule bodies', () => {
  const out = renderAgents(STATE, ['rules/common/auth-gate.md'], ['project-memory'], { leanMode: false });
  assert.ok(out.includes('## Active Rules'));
  assert.ok(out.includes('## Active Rule Contents'));
  assert.ok(out.includes('## Active Skills'));
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

test('preserveManualRootContext strips tool-managed gitnexus blocks; pure-boilerplate files preserve nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-preserve-'));
  try {
    const gitnexusBlock = '<!-- gitnexus:start -->\n# GitNexus — Code Intelligence\nboilerplate\n<!-- gitnexus:end -->\n';
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), gitnexusBlock, 'utf8');
    const { preserveManualRootContext } = require('../render-agents') as typeof import('../render-agents');
    assert.equal(preserveManualRootContext(dir, 'AGENTS.md', { mode: 'new-project' }), true);
    // The root file is cleared for generation, but NO .local note is written —
    // the gitnexus block is regenerable boilerplate, not user content.
    assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'AGENTS.local.md')), false);

    // User-authored content AROUND a tool block is still preserved (block stripped).
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `My real notes.\n${gitnexusBlock}`, 'utf8');
    assert.equal(preserveManualRootContext(dir, 'CLAUDE.md', { mode: 'new-project' }), true);
    const preserved = fs.readFileSync(path.join(dir, '.traffic-one', 'CLAUDE.local.md'), 'utf8');
    assert.ok(preserved.includes('My real notes.'));
    assert.ok(!preserved.includes('gitnexus:start'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderAgentsWithLocalContext renders identical AGENTS/CLAUDE local bodies only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-localdup-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const body = 'Shared local notes body.';
    fs.writeFileSync(path.join(dir, '.traffic-one', 'AGENTS.local.md'), `# Preserved AGENTS.md\n\nintro\n\n---\n\n${body}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'CLAUDE.local.md'), `# Preserved CLAUDE.md\n\nintro\n\n---\n\n${body}\n`, 'utf8');
    const out = renderAgentsWithLocalContext(dir, STATE, ['rules/common/auth-gate.md'], ['project-memory'], { mandatoryRules: ['rules/common/auth-gate.md'] });
    assert.equal(out.split(body).length - 1, 1, 'identical preserved body must render once');
    assert.ok(out.includes('AGENTS.local.md'));
    assert.ok(!out.includes('### .traffic-one/CLAUDE.local.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Active State carries team mode, OpenCode flag, and the role→model line-up', () => {
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  delete process.env.TRAFFIC_ONE_HOST;
  process.env.TRAFFIC_ONE_USER_PLAN = 'max';
  try {
    const state = {
      ...STATE,
      team: { mode: 'subagents', approved: true },
      performance: { level: 'balanced' },
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.15.13' } },
    };
    const out = renderAgents(state, ['rules/common/auth-gate.md'], ['project-memory'], { leanMode: true, mandatoryRules: ['rules/common/auth-gate.md'] });
    assert.ok(out.includes('- Team: subagents (balanced, approved)'));
    assert.ok(out.includes('- OpenCode delegation: enabled'));
    assert.ok(out.includes('Role models (pass as `model` when spawning): architect='));
  } finally {
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
  }
});

test('Active State on Kilo gives the general-task marker recipe and omits role model ids', () => {
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  process.env.TRAFFIC_ONE_HOST = 'kilo';
  try {
    const state = {
      ...STATE,
      team: { mode: 'subagents', approved: true },
      performance: { level: 'balanced' },
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.15.13' } },
    };
    const out = renderAgents(state, ['rules/common/auth-gate.md'], ['project-memory'], { leanMode: true, mandatoryRules: ['rules/common/auth-gate.md'] });
    assert.ok(out.includes('- Team: subagents (balanced, approved)'));
    assert.ok(out.includes('- OpenCode delegation: off'));
    assert.ok(out.includes('Kilo subagents: use `task` with `subagent_type: "general"`'));
    assert.ok(out.includes('[t1-role: senior-<role>]'));
    assert.ok(!out.includes('Role models (pass as `model` when spawning):'));
    assert.ok(!out.includes('opencode/'));
  } finally {
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
  }
});

test('Active State omits team lines when no local prefs are present', () => {
  const out = renderAgents(STATE, ['rules/common/auth-gate.md'], ['project-memory'], { leanMode: true, mandatoryRules: ['rules/common/auth-gate.md'] });
  assert.ok(!out.includes('- Team:'));
  assert.ok(!out.includes('Role models'));
});
