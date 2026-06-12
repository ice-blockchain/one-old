import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { extractSpawnedAgentId, recordSpawnedAgent } from '../record-agent';
import { subagentStartBind } from '../subagent-bind';
import { inferTrafficOneSpawnRole } from '../role-infer';
import { GENERATED_MARKER } from '../../../shared/materialize';
import { markOpenCodeRoleAttempted } from '../../../shared/opencode-roles';
import { readEffectiveState, readRunAgentRegistry, resolveRunAgentContext } from '../../../shared/state';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

test('inferTrafficOneSpawnRole reads subagent_type, namespaced ids, and prose', () => {
  assert.equal(inferTrafficOneSpawnRole({ subagent_type: 'senior-frontend' }), 'senior-frontend');
  assert.equal(inferTrafficOneSpawnRole({ subagent_type: 'traffic-one:senior-backend' }), 'senior-backend');
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'You are the Traffic One senior-tester role.' }), 'senior-tester');
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'just do something' }), null);
});

test('inferTrafficOneSpawnRole anchors on the declared role despite sibling mentions (Codex parallel spawn)', () => {
  // The Codex spawn carries no structured subagent_type (agent_type is the generic
  // "worker"); the role lives only in the message, which also names the SIBLING
  // role in a scope-coordination note. The primary "acting as Traffic One `<role>`"
  // declaration must win over the ambiguous count-the-mentions fallback.
  const frontend = {
    agent_type: 'worker',
    message:
      'You are acting as Traffic One `senior-frontend` for run-id 1780993268965 in /repo. ' +
      'You are not alone: senior-backend owns only `src/features/news/data.ts` and its types.',
  };
  const backend = {
    agent_type: 'worker',
    message:
      'You are acting as Traffic One `senior-backend` for run-id 1780993268965 in /repo. ' +
      'senior-frontend is running in parallel and owns UI/routes.',
  };
  assert.equal(inferTrafficOneSpawnRole(frontend), 'senior-frontend');
  assert.equal(inferTrafficOneSpawnRole(backend), 'senior-backend');
  // Plain (no backticks) and the architect single-mention case still resolve.
  assert.equal(inferTrafficOneSpawnRole({ message: 'You are acting as Traffic One senior-tester for run 1.' }), 'senior-tester');
  assert.equal(inferTrafficOneSpawnRole({ message: 'Acting as Traffic One senior-architect; produce the plan.' }), 'senior-architect');
  // A non-role declaration falls through to the unique-match fallback (here: none) → null.
  assert.equal(inferTrafficOneSpawnRole({ message: 'You are acting as Traffic One worker for some run.' }), null);
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

test('quick-fix maintenance worker is pinned to the cheapest model even at high tier', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Level is high (senior roles → opus), but the quick-fix worker resolves to the
    // cheapest tier → claude "haiku". A pricier model is denied; haiku is allowed.
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'opus' }));
    assert.equal(wrong.kind, 'deny');
    if (wrong.kind === 'deny') assert.ok(wrong.reason.includes('Performance gate'));
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }));
    assert.equal(ok.kind, 'noop');
  });
});

test('quick-fix pin is enforced on existing codebases too, and stakes a run claim', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // The per-role tier gate is new-project-only, but quick-fix must stay pinned
    // in the primary maintenance population: existing codebases.
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'opus' }));
    assert.equal(wrong.kind, 'deny');
    if (wrong.kind === 'deny') assert.ok(wrong.reason.includes('Performance gate'));

    // No model param at all → still denied (would inherit the parent model).
    const none = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix' }));
    assert.equal(none.kind, 'deny');

    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }));
    assert.equal(ok.kind, 'noop');
    // The allowed spawn staked a pending run claim so the run-team write gate
    // can resolve the worker's role on its first write.
    const runId = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    assert.ok(runId.length > 0, 'currentRunId minted');
    const pendingDir = path.join(cwd, '.traffic-one', 'runs', runId, 'pending');
    const pending = fs.readdirSync(pendingDir).filter((f) => f.startsWith('quick-fix-'));
    assert.ok(pending.length > 0, 'pending quick-fix claim staked');
  });
});

test('team.overrides cannot lift the quick-fix pin', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.team = { ...prefs.team, overrides: { 'quick-fix': 'highest' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    // Even with an explicit override to the highest tier, the pin holds.
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'opus' }));
    assert.equal(wrong.kind, 'deny');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' })).kind, 'noop');
  });
});

test('quick-fix is OpenCode-delegated first when OpenCode is active, then falls back to cheapest', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-Q';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));

    markOpenCodeRoleAttempted(cwd, 'run-Q', 'quick-fix');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' })).kind, 'noop');
  });
});

test('opencode role gate: a configured role is denied until OpenCode is tried, then allowed (fallback)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Enable OpenCode + set a currentRunId so the gate can scope the attempt marker.
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-X';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    // senior-frontend is in the default delegateRoles → deny until OpenCode tried
    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));

    // runner records the attempt → gate falls through to the normal model check → allow
    markOpenCodeRoleAttempted(cwd, 'run-X', 'senior-frontend');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' })).kind, 'noop');

    // a role NOT in the configured set (senior-backend) is never opencode-gated
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'noop');
  });
});

test('opencode role gate: mints currentRunId when absent (existing-codebase) so enforcement is not skipped', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    // The exact gap: existing-codebase + NO currentRunId. ensureRunAgentClaim is
    // never reached for this mode, so before the fix the gate silently skipped.
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    delete one.currentRunId;
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    // senior-frontend (a default delegate role) → the gate mints a run id + denies.
    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));

    // The minted run id was persisted to .one.json (so the runner + next gate agree).
    const minted = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    assert.ok(minted.length > 0, 'currentRunId should be minted + persisted');

    // Recording the attempt under the minted run id lets the fallback spawn through.
    markOpenCodeRoleAttempted(cwd, minted, 'senior-frontend');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' })).kind, 'noop');
  });
});

test('opencode role gate: NO-DEADLOCK — denies a (run, role) at most once even when no attempt is ever recorded', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // The live Codex failure mode: the host's safety reviewer rejects the
    // opencode_delegate MCP call ABOVE our code, so the runner never writes the
    // attempt marker. The gate must still let the second spawn through, or the
    // delegate path AND the spawn path are both blocked forever.
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-reviewer-reject';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    // First spawn → denied (with the delegate instructions), deny recorded.
    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    // Second spawn, with NO attempt marker (delegate was rejected externally) → allowed.
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' })).kind, 'noop');
  });
});

test('opencode role gate: deny block is clean (no leftover template placeholders)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-clean';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') {
      assert.ok(denied.reason.includes('OpenCode role gate'));
      assert.ok(denied.reason.includes('opencode_delegate'));
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(denied.reason), 'all template placeholders must be substituted away');
    }
  });
});

test('codex: OpenCode role gate fires the SAME as every host (host-agnostic)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-codex';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    // A configured role on Codex is delegated to OpenCode first, exactly like Claude/Cursor.
    const denied = agentModelGate(codexSpawnCtx(cwd, {
      agent_type: 'worker',
      message: 'You are acting as Traffic One `senior-frontend` for this Codex run.',
      model: 'gpt-5.5',
    }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));
    // Deny-once: a second spawn (no attempt recorded — e.g. tool unavailable) falls through.
    assert.equal(agentModelGate(codexSpawnCtx(cwd, {
      agent_type: 'worker',
      message: 'You are acting as Traffic One `senior-frontend` for this Codex run.',
      model: 'gpt-5.5',
    })).kind, 'noop');
  });
});

test('a pinned openCode.model does not change gating (no per-model branch)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true, model: 'opencode/gpt-5.1-codex' };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-pinned';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') {
      assert.ok(denied.reason.includes('OpenCode role gate'));
      // the gate no longer injects a per-model instruction into the deny
      assert.ok(!denied.reason.includes('opencode/gpt-5.1-codex'));
    }
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

// ── Subagent reuse: recorder + duplicate-spawn deny ──────────────────────────

function withTeamsEnv(fn: () => void): void {
  const prev = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = prev;
  }
}

function setCurrentRunId(cwd: string, runId: string): void {
  const file = path.join(cwd, '.traffic-one', '.one.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  state.currentRunId = runId;
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
}

function spawnCtxWithSession(cwd: string, toolInput: Record<string, unknown>, sessionId: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host: 'claude', cwd,
    raw: { tool_name: 'Task', tool_input: toolInput, session_id: sessionId },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function postSpawnCtx(cwd: string, toolInput: Record<string, unknown>, toolResponse: unknown, sessionId: string): Ctx {
  const input: HookInput = {
    event: 'PostToolUse', host: 'claude', cwd,
    raw: { tool_name: 'Task', tool_input: toolInput, tool_response: toolResponse, session_id: sessionId },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('extractSpawnedAgentId reads the Agent result footer in string and structured payloads', () => {
  assert.equal(
    extractSpawnedAgentId("READY\nagentId: add5367d74354d9b3 (use SendMessage with to: 'add5367d74354d9b3' to continue this agent)"),
    'add5367d74354d9b3',
  );
  assert.equal(
    extractSpawnedAgentId({ content: [{ type: 'text', text: 'done. agentId: a99c9f8a723f92f77 (use SendMessage…)' }] }),
    'a99c9f8a723f92f77',
  );
  // Structured spelling: a payload carrying the id as a JSON field is scanned
  // as serialized JSON ("agentId":"…") and must match too.
  assert.equal(extractSpawnedAgentId({ agentId: 'deadbeef12345678', content: [] }), 'deadbeef12345678');
  // No labelled id → null (a bare sha in the reply must NOT be captured).
  assert.equal(extractSpawnedAgentId('committed 4e66b2882da9afb9747468b08a253ca2f09c85f3'), null);
  assert.equal(extractSpawnedAgentId(undefined), null);
});

test('reuse: recorder persists the agent id, duplicate same-role spawn is denied with SendMessage prose', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-reuse-1');
      // First spawn returns an agentId → PostToolUse records it.
      const rec = recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: 'opus', prompt: 'build the UI' },
        "READY agentId: abc123def456789 (use SendMessage with to: 'abc123def456789' to continue this agent)",
        'parent-1',
      ));
      assert.equal(rec.kind, 'noop');
      const registry = readRunAgentRegistry(cwd, 'run-reuse-1');
      assert.equal(registry['senior-frontend']?.agentId, 'abc123def456789');

      // Second senior-frontend spawn from the SAME parent session → deny, naming the id.
      const dup = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-frontend', model: 'opus', prompt: 'part 2: admin area' }, 'parent-1'));
      assert.equal(dup.kind, 'deny');
      if (dup.kind === 'deny') {
        assert.ok(dup.reason.includes('abc123def456789'), 'deny prose names the live agent id');
        assert.ok(dup.reason.includes('SendMessage'), 'deny prose teaches the continuation tool');
        assert.ok(dup.reason.includes('[t1-replace-agent]'), 'deny prose teaches the escape hatch');
      }

      // A DIFFERENT role is unaffected (backend spawns fresh).
      const other = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-backend', model: 'opus', prompt: 'build the API' }, 'parent-1'));
      assert.equal(other.kind, 'noop');

      // A different PARENT session never blocks: in-process agents died with their session.
      const otherSession = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-frontend', model: 'opus', prompt: 'resume after restart' }, 'parent-2'));
      assert.equal(otherSession.kind, 'noop');
    });
  });
});

test('reuse: the replace marker retires the recorded agent and lets ONE replacement spawn through', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-reuse-2');
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-tester', model: 'haiku', prompt: 'write tests' },
        'agentId: tester11aa22bb33',
        'parent-1',
      ));
      // Marker spawn passes the reuse gate (and marks the old entry replaced)…
      const replaced = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-tester', model: 'haiku', prompt: 'context exhausted, fresh start [t1-replace-agent] — rerun the suite' },
        'parent-1',
      ));
      assert.equal(replaced.kind, 'noop');
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-2')['senior-tester']?.replaced, true);
      // …and a later duplicate (no marker, nothing re-recorded yet) is NOT blocked by the retired entry.
      const after = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-tester', model: 'haiku', prompt: 'rerun' }, 'parent-1'));
      assert.equal(after.kind, 'noop');
    });
  });
});

test('reuse: without the teams env flag the gate and recorder are inert (non-teams hosts unchanged)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prev = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    try {
      setCurrentRunId(cwd, 'run-reuse-3');
      const rec = recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: 'opus', prompt: 'build' },
        'agentId: noflag111222333',
        'parent-1',
      ));
      assert.equal(rec.kind, 'noop');
      assert.equal(Object.keys(readRunAgentRegistry(cwd, 'run-reuse-3')).length, 0, 'no registry write without the flag');
      const dup = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-frontend', model: 'opus', prompt: 'again' }, 'parent-1'));
      assert.equal(dup.kind, 'noop');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = prev;
    }
  });
});

// Codex shapes: spawn_agent returns snake_case `agent_id`, and continuation
// (send_input) is native — no Claude feature flag involved. Both were misses
// that left the registry empty / the regime disabled on Codex.
test('extractSpawnedAgentId reads Codex snake_case agent_id (structured and serialized)', () => {
  const { extractSpawnedAgentId } = require('../record-agent') as typeof import('../record-agent');
  assert.equal(extractSpawnedAgentId({ agent_id: '019ebb7f-0691-7281-b686-27e7fe6b393f', nickname: 'Volta' }), '019ebb7f-0691-7281-b686-27e7fe6b393f');
  assert.equal(extractSpawnedAgentId('{"agent_id":"019ebb7f-0842-7a93-8a9f-674d63b8c556","nickname":"Arendt"}'), '019ebb7f-0842-7a93-8a9f-674d63b8c556');
});

test('subagentContinuationAvailable is true on Codex without the Claude flag, and the flag still force-disables', async () => {
  const { subagentContinuationAvailable } = await import('../../../shared/state/run-agent');
  assert.equal(subagentContinuationAvailable({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex-desktop' } as NodeJS.ProcessEnv), true);
  assert.equal(subagentContinuationAvailable({ CODEX_PLUGIN_ROOT: '/x' } as NodeJS.ProcessEnv), true);
  assert.equal(subagentContinuationAvailable({ CODEX_PLUGIN_ROOT: '/x', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv), false);
  assert.equal(subagentContinuationAvailable({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } as NodeJS.ProcessEnv), true);
});
