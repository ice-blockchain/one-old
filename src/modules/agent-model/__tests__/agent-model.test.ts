import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { classifySubagentStop, extractSpawnedAgentId, recordSpawnedAgent } from '../record-agent';
import { subagentStartBind } from '../subagent-bind';
import { opencodeSubagentBind } from '../opencode-subagent-bind';
import { inferTrafficOneSpawnRole, inferTrafficOneSpawnRoleEvidence } from '../role-infer';
import { GENERATED_MARKER } from '../../../shared/materialize';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import { writeArchitectPhaseComplete } from '../../plan-guard/__tests__/architect-phase-fixtures';
import { modelChoicePrompted, writeModelChoice } from '../model-choice';
import { exhaustedModelsForRole, recordExhaustedModel } from '../exhausted-models';
import { markOpenCodePlanBatchComplete, markOpenCodePlanBatchTerminal, markOpenCodePlanRoleCompleted, markOpenCodeRoleAttempted } from '../../../shared/opencode-roles';
import { claimThreadRole, ensureRunAgentClaim, hookSessionIdentity, listCursorSpawnObservations, markCursorSpawnObservationRetryHandled, observeCodexChildModel, readCodexModelObservation, readEffectiveState, readRunAgentRegistry, recordCursorSpawnObservation, recordRunAgent, resolveRunAgentContext } from '../../../shared/state';
import { isForeignOnboardingThread } from '../../../shared/onboarding-server/onboarding-session';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';
import { openCodeGlobalAgentName } from '../../../shared/materialize/opencode-assets';
import { ensureRunModelPolicy, readRunModelPolicy } from '../../../shared/run-model-policy';
import { codexChildModelGate } from '../codex-child-model';
import { captureCursorModels, freshCursorModels } from '../../../shared/materialize/cursor-models';
import { currentHostModelTarget } from '../../../shared/current-model-tiers';
import { writeOneMcpConfigCacheEntry } from '../../../shared/one-mcp-cache';
import { oneMcpPayloadFingerprint } from '../../../shared/one-mcp';
import type { OneMcpModelConfigPayload } from '../../../shared/one-mcp/types';
import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  publicEndpoint,
} from '../../../config/one-mcp';

test('inferTrafficOneSpawnRole reads subagent_type, namespaced ids, agentName, and prose', () => {
  assert.equal(inferTrafficOneSpawnRole({ subagent_type: 'senior-frontend' }), 'senior-frontend');
  assert.equal(inferTrafficOneSpawnRole({ subagent_type: 'traffic-one:senior-backend' }), 'senior-backend');
  assert.equal(inferTrafficOneSpawnRole({ agent_type: 'traffic-one:senior-frontend' }), 'senior-frontend');
  assert.equal(inferTrafficOneSpawnRole({ agentType: 'traffic-one:senior-backend' }), 'senior-backend');
  assert.equal(inferTrafficOneSpawnRole({ agent_name: 'senior-reviewer' }), 'senior-reviewer');
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'You are the Traffic One senior-tester role.' }), 'senior-tester');
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'just do something' }), null);
});

test('inferTrafficOneSpawnRole normalizes exact Codex task-name leaves and replacement suffixes', () => {
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'senior_architect' }), 'senior-architect');
  assert.equal(inferTrafficOneSpawnRole({ taskName: '/root/senior_frontend' }), 'senior-frontend');
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'traffic-one:workers/senior_backend_2' }), 'senior-backend');
  assert.equal(inferTrafficOneSpawnRole({ taskName: '/root/senior-reviewer-12' }), 'senior-reviewer');
  assert.equal(inferTrafficOneSpawnRole({ taskName: '  /ROOT/SENIOR_SHIPPER_4  ' }), 'senior-shipper');
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'quick_fix' }), 'quick-fix');
  assert.equal(
    inferTrafficOneSpawnRole({ agent_type: 'worker', task_name: '/root/senior_tester_3' }),
    'senior-tester',
    'a generic host type must not hide a role-bearing task name',
  );

  assert.equal(inferTrafficOneSpawnRole({ task_name: 'worker' }), null);
  assert.equal(inferTrafficOneSpawnRole({ task_name: '/root/worker_2' }), null);
  assert.equal(inferTrafficOneSpawnRole({ task_name: '/root/senior_architect_helper' }), null);
  assert.equal(inferTrafficOneSpawnRole({ task_name: '/root/senior_architect2' }), null);
  assert.equal(inferTrafficOneSpawnRole({ task_name: '/root/senior_architect/worker' }), null);
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'build_senior_architect' }), null);
});

test('inferTrafficOneSpawnRole filters non-candidates and fails closed only within the winning tier', () => {
  assert.equal(
    inferTrafficOneSpawnRole({ agent_type: 'default', agent_path: '/root/senior_architect' }),
    'senior-architect',
  );
  assert.equal(
    inferTrafficOneSpawnRole({ subagent_type: 'general', prompt: 'Continue. [t1-role: senior-backend]' }),
    'senior-backend',
  );
  assert.equal(
    inferTrafficOneSpawnRole({ agent_type: 'senior-frontend', agent_path: '/root/senior_architect' }),
    null,
    'different valid peer host fields are an authoritative conflict',
  );
  assert.equal(
    inferTrafficOneSpawnRole({ agent_type: 'senior-backend', task_name: 'senior_architect' }),
    'senior-backend',
    'host metadata outranks the lower task-name tier',
  );
  assert.equal(
    inferTrafficOneSpawnRole({ task_name: 'senior_architect', message: '[t1-role: senior-frontend]' }),
    'senior-architect',
    'task name outranks readable prompt evidence',
  );
});

test('inferTrafficOneSpawnRole resolves fix-cycle prompts without the "Traffic One" literal (7c Couldn\'t-start fix)', () => {
  // Observed 7c: the orchestrator sent CHANGES_REQUESTED fixes as fresh generic
  // workers whose prompt named only the owning role — no "Traffic One" literal,
  // no [t1-role:] marker. Role inference returned none, the child stayed
  // unbound, and Cursor rendered it as "New subagent — Couldn't start". The
  // ownership phrasing must resolve to the OWNING implementer even though the
  // findings also mention `senior-reviewer` as their source.
  assert.equal(
    inferTrafficOneSpawnRole({
      subagent_type: 'general-purpose',
      task: 'Fix CHANGES_REQUESTED item owned by senior-backend. Stay in your assignment scope.\n\n'
        + 'Finding VERBATIM from senior-reviewer:\n\n3. `packages/api-client/src/coursesService.ts:119` — unescaped search.',
    }),
    'senior-backend',
  );
  assert.equal(
    inferTrafficOneSpawnRole({
      subagent_type: 'generalPurpose',
      prompt: 'Fix CHANGES_REQUESTED items owned by senior-frontend. Stay in your assignment scope.\n\n'
        + 'Findings VERBATIM from senior-reviewer:\n\n1. `apps/web/src/lib/seo.ts:25` — slug mismatch.',
    }),
    'senior-frontend',
  );
  // The fix-cycle re-spawn template ("You are continuing as `<role>`…") resolves too.
  assert.equal(
    inferTrafficOneSpawnRole({
      prompt: 'You are continuing as `senior-frontend` in run 1784727578206, fix cycle #1. End with FIXES_APPLIED.',
    }),
    'senior-frontend',
  );
  // Without a role-bearing phrase, generic work stays unclaimed, and the weaker
  // bare-mention tier still requires the "Traffic One" literal.
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'Fix the failing build owned by the platform team.' }), null);
  assert.equal(inferTrafficOneSpawnRole({ prompt: 'Ping senior-backend about the schema.' }), null);
});

test('inferTrafficOneSpawnRole inspects both source envelopes and accepts outer threadSpawn camelCase', () => {
  const nestedPayload = inferTrafficOneSpawnRoleEvidence({
    source: { event: 'subagent-start' },
    payload: {
      source: {
        subagent: {
          threadSpawn: { agentPath: '/root/senior_architect' },
        },
      },
    },
  });
  assert.equal(nestedPayload.kind, 'evidence');
  if (nestedPayload.kind === 'evidence') {
    assert.equal(nestedPayload.evidence.role, 'senior-architect');
    assert.equal(nestedPayload.evidence.source, 'host-agent-path');
  }

  assert.equal(
    inferTrafficOneSpawnRole({
      source: { subagent: { threadSpawn: { taskName: '/root/senior_reviewer' } } },
    }),
    'senior-reviewer',
  );

  const conflictingSources = inferTrafficOneSpawnRoleEvidence({
    source: { subagent: { thread_spawn: { agent_path: '/root/senior_architect' } } },
    payload: { source: { subagent: { threadSpawn: { agentPath: '/root/senior_frontend' } } } },
  });
  assert.equal(conflictingSources.kind, 'conflict', 'neither source envelope may mask the other');
  if (conflictingSources.kind === 'conflict') {
    assert.deepEqual(
      new Set(conflictingSources.candidates.map((candidate) => candidate.role)),
      new Set(['senior-architect', 'senior-frontend']),
    );
  }
});

test('verifier roles cannot resume or bind an implementer agent id', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    const memoryDir = '.traffic' + '-one';
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, memoryDir, '.one.json'), 'utf8')).currentRunId as string;
    recordRunAgent(cwd, runId, 'senior-frontend', {
      agentId: 'frontend-agent-1',
      resumeId: 'frontend-agent-1',
      parentSessionId: null,
    });

    const reviewerResume = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-reviewer',
      model: 'claude-sonnet-4-5',
      resume: 'frontend-agent-1',
    }, 'cursor'));
    assert.equal(reviewerResume.kind, 'deny');
    if (reviewerResume.kind === 'deny') assert.match(reviewerResume.reason, /verifier independence gate/);

    const testerResume = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-tester',
      model: 'composer-2.5-fast',
      resume: 'frontend-agent-1',
    }, 'cursor'));
    assert.equal(testerResume.kind, 'deny');

    recordRunAgent(cwd, runId, 'senior-reviewer', {
      agentId: 'frontend-agent-1',
      resumeId: 'frontend-agent-1',
      parentSessionId: null,
    });
    const registry = readRunAgentRegistry(cwd, runId);
    assert.equal(registry['senior-reviewer'], undefined, 'recorder must not bind reviewer to implementer id');

    recordRunAgent(cwd, runId, 'senior-reviewer', {
      agentId: 'reviewer-agent-1',
      resumeId: 'reviewer-agent-1',
      parentSessionId: null,
    });
    const sameReviewer = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-reviewer',
      model: 'claude-fable-5-thinking-high',
      resume: 'reviewer-agent-1',
    }, 'cursor'));
    assert.equal(sameReviewer.kind, 'noop', 'same-role reviewer continuation remains allowed');
  });
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
  'claude-fable-5-thinking-high', 'gpt-5.6-sol-medium',
  'gpt-5.6-terra-medium', 'claude-sonnet-5-thinking-high',
  'composer-2.5-fast', 'gpt-5.4-mini', 'gpt-5.6-luna',
];

function withMaterialized(opts: { teamApproved: boolean; cursorModels?: string[] | null; architectComplete?: boolean; level?: 'high' | 'balanced' | 'low' }, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-agentmodel-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  const prevMcpCache = env.TRAFFIC_ONE_MCP_CACHE_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_MCP_CACHE_PATH = path.join(dir, 'one-mcp.json');
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
  const cursorModels = opts.cursorModels === undefined ? DEFAULT_CURSOR_MODELS : opts.cursorModels;
  const prefs = hostScopedPerformancePrefs(
    { level: opts.level ?? 'high', source: 'prompted' },
    { mode: 'subagents', source: 'prompted', ...(opts.teamApproved ? { approved: true } : {}) },
    'pro',
  );
  if (cursorModels) {
    withCursorAvailableModels(prefs, cursorModels, 'pro');
  }
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
  if (opts.architectComplete !== false && opts.teamApproved) {
    const runId = 'run-test';
    const onePath = path.join(t1, '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = runId;
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    writeArchitectPhaseComplete(dir, runId, one);
  }
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevMcpCache === undefined) delete env.TRAFFIC_ONE_MCP_CACHE_PATH; else env.TRAFFIC_ONE_MCP_CACHE_PATH = prevMcpCache;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the spawn gate stands down inside the plugin authoring repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoring-spawn-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'gen', 'index.ts'), 'export {};\n', 'utf8');
    resetAuthoringRootCache();
    // A role-marked spawn whose prompt carries a literal un-substituted run-id
    // placeholder — in an end-user project the run-id gate denies this shape.
    const r = agentModelGate(spawnCtx(dir, {
      subagent_type: 'Explore',
      prompt: '[t1-role: senior-frontend] inspect .traffic-one/runs/<runId>/ and report',
    }));
    assert.equal(r.kind, 'noop');
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function spawnCtx(cwd: string, toolInput: Record<string, unknown>, host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'kilo' = 'claude', workspaceRoot?: string): Ctx {
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
  const onePath = path.join(t1, '.one.json');
  const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
  const runId = typeof one.currentRunId === 'string' && one.currentRunId.trim() ? one.currentRunId.trim() : 'run-test';
  if (!one.currentRunId) {
    one.currentRunId = runId;
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
  }
  writeArchitectPhaseComplete(cwd, runId, one);
}

test('non-spawn tools are ignored', () => {
  const cwd = process.cwd();
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: { tool_name: 'Bash' }, tool: { class: 'shell' as ToolClass, rawName: 'Bash', command: 'ls' } };
  const ctx = { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
  assert.equal(agentModelGate(ctx).kind, 'noop');
});

test('a subagent cannot create a missing immutable run model policy', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const parentCtx = spawnCtx(cwd, {
      subagent_type: 'senior-frontend',
      model: 'claude-fable-5-thinking-high',
    });
    const ctx = {
      ...parentCtx,
      input: {
        ...parentCtx.input,
        raw: {
          ...(parentCtx.input.raw as Record<string, unknown>),
          agent_type: 'default',
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread' } } },
        },
      },
    } as Ctx;

    const result = agentModelGate(ctx);
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') assert.match(result.reason, /child cannot create or rebase/i);
    assert.equal(readRunModelPolicy(cwd, 'run-test'), null, 'child must not freeze mutable global state');
  });
});

test('every recognized host child is blocked before its first tool when the parent policy is missing', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const childCtx = {
      input: {
        event: 'PreToolUse', host: 'claude', cwd,
        raw: {
          hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 'parent-session',
          agent_id: 'claude-child-1', agent_type: 'senior-frontend',
        },
        tool: { class: 'file-read', rawName: 'Read', filePath: path.join(cwd, 'README.md') },
      },
      host: 'claude', cwd, now: () => 'x',
    } as unknown as Ctx;

    const blocked = codexChildModelGate(childCtx);
    assert.equal(blocked.kind, 'deny');
    if (blocked.kind === 'deny') assert.match(blocked.reason, /immutable model-policy\.json is missing/i);
    assert.equal(readRunModelPolicy(cwd, 'run-test'), null, 'child gate must not create the policy');

    freezeRunPolicy(cwd, 'claude');
    assert.equal(codexChildModelGate(childCtx).kind, 'noop');
  });
});

test('spawn identity conflict is denied before any role claim is staked', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const result = agentModelGate(spawnCtx(cwd, {
      agent_type: 'senior-frontend',
      agent_path: '/root/senior_architect',
      model: 'opus',
    }));

    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') {
      assert.match(result.reason, /spawn identity gate/i);
      assert.match(result.reason, /`senior-frontend` \(host-agent-type\)/);
      assert.match(result.reason, /`senior-architect` \(host-agent-path\)/);
      assert.match(result.reason, /blocked before a child started/i);
      assert.match(result.reason, /correct or remove the stale identity field or marker/i);
    }

    const pendingDir = path.join(cwd, '.traffic-one', 'runs', 'run-test', 'pending');
    const pending = fs.existsSync(pendingDir)
      ? fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json'))
      : [];
    assert.deepEqual(pending, [], 'an ambiguous spawn cannot create a role claim');

    const debugFile = path.join(cwd, '.traffic-one', 'runs', 'run-test', 'debug', 'claim-capture.jsonl');
    const diagnostic = fs.readFileSync(debugFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { label?: string; raw?: { candidates?: unknown[] } })
      .find((entry) => entry.label === 'spawn-role-conflict');
    assert.equal(diagnostic?.raw?.candidates?.length, 2, 'the conflict diagnostic is structural and bounded');
  });
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

test('Claude native fable/best aliases satisfy Highest without becoming cross-host aliases', () => {
  for (const alias of ['fable', 'best']) {
    withMaterialized({ teamApproved: true }, (cwd) => {
      const result = agentModelGate(spawnCtx(cwd, {
        subagent_type: 'senior-frontend',
        model: alias,
      }));
      assert.equal(result.kind, 'noop', `${alias} is a valid Claude Highest selector`);
    });
  }
});

test('existing-codebase roles still honor Performance, Team, and the configured model', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    one.lifecycle = { phase: 'maintenance' };
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    const wrong = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-frontend',
      model: 'sonnet',
      prompt: '[t1-role: senior-frontend]\nApply the bounded frontend fix.',
    }));
    assert.equal(wrong.kind, 'deny');
    if (wrong.kind === 'deny') assert.ok(wrong.reason.includes('Performance gate'));

    const correct = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-frontend',
      model: 'opus',
      prompt: '[t1-role: senior-frontend]\nApply the bounded frontend fix.',
    }));
    assert.equal(correct.kind, 'noop');
  });

  withMaterialized({ teamApproved: true }, (cwd) => {
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    one.lifecycle = { phase: 'maintenance' };
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = hostScopedPerformancePrefs(
      { level: 'low', source: 'prompted' },
      { mode: 'main-agent', source: 'prompted', approved: true },
      'pro',
    );
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');

    const low = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-frontend',
      model: 'opus',
      prompt: '[t1-role: senior-frontend]\nApply the bounded frontend fix.',
    }));
    assert.equal(low.kind, 'deny');
    if (low.kind === 'deny') assert.match(low.reason, /main[- ]agent|level "low"/i);
  });
});

test('Copilot: missing model arg does not deadlock while slugs are unvalidated', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const r = agentModelGate(spawnCtx(cwd, {
      agentName: 'senior-frontend',
      prompt: '[t1-role: senior-frontend] implement assigned UI scope',
    }, 'copilot'));
    assert.equal(r.kind, 'noop');
  });
});

test('Kilo: built-in general task with marker succeeds; named project agent is redirected to general', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const general = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'general',
      prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan for the approved run.',
    }, 'kilo'));
    assert.equal(general.kind, 'noop');
    const named = agentModelGate(spawnCtx(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-architect'),
      prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan for the approved run.',
    }, 'kilo'));
    assert.equal(named.kind, 'deny');
    if (named.kind === 'deny') {
      assert.match(named.reason, /built-in writable Task subagent type `general`/);
      assert.match(named.reason, /\.kilo\/agents\/senior-architect\.md/);
      assert.match(named.reason, /subagent_type: "general"/);
      assert.match(named.reason, /do NOT fall back to main-agent/i);
    }
    const explore = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'explore',
      prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan for the approved run.',
    }, 'kilo'));
    assert.equal(explore.kind, 'deny');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.ok(String(state.currentRunId || '').length > 0, 'Kilo general marker spawn still mints/uses the Traffic One run id');
  });
});

test('Kilo: a corrective general spawn recovers from failed named-role pending claims', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const oldState = readEffectiveState(cwd);
    ensureRunAgentClaim(cwd, oldState, 'senior-architect', { session_id: 'kilo-parent' }, {
      toolName: 'task',
      agentType: 'senior-architect',
    });

    const corrected = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'general',
      prompt: '[t1-role: senior-architect]\nRead .kilo/agents/senior-architect.md before producing the plan.',
    }, 'kilo-parent', 'kilo'));
    assert.equal(corrected.kind, 'noop');

    const runId = String(JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId);
    const pendingDir = path.join(cwd, '.traffic-one', 'runs', runId, 'pending');
    assert.equal(fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')).length, 2,
      'the corrective spawn is not blocked by a failed named-agent attempt');

    const childPrompt = '[t1-role: senior-architect]\nRead .kilo/agents/senior-architect.md before producing the plan.';
    opencodeSubagentBind({
      input: {
        event: 'UserPromptSubmit',
        host: 'kilo',
        cwd,
        prompt: childPrompt,
        raw: { session_id: 'kilo-general-child', prompt: childPrompt },
      },
      host: 'kilo',
      cwd,
      now: () => 'x',
    } as unknown as Ctx);

    const context = resolveRunAgentContext(cwd, readEffectiveState(cwd), { session_id: 'kilo-general-child' });
    assert.equal(context?.role, 'senior-architect');
    assert.equal(fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')).length, 0,
      'the child bind removes the failed named-agent pending claim and its replacement');
  });
});

test('OpenCode: task spawn does not require unsupported model parameter', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const r = agentModelGate(spawnCtx(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-architect'),
      prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan for the approved run.',
    }, 'opencode'));
    assert.equal(r.kind, 'noop');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    const runId = String(state.currentRunId || '');
    assert.ok(runId.length > 0, 'OpenCode spawn still mints/uses the Traffic One run id');
    const pending = fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId, 'pending')).filter((f) => f.startsWith('senior-architect-'));
    assert.ok(pending.length > 0, 'pending senior-architect claim staked for OpenCode');
  });
});

test('OpenCode: Task spawn records its parent so an unmarked child write can be scope-attributed', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const r = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-architect'),
      prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan for the approved run.',
    }, 'ses_oc_parent', 'opencode'));
    assert.equal(r.kind, 'noop');
    assert.equal(isForeignOnboardingThread(cwd, 'ses_oc_parent'), false, 'the parent remains protected from scope attribution');
    assert.equal(isForeignOnboardingThread(cwd, 'ses_oc_child_without_chat_message'), true,
      'a child whose initial chat.message hook is skipped can still bind by assignment scope');
  });
});

test('OpenCode: built-in general with a Traffic One role marker is denied because it inherits the parent model', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const r = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'general',
      prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan for the approved run.',
    }, 'opencode'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(openCodeGlobalAgentName(cwd, 'senior-architect')));
      assert.match(r.reason, /not `general`/);
      assert.match(r.reason, /inherit/i);
      assert.match(r.reason, /\.config\/opencode\/agents\/traffic-one-[a-f0-9]{12}-senior-architect\.md/);
    }
  });
});

test('OpenCode: generic role metadata is not accepted as the actual named subagent type', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const r = agentModelGate(spawnCtx(cwd, {
      role: 'senior-architect',
      prompt: '[t1-role: senior-architect]\nProduce the Traffic One plan for the approved run.',
    }, 'opencode'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(openCodeGlobalAgentName(cwd, 'senior-architect')));
      assert.match(r.reason, /not `missing`/);
    }
  });
});

test('OpenCode: spawn prompts cannot carry absolute .traffic-one paths from another root', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const r = agentModelGate(spawnCtx(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-frontend'),
      prompt: [
        '[t1-role: senior-frontend]',
        'Read /Users/w3s/Ps/Projects/traffic-one/tests/opencode/3/.traffic-one/digests/run-test/frontend.md first.',
      ].join('\n'),
    }, 'opencode'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.match(r.reason, /outside this project root|corrupted root|project-relative/i);
      assert.ok(r.reason.includes('/Users/w3s/Ps/Projects/traffic-one/tests/opencode/3/.traffic-one/digests/run-test/frontend.md'));
      assert.ok(r.reason.includes(cwd));
    }
  });
});

test('OpenCode: bound child session records a live role and duplicate same-role spawn requires explicit replacement', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const first = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-frontend'),
      prompt: '[t1-role: senior-frontend]\nBuild the assigned UI scope.',
    }, 'parent-oc', 'opencode'));
    assert.equal(first.kind, 'noop');

    const bindInput: HookInput = {
      event: 'UserPromptSubmit',
      host: 'opencode',
      cwd,
      prompt: '[t1-role: senior-frontend]\nBuild the assigned UI scope.',
      raw: { session_id: 'ses_oc_frontend_1', prompt: '[t1-role: senior-frontend]\nBuild the assigned UI scope.' },
    };
    opencodeSubagentBind({ input: bindInput, host: 'opencode', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-frontend']?.agentId, 'ses_oc_frontend_1');

    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-frontend'),
      prompt: '[t1-role: senior-frontend]\nFix build errors.',
    }, 'parent-oc', 'opencode'));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.ok(duplicate.reason.includes('ses_oc_frontend_1'));
      assert.ok(duplicate.reason.includes('OpenCode'));
      assert.ok(duplicate.reason.includes('[t1-replace-agent]'));
      assert.ok(!duplicate.reason.includes('SendMessage'));
    }

    const replacement = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-frontend'),
      prompt: '[t1-role: senior-frontend]\n[t1-replace-agent]\nPrevious OpenCode agent completed. Follow-up fix cycle: fix build errors only.',
    }, 'parent-oc', 'opencode'));
    assert.equal(replacement.kind, 'noop');
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

test('literal <run-id> template placeholder never trips the spawn gate; Claude rewrites the child input', () => {
  // Hermetic: the agent-reuse gate is teams-env-gated on Claude — force it off so
  // consecutive same-role spawns exercise the run-id path, not reuse denies.
  const prevTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0';
  try {
    withMaterialized({ teamApproved: true }, (cwd) => {
      agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'opus' }));
      const runId = (JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string) || '';
      assert.ok(runId.length > 0, 'currentRunId minted');

      // Template-faithful prompt (the 6c first-spawn shape): correct `Run ID:` header,
      // literal `<run-id>` placeholders left in the runs/digests paths.
      const spawn = agentModelGate(spawnCtx(cwd, {
        subagent_type: 'senior-architect', model: 'opus',
        prompt: `[t1-role: senior-architect]\nRun ID: ${runId}\n\nWrite .traffic-one/runs/<run-id>/assignments.json LAST, then the digest to .traffic-one/digests/<run-id>/architect.md`,
      }));
      assert.notEqual(spawn.kind, 'deny', 'placeholder prompt must not be denied');
      // Claude supports PreToolUse input rewrite: the allow carries a FULL
      // updatedToolInput (every field preserved) with the placeholders substituted.
      assert.equal(spawn.kind, 'context');
      if (spawn.kind === 'context') {
        const updated = spawn.updatedToolInput;
        assert.ok(updated, 'allow carries updatedToolInput');
        assert.equal(updated?.subagent_type, 'senior-architect');
        assert.equal(updated?.model, 'opus');
        const rewritten = String(updated?.prompt);
        assert.ok(!rewritten.includes('<run-id>'), 'placeholder substituted in the child prompt');
        assert.ok(rewritten.includes(`runs/${runId}/assignments.json`));
        assert.ok(rewritten.includes(`digests/${runId}/architect.md`));
      }

      // A fabricated id ALONGSIDE placeholders still denies — naming the fabricated
      // id, and echoing a corrected prompt with neither it nor any placeholder left.
      const bad = agentModelGate(spawnCtx(cwd, {
        subagent_type: 'senior-architect', model: 'opus',
        prompt: 'Write .traffic-one/runs/2026-06-17T13-47-00Z/assignments.json and .traffic-one/digests/<run-id>/architect.md',
      }));
      assert.equal(bad.kind, 'deny');
      if (bad.kind === 'deny') {
        assert.ok(bad.reason.includes('run-id gate'));
        assert.ok(bad.reason.includes('2026-06-17T13-47-00Z'), 'names the fabricated id, not the placeholder');
        assert.ok(bad.reason.includes(`runs/${runId}/assignments.json`), 'echo corrects the fabricated id');
        assert.ok(bad.reason.includes(`digests/${runId}/architect.md`), 'echo substitutes the placeholder too');
        assert.ok(!bad.reason.includes('<run-id>'), 'no placeholder survives into the echo');
      }
    });

    // Non-rewrite host (fresh project so the run policy freezes for copilot): the
    // same placeholder prompt is allowed AS-IS — no deny, no updatedToolInput; the
    // child resolves `<run-id>` itself and the plan write-guard stays the backstop.
    withMaterialized({ teamApproved: true }, (cwd) => {
      const copilot = agentModelGate(spawnCtx(cwd, {
        subagent_type: 'senior-architect', model: 'gpt-5.6-sol',
        prompt: '[t1-role: senior-architect]\nWrite .traffic-one/runs/<run-id>/assignments.json',
      }, 'copilot'));
      assert.equal(copilot.kind, 'noop');
    });

    // The 6c incident shape verbatim: the VERY FIRST spawn of the run, on Cursor,
    // template-faithful prompt (correct `Run ID:` header, placeholder paths), exact
    // captured Task-tool slug. Pre-6c-fix this denied as "Couldn't start"; it must
    // now be allowed on attempt one — and Cursor (no input rewrite) gets no
    // updatedToolInput.
    withMaterialized({ teamApproved: true }, (cwd) => {
      const runId = (JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string) || '';
      assert.ok(runId.length > 0, 'run pre-minted before any spawn (as in the incident)');
      const first = agentModelGate(spawnCtx(cwd, {
        subagent_type: 'senior-architect', model: 'claude-fable-5-thinking-high',
        prompt: `[t1-role: senior-architect]\nRun ID: ${runId}\n\nAlso write assignments.json to .traffic-one/runs/<run-id>/assignments.json LAST.\n\nOn finish, write handoff digest to:\n  .traffic-one/digests/<run-id>/architect.md`,
      }, 'cursor'));
      assert.notEqual(first.kind, 'deny', 'first Cursor architect spawn must not be denied on the template placeholder');
      if (first.kind === 'context') {
        assert.equal(first.updatedToolInput, undefined, 'Cursor allow carries no input rewrite');
      }
    });
  } finally {
    if (prevTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = prevTeams;
  }
});

test('Cursor: model-param requires an exact captured Task-tool slug before staking a claim', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // high senior-frontend → highest tier → cursor "claude-fable-5-thinking-high" (the exact
    // Task-tool slug). The bare Anthropic alias Cursor rejects → deny (the original tester bug).
    // A no/wrong-model spawn is an ORCHESTRATOR-actionable deny — the plain per-role model-tier
    // deny ("pass model=X") — NOT the user-facing budget/disabled CHOICE (that is reserved for a
    // genuine Composer-floor degradation; see degradedToFloorDeny). So the alias here denies with
    // the "Performance gate … pass model" prose, not the enable/fallback question.
    const firstWrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }, 'cursor'));
    assert.equal(firstWrong.kind, 'deny');
    if (firstWrong.kind === 'deny') assert.ok(firstWrong.reason.includes('Performance gate'), 'no/wrong-model spawn gets the plain per-role model deny, not the choice');

    for (const claudeAlias of ['fable', 'best']) {
      const aliasResult = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: claudeAlias }, 'cursor'));
      assert.equal(aliasResult.kind, 'deny', `${claudeAlias} remains invalid on Cursor`);
    }

    // Terra is a BALANCED Task-tool slug, NOT highest → deny: no cross-tier acceptance.
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium' }, 'cursor'));
    assert.equal(wrong.kind, 'deny');
    if (wrong.kind === 'deny') assert.ok(wrong.reason.includes('Performance gate'));

    // No model param → deny (would inherit the parent model).
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend' }, 'cursor')).kind, 'deny');

    // A family alias or invented sub-variant satisfies the tier but is NOT an exact Cursor Task id.
    // Deny before Cursor sees the Task call, otherwise it creates a visible "Couldn't start" card.
    const bareFamily = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5' }, 'cursor'));
    assert.equal(bareFamily.kind, 'deny');
    if (bareFamily.kind === 'deny') {
      assert.ok(bareFamily.reason.includes('Cursor model gate'));
      assert.ok(bareFamily.reason.includes('claude-fable-5-thinking-high'));
    }
    const invented = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high-fast' }, 'cursor'));
    assert.equal(invented.kind, 'deny');
    if (invented.kind === 'deny') assert.ok(invented.reason.includes('Cursor model gate'));

    // The exact highest Task-tool slug passes.
    // The FIRST passing Cursor spawn of the run also carries the one-time model-availability
    // advisory (kind 'context'); it is still an ALLOW (not a deny) and stakes the claim.
    assert.notEqual(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor')).kind, 'deny');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const runId = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    assert.ok(runId.length > 0, 'currentRunId minted on Cursor spawn');
    const pending = fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId, 'pending')).filter((f) => f.startsWith('senior-frontend-'));
    assert.ok(pending.length > 0, 'pending senior-frontend claim staked on Cursor');
  });
});

test('Cursor: the configured same-tier FALLBACK model satisfies the gate when the build lacks the preferred slug', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // highest preferred = claude-fable-5-thinking-high; if a build doesn't offer it, the
    // configured same-tier fallback (gpt-5.6-sol-medium)
    // satisfies the tier via the accept-set and stakes a claim, instead of deadlocking.
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'gpt-5.6-sol-medium' }, 'cursor'));
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
    const r = agentModelGate(spawnCtx(pkg, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor', cwd));
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
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    withCursorAvailableModels(prefs, ['composer-2.5-fast'], 'business');
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    const r = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
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
      assert.ok(d.reason.includes('claude-fable-5-thinking-high'), 'names the recommended build slug');
      assert.ok(d.reason.includes('gpt-5.6-sol-medium'), 'names a usable same-tier fallback build slug');
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

test('Cursor capture precondition: the immutable run stays blocked until the picker is captured', () => {
  withMaterialized({ teamApproved: true, cursorModels: null }, (cwd) => {
    // No captured model list yet → the gate asks the orchestrator to enumerate + persist it.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(/model-capture|list the model ids/i.test(first.reason), 'asks to capture the model list');
      assert.match(first.reason, /required before the first team spawn/i);
      assert.doesNotMatch(first.reason, /optional|re-issue the same.*unchanged/i);
    }
    // Retrying without satisfying the prerequisite cannot mint a policy with an
    // empty model list or silently advance on guessed slugs.
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.equal(second.kind, 'deny');

    // A non-empty but partial picker capture is still unsafe for an immutable
    // run: Balanced roles and quick-fix would have no exact runnable slug.
    assert.equal(captureCursorModels(cwd, ['claude-fable-5-thinking-high'], 'pro'), true);
    const partial = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.equal(partial.kind, 'deny');
    if (partial.kind === 'deny') {
      assert.match(partial.reason, /missing captured tiers(?: for this run)?:\s*balanced, cheapest/i);
    }
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    assert.equal(readRunModelPolicy(cwd, runId), null, 'partial capture cannot publish model-policy.json');

    assert.equal(captureCursorModels(cwd, DEFAULT_CURSOR_MODELS, 'pro'), true);
    const third = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.notEqual(third.kind, 'deny', 'capture lets the parent create the policy and proceed');
    const policy = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', runId, 'model-policy.json'), 'utf8'));
    assert.deepEqual(policy.cursorAvailableModels, DEFAULT_CURSOR_MODELS);
  });
});

test('Cursor spawn and child bind stay on the frozen run after sidecar, plan, and availableModels mutate; next run adopts them', () => {
  withMaterialized({ teamApproved: true, level: 'high' }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-frozen-target');
    freezeRunPolicy(cwd, 'cursor', 'run-cursor-frozen-target');
    const frozen = readRunModelPolicy(cwd, 'run-cursor-frozen-target');
    assert.ok(frozen);
    const oldExpected = frozen!.roles['senior-architect']!.preferredModel;
    const oldExact = frozen!.cursorAvailableModels!.find((model) => model.startsWith(oldExpected))!;
    assert.ok(oldExact);

    const payload: OneMcpModelConfigPayload = {
      tiers: {
        high: ['remote-base-high'], balanced: ['remote-base-balanced'],
        low: ['remote-base-low'], auto: ['remote-base-balanced'],
      },
      plans: {
        business: {
          high: ['remote-business-high'], balanced: ['remote-business-balanced'],
          low: ['remote-business-low'], auto: ['remote-business-balanced'],
        },
      },
    };
    writeOneMcpConfigCacheEntry('cursor', {
      endpoint: publicEndpoint(process.env),
      configName: ONE_MCP_CONFIG_NAME_BY_HOST.cursor,
      decoderVersion: ONE_MCP_DECODER_VERSION,
      version: 9,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-17T12:00:00.000Z',
      payload,
      payloadFingerprint: oneMcpPayloadFingerprint(payload),
    }, process.env);
    process.env.TRAFFIC_ONE_USER_PLAN = 'business';
    const newModels = [
      'remote-business-high-build', 'remote-business-balanced-build', 'remote-business-low-build',
    ];
    assert.equal(captureCursorModels(cwd, newModels, 'business'), true);
    const nextTarget = currentHostModelTarget('cursor', 'business');
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')) as {
      hosts: Record<string, { performance: Record<string, unknown>; team: Record<string, unknown> }>;
    };
    prefs.hosts.cursor!.performance = {
      level: 'balanced', source: 'prompted',
      target: { plan: 'business', appliedFingerprint: nextTarget.appliedFingerprint, configVersion: 9 },
    };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');

    const spawn = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-architect',
      model: oldExact,
      prompt: 'Continue the frozen architecture run.',
    }, 'parent-frozen', 'cursor'));
    assert.notEqual(spawn.kind, 'deny', 'old run ignores the new sidecar, plan, and picker capture');

    const started = subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'subagent-start',
      subagent_id: 'tool_frozen_cursor_child',
      subagent_type: 'senior-architect',
      subagent_model: oldExact,
      session_id: 'parent-frozen',
      started_at: Date.now(),
    }, 'cursor'));
    assert.equal(started.kind, 'noop');
    const observation = listCursorSpawnObservations(cwd, 'run-cursor-frozen-target')[0];
    assert.equal(observation?.tier, frozen!.roles['senior-architect']!.tier);
    assert.equal(observation?.expectedModel, oldExpected);
    assert.deepEqual(readRunModelPolicy(cwd, 'run-cursor-frozen-target')?.cursorAvailableModels, DEFAULT_CURSOR_MODELS);

    setCurrentRunId(cwd, 'run-cursor-next-target');
    assert.deepEqual(freshCursorModels(cwd, 'business'), newModels);
    const nextState = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
    assert.deepEqual((nextState.performance as Record<string, unknown>).target, {
      plan: 'business', appliedFingerprint: nextTarget.appliedFingerprint, configVersion: 9,
    });
    freezeRunPolicy(cwd, 'cursor', 'run-cursor-next-target');
    const next = readRunModelPolicy(cwd, 'run-cursor-next-target');
    assert.equal(next?.plan, 'business');
    assert.equal(next?.configVersion, 9);
    assert.match(next?.roles['senior-architect']?.preferredModel || '', /^remote-business-/);
    assert.notEqual(next?.roles['senior-architect']?.preferredModel, oldExpected);
    assert.deepEqual(next?.cursorAvailableModels, newModels);
  });
});

test('Cursor: the PASSED model is authoritative — a matching .cursor/agents frontmatter does NOT rescue a no-model/wrong-model spawn (Cursor ignores the frontmatter, inherits the parent model)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // high senior-frontend → highest tier → Fable family. Materialize the frontmatter with the
    // correct Fable slug — but on Cursor that is NOT auto-applied: omitting `model` makes the
    // subagent inherit the PARENT model, so the gate must REQUIRE the passed model.
    const agentsDir = path.join(cwd, '.cursor', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'senior-frontend.md'), `---\nname: senior-frontend\nmodel: claude-fable-5-thinking-high\n---\nbody\n`, 'utf8');

    // NO model param → DENY, even though the frontmatter pins the right model.
    const noModel = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend' }, 'cursor'));
    assert.equal(noModel.kind, 'deny', 'no `model` arg → deny (Cursor would inherit the parent model)');

    // A WRONG-tier passed model → DENY (the matching frontmatter no longer rescues it). This is
    // the 19b bug: a balanced-override role pinned correctly but spawned on the parent's Opus.
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium' }, 'cursor'));
    assert.equal(wrong.kind, 'deny', 'wrong-tier passed model denies despite a matching frontmatter');

    // The CORRECT passed model → allowed (first pass may carry the one-time advisory).
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.notEqual(ok.kind, 'deny', 'the passed model is what satisfies the gate');
  });
});

test('Cursor degraded-to-floor choice: names the RECOMMENDED tier model verbatim (not the available floor), prompts once, then a recorded choice proceeds', () => {
  // Fable IS offered (so the eligibility gate does not fire) but the API budget is exhausted, so
  // the orchestrator passes composer-2.5-fast (the floor). The choice deny must name the model the
  // user should restore (`claude-fable-5`, the tier family) — NOT the floor it collapsed to.
  withMaterialized({ teamApproved: true, cursorModels: ['claude-fable-5-thinking-high', 'gpt-5.6-sol-medium', 'composer-2.5-fast'] }, (cwd) => {
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
      assert.ok(first.reason.includes('claude-fable-5'), 'recommended model is the disabled tier family, not the available floor');
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
      assert.ok(blockedFloor.reason.includes('claude-fable-5'), 'names the recommended model to enable');
    }

    // 5) "enable-retry" + the orchestrator now passing a recommended-family slug → proceeds normally
    //    (not on the floor, so the degradation deny never fires).
    const er = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.notEqual(er.kind, 'deny', `enable-retry on the recommended model proceeds${er.kind === 'deny' ? `: ${er.reason}` : ''}`);
  });
});

test('Cursor eligibility: the PICKED model is not offered (disabled) → ask ONCE even when the fallback is a valid alternate (the "I wasn\'t asked" gap)', () => {
  // The 23b incident: architect overridden to BALANCED → GPT-5.6 Terra, but the build offers
  // only Fable + Sonnet 5 + Composer — NO Terra. Materialization falls back to Sonnet 5,
  // which SATISFIES the balanced tier, so the spawn would pass silently. degradedToFloorDeny does
  // NOT catch this (Sonnet 5 is not the Composer floor). The eligibility gate must surface the
  // choice ONCE, naming the recommended model to enable (Terra) + the fallback it would use.
  withMaterialized({
    teamApproved: true,
    cursorModels: ['claude-fable-5-thinking-high', 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'],
  }, (cwd) => {
    // Override the architect to balanced so its preferred model is GPT-5.6 Terra (absent).
    const prefs = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'));
    for (const hostPrefs of Object.values(prefs.hosts) as Record<string, unknown>[]) {
      (hostPrefs.team as Record<string, unknown>).overrides = { 'senior-architect': 'balanced' };
    }
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify(prefs), 'utf8');

    // The architect is spawned on the resolved fallback (Sonnet 5) — a VALID balanced model.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'claude-sonnet-5-thinking-high' }, 'cursor'));
    assert.equal(first.kind, 'deny', 'the picked-but-unavailable model surfaces a choice, not a silent fallback');
    if (first.kind === 'deny') {
      assert.ok(first.reason.includes('gpt-5.6-terra'), 'names the recommended model the user picked (to enable)');
      assert.ok(first.reason.includes('claude-sonnet-5'), 'names the same-tier fallback it would use');
      assert.ok(first.promptRequest !== undefined, 'carries a promptRequest modal');
    }
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    assert.equal(modelChoicePrompted(cwd, runId), true, 'prompted marker set (shared, at most one model prompt/run)');

    // Without a recorded answer, the same spawn stays blocked (fail closed).
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'claude-sonnet-5-thinking-high' }, 'cursor'));
    assert.equal(second.kind, 'deny', 'without explicit use-fallback, same-tier fallback stays blocked');

    writeModelChoice(cwd, runId, 'use-fallback');
    const allowed = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'claude-sonnet-5-thinking-high' }, 'cursor'));
    assert.notEqual(allowed.kind, 'deny', 'recorded use-fallback proceeds on the fallback');

    writeModelChoice(cwd, runId, 'enable-retry');
    const blockedFallback = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect', model: 'claude-sonnet-5-thinking-high' }, 'cursor'));
    assert.equal(blockedFallback.kind, 'deny', 'recorded enable-retry must block the same-tier fallback');
    if (blockedFallback.kind === 'deny') {
      assert.ok(/enable\/retry|do NOT proceed on a fallback/i.test(blockedFallback.reason));
      assert.ok(blockedFallback.reason.includes('gpt-5.6-terra'), 'names the picked model to enable');
    }

    // A role whose PREFERRED model IS offered (frontend → Fable, present) is NOT prompted.
    const fe = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
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
      assert.ok(!first.reason.includes('gpt-5.6-sol'), 'does not offer an absent first alternate');
    }
  });
});

test('Cursor proactive advisory: first passing spawn names the models + enable path, once per run', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.equal(first.kind, 'context', 'first passing Cursor spawn carries the advisory');
    if (first.kind === 'context') {
      assert.ok(first.context.includes('claude-fable-5-thinking-high'), 'advisory lists the team models');
      assert.ok(/budget/i.test(first.context), 'advisory names the budget-exhaustion cause + remedy');
      // USER-VISIBLE: rides systemMessage (→ user_message on Cursor), not just additional_context.
      assert.ok(first.systemMessage !== undefined, 'advisory has a user-visible systemMessage');
      assert.ok(/budget|Composer/i.test(String(first.systemMessage)), 'the visible banner explains the Composer/budget situation');
    }
    // A second passing spawn (different role) → advisory already shown → clean noop.
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
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
    for (const hostPrefs of Object.values(prefs.hosts) as Record<string, unknown>[]) {
      hostPrefs.team = { ...(hostPrefs.team as Record<string, unknown>), overrides: { 'quick-fix': 'highest' } };
    }
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
    setCurrentRunId(cwd, 'run-Q');
    queueDelegateRole(cwd, 'quick-fix');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));

    markOpenCodeRoleAttempted(cwd, 'run-Q', 'quick-fix');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' })).kind, 'noop');
  });
});

test('architect phase gate: blocks implementers when plan exists but baseline is incomplete', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    const t1 = path.join(cwd, '.traffic-one');
    fs.writeFileSync(path.join(t1, 'plan.md'), '# partial plan', 'utf8');
    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') {
      assert.ok(denied.reason.includes('Architect phase gate'));
      assert.ok(denied.reason.includes('coding.md'));
      assert.ok(denied.reason.includes('spawn `senior-architect`'), 'prose leads with the next action');
    }
  });
});

test('architect phase gate stands down in MAINTENANCE once a prior assignments manifest exists (8c)', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    const t1 = path.join(cwd, '.traffic-one');
    fs.writeFileSync(path.join(t1, 'plan.md'), '# partial plan', 'utf8');
    // Post-build state: mode stays "new-project", lifecycle flips to maintenance,
    // and a small-tier feature starts a FRESH run with no architect artifacts.
    const onePath = path.join(t1, '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.currentRunId = 'run-maint-2';
    one.lifecycle = { phase: 'maintenance', source: 'prompt-boundary' };
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    // No assignments manifest anywhere → the gate still fires (nothing to scope by).
    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('Architect phase gate'));

    // The BUILD run's manifest exists → resilient scope fallback → implementer
    // spawns first-try (task-triage small tier: no architect for a small feature).
    fs.mkdirSync(path.join(t1, 'runs', 'run-build'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'runs', 'run-build', 'assignments.json'), JSON.stringify({
      version: 1,
      runId: 'run-build',
      createdBy: 'senior-architect',
      assignments: [{ role: 'senior-frontend', scope: { include: ['apps/web/**'], exclude: [] } }],
    }), 'utf8');
    const allowed = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(allowed.kind, 'noop', allowed.kind === 'deny' ? allowed.reason : undefined);
  });
});

test('opencode plan-batch gate: queued Step-0 work blocks both implementers until the batch is terminal', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    setCurrentRunId(cwd, 'run-plan-batch');
    queueDelegateRoles(cwd, ['frontend', 'backend']);

    const backend = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' }));
    assert.equal(backend.kind, 'deny');
    if (backend.kind === 'deny') {
      assert.ok(backend.reason.includes('OpenCode plan-batch gate'));
      assert.ok(backend.reason.includes('opencode_delegate_from_plan'));
      assert.ok(backend.reason.includes('frontend, backend'));
      assert.ok(backend.reason.includes('Do NOT retry Task/spawn_agent'));
      assert.ok(backend.context?.includes('do NOT retry Task spawns'));
      assert.ok(backend.context?.includes('opencode_delegate_from_plan'));
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
    assert.equal(stillBackend.kind, 'deny', 'backend stays blocked until batch is terminal');
    markOpenCodePlanRoleCompleted(cwd, 'run-plan-batch', 'backend');
    const stillBoth = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' }));
    assert.equal(stillBoth.kind, 'deny', 'per-role markers alone do not clear the batch gate');

    markOpenCodePlanBatchTerminal(cwd, 'run-plan-batch', 'success');
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
    setCurrentRunId(cwd, 'run-plan-complete');
    queueDelegateRoles(cwd, ['frontend', 'backend', 'tester']);

    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'deny');
    markOpenCodePlanBatchComplete(cwd, 'run-plan-complete');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'noop');
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' })).kind, 'noop');
  });
});

test('opencode plan-batch gate: failed terminal batch.json clears implementers (fail-open)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true };
    prefs.toolchain = { opencode: { installedVersion: '1.17.8' } };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    setCurrentRunId(cwd, 'run-plan-failed');
    queueDelegateRoles(cwd, ['frontend', 'backend']);

    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: 'opus' })).kind, 'deny');
    markOpenCodePlanBatchTerminal(cwd, 'run-plan-failed', 'failed', 'every unit failed');
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
    setCurrentRunId(cwd, 'run-X');
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
    markOpenCodePlanBatchTerminal(cwd, 'run-X', 'success');
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
    setCurrentRunId(cwd, 'run-noqueue');
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
    setCurrentRunId(cwd, 'run-reviewer-reject');
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
    setCurrentRunId(cwd, 'run-clean');
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
    setCurrentRunId(cwd, 'run-codex');
    queueDelegateRole(cwd, 'senior-tester');

    // A configured role on Codex is delegated to OpenCode first, exactly like Claude/Cursor.
    const denied = agentModelGate(codexSpawnCtx(cwd, {
      agent_type: 'worker',
      message: 'You are acting as Traffic One `senior-tester` for this Codex run.',
      model: 'gpt-5.6-terra',
    }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));
    // Deny-once: a second spawn (no attempt recorded — e.g. tool unavailable) falls through.
    const fallback = agentModelGate(codexSpawnCtx(cwd, {
      agent_type: 'worker',
      message: 'You are acting as Traffic One `senior-tester` for this Codex run.',
      model: 'gpt-5.6-terra',
    }));
    assert.equal(fallback.kind, 'noop', fallback.kind === 'deny' ? fallback.reason : undefined);
  });
});

test('a pinned openCode.model does not change gating (no per-model branch)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    prefs.openCode = { enabled: true, model: 'opencode/gpt-5.5' };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    setCurrentRunId(cwd, 'run-pinned');
    queueDelegateRole(cwd, 'senior-tester');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-tester', model: 'haiku' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') {
      assert.ok(denied.reason.includes('OpenCode role gate'));
      // the gate no longer injects a per-model instruction into the deny
      assert.ok(!denied.reason.includes('opencode/gpt-5.5'));
    }
  });
});

// Codex spawn ctx: namespaced multi-agent tool, role conveyed in the prose message
// (Codex passes agent_type:"worker", not a Traffic One subagent_type), session_id is
// the spawner/parent thread. Host 'codex' so the model tier resolves to Sol/Terra.
function codexSpawnCtx(cwd: string, toolInput: Record<string, unknown>, rawName = 'multi_agent_v1.spawn_agent'): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host: 'codex', cwd,
    raw: { tool_name: rawName, tool_input: toolInput, session_id: 'parent-thread-1' },
    tool: { class: 'spawn-agent' as ToolClass, rawName },
  };
  return { input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx;
}

function subagentStartCtx(cwd: string, raw: Record<string, unknown>, host: 'codex' | 'cursor' | 'copilot' = 'codex'): Ctx {
  const input: HookInput = { event: 'SubagentStart', host, cwd, raw };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

function codexSessionMeta(childThread: string, parentThread: string, agentPath: string): Record<string, unknown> {
  return {
    timestamp: '2026-07-16T08:15:39.909Z',
    type: 'session_meta',
    payload: {
      id: childThread,
      parent_thread_id: parentThread,
      thread_source: 'subagent',
      agent_path: agentPath,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentThread,
            agent_path: agentPath,
          },
        },
      },
    },
  };
}

function codexChildPreToolCtx(
  cwd: string,
  childThread: string,
  parentThread: string,
  transcript: string,
  model: string,
  extra: Record<string, unknown> = {},
): Ctx {
  return {
    input: {
      event: 'PreToolUse', host: 'codex', cwd,
      raw: {
        hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: childThread,
        session_id: parentThread, transcript_path: transcript, model, ...extra,
      },
      tool: { class: 'file-read', rawName: 'Read', filePath: path.join(cwd, 'README.md') },
    },
    host: 'codex', cwd, now: () => 'x',
  } as unknown as Ctx;
}

test('codex: namespaced parent spawn validates intent but creates no claim or reusable row', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const missing = agentModelGate(codexSpawnCtx(cwd, {
      task_name: 'senior_frontend',
      message: 'You are `senior-frontend` for Traffic One.',
      fork_turns: 'none',
    }));
    assert.equal(missing.kind, 'deny');
    const ok = agentModelGate(codexSpawnCtx(cwd, {
      task_name: 'senior_frontend',
      message: 'You are `senior-frontend` for Traffic One.',
      fork_turns: 'none',
      model: 'gpt-5.6-sol',
    }));
    assert.equal(ok.kind, 'noop');

    // Requested parent input is not runtime proof. SubagentStart/child
    // PreToolUse must observe the actual model before durable child state exists.
    const state = readEffectiveState(cwd) as { currentRunId?: string };
    const pending = path.join(cwd, '.traffic-one', 'runs', String(state.currentRunId), 'pending');
    assert.equal(fs.existsSync(pending), false);
    assert.deepEqual(readRunAgentRegistry(cwd, String(state.currentRunId)), {});
  });
});

test('codex: quick-fix requires the exact cheapest model without an early parent claim', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const missing = agentModelGate(codexSpawnCtx(cwd, {
      message: 'You are acting as Traffic One quick-fix. Apply one bounded maintenance fix.',
    }));
    assert.equal(missing.kind, 'deny');
    const result = agentModelGate(codexSpawnCtx(cwd, {
      task_name: 'quick_fix',
      message: 'You are acting as Traffic One quick-fix. Apply one bounded maintenance fix.',
      fork_turns: 'none',
      model: 'gpt-5.6-terra',
    }));
    assert.equal(result.kind, 'noop');
    const pending = path.join(cwd, '.traffic-one', 'runs', 'run-test', 'pending');
    assert.equal(fs.existsSync(pending), false);
    assert.deepEqual(readRunAgentRegistry(cwd, 'run-test'), {});
  });
});

test('codex end-to-end: observed SubagentStart model verifies against policy before the child claim resolves', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const childThread = '019e7396-6543-7881-a4a9-dfe9d5a17807';
    const childTranscript = path.join(cwd, `rollout-2026-05-29T14-54-56-${childThread}.jsonl`);
    fs.writeFileSync(childTranscript, `${JSON.stringify(codexSessionMeta(
      childThread,
      'orchestrator-parent',
      '/root/senior_frontend',
    ))}\n`, 'utf8');

    // SubagentStart fires in the parent context (session_id = parent) with the child agent_id + transcript.
    subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart', agent_id: childThread, session_id: 'orchestrator-parent',
      transcript_path: childTranscript, task_name: 'senior_frontend', model: 'gpt-5.6-sol',
    }));

    // The child's apply_patch reports the PARENT session_id but its own transcript_path →
    // resolves the claimed role by transcript threadId (no pending-claiming).
    const state = readEffectiveState(cwd);
    const child = resolveRunAgentContext(cwd, state, {
      session_id: 'orchestrator-parent', transcript_path: childTranscript, model: 'gpt-5.6-sol',
    }, { claimPending: false, host: 'codex' });
    assert.ok(child, 'expected the child write to resolve the claimed role via transcript threadId');
    assert.equal(child!.role, 'senior-frontend');
    assert.equal(child!.sessionId, childThread);

    // The orchestrator (its own transcript, no claim) resolves no role → main-agent writes stay blocked.
    const mainTranscript = path.join(cwd, 'rollout-2026-05-29T14-00-00-019e7389-8edd-7e50-b566-2e9a0d52b9d9.jsonl');
    assert.equal(resolveRunAgentContext(cwd, state, { session_id: 'orchestrator-parent', transcript_path: mainTranscript }, { claimPending: false }), null);
  });
});

test('codex unresolved SubagentStart reports canonical recovery and creates no claim for missing or short rollouts', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const cases = [
      { label: 'missing', childThread: '019f69fe-e335-7de0-be43-1ee45e3535c4', contents: null },
      { label: 'short', childThread: '019f69fe-e335-7de0-be43-1ee45e3535c5', contents: '{"type":"session_' },
    ] as const;

    for (const item of cases) {
      const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${item.childThread}.jsonl`);
      if (item.contents !== null) fs.writeFileSync(transcript, item.contents, 'utf8');
      const result = subagentStartBind(subagentStartCtx(cwd, {
        hook_event_name: 'SubagentStart',
        agent_id: item.childThread,
        session_id: parentThread,
        transcript_path: transcript,
      }));

      assert.equal(result.kind, 'context', `${item.label} rollout is unresolved but SubagentStart stays non-blocking`);
      if (result.kind === 'context') {
        assert.match(result.context, /no per-run role claim was created/i);
        assert.match(result.context, /Do not write files from this child/i);
        assert.match(result.context, /stop or replace this child and retry the same role/i);
        assert.match(result.context, /`senior_architect`/);
        assert.match(result.context, /`senior_frontend`/);
        assert.match(result.context, /encrypts the spawn message/i);
        assert.match(result.context, /marker position is not an identity requirement/i);
        assert.match(result.context, /Do not self-assert a role in assistant prose/i);
      }
      assert.equal(
        fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'run-test', `${item.childThread}.json`)),
        false,
        `${item.label} rollout must not create a guessed child claim`,
      );
    }

    assert.deepEqual(readRunAgentRegistry(cwd, 'run-test'), {}, 'unresolved starts do not create reusable agent rows');
    const captureFile = path.join(cwd, '.traffic-one', 'runs', 'run-test', 'debug', 'claim-capture.jsonl');
    const unresolved = fs.readFileSync(captureFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { label?: string; raw?: Record<string, unknown> })
      .filter((entry) => entry.label === 'subagent-start-role-unresolved');
    assert.equal(unresolved.length, 2, 'both attribution races emit a bounded structural diagnostic');
    assert.deepEqual(unresolved.map((entry) => entry.raw?.threadId), cases.map((item) => item.childThread));
    assert.ok(unresolved.every((entry) => entry.raw?.hasTranscriptPath === true));
  });
});

test('codex unresolved start without a parent run never mints or repairs policy from the child', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    delete one.currentRunId;
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    const childThread = '019f69fe-e335-7de0-be43-1ee45e3535c9';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${childThread}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"session_', 'utf8');

    const result = subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart',
      agent_id: childThread,
      session_id: 'orchestrator-parent',
      transcript_path: transcript,
      model: 'gpt-5.6-sol',
    }));
    assert.equal(result.kind, 'context');
    const runId = String(JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId || '');
    assert.equal(runId, '', 'only the parent may mint a run and create model-policy.json');
  });
});

test('codex child PreToolUse completes a pending-role observation after line-zero metadata appears', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childThread = '019f69fe-e335-7de0-be43-1ee45e3535c6';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${childThread}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"session_', 'utf8');

    const unresolved = subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart',
      agent_id: childThread,
      session_id: parentThread,
      transcript_path: transcript,
      model: 'gpt-5.6-sol',
    }));
    assert.equal(unresolved.kind, 'context');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'run-test', `${childThread}.json`)), false);

    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(childThread, parentThread, '/root/senior_architect'))}\n`,
      'utf8',
    );
    const gate = codexChildModelGate({
      input: {
        event: 'PreToolUse', host: 'codex', cwd,
        raw: {
          hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: childThread,
          session_id: parentThread, transcript_path: transcript, model: 'gpt-5.6-sol',
        },
        tool: { class: 'file-read', rawName: 'Read', filePath: path.join(cwd, 'README.md') },
      },
      host: 'codex', cwd, now: () => 'x',
    } as unknown as Ctx);
    assert.equal(gate.kind, 'noop');
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'codex' });
    const firstWrite = resolveRunAgentContext(cwd, state, {
      session_id: parentThread,
      transcript_path: transcript,
      agent_id: childThread,
      model: 'gpt-5.6-sol',
    }, { host: 'codex' });

    assert.ok(firstWrite, 'the first child write binds after the rollout flushes line-zero metadata');
    assert.equal(firstWrite?.role, 'senior-architect');
    assert.equal(firstWrite?.sessionId, childThread);
    const claim = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'run-test', `${childThread}.json`),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(claim.role, 'senior-architect');
    assert.equal(claim.parentSessionId, parentThread);
    assert.equal(claim.roleSource, 'codex-session-meta-agent-path');
    assert.equal(claim.transcriptPath, transcript);
  });
});

test('codex followup model drift retires the child and frees the role for one replacement', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childA = '019f8fa1-1111-7000-8000-00000000000a';
    const childB = '019f8fa1-2222-7000-8000-00000000000b';
    const transcriptA = path.join(cwd, `rollout-drift-${childA}.jsonl`);
    const transcriptB = path.join(cwd, `rollout-drift-${childB}.jsonl`);
    fs.writeFileSync(transcriptA, `${JSON.stringify(codexSessionMeta(childA, parentThread, '/root/senior_tester'))}\n`, 'utf8');
    fs.writeFileSync(transcriptB, `${JSON.stringify(codexSessionMeta(childB, parentThread, '/root/senior_tester'))}\n`, 'utf8');

    // spawn-time model verifies and claims the role
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra')).kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, childA);

    // a later followup turn silently runs on the PARENT's model (observed
    // 8c-codex): terminal conflict, and the deny both retires the thread and
    // durably releases the role slot in the reuse registry
    const drift = codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-sol'));
    assert.equal(drift.kind, 'deny');
    if (drift.kind === 'deny') {
      assert.match(drift.reason, /hook-model-conflict/);
      assert.match(drift.reason, /retired/i);
      assert.match(drift.reason, /released for ONE replacement/);
      assert.match(drift.reason, /spawn a FRESH child/i);
      assert.match(drift.reason, /Do NOT follow-up or interrupt-respawn/i);
    }
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childA])?.status, 'conflict');
    const registryRaw = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'run-test', 'agents.json'), 'utf8',
    )) as { agents: Record<string, { agentId?: string; replaced?: boolean; replacementReason?: string }>; history?: unknown[] };
    assert.equal(registryRaw.agents['senior-tester']?.replaced, true);
    assert.equal(registryRaw.agents['senior-tester']?.replacementReason, 'hook-model-conflict');
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.replaced, true, 'the reuse row is marked replaced');

    // the retired thread stays blocked on every later call
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra')).kind, 'deny');

    // a FRESH policy-compliant child now claims the released slot
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childB, parentThread, transcriptB, 'gpt-5.6-terra')).kind, 'noop');
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childB])?.status, 'verified');
    const replaced = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'run-test', 'agents.json'), 'utf8',
    )) as { agents: Record<string, { agentId?: string; replaced?: boolean }>; history?: Array<Record<string, unknown>> };
    assert.equal(replaced.agents['senior-tester']?.agentId, childB);
    assert.equal(replaced.agents['senior-tester']?.replaced, false);
    assert.ok(
      (replaced.history || []).some((entry) => entry.oldAgentId === childA && entry.newAgentId === childB
        && entry.replacementReason === 'hook-model-conflict'),
      'the retired incumbent is preserved in registry history',
    );
    const claimB = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'run-test', `${childB}.json`), 'utf8',
    )) as Record<string, unknown>;
    assert.equal(claimB.role, 'senior-tester');

    // the dead thread cannot disturb the live replacement
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-sol')).kind, 'deny');
    const after = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'run-test', 'agents.json'), 'utf8',
    )) as { agents: Record<string, { agentId?: string; replaced?: boolean }> };
    assert.equal(after.agents['senior-tester']?.agentId, childB);
    assert.equal(after.agents['senior-tester']?.replaced, false);
    });
  });
});

test('codex depth-2 replacement spawn (child-of-child) passes the parent-pair check', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    // Codex reports the ROOT conversation as session_id for EVERY child while
    // line-zero parent_thread_id names the IMMEDIATE parent (here: another
    // senior child). Before the fix this exact shape was denied as a
    // child/parent pair mismatch (observed 8c-codex: every architect-spawned
    // reviewer replacement was stranded before its first read).
    const rootSession = '019f8f7c-501d-76f1-892f-5cedbd39f57d';
    const architect = '019f8f7f-eef6-7f40-a47d-ae4c90c8e3fa';
    const child = '019f8fa1-3333-7000-8000-00000000000c';
    const transcript = path.join(cwd, `rollout-depth2-${child}.jsonl`);
    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(child, architect, '/root/senior_architect/senior_tester'))}\n`,
      'utf8',
    );
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, child, rootSession, transcript, 'gpt-5.6-terra')).kind, 'noop');
    const observation = readCodexModelObservation(cwd, 'run-test', [child]);
    assert.equal(observation?.status, 'verified');
    assert.equal(observation?.parentSessionId, architect, 'the immediate parent from line-zero wins');
    // the second call re-compares the stored immediate parent against the
    // hook's root session — still the same true pair, still open
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, child, rootSession, transcript, 'gpt-5.6-terra')).kind, 'noop');
    // an explicitly contradictory parent claim (neither line-zero parent nor
    // the root session) is still a mismatch
    const liar = codexChildModelGate(codexChildPreToolCtx(
      cwd, child, rootSession, transcript, 'gpt-5.6-terra',
      { parent_session_id: '019f8fa1-4444-7000-8000-00000000000d' },
    ));
    assert.equal(liar.kind, 'deny');
  });
});

test('codex depth-2 replacement survives the SubagentStart→PreToolUse parent upgrade', () => {
  // The exact 9c-codex failure: SubagentStart fires before the child rollout
  // flushes line-zero (parent unknown at that moment), then the first
  // PreToolUse reads line-zero's IMMEDIATE parent (another senior child, not
  // the root session). That upgrade used to persist as a terminal
  // `parent-session-conflict`, killing every depth-2 replacement on arrival.
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      freezeRunPolicy(cwd, 'codex');
      const root = '019f8f7c-501d-76f1-892f-5cedbd39f57d';
      const frontend = '019f9003-27d2-7f11-a0e3-50866abbb205';
      const child = '019f9012-d290-73d0-a235-02b3bd84e52e';
      const transcript = path.join(cwd, `rollout-parent-upgrade-${child}.jsonl`);
      fs.writeFileSync(transcript, '{"type":"session_', 'utf8');
      const start = subagentStartBind(subagentStartCtx(cwd, {
        hook_event_name: 'SubagentStart', agent_id: child, session_id: root,
        transcript_path: transcript, task_name: 'senior_tester', model: 'gpt-5.6-terra',
      }));
      assert.ok(start.kind === 'noop' || start.kind === 'context', 'SubagentStart is never a deny here');
      // line-zero now appears: this child was spawned BY the frontend (depth 2)
      fs.writeFileSync(
        transcript,
        `${JSON.stringify(codexSessionMeta(child, frontend, '/root/senior_frontend/senior_tester'))}\n`,
        'utf8',
      );
      const gate = codexChildModelGate(codexChildPreToolCtx(cwd, child, root, transcript, 'gpt-5.6-terra'));
      assert.equal(gate.kind, 'noop', 'parent upgrade (spawn-time unknown → line-zero immediate parent) must not conflict');
      const observation = readCodexModelObservation(cwd, 'run-test', [child]);
      assert.equal(observation?.status, 'verified');
      assert.equal(observation?.parentSessionId, frontend, 'the line-zero immediate parent wins');
    });
  });
});

test('codex observation parent upgrades across evidence grades but conflicts within a grade', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const root = '019f8f7c-501d-76f1-892f-5cedbd39f57d';
    const frontend = '019f9003-27d2-7f11-a0e3-50866abbb205';
    // legacy/other-caller shape: SubagentStart recorded the ROOT session as parent
    const upgraded = (() => {
      observeCodexChildModel(cwd, 'run-test', {
        childId: 'child-upgrade', parentSessionId: root, actualModel: 'gpt-5.6-terra',
        role: 'senior-tester', source: 'SubagentStart',
      });
      return observeCodexChildModel(cwd, 'run-test', {
        childId: 'child-upgrade', parentSessionId: frontend, actualModel: 'gpt-5.6-terra',
        role: 'senior-tester', source: 'PreToolUse',
      });
    })();
    assert.equal(upgraded?.status, 'verified');
    assert.equal(upgraded?.parentSessionId, frontend);
    // a later, weaker SubagentStart parent notion is ignored, not a conflict
    const lateStart = observeCodexChildModel(cwd, 'run-test', {
      childId: 'child-upgrade', parentSessionId: root, actualModel: 'gpt-5.6-terra',
      role: 'senior-tester', source: 'SubagentStart',
    });
    assert.equal(lateStart?.status, 'verified');
    assert.equal(lateStart?.parentSessionId, frontend);
    // same-grade disagreement (line-zero itself changed) stays terminal
    const conflicted = observeCodexChildModel(cwd, 'run-test', {
      childId: 'child-upgrade', parentSessionId: root, actualModel: 'gpt-5.6-terra',
      role: 'senior-tester', source: 'PreToolUse',
    });
    assert.equal(conflicted?.status, 'conflict');
    assert.equal(conflicted?.reason, 'parent-session-conflict');
  });
});

test('codex authoritative role correction revalidates a provisional mismatch before creating child state', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      freezeRunPolicy(cwd, 'codex');
      const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
      const childThread = '019f69fe-e335-7de0-be43-1ee45e353601';
      const transcript = path.join(cwd, `rollout-role-correction-${childThread}.jsonl`);
      fs.writeFileSync(transcript, '{"type":"session_', 'utf8');

      const start = subagentStartBind(subagentStartCtx(cwd, {
        hook_event_name: 'SubagentStart', agent_id: childThread, session_id: parentThread,
        transcript_path: transcript, task_name: 'senior_frontend', model: 'gpt-5.6-terra',
      }));
      assert.equal(start.kind, 'context');
      assert.equal(readCodexModelObservation(cwd, 'run-test', [childThread])?.status, 'mismatch');
      assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'run-test', `${childThread}.json`)), false);
      assert.deepEqual(readRunAgentRegistry(cwd, 'run-test'), {});

      // The actual child rollout now exposes the authoritative tester role. Terra
      // is valid for tester in the immutable High policy, so the same model can be
      // re-evaluated and only then become claimable/reusable.
      fs.writeFileSync(
        transcript,
        `${JSON.stringify(codexSessionMeta(childThread, parentThread, '/root/senior_tester'))}\n`,
        'utf8',
      );
      const gate = codexChildModelGate(codexChildPreToolCtx(
        cwd, childThread, parentThread, transcript, 'gpt-5.6-terra',
      ));
      assert.equal(gate.kind, 'noop');
      const observation = readCodexModelObservation(cwd, 'run-test', [childThread]);
      assert.equal(observation?.status, 'verified');
      assert.equal(observation?.role, 'senior-tester');
      const claim = JSON.parse(fs.readFileSync(
        path.join(cwd, '.traffic-one', 'runs', 'run-test', `${childThread}.json`),
        'utf8',
      )) as Record<string, unknown>;
      assert.equal(claim.role, 'senior-tester');
      assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, childThread);
      assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-frontend'], undefined);
    });
  });
});

test('a delayed Codex role correction cannot replace a newer verified child for that role', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      freezeRunPolicy(cwd, 'codex');
      const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
      const delayedChild = '019f69fe-e335-7de0-be43-1ee45e353611';
      const delayedTranscript = path.join(cwd, `rollout-delayed-${delayedChild}.jsonl`);
      fs.writeFileSync(delayedTranscript, '{"type":"session_', 'utf8');
      subagentStartBind(subagentStartCtx(cwd, {
        hook_event_name: 'SubagentStart', agent_id: delayedChild, session_id: parentThread,
        transcript_path: delayedTranscript, task_name: 'senior_frontend', model: 'gpt-5.6-terra',
      }));
      assert.equal(readCodexModelObservation(cwd, 'run-test', [delayedChild])?.status, 'mismatch');

      const newerChild = '019f69fe-e335-7de0-be43-1ee45e353612';
      const newerTranscript = path.join(cwd, `rollout-newer-${newerChild}.jsonl`);
      fs.writeFileSync(
        newerTranscript,
        `${JSON.stringify(codexSessionMeta(newerChild, parentThread, '/root/senior_tester'))}\n`,
        'utf8',
      );
      assert.equal(codexChildModelGate(codexChildPreToolCtx(
        cwd, newerChild, parentThread, newerTranscript, 'gpt-5.6-terra',
      )).kind, 'noop');
      assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, newerChild);

      fs.writeFileSync(
        delayedTranscript,
        `${JSON.stringify(codexSessionMeta(delayedChild, parentThread, '/root/senior_tester'))}\n`,
        'utf8',
      );
      const delayed = codexChildModelGate(codexChildPreToolCtx(
        cwd, delayedChild, parentThread, delayedTranscript, 'gpt-5.6-terra',
      ));
      assert.equal(delayed.kind, 'deny');
      assert.equal(
        fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'run-test', `${delayedChild}.json`)),
        false,
      );
      assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, newerChild);
    });
  });
});

test('codex conflicting model evidence is terminal and cannot be healed by a later role correction', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childThread = '019f69fe-e335-7de0-be43-1ee45e353602';
    const transcript = path.join(cwd, `rollout-terminal-conflict-${childThread}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"session_', 'utf8');

    subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart', agent_id: childThread, session_id: parentThread,
      transcript_path: transcript, task_name: 'senior_frontend', model: 'gpt-5.6-terra',
    }));
    const conflictGate = codexChildModelGate(codexChildPreToolCtx(
      cwd, childThread, parentThread, transcript, 'gpt-5.6-sol',
      { task_name: 'senior_frontend' },
    ));
    assert.equal(conflictGate.kind, 'deny');
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childThread])?.status, 'conflict');

    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(childThread, parentThread, '/root/senior_tester'))}\n`,
      'utf8',
    );
    const staleCorrection = codexChildModelGate(codexChildPreToolCtx(
      cwd, childThread, parentThread, transcript, 'gpt-5.6-terra',
    ));
    assert.equal(staleCorrection.kind, 'deny');
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childThread])?.status, 'conflict');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'run-test', `${childThread}.json`)), false);
    assert.deepEqual(readRunAgentRegistry(cwd, 'run-test'), {});
  });
});

test('codex mismatched child does not reserve the role and a correct respawn becomes reusable', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      freezeRunPolicy(cwd, 'codex');
      const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
      const rejectedChild = '019f69fe-e335-7de0-be43-1ee45e353603';
      const rejectedTranscript = path.join(cwd, `rollout-rejected-${rejectedChild}.jsonl`);
      fs.writeFileSync(
        rejectedTranscript,
        `${JSON.stringify(codexSessionMeta(rejectedChild, parentThread, '/root/senior_frontend'))}\n`,
        'utf8',
      );
      subagentStartBind(subagentStartCtx(cwd, {
        hook_event_name: 'SubagentStart', agent_id: rejectedChild, session_id: parentThread,
        transcript_path: rejectedTranscript, task_name: 'senior_frontend', model: 'gpt-5.6-terra',
      }));
      assert.equal(readCodexModelObservation(cwd, 'run-test', [rejectedChild])?.status, 'mismatch');
      assert.deepEqual(readRunAgentRegistry(cwd, 'run-test'), {});

      const retry = agentModelGate(codexSpawnCtx(cwd, {
        task_name: 'senior_frontend', message: 'Retry the bounded frontend task.',
        fork_turns: 'none', model: 'gpt-5.6-sol',
      }));
      assert.equal(retry.kind, 'noop', 'the rejected child does not trip the reuse gate');

      const acceptedChild = '019f69fe-e335-7de0-be43-1ee45e353604';
      const acceptedTranscript = path.join(cwd, `rollout-accepted-${acceptedChild}.jsonl`);
      fs.writeFileSync(
        acceptedTranscript,
        `${JSON.stringify(codexSessionMeta(acceptedChild, parentThread, '/root/senior_frontend'))}\n`,
        'utf8',
      );
      const accepted = subagentStartBind(subagentStartCtx(cwd, {
        hook_event_name: 'SubagentStart', agent_id: acceptedChild, session_id: parentThread,
        transcript_path: acceptedTranscript, task_name: 'senior_frontend', model: 'gpt-5.6-sol',
      }));
      assert.equal(accepted.kind, 'noop');
      assert.equal(readCodexModelObservation(cwd, 'run-test', [acceptedChild])?.status, 'verified');
      assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-frontend']?.agentId, acceptedChild);
      assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'run-test', `${rejectedChild}.json`)), false);
    });
  });
});

test('codex SubagentStart fails closed when line-zero child identity does not match the hook', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const hookChild = '019f69fe-e335-7de0-be43-1ee45e3535c7';
    const metadataChild = '019f69fe-e335-7de0-be43-1ee45e3535c8';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${hookChild}.jsonl`);
    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(metadataChild, parentThread, '/root/senior_architect'))}\n`,
      'utf8',
    );

    const result = subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart',
      agent_id: hookChild,
      session_id: parentThread,
      transcript_path: transcript,
      task_name: 'senior_architect',
    }));
    assert.equal(result.kind, 'context');
    assert.equal(fs.existsSync(
      path.join(cwd, '.traffic-one', 'runs', 'run-test', `${hookChild}.json`),
    ), false);
    const captureFile = path.join(cwd, '.traffic-one', 'runs', 'run-test', 'debug', 'claim-capture.jsonl');
    const captures = fs.readFileSync(captureFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const diagnostic = captures.find((entry) => entry.label === 'subagent-start-role-unresolved');
    assert.equal(diagnostic?.raw?.transcriptIdentityMismatch, true);
  });
});

test('codex SubagentStart fails closed when the parent omitted currentRunId (existing-codebase)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // The exact Codex gap: no PreToolUse fires for spawn_agent, so the persisting
    // ensureCurrentRunId in agentModelGate never runs — setup completed with NO
    // currentRunId in project state, and the run-team write gate denied the
    // architect's first coordination write (run-team-not-subagent).
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    delete one.currentRunId;
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    const childThread = '019e7396-0000-7881-a4a9-dfe9d5a17999';
    const childTranscript = path.join(cwd, `rollout-2026-07-13T10-00-00-${childThread}.jsonl`);
    fs.writeFileSync(childTranscript, `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `You are the Traffic One senior-architect role for ${cwd}. Plan the fix.` }] },
    })}\n`, 'utf8');

    const result = subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart', agent_id: childThread, session_id: 'orchestrator-parent',
      transcript_path: childTranscript, task_name: 'senior_architect', model: 'gpt-5.6-sol',
    }));

    const minted = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    assert.equal(result.kind, 'context');
    assert.equal(minted, '', 'a child cannot mint or rebase a missing parent run');
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
  writeArchitectPhaseComplete(cwd, runId, state);
}

function freezeRunPolicy(cwd: string, host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'kilo' | 'windsurf', runId?: string): void {
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: host });
  const activeRunId = runId || (typeof state.currentRunId === 'string' ? state.currentRunId : '');
  assert.ok(activeRunId, 'test fixture must have a current run id before freezing policy');
  assert.ok(
    ensureRunModelPolicy(cwd, activeRunId, host, state, { ...process.env, TRAFFIC_ONE_HOST: host }),
    `test fixture could not freeze ${host} run policy`,
  );
}

function spawnCtxWithSession(cwd: string, toolInput: Record<string, unknown>, sessionId: string, host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'windsurf' | 'opencode' | 'kilo' = 'claude'): Ctx {
  const rawName = host === 'windsurf' ? 'devin.run_subagent' : 'Task';
  const input: HookInput = {
    event: 'PreToolUse', host, cwd,
    raw: { tool_name: rawName, tool_input: toolInput, session_id: sessionId },
    tool: { class: 'spawn-agent' as ToolClass, rawName },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

function postSpawnCtx(
  cwd: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  sessionId: string,
  host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'windsurf' = 'claude',
  rawName = host === 'windsurf' ? 'devin.run_subagent' : 'Task',
): Ctx {
  const input: HookInput = {
    event: 'PostToolUse', host, cwd,
    raw: { tool_name: rawName, tool_input: toolInput, tool_response: toolResponse, session_id: sessionId },
    tool: { class: 'spawn-agent' as ToolClass, rawName },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

function observeCursorSpawn(
  cwd: string,
  runId: string,
  role: string,
  requestedModel: string,
  tier: 'highest' | 'balanced' | 'cheapest',
  expectedModel: string,
  toolCallId: string,
  parentSessionId = 'parent-1',
): void {
  const observed = recordCursorSpawnObservation(cwd, runId, {
    parentSessionId,
    toolCallId,
    role,
    requestedModel,
    tier,
    expectedModel,
  });
  assert.ok(observed, `records Cursor start observation ${toolCallId}`);
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
  assert.equal(
    extractSpawnedAgentId({ toolTelemetry: { restrictedProperties: { agent_id: 'senior-frontend' } } }),
    'senior-frontend',
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

test('mid-run API-limit stop anchors fallback on the role original tier, not the failed model owning row', () => {
  withMaterialized({ teamApproved: true, level: 'high' }, (cwd) => {
    const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    try {
      setCurrentRunId(cwd, 'run-api-limit');
      freezeRunPolicy(cwd, 'cursor', 'run-api-limit');
      observeCursorSpawn(
        cwd,
        'run-api-limit',
        'senior-frontend',
        'gpt-5.6-terra-medium',
        'highest',
        'claude-fable-5',
        'tool_11111111-1111-4111-8111-111111111111',
      );
      recordRunAgent(cwd, 'run-api-limit', 'senior-frontend', {
        agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301',
        toolCallId: 'tool_11111111-1111-4111-8111-111111111111',
        parentSessionId: 'parent-1',
      });

      // The stopped Task result is the ONLY synchronous signal (no SubagentStop
      // event exists). Before the fix this payload RE-recorded the dead agent as
      // live (it still prints Agent ID:) and returned noop → the orchestrator
      // idled until the sibling finished, then respawned on the exhausted model.
      const result = recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: 'build the UI' },
        { status: 'stopped', content: [{ type: 'text', text: 'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 — stopped: you have hit your API usage limit.' }] },
        'parent-1',
        'cursor',
      ));
      assert.equal(result.kind, 'noop', 'PostTool persists; parent reconciliation owns delivery');

      // Retired from the registry → the reuse gate no longer demands continuation
      // of the dead agent.
      const registry = readRunAgentRegistry(cwd, 'run-api-limit');
      assert.equal(registry['senior-frontend']?.replaced, true, 'dead agent retired');
      const durable = listCursorSpawnObservations(cwd, 'run-api-limit')[0];
      assert.equal(durable?.outcome, 'api-limit', 'PostTool result persists the correlated outcome');
      assert.equal(durable?.prescribedModel, 'claude-fable-5-thinking-high', 'durable result stores the exact original-tier retry slug');
      assert.match(durable?.directive || '', /Retry the same role now/i);
      assert.ok(durable?.directive?.includes('claude-fable-5-thinking-high'), 'prescribes the first captured slug in the role original highest tier');
      assert.ok(!durable?.directive?.includes('claude-sonnet-5'), 'does not drift into Terra\'s owning balanced row');
      assert.match(durable?.directive || '', /gpt-5\.6-terra-medium/i, 'names the exhausted model');

      const wrongRetry = agentModelGate(spawnCtxWithSession(cwd, {
        subagent_type: 'senior-frontend',
        model: 'gpt-5.6-terra-medium',
        prompt: '[t1-role: senior-frontend]\nContinue after the failed child.',
      }, 'parent-1', 'cursor'));
      assert.equal(wrongRetry.kind, 'deny', 'no-marker correlated gate blocks the exhausted model');
      if (wrongRetry.kind === 'deny') assert.ok(wrongRetry.reason.includes('claude-fable-5-thinking-high'));

      const exactRetry = agentModelGate(spawnCtxWithSession(cwd, {
        subagent_type: 'senior-frontend',
        model: 'claude-fable-5-thinking-high',
        prompt: '[t1-role: senior-frontend]\nContinue after the failed child.',
      }, 'parent-1', 'cursor'));
      assert.notEqual(exactRetry.kind, 'deny', 'the exact prescribed slug is accepted without a replacement marker');
    } finally {
      if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    }
  });
});

test('mid-run API-limit stop requires the existing choice before a highest role drops to Composer', () => {
  withMaterialized({
    teamApproved: true,
    level: 'high',
    cursorModels: ['gpt-5.6-terra-medium', 'composer-2.5-fast'],
  }, (cwd) => {
    setCurrentRunId(cwd, 'run-recorder-floor');
    freezeRunPolicy(cwd, 'cursor', 'run-recorder-floor');
    observeCursorSpawn(
      cwd,
      'run-recorder-floor',
      'senior-frontend',
      'gpt-5.6-terra-medium',
      'highest',
      'claude-fable-5',
      'tool_22222222-2222-4222-8222-222222222222',
    );
    const stopped = () => recordSpawnedAgent(postSpawnCtx(
      cwd,
      { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: 'build the UI' },
      { status: 'error', content: [{ type: 'text', text: 'API usage limit reached.' }] },
      'parent-1',
      'cursor',
    ));

    const ask = stopped();
    assert.equal(ask.kind, 'noop');
    let durable = listCursorSpawnObservations(cwd, 'run-recorder-floor')[0]!;
    assert.match(durable.directive || '', /\*\*enable\*\*.*Restore API budget/s);
    assert.match(durable.directive || '', /\*\*fallback\*\*.*composer-2\.5-fast/s);
    assert.ok(!/Re-send .*model="composer-2\.5-fast"/.test(durable.directive || ''), 'does not auto-spawn the floor before consent');
    assert.equal(modelChoicePrompted(cwd, 'run-recorder-floor'), true);

    writeModelChoice(cwd, 'run-recorder-floor', 'use-fallback');
    const accepted = stopped();
    assert.equal(accepted.kind, 'noop');
    durable = listCursorSpawnObservations(cwd, 'run-recorder-floor')[0]!;
    assert.match(durable.directive || '', /model:\s*"composer-2\.5-fast"/i, 'accepted fallback prescribes the exact captured Composer slug');

    writeModelChoice(cwd, 'run-recorder-floor', 'enable-retry');
    const enable = stopped();
    assert.equal(enable.kind, 'noop');
    durable = listCursorSpawnObservations(cwd, 'run-recorder-floor')[0]!;
    assert.match(durable.directive || '', /do not rotate to a fallback/i);
    assert.ok(durable.directive?.includes('claude-fable-5'), 'enable/retry points back to the original tier recommendation');
  });
});

test('mid-run API-limit on cheapest Composer rotates automatically to the next cheapest candidate', () => {
  withMaterialized({
    teamApproved: true,
    level: 'high',
    cursorModels: ['composer-2.5-fast', 'gpt-5.4-mini-fast'],
  }, (cwd) => {
    setCurrentRunId(cwd, 'run-recorder-cheapest');
    freezeRunPolicy(cwd, 'cursor', 'run-recorder-cheapest');
    observeCursorSpawn(
      cwd,
      'run-recorder-cheapest',
      'quick-fix',
      'composer-2.5-fast',
      'cheapest',
      'composer-2.5',
      'tool_33333333-3333-4333-8333-333333333333',
    );
    const result = recordSpawnedAgent(postSpawnCtx(
      cwd,
      { subagent_type: 'quick-fix', model: 'composer-2.5-fast', prompt: 'apply the fix' },
      { status: 'error', content: [{ type: 'text', text: 'RESOURCE_EXHAUSTED: quota exceeded' }] },
      'parent-1',
      'cursor',
    ));
    assert.equal(result.kind, 'noop');
    const durable = listCursorSpawnObservations(cwd, 'run-recorder-cheapest')[0]!;
    assert.ok(durable.directive?.includes('gpt-5.4-mini-fast'), 'Composer is the cheapest-tier primary, so its API limit advances automatically');
    assert.ok(!durable.directive?.includes('**enable**'), 'normal cheapest rotation does not ask for a floor downgrade');
  });
});

test('mid-run explicit model-unavailable result asks Settings/enable or the next exact tier slug', () => {
  withMaterialized({
    teamApproved: true,
    level: 'balanced',
    cursorModels: ['gpt-5.6-terra-medium', 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'],
  }, (cwd) => {
    setCurrentRunId(cwd, 'run-recorder-unavailable');
    freezeRunPolicy(cwd, 'cursor', 'run-recorder-unavailable');
    observeCursorSpawn(
      cwd,
      'run-recorder-unavailable',
      'senior-frontend',
      'gpt-5.6-terra-medium',
      'balanced',
      'gpt-5.6-terra',
      'tool_44444444-4444-4444-8444-444444444444',
    );
    recordRunAgent(cwd, 'run-recorder-unavailable', 'senior-frontend', {
      agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc302',
      toolCallId: 'tool_44444444-4444-4444-8444-444444444444',
      parentSessionId: 'parent-1',
    });
    const unavailable = () => recordSpawnedAgent(postSpawnCtx(
      cwd,
      { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: 'build the UI' },
      { status: 'error', content: [{ type: 'text', text: 'The requested model gpt-5.6-terra-medium is not enabled.' }] },
      'parent-1',
      'cursor',
    ));

    const ask = unavailable();
    assert.equal(ask.kind, 'noop');
    let durable = listCursorSpawnObservations(cwd, 'run-recorder-unavailable')[0]!;
    assert.match(durable.directive || '', /Settings → Models/);
    assert.match(durable.directive || '', /\*\*enable\*\*.*gpt-5\.6-terra-medium/s);
    assert.match(durable.directive || '', /\*\*fallback\*\*.*claude-sonnet-5-thinking-high/s);
    assert.equal(modelChoicePrompted(cwd, 'run-recorder-unavailable'), true);
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-recorder-unavailable', 'senior-frontend'), [], 'availability does not condemn the model as API-limited');
    assert.equal(readRunAgentRegistry(cwd, 'run-recorder-unavailable')['senior-frontend']?.replaced, true);

    writeModelChoice(cwd, 'run-recorder-unavailable', 'use-fallback');
    const fallback = unavailable();
    assert.equal(fallback.kind, 'noop');
    durable = listCursorSpawnObservations(cwd, 'run-recorder-unavailable')[0]!;
    assert.match(durable.directive || '', /Proceed now on \*\*claude-sonnet-5-thinking-high\*\*/);
  });
});

test('Cursor API-limit respawn: the pre-spawn gate REFUSES reusing the exhausted model and names the next same-tier fallback', () => {
  // The real bug (session 6ce81ecd): Cursor emits NO post-spawn stop event (Task
  // fires preToolUse but never postToolUse), so record-agent.ts's stop→fallback
  // directive can never run there. The orchestrator self-detected the API limit and
  // RE-SPAWNED senior-backend — but on the SAME exhausted gpt-5.6-terra-medium. The
  // spawn gate is the only hook Cursor delivers; it must force the model rotation.
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-rotate');
    // A live backend agent on the balanced model that will be reported exhausted.
    recordRunAgent(cwd, 'run-rotate', 'senior-backend', {
      agentId: '2c2a9638-8ba9-401b-84a9-f9b42ee968b0',
      resumeId: '2c2a9638-8ba9-401b-84a9-f9b42ee968b0',
      model: 'gpt-5.6-terra-medium',
      parentSessionId: 'parent-1',
    });

    // Respawn reusing the SAME exhausted model → denied, pointing at the fallback.
    const reuse = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-backend',
      model: 'gpt-5.6-terra-medium',
      prompt: '[t1-replace-agent]\n[t1-role: senior-backend]\nPrevious senior-backend spawn failed (API limit). Replace and complete backend scope.',
    }, 'parent-1', 'cursor'));
    assert.equal(reuse.kind, 'deny');
    if (reuse.kind === 'deny') {
      assert.match(reuse.reason, /rotation/i, 'names the model-rotation reason');
      assert.match(reuse.reason, /gpt-5\.6-terra-medium.*exhaust/i, 'names the exhausted model');
      assert.ok(reuse.reason.includes('claude-sonnet-5'), 'prescribes the next same-tier fallback (resolved to the captured slug)');
      assert.ok(reuse.reason.includes('[t1-replace-agent]'), 'keeps the replacement marker in the recipe');
    }
    // The exhausted model is persisted for the run so later retries also skip it.
    assert.deepEqual(
      exhaustedModelsForRole(cwd, 'run-rotate', 'senior-backend'),
      ['gpt-5.6-terra-medium'],
    );

    // Respawn on a FRESH same-tier model (the prescribed fallback) is NOT rotation-denied.
    const rotated = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-backend',
      model: 'claude-sonnet-5-thinking-high',
      prompt: '[t1-replace-agent]\n[t1-role: senior-backend]\nPrevious senior-backend spawn hit an API limit. Replace on the fallback model.',
    }, 'parent-1', 'cursor'));
    assert.notEqual(rotated.kind, 'deny', 'the fresh fallback model spawns (no rotation block)');
  });
});

test('rotation to the Composer FLOOR asks the user (enable/fallback) instead of silently downgrading', () => {
  // Only terra + composer are offered: exhausting terra leaves the floor as the
  // sole fallback. That is a REAL downgrade — it must route through the SAME
  // enable/fallback choice the pre-spawn guards use, not rotate silently.
  withMaterialized({ teamApproved: true, level: 'balanced', cursorModels: ['gpt-5.6-terra-medium', 'composer-2.5-fast'] }, (cwd) => {
    setCurrentRunId(cwd, 'run-floor');
    const rd = path.join(cwd, '.traffic-one', 'runs', 'run-floor');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
      version: 1,
      agents: { 'senior-backend': { agentId: '2c2a9638-8ba9-401b-84a9-f9b42ee968b0', resumeId: '2c2a9638-8ba9-401b-84a9-f9b42ee968b0', role: 'senior-backend', model: 'gpt-5.6-terra-medium', agentType: 'senior-backend', parentSessionId: 'parent-1', recordedAt: new Date().toISOString(), tasks: 1, replaced: false } },
      history: [],
    }));
    const spawn = () => agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-backend',
      model: 'gpt-5.6-terra-medium',
      prompt: '[t1-replace-agent]\n[t1-role: senior-backend]\nPrevious senior-backend spawn failed (API limit). Replace and complete backend scope.',
    }, 'parent-1', 'cursor'));

    // No choice recorded yet → the enable/fallback question, once per run.
    const ask = spawn();
    assert.equal(ask.kind, 'deny');
    if (ask.kind === 'deny') {
      assert.match(ask.reason, /API\/usage-limit failure/i, 'the API-limit Composer choice prose');
      assert.ok(ask.reason.includes('composer-2.5-fast'), 'names the floor as the fallback');
      assert.match(ask.reason, /enable/i, 'offers the enable option');
    }
    assert.equal(modelChoicePrompted(cwd, 'run-floor'), true, 'shares the once-per-run choice marker');

    // "fallback" recorded → the floor respawn is prescribed automatically.
    writeModelChoice(cwd, 'run-floor', 'use-fallback');
    const proceed = spawn();
    assert.equal(proceed.kind, 'deny');
    if (proceed.kind === 'deny') {
      assert.match(proceed.reason, /model rotation/i);
      assert.ok(proceed.reason.includes('model="composer-2.5-fast"'), 'prescribes the accepted floor');
    }

    // "enable" recorded → the floor spawn stays denied until the model is restored.
    writeModelChoice(cwd, 'run-floor', 'enable-retry');
    const enable = spawn();
    assert.equal(enable.kind, 'deny');
    if (enable.kind === 'deny') assert.match(enable.reason, /enable/i, 'insists on restoring the recommended model');
  });
});

test('exhausted-model ledger entries EXPIRE — a transient throttle does not condemn the model for the whole build', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-ttl');
    const rd = path.join(cwd, '.traffic-one', 'runs', 'run-ttl');
    fs.mkdirSync(rd, { recursive: true });
    const old = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // > 10-min TTL
    fs.writeFileSync(path.join(rd, 'exhausted-models.json'), JSON.stringify({
      'senior-backend': [{ model: 'gpt-5.6-terra-medium', at: old }],
      'senior-frontend': ['legacy-entry-no-timestamp'],
    }));
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-ttl', 'senior-backend'), [], 'expired condemnation is lifted');
    // Legacy (no-timestamp) entries never expire within the run — safer on upgrade.
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-ttl', 'senior-frontend'), ['legacy-entry-no-timestamp']);
    // A fresh record re-condemns and refreshes.
    recordExhaustedModel(cwd, 'run-ttl', 'senior-backend', 'gpt-5.6-terra-medium');
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-ttl', 'senior-backend'), ['gpt-5.6-terra-medium']);
  });
});

test('dead-agent escape corroboration: a signal-less retry inside the hard window still waits; a corroborated one retires at the grace', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-corr');
    const rd = path.join(cwd, '.traffic-one', 'runs', 'run-corr');
    fs.mkdirSync(rd, { recursive: true });
    const midWindow = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 min: > 90s grace, < 270s hard
    const writeAgent = () => fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
      version: 1,
      agents: { 'senior-architect': { agentId: 'tool_dead5678-1a31-47e6-a1ce-ba45b370fe7', resumeId: null, toolCallId: 'tool_dead5678-1a31-47e6-a1ce-ba45b370fe7', role: 'senior-architect', model: 'gpt-5.6-terra-medium', agentType: 'senior-architect', parentSessionId: 'parent-1', recordedAt: midWindow, tasks: 1, replaced: false } },
      history: [],
    }));

    // Signal-less "continue" retry at 2 min → NOT presumed dead (no bare-timer duplicate).
    writeAgent();
    const quiet = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-architect',
      model: 'gpt-5.6-terra-medium',
      prompt: '[t1-role: senior-architect]\nContinue architect work; deliverables still needed under the run dir.',
    }, 'parent-1', 'cursor'));
    assert.equal(quiet.kind, 'deny', 'a slow-but-live agent is not retired on a bare timer');
    if (quiet.kind === 'deny') assert.ok(/has not exposed a valid Task `resume` UUID/i.test(quiet.reason));

    // The SAME 2-min-old agent with a corroborating failure signal → retired, retry allowed.
    writeAgent();
    const corroborated = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-architect',
      model: 'claude-sonnet-5-thinking-high',
      prompt: '[t1-role: senior-architect]\nPrevious architect subagent stopped (API usage limit). Re-run the architect scope.',
    }, 'parent-1', 'cursor'));
    assert.notEqual(corroborated.kind, 'deny', 'a corroborated death retires at the 90s grace');
    assert.equal(readRunAgentRegistry(cwd, 'run-corr')['senior-architect']?.replaced, true);
  });
});

test('Cursor no-marker liveness uses exhaustion of the current live model, not another role-ledger model', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    const runId = 'run-live-model-specific';
    const role = 'senior-architect';
    const parent = 'parent-live-model-specific';
    const terra = 'gpt-5.6-terra-medium';
    const sonnet = 'claude-sonnet-5-thinking-high';
    const agentId = 'tool_abcddcba-1234-4abc-8def-123456789abc';
    setCurrentRunId(cwd, runId);
    recordExhaustedModel(cwd, runId, role, terra);
    const rd = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(rd, { recursive: true });
    const writeCurrentSonnet = (ageMs: number): void => {
      fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
        version: 1,
        agents: {
          [role]: {
            agentId,
            resumeId: null,
            toolCallId: agentId,
            role,
            model: sonnet,
            agentType: role,
            parentSessionId: parent,
            recordedAt: new Date(Date.now() - ageMs).toISOString(),
            tasks: 1,
            replaced: false,
          },
        },
        history: [],
      }));
    };
    const quietRetry = () => agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: role,
      model: sonnet,
      prompt: '[t1-role: senior-architect]\nContinue the remaining architect scope.',
    }, parent, 'cursor'));

    writeCurrentSonnet(2 * 60 * 1000);
    const insideHardWindow = quietRetry();
    assert.equal(
      insideHardWindow.kind,
      'deny',
      'Terra exhaustion cannot shorten the liveness window of the current Sonnet child',
    );
    if (insideHardWindow.kind === 'deny') {
      assert.match(insideHardWindow.reason, /has not exposed a valid Task `resume` UUID/i);
    }
    assert.equal(readRunAgentRegistry(cwd, runId)[role]?.replaced, false);

    writeCurrentSonnet(271 * 1000);
    assert.notEqual(quietRetry().kind, 'deny', 'the same signal-less Sonnet child retires after 270s');
    assert.equal(readRunAgentRegistry(cwd, runId)[role]?.replaced, true);
    assert.deepEqual(exhaustedModelsForRole(cwd, runId, role), [terra]);
  });
});

test('Cursor ambiguous replace marker obeys 90/270s timers without condemning a model from prompt text', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    const role = 'senior-architect';
    const model = 'gpt-5.6-terra-medium';
    const parent = 'parent-ambiguous-marker';
    const writeLive = (runId: string, ageMs: number): void => {
      setCurrentRunId(cwd, runId);
      const rd = path.join(cwd, '.traffic-one', 'runs', runId);
      fs.mkdirSync(rd, { recursive: true });
      fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
        version: 1,
        agents: {
          [role]: {
            agentId: 'tool_a11b22c3-4444-4555-8666-777788889999',
            resumeId: null,
            toolCallId: 'tool_a11b22c3-4444-4555-8666-777788889999',
            role,
            model,
            agentType: role,
            parentSessionId: parent,
            recordedAt: new Date(Date.now() - ageMs).toISOString(),
            tasks: 1,
            replaced: false,
          },
        },
        history: [],
      }));
    };
    const retry = (prompt: string) => agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: role,
      model,
      prompt,
    }, parent, 'cursor'));
    const apiMarker = '[t1-replace-agent]\n[t1-role: senior-architect]\nPrevious child reported API usage limit; retry.';
    const quietMarker = '[t1-replace-agent]\n[t1-role: senior-architect]\nContinue the remaining architect scope.';

    writeLive('run-marker-fresh', 0);
    const fresh = retry(apiMarker);
    assert.equal(fresh.kind, 'deny', 'prompt-only API text cannot retire a fresh no-resume child');
    if (fresh.kind === 'deny') assert.match(fresh.reason, /has not exposed a valid Task `resume` UUID/i);
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-marker-fresh', role), []);

    writeLive('run-marker-grace', 2 * 60 * 1000);
    const grace = retry(apiMarker);
    assert.notEqual(grace.kind, 'deny', 'API text corroborates death only after the 90s grace');
    assert.equal(readRunAgentRegistry(cwd, 'run-marker-grace')[role]?.replaced, true);
    assert.deepEqual(
      exhaustedModelsForRole(cwd, 'run-marker-grace', role),
      [],
      'orchestrator-authored API text never becomes durable model exhaustion evidence',
    );

    writeLive('run-marker-hard-wait', 2 * 60 * 1000);
    const hardWait = retry(quietMarker);
    assert.equal(hardWait.kind, 'deny', 'an uncorroborated marker still waits inside the 270s hard window');
    assert.equal(readRunAgentRegistry(cwd, 'run-marker-hard-wait')[role]?.replaced, false);

    writeLive('run-marker-hard-retire', 5 * 60 * 1000);
    const hardRetire = retry(quietMarker);
    assert.notEqual(hardRetire.kind, 'deny', 'the hard timer eventually retires an unresumable child');
    assert.equal(readRunAgentRegistry(cwd, 'run-marker-hard-retire')[role]?.replaced, true);
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-marker-hard-retire', role), []);

    writeLive('run-marker-durable-limit', 2 * 60 * 1000);
    recordExhaustedModel(cwd, 'run-marker-durable-limit', role, model);
    const durable = retry(quietMarker);
    assert.equal(durable.kind, 'deny', 'durable per-role evidence enables model rotation after the grace');
    if (durable.kind === 'deny') {
      assert.match(durable.reason, /model rotation/i);
      assert.ok(durable.reason.includes('claude-sonnet-5-thinking-high'), 'rotation names the next model in the original tier');
    }
  });
});

test('non-limit replacement (a plain stop) may reuse the same model — rotation only fires on an API/usage limit', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-plainstop');
    recordRunAgent(cwd, 'run-plainstop', 'senior-backend', {
      agentId: '3d3b0000-8ba9-401b-84a9-f9b42ee968b0',
      resumeId: '3d3b0000-8ba9-401b-84a9-f9b42ee968b0',
      model: 'gpt-5.6-terra-medium',
      parentSessionId: 'parent-1',
    });
    // "context exhausted" is a valid replacement reason but does NOT condemn the model.
    const replace = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-backend',
      model: 'gpt-5.6-terra-medium',
      prompt: '[t1-replace-agent]\n[t1-role: senior-backend]\nPrevious agent context exhausted; continue the remaining backend scope.',
    }, 'parent-1', 'cursor'));
    assert.notEqual(replace.kind, 'deny', 'a non-limit replacement is not model-rotated');
    assert.deepEqual(
      exhaustedModelsForRole(cwd, 'run-plainstop', 'senior-backend'),
      [],
      'no model recorded exhausted for a non-limit stop',
    );
  });
});

test('a successful Task result that merely mentions the word "stopped" is NOT classified as a failure', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-ok-mention');
      const rec = recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'build the API' },
        "DONE — stopped the dev server after tests. agentId: abc999def456789 (use SendMessage with to: 'abc999def456789')",
        'parent-1',
      ));
      assert.equal(rec.kind, 'noop', 'prose mention of stopped never triggers the failure path');
      const registry = readRunAgentRegistry(cwd, 'run-ok-mention');
      assert.equal(registry['senior-backend']?.agentId, 'abc999def456789', 'successful result still recorded live');
    });
  });
});

test('Cursor PostTool classifier requires structured failure evidence and ignores negated limit prose', () => {
  assert.equal(classifySubagentStop('API usage limit reached.'), null, 'plain model-written output is not structured failure evidence');
  assert.equal(classifySubagentStop({
    status: 'completed',
    content: [{ type: 'text', text: 'Report: API usage limit reached in the incident fixture; model foo is not enabled.' }],
  }), null, 'successful structured result may discuss both failure vocabularies');
  assert.equal(classifySubagentStop({
    status: 'completed',
    content: [{ type: 'text', text: 'Implemented API-limit fallback behavior.' }],
  }, false), null, 'an explicit success envelope also wins on legacy/non-Cursor hosts');
  assert.equal(classifySubagentStop({ status: 'error', error: 'No API limit was reached.' }), 'stopped', 'negated phrase remains generic stopped recovery');
  assert.equal(classifySubagentStop({ status: 'error', error: 'API usage limit reached.' }), 'api-limit');
});

test('successful Cursor Task report cannot condemn a model or retire its live observation', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-success-report');
    observeCursorSpawn(
      cwd,
      'run-cursor-success-report',
      'senior-backend',
      'gpt-5.6-terra-medium',
      'balanced',
      'gpt-5.6-terra',
      'tool_55555555-5555-4555-8555-555555555555',
    );
    recordRunAgent(cwd, 'run-cursor-success-report', 'senior-backend', {
      agentId: 'tool_55555555-5555-4555-8555-555555555555',
      toolCallId: 'tool_55555555-5555-4555-8555-555555555555',
      model: 'gpt-5.6-terra-medium',
      parentSessionId: 'parent-1',
    });

    const result = recordSpawnedAgent(postSpawnCtx(
      cwd,
      { subagent_type: 'senior-backend', model: 'gpt-5.6-terra-medium', prompt: 'audit recovery code' },
      {
        status: 'completed',
        agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc399',
        content: [{ type: 'text', text: 'Verified the API usage limit fixture and the model-not-enabled Settings copy. No API limit was reached during this run.' }],
      },
      'parent-1',
      'cursor',
    ));
    assert.equal(result.kind, 'noop');
    assert.equal(listCursorSpawnObservations(cwd, 'run-cursor-success-report')[0]?.outcome, null);
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-cursor-success-report', 'senior-backend'), []);
    assert.notEqual(readRunAgentRegistry(cwd, 'run-cursor-success-report')['senior-backend']?.replaced, true);
  });
});

test('delayed Cursor PostTool result persists against its old observation but CAS cannot retire a newer retry', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-delayed-post');
    freezeRunPolicy(cwd, 'cursor', 'run-cursor-delayed-post');
    observeCursorSpawn(
      cwd,
      'run-cursor-delayed-post',
      'senior-backend',
      'gpt-5.6-terra-medium',
      'highest',
      'claude-fable-5',
      'tool_66666666-6666-4666-8666-666666666666',
    );
    observeCursorSpawn(
      cwd,
      'run-cursor-delayed-post',
      'senior-backend',
      'gpt-5.6-terra-medium',
      'balanced',
      'gpt-5.6-terra',
      'tool_77777777-7777-4777-8777-777777777777',
    );
    recordRunAgent(cwd, 'run-cursor-delayed-post', 'senior-backend', {
      agentId: 'tool_77777777-7777-4777-8777-777777777777',
      toolCallId: 'tool_77777777-7777-4777-8777-777777777777',
      model: 'gpt-5.6-terra-medium',
      parentSessionId: 'parent-1',
    });

    const nested = path.join(cwd, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });
    const post = postSpawnCtx(
      nested,
      { subagent_type: 'senior-backend', model: 'gpt-5.6-terra-medium', prompt: 'old task' },
      { status: 'error', error: 'HTTP 429 Too Many Requests' },
      'parent-1',
      'cursor',
    );
    (post.input.raw as Record<string, unknown>).tool_call_id = 'tool_66666666-6666-4666-8666-666666666666';
    const result = recordSpawnedAgent({ ...post, input: { ...post.input, workspaceRoot: cwd } });
    assert.equal(result.kind, 'noop', 'Cursor PostTool persists only; parent reconciliation owns delivery');

    let observations = listCursorSpawnObservations(cwd, 'run-cursor-delayed-post');
    const old = observations.find((item) => item.toolCallId === 'tool_66666666-6666-4666-8666-666666666666');
    assert.equal(old?.outcome, 'api-limit');
    assert.ok(old?.directive?.includes('claude-fable-5-thinking-high'), 'old immutable highest-tier anchor wins over current balanced state');
    assert.equal(old?.followupEmitted, false, 'PostTool persistence cannot claim parent delivery ownership');
    assert.equal(observations.find((item) => item.toolCallId === 'tool_77777777-7777-4777-8777-777777777777')?.outcome, null);
    assert.ok(old?.childTranscriptId);
    markCursorSpawnObservationRetryHandled(cwd, 'run-cursor-delayed-post', old!.childTranscriptId!);

    const idlessReplay = postSpawnCtx(
      nested,
      { subagent_type: 'senior-backend', model: 'gpt-5.6-terra-medium', prompt: 'delayed old task without identity' },
      { status: 'error', error: 'HTTP 429 Too Many Requests' },
      'parent-1',
      'cursor',
    );
    assert.equal(recordSpawnedAgent({
      ...idlessReplay,
      input: { ...idlessReplay.input, workspaceRoot: cwd },
    }).kind, 'noop', 'id-less replay stays ambiguous across old+new matching starts');
    observations = listCursorSpawnObservations(cwd, 'run-cursor-delayed-post');
    assert.equal(observations.find((item) => item.toolCallId === 'tool_77777777-7777-4777-8777-777777777777')?.outcome, null, 'handled old start is still counted for ambiguity');
    const current = readRunAgentRegistry(cwd, 'run-cursor-delayed-post')['senior-backend'];
    assert.equal(current?.toolCallId, 'tool_77777777-7777-4777-8777-777777777777');
    assert.notEqual(current?.replaced, true, 'old result cannot retire the newer retry');
    assert.equal(fs.existsSync(path.join(nested, '.traffic-one')), false, 'nested Cursor cwd resolves writes to workspace root');
  });
});

test('explicit model-unavailable PostTool text stays generic outside Cursor', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-noncursor-unavailable');
      freezeRunPolicy(cwd, 'claude', 'run-noncursor-unavailable');
      recordRunAgent(cwd, 'run-noncursor-unavailable', 'senior-backend', {
        agentId: 'noncursor-backend-agent',
        parentSessionId: 'parent-1',
      });
      const result = recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'build API' },
        { status: 'error', error: 'The requested model opus is not enabled.' },
        'parent-1',
        'claude',
      ));
      assert.equal(result.kind, 'context');
      if (result.kind === 'context') {
        assert.doesNotMatch(result.context, /Settings → Models|\*\*enable\*\*/);
        assert.match(result.context, /stopped mid-run/i);
      }
      assert.equal(readRunAgentRegistry(cwd, 'run-noncursor-unavailable')['senior-backend']?.replaced, true);
    });
  });
});

test('reuse (Codex): duplicate spawn routes to current collaboration continuation tools', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-codex-reuse');
    recordRunAgent(cwd, 'run-codex-reuse', 'senior-frontend', {
      agentId: '019ebb7f-0691-7281-b686-27e7fe6b393f',
      parentSessionId: 'parent-thread-1',
    });
    const duplicate = agentModelGate(codexSpawnCtx(cwd, {
      message: 'You are `senior-frontend` for Traffic One. Apply the next bounded fix.',
    }));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.ok(duplicate.reason.includes('followup_task'));
      assert.ok(duplicate.reason.includes('send_message'));
      assert.ok(!duplicate.reason.includes('send_input'));
    }
  });
});

test('reuse (Codex): matching line-zero metadata verifies continuation while a fresh unverified row stays blocked', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const runId = 'run-codex-meta-match';
    const parentThread = 'parent-thread-1';
    const childThread = '019f69fe-e335-7de0-be43-1ee45e3535c7';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${childThread}.jsonl`);
    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(childThread, parentThread, '/root/senior_architect'))}\n`,
      'utf8',
    );
    setCurrentRunId(cwd, runId);
    freezeRunPolicy(cwd, 'codex', runId);
    assert.equal(observeCodexChildModel(cwd, runId, {
      childId: childThread,
      parentSessionId: parentThread,
      actualModel: 'gpt-5.6-sol',
      role: 'senior-architect',
      source: 'SubagentStart',
    })?.status, 'verified');
    recordRunAgent(cwd, runId, 'senior-architect', {
      agentId: childThread,
      parentSessionId: parentThread,
      transcriptPath: transcript,
      model: 'gpt-5.6-sol',
    });

    const duplicate = agentModelGate(codexSpawnCtx(cwd, {
      task_name: 'senior_architect',
      message: '[t1-role: senior-architect]\nContinue the bounded architecture task.',
      model: 'gpt-5.6-sol',
      fork_turns: 'none',
    }));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.match(duplicate.reason, /already has a LIVE `senior-architect` agent/i);
      assert.match(duplicate.reason, new RegExp(childThread));
      assert.match(duplicate.reason, /Call `followup_task`/);
      assert.match(duplicate.reason, /use `send_message`/);
      assert.doesNotMatch(duplicate.reason, /cannot verify that child's role/i);
    }
    const verified = readRunAgentRegistry(cwd, runId)['senior-architect'];
    assert.equal(verified?.roleSource, 'codex-session-meta-agent-path');
    assert.equal(verified?.transcriptPath, transcript);
  });

  withMaterialized({ teamApproved: true }, (cwd) => {
    const runId = 'run-codex-meta-unverified';
    const childThread = '019f69fe-e335-7de0-be43-1ee45e3535c8';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${childThread}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"session_', 'utf8');
    setCurrentRunId(cwd, runId);
    freezeRunPolicy(cwd, 'codex', runId);
    recordRunAgent(cwd, runId, 'senior-architect', {
      agentId: childThread,
      parentSessionId: 'parent-thread-1',
      transcriptPath: transcript,
      model: 'gpt-5.6-sol',
    });

    const duplicate = agentModelGate(codexSpawnCtx(cwd, {
      task_name: 'senior_architect',
      message: '[t1-role: senior-architect]\nContinue the bounded architecture task.',
      model: 'gpt-5.6-sol',
      fork_turns: 'none',
    }));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.match(duplicate.reason, /fresh Codex `senior-architect` registry row/);
      assert.ok(duplicate.reason.includes(`child \`${childThread}\``));
      assert.match(duplicate.reason, /codex-observed-model-missing/);
      assert.match(duplicate.reason, /Do not route `followup_task`\/`send_message` to this unverified id/);
      assert.match(duplicate.reason, /do not start a duplicate/i);
      assert.match(duplicate.reason, /Retry after the child rollout is flushed/);
      assert.match(duplicate.reason, /use `\[t1-replace-agent\]` with the concrete failure reason/);
      assert.match(duplicate.reason, /exact task-name contract/);
      assert.match(duplicate.reason, /`senior_architect`/);
      assert.match(duplicate.reason, /encrypt spawn-message content/i);
      assert.doesNotMatch(duplicate.reason, /Continue the SAME Codex agent/i);
    }
    const stillFresh = readRunAgentRegistry(cwd, runId)['senior-architect'];
    assert.equal(stillFresh?.replaced, false, 'an unresolved fresh row is preserved while metadata may still flush');
    assert.equal(stillFresh?.roleSource, null);
  });
});

test('reuse (Codex): authoritative dead-child conflict rebinds before continuation and allows a fresh requested role', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const runId = 'run-codex-dead-reuse-rebind';
    const parentThread = 'parent-thread-1';
    const childThread = '019f69fe-e335-7de0-be43-1ee45e3535d9';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${childThread}.jsonl`);
    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(childThread, parentThread, '/root/senior_architect'))}\n`,
      'utf8',
    );
    setCurrentRunId(cwd, runId);
    freezeRunPolicy(cwd, 'codex', runId);
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'codex' });
    writeArchitectPhaseComplete(cwd, runId, state as Record<string, unknown>);
    assert.equal(observeCodexChildModel(cwd, runId, {
      childId: childThread,
      parentSessionId: parentThread,
      actualModel: 'gpt-5.6-sol',
      role: 'senior-frontend',
      source: 'SubagentStart',
    })?.status, 'verified');
    assert.ok(claimThreadRole(cwd, state, childThread, 'senior-frontend', {
      parentSessionId: parentThread,
      model: 'gpt-5.6-sol',
      recordAgent: false,
    }));
    recordRunAgent(cwd, runId, 'senior-frontend', {
      agentId: childThread,
      parentSessionId: parentThread,
      transcriptPath: transcript,
      model: 'gpt-5.6-sol',
    });

    const freshFrontend = agentModelGate(codexSpawnCtx(cwd, {
      task_name: 'senior_frontend',
      message: '[t1-role: senior-frontend]\nImplement the next bounded frontend unit.',
      model: 'gpt-5.6-sol',
      fork_turns: 'none',
    }));
    assert.equal(freshFrontend.kind, 'noop', 'the poisoned frontend key is freed instead of continuing the architect');
    const registry = readRunAgentRegistry(cwd, runId);
    assert.equal(registry['senior-frontend'], undefined);
    assert.equal(registry['senior-architect']?.agentId, childThread);
    const corrected = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', runId, `${childThread}.json`),
      'utf8',
    ));
    assert.equal(corrected.role, 'senior-architect');
    assert.equal(corrected.correctedFromRole, 'senior-frontend');
  });
});

test('reuse (Codex): a registry row from another parent session cannot block a fresh spawn', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const runId = 'run-codex-parent-mismatch';
    setCurrentRunId(cwd, runId);
    freezeRunPolicy(cwd, 'codex', runId);
    writeArchitectPhaseComplete(cwd, runId, readEffectiveState(cwd) as Record<string, unknown>);
    recordRunAgent(cwd, runId, 'senior-frontend', {
      agentId: '019f69fe-e335-7de0-be43-1ee45e3535ea',
      parentSessionId: 'dead-parent-thread',
      roleSource: 'spawn-task-name',
    });
    const fresh = agentModelGate(codexSpawnCtx(cwd, {
      task_name: 'senior_frontend',
      message: '[t1-role: senior-frontend]\nImplement the bounded frontend unit.',
      model: 'gpt-5.6-sol',
      fork_turns: 'none',
    }));
    assert.equal(fresh.kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, runId)['senior-frontend']?.parentSessionId, 'dead-parent-thread');
  });
});

test('shipped instruction sources require a pinned Codex model and versionless plan-aware catalog', () => {
  const instructionPaths = [
    'src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md',
    'src/modules/skills/skills-catalog/senior-eng-orchestrator/resources/prompt-templates.md',
    'src/modules/skills/skills-catalog/model-tier-sync/SKILL.md',
    'src/modules/agent-model/skill/SKILL.md',
    'src/modules/rules/rules/common/senior-engineer-team.md',
    'src/modules/agent-model/subagent-bind.ts',
    'src/modules/agent-model/codex-child-model.ts',
    'src/modules/plan-guard/plan-runteam.ts',
  ];
  const staleCodexNoModelClaims = [
    /\bCodex\b[^\n]{0,180}\bpass no `?model`?/i,
    /\bCodex\b[^\n]{0,180}\bwith no `?model`?/i,
    /\bCodex\b[^\n]{0,180}\bno `?model`? field/i,
    /\bCodex\b[^\n]{0,180}\bomit(?: the)? `?model`?/i,
    /\bCodex\b[^\n]{0,180}\b(?:does not|doesn't|cannot|can't)\b[^\n]{0,80}\b(?:support|accept|expose|receive)\b[^\n]{0,40}\bmodel\b/i,
    /\bCodex\b[^\n]{0,180}\bexposes no\b[^\n]{0,30}\bmodel\b/i,
  ];

  for (const relPath of instructionPaths) {
    const content = fs.readFileSync(path.join(process.cwd(), relPath), 'utf8');
    assert.doesNotMatch(content, /\bfork_context\b/, `${relPath} uses the obsolete fork_context key`);
    for (const staleClaim of staleCodexNoModelClaims) {
      assert.doesNotMatch(content, staleClaim, `${relPath} says Codex cannot receive an explicit model`);
    }
  }

  const orchestrator = fs.readFileSync(path.join(process.cwd(), instructionPaths[0]!), 'utf8');
  const syncSkill = fs.readFileSync(path.join(process.cwd(), instructionPaths[2]!), 'utf8');
  assert.match(orchestrator, /Codex `spawn_agent`[^\n]*`model`[^\n]*`fork_turns: "none"`/i);
  assert.doesNotMatch(syncSkill, /payloadSchemaVersion/);
  assert.match(syncSkill, /"tiers": \{/);
  assert.match(syncSkill, /"plans": \{/);
  assert.match(syncSkill, /sparse overrides[^\n]*complete plan rows/i);
});

test('reuse (Copilot): records background agent_id and denies same-role respawn', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-copilot-reuse');
    const rec = recordSpawnedAgent(postSpawnCtx(
      cwd,
      {
        agent_type: 'traffic-one:senior-frontend',
        name: 'senior-frontend',
        mode: 'background',
        prompt: 'implement learner frontend',
      },
      {
        toolTelemetry: {
          restrictedProperties: {
            agent_id: 'senior-frontend',
            agent_name: 'traffic-one:senior-frontend',
          },
        },
      },
      'parent-1',
      'copilot',
      'task',
    ));
    assert.equal(rec.kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, 'run-copilot-reuse')['senior-frontend']?.agentId, 'senior-frontend');

    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      agent_type: 'traffic-one:senior-frontend',
      name: 'senior-frontend-fixes',
      mode: 'background',
      prompt: 'Apply reviewer-requested fixes',
    }, 'parent-1', 'copilot'));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.ok(duplicate.reason.includes('senior-frontend'), 'deny names the live Copilot agent id');
      assert.ok(duplicate.reason.includes('Copilot') && duplicate.reason.includes('task'), 'deny teaches the Copilot continuation recipe');
      assert.ok(!duplicate.reason.includes('SendMessage'), 'no Claude SendMessage on Copilot');
    }

    const explicitContinuation = agentModelGate(spawnCtxWithSession(cwd, {
      agent_type: 'traffic-one:senior-frontend',
      agent_id: 'senior-frontend',
      name: 'senior-frontend',
      mode: 'background',
      prompt: 'Continue with only the new fix task',
    }, 'parent-1', 'copilot'));
    assert.equal(explicitContinuation.kind, 'noop', 'Copilot task carrying agent_id passes as continuation');

    const sameNameContinuation = agentModelGate(spawnCtxWithSession(cwd, {
      agent_type: 'traffic-one:senior-frontend',
      name: 'senior-frontend',
      mode: 'background',
      prompt: 'Continue using the same background agent name',
    }, 'parent-1', 'copilot'));
    assert.equal(sameNameContinuation.kind, 'deny', 'Copilot name-only retry is still a fresh background task');
    if (sameNameContinuation.kind === 'deny') {
      assert.ok(sameNameContinuation.reason.includes('Do NOT substitute `name: "senior-frontend"`'));
    }
  });
});

test('reuse (Windsurf): records returned agent id and denies same-role respawn with run_subagent prose', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-windsurf-reuse');
    const rec = recordSpawnedAgent(postSpawnCtx(
      cwd,
      {
        profile: 'senior-frontend',
        prompt: '[t1-role: senior-frontend]\nbuild the UI',
      },
      { agent_id: 'devin-agent-123' },
      'parent-1',
      'windsurf',
    ));
    assert.equal(rec.kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, 'run-windsurf-reuse')['senior-frontend']?.agentId, 'devin-agent-123');

    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      profile: 'senior-frontend',
      prompt: '[t1-role: senior-frontend]\npart 2: admin area',
    }, 'parent-1', 'windsurf'));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.ok(duplicate.reason.includes('senior-frontend'));
      assert.ok(duplicate.reason.includes('run_subagent'));
      assert.ok(duplicate.reason.includes('profile `subagent_general`'));
      assert.ok(duplicate.reason.includes('[t1-role: senior-frontend]'));
      assert.ok(!duplicate.reason.includes('profile `devin-agent-123`'));
      assert.ok(!duplicate.reason.includes('SendMessage'));
    }
  });
});

test('reuse (Kilo): child binding records the live role and blocks a duplicate general task', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-kilo-reuse');
    freezeRunPolicy(cwd, 'kilo', 'run-kilo-reuse');
    const prompt = '[t1-role: senior-frontend]\nRead .kilo/agents/senior-frontend.md, then implement the UI.';
    opencodeSubagentBind({
      input: { event: 'UserPromptSubmit', host: 'kilo', cwd, raw: { session_id: 'kilo-child-fe', prompt }, prompt },
      host: 'kilo', cwd, now: () => 'x',
    } as unknown as Ctx);

    assert.equal(readRunAgentRegistry(cwd, 'run-kilo-reuse')['senior-frontend']?.agentId, 'kilo-child-fe');
    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'general',
      prompt: '[t1-role: senior-frontend]\nApply the next frontend fix.',
    }, 'kilo-parent', 'kilo'));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.ok(duplicate.reason.includes('Kilo'));
      assert.ok(duplicate.reason.includes('[t1-replace-agent]'));
      assert.ok(duplicate.reason.includes('[t1-role: senior-frontend]'));
      assert.ok(duplicate.reason.includes('general'));
    }
  });
});

test('reuse prose never tells Copilot to continue by name-only', () => {
  const teamRule = fs.readFileSync(path.join(process.cwd(), 'src/modules/rules/rules/common/senior-engineer-team.md'), 'utf8');
  const triage = fs.readFileSync(path.join(process.cwd(), 'src/modules/skills/skills-catalog/task-triage/SKILL.md'), 'utf8');
  for (const doc of [teamRule, triage]) {
    assert.match(doc, /agent_id/i);
    assert.doesNotMatch(doc, /agent_id`?\s*\/\s*(?:same\s*)?`?name`?/i);
  }
});

test('Windsurf first-run: built-in general profile binds the marker role and is allowed', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-windsurf-general');
    const result = agentModelGate(spawnCtxWithSession(cwd, {
      profile: 'subagent_general',
      task: '[t1-role: senior-architect]\nRead .devin/agents/senior-architect/AGENT.md, then produce PLAN_READY.',
    }, 'parent-1', 'windsurf'));
    assert.equal(result.kind, 'noop');
    const pendingDir = path.join(cwd, '.traffic-one', 'runs', 'run-windsurf-general', 'pending');
    assert.ok(fs.readdirSync(pendingDir).some((file) => file.startsWith('senior-architect-')));
  });
});

test('reuse (Windsurf): failed custom-profile spawn does not create a live registry entry', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-windsurf-failed-spawn');
    recordSpawnedAgent(postSpawnCtx(
      cwd,
      { profile: 'senior-architect', prompt: '[t1-role: senior-architect]\nplan' },
      { error: "Unknown subagent profile 'senior-architect'" },
      'parent-1',
      'windsurf',
    ));
    assert.equal(readRunAgentRegistry(cwd, 'run-windsurf-failed-spawn')['senior-architect'], undefined);
  });
});

test('reuse (Copilot): SubagentStart records background display name before fix-cycle respawn', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-copilot-subagent-start');
    freezeRunPolicy(cwd, 'copilot', 'run-copilot-subagent-start');
    subagentStartBind(subagentStartCtx(cwd, {
      sessionId: 'parent-1',
      transcriptPath: '/Users/w3s/.copilot/session-state/session/events.jsonl',
      agentName: 'traffic-one:senior-frontend',
      agentDisplayName: 'senior-frontend',
      agentDescription: 'Use PROACTIVELY after `senior-architect` produces `.traffic-one/plan.md` to implement the UI layer.',
    }, 'copilot'));

    assert.equal(
      readRunAgentRegistry(cwd, 'run-copilot-subagent-start')['senior-frontend']?.agentId,
      'senior-frontend',
      'Copilot SubagentStart display name is the reusable background agent id',
    );

    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      agent_type: 'traffic-one:senior-frontend',
      name: 'senior-frontend-fixes',
      mode: 'sync',
      prompt: 'Fix frontend contract mismatches',
    }, 'parent-1', 'copilot'));
    assert.equal(duplicate.kind, 'deny');
    if (duplicate.kind === 'deny') {
      assert.ok(duplicate.reason.includes('senior-frontend'));
      assert.ok(duplicate.reason.includes('Copilot') && duplicate.reason.includes('task'));
    }
  });
});

test('reuse (Cursor): duplicate spawn deny names Task resume UUID after PostToolUse records it', () => {
  withMaterialized({ teamApproved: true, cursorModels: DEFAULT_CURSOR_MODELS }, (cwd) => {
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

test('reuse (Cursor): a generic fix-cycle spawn ("owned by senior-X") is denied with the resume recipe instead of dying unbound (7c)', () => {
  withMaterialized({ teamApproved: true, cursorModels: DEFAULT_CURSOR_MODELS }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-cursor-fixcycle');
      freezeRunPolicy(cwd, 'cursor', 'run-cursor-fixcycle');
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: 'composer-2.5-fast', prompt: 'build the API' },
        'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 (can be used with the resume parameter)',
        'parent-1',
        'cursor',
      ));
      // Observed 7c: after CHANGES_REQUESTED the orchestrator spawned a fresh
      // `general-purpose` Task whose prompt named the owning role only in prose.
      // Pre-fix the role never resolved, the gate noop'd, and the unbound child
      // died as "New subagent — Couldn't start". Now the ownership phrasing
      // resolves the role and the reuse gate redirects to the live agent.
      const fix = agentModelGate(spawnCtxWithSession(cwd, {
        subagent_type: 'general-purpose',
        model: 'composer-2.5-fast',
        prompt: 'Fix CHANGES_REQUESTED item owned by senior-backend. Stay in your assignment scope.\n\n'
          + 'Finding VERBATIM from senior-reviewer:\n\n3. `packages/api-client/src/coursesService.ts:119` — unescaped search filter.',
      }, 'parent-1', 'cursor'));
      assert.equal(fix.kind, 'deny', 'the role-less generic fix spawn must be intercepted at PreToolUse');
      if (fix.kind === 'deny') {
        assert.ok(fix.reason.includes('bff46cd7-3681-4cf0-adcf-263bf55cc301'), 'deny names the live backend resume UUID');
        assert.match(fix.reason, /resume/i, 'deny teaches the Task resume continuation');
      }
    });
  });
});

test('reuse (Cursor): subagent-start records the spawned subagent_id into the registry (10b re-spawn-pileup fix)', () => {
  withMaterialized({ teamApproved: true, cursorModels: DEFAULT_CURSOR_MODELS }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-1');
    freezeRunPolicy(cwd, 'cursor', 'run-cursor-1');
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
          subagent_model: 'claude-fable-5-thinking-high',
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
    const dup = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-architect', model: 'claude-fable-5-thinking-high', prompt: 'continue architecture' }, 'orchestrator-parent', 'cursor'));
    assert.equal(dup.kind, 'deny');
    if (dup.kind === 'deny') {
      assert.ok(/has not exposed a valid Task `resume` UUID/i.test(dup.reason), dup.reason);
      assert.ok(!dup.reason.includes('resume: "tool_'), 'never suggests resuming a tool_* id');
    }
  });
});

test('Cursor: nested SubagentStart anchors every run write at the workspace root', () => {
  withMaterialized({ teamApproved: true, level: 'high' }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-nested-start');
    freezeRunPolicy(cwd, 'cursor', 'run-cursor-nested-start');
    const nested = path.join(cwd, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    const result = subagentStartBind({
      input: {
        event: 'SubagentStart', host: 'cursor', cwd: nested, workspaceRoot: cwd,
        raw: {
          hook_event_name: 'subagent-start',
          subagent_id: 'tool_c11d22e3-4444-4555-8666-777788889999',
          subagent_type: 'senior-architect',
          subagent_model: 'claude-fable-5-thinking-high',
          session_id: 'orchestrator-parent',
          started_at: Date.now(),
        },
      },
      host: 'cursor', cwd: nested, now: () => 'x',
    } as unknown as Ctx);

    assert.equal(result.kind, 'noop');
    assert.equal(
      readRunAgentRegistry(cwd, 'run-cursor-nested-start')['senior-architect']?.toolCallId,
      'tool_c11d22e3-4444-4555-8666-777788889999',
      'the live registry is rooted at the workspace',
    );
    assert.equal(
      listCursorSpawnObservations(cwd, 'run-cursor-nested-start')[0]?.toolCallId,
      'tool_c11d22e3-4444-4555-8666-777788889999',
      'the immutable spawn observation is rooted at the workspace',
    );
    assert.equal(
      fs.existsSync(path.join(nested, '.traffic-one')),
      false,
      'SubagentStart must never mint nested run/model/claim state',
    );
  });
});

test('Cursor child fails closed when its parent policy is missing or corrupt and never repairs it from mutable state', () => {
  withMaterialized({ teamApproved: true, level: 'high' }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-child-policy');
    const child = () => subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'subagent-start',
      subagent_id: 'tool_cursor_policy_child',
      subagent_type: 'senior-architect',
      subagent_model: 'claude-fable-5-thinking-high',
      session_id: 'orchestrator-parent',
    }, 'cursor'));

    const missing = child();
    assert.equal(missing.kind, 'deny');
    if (missing.kind === 'deny') assert.match(missing.reason, /model-policy\.json is missing or corrupt/i);
    assert.equal(readRunAgentRegistry(cwd, 'run-cursor-child-policy')['senior-architect'], undefined);

    freezeRunPolicy(cwd, 'cursor', 'run-cursor-child-policy');
    const policyPath = path.join(cwd, '.traffic-one', 'runs', 'run-cursor-child-policy', 'model-policy.json');
    const tampered = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
    tampered.plan = 'business';
    fs.writeFileSync(policyPath, JSON.stringify(tampered), 'utf8');
    const corrupt = child();
    assert.equal(corrupt.kind, 'deny');
    if (corrupt.kind === 'deny') assert.match(corrupt.reason, /model-policy\.json is missing or corrupt/i);
    assert.equal(readRunModelPolicy(cwd, 'run-cursor-child-policy'), null);
    assert.equal(readRunAgentRegistry(cwd, 'run-cursor-child-policy')['senior-architect'], undefined);
  });
});

test('Cursor: SubagentStart stops senior team when model choice is still pending, even with generic subagent_type', () => {
  withMaterialized({
    teamApproved: true,
    cursorModels: ['claude-fable-5-thinking-high', 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'],
  }, (cwd) => {
    setCurrentRunId(cwd, 'run-cursor-pending-model-choice');
    const prefs = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'));
    for (const hostPrefs of Object.values(prefs.hosts) as Record<string, unknown>[]) {
      (hostPrefs.team as Record<string, unknown>).overrides = { 'senior-architect': 'balanced' };
    }
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify(prefs), 'utf8');
    freezeRunPolicy(cwd, 'cursor', 'run-cursor-pending-model-choice');

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
    assert.equal(
      listCursorSpawnObservations(cwd, 'run-cursor-pending-model-choice')[0]?.toolCallId,
      'tool_pending_model_choice',
      'the actual start remains immutable evidence even though the pending choice stops the child',
    );
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
  assert.equal(subagentContinuationAvailable({ TRAFFIC_ONE_HOST: 'copilot' } as NodeJS.ProcessEnv), true);
  assert.equal(subagentContinuationAvailable({ TRAFFIC_ONE_HOST: 'copilot', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv, 'copilot'), true);
  assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv, 'windsurf'), true);
  assert.equal(subagentContinuationAvailable({ TRAFFIC_ONE_HOST: 'windsurf' } as NodeJS.ProcessEnv), true);
  assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv, 'opencode'), true);
  assert.equal(subagentContinuationAvailable({ TRAFFIC_ONE_HOST: 'opencode' } as NodeJS.ProcessEnv), true);
});

test('Cursor reuse deny names the Task resume recipe and accepts continuation fields', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // First Cursor spawn passes the gate + mints currentRunId + stakes a claim.
    agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    // Simulate the PostToolUse recorder writing the live-agent registry.
    const rd = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
      version: 1, agents: { 'senior-frontend': { agentId: 'cursor-agent-xyz', recordedAt: new Date().toISOString(), tasks: 1, replaced: false } },
    }));
    // Duplicate Cursor spawn → reuse deny with the Task+resume recipe (NOT SendMessage).
    const d = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high' }, 'cursor'));
    assert.equal(d.kind, 'deny');
    if (d.kind === 'deny') {
      assert.ok(d.reason.includes('cursor-agent-xyz'), 'names the live agent id');
      assert.ok(/Task/.test(d.reason) && /resume/.test(d.reason), 'uses the Cursor Task resume recipe');
      assert.ok(!d.reason.includes('SendMessage'), 'no Claude SendMessage on Cursor');
    }
    // The RESUME itself (Task carrying resume) must pass the gate — never block the
    // continuation it just asked for. This makes the deny satisfiable → no soft-loop.
    const resume = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high', resume: 'cursor-agent-xyz' }, 'cursor'));
    assert.equal(resume.kind, 'noop', 'a Cursor Task call carrying resume passes the reuse gate');
    const legacyAgentId = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'claude-fable-5-thinking-high', agentId: 'cursor-agent-xyz' }, 'cursor'));
    assert.equal(legacyAgentId.kind, 'noop', 'legacy agentId continuation remains accepted');
  });
});

test('Cursor dead-agent escape: a stale no-resume-id agent is retired so the retry is NOT deadlocked on await-cursor-id', () => {
  // The real deadlock (session dfde9239): the senior-architect hit a Cursor API
  // usage limit and died BEFORE producing a resume UUID (resumeId stays null). The
  // orchestrator retried with "Continue architect work" (no [t1-replace-agent], no
  // limit wording), and the reuse gate denied every retry with await-cursor-id —
  // telling it to wait for a resume id that will never arrive. Past the grace
  // window, the gate must presume the agent dead, retire it, and allow the retry.
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-dead');
    const rd = path.join(cwd, '.traffic-one', 'runs', 'run-dead');
    fs.mkdirSync(rd, { recursive: true });
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago (> 90s grace)
    fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
      version: 1,
      agents: { 'senior-architect': { agentId: 'tool_dead1234-1a31-47e6-a1ce-ba45b370fe7', resumeId: null, toolCallId: 'tool_dead1234-1a31-47e6-a1ce-ba45b370fe7', role: 'senior-architect', model: 'gpt-5.6-terra-medium', agentType: 'senior-architect', parentSessionId: 'orchestrator-parent', recordedAt: stale, tasks: 1, replaced: false } },
      history: [],
    }));
    // Plain retry — the exact framing the stuck run used: no marker, no limit text.
    const retry = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-architect',
      model: 'gpt-5.6-terra-medium',
      prompt: '[t1-role: senior-architect]\nContinue architect work; deliverables still needed: .traffic-one/plan.md',
    }, 'orchestrator-parent', 'cursor'));
    assert.notEqual(retry.kind, 'deny', 'the retry is allowed once the dead agent is retired (no await-cursor-id deadlock)');
    assert.equal(readRunAgentRegistry(cwd, 'run-dead')['senior-architect']?.replaced, true, 'the dead architect is retired from the registry');
  });
});

test('Cursor await-cursor-id is preserved for a FRESH no-resume-id agent (resume id may still be incoming)', () => {
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    setCurrentRunId(cwd, 'run-fresh');
    const rd = path.join(cwd, '.traffic-one', 'runs', 'run-fresh');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
      version: 1,
      agents: { 'senior-architect': { agentId: 'tool_face9012-1a31-47e6-a1ce-ba45b370fe7', resumeId: null, toolCallId: 'tool_face9012-1a31-47e6-a1ce-ba45b370fe7', role: 'senior-architect', model: 'gpt-5.6-terra-medium', agentType: 'senior-architect', parentSessionId: 'orchestrator-parent', recordedAt: new Date().toISOString(), tasks: 1, replaced: false } },
      history: [],
    }));
    const retry = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'senior-architect',
      model: 'gpt-5.6-terra-medium',
      prompt: '[t1-role: senior-architect]\nContinue architect work; deliverables still needed: .traffic-one/plan.md',
    }, 'orchestrator-parent', 'cursor'));
    assert.equal(retry.kind, 'deny', 'a fresh agent still waits — the resume id may not have been harvested yet');
    if (retry.kind === 'deny') assert.ok(/has not exposed a valid Task `resume` UUID/i.test(retry.reason));
    assert.equal(readRunAgentRegistry(cwd, 'run-fresh')['senior-architect']?.replaced, false, 'a fresh agent is not retired');
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
  assert.equal(inferTrafficOneSpawnRole({
    profile: 'subagent_general',
    task: '[t1-role: senior-architect]\nRead the materialized Devin role contract.',
  }), 'senior-architect');
});
