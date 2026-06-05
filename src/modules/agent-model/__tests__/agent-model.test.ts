import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { subagentStartBind } from '../subagent-bind';
import { inferTrafficOneSpawnRole } from '../role-infer';
import { GENERATED_MARKER } from '../../../shared/materialize';
import { readEffectiveState, resolveRunAgentContext } from '../../../shared/state';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

test('inferTrafficOneSpawnRole reads subagent_type, namespaced ids, and prose', () => {
  assert.equal(inferTrafficOneSpawnRole({ subagent_type: 'senior-frontend' }), 'senior-frontend');
  assert.equal(inferTrafficOneSpawnRole({ subagent_type: 'traffic-one:senior-backend' }), 'senior-backend');
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'You are the Traffic One senior-tester role.' }), 'senior-tester');
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'just do something' }), null);
});

// A fully-materialized new-project temp dir with performance/team in local prefs
// so readEffectiveState surfaces only the current user's choices.
function withMaterialized(opts: { teamApproved: boolean }, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-agentmodel-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // Pin a paid plan so the plan-aware gate resolves deterministic tiers regardless
  // of the test machine's real ~/.claude.json|~/.codex auth (a non-free plan inherits
  // DEFAULT_AGENT_TIERS → the high=highest behavior these assertions encode).
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
  fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'rule', 'utf8');
  fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 'skill', 'utf8');
  fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({
    generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `ctx\n${GENERATED_MARKER}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
    onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
  }), 'utf8');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', ...(opts.teamApproved ? { approved: true } : {}) },
  }), 'utf8');
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function spawnCtx(cwd: string, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host: 'claude', cwd, raw: { tool_name: 'Task', tool_input: toolInput },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('non-spawn tools are ignored', () => {
  const cwd = process.cwd();
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: { tool_name: 'Bash' }, tool: { class: 'shell' as ToolClass, rawName: 'Bash', command: 'ls' } };
  const ctx = { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
  assert.equal(agentModelGate(ctx).kind, 'noop');
});

test('team not approved → deny with the Team Confirmation prose', () => {
  withMaterialized({ teamApproved: false }, (cwd) => {
    const r = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('Team gate') && r.reason.includes('team.approved'));
  });
});

test('team approved but wrong model → deny model-param; correct model → allow', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'sonnet' }));
    assert.equal(wrong.kind, 'deny');
    if (wrong.kind === 'deny') assert.ok(wrong.reason.includes('Performance gate'));
    // high senior-frontend → highest tier → claude "opus"
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(ok.kind, 'noop');
  });
});

// Codex spawn ctx: namespaced multi-agent tool, role conveyed in the prose message
// (Codex passes agent_type:"worker", not a Traffic One subagent_type), session_id is
// the spawner/parent thread. Host 'codex' so the model tier resolves to gpt-5.5.
function codexSpawnCtx(cwd: string, toolInput: Record<string, unknown>, rawName = 'multi_agent_v1.spawn_agent'): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host: 'codex', cwd,
    raw: { tool_name: rawName, tool_input: toolInput, session_id: 'parent-thread-1' },
    tool: { class: 'spawn-agent' as ToolClass, rawName },
  };
  return { input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx;
}

function subagentStartCtx(cwd: string, raw: Record<string, unknown>): Ctx {
  const input: HookInput = { event: 'SubagentStart', host: 'codex', cwd, raw };
  return { input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx;
}

test('codex: namespaced spawn enforces gpt-5.5 and stakes a senior-frontend claim', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Wrong model (stale gpt-5-codex) is denied; gpt-5.5 is allowed.
    const wrong = agentModelGate(codexSpawnCtx(cwd, { model: 'gpt-5-codex', message: 'You are `senior-frontend` for Traffic One.' }));
    assert.equal(wrong.kind, 'deny');
    if (wrong.kind === 'deny') assert.ok(wrong.reason.includes('Performance gate'));

    const ok = agentModelGate(codexSpawnCtx(cwd, { model: 'gpt-5.5', message: 'You are `senior-frontend` for Traffic One.' }));
    assert.equal(ok.kind, 'noop');

    // The namespaced spawn staked a pending claim (proves the gate did not bail on the namespace).
    const state = readEffectiveState(cwd) as { currentRunId?: string };
    const pending = path.join(cwd, '.traffic-one', 'runs', String(state.currentRunId), 'pending');
    assert.equal(fs.readdirSync(pending).filter((f) => f.endsWith('.json')).length, 1);
  });
});

test('codex end-to-end: SubagentStart infers role from the child rollout, claims the thread, child write resolves it', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Codex fires no PreToolUse for the spawn; the child's rollout is what carries the
    // role. Write a minimal child transcript whose filename embeds the thread id and
    // whose spawn prompt names the role.
    const childThread = '019e7396-6543-7881-a4a9-dfe9d5a17807';
    const childTranscript = path.join(cwd, `rollout-2026-05-29T14-54-56-${childThread}.jsonl`);
    fs.writeFileSync(childTranscript, `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `You are the Traffic One senior-frontend role for ${cwd}. Build the UI.` }] },
    })}\n`, 'utf8');

    // SubagentStart fires in the parent context (session_id = parent) with the child agent_id + transcript.
    subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart', agent_id: childThread, session_id: 'orchestrator-parent', transcript_path: childTranscript,
    }));

    // The child's apply_patch reports the PARENT session_id but its own transcript_path →
    // resolves the claimed role by transcript threadId (no pending-claiming).
    const state = readEffectiveState(cwd);
    const child = resolveRunAgentContext(cwd, state, { session_id: 'orchestrator-parent', transcript_path: childTranscript }, { claimPending: false });
    assert.ok(child, 'expected the child write to resolve the claimed role via transcript threadId');
    assert.equal(child!.role, 'senior-frontend');
    assert.equal(child!.sessionId, childThread);

    // The orchestrator (its own transcript, no claim) resolves no role → main-agent writes stay blocked.
    const mainTranscript = path.join(cwd, 'rollout-2026-05-29T14-00-00-019e7389-8edd-7e50-b566-2e9a0d52b9d9.jsonl');
    assert.equal(resolveRunAgentContext(cwd, state, { session_id: 'orchestrator-parent', transcript_path: mainTranscript }, { claimPending: false }), null);
  });
});
