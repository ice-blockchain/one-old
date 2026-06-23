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
import { modelChoicePrompted, writeModelChoice } from '../model-choice';
import { markOpenCodePlanBatchComplete, markOpenCodePlanRoleCompleted, markOpenCodeRoleAttempted } from '../../../shared/opencode-roles';
import { hookSessionIdentity, readEffectiveState, readRunAgentRegistry, resolveRunAgentContext } from '../../../shared/state';
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
// Default captured Cursor model list (a realistic higher-plan build, incl. screenshot-style
// reasoning suffixes). Written to .traffic-one/cursor-models.json so the capture precondition
// is satisfied and tests exercise model validation. Pass cursorModels: null to opt OUT (to
// exercise the capture precondition itself).
const DEFAULT_CURSOR_MODELS = [
  'claude-opus-4-8-thinking-high', 'claude-opus-4-7-thinking-max', 'claude-fable-5-thinking-high',
  'gpt-5.5-medium', 'gpt-5.5-extra-high', 'composer-2.5-fast',
];

function withMaterialized(opts: { teamApproved: boolean; cursorModels?: string[] | null }, fn: (cwd: string) => void): void {
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
  const cursorModels = opts.cursorModels === undefined ? DEFAULT_CURSOR_MODELS : opts.cursorModels;
  if (cursorModels) {
    fs.writeFileSync(path.join(t1, 'cursor-models.json'), JSON.stringify({ models: cursorModels }), 'utf8');
  }
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function spawnCtx(cwd: string, toolInput: Record<string, unknown>, host: 'claude' | 'codex' | 'cursor' = 'claude', workspaceRoot?: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host, cwd, workspaceRoot, raw: { tool_name: 'Task', tool_input: toolInput },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

// Queue one bounded OpenCode unit for `role` in plan.md — the OpenCode role gate
// only forces delegation-first for roles the architect actually QUEUED work for.
function queueDelegateRole(cwd: string, role: string): void {
  queueDelegateRoles(cwd, [role]);
}

function queueDelegateRoles(cwd: string, roles: string[]): void {
  const t1 = path.join(cwd, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(
    path.join(t1, 'plan.md'),
    `<!-- opencode-delegate:start -->\n${roles.map((role, index) => `- id: ${role.replace(/^senior-/, '')}-${index + 1} | role: ${role} | files: x.ts | task: one bounded unit. Acceptance: ok.`).join('\n')}\n<!-- opencode-delegate:end -->\n`,
    'utf8',
  );
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

test('spawn whose prompt fabricates a non-currentRunId run-id is denied, naming the correct id', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // A clean architect spawn mints currentRunId.
    agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'opus' }));
    const runId = (JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string) || '';
    assert.ok(runId.length > 0, 'currentRunId minted');

    // A spawn prompt with a fabricated ISO run-id path → denied, naming both ids.
    const bad = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-architect', model: 'opus',
      prompt: 'You are the architect. Write .traffic-one/runs/2026-06-17T13-47-00Z/assignments.json and digests/2026-06-17T13-47-00Z/architect.md',
    }));
    assert.equal(bad.kind, 'deny');
    if (bad.kind === 'deny') {
      assert.ok(bad.reason.includes('run-id gate'), 'is the run-id gate deny');
      assert.ok(bad.reason.includes('2026-06-17T13-47-00Z'), 'names the stray id');
      assert.ok(bad.reason.includes(runId), 'names the correct currentRunId');
      // SELF-HEALING: the deny echoes the spawn prompt with the stray id ALREADY replaced by
      // currentRunId, so a weak orchestrator can copy-paste it instead of "rebuilding" (and falling
      // back to an inline build). The corrected runs/digests paths must carry the right id.
      assert.ok(/RE-ISSUE THE SAME/i.test(bad.reason), 'instructs re-issuing the same spawn');
      assert.ok(bad.reason.includes(`runs/${runId}/assignments.json`), 'echoes the corrected prompt (stray id replaced)');
      assert.ok(bad.reason.includes(`digests/${runId}/architect.md`), 'corrects every stray occurrence');
    }

    // The SAME prompt using currentRunId does not trip the run-id gate.
    const ok = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-architect', model: 'opus',
      prompt: `You are the architect. Write .traffic-one/runs/${runId}/assignments.json and digests/${runId}/architect.md`,
    }));
    assert.ok(!(ok.kind === 'deny' && ok.reason.includes('run-id gate')), 'correct run-id must not trip the gate');
  });
});

test('Cursor: model-param requires an exact captured Task-tool slug before staking a claim', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // high senior-frontend → highest tier → cursor "claude-opus-4-8-thinking-high" (the exact
    // Task-tool slug). The bare Anthropic alias Cursor rejects → deny (the original tester bug).
    // A no/wrong-model spawn is an ORCHESTRATOR-actionable deny — the plain per-role model-tier
    // deny ("pass model=X") — NOT the user-facing budget/disabled CHOICE (that is reserved for a
    // genuine Composer-floor degradation; see degradedToFloorDeny). So the alias here denies with
    // the "Performance gate … pass model" prose, not the enable/fallback question.
    const firstWrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }, 'cursor'));
    assert.equal(firstWrong.kind, 'deny');
    if (firstWrong.kind === 'deny') assert.ok(firstWrong.reason.includes('Performance gate'), 'no/wrong-model spawn gets the plain per-role model deny, not the choice');

    // gpt-5.5-medium is a BALANCED Task-tool slug, NOT highest → deny: no cross-tier acceptance.
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'gpt-5.5-medium' }, 'cursor'));
    assert.equal(wrong.kind, 'deny');
    if (wrong.kind === 'deny') assert.ok(wrong.reason.includes('Performance gate'));

    // No model param → deny (would inherit the parent model).
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend' }, 'cursor')).kind, 'deny');

    // A family alias or invented sub-variant satisfies the tier but is NOT an exact Cursor Task id.
    // Deny before Cursor sees the Task call, otherwise it creates a visible "Couldn't start" card.
    const bareFamily = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8' }, 'cursor'));
    assert.equal(bareFamily.kind, 'deny');
    if (bareFamily.kind === 'deny') {
      assert.ok(bareFamily.reason.includes('Cursor model gate'));
      assert.ok(bareFamily.reason.includes('claude-opus-4-8-thinking-high'));
    }
    const invented = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high-fast' }, 'cursor'));
    assert.equal(invented.kind, 'deny');
    if (invented.kind === 'deny') assert.ok(invented.reason.includes('Cursor model gate'));

    // The exact highest Task-tool slug passes.
    // The FIRST passing Cursor spawn of the run also carries the one-time model-availability
    // advisory (kind 'context'); it is still an ALLOW (not a deny) and stakes the claim.
    assert.notEqual(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor')).kind, 'deny');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const runId = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    assert.ok(runId.length > 0, 'currentRunId minted on Cursor spawn');
    const pending = fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId, 'pending')).filter((f) => f.startsWith('senior-frontend-'));
    assert.ok(pending.length > 0, 'pending senior-frontend claim staked on Cursor');
  });
});

test('Cursor: the configured same-tier FALLBACK model satisfies the gate when the build lacks the preferred slug', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // highest preferred = claude-opus-4-8-thinking-high; if a build doesn't offer it, the
    // configured same-tier fallback (claude-fable-5-thinking-high — Cursor's "highest alternate")
    // satisfies the tier via the accept-set and stakes a claim, instead of deadlocking.
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    // Allowed (first passing spawn of the run may carry the one-time model-availability advisory).
    assert.notEqual(ok.kind, 'deny', 'the configured same-tier fallback satisfies the gate');
    const runId = (JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string) || '';
    const pending = fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId, 'pending')).filter((f) => f.startsWith('senior-frontend-'));
    assert.ok(pending.length > 0, 'claim staked on the fallback-model spawn');
  });
});

test('Cursor: spawn gate resolves subpackage cwd to the workspace root before writing run state', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const pkg = path.join(cwd, 'packages', 'ui');
    fs.mkdirSync(pkg, { recursive: true });
    const r = agentModelGate(spawnCtx(pkg, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor', cwd));
    assert.notEqual(r.kind, 'deny', 'valid spawn from a package cwd is allowed');

    const rootState = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    const runId = String(rootState.currentRunId || '');
    assert.ok(runId.length > 0, 'currentRunId is minted on the workspace root');
    assert.equal(fs.existsSync(path.join(pkg, '.traffic-one', '.one.json')), false, 'no stray package .traffic-one state is created');
    const pendingDir = path.join(cwd, '.traffic-one', 'runs', runId, 'pending');
    const pending = fs.readdirSync(pendingDir).filter((f) => f.startsWith('senior-frontend-'));
    assert.ok(pending.length > 0, 'run claim is staked under the workspace root');
  });
});

test('Cursor: a highest role degrading to composer-2.5-fast (budget exhausted) surfaces the choice ONCE, then proceeds', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // At 100% API usage Cursor makes the premium models unavailable and the orchestrator passes
    // composer-2.5-fast (the included "Auto + Composer" floor). composer SATISFIES the tier
    // (universal floor), but for a HIGHEST role that's a silent downgrade — so the gate surfaces
    // the choice ONCE (visible deny) naming both causes (budget / disabled) + the fallback.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.equal(first.kind, 'deny', 'degradation to Composer floor is surfaced, not silently allowed');
    if (first.kind === 'deny') {
      assert.ok(/budget|disabled|enable/i.test(first.reason), 'names the budget/disabled causes + remedy');
      assert.ok(first.reason.includes('composer-2.5-fast'), 'names the Composer fallback it would drop to');
    }
    // Without explicit consent, further composer spawns stay blocked (fail closed).
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.equal(second.kind, 'deny', 'without explicit use-fallback, Composer floor stays blocked');
    const runId = (JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string) || '';
    writeModelChoice(cwd, runId, 'use-fallback');
    const third = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.notEqual(third.kind, 'deny', 'recorded use-fallback proceeds on the Composer floor');
  });
});

test('Cursor: senior-tester / quick-fix on composer is NOT flagged as degradation (cheapest tier wants Composer)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // tester is the cheapest tier → Composer is its CORRECT model, not a downgrade → no prompt.
    const tester = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'composer-2.5-fast' }, 'cursor'));
    assert.notEqual(tester.kind, 'deny', 'cheapest-tier role on Composer is not a degradation');
  });
});

test('Cursor: an earlier wrong-model deny does NOT suppress the degradation prompt', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Spawn 1: wrong/alias model → a plain per-role model-param deny.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }, 'cursor'));
    assert.equal(first.kind, 'deny');
    // Spawn 2: degrades to the Composer floor → STILL prompts; the wrong-model deny must not mask
    // this user-facing degradation signal.
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.equal(second.kind, 'deny', 'degradation prompt fires despite the earlier wrong-model deny');
    if (second.kind === 'deny') assert.ok(/budget|disabled|enable/i.test(second.reason));
  });
});

test('Cursor: a STALE captured list (plan upgrade/downgrade) re-fires the capture precondition', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Capture stamped under a DIFFERENT plan than the current one (test env plan = 'pro').
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', 'cursor-models.json'),
      JSON.stringify({ models: ['composer-2.5-fast'], plan: 'business', capturedAt: new Date().toISOString() }),
      'utf8',
    );
    const r = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.equal(r.kind, 'deny', 'plan changed → stale capture → re-prompt to re-enumerate');
    if (r.kind === 'deny') assert.ok(/cursor-models\.json|enumerate|model list/i.test(r.reason), 'asks to re-capture the model list');
  });
});

test('Cursor: the model deny names the recommended + a usable same-tier fallback (real captured build slugs)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // First wrong/alias model → the enable/fallback CHOICE deny, naming the RECOMMENDED build
    // slug + the next-eligible fallback, both resolved from the captured cursor-models.json.
    const d = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }, 'cursor'));
    assert.equal(d.kind, 'deny');
    if (d.kind === 'deny') {
      assert.ok(d.reason.includes('claude-opus-4-8-thinking-high'), 'names the recommended build slug');
      assert.ok(d.reason.includes('claude-opus-4-7-thinking-max'), 'names a usable same-tier fallback build slug');
    }
    // After "use-fallback", the plain per-role deny LISTS the same-tier fallback families
    // resolved to the real build slugs the runner offers, so the orchestrator can switch.
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    writeModelChoice(cwd, runId, 'use-fallback');
    const d2 = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }, 'cursor'));
    assert.equal(d2.kind, 'deny');
    if (d2.kind === 'deny') {
      assert.ok(d2.reason.includes('claude-fable-5-thinking-high') && d2.reason.includes('composer-2.5-fast'),
        'lists the same-tier fallback build slugs');
    }
  });
});

test('Cursor capture precondition: missing cursor-models.json denies ONCE (capture prompt) then proceeds (no-deadlock)', () => {
  withMaterialized({ teamApproved: true, cursorModels: null }, (cwd) => {
    // No captured model list yet → the gate asks the orchestrator to enumerate + persist it.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') assert.ok(/cursor-models\.json|model-capture|enumerate/i.test(first.reason), 'asks to capture the model list');
    // No-deadlock: a second spawn is NOT re-prompted for capture — it proceeds (here the valid
    // model passes, carrying the one-time advisory).
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.notEqual(second.kind, 'deny', 'capture is asked at most once per run');
  });
});

test('Cursor: the PASSED model is authoritative — a matching .cursor/agents frontmatter does NOT rescue a no-model/wrong-model spawn (Cursor ignores the frontmatter, inherits the parent model)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // high senior-frontend → highest tier → opus family. Materialize the frontmatter with the
    // correct opus slug — but on Cursor that is NOT auto-applied: omitting `model` makes the
    // subagent inherit the PARENT model, so the gate must REQUIRE the passed model.
    const agentsDir = path.join(cwd, '.cursor', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'senior-frontend.md'), `---\nname: senior-frontend\nmodel: claude-opus-4-8-thinking-high\n---\nbody\n`, 'utf8');

    // NO model param → DENY, even though the frontmatter pins the right model.
    const noModel = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend' }, 'cursor'));
    assert.equal(noModel.kind, 'deny', 'no `model` arg → deny (Cursor would inherit the parent model)');

    // A WRONG-tier passed model → DENY (the matching frontmatter no longer rescues it). This is
    // the 19b bug: a balanced-override role pinned correctly but spawned on the parent's Opus.
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'gpt-5.5-medium' }, 'cursor'));
    assert.equal(wrong.kind, 'deny', 'wrong-tier passed model denies despite a matching frontmatter');

    // The CORRECT passed model → allowed (first pass may carry the one-time advisory).
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.notEqual(ok.kind, 'deny', 'the passed model is what satisfies the gate');
  });
});

test('Cursor degraded-to-floor choice: names the RECOMMENDED tier model verbatim (not the available floor), prompts once, then a recorded choice proceeds', () => {
  // Opus IS offered (so the eligibility gate does not fire) but the API budget is exhausted, so
  // the orchestrator passes composer-2.5-fast (the floor). The choice deny must name the model the
  // user should restore (`claude-opus-4-8`, the tier family) — NOT the floor it collapsed to.
  withMaterialized({ teamApproved: true, cursorModels: ['claude-opus-4-8-thinking-high', 'gpt-5.5-medium', 'composer-2.5-fast'] }, (cwd) => {
    // 1) A highest role degraded to the Composer floor → the enable/fallback CHOICE deny.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(/budget|disabled|enable|fallback/i.test(first.reason), 'offers the enable/fallback choice');
      assert.ok(first.promptRequest !== undefined, 'carries a promptRequest for hosts that render modals');
      // REGRESSION GUARD (the user-reported bug): the RECOMMENDED model named is the tier FAMILY,
      // shown verbatim even though it's disabled/absent from the captured list — never collapsed to
      // composer (the available floor). Before the fix, cursorRealSlug(expected) resolved THROUGH
      // the captured list, which excludes the disabled model, so it wrongly named composer-2.5-fast
      // as the "recommended" model to enable.
      assert.ok(first.reason.includes('claude-opus-4-8'), 'recommended model is the disabled tier family, not the available floor');
      assert.ok(first.reason.includes('composer-2.5-fast'), 'names the Composer floor as the proceed-now fallback');
    }
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    assert.equal(modelChoicePrompted(cwd, runId), true, 'prompted marker set');

    // 2) Without a recorded answer, further spawns stay blocked (fail closed).
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.equal(second.kind, 'deny', 'without explicit use-fallback, Composer floor stays blocked');

    // 3) A recorded "use-fallback" → the Composer-floor spawn proceeds on the floor (no re-prompt).
    writeModelChoice(cwd, runId, 'use-fallback');
    const fb = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.notEqual(fb.kind, 'deny', 'recorded use-fallback proceeds on the Composer floor');

    // 4) A recorded "enable-retry" blocks the fallback floor instead of silently proceeding.
    writeModelChoice(cwd, runId, 'enable-retry');
    const blockedFloor = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.equal(blockedFloor.kind, 'deny', 'recorded enable-retry must not proceed on the Composer floor');
    if (blockedFloor.kind === 'deny') {
      assert.ok(/enable\/retry|do NOT proceed on a fallback/i.test(blockedFloor.reason));
      assert.ok(blockedFloor.reason.includes('claude-opus-4-8'), 'names the recommended model to enable');
    }

    // 5) "enable-retry" + the orchestrator now passing a recommended-family slug → proceeds normally
    //    (not on the floor, so the degradation deny never fires).
    const er = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.notEqual(er.kind, 'deny', 'enable-retry on the recommended model proceeds');
  });
});

test('Cursor eligibility: the PICKED model is not offered (disabled) → ask ONCE even when the fallback is a valid alternate (the "I wasn\'t asked" gap)', () => {
  // The 23b incident: architect overridden to BALANCED → claude-4.6-sonnet, but the build offers
  // only opus-high + gpt-5.5 + composer — NO sonnet. Materialization falls back to gpt-5.5-medium,
  // which SATISFIES the balanced tier, so the spawn would pass silently. degradedToFloorDeny does
  // NOT catch this (gpt-5.5 is not the Composer floor). The eligibility gate must surface the
  // choice ONCE, naming the recommended model to enable (sonnet) + the fallback it would use.
  withMaterialized({
    teamApproved: true,
    cursorModels: ['claude-opus-4-8-thinking-high', 'gpt-5.5-medium', 'composer-2.5-fast'],
  }, (cwd) => {
    // Override the architect to balanced so its preferred model is claude-4.6-sonnet (absent).
    const prefs = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'));
    prefs.team.overrides = { 'senior-architect': 'balanced' };
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify(prefs), 'utf8');

    // The architect is spawned on the resolved fallback (gpt-5.5-medium) — a VALID balanced model.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'gpt-5.5-medium' }, 'cursor'));
    assert.equal(first.kind, 'deny', 'the picked-but-unavailable model surfaces a choice, not a silent fallback');
    if (first.kind === 'deny') {
      assert.ok(first.reason.includes('claude-4.6-sonnet'), 'names the recommended model the user picked (to enable)');
      assert.ok(first.reason.includes('gpt-5.5'), 'names the same-tier fallback it would use');
      assert.ok(first.promptRequest !== undefined, 'carries a promptRequest modal');
    }
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    assert.equal(modelChoicePrompted(cwd, runId), true, 'prompted marker set (shared, at most one model prompt/run)');

    // Without a recorded answer, the same spawn stays blocked (fail closed).
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'gpt-5.5-medium' }, 'cursor'));
    assert.equal(second.kind, 'deny', 'without explicit use-fallback, same-tier fallback stays blocked');

    writeModelChoice(cwd, runId, 'use-fallback');
    const allowed = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'gpt-5.5-medium' }, 'cursor'));
    assert.notEqual(allowed.kind, 'deny', 'recorded use-fallback proceeds on the fallback');

    writeModelChoice(cwd, runId, 'enable-retry');
    const blockedFallback = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'gpt-5.5-medium' }, 'cursor'));
    assert.equal(blockedFallback.kind, 'deny', 'recorded enable-retry must block the same-tier fallback');
    if (blockedFallback.kind === 'deny') {
      assert.ok(/enable\/retry|do NOT proceed on a fallback/i.test(blockedFallback.reason));
      assert.ok(blockedFallback.reason.includes('claude-4.6-sonnet'), 'names the picked model to enable');
    }

    // A role whose PREFERRED model IS offered (frontend → opus, present) is NOT prompted.
    const fe = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.notEqual(fe.kind, 'deny', 'a role whose picked model is offered spawns clean');
  });
});

test('Cursor eligibility: fallback choice names an offered alternate, not the first absent alternate', () => {
  withMaterialized({
    teamApproved: true,
    cursorModels: ['composer-2.5-fast'],
  }, (cwd) => {
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5-fast' }, 'cursor'));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(first.reason.includes('composer-2.5-fast'), 'names the actually offered Composer fallback');
      assert.ok(!first.reason.includes('claude-opus-4-7'), 'does not offer an absent first alternate');
    }
  });
});

test('Cursor proactive advisory: first passing spawn names the models + enable path, once per run', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.equal(first.kind, 'context', 'first passing Cursor spawn carries the advisory');
    if (first.kind === 'context') {
      assert.ok(first.context.includes('claude-opus-4-8-thinking-high'), 'advisory lists the team models');
      assert.ok(/budget/i.test(first.context), 'advisory names the budget-exhaustion cause + remedy');
      // USER-VISIBLE: rides systemMessage (→ user_message on Cursor), not just additional_context.
      assert.ok(first.systemMessage !== undefined, 'advisory has a user-visible systemMessage');
      assert.ok(/budget|Composer/i.test(String(first.systemMessage)), 'the visible banner explains the Composer/budget situation');
    }
    // A second passing spawn (different role) → advisory already shown → clean noop.
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.equal(second.kind, 'noop', 'advisory is shown at most once per run');
  });
});

test('Cursor quick-fix is pinned to the exact captured cheapest Cursor model', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // quick-fix → cheapest tier → cursor "composer-2.5-fast". A pricier/alias model denies;
    // the exact Task-tool slug passes. A fabricated same-family sub-variant is denied before
    // Cursor sees it, because Task requires an id from the captured model list.
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }, 'cursor')).kind, 'deny');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'composer-2.5-fast' }, 'cursor')).kind, 'noop');
    const invented = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'composer-2.5-fast-high' }, 'cursor'));
    assert.equal(invented.kind, 'deny');
    if (invented.kind === 'deny') assert.ok(invented.reason.includes('Cursor model gate'));
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
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-Q';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    queueDelegateRole(cwd, 'quick-fix');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));

    markOpenCodeRoleAttempted(cwd, 'run-Q', 'quick-fix');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' })).kind, 'noop');
  });
});

test('opencode plan-batch gate: queued Step-0 work blocks both implementers until the batch is terminal', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-plan-batch';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    queueDelegateRoles(cwd, ['frontend', 'backend']);

    const backend = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' }));
    assert.equal(backend.kind, 'deny');
    if (backend.kind === 'deny') {
      assert.ok(backend.reason.includes('OpenCode plan-batch gate'));
      assert.ok(backend.reason.includes('opencode_delegate_from_plan'));
      assert.ok(backend.reason.includes('frontend, backend'));
    }
    const frontend = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(frontend.kind, 'deny');
    if (frontend.kind === 'deny') assert.ok(frontend.reason.includes('OpenCode plan-batch gate'));

    const pendingDir = path.join(cwd, '.traffic-one', 'runs', 'run-plan-batch', 'pending');
    assert.equal(fs.existsSync(pendingDir), false, 'denied implementer spawns must not stake pending claims');
    const denyDir = path.join(cwd, '.traffic-one', 'runs', 'run-plan-batch', 'opencode-gate-denies');
    assert.equal(fs.existsSync(denyDir), false, 'plan-batch denies must not consume the per-role deny-once fallback');

    markOpenCodePlanRoleCompleted(cwd, 'run-plan-batch', 'frontend');
    const stillBackend = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' }));
    assert.equal(stillBackend.kind, 'deny', 'backend stays blocked until every queued role is terminal');
    markOpenCodePlanRoleCompleted(cwd, 'run-plan-batch', 'backend');

    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'noop');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' })).kind, 'noop');
  });
});

test('opencode plan-batch gate: COMPLETE marker alone clears implementer spawns', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-plan-complete';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    queueDelegateRoles(cwd, ['frontend', 'backend', 'tester']);

    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'deny');
    markOpenCodePlanBatchComplete(cwd, 'run-plan-complete');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'noop');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' })).kind, 'noop');
  });
});

test('opencode role gate: a configured non-implementer role is denied until OpenCode is tried, then allowed (fallback)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Enable OpenCode + set a currentRunId so the gate can scope the attempt marker.
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-X';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    queueDelegateRole(cwd, 'senior-tester');

    // senior-tester is in the default delegateRoles → deny until OpenCode tried
    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'haiku' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));

    // runner records the attempt → gate falls through to the normal model check → allow
    markOpenCodeRoleAttempted(cwd, 'run-X', 'senior-tester');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'haiku' })).kind, 'noop');

    // Once the plan batch is terminal, a role NOT in the configured set
    // (senior-backend) is never opencode role-gated.
    markOpenCodePlanRoleCompleted(cwd, 'run-X', 'senior-tester');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'noop');
  });
});

test('opencode role gate: a forced role with NO queued units is NOT trapped (proceeds to paid)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-noqueue';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    // No opencode-delegate queue for senior-frontend → from-plan can't deliver it, so
    // denying its paid spawn would STALL the role. The gate must NOT deny (the gap fix);
    // the paid implementer proceeds (correct model → noop).
    const r = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.notEqual(r.kind, 'deny');
  });
});

test('opencode role gate: mints currentRunId when absent (existing-codebase) so enforcement is not skipped', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    // The exact gap: existing-codebase + NO currentRunId. ensureRunAgentClaim is
    // never reached for this mode, so before the fix the gate silently skipped.
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    delete one.currentRunId;
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    // existing-codebase ⇒ maintenance phase, so the gate forces delegation even with no
    // plan queue (small fixes go to OpenCode ad hoc).

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
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-reviewer-reject';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    queueDelegateRole(cwd, 'senior-tester');

    // First spawn → denied (with the delegate instructions), deny recorded.
    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'haiku' }));
    assert.equal(denied.kind, 'deny');
    // Second spawn, with NO attempt marker (delegate was rejected externally) → allowed.
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'haiku' })).kind, 'noop');
  });
});

test('opencode role gate: deny block is clean (no leftover template placeholders)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-clean';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    queueDelegateRole(cwd, 'senior-tester');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'haiku' }));
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
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-codex';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    queueDelegateRole(cwd, 'senior-tester');

    // A configured role on Codex is delegated to OpenCode first, exactly like Claude/Cursor.
    const denied = agentModelGate(codexSpawnCtx(cwd, {
      agent_type: 'worker',
      message: 'You are acting as Traffic One `senior-tester` for this Codex run.',
      model: 'gpt-5.4-mini',
    }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));
    // Deny-once: a second spawn (no attempt recorded — e.g. tool unavailable) falls through.
    assert.equal(agentModelGate(codexSpawnCtx(cwd, {
      agent_type: 'worker',
      message: 'You are acting as Traffic One `senior-tester` for this Codex run.',
      model: 'gpt-5.4-mini',
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
    queueDelegateRole(cwd, 'senior-tester');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'haiku' }));
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

function spawnCtxWithSession(cwd: string, toolInput: Record<string, unknown>, sessionId: string, host: 'claude' | 'codex' | 'cursor' = 'claude'): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host, cwd,
    raw: { tool_name: 'Task', tool_input: toolInput, session_id: sessionId },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
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
  assert.equal(
    extractSpawnedAgentId('Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 (can be used with the `resume` parameter'),
    'bff46cd7-3681-4cf0-adcf-263bf55cc301',
  );
  assert.equal(
    extractSpawnedAgentId('[label](9e41b709-ff45-4f20-bcbd-d077f92944b8)'),
    '9e41b709-ff45-4f20-bcbd-d077f92944b8',
  );
  // Structured spelling: a payload carrying the id as a JSON field is scanned
  // as serialized JSON ("agentId":"…") and must match too.
  assert.equal(extractSpawnedAgentId({ agentId: 'deadbeef12345678', content: [] }), 'deadbeef12345678');
  // tool_* spawn ids must NOT be captured as resume ids.
  assert.equal(extractSpawnedAgentId('agentId: tool_b1b73265-1c92-4340-a170-d148f8f0dde'), null);
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

test('reuse (Cursor): duplicate spawn deny names Task resume UUID after PostToolUse records it', () => {
  withMaterialized({ teamApproved: true, cursorModels: [...DEFAULT_CURSOR_MODELS, 'claude-4.6-sonnet-thinking'] }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-cursor-resume');
      subagentStartBind({
        input: {
          event: 'SubagentStart', host: 'cursor', cwd,
          raw: {
            subagent_id: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
            subagent_type: 'senior-frontend',
            session_id: 'parent-1',
          },
        },
        host: 'cursor', cwd, now: () => 'x',
      } as unknown as Ctx);
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: 'composer-2.5', prompt: 'build UI' },
        'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 (can be used with the resume parameter)',
        'parent-1',
      ));
      const dup = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-frontend', model: 'composer-2.5', prompt: 'fix cycle' }, 'parent-1'));
      assert.equal(dup.kind, 'deny');
      if (dup.kind === 'deny') {
        assert.ok(dup.reason.includes('bff46cd7-3681-4cf0-adcf-263bf55cc301'), 'deny must name Cursor resume UUID, not tool_* id');
        assert.ok(!dup.reason.includes('tool_b1b73265'), 'deny must not name tool_* id');
      }
    });
  });
});

test('reuse (Cursor): subagent-start records the spawned subagent_id into the registry (10b re-spawn-pileup fix)', () => {
  withMaterialized({ teamApproved: true, cursorModels: [...DEFAULT_CURSOR_MODELS, 'claude-4.6-sonnet-thinking'] }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-1');
    // Cursor's subagent-start carries the spawned id as `subagent_id` (= tool_<uuid>) and
    // the role as `subagent_type` — NOT agent_id/agent_type. The PostToolUse(Task) recorder
    // never sees this id, so without recording it on subagent-start the registry stays empty
    // and every fix-cycle re-spawns the role fresh (observed 10b: backend ×3, frontend ×3,
    // 11 unbound pending claims, stalled mid-review-fix-cycle).
    const cursorCtx = {
      input: {
        event: 'SubagentStart', host: 'cursor', cwd,
        raw: {
          hook_event_name: 'subagent-start',
          subagent_id: 'tool_f90f3399-a93f-4d3e-9d95-fc7dc37f8bb',
          subagent_type: 'senior-architect',
          subagent_model: 'composer-2.5-fast',
          session_id: 'orchestrator-parent',
          conversation_id: 'conv-child-1',
          transcript_path: '/tmp/orchestrator-parent.jsonl',
        },
      },
      host: 'cursor', cwd, now: () => 'x',
    } as unknown as Ctx;
    subagentStartBind(cursorCtx);
    const registry = readRunAgentRegistry(cwd, 'run-cursor-1');
    assert.equal(
      registry['senior-architect']?.toolCallId,
      'tool_f90f3399-a93f-4d3e-9d95-fc7dc37f8bb',
      'Cursor subagent_id must be recorded as toolCallId until PostToolUse supplies resume UUID',
    );
    assert.equal(registry['senior-architect']?.resumeId, null);
    assert.equal(registry['senior-architect']?.agentType, 'senior-architect');
    assert.equal(
      fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'run-cursor-1', 'tool_f90f3399-a93f-4d3e-9d95-fc7dc37f8bb.json')),
      false,
      'Cursor subagent-start must not claim tool_<id>; the child conversation claims itself on first write',
    );
    const dup = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-architect', model: 'composer-2.5-fast', prompt: 'continue architecture' }, 'orchestrator-parent', 'cursor'));
    assert.equal(dup.kind, 'deny');
    if (dup.kind === 'deny') {
      assert.ok(/has not exposed a valid Task `resume` UUID/i.test(dup.reason), dup.reason);
      assert.ok(!dup.reason.includes('resume: "tool_'), 'never suggests resuming a tool_* id');
    }
  });
});

test('Cursor: SubagentStart stops senior team when model choice is still pending, even with generic subagent_type', () => {
  withMaterialized({
    teamApproved: true,
    cursorModels: ['claude-opus-4-8-thinking-high', 'gpt-5.5-medium', 'composer-2.5-fast'],
  }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-pending-model-choice');
    const prefs = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'));
    prefs.team.overrides = { 'senior-architect': 'balanced' };
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify(prefs), 'utf8');

    const cursorCtx = {
      input: {
        event: 'SubagentStart', host: 'cursor', cwd,
        raw: {
          hook_event_name: 'subagent-start',
          subagent_id: 'tool_pending_model_choice',
          subagent_type: 'general-purpose',
          subagent_model: 'composer-2.5-fast',
          session_id: 'orchestrator-parent',
          task: '[t1-role: senior-architect] Produce the Traffic One plan.',
        },
      },
      host: 'cursor', cwd, now: () => 'x',
    } as unknown as Ctx;

    const blocked = subagentStartBind(cursorCtx);
    assert.equal(blocked.kind, 'deny');
    if (blocked.kind === 'deny') {
      assert.ok(/model choice required/i.test(blocked.reason), 'names the pending model choice');
      assert.ok(blocked.reason.includes('senior-architect'), 'infers the role from the task marker');
      assert.ok(/must stop now|must not write files/i.test(blocked.reason), 'tells the already-started subagent to stop');
    }
    assert.equal(readRunAgentRegistry(cwd, 'run-cursor-pending-model-choice')['senior-architect'], undefined);

    writeModelChoice(cwd, 'run-cursor-pending-model-choice', 'use-fallback');
    assert.equal(subagentStartBind(cursorCtx).kind, 'noop');
    assert.equal(
      readRunAgentRegistry(cwd, 'run-cursor-pending-model-choice')['senior-architect']?.agentId,
      'tool_pending_model_choice',
      'recorded choice lets the Cursor subagent be registered for reuse',
    );
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

test('reuse: replace marker without a failure reason is denied while a healthy agent exists', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-reuse-marker-guard');
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: 'opus', prompt: 'build UI' },
        'agentId: frontend11aa22bb33',
        'parent-1',
      ));
      const duplicate = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-frontend', model: 'opus', prompt: 'fresh copy [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(duplicate.kind, 'deny');
      if (duplicate.kind === 'deny') {
        assert.ok(duplicate.reason.includes('frontend11aa22bb33'), 'still points at the live agent');
      }
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-marker-guard')['senior-frontend']?.replaced, false);
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

// ── Claude agent-teams: worker identity binds by agent_id / agent_type ───────
// Reproduces the captured payload (learning-platform run-20260617): a team worker
// stamps agent_id + agent_type on the write but sends NO parent_session_id and the
// PARENT's session_id/transcript. Before the fix this read as "main agent" and the
// run-team gate deadlocked. See project_agent_teams_claim_deadlock.
const AGENT_TEAMS_WRITE = {
  session_id: '154f721d-49f5-4ec8-9dc1-7ce51767b8fb', // PARENT session
  transcript_path: '/x/154f721d-49f5-4ec8-9dc1-7ce51767b8fb.jsonl', // PARENT transcript
  agent_id: 'a05438499c80df496',
  agent_type: 'traffic-one:senior-frontend',
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: '/x/apps/web/src/App.tsx', content: 'export default function App(){}' },
};

test('agent-teams: hookSessionIdentity reads agent_id + agent_type as a subagent worker', () => {
  const id = hookSessionIdentity(AGENT_TEAMS_WRITE);
  assert.equal(id.isSubagent, true, 'agent_id + role agent_type ⇒ subagent');
  assert.equal(id.declaredRole, 'senior-frontend', 'role read straight from agent_type');
  assert.equal(id.agentId, 'a05438499c80df496');
  // A bare orchestrator payload (no agent_id/agent_type) is NOT a subagent.
  assert.equal(hookSessionIdentity({ session_id: 'p1' }).isSubagent, false);
});

test('agent-teams: a worker write binds its claim by agent_id (no transcript inference)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-at-1');
    const state = readEffectiveState(cwd);
    // First write: resolves by binding a fresh claim keyed by agent_id.
    const ctx = resolveRunAgentContext(cwd, state, AGENT_TEAMS_WRITE, { claimPending: true });
    assert.ok(ctx, 'worker write resolves instead of denying as "main agent"');
    assert.equal(ctx!.role, 'senior-frontend');
    // The claim is persisted keyed by agent_id, so a SECOND write resolves by exact match.
    const again = resolveRunAgentContext(cwd, readEffectiveState(cwd), AGENT_TEAMS_WRITE, { claimPending: false });
    assert.ok(again, 'second write resolves by exact agent_id match');
    assert.equal(again!.role, 'senior-frontend');
  });
});

test('agent-teams: binding records the role for reuse so a duplicate same-role spawn is denied', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => { // flag on → the reuse registry is live
      setCurrentRunId(cwd, 'run-at-2');
      // Backend worker's first write binds its claim AND mirrors into agents.json.
      const backendWrite = {
        ...AGENT_TEAMS_WRITE,
        agent_id: 'bbb111backend',
        agent_type: 'traffic-one:senior-backend',
        tool_input: { file_path: '/x/supabase/migrations/0001_init.sql', content: '-- sql' },
      };
      const ctx = resolveRunAgentContext(cwd, readEffectiveState(cwd), backendWrite, { claimPending: true });
      assert.equal(ctx?.role, 'senior-backend');
      assert.equal(readRunAgentRegistry(cwd, 'run-at-2')['senior-backend']?.agentId, 'bbb111backend',
        'the bind mirrored the live backend agent into the reuse registry');
      // A SECOND backend spawn ("gap-fill exports") from the same parent session is
      // now denied and pointed at the live agent — no fresh rule-reloading spawn.
      const dup = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'gap-fill the backend exports' },
        '154f721d-49f5-4ec8-9dc1-7ce51767b8fb', // == the worker write's (parent) session_id
      ));
      assert.equal(dup.kind, 'deny');
      if (dup.kind === 'deny') {
        assert.ok(dup.reason.includes('bbb111backend'), 'deny names the live agent id to continue');
        assert.ok(dup.reason.includes('SendMessage'), 'deny teaches the continuation tool');
      }
    });
  });
});

test('subagentContinuationAvailable is true on Codex without the Claude flag, and the flag still force-disables', async () => {
  const { subagentContinuationAvailable } = await import('../../../shared/state/run-agent');
  assert.equal(subagentContinuationAvailable({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex-desktop' } as NodeJS.ProcessEnv), true);
  assert.equal(subagentContinuationAvailable({ CODEX_PLUGIN_ROOT: '/x' } as NodeJS.ProcessEnv), true);
  assert.equal(subagentContinuationAvailable({ CODEX_PLUGIN_ROOT: '/x', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv), false);
  assert.equal(subagentContinuationAvailable({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } as NodeJS.ProcessEnv), true);
  // Cursor: the Task continuation primitive enables reuse (CURSOR_PLUGIN_ROOT signal),
  // and the explicit off-flag still force-disables everywhere.
  assert.equal(subagentContinuationAvailable({ CURSOR_PLUGIN_ROOT: '/x' } as NodeJS.ProcessEnv), true);
  assert.equal(subagentContinuationAvailable({ CURSOR_PLUGIN_ROOT: '/x', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 'off' } as NodeJS.ProcessEnv), false);
});

test('Cursor reuse deny names the Task resume recipe and accepts continuation fields', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // First Cursor spawn passes the gate + mints currentRunId + stakes a claim.
    agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    // Simulate the PostToolUse recorder writing the live-agent registry.
    const rd = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
      version: 1, agents: { 'senior-frontend': { agentId: 'cursor-agent-xyz', recordedAt: new Date().toISOString(), tasks: 1, replaced: false } },
    }));
    // Duplicate Cursor spawn → reuse deny with the Task+resume recipe (NOT SendMessage).
    const d = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high' }, 'cursor'));
    assert.equal(d.kind, 'deny');
    if (d.kind === 'deny') {
      assert.ok(d.reason.includes('cursor-agent-xyz'), 'names the live agent id');
      assert.ok(/Task/.test(d.reason) && /resume/.test(d.reason), 'uses the Cursor Task resume recipe');
      assert.ok(!d.reason.includes('SendMessage'), 'no Claude SendMessage on Cursor');
    }
    // The RESUME itself (Task carrying resume) must pass the gate — never block the
    // continuation it just asked for. This makes the deny satisfiable → no soft-loop.
    const resume = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high', resume: 'cursor-agent-xyz' }, 'cursor'));
    assert.equal(resume.kind, 'noop', 'a Cursor Task call carrying resume passes the reuse gate');
    const legacyAgentId = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-opus-4-8-thinking-high', agentId: 'cursor-agent-xyz' }, 'cursor'));
    assert.equal(legacyAgentId.kind, 'noop', 'legacy agentId continuation remains accepted');
  });
});

test('inferTrafficOneSpawnRole reads the clause-anchored "Traffic One senior-X" declaration despite sibling mentions', () => {
  const { inferTrafficOneSpawnRole } = require('../role-infer') as typeof import('../role-infer');
  assert.equal(inferTrafficOneSpawnRole({
    agent_type: 'worker',
    message: 'You are the Traffic One senior-architect for run 1781266789389 in /x.\n\nWrite assignments for senior-frontend and senior-backend with disjoint scopes.',
  }), 'senior-architect');
  assert.equal(inferTrafficOneSpawnRole({
    agent_type: 'worker',
    message: 'You are Traffic One `senior-frontend` for project root /x. senior-backend owns the API.',
  }), 'senior-frontend');
});

test('inferTrafficOneSpawnRole handles the role-before-"Traffic One" prompt shape', () => {
  const { inferTrafficOneSpawnRole } = require('../role-infer') as typeof import('../role-infer');
  assert.equal(inferTrafficOneSpawnRole({
    agent_type: 'worker',
    message: 'You are `senior-architect` for a Traffic One run in `/x`.\n\nProduce assignments for senior-frontend and senior-backend.',
  }), 'senior-architect');
});

test('inferTrafficOneSpawnRole honors the [t1-role:] marker contract over any phrasing', () => {
  const { inferTrafficOneSpawnRole } = require('../role-infer') as typeof import('../role-infer');
  assert.equal(inferTrafficOneSpawnRole({
    agent_type: 'worker',
    message: '[t1-role: senior-backend]\nDo whatever phrasing follows; senior-frontend and senior-tester are also mentioned here.',
  }), 'senior-backend');
});
