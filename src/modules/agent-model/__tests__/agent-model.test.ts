import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { SUBAGENT_STALE_MS } from '../../../config/state';
import { selectAdapter } from '../../../adapters/select';
import { TOOL_INPUT_KEYS, toolResultPayload } from '../../../shared/tool-result';
import { agentModelGate } from '../handler';
import { classifySubagentStop, extractSpawnedAgentId, recordSpawnedAgent } from '../record-agent';
import { subagentStartBind } from '../subagent-bind';
import { opencodeSubagentBind } from '../opencode-subagent-bind';
import { SPAWN_BRIEF_KEYS, inferTrafficOneSpawnRole, inferTrafficOneSpawnRoleEvidence } from '../role-infer';
import { GENERATED_MARKER } from '../../../shared/materialize';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import { writeArchitectPhaseComplete } from '../../plan-guard/__tests__/architect-phase-fixtures';
import { modelChoicePrompted, writeModelChoice } from '../model-choice';
import { exhaustedModelsForRole, recordExhaustedModel } from '../exhausted-models';
import { markOpenCodePlanBatchComplete, markOpenCodePlanBatchTerminal, markOpenCodePlanRoleCompleted, markOpenCodeRoleAttempted, markVerifyGateDenied } from '../../../shared/opencode-roles';
import { REPLACE_AGENT_MARKER, claimThreadRole, ensureRunAgentClaim, hookSessionIdentity, listCursorSpawnObservations, markCursorSpawnObservationRetryHandled, observeCodexChildModel, readCodexModelObservation, readEffectiveState, readRunAgentRegistry, recordCursorSpawnObservation, recordRunAgent, resolveRunAgentContext, runLedgerAdmitsClaims, subagentContinuationAvailable, transitionRunStatus } from '../../../shared/state';
import { isForeignOnboardingThread } from '../../../shared/onboarding-server/onboarding-session';
import type { Ctx, HookInput, HookResult, ToolClass } from '../../../core/types';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';
import {
  CURSOR_HIGHEST_ALT as FIXTURE_CURSOR_HIGHEST_ALT,
  CURSOR_HIGHEST_FAMILY,
  CURSOR_HIGHEST_SLUG as FIXTURE_CURSOR_HIGHEST_SLUG,
  DEFAULT_CURSOR_MODELS,
  freezeRunPolicy as freezeRunPolicyFixture,
  withMaterialized as withMaterializedFixture,
} from './agent-model-fixtures';
import { openCodeGlobalAgentName } from '../../../shared/materialize/opencode-assets';
import { ensureRunModelPolicy, readRunModelPolicy } from '../../../shared/run-model-policy';
import { ensureRunBootstrap, readActiveRunBootstrap } from '../../../shared/run-bootstrap-policy';
import { codexChildModelGate } from '../codex-child-model';
import { captureCursorModels, freshCursorModels } from '../../../shared/materialize/cursor-models';
import { currentHostModelTarget } from '../../../shared/current-model-tiers';
import { modelTierSnapshot, resolveModel } from '../../../shared/model-tiers';
import { writeOneMcpConfigCacheEntry } from '../../../shared/one-mcp/cache';
import { oneMcpPayloadFingerprint } from '../../../shared/one-mcp';
import type { OneMcpModelConfigPayload } from '../../../shared/one-mcp/types';
import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  DEFAULT_PUBLIC_ENDPOINT,
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

test('inferTrafficOneSpawnRole binds a distinct-named reattach-dodging replacement (senior_frontend_fix_1) to its role', () => {
  // 15c-codex: after a hook-model-conflict retirement, a plain same-name
  // `senior_frontend` respawn kept reattaching the dead runtime, so root tried
  // `senior_frontend_fix_1` — which must still bind to senior-frontend (only a
  // numeric suffix used to be stripped, so it resolved to null and deadlocked
  // the fix cycle).
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'senior_frontend_fix_1' }), 'senior-frontend');
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'senior_backend_fix_2' }), 'senior-backend');
  assert.equal(inferTrafficOneSpawnRole({ subagent_type: 'senior-reviewer-retry' }), 'senior-reviewer');
  // Canonical and numeric-suffixed forms still resolve; a non-role name stays null.
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'senior_tester' }), 'senior-tester');
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'senior-shipper-2' }), 'senior-shipper');
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'quick_fix_1' }), 'quick-fix');
  assert.equal(inferTrafficOneSpawnRole({ task_name: 'totally_unrelated_worker' }), null);
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
    agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
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
      model: CURSOR_HIGHEST_SLUG,
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
// Derived from the live catalog, never hardcoded: which family anchors a tier is
// editable policy, so a re-order must not break these behavioural gate tests.
// Fixtures shared with the sibling gate suites (exploration cap, verify gate)
// live in ./agent-model-fixtures; re-bound locally to keep call sites short.
const CURSOR_HIGHEST_SLUG = FIXTURE_CURSOR_HIGHEST_SLUG;
const CURSOR_HIGHEST_ALT = FIXTURE_CURSOR_HIGHEST_ALT;

function withMaterialized(opts: { teamApproved: boolean; cursorModels?: string[] | null; architectComplete?: boolean; level?: 'high' | 'balanced' | 'low' }, fn: (cwd: string) => void): void {
  withMaterializedFixture(opts, fn);
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

test('the child model gate stands down before policy reads inside the plugin authoring repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoring-child-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'gen', 'index.ts'), 'export {};\n', 'utf8');
    resetAuthoringRootCache();
    const input: HookInput = {
      event: 'PreToolUse',
      host: 'codex',
      cwd: dir,
      raw: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        session_id: 'root-thread',
        agent_id: 'child-thread',
        agent_type: 'senior-frontend',
      },
      tool: {
        class: 'file-read',
        rawName: 'Read',
        filePath: path.join(dir, 'src', 'gen', 'index.ts'),
      },
    };
    const ctx = { input, host: 'codex', cwd: dir, now: () => 'x' } as unknown as Ctx;
    assert.equal(codexChildModelGate(ctx).kind, 'noop');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false);
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('authoring cwd does not exempt an absolute target in a real project', () => {
  withMaterialized({ teamApproved: true }, (projectRoot) => {
    const authoringRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoring-external-target-'));
    try {
      fs.writeFileSync(path.join(authoringRoot, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
      fs.mkdirSync(path.join(authoringRoot, 'src', 'gen'), { recursive: true });
      fs.writeFileSync(path.join(authoringRoot, 'src', 'gen', 'index.ts'), 'export {};\n', 'utf8');
      resetAuthoringRootCache();
      const input: HookInput = {
        event: 'PreToolUse',
        host: 'claude',
        cwd: authoringRoot,
        raw: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          session_id: 'parent-session',
          agent_id: 'child-session',
          agent_type: 'senior-frontend',
          tool_input: { file_path: path.join(projectRoot, 'README.md') },
        },
        tool: {
          class: 'file-read',
          rawName: 'Read',
          filePath: path.join(projectRoot, 'README.md'),
        },
      };
      const ctx = { input, host: 'claude', cwd: authoringRoot, now: () => 'x' } as unknown as Ctx;
      const result = codexChildModelGate(ctx);
      assert.equal(result.kind, 'deny');
      if (result.kind === 'deny') assert.match(result.reason, /model-policy\.json is missing/i);
    } finally {
      resetAuthoringRootCache();
      fs.rmSync(authoringRoot, { recursive: true, force: true });
    }
  });
});

function spawnCtx(cwd: string, toolInput: Record<string, unknown>, host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'kilo' = 'claude', workspaceRoot?: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host, cwd, workspaceRoot, raw: { tool_name: 'Task', tool_input: toolInput },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

const QUICK_FIX_SCOPE_MARKER =
  '[t1-bounded-scope: {"outputs":["src/bounded-fix.ts"],"allowlist":["src/bounded-fix.ts"],"exclude":[]}]';

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
      model: CURSOR_HIGHEST_SLUG,
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

test('every recognized host child needs both the parent policy and a parent-bound trafficOneRole before its first tool', () => {
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
    const unbound = codexChildModelGate(childCtx);
    assert.equal(unbound.kind, 'deny');
    if (unbound.kind === 'deny') assert.match(unbound.reason, /no parent-resolved trafficOneRole/i);
  });
});

test('an unbound child that the reuse registry names as the live role agent is adopted, not deadlocked', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // Live deadlock: the reuse gate refused a replacement spawn because
    // agents.json names this child as the live `senior-architect`, while this
    // gate demanded exactly that respawn because the child carried no claim
    // (it was spawned before its bootstrap envelope existed). Nine consecutive
    // identical denials across Read and Bash — a bare `pwd` included — and the
    // follow-up feature could never start.
    const childCtx = (agentId: string): Ctx => ({
      input: {
        event: 'PreToolUse', host: 'claude', cwd,
        raw: {
          hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 'parent-session',
          // recognized as a child (distinct thread under the parent session)
          // but carrying NO role — exactly the shape that deadlocked live.
          agent_id: agentId, agent_type: 'default',
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent-session' } } },
        },
        tool: { class: 'file-read', rawName: 'Read', filePath: path.join(cwd, 'README.md') },
      },
      host: 'claude', cwd, now: () => 'x',
    } as unknown as Ctx);

    freezeRunPolicy(cwd, 'claude');
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'claude' });
    const runId = String(state.currentRunId);
    const policy = readRunModelPolicy(cwd, runId);
    assert.ok(policy);
    assert.ok(ensureRunBootstrap(cwd, runId, 'senior-architect', state, {
      modelPolicyId: policy.policyId,
      host: 'claude',
    }));

    // no registry row → still fail-closed
    const stillDenied = codexChildModelGate(childCtx('a4418a7fd15384451'));
    assert.equal(stillDenied.kind, 'deny');
    if (stillDenied.kind === 'deny') assert.match(stillDenied.reason, /no parent-resolved trafficOneRole/i);

    // parent-issued registry row naming this exact child → adopted
    recordRunAgent(cwd, runId, 'senior-architect', {
      agentId: 'a4418a7fd15384451',
      parentSessionId: 'parent-session',
    });
    assert.equal(codexChildModelGate(childCtx('a4418a7fd15384451')).kind, 'noop');
    // and the adoption is durable: the claim now resolves for later calls
    assert.equal(
      resolveRunAgentContext(cwd, readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'claude' }), {
        hook_event_name: 'PreToolUse', session_id: 'parent-session', agent_id: 'a4418a7fd15384451',
      }, { claimPending: false, host: 'claude' })?.role,
      'senior-architect',
    );
    // a DIFFERENT child id is never adopted off someone else's registry row
    const foreign = codexChildModelGate(childCtx('some-other-child'));
    assert.equal(foreign.kind, 'deny');
    if (foreign.kind === 'deny') assert.match(foreign.reason, /no parent-resolved trafficOneRole/i);
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
    // The corrective spawn is still not blocked — but it SUPERSEDES the failed
    // named-agent attempt's handoff instead of adding a second one beside it.
    // Both come from `kilo-parent`, and the role-keyed CAS slot
    // (claims-store.ts's pendingClaimFile) holds exactly one claim per role, so
    // the parent's own retry replaces its dead attempt. Two claims for one role
    // was never the recovery working; it was `activeRunClaimCount` reporting two
    // live architects and vetoing settlement until both expired.
    assert.deepEqual(fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')), ['senior-architect.json'],
      'the corrective spawn is not blocked, and replaces the failed attempt rather than doubling it');

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
      'the child bind consumes the role\'s pending claim');
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
    const pending = fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId, 'pending'));
    assert.deepEqual(pending, ['senior-architect.json'], 'pending senior-architect claim staked for OpenCode, in the role-keyed CAS slot');
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

// CHANGED BEHAVIOUR (was: 'OpenCode: bound child session records a live role and
// duplicate same-role spawn requires explicit replacement'). The old test asserted
// that the bind wrote a reuse-registry row and that the row then DENIED the role's
// next spawn. The row's only role evidence was the `[t1-role:]` marker in the prompt
// the orchestrator itself wrote, and OpenCode exposes no continuation primitive to
// route the denied task to — so the deny rested on evidence no host ever
// corroborated. Reuse now stands down on OpenCode; the child CLAIM (the part that
// makes a child's writes resolve) is unchanged, which is what the assertions below
// pin.
test('OpenCode: a bound child claims its role but never a reusable agent row, so a same-role respawn is not denied', () => {
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
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-frontend'], undefined,
      'no unverifiable reuse row is written on OpenCode');
    // The claim still binds — role resolution for the child's writes must not
    // regress with the registry.
    assert.equal(
      resolveRunAgentContext(cwd, readEffectiveState(cwd), { session_id: 'ses_oc_frontend_1' }, { claimPending: false })?.role,
      'senior-frontend',
      'the child session still resolves its role from its claim',
    );

    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: openCodeGlobalAgentName(cwd, 'senior-frontend'),
      prompt: '[t1-role: senior-frontend]\nFix build errors.',
    }, 'parent-oc', 'opencode'));
    assert.equal(duplicate.kind, 'noop', 'the follow-up spawns fresh instead of being routed to an unverified child');

    // The [t1-replace-agent] escape hatch stays satisfiable — it was the only exit
    // from the old deny, and a host without the registry must not lose it.
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
        subagent_type: 'senior-architect', model: CURSOR_HIGHEST_SLUG,
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
    // high senior-frontend → highest tier → the exact captured Cursor Task-tool slug.
    // The bare Anthropic alias Cursor rejects → deny (the original tester bug).
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
    const bareFamily = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_FAMILY }, 'cursor'));
    assert.equal(bareFamily.kind, 'deny');
    if (bareFamily.kind === 'deny') {
      assert.ok(bareFamily.reason.includes('Cursor model gate'));
      assert.ok(bareFamily.reason.includes(CURSOR_HIGHEST_SLUG));
    }
    const invented = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: `${CURSOR_HIGHEST_SLUG}-fast` }, 'cursor'));
    assert.equal(invented.kind, 'deny');
    if (invented.kind === 'deny') assert.ok(invented.reason.includes('Cursor model gate'));

    // The exact highest Task-tool slug passes.
    // The FIRST passing Cursor spawn of the run also carries the one-time model-availability
    // advisory (kind 'context'); it is still an ALLOW (not a deny) and stakes the claim.
    assert.notEqual(agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor')).kind, 'deny');
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const runId = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    assert.ok(runId.length > 0, 'currentRunId minted on Cursor spawn');
    const pending = fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId, 'pending'));
    assert.deepEqual(pending, ['senior-frontend.json'], 'pending senior-frontend claim staked on Cursor');
  });
});

test('Cursor: the configured same-tier FALLBACK model satisfies the gate when the build lacks the preferred slug', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // If a build doesn't offer the preferred highest slug, the configured same-tier fallback
    // satisfies the tier via the accept-set and stakes a claim, instead of deadlocking.
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_ALT }, 'cursor'));
    // Allowed (first passing spawn of the run may carry the one-time model-availability advisory).
    assert.notEqual(ok.kind, 'deny', 'the configured same-tier fallback satisfies the gate');
    const runId = (JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string) || '';
    const pending = fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId, 'pending'));
    assert.deepEqual(pending, ['senior-frontend.json'], 'claim staked on the fallback-model spawn');
  });
});

test('Cursor: spawn gate resolves subpackage cwd to the workspace root before writing run state', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const pkg = path.join(cwd, 'packages', 'ui');
    fs.mkdirSync(pkg, { recursive: true });
    const r = agentModelGate(spawnCtx(pkg, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor', cwd));
    assert.notEqual(r.kind, 'deny', 'valid spawn from a package cwd is allowed');

    const rootState = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    const runId = String(rootState.currentRunId || '');
    assert.ok(runId.length > 0, 'currentRunId is minted on the workspace root');
    assert.equal(fs.existsSync(path.join(pkg, '.traffic-one', '.one.json')), false, 'no stray package .traffic-one state is created');
    const pendingDir = path.join(cwd, '.traffic-one', 'runs', runId, 'pending');
    assert.deepEqual(fs.readdirSync(pendingDir), ['senior-frontend.json'], 'run claim is staked under the workspace root');
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
    const r = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
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
      assert.ok(d.reason.includes(CURSOR_HIGHEST_SLUG), 'names the recommended build slug');
      assert.ok(d.reason.includes(CURSOR_HIGHEST_ALT), 'names a usable same-tier fallback build slug');
    }
    // After "use-fallback", the plain per-role deny LISTS the same-tier fallback families
    // resolved to the real build slugs the runner offers, so the orchestrator can switch.
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    writeModelChoice(cwd, runId, 'use-fallback');
    const d2 = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }, 'cursor'));
    assert.equal(d2.kind, 'deny');
    if (d2.kind === 'deny') {
      assert.ok(d2.reason.includes(CURSOR_HIGHEST_SLUG) && d2.reason.includes('composer-2.5-fast'),
        'lists the same-tier fallback build slugs');
    }
  });
});

test('Cursor capture precondition: the immutable run stays blocked until the picker is captured', () => {
  withMaterialized({ teamApproved: true, cursorModels: null }, (cwd) => {
    // No captured model list yet → the gate asks the orchestrator to enumerate + persist it.
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(/model-capture|list the model ids/i.test(first.reason), 'asks to capture the model list');
      assert.match(first.reason, /required before the first team spawn/i);
      assert.doesNotMatch(first.reason, /optional|re-issue the same.*unchanged/i);
    }
    // Retrying without satisfying the prerequisite cannot mint a policy with an
    // empty model list or silently advance on guessed slugs.
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    assert.equal(second.kind, 'deny');

    // A non-empty but partial picker capture is still unsafe for an immutable
    // run: Balanced roles and quick-fix would have no exact runnable slug.
    assert.equal(captureCursorModels(cwd, [CURSOR_HIGHEST_SLUG], 'pro'), true);
    const partial = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    assert.equal(partial.kind, 'deny');
    if (partial.kind === 'deny') {
      assert.match(partial.reason, /missing captured tiers(?: for this run)?:\s*balanced, cheapest/i);
    }
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    assert.equal(readRunModelPolicy(cwd, runId), null, 'partial capture cannot publish model-policy.json');

    assert.equal(captureCursorModels(cwd, DEFAULT_CURSOR_MODELS, 'pro'), true);
    const third = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
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
      endpoint: DEFAULT_PUBLIC_ENDPOINT,
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
    fs.writeFileSync(path.join(agentsDir, 'senior-frontend.md'), `---\nname: senior-frontend\nmodel: ${CURSOR_HIGHEST_SLUG}\n---\nbody\n`, 'utf8');

    // NO model param → DENY, even though the frontmatter pins the right model.
    const noModel = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend' }, 'cursor'));
    assert.equal(noModel.kind, 'deny', 'no `model` arg → deny (Cursor would inherit the parent model)');

    // A WRONG-tier passed model → DENY (the matching frontmatter no longer rescues it). This is
    // the 19b bug: a balanced-override role pinned correctly but spawned on the parent's Opus.
    const wrong = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium' }, 'cursor'));
    assert.equal(wrong.kind, 'deny', 'wrong-tier passed model denies despite a matching frontmatter');

    // The CORRECT passed model → allowed (first pass may carry the one-time advisory).
    const ok = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    assert.notEqual(ok.kind, 'deny', 'the passed model is what satisfies the gate');
  });
});

test('Cursor degraded-to-floor choice: names the RECOMMENDED tier model verbatim (not the available floor), prompts once, then a recorded choice proceeds', () => {
  // Fable IS offered (so the eligibility gate does not fire) but the API budget is exhausted, so
  // the orchestrator passes composer-2.5-fast (the floor). The choice deny must name the model the
  // user should restore (the configured highest tier family) — NOT the floor it collapsed to.
  withMaterialized({ teamApproved: true, cursorModels: [CURSOR_HIGHEST_SLUG, CURSOR_HIGHEST_ALT, 'composer-2.5-fast'] }, (cwd) => {
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
      assert.ok(first.reason.includes(CURSOR_HIGHEST_FAMILY), 'recommended model is the disabled tier family, not the available floor');
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
      assert.ok(blockedFloor.reason.includes(CURSOR_HIGHEST_FAMILY), 'names the recommended model to enable');
    }

    // 5) "enable-retry" + the orchestrator now passing a recommended-family slug → proceeds normally
    //    (not on the floor, so the degradation deny never fires).
    const er = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
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
    cursorModels: [CURSOR_HIGHEST_SLUG, 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'],
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
    const fe = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
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
      assert.ok(!first.reason.includes(CURSOR_HIGHEST_ALT), 'does not offer an absent first alternate');
    }
  });
});

test('Cursor proactive advisory: first passing spawn names the models + enable path, once per run', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const first = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    assert.equal(first.kind, 'context', 'first passing Cursor spawn carries the advisory');
    if (first.kind === 'context') {
      assert.ok(first.context.includes(CURSOR_HIGHEST_SLUG), 'advisory lists the team models');
      assert.ok(/budget/i.test(first.context), 'advisory names the budget-exhaustion cause + remedy');
      // USER-VISIBLE: rides systemMessage (→ user_message on Cursor), not just additional_context.
      assert.ok(first.systemMessage !== undefined, 'advisory has a user-visible systemMessage');
      assert.ok(/budget|Composer/i.test(String(first.systemMessage)), 'the visible banner explains the Composer/budget situation');
    }
    // A second passing spawn (different role) → advisory already shown → clean noop.
    const second = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-backend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    assert.equal(second.kind, 'noop', 'advisory is shown at most once per run');
  });
});

test('Cursor quick-fix is pinned to the exact captured cheapest Cursor model', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // quick-fix → cheapest tier → cursor "composer-2.5-fast". A pricier/alias model denies;
    // the exact Task-tool slug passes. A fabricated same-family sub-variant is denied before
    // Cursor sees it, because Task requires an id from the captured model list.
    assert.equal(agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }, 'cursor')).kind, 'deny');
    assert.equal(agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'composer-2.5-fast',
      prompt: QUICK_FIX_SCOPE_MARKER,
    }, 'cursor')).kind, 'noop');
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
    const ok = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    }));
    assert.equal(ok.kind, 'noop');
  });
});

test('quick-fix spawn mints only the exact machine-readable bounded scope', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const broad = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: '[t1-bounded-scope: {"outputs":["src/**"]}]',
    }));
    assert.equal(broad.kind, 'deny');

    const exact = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    }));
    assert.equal(exact.kind, 'noop');
    const state = readEffectiveState(cwd) as { currentRunId?: string };
    const envelope = readActiveRunBootstrap(cwd, String(state.currentRunId), 'quick-fix');
    assert.deepEqual(envelope?.workUnit.outputs, [
      `.traffic-one/digests/${String(state.currentRunId)}/quick-fix.md`,
      'src/bounded-fix.ts',
    ]);
    assert.deepEqual(envelope?.workUnit.allowlist, [
      `.traffic-one/digests/${String(state.currentRunId)}/quick-fix.md`,
      'src/bounded-fix.ts',
    ]);
  });
});

// CLAIM MINTING is the non-advisory half of the split rule in
// state/run-agent/mutation-result.ts: an `unavailable` mint is retried and then
// DENIED. Before this, all three mint call sites discarded the result, so a mint
// that never happened allowed the spawn anyway — and the child that started
// bound no role, wrote as the main agent, was invisible to the duplicate-spawn
// gate and could not be released when the run settled.
//
// `unavailable` is provoked at the write chokepoint rather than by holding the
// claims lock: a symlinked slot is refused by fsjson.ts's O_NOFOLLOW fence, which
// answers immediately and deterministically, where a contended lock costs two
// 2s timeouts and needs a live pid to stay unstale.
test('a role claim that cannot be recorded denies the spawn instead of starting a claimless child', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const ok = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    }));
    assert.equal(ok.kind, 'noop', 'the run and its claim slot exist before the slot is made unwritable');

    const runId = String((readEffectiveState(cwd) as { currentRunId?: string }).currentRunId);
    const slot = path.join(cwd, '.traffic-one', 'runs', runId, 'pending', 'quick-fix.json');
    fs.rmSync(slot, { force: true });
    fs.symlinkSync(path.join(os.tmpdir(), 't1-claim-slot-elsewhere.json'), slot);

    const denied = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    }));
    assert.equal(denied.kind, 'deny', 'a spawn whose claim cannot be recorded must not proceed');
    if (denied.kind === 'deny') {
      assert.match(denied.reason, /could not be recorded/);
      assert.match(denied.reason, /Retry the SAME spawn/);
      assert.match(denied.reason, /binds no role/,
        'the deny explains the harm it prevents, so the parent does not work around it');
    }
  });
});

test('a backgrounded role spawn is denied — foreground only', () => {
  // ep-new-feature e2e: the parent spawned the architect with
  // run_in_background:true, ended its turn "while it completes", and the
  // headless session exited — child killed, claim dangling, nothing delivered,
  // host exit 0. The gate must refuse the detach outright.
  withMaterialized({ teamApproved: true }, (cwd) => {
    const backgrounded = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-architect',
      model: 'opus',
      run_in_background: true,
    }));
    assert.equal(backgrounded.kind, 'deny');
    if (backgrounded.kind === 'deny') {
      assert.ok(backgrounded.reason.includes('FOREGROUND'));
      assert.ok(backgrounded.reason.includes('run_in_background'));
    }
    // The same spawn without the flag passes.
    const foreground = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-architect',
      model: 'opus',
    }));
    assert.equal(foreground.kind, 'noop', foreground.kind === 'deny' ? foreground.reason : undefined);
  });
});

test('claude model deny leads with the Task-schema alias, never a concrete slug the schema rejects', () => {
  // Claude's Task tool only accepts sonnet|opus|haiku|fable for `model`; a deny
  // that leads with "claude-sonnet-5" walks the parent into an
  // InputValidationError (observed: ep-new-feature run 1785662486571).
  withMaterialized({ teamApproved: true, level: 'balanced' }, (cwd) => {
    const bare = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-architect' }));
    assert.equal(bare.kind, 'deny');
    if (bare.kind === 'deny') {
      const named = /model:\s*"([^"]+)"/.exec(bare.reason)?.[1]
        || /`model:\s*"?([A-Za-z0-9._-]+)/.exec(bare.reason)?.[1];
      assert.ok(named, `deny must name a model to pass, got: ${bare.reason.slice(0, 200)}`);
      assert.ok(['sonnet', 'opus', 'haiku', 'fable'].includes(String(named)),
        `deny must lead with a Task-schema alias, got "${String(named)}" in: ${bare.reason.slice(0, 300)}`);
    }
  });
});

test('scope-less quick-fix spawn in a run with no compiled assignments names the bounded-scope remedy', () => {
  // The ep-text-edit e2e failure: a headless session (no UserPromptSubmit → no
  // triage directive) spawned quick-fix with NO bounded scope in a run that has
  // no compiled assignments. The envelope is unfulfillable by construction, and
  // the old generic "repair and retry" deny looped the parent six times before
  // it silently gave up. The deny must name the actual fix.
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    one.lifecycle = { phase: 'maintenance', source: 'test' };
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');

    const bare = agentModelGate(spawnCtx(cwd, { subagent_type: 'quick-fix', model: 'haiku' }));
    assert.equal(bare.kind, 'deny');
    if (bare.kind === 'deny') {
      assert.ok(bare.reason.includes('t1-bounded-scope'), `deny must name the marker, got: ${bare.reason}`);
      assert.ok(bare.reason.includes('allowedFiles'));
      assert.ok(!bare.reason.includes('Repair the parent materialization/policy'), 'must not fall through to the unfollowable generic remedy');
    }

    // The remedy works: the SAME spawn with the marker publishes the bounded
    // envelope and passes.
    const ok = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    }));
    assert.equal(ok.kind, 'noop', ok.kind === 'deny' ? ok.reason : undefined);
    const runId = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    const envelope = readActiveRunBootstrap(cwd, runId, 'quick-fix');
    assert.equal(envelope?.workUnit.unitId, 'quick-fix:bootstrap');
    assert.deepEqual(envelope?.workUnit.outputs, [
      `.traffic-one/digests/${runId}/quick-fix.md`,
      'src/bounded-fix.ts',
    ]);
  });
});

test('paid maintenance frontend spawn reuses the exact active bounded WorkUnit', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    one.lifecycle = { phase: 'maintenance', source: 'test' };
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    freezeRunPolicy(cwd, 'claude');
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'claude' });
    const policy = readRunModelPolicy(cwd, 'run-test');
    assert.ok(policy);
    const bounded = ensureRunBootstrap(cwd, 'run-test', 'senior-frontend', state, {
      host: 'claude',
      hostAgentType: 'senior-frontend',
      evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: policy.policyId,
      boundedOutputs: ['src/bounded-page.tsx'],
      boundedAllowlist: ['src/bounded-page.tsx'],
    });
    assert.ok(bounded);
    assert.equal(bounded.workUnit.unitId, 'senior-frontend:bounded-maintenance');

    const allowed = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-frontend',
      model: 'opus',
      prompt: 'Implement only the parent-published maintenance WorkUnit.',
    }));
    assert.equal(allowed.kind, 'noop', allowed.kind === 'deny' ? allowed.reason : undefined);
    const after = readActiveRunBootstrap(cwd, 'run-test', 'senior-frontend');
    assert.equal(after?.workUnit.contractHash, bounded.workUnit.contractHash);
    assert.equal(after?.trafficOneRole, bounded.trafficOneRole);
    assert.deepEqual(after?.workUnit.outputs, [
      '.traffic-one/digests/run-test/frontend.md',
      'src/bounded-page.tsx',
    ]);
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

    const ok = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    }));
    assert.equal(ok.kind, 'noop');
    // The allowed spawn staked a pending run claim so the run-team write gate
    // can resolve the worker's role on its first write.
    const runId = (JSON.parse(fs.readFileSync(onePath, 'utf8')).currentRunId as string) || '';
    assert.ok(runId.length > 0, 'currentRunId minted');
    const pendingDir = path.join(cwd, '.traffic-one', 'runs', runId, 'pending');
    assert.deepEqual(fs.readdirSync(pendingDir), ['quick-fix.json'], 'pending quick-fix claim staked');
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
    assert.equal(agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    })).kind, 'noop');
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
    assert.equal(agentModelGate(spawnCtx(cwd, {
      subagent_type: 'quick-fix',
      model: 'haiku',
      prompt: QUICK_FIX_SCOPE_MARKER,
    })).kind, 'noop');
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

test('architect phase gate rejects legacy sibling assignments in a maintenance v2 run', () => {
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

    // A sibling BUILD manifest is not authority for this fresh run.
    fs.mkdirSync(path.join(t1, 'runs', 'run-build'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'runs', 'run-build', 'assignments.json'), JSON.stringify({
      version: 1,
      runId: 'run-build',
      createdBy: 'senior-architect',
      assignments: [{ role: 'senior-frontend', scope: { include: ['apps/web/**'], exclude: [] } }],
    }), 'utf8');
    const stillDenied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(stillDenied.kind, 'deny');
    if (stillDenied.kind === 'deny') assert.match(stillDenied.reason, /Architect phase gate/);
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
    // Burn the verify-gate budget (queued-but-unstarted batch would fire it
    // first) — this test pins the PER-ROLE gate's own contract.
    markVerifyGateDenied(cwd, 'run-X', 'senior-tester');

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

    // Recording the attempt clears only the OpenCode-first gate. The new run
    // still lacks its own architecture contracts, so paid spawn remains denied.
    markOpenCodeRoleAttempted(cwd, minted, 'senior-frontend');
    const missingContracts = agentModelGate(spawnCtx(cwd, {
      subagent_type: 'senior-frontend',
      model: 'opus',
    }));
    assert.equal(missingContracts.kind, 'deny');
    if (missingContracts.kind === 'deny') assert.match(missingContracts.reason, /Architect phase gate/);
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
    markVerifyGateDenied(cwd, 'run-reviewer-reject', 'senior-tester'); // pin the per-role gate alone

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
    markVerifyGateDenied(cwd, 'run-clean', 'senior-tester'); // pin the per-role gate alone

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
    markVerifyGateDenied(cwd, 'run-codex', 'senior-tester'); // pin the per-role gate alone

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
      message: `You are acting as Traffic One quick-fix. Apply one bounded maintenance fix.\n${QUICK_FIX_SCOPE_MARKER}`,
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
        assert.match(result.context, /FIRST line of the spawn message must carry the literal role marker/i);
        assert.match(result.context, /first tool call once the spawn prompt lands in its rollout/i);
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

test('codex followup drift on a CHILD-VERIFIED thread is an accepted continuation that keeps the same agent', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childA = '019f8fa1-1111-7000-8000-00000000000a';
    const transcriptA = path.join(cwd, `rollout-drift-${childA}.jsonl`);
    fs.writeFileSync(transcriptA, `${JSON.stringify(codexSessionMeta(childA, parentThread, '/root/senior_tester'))}\n`, 'utf8');

    // the child's OWN blocking turn verifies its model and claims the role
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra')).kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, childA);

    // A later followup turn runs on the PARENT's model because the host continues
    // that same runtime. Retiring the thread here made every fix cycle spawn a
    // FRESH agent that reloads the whole context (observed 12c/15c/17c/18c:
    // senior_<role>_fix_1/_fix_2 proliferation), so this is now accepted.
    const drift = codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-sol'));
    assert.equal(drift.kind, 'noop', 'the continuation proceeds');
    const observed = readCodexModelObservation(cwd, 'run-test', [childA]);
    assert.equal(observed?.status, 'verified', 'the thread stays verified');
    assert.equal(observed?.actualModel, 'gpt-5.6-terra', 'the child-verified model stays the policy anchor');
    assert.equal(observed?.reason, 'continuation-on-gpt-5.6-sol', 'the accepted drift stays auditable');

    // the same agent keeps the role slot — no replacement, no history churn
    const registryRaw = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'run-test', 'agents.json'), 'utf8',
    )) as { agents: Record<string, { agentId?: string; replaced?: boolean }>; history?: unknown[] };
    assert.equal(registryRaw.agents['senior-tester']?.agentId, childA);
    assert.equal(registryRaw.agents['senior-tester']?.replaced, false, 'the reuse row is NOT marked replaced');
    assert.equal((registryRaw.history || []).length, 0, 'a continuation creates no replacement history');

    // The continuation turn must still RESOLVE its role context, or its writes are
    // denied while the slot stays occupied — a fresh deadlock. The hook model on
    // that turn is the drifted one, which no longer equals the anchor.
    const continuationCtx = resolveRunAgentContext(cwd, readEffectiveState(cwd), {
      hook_event_name: 'PreToolUse', agent_id: childA, session_id: parentThread,
      transcript_path: transcriptA, model: 'gpt-5.6-sol',
    }, { claimPending: false, host: 'codex' });
    assert.equal(continuationCtx?.role, 'senior-tester', 'the drifted continuation turn still owns its role');

    // further turns — on the parent model or back on its own — keep working
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-sol')).kind, 'noop');
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra')).kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, childA);
    });
  });
});

test('codex child running on a policy-forbidden model is STILL denied on its first blocking turn (SubagentStart anchor is not proof)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childA = '019f8fa1-5555-7000-8000-00000000000e';
    const transcriptA = path.join(cwd, `rollout-requested-${childA}.jsonl`);
    fs.writeFileSync(transcriptA, `${JSON.stringify(codexSessionMeta(childA, parentThread, '/root/senior_tester'))}\n`, 'utf8');

    // SubagentStart fires in the SPAWNER's context and reports the model the
    // parent REQUESTED — it can reach `verified` before the child ever runs.
    subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart', agent_id: childA, session_id: parentThread,
      transcript_path: transcriptA, model: 'gpt-5.6-terra',
    }));
    const anchored = readCodexModelObservation(cwd, 'run-test', [childA]);
    assert.equal(anchored?.status, 'verified', 'the requested model verifies at SubagentStart');
    assert.deepEqual([...(anchored?.modelSources || [])], ['SubagentStart']);

    // The child then ACTUALLY runs on a model its role forbids. Accepting that as
    // a "continuation" off the requested anchor would make the child's own first
    // blocking check vacuous, so it must still be terminal.
    const forbidden = codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-sol'));
    assert.equal(forbidden.kind, 'deny', 'the first blocking turn is not vacuous');
    if (forbidden.kind === 'deny') assert.match(forbidden.reason, /hook-model-conflict/);
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childA])?.status, 'conflict');
    });
  });
});

test('a conflict on a VERIFIED codex incumbent still retires it and releases the role slot for one replacement', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childA = '019f8fa1-6666-7000-8000-00000000000f';
    const childB = '019f8fa1-7777-7000-8000-000000000010';
    const transcriptA = path.join(cwd, `rollout-incumbent-${childA}.jsonl`);
    const transcriptB = path.join(cwd, `rollout-incumbent-${childB}.jsonl`);
    fs.writeFileSync(transcriptA, `${JSON.stringify(codexSessionMeta(childA, parentThread, '/root/senior_tester'))}\n`, 'utf8');
    fs.writeFileSync(transcriptB, `${JSON.stringify(codexSessionMeta(childB, parentThread, '/root/senior_tester'))}\n`, 'utf8');

    // childA verifies on its own turn and owns the reuse slot
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra')).kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, childA);

    // A non-model conflict (here: the same thread observed under another role)
    // is still terminal for a verified incumbent — accepting model continuations
    // must not disable the OTHER conflict reasons or the slot release.
    assert.equal(observeCodexChildModel(cwd, 'run-test', {
      childId: childA,
      parentSessionId: parentThread,
      actualModel: 'gpt-5.6-terra',
      role: 'senior-frontend',
      source: 'PreToolUse',
    })?.status, 'conflict');

    const denied = codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra'));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.match(denied.reason, /released for ONE replacement/);
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.replaced, true, 'the incumbent slot is released');

    // a FRESH policy-compliant child takes the released slot
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childB, parentThread, transcriptB, 'gpt-5.6-terra')).kind, 'noop');
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, childB);
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.replaced, false);
    });
  });
});

test('codex model drift BEFORE verification is still terminal and frees the role for one replacement', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childA = '019f8fa1-3333-7000-8000-00000000000c';
    const childB = '019f8fa1-4444-7000-8000-00000000000d';
    const transcriptA = path.join(cwd, `rollout-unverified-${childA}.jsonl`);
    const transcriptB = path.join(cwd, `rollout-unverified-${childB}.jsonl`);
    fs.writeFileSync(transcriptA, `${JSON.stringify(codexSessionMeta(childA, parentThread, '/root/senior_tester'))}\n`, 'utf8');
    fs.writeFileSync(transcriptB, `${JSON.stringify(codexSessionMeta(childB, parentThread, '/root/senior_tester'))}\n`, 'utf8');

    // a model observed before any role is resolvable: pending-role, NOT verified
    assert.equal(observeCodexChildModel(cwd, 'run-test', {
      childId: childA,
      parentSessionId: parentThread,
      actualModel: 'gpt-5.6-sol',
      role: null,
      source: 'SubagentStart',
    })?.status, 'pending-role');

    const drift = codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra'));
    assert.equal(drift.kind, 'deny');
    if (drift.kind === 'deny') {
      assert.match(drift.reason, /hook-model-conflict/);
      assert.match(drift.reason, /retired/i);
      assert.match(drift.reason, /senior_tester_fix_<n>/);
      assert.match(drift.reason, /nested from another senior/i);
    }
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childA])?.status, 'conflict');
    // This child never verified, so it never held the reuse slot — there is no
    // incumbent to release, and the role stays claimable by a compliant child.
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester'], undefined);
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childA, parentThread, transcriptA, 'gpt-5.6-terra')).kind, 'deny',
      'the retired thread stays blocked on every later call');

    // a FRESH policy-compliant child claims the released slot
    assert.equal(codexChildModelGate(codexChildPreToolCtx(cwd, childB, parentThread, transcriptB, 'gpt-5.6-terra')).kind, 'noop');
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childB])?.status, 'verified');
    assert.equal(readRunAgentRegistry(cwd, 'run-test')['senior-tester']?.agentId, childB);
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

// ── The observation store's own "I could not find out" ───────────────────────
//
// observeCodexChildModel returns null for a missing/foreign-host policy AND for
// its own contended lock or refused write, and both gates below used to collapse
// that into a verdict: the SubagentStart text rendered `unavailable (model policy
// missing)` — a GUESS, with the policy sitting readable next to it — and the
// PreToolUse deny rendered the same guess. Both then prescribed replacing the
// child, which is the run-team defect in miniature: a lock another hook holds
// for up to a second answered with "destroy it".

// Hold that store's lock from THIS process. Sibling of
// shared/state/__tests__/owned-lock-fixture.ts, kept here because this store is
// not one of the four run-scoped owned-dir locks; the owner sentinel names this
// pid and is stamped now, so no contender can steal or reclaim the lease.
function holdCodexObservationLock(cwd: string, runId: string): string {
  const lockDir = path.join(cwd, '.traffic-one', 'runs', runId, 'codex-model-observations.json.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  return lockDir;
}

test('codex SubagentStart reports a contended observation store as retryable, not as a child to replace', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childThread = '019f69fe-e335-7de0-be43-1ee45e353611';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${childThread}.jsonl`);
    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(childThread, parentThread, '/root/senior_frontend'))}\n`,
      'utf8',
    );
    const start = (): HookResult => subagentStartBind(subagentStartCtx(cwd, {
      hook_event_name: 'SubagentStart', agent_id: childThread, session_id: parentThread,
      transcript_path: transcript, task_name: 'senior_frontend', model: 'gpt-5.6-sol',
    }));

    const lockDir = holdCodexObservationLock(cwd, 'run-test');
    const held = start();
    assert.equal(held.kind, 'context');
    if (held.kind === 'context') {
      assert.match(held.context, /model-observation store was unavailable/);
      assert.match(held.context, /Do NOT interrupt or replace this child on this message/);
      assert.doesNotMatch(held.context, /model policy missing/,
        'the policy is readable right here, so naming it was a guess at a cause that is not the cause');
    }
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childThread]), null,
      'nothing was recorded, which is what makes this "not found out" rather than a verdict');

    // The same event with the contention gone verifies the child normally. That is
    // what makes the retryable wording TRUE rather than merely gentler.
    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.equal(start().kind, 'noop');
    assert.equal(readCodexModelObservation(cwd, 'run-test', [childThread])?.status, 'verified');
  });
});

test('codex child gate tells a contended observation store from a policy that is really missing', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'codex');
    const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
    const childThread = '019f69fe-e335-7de0-be43-1ee45e353612';
    const transcript = path.join(cwd, `rollout-2026-07-16T11-15-39-${childThread}.jsonl`);
    fs.writeFileSync(
      transcript,
      `${JSON.stringify(codexSessionMeta(childThread, parentThread, '/root/senior_frontend'))}\n`,
      'utf8',
    );
    const call = (): HookResult => codexChildModelGate(
      codexChildPreToolCtx(cwd, childThread, parentThread, transcript, 'gpt-5.6-sol'),
    );

    // The two branches carry two deny ids, and this row asserts both. Telling
    // them apart in the PROSE was only half the repair: `denyId` is what the
    // decision log records for a bug report, `denyTarget` is the same `role` on
    // one branch and the run on the other, and this gate writes no per-branch
    // diagnostic — so while both rendered `codex-child-model-status-unverified`
    // the log could not distinguish a two-second lock from a run whose policy is
    // gone, which is the same collapse one level down from the wording.
    const lockDir = holdCodexObservationLock(cwd, 'run-test');
    const held = call();
    assert.equal(held.kind, 'deny', 'an unverified child still fails closed — only the REMEDY changes');
    if (held.kind === 'deny') {
      assert.equal(held.denyId, 'codex-child-model-observation-persist-failed');
      assert.match(held.reason, /observed-model record could not be written/);
      assert.match(held.reason, /Retry this tool once; if it repeats, replace the child from the parent/);
      assert.doesNotMatch(held.reason, /model policy missing/);
    }

    // Same null from the store, genuinely durable cause: no policy to verify
    // against. Here the parent really must repair the run, and no retry helps.
    fs.rmSync(lockDir, { recursive: true, force: true });
    const policyFile = path.join(cwd, '.traffic-one', 'runs', 'run-test', 'model-policy.json');
    const policy = fs.readFileSync(policyFile, 'utf8');
    fs.rmSync(policyFile);
    const missing = call();
    assert.equal(missing.kind, 'deny');
    if (missing.kind === 'deny') {
      // The same missing/foreign-host run policy the non-Codex branch of this
      // gate refuses, with the same remedy, so it is deliberately the SAME id
      // rather than a third one — and the run, not the role, is what was
      // refused.
      assert.equal(missing.denyId, 'codex-child-model-policy-missing');
      assert.equal(missing.denyTarget, 'run-test');
      assert.match(missing.reason, /immutable model policy for run `run-test` is missing, corrupt/);
      assert.doesNotMatch(missing.reason, /Retry this tool once/,
        'nothing clears on its own here, so the retry must not be offered');
    }
    if (held.kind === 'deny' && missing.kind === 'deny') {
      assert.notEqual(held.denyId, missing.denyId,
        'one id for both is what sent a reader back to string-matching the prose');
    }

    // And with both restored the child verifies, so the transient row above was
    // measuring the lock and not a broken fixture.
    fs.writeFileSync(policyFile, policy, 'utf8');
    assert.equal(call().kind, 'noop');
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

const freezeRunPolicy = freezeRunPolicyFixture;

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

// The same PostToolUse spawn context, but with the RESULT placed wherever the
// host under test actually puts it. `postSpawnCtx` above always writes the
// `tool_response` wrapper, which only three of the seven hosts send.
function postSpawnCtxRawResult(
  cwd: string,
  raw: Record<string, unknown>,
  host: 'claude' | 'cursor' | 'copilot',
  rawName = 'Task',
): Ctx {
  const input: HookInput = {
    event: 'PostToolUse', host, cwd,
    raw: { tool_name: rawName, session_id: 'parent-1', ...raw },
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
        CURSOR_HIGHEST_FAMILY,
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
      assert.equal(durable?.prescribedModel, CURSOR_HIGHEST_SLUG, 'durable result stores the exact original-tier retry slug');
      assert.match(durable?.directive || '', /Retry the same role now/i);
      assert.ok(durable?.directive?.includes(CURSOR_HIGHEST_SLUG), 'prescribes the first captured slug in the role original highest tier');
      assert.ok(!durable?.directive?.includes('claude-sonnet-5'), 'does not drift into Terra\'s owning balanced row');
      assert.match(durable?.directive || '', /gpt-5\.6-terra-medium/i, 'names the exhausted model');

      const wrongRetry = agentModelGate(spawnCtxWithSession(cwd, {
        subagent_type: 'senior-frontend',
        model: 'gpt-5.6-terra-medium',
        prompt: '[t1-role: senior-frontend]\nContinue after the failed child.',
      }, 'parent-1', 'cursor'));
      assert.equal(wrongRetry.kind, 'deny', 'no-marker correlated gate blocks the exhausted model');
      if (wrongRetry.kind === 'deny') assert.ok(wrongRetry.reason.includes(CURSOR_HIGHEST_SLUG));

      const exactRetry = agentModelGate(spawnCtxWithSession(cwd, {
        subagent_type: 'senior-frontend',
        model: CURSOR_HIGHEST_SLUG,
        prompt: '[t1-role: senior-frontend]\nContinue after the failed child.',
      }, 'parent-1', 'cursor'));
      assert.notEqual(exactRetry.kind, 'deny', 'the exact prescribed slug is accepted without a replacement marker');
    } finally {
      if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    }
  });
});

/**
 * The wrapper key is not where a result lives on most hosts. Cursor spreads it
 * across flat top-level fields, and reading only `tool_response`/`toolResponse`/
 * `tool_result`/`toolResult` saw NOTHING there — so a subagent that had already
 * died was re-recorded as live (Cursor prints `Agent ID:` for a stopped run too)
 * and the reuse gate then demanded continuation of a dead agent.
 *
 * Same fixture as the wrapper test above; only the PLACE the result arrives in
 * differs.
 */
test('a dead subagent is retired from a flat payload that names no wrapper key', () => {
  withMaterialized({ teamApproved: true, level: 'high' }, (cwd) => {
    const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    try {
      setCurrentRunId(cwd, 'run-flat-stop');
      freezeRunPolicy(cwd, 'cursor', 'run-flat-stop');
      observeCursorSpawn(
        cwd,
        'run-flat-stop',
        'senior-frontend',
        'gpt-5.6-terra-medium',
        'highest',
        CURSOR_HIGHEST_FAMILY,
        'tool_77777777-7777-4777-8777-777777777777',
      );
      recordRunAgent(cwd, 'run-flat-stop', 'senior-frontend', {
        agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301',
        toolCallId: 'tool_77777777-7777-4777-8777-777777777777',
        parentSessionId: 'parent-1',
      });

      const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
        tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: 'build the UI' },
        // Flat: the status and the text are siblings of the tool name, with no
        // container naming either of them.
        status: 'error',
        output: 'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 — stopped: you have hit your API usage limit.',
        exit_code: 1,
      }, 'cursor'));
      assert.equal(result.kind, 'noop', 'Cursor PostTool persists; parent reconciliation owns delivery');

      const registry = readRunAgentRegistry(cwd, 'run-flat-stop');
      assert.equal(registry['senior-frontend']?.replaced, true, 'the dead agent is retired from a flat result too');
      const durable = listCursorSpawnObservations(cwd, 'run-flat-stop')[0];
      assert.equal(durable?.outcome, 'api-limit', 'the flat result is correlated with the same outcome as a wrapped one');
      assert.match(durable?.directive || '', /Retry the same role now/i);
    } finally {
      if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    }
  });
});

/**
 * Copilot's result key is not established anywhere in this tree, so the shape it
 * arrives in is the one case no key list could have covered. Reading the payload
 * rather than a named wrapper is what keeps a stop signal legible there — the
 * classifier's own evidence rules are unchanged, it is only no longer looking in
 * a field this host never sends.
 */
test('a dead subagent is retired when the result sits in an envelope nothing names (Copilot)', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-copilot-stop');
    freezeRunPolicy(cwd, 'copilot', 'run-copilot-stop');
    recordRunAgent(cwd, 'run-copilot-stop', 'senior-frontend', {
      agentId: 'copilotchild12345',
      resumeId: 'copilotchild12345',
      parentSessionId: 'parent-1',
    });

    const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: { agent_type: 'traffic-one:senior-frontend', model: 'composer-2.5-fast', prompt: 'build the UI' },
      execution_record: { status: 'stopped', text: 'API usage limit reached.' },
    }, 'copilot'));

    assert.equal(result.kind, 'context', 'the orchestrator is told to respawn instead of waiting on a dead agent');
    if (result.kind === 'context') {
      assert.match(result.context, /senior-frontend/);
      assert.match(result.context, /API\/usage limit/i);
    }
    const registry = readRunAgentRegistry(cwd, 'run-copilot-stop');
    assert.equal(registry['senior-frontend']?.replaced, true, 'dead agent retired from the reuse registry');
  });
});

/**
 * P1, in both directions: the structured verdict is read wherever a host wrapped
 * it, and only there.
 *
 * `toolResultPayload` unwraps the four WRAPPER spellings and never a container,
 * so a result reporting `status:'error'` while naming no incident vocabulary was
 * legible under `tool_response` and INVISIBLE under every other envelope — the
 * classifier answered null, `recordSpawnedAgent` fell through to the id branch,
 * and the dead child was written back as this run's live reusable agent. The
 * end-to-end row below is that defect; this row is the classification underneath
 * it, over every envelope the tree either names as a container or constructs as
 * a guess.
 *
 * Constructed directly rather than through an adapter, deliberately: the question
 * is the envelope's NAME, and no host lift is involved in answering it. Two of the
 * five (`output`, `tool_info`) are containers this tree names from host
 * documentation and installed wrappers rather than from a guess, which is what
 * makes this independent of the Copilot guess. It is NOT a claim of observed
 * shapes: no recorded tool-result payload exists in this tree for any of the seven
 * hosts, so every payload here is constructed.
 *
 * The bound is pinned with it. One level, because an envelope is a container and
 * not a tree: a verdict two levels down belongs to some nested child.
 *
 * And WHAT is read at each depth is pinned beside WHERE, because widening the
 * where without narrowing the what introduced a new false positive in the
 * live-agent-retiring direction. The `metadata`/`results`/`child_reports` rows
 * below are that defect: a flat "every record child is a verdict source" list read
 * a nested `error` as THIS tool call's failure, and made the answer depend on which
 * child the host serialized first.
 */
test('the structured verdict is read one level into an envelope, and no further', () => {
  const ENVELOPES = ['tool_response', 'execution_record', 'tool_output', 'output', 'tool_info'];
  const LIMIT = 'you have hit your API usage limit';
  const rows: { label: string; response: unknown; strict: boolean; expected: string | null }[] = [
    // The flat payload has no envelope at all: the verdict is the payload's own
    // top level, and a reader that only looked one level DOWN would lose it.
    { label: 'flat payload: status error', response: { status: 'error', output: 'the child crashed.' }, strict: true, expected: 'stopped' },
    { label: 'flat payload: status completed beside limit prose', response: { status: 'completed', output: LIMIT }, strict: false, expected: null },
    // Success is decided before failure WITHIN a source, and the payload's own
    // verdict is decided before any envelope's. Both orders are the behaviour
    // that shipped; neither is incidental.
    { label: 'flat payload: a success status outranks a non-empty error beside it', response: { status: 'completed', error: 'a handled glitch' }, strict: false, expected: null },
    { label: 'the payload own verdict outranks an envelope it carries', response: { status: 'completed', execution_record: { status: 'error' } }, strict: false, expected: null },
    // A nested child's `error` is that CHILD'S. Read as the tool's own it retires
    // a live agent over a warning, a partial result, or a grandchild's death —
    // measured, all three of these classified `stopped` under the flat list.
    { label: 'a nested metadata warning is not this tool call failing', response: { metadata: { error: 'a deprecation warning' }, execution_record: { status: 'completed' } }, strict: true, expected: null },
    { label: 'the same payload with the envelope FIRST in key order', response: { execution_record: { status: 'completed' }, metadata: { error: 'a deprecation warning' } }, strict: true, expected: null },
    { label: 'a nested partial result is not this tool call failing', response: { results: { error: '1 file skipped' } }, strict: true, expected: null },
    { label: 'a sub-sub agent death is not this tool call failing', response: { child_reports: { error: 'the sub-sub agent died' } }, strict: true, expected: null },
    // At the result's OWN top level a bare `error` IS the tool reporting failure,
    // which is the asymmetry the depth split exists to express.
    { label: 'a bare error at the payload own top level is a failure', response: { error: 'the child crashed.' }, strict: true, expected: 'stopped' },
    // Two envelopes DISAGREEING is the only shape that can pin how children are
    // resolved, and the flat list resolved it by serialization order: whichever
    // child the host happened to write first decided whether a run kept its agent.
    // Success outranks failure, in both key orders, because the wrong direction
    // here retires a live agent.
    {
      label: 'two envelopes disagree: success outranks failure',
      response: { results: { status: 'completed' }, execution_record: { status: 'failed' } },
      strict: true,
      expected: null,
    },
    {
      label: 'the same disagreement in the other key order',
      response: { execution_record: { status: 'failed' }, results: { status: 'completed' } },
      strict: true,
      expected: null,
    },
  ];
  for (const envelope of ENVELOPES) {
    rows.push(
      {
        label: `${envelope}: a status-only failure, no incident vocabulary anywhere`,
        response: { [envelope]: { status: 'error', text: 'the child crashed.' } },
        strict: true,
        expected: 'stopped',
      },
      {
        label: `${envelope}: the same failure naming a limit in the RESULT`,
        response: { [envelope]: { status: 'error', text: LIMIT } },
        strict: true,
        expected: 'api-limit',
      },
      {
        label: `${envelope}: an explicit success envelope still wins over limit prose inside the report`,
        response: { [envelope]: { status: 'completed', text: `Report: ${LIMIT} was handled.` } },
        strict: false,
        expected: null,
      },
      {
        label: `${envelope}: is_error rather than a word status`,
        response: { [envelope]: { is_error: true, text: 'the child crashed.' } },
        strict: true,
        expected: 'stopped',
      },
      {
        label: `${envelope}: a verdict TWO levels down is some nested child's, not the tool's`,
        response: { [envelope]: { child: { status: 'error' } } },
        strict: true,
        expected: null,
      },
      {
        label: `${envelope}: a success status inside it outranks a non-empty error beside it`,
        response: { [envelope]: { status: 'completed', error: 'a handled glitch' } },
        strict: false,
        expected: null,
      },
      // What refusing a nested bare `error` costs, stated where it is paid: an
      // envelope whose ONLY signal is an `error` field no longer counts as a
      // structured failure. On the hosts that send envelopes the text fallback
      // still reads it, so a real incident is still classified; under Cursor's
      // structured-failure requirement it is not — and Cursor sends no envelope.
      {
        label: `${envelope}: a bare error inside it is still read as TEXT`,
        response: { [envelope]: { error: 'you have hit your API usage limit' } },
        strict: false,
        expected: 'api-limit',
      },
      {
        label: `${envelope}: but a bare error inside it is not a STRUCTURED failure`,
        response: { [envelope]: { error: 'the child crashed.' } },
        strict: true,
        expected: null,
      },
    );
  }
  // Key order is not evidence. The same logical payload serialized with its
  // children in different orders must classify identically — measured, the flat
  // every-record-child list answered `failure` or `success` depending only on
  // which child the host happened to put first.
  const children: [string, unknown][] = [
    ['metadata', { error: 'a deprecation warning' }],
    ['execution_record', { status: 'completed' }],
    ['child_reports', { error: 'the sub-sub agent died' }],
  ];
  const byOrder = new Set([[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0]].map((order) => String(
    classifySubagentStop(Object.fromEntries(order.map((index) => children[index]!)), true),
  )));
  assert.deepEqual([...byOrder], ['null'], 'the verdict changed with the order the host serialized its children in');
  const misread = rows
    .filter((row) => classifySubagentStop(row.response, row.strict) !== row.expected)
    .map((row) => `${row.label} → ${String(classifySubagentStop(row.response, row.strict))}`);
  assert.deepEqual(misread, [], 'these envelopes were classified wrongly');
});

/**
 * A SUCCESS MARKER IS A SUCCESS IN EVERY SPELLING THIS READER READS — and the set
 * it reads is now bounded by evidence rather than by symmetry.
 *
 * `status` and `state` are read as the same field, so a child reporting SUCCESS in
 * either cannot fall through to the bare-error arm and then to the text — and a
 * successful report that MENTIONS an incident ("I backed off after an API usage
 * limit and finished the settings screen") is the ordinary way an agent describes
 * having handled one. Both directions are driven, because a spelling read for
 * success must be read for failure too or the gap simply moves.
 *
 * `resultType`/`result_type` WERE in that set for one round and are not any more.
 * Measured: the two spellings appear nowhere in this tree but their own reader and
 * this test, and nowhere in the host wrappers installed on the machine either, so
 * the arm decided 8 rows in the whole suite — all of them its own — and closed a
 * case that previously classified. A row built from a guess is held to the same
 * standard as the constructed Copilot shapes, so it is gone, and the COST of
 * declining it is pinned below rather than argued: in that spelling a success
 * marker is unread, and a non-empty `error` beside it reads as this tool call
 * failing. Those two rows are what redden the day a real payload grounds the key,
 * which is the day to put the arm back.
 *
 * What none of this rests on is a claim about which spelling a given host really
 * sends: no recorded tool-result payload exists in this tree for any host (see the
 * disclosure in shared/tool-result.ts).
 */
test('a success marker is read as success in every spelling of the same field', () => {
  const HANDLED = 'I backed off after an API usage limit and finished the settings screen';
  const rows: { label: string; response: unknown; strict: boolean; expected: string | null }[] = [
    // The declined spelling, in both directions, priced as a cost rather than
    // asserted as safety.
    {
      label: 'COST result_type: an ungrounded success spelling is not read as success',
      response: { result_type: 'success', error: HANDLED },
      strict: false,
      expected: 'api-limit',
    },
    {
      label: 'COST resultType: nor is it read as a failure when it names one',
      response: { resultType: 'failed', text: 'the child crashed.' },
      strict: true,
      expected: null,
    },
  ];
  for (const key of ['status', 'state']) {
    rows.push(
      {
        label: `${key}: success at the payload own level, a limit quoted in the report`,
        response: { [key]: 'success', error: HANDLED },
        strict: false,
        expected: null,
      },
      {
        label: `${key}: success one record in, a limit quoted in the report`,
        response: { execution_record: { [key]: 'success', error: HANDLED } },
        strict: false,
        expected: null,
      },
      {
        label: `${key}: a failure word in the same field is still a failure`,
        response: { [key]: 'failed', text: 'the child crashed.' },
        strict: true,
        expected: 'stopped',
      },
    );
  }
  const misread = rows
    .filter((row) => (classifySubagentStop(row.response, row.strict) ?? null) !== row.expected)
    .map((row) => `${row.label} → ${String(classifySubagentStop(row.response, row.strict))}`);
  assert.deepEqual(misread, [], 'a spelling of the outcome field was read differently from its synonyms');
});

/**
 * The same defect end to end, on the host it lands on. Byte-identical payloads,
 * one under the wrapper spelling and one under an envelope nothing names: before
 * the fix the first retired the dead agent and told the orchestrator to respawn,
 * while the second recorded the corpse as the run's LIVE `senior-frontend` and
 * returned noop — the hook doing nothing at all where it exists to intervene.
 */
test('an envelope nothing names retires the dead subagent, exactly as the wrapper spelling does', () => {
  for (const envelope of ['tool_response', 'execution_record', 'tool_output', 'output', 'tool_info']) {
    withMaterialized({ teamApproved: true }, (cwd) => {
      setCurrentRunId(cwd, 'run-envelope-stop');
      freezeRunPolicy(cwd, 'copilot', 'run-envelope-stop');
      recordRunAgent(cwd, 'run-envelope-stop', 'senior-frontend', {
        agentId: 'copilotchild12345', resumeId: 'copilotchild12345', parentSessionId: 'parent-1',
      });

      const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
        tool_input: { agent_type: 'traffic-one:senior-frontend', model: 'composer-2.5-fast', prompt: 'build the UI' },
        // A stopped child that still reports its id — which is precisely why the
        // id branch was reached and the corpse re-registered.
        [envelope]: { status: 'error', agent_id: 'senior-frontend' },
      }, 'copilot', 'task'));

      assert.equal(result.kind, 'context', `${envelope}: the orchestrator is told to respawn`);
      const row = readRunAgentRegistry(cwd, 'run-envelope-stop')['senior-frontend'];
      assert.equal(row?.replaced, true, `${envelope}: the dead agent is retired from the reuse registry`);
      assert.equal(row?.agentId, 'copilotchild12345', `${envelope}: and the failed result never overwrites it with a live row`);
    });
  }
});

/**
 * A LIST IS A POSITION A RESULT REALLY ARRIVES IN, driven to the two pieces of
 * disk state the classification decides — the run agent REGISTRY and the run's
 * EXHAUSTION LEDGER — because that is where the cost of getting it wrong is paid
 * and a unit answer cannot show either.
 *
 * `content[]` is Claude's own result shape and `steps[]` is one of Copilot's, and
 * for as long as `toolResultVerdictSources` refused an array no member of either
 * was a verdict source. Measured on this fixture before the list rule:
 * `{ content: [{ status: 'error', message: '…API usage limit' }] }` returned noop,
 * the dead child stayed registered as this run's LIVE `senior-frontend`, and the
 * ledger stayed empty — while the byte-identical payload spelling the limit
 * `text` retired the agent and condemned its model. A bare top-level list did the
 * same. That asymmetry was never a second defect: `text` is not a brief spelling
 * and the value walk has always recursed lists, so the two observations are one
 * rule seen from the structure side and from the text side.
 *
 * THE CONTROLS ARE THE POINT OF THE ROW, not decoration. The list rule is a
 * widening, and the widening it must not become is the one that let an echoed
 * spawn brief retire a LIVE agent: a member of an own-level list is a NESTED
 * source, which is exactly the depth at which a bare `error` is refused, so a
 * first-spawn brief inside a step list is still not evidence and a
 * `[t1-replace-agent]` brief is still barred by the marker from every position.
 * Each of those is driven here to the same two files.
 */
test('a limit inside a list retires the dead child and condemns its model, and a brief in one still cannot', () => {
  const LIMIT = 'you have hit your API usage limit';
  const ROWS: {
    label: string;
    result: Record<string, unknown>;
    retired: boolean;
    condemned: boolean;
  }[] = [
    {
      label: 'Claude own result shape: content[] reporting a failure and the limit under `message`',
      result: { content: [{ status: 'error', message: LIMIT }] },
      retired: true,
      condemned: true,
    },
    {
      label: 'the same limit one key over, which always worked and must keep working',
      result: { content: [{ status: 'error', text: LIMIT }] },
      retired: true,
      condemned: true,
    },
    {
      label: 'a bare top-level list, the degenerate position of the same class',
      result: { tool_response: [{ status: 'error', message: LIMIT }] },
      retired: true,
      condemned: true,
    },
    {
      label: "Copilot's step list at the payload top level",
      result: { steps: [{ is_error: true, message: LIMIT }] },
      retired: true,
      condemned: true,
    },
    // CONTROL — the fail-open direction, priced end to end. A bare `error` is
    // refused at a nested source, so nothing in this payload is a verdict and an
    // ordinary first-spawn product brief beside it is not evidence.
    {
      label: 'CONTROL a first-spawn brief inside a list whose only signal is a bare error',
      result: { content: [{ error: 'a deprecation warning', message: FIRST_SPAWN_BRIEF }], execution_record: { status: 'running' } },
      retired: false,
      condemned: false,
    },
    {
      label: 'CONTROL a first-spawn brief inside execution_record.steps[], below the sources',
      result: { execution_record: { status: 'running', steps: [{ status: 'error', message: FIRST_SPAWN_BRIEF }] } },
      retired: false,
      condemned: false,
    },
    {
      label: 'CONTROL a first-spawn brief in a top-level step list with no verdict of its own',
      result: { steps: [{ message: FIRST_SPAWN_BRIEF }], execution_record: { status: 'running' } },
      retired: false,
      condemned: false,
    },
    // CONTROL — the replacement brief the product itself prescribes, which quotes
    // the previous incident by design. The marker keeps it out even where it is
    // co-located with a real failure: the child is retired by the RESULT saying
    // error, and no model is condemned by the brief.
    {
      label: 'CONTROL a [t1-replace-agent] brief inside a failing list member condemns nothing',
      result: { content: [{ status: 'error', message: REPLACEMENT_BRIEF }] },
      retired: true,
      condemned: false,
    },
    {
      label: 'CONTROL the same replacement brief in a bare top-level list',
      result: { tool_response: [{ status: 'error', message: REPLACEMENT_BRIEF }] },
      retired: true,
      condemned: false,
    },
  ];

  const wrong: string[] = [];
  for (const row of ROWS) {
    withMaterialized({ teamApproved: true }, (cwd) => {
      const runId = 'run-list-stop';
      setCurrentRunId(cwd, runId);
      freezeRunPolicy(cwd, 'copilot', runId);
      recordRunAgent(cwd, runId, 'senior-frontend', {
        agentId: 'copilotchild12345', resumeId: 'copilotchild12345', parentSessionId: 'parent-1',
      });
      recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
        tool_input: { agent_type: 'traffic-one:senior-frontend', model: 'composer-2.5-fast', prompt: 'build the UI' },
        ...row.result,
      }, 'copilot', 'task'));
      const registered = readRunAgentRegistry(cwd, runId)['senior-frontend'];
      const retired = registered?.replaced === true;
      const condemned = exhaustedModelsForRole(cwd, runId, 'senior-frontend').includes('composer-2.5-fast');
      if (retired !== row.retired) wrong.push(`${row.label}: registry retired=${retired}, wanted ${row.retired}`);
      if (condemned !== row.condemned) wrong.push(`${row.label}: ledger condemned=${condemned}, wanted ${row.condemned}`);
      assert.equal(registered?.agentId, 'copilotchild12345', `${row.label}: the result must never overwrite the row with a live one`);
    });
  }
  assert.deepEqual(wrong, [], 'a list position wrote the wrong registry or ledger state');
});

/**
 * THE DISCRIMINATOR'S WIRING, PINNED IN BOTH DIRECTIONS. A peer counted 23 calls in
 * this suite that pass no spawn input and read that as the discriminator being
 * "unwired by omission" at the public API. Optionality is real — those rows ask what
 * a RESULT alone supports, which is the question everywhere except the recorder — and
 * the answer chosen here is to pin the WIRING behaviourally rather than to require
 * the parameter and spell `undefined` at ~30 unit rows. `record-agent.ts` records
 * that decision and its residual.
 *
 * The negative direction was already covered: the `echoed from the spawn input` cell
 * of the crash-brief row below fails if the recorder stops passing its tool input
 * (measured: deleting that argument at the call site reds this row and that one, and
 * nothing else). What was missing is the POSITIVE control, which is what makes the
 * suppression evidence about a discriminator rather than about a deaf classifier: an
 * echo-suppressed row proves nothing on its own if the same result condemns nothing
 * either. This row drives both halves of one payload — same result, two spawn briefs
 * — to the run's exhaustion LEDGER, so an echo that suppresses everything and an echo
 * that suppresses nothing are each red.
 */
test('the recorder hands the classifier the spawn input, so an echoed brief condemns no model', () => {
  const rows: { label: string; prompt: string; condemned: boolean }[] = [
    {
      label: 'the host echoes this spawn own brief beside a real failure',
      prompt: FIRST_SPAWN_BRIEF,
      condemned: false,
    },
    {
      // The CONTROL, and what makes the row above evidence about the wiring
      // rather than about the classifier being deaf: the same result beside a
      // spawn that never mentioned a limit still condemns the model.
      label: 'CONTROL the same result, a spawn brief that names no limit',
      prompt: 'Build the billing screen.',
      condemned: true,
    },
  ];
  const wrong: string[] = [];
  for (const row of rows) {
    withMaterialized({ teamApproved: true }, (cwd) => {
      const runId = 'run-echo-wiring';
      setCurrentRunId(cwd, runId);
      freezeRunPolicy(cwd, 'copilot', runId);
      recordRunAgent(cwd, runId, 'senior-frontend', {
        agentId: 'copilotchild12345', resumeId: 'copilotchild12345', parentSessionId: 'parent-1',
      });
      recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
        tool_input: { agent_type: 'traffic-one:senior-frontend', model: 'composer-2.5-fast', prompt: row.prompt },
        status: 'error',
        message: FIRST_SPAWN_BRIEF,
        exit_code: 1,
      }, 'copilot', 'task'));
      const registered = readRunAgentRegistry(cwd, runId)['senior-frontend'];
      const condemned = exhaustedModelsForRole(cwd, runId, 'senior-frontend').includes('composer-2.5-fast');
      // Retired either way: the result reports a failure of its own, and the echo
      // decides the KIND, never whether the child is dead.
      if (registered?.replaced !== true) wrong.push(`${row.label}: the failed child was not retired`);
      if (condemned !== row.condemned) wrong.push(`${row.label}: ledger condemned=${condemned}, wanted ${row.condemned}`);
    });
  }
  assert.deepEqual(wrong, [], 'the recorder stopped handing the classifier its spawn input');
});

/**
 * A spawn prompt is not a result. Reading the payload rather than a named wrapper
 * is what made a stop signal legible on the hosts that name none — and it also put
 * the SPAWN PROMPT into the text being classified, because the payload carries
 * both. Measured on each host's real adapter, a live Copilot agent whose prompt
 * merely mentioned an API limit read as dead, and a genuinely crashed Cursor child
 * whose prompt mentioned one was upgraded from `stopped` to `api-limit` — which
 * condemns a model that never hit a limit.
 *
 * Built through `selectAdapter(host).parse` deliberately: Copilot's adapter parses
 * `tool_args` (a JSON STRING on the CLI) and lifts it into `tool_input`, so a
 * hand-written record would not be the payload the hook actually receives.
 */
function rawFromHost(
  host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'kilo' | 'windsurf',
  argv: readonly string[],
  stdin: Record<string, unknown>,
): unknown {
  return selectAdapter(host).parse({ argv, stdin: JSON.stringify(stdin) }).raw;
}

const LIMIT_IN_PROMPT = 'Build billing. If the provider returns an API usage limit error, show a retry banner.';

/**
 * THE TWO POSITIONS, driven for every row rather than for whichever one the last
 * reader happened to discover.
 *
 * This is the harness half of a defect that was not a missing row. The corpus
 * already carried "a spawn prompt that names an API limit does not make a live
 * agent dead", in this exact text — but only NESTED under the host's input key.
 * The TOP-LEVEL position was discovered while fixing the id extractor and never
 * carried back to the classifier row that already existed for the other position,
 * so an ordinary first-spawn product brief at the top level went on retiring live
 * agents through a corpus that looked complete. Patching that one row would have
 * been the denylist move; this crosses the axis instead, so a THIRD position (or a
 * fifth brief spelling) discovered by one reader cannot leave the other's corpus
 * behind.
 *
 * `tool_args` is a JSON STRING on the Copilot CLI and the adapter lifts it into
 * `tool_input`, so the nested position must be built through the adapter to be the
 * payload a hook really sees.
 */
/**
 * THE THIRD POSITION, added for exactly the reason the axis exists and after it
 * failed at that job. Two positions were enumerated because two were the ones a
 * reader had discovered; a peer review found a third by reading the WALKS instead
 * of the corpus, and every payload it built leaked at the unit level while the
 * same payloads at these two positions were clean. The three narrowing walks
 * recursed through `obj()`, which refuses an array, so a brief-named key reached
 * through an array was excluded by nothing — while `briefSubtree` and
 * `toolResultText`'s `collect`, the inner halves of the same two mechanisms, have
 * always mapped into arrays. The corpus could not see it: the brief SHAPES put an
 * array under the key (the brief's own value) and never above it.
 */
type BriefPosition = 'nested under the input key' | 'at the payload top level' | 'behind an array';
const BRIEF_POSITIONS: readonly BriefPosition[] = ['nested under the input key', 'at the payload top level', 'behind an array'];

/**
 * The second axis, for the same reason as the first: a brief is not always a
 * string. The id extractor learned that the hard way — its exclusion fired on
 * `typeof child === 'string'` and every structured respelling walked around it —
 * and the classifier's exclusion is a different function with the same shape of
 * hole. So every classifier row is driven in each spelling a host uses for a
 * text field, not only the flat one.
 */
type BriefShape = { label: string; spell: (brief: string) => unknown };
const BRIEF_SHAPES: readonly BriefShape[] = [
  { label: 'a string', spell: (brief) => brief },
  { label: 'an object with .text', spell: (brief) => ({ text: brief }) },
  { label: 'an array of strings', spell: (brief) => [brief] },
  { label: 'content blocks', spell: (brief) => [{ type: 'text', text: brief }] },
  { label: 'nested one deeper', spell: (brief) => ({ content: [{ text: brief }] }) },
];

function briefAt(
  host: 'copilot' | 'cursor',
  position: BriefPosition,
  key: string,
  brief: unknown,
  result: Record<string, unknown>,
): unknown {
  const nested = position === 'nested under the input key';
  // `steps[]` rather than a bare `[{…}]` because the array must sit ABOVE the
  // brief key inside the result, which is the position no exclusion reached:
  // Cursor's adapter passes `raw: data` through verbatim and `content[]` is the
  // one array shape this tree documents arriving there.
  const echoed = position === 'at the payload top level' ? { [key]: brief }
    : position === 'behind an array' ? { steps: [{ [key]: brief }] }
      : {};
  if (host === 'copilot') {
    return rawFromHost('copilot', ['after-tool-use'], {
      hook_event_name: 'PostToolUse',
      tool_name: 'task',
      tool_args: JSON.stringify({
        agent_type: 'traffic-one:senior-frontend',
        mode: 'background',
        ...(nested ? { [key]: brief } : {}),
      }),
      ...echoed,
      ...result,
    });
  }
  return rawFromHost('cursor', ['after-tool-use'], {
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'senior-frontend',
      model: 'gpt-5.6-terra-medium',
      ...(nested ? { [key]: brief } : {}),
    },
    ...echoed,
    ...result,
  });
}

const CRASHED_NO_LIMIT = {
  status: 'error',
  output: 'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 — the child crashed.',
  exit_code: 1,
};
const REPLACEMENT_BRIEF = `${REPLACE_AGENT_MARKER}\nThe previous senior-frontend hit an API usage limit. Continue its work.`;
const FIRST_SPAWN_BRIEF = 'Build the billing screen. If the provider returns an API usage limit error, show a retry banner and back off.';

/**
 * A spawn brief is not a result, at EITHER position.
 *
 * Reading the payload rather than a named wrapper is what made a stop signal
 * legible on the hosts that name none — and it also put the spawn BRIEF into the
 * text being classified, because the payload carries both. Measured end to end on
 * materialized fixtures before this round:
 *
 *   - Copilot, first-spawn product brief, NO marker, the result explicitly
 *     reporting `execution_record: { status: 'running' }` → `api-limit`. The LIVE
 *     subagent was retired from the run registry, the orchestrator was told to
 *     respawn while the real child kept burning tokens, and `composer-2.5-fast`
 *     went into the run's exhaustion ledger having never hit a limit. Four of the
 *     five spellings fired; only `prompt` was already covered, by name, in
 *     `TOOL_INPUT_KEYS`;
 *   - Cursor, the same brief, into the DURABLE observation ledger: two runs
 *     byte-identical but for the brief's position classified `generic` nested and
 *     `api-limit` at the top level, condemning `gpt-5.6-terra-medium`.
 *
 * The RESIDUAL is a row here rather than a paragraph elsewhere, and it is one
 * spelling at one position in one SHAPE: a marker-free flat-string brief under
 * `message` at a FLAT host's top level, where the result ALREADY reports a
 * decisive failure, is still read as evidence. `{ status: 'error', message: '<brief naming a limit>' }` is
 * byte-identical to the failure envelope every host spells that way once the
 * wrapper is off. Bounded: a decisive failure is required, so no LIVE agent can be
 * retired by a brief any more — what it still costs is `stopped` upgraded to
 * `api-limit`, which condemns the dead agent's model. If a later round closes it,
 * this row reddens; that is a FIX, and the expectation moves to 'stopped'.
 *
 * AND ITS PREMISE IS NARROWER THAN THIS FIXTURE, which is worth stating exactly,
 * because the fixture is what a future reader will take the residual to be. These
 * payloads put the brief at the top level and NOT in the tool input, isolating the
 * position — but the reason a brief is at the top level at all is that the host
 * ECHOED it, and an echo has an original in the same payload. Where it does, the
 * recorder now separates the two (`classifySubagentStop`'s third argument, pinned
 * in its own row below), and this cell classifies `stopped`. What survives here is
 * the shape with no second copy anywhere: reachable only if a host invents brief
 * prose the spawn never sent.
 *
 * The bound is now a PROPERTY rather than a hope, and it did not hold when it was
 * first written: brief prose survives only in a record whose verdict
 * `structuredOutcome` itself reads, so a surviving brief only ever reaches the
 * text classifier on a payload whose structured outcome is `failure`. The row
 * below asserts that directly, over every position and shape.
 */
test('a spawn brief that names an API limit does not make a live agent dead, at either position', () => {
  const rows: {
    label: string;
    host: 'copilot' | 'cursor';
    brief: string;
    result: Record<string, unknown>;
    strict: boolean;
    expected: string | null;
    /** The one measured exception, at the one position it applies to. */
    residual?: { key: string; position: BriefPosition; expected: string };
  }[] = [
    {
      label: 'copilot: a first-spawn brief naming a limit, result says running',
      host: 'copilot', brief: FIRST_SPAWN_BRIEF, strict: false, expected: null,
      result: { execution_record: { status: 'running', text: 'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 — shipped the settings page.' } },
    },
    {
      label: 'copilot: a replacement brief quoting the previous limit, result says running',
      host: 'copilot', brief: REPLACEMENT_BRIEF, strict: false, expected: null,
      result: { execution_record: { status: 'running', text: 'The background task started.' } },
    },
    {
      // Cursor's structured-failure requirement decides WHETHER to classify, never
      // WHAT the text is: once the result is genuinely failed, the brief was still
      // deciding the kind — and the kind is what rotates models.
      label: 'cursor: a first-spawn brief naming a limit, a real crash naming none',
      host: 'cursor', brief: FIRST_SPAWN_BRIEF, strict: true, expected: 'stopped',
      result: CRASHED_NO_LIMIT,
      residual: { key: 'message', position: 'at the payload top level', expected: 'api-limit' },
    },
    {
      label: 'cursor: a replacement brief quoting the previous limit, a real crash naming none',
      host: 'cursor', brief: REPLACEMENT_BRIEF, strict: true, expected: 'stopped',
      result: CRASHED_NO_LIMIT,
    },
    // The CONTROLS: this narrows where the classifier looks, not what counts as
    // evidence. A limit in the RESULT still fires at both positions.
    {
      label: 'cursor CONTROL: the limit is in the result, not the brief',
      host: 'cursor', brief: FIRST_SPAWN_BRIEF, strict: true, expected: 'api-limit',
      result: { status: 'error', output: 'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 — you have hit your API usage limit.', exit_code: 1 },
    },
    {
      label: 'copilot CONTROL: the limit is in the envelope, not the brief',
      host: 'copilot', brief: FIRST_SPAWN_BRIEF, strict: false, expected: 'api-limit',
      result: { execution_record: { status: 'stopped', text: 'you have hit your API usage limit.' } },
    },
  ];

  const misread: string[] = [];
  const positionDisagreement: string[] = [];
  for (const row of rows) {
    for (const key of SPAWN_BRIEF_KEYS) {
      for (const shape of BRIEF_SHAPES) {
        // The residual is a STRING-only cost: a structured brief keeps no string
        // leaf at all, so the one spelling that still reads as evidence cannot be
        // reached through any of the other four.
        const residual = shape.label === 'a string' && row.residual?.key === key ? row.residual : undefined;
        const answers = new Map<BriefPosition, string | null>();
        for (const position of BRIEF_POSITIONS) {
          const brief = shape.spell(row.brief);
          const got = classifySubagentStop(briefAt(row.host, position, key, brief, row.result), row.strict) ?? null;
          answers.set(position, got);
          const expected = residual?.position === position ? residual.expected : row.expected;
          if (got !== expected) {
            misread.push(`${row.label} [${key} as ${shape.label}, ${position}] → ${String(got)}, wanted ${String(expected)}`);
          }
        }
        // The axis crossing itself: unless a residual is DECLARED for this cell,
        // EVERY position must agree — not just the two a past reader happened to
        // know about. A position discovered by one reader reddens here even if
        // every aimed row above still passes.
        const distinct = new Set([...answers.values()].map((answer) => String(answer)));
        if (!residual && distinct.size > 1) {
          const spread = BRIEF_POSITIONS.map((position) => `${position} ${String(answers.get(position))}`).join(', ');
          positionDisagreement.push(`${row.label} [${key} as ${shape.label}] → ${spread}`);
        }
      }
    }
  }
  assert.deepEqual(misread, [], 'a brief was read as the result, or a result was no longer read');
  assert.deepEqual(positionDisagreement, [], 'the same brief classified differently depending only on where it sat');
});

/**
 * THE INVARIANT, asserted as one, rather than argued in a paragraph beside the
 * rows that happen to demonstrate it.
 *
 * "A decisive failure is required, so no LIVE agent can be retired by a brief"
 * was recorded as an invariant while being false in two ways at once, both found
 * by a peer driving the real recorder. The classifier's brief exclusion admitted
 * a bare nested `error` as decisive at EVERY depth, while `structuredOutcome` one
 * function down refuses one at every depth but the payload's own — so
 * `{ metadata: { error: 'a deprecation warning', message: '<a first-spawn
 * brief>' }, execution_record: { status: 'running' } }` retired a live Copilot
 * agent and condemned `composer-2.5-fast`, with nothing failed anywhere. And no
 * exclusion reached through an array, so the same brief inside `steps[]` did the
 * same thing from a second position.
 *
 * The property that makes the sentence true is structural: brief prose survives
 * only in a record whose verdict `structuredOutcome` reads — the payload's own
 * top level, or one record in — so a brief can only ever be read on a payload
 * that already classifies as a structured failure. This drives the observable
 * form of that: where the result reports no failure of its own, NO brief, in any
 * spelling, shape or position, may produce a classification at all.
 *
 * Copilot, so `requireStructuredFailure` is false and the text fallback really
 * does run — on Cursor the strict gate would answer null without consulting the
 * text, which would make this row pass for the wrong reason.
 */
test('a brief cannot retire an agent the result never reported dead, at any position', () => {
  const LIVE_RESULTS: { label: string; result: Record<string, unknown> }[] = [
    { label: 'the child is explicitly running', result: { execution_record: { status: 'running' } } },
    { label: 'the child completed', result: { execution_record: { status: 'completed', text: 'shipped the settings page.' } } },
    { label: 'the result reports nothing at all', result: { output: 'The subagent started.' } },
    // The three the depth mirror closed: a nested BARE error is some child's, and
    // `structuredOutcome` has always refused it. Now both halves agree.
    { label: 'a nested deprecation warning beside a running child', result: { metadata: { error: 'a deprecation warning' }, execution_record: { status: 'running' } } },
    { label: 'a nested partial result', result: { results: { error: '1 file skipped' } } },
    { label: 'a sub-sub agent death', result: { child_reports: { error: 'the sub-sub agent died' } } },
    // Below the verdict sources: a failure two levels down is not this tool's, so
    // a brief co-located with it is not evidence either.
    { label: 'a failure two levels down', result: { output: { metadata: { status: 'error' } } } },
  ];
  const retired: string[] = [];
  for (const context of LIVE_RESULTS) {
    for (const key of SPAWN_BRIEF_KEYS) {
      for (const shape of BRIEF_SHAPES) {
        for (const position of BRIEF_POSITIONS) {
          const payload = briefAt('copilot', position, key, shape.spell(FIRST_SPAWN_BRIEF), context.result);
          const got = classifySubagentStop(payload, false);
          if (got !== null) retired.push(`${context.label} [${key} as ${shape.label}, ${position}] → ${String(got)}`);
        }
      }
    }
  }
  assert.deepEqual(retired, [], 'a spawn brief classified a failure on a payload that reported none');
});

/**
 * The depth mirror, at the unit, and what it COSTS — priced here rather than
 * asserted as free.
 *
 * The classifier reads a verdict at two positions and admits different evidence
 * at each: a bare `error` is the tool reporting failure at its OWN top level and
 * is some child's one level in. The brief exclusion is the same classifier's
 * other half and used to admit a bare error everywhere, which is mutant M7 —
 * killed in `structuredOutcome` by the strict rows above — shipping unmutated one
 * function up.
 *
 * The cost of narrowing it is real and one-directional: limit vocabulary that
 * lives ONLY under a `message` key below the verdict sources is no longer read,
 * so a genuine limit reported that way rotates no model. The same text one key
 * over survives at every depth, and the containers that nest that deep belong to
 * hosts that never reach this recorder. Under-condemning is the side to be wrong
 * on: a wrongly exhausted model can terminate a role outright.
 */
test('a bare error is a verdict at the payload own level only, in BOTH halves of the classifier', () => {
  const LIMIT = 'you have hit your API usage limit';
  const rows: { label: string; response: unknown; strict: boolean; expected: string | null }[] = [
    // Closed: a nested bare error no longer makes brief prose decisive.
    { label: 'nested bare error + brief, child running', strict: false, expected: null,
      response: { metadata: { error: 'a deprecation warning', message: FIRST_SPAWN_BRIEF }, execution_record: { status: 'running' } } },
    { label: 'nested bare error + brief, nothing else', strict: false, expected: null,
      response: { results: { error: '1 file skipped', message: FIRST_SPAWN_BRIEF } } },
    // Unchanged: the OWN level still admits one, which is the asymmetry itself.
    { label: 'own bare error + a real limit message', strict: true, expected: 'api-limit',
      response: { error: 'the child died', message: LIMIT } },
    { label: 'own status failure + a real limit message', strict: true, expected: 'api-limit',
      response: { status: 'error', message: LIMIT } },
    // Unchanged: a nested record with a STATUS is a verdict source at that depth,
    // so its own message is still its own error text.
    { label: 'nested status failure + a real limit message', strict: false, expected: 'api-limit',
      response: { execution_record: { status: 'error', message: LIMIT } } },
    // The COST, pinned so it cannot be rediscovered as a surprise.
    { label: 'COST: nested bare error, the limit only in its message', strict: false, expected: null,
      response: { execution_record: { error: 'the child stopped', message: LIMIT } } },
    { label: 'COST: below the sources, the limit only in a message', strict: false, expected: null,
      response: { output: { metadata: { status: 'error', message: LIMIT } } } },
    { label: 'COST: a failing step in an array, the limit only in its message', strict: false, expected: 'stopped',
      response: { execution_record: { status: 'error', steps: [{ status: 'error', message: LIMIT }] } } },
    // And what does NOT move with it: the same evidence under any other key.
    { label: 'the same limit under `text`, below the sources', strict: false, expected: 'api-limit',
      response: { output: { metadata: { status: 'error', text: LIMIT } } } },
    { label: 'the same limit under `error`, one level in', strict: false, expected: 'api-limit',
      response: { execution_record: { error: LIMIT, message: FIRST_SPAWN_BRIEF } } },
  ];
  const misread = rows
    .filter((row) => (classifySubagentStop(row.response, row.strict) ?? null) !== row.expected)
    .map((row) => `${row.label} → ${String(classifySubagentStop(row.response, row.strict))}`);
  assert.deepEqual(misread, [], 'the two halves of the classifier disagreed about what a verdict is');
});

/**
 * THE RULE ITSELF, as an equivalence over positions, rather than three cost rows
 * that happen to demonstrate it.
 *
 * The rows above price what dropping a brief-named `message` costs at three
 * positions. They cannot state WHY those three and not others, so the next edit
 * can move the boundary — make a bare error decisive at every depth, or move a
 * list member's depth — and stay green, which is exactly what a peer review
 * found: mutating the array arm to keep its parent's depth added zero red while
 * moving real classifications.
 *
 * Which is the rule, and it is one sentence: a record's `message` is read as this
 * tool's failure text exactly where that record's own failure SIGNAL is read as
 * this tool's verdict. Same positions, same evidence, one direction each way — so
 * a limit under `message` is lost precisely where a `status: 'error'` beside it
 * would also have been ignored, and attributing a nested child's limit to the
 * parent is refused in the KIND dimension for the same reason it is refused in
 * the RETIREMENT dimension.
 *
 * THE EQUIVALENCE SURVIVED A BOUNDARY MOVE, and that is what this round did to
 * it. A list used to be a position of its own that no verdict could be read at,
 * so `content[]` — Claude's own result shape — read neither the verdict nor the
 * message: consistent, and consistently blind. A list costs no level now, so a
 * member of an own-level list is a nested source in both halves at once, and the
 * `inside content[]` / `inside steps[]` / `the payload IS an array` cells below
 * now read BOTH where they used to read NEITHER. Measured over a 1,680-row corpus
 * (position × verdict signal × limit carrier × sibling verdict × strictness — the
 * construction is in the driver, and the count is a count of that product, not of
 * anything more general), 140 rows moved: 135 gained a classification, every one
 * of them on a payload whose own list member reports a failure of its own
 * (`status`, `is_error` or `ok:false` — never a bare `error`), and 5 moved the
 * other way, from `api-limit` to null, because a `status:'completed'` inside a
 * list is now read as the success it is. No row where any source reported success
 * gained a retirement.
 *
 * `requireStructuredFailure` is false throughout so the text fallback really
 * runs; on the strict path a payload with no readable verdict answers null
 * without reading any text, and every cell would agree for the wrong reason.
 */
test('a message is read as evidence exactly where its record is read as a verdict', () => {
  const LIMIT = 'you have hit your API usage limit';
  const POSITIONS: { label: string; at: (fields: Record<string, unknown>) => unknown }[] = [
    { label: 'the payload own top level', at: (fields) => ({ ...fields }) },
    { label: 'one record in, execution_record', at: (fields) => ({ execution_record: { ...fields } }) },
    { label: 'one record in, an envelope nothing names', at: (fields) => ({ tool_output: { ...fields } }) },
    { label: 'two records in', at: (fields) => ({ output: { metadata: { ...fields } } }) },
    { label: 'inside content[]', at: (fields) => ({ content: [{ ...fields }] }) },
    { label: 'inside steps[]', at: (fields) => ({ steps: [{ ...fields }] }) },
    { label: 'the payload IS an array', at: (fields) => [{ ...fields }] },
  ];
  const SIGNALS: { label: string; fields: Record<string, unknown> }[] = [
    { label: 'status error', fields: { status: 'error' } },
    { label: 'a bare error', fields: { error: 'boom' } },
    { label: 'is_error', fields: { is_error: true } },
  ];
  const broken: string[] = [];
  for (const position of POSITIONS) {
    for (const signal of SIGNALS) {
      const verdictRead = classifySubagentStop(position.at(signal.fields), false) === 'stopped';
      const messageRead = classifySubagentStop(position.at({ ...signal.fields, message: LIMIT }), false) === 'api-limit';
      if (verdictRead !== messageRead) {
        broken.push(`${position.label} | ${signal.label} | verdict read=${verdictRead}, message read=${messageRead}`);
      }
    }
  }
  assert.deepEqual(broken, [], 'the classifier read a message from a record whose verdict it refuses, or the reverse');
  // Not vacuous in either direction: one cell reads both, one reads neither.
  assert.equal(classifySubagentStop({ status: 'error', message: LIMIT }, false), 'api-limit', 'a decisive record own message is evidence');
  assert.equal(
    classifySubagentStop({ output: { metadata: { status: 'error', message: LIMIT } } }, false),
    null,
    'a record below the verdict sources is decisive nowhere, so neither is its message',
  );
  // The equivalence held over a boundary that was in the WRONG PLACE, and this
  // assertion used to pin the wrong side of it: `an array member is a verdict
  // source nowhere` expected null here. A list costs no level now, so a member of
  // an own-level list is a nested source and its `message` is read exactly there
  // — which is the same one sentence, at a position it used to exclude.
  assert.equal(
    classifySubagentStop({ content: [{ status: 'error', message: LIMIT }] }, false),
    'api-limit',
    'a member of an own-level list is a nested source, and its message is read there',
  );
  // And the three WRONG versions of that widening, which the equivalence above
  // cannot distinguish on its own because each keeps both halves in step.
  //  1. a list member promoted to the OWN level, where a bare `error` counts.
  //     That is the fail-open the position rule exists for.
  assert.equal(
    classifySubagentStop({ content: [{ error: 'a deprecation warning', message: LIMIT }] }, false),
    null,
    'a bare error inside a list is not a verdict, so a brief beside it is not evidence',
  );
  assert.equal(
    classifySubagentStop([{ error: 'a deprecation warning', message: LIMIT }], false),
    null,
    'and a member of a bare top-level list is not the own level either',
  );
  //  2. transparency that recurses: a list inside a list.
  assert.equal(
    classifySubagentStop({ content: [[{ status: 'error', message: LIMIT }]] }, false),
    null,
    'a list inside a list is below the sources',
  );
  //  3. transparency that ignores the one-level bound: a list inside an envelope.
  assert.equal(
    classifySubagentStop({ execution_record: { steps: [{ status: 'error', message: LIMIT }] } }, false),
    null,
    'a step list inside an envelope is below the sources',
  );
});

/**
 * THE ECHO, which is what closes the last cell the position corpus still declares
 * as a residual — and the reason the previous round's irreducibility argument was
 * wrong rather than merely unlucky.
 *
 * That argument was: in this cell the brief appears in exactly one place, so no
 * discriminator can exist. It appears in one place IN THE RESULT. The payload
 * also carries the tool INPUT, which the recorder reads one line above the
 * classify call to infer the role and never handed the classifier — and the very
 * premise that puts a brief in the result is that the host ECHOED it, so a second
 * copy is not a lucky coincidence but a consequence of the shape being reachable
 * at all. This is the same principle as the `[t1-replace-agent]` marker:
 * evidence from OUTSIDE the ambiguous string.
 *
 * THE PREMISE SURVIVED PEER REVIEW AND THE INSTRUMENT DID NOT, so this file
 * records both versions. What shipped was CONTAINMENT over every string in
 * `tool_input` to depth 4, pinned here as "a TRUNCATED echo still matches" and
 * defended in prose as only ever suppressing a message "the prompt already
 * contained verbatim". Measured, it suppressed genuine host messages from nine
 * normalized characters up (`API limit` inside 'Refactor the API limit banner
 * component.'), out of `model`, `agent_type`, an unnamed key and a nested object
 * three and four levels down, and — the blocker — on the respawn the product
 * itself prescribes, where the prompt quotes the incident by design.
 *
 * So the test is IDENTITY and the haystack is the BRIEF: a result string is an
 * echo when it equals, normalized, one of the strings `role-infer.ts` reads as
 * this spawn's brief. A re-indented, re-cased echo still matches (each string is
 * whitespace-folded and case-folded); a truncated one no longer does, and that
 * row is below with its new answer rather than deleted.
 */
test('a brief the spawn input already carries is an echo, not the result reporting a limit', () => {
  const LIMIT = 'you have hit your API usage limit';
  const CRASH = { status: 'error', output: 'the child crashed.', exit_code: 1 };
  const rows: { label: string; message: string; input: Record<string, unknown>; expected: string }[] = [
    {
      label: 'the residual cell: the host echoes the brief beside a real crash',
      message: FIRST_SPAWN_BRIEF,
      input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: FIRST_SPAWN_BRIEF },
      expected: 'stopped',
    },
    {
      label: 're-indented and re-cased by the host',
      message: `\n   ${FIRST_SPAWN_BRIEF.replace('. ', '.\n   ').toUpperCase()}\n`,
      input: { prompt: FIRST_SPAWN_BRIEF },
      expected: 'stopped',
    },
    {
      label: 'the brief nested one deeper in the input, as role-infer reads it',
      message: FIRST_SPAWN_BRIEF,
      input: { payload: { description: FIRST_SPAWN_BRIEF } },
      expected: 'stopped',
    },
    // The controls, which are what keep this from being a way to lose evidence.
    {
      label: 'CONTROL a genuine limit message the input never mentions',
      message: LIMIT,
      input: { subagent_type: 'senior-frontend', prompt: 'Build the billing screen.' },
      expected: 'api-limit',
    },
    {
      label: 'CONTROL no input at all: the result alone still decides',
      message: LIMIT,
      input: {},
      expected: 'api-limit',
    },
    {
      label: 'CONTROL an echoed brief does not hide a limit the RESULT reports',
      message: FIRST_SPAWN_BRIEF,
      input: { prompt: FIRST_SPAWN_BRIEF },
      expected: 'api-limit',
    },
    // WHAT IDENTITY COSTS, and the row that used to pin the opposite. Under
    // containment this answered `stopped`; a truncated echo is now read as a
    // result. The trade is deliberate: a prefix or substring test is what let a
    // brief mentioning a limit disable classification for the child's whole life,
    // and this direction costs the KIND on a child already reported dead.
    {
      label: 'COST an echo the host truncated is no longer detected',
      message: FIRST_SPAWN_BRIEF.slice(0, 70),
      input: { prompt: FIRST_SPAWN_BRIEF },
      expected: 'api-limit',
    },
    {
      label: 'COST an echo the host appended a suffix to, unchanged from before',
      message: `${FIRST_SPAWN_BRIEF} [truncated]`,
      input: { prompt: FIRST_SPAWN_BRIEF },
      expected: 'api-limit',
    },
  ];
  const misread: string[] = [];
  for (const row of rows) {
    const result = row.label.includes('does not hide a limit')
      ? { ...CRASH, output: `Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 — ${LIMIT}.` }
      : CRASH;
    const got = classifySubagentStop({ ...result, message: row.message }, true, row.input);
    if (got !== row.expected) misread.push(`${row.label} → ${String(got)}, wanted ${row.expected}`);
  }
  assert.deepEqual(misread, [], 'the echo discriminator read a brief as a result, or a result as a brief');
  // The discriminator is OPTIONAL and its absence must not change anything: a
  // caller with no spawn call to compare against gets the result-only answer.
  assert.equal(
    classifySubagentStop({ status: 'error', message: FIRST_SPAWN_BRIEF, exit_code: 1 }, true),
    'api-limit',
    'without the input, this is the documented residual and stays it',
  );
});

/**
 * WHAT MAY SUPPRESS A GENUINE LIMIT, driven as the two axes the containment
 * version failed on rather than as the one row that discovered it.
 *
 * A discriminator that reads the spawn input has to answer where it reads and
 * how it compares, and getting either wrong turns evidence into a denylist. Both
 * were wrong, and each cell here is a measured suppression under containment:
 *
 *   - POSITION. The input was walked for every string to depth 4, so `model`,
 *     `agent_type`, a key no reader names, a nested context object and an array
 *     member could all suppress. Only the brief positions `role-infer.ts` reads
 *     may, because only a brief has an echo;
 *   - COMPARISON. Containment fires on nine normalized characters, so an
 *     ordinary product brief that merely NAMES an incident code disabled that
 *     code for the child's whole life. Identity cannot: a host sentence is never
 *     equal to a whole brief.
 *
 * Both evidence kinds are driven, not just `api-limit` — `model-unavailable`
 * routes to Cursor's Settings flow and was suppressible on the same rule.
 */
test('only a brief can be an echo, and only by being the whole brief', () => {
  const CRASH = { status: 'error', output: 'the child crashed.', exit_code: 1 };
  const classify = (message: string, input: Record<string, unknown>) =>
    String(classifySubagentStop({ ...CRASH, message }, true, input));

  // AXIS 1 — the input position the same needle sits in. A brief suppresses; no
  // other field may, however deep the walk that finds it.
  const NEEDLE = 'you have hit your API usage limit';
  const POSITIONS: { label: string; input: Record<string, unknown>; suppresses: boolean }[] = [
    { label: 'prompt (a brief role-infer reads)', input: { prompt: NEEDLE }, suppresses: true },
    { label: 'payload.description (the other brief position)', input: { payload: { description: NEEDLE } }, suppresses: true },
    { label: 'model', input: { model: NEEDLE }, suppresses: false },
    { label: 'agent_type', input: { agent_type: NEEDLE }, suppresses: false },
    { label: 'a key no reader names', input: { note: NEEDLE }, suppresses: false },
    { label: 'a nested object two levels in', input: { context: { note: NEEDLE } }, suppresses: false },
    { label: 'four levels in', input: { a: { b: { c: { d: NEEDLE } } } }, suppresses: false },
    { label: 'inside an array', input: { files: [NEEDLE] }, suppresses: false },
  ];
  const wrongPosition = POSITIONS
    .map((row) => ({ row, got: classify(NEEDLE, row.input) }))
    .filter(({ row, got }) => got !== (row.suppresses ? 'stopped' : 'api-limit'))
    .map(({ row, got }) => `${row.label} → ${got}`);
  assert.deepEqual(wrongPosition, [], 'a field that is not a brief suppressed a limit the result reported');

  // AXIS 2 — the needle. Every one of these is a host message a real incident
  // arrives as, beside a brief that merely mentions the same words. Containment
  // suppressed all of them; the shortest is nine characters.
  const NEEDLES: { message: string; brief: string; kind: string }[] = [
    { message: 'API limit', brief: 'Refactor the API limit banner component.', kind: 'api-limit' },
    { message: 'API usage limit', brief: FIRST_SPAWN_BRIEF, kind: 'api-limit' },
    { message: 'rate_limit_exceeded', brief: 'Add a retry with backoff when the API returns rate_limit_exceeded.', kind: 'api-limit' },
    { message: 'quota exceeded', brief: 'Warn the user when their quota exceeded the plan allowance.', kind: 'api-limit' },
    { message: 'rate-limited', brief: 'Write the tests for the rate-limited branch of the client.', kind: 'api-limit' },
    { message: 'too many requests', brief: 'Handle too many requests from the payments provider.', kind: 'api-limit' },
    { message: 'model not enabled', brief: 'Hide the selector when the model not enabled error comes back.', kind: 'model-unavailable' },
  ];
  const swallowed = NEEDLES
    .map((row) => ({ row, got: classify(row.message, { prompt: row.brief, model: 'composer-2.5-fast' }) }))
    .filter(({ row, got }) => got !== row.kind)
    .map(({ row, got }) => `${JSON.stringify(row.message)} inside ${JSON.stringify(row.brief)} → ${got}`);
  assert.deepEqual(swallowed, [], 'a brief that merely names an incident disabled that incident');

  // And the whole brief still is an echo, in both spellings of the same word, so
  // the rows above are not passing because the mechanism stopped working.
  assert.equal(classify(FIRST_SPAWN_BRIEF, { prompt: FIRST_SPAWN_BRIEF }), 'stopped', 'the echo itself is still read as an echo');
  assert.equal(
    classify('The model gpt-5.6-terra-medium is not enabled', { prompt: 'The model gpt-5.6-terra-medium is not enabled' }),
    'stopped',
    'a model-availability brief the host echoed is an echo too',
  );
});

/**
 * WHAT CLOSING THE BRIEF LEAK COST, which the round that closed it recorded as
 * "no evidence path was deleted". That was false, and this is the tenth path: a
 * failure record with NO status field, whose only content is a `message`.
 *
 * Before the exclusion, `{ message: 'you have hit your API usage limit' }`
 * classified `api-limit`; it now answers null, so a child that died that way
 * stays registered as LIVE and no rotation happens. The trade is kept — the
 * alternative is to read a status-less `message` as evidence, which is precisely
 * the first-spawn brief that retired live agents and condemned models — but it is
 * a TRADE, not the absence of one, and the sentence that justified it ("there is
 * nothing for a `message` to be the message OF") is deleted rather than defended.
 *
 * The bound on it: every other spelling of a status-less failure still fires, so
 * a host has to report failure through `message` ALONE to be lost.
 */
test('a status-less failure record under `message` alone is the disclosed cost of the brief exclusion', () => {
  const LIMIT = 'you have hit your API usage limit';
  assert.equal(classifySubagentStop({ message: LIMIT }, false), null, 'the cost: read as a brief, not as a failure');
  assert.equal(classifySubagentStop({ message: LIMIT, output: 'the run ended' }, false), null, 'and prose beside it does not rescue it');
  // The bound. Every one of these is a status-less failure that still classifies.
  for (const [label, response] of [
    ['a bare failure STRING', `run_subagent failed: ${LIMIT}`],
    ['{ text: … }', { text: LIMIT }],
    ['{ error: … } at the own level', { error: LIMIT }],
    ['{ stdout: … }', { stdout: LIMIT }],
    ['vocabulary carried by a KEY', { rate_limit_exceeded: true }],
  ] as const) {
    assert.equal(classifySubagentStop(response, false), 'api-limit', `${label}: still read as the failure it is`);
  }
});

/**
 * The two evidence paths that separate this from the one-line version. Handing the
 * classifier the leaf's existing input-excluding WALK closes the rows above and
 * silently drops both of these: the walk starts by demanding a record, so a bare
 * failure string answers '', and it collects VALUES, so vocabulary carried by a key
 * is never seen. Both are failure detections that ship today.
 */
test('excluding the input keeps a legacy host unstructured failure string', () => {
  const legacyString = rawFromHost('claude', [], {
    hook_event_name: 'PostToolUse',
    tool_name: 'Task',
    tool_input: { subagent_type: 'senior-frontend', prompt: 'build the UI' },
    tool_response: 'run_subagent failed: you have hit your API usage limit.',
  });
  assert.equal(
    classifySubagentStop(toolResultPayload(legacyString), false),
    'api-limit',
    'a host that answers with nothing but a failure string still gets the documented text fallback',
  );
});

/**
 * Separate from the row above on purpose: the two paths die to the same one-line
 * shortcut for different reasons, and folded into one test the first assertion
 * would abort before the second could redden.
 */
test('excluding the input keeps limit vocabulary carried by a key rather than a value', () => {
  const keyOnly = rawFromHost('claude', [], {
    hook_event_name: 'PostToolUse',
    tool_name: 'Task',
    tool_input: { subagent_type: 'senior-frontend', prompt: 'build the UI' },
    tool_response: { rate_limit_exceeded: true },
  });
  assert.equal(
    classifySubagentStop(toolResultPayload(keyOnly), false),
    'api-limit',
    'the limit is the KEY; only the serialized form carries it',
  );

  // The same evidence inside the envelope Copilot-shaped payloads use, where no
  // wrapper narrows anything and the projection is doing all the work.
  const copilotKeyOnly = rawFromHost('copilot', ['after-tool-use'], {
    hook_event_name: 'PostToolUse',
    tool_name: 'task',
    tool_args: JSON.stringify({ agent_type: 'traffic-one:senior-frontend', prompt: 'build the UI' }),
    execution_record: { rate_limit_exceeded: true },
  });
  assert.equal(classifySubagentStop(toolResultPayload(copilotKeyOnly), false), 'api-limit');
});

/**
 * The MIRROR of the rows above, and the reason this round could not hold agent
 * ids constant the way the previous one did. `extractSpawnedAgentId` was left
 * scanning the whole payload on the argument that its regex is anchored on a
 * labelled `agent[_ ]id:` form, so only text that literally quotes a labelled id
 * could false-positive. That text exists, and it is the single worst place for it
 * to: a `[t1-replace-agent]` prompt quotes the id the orchestrator was just told
 * to retire. Extracting it re-registers the corpse as the run's live agent, and
 * combined with the fail-open the first round closed, the same id is then vouched
 * for as alive.
 *
 * Every row is built the way its host sends it and pushed through THAT host's
 * adapter, because the lifts decide what a hook sees: Copilot parses `tool_args`
 * from a JSON string into both `tool_input` and `toolInput`, Cascade copies
 * `tool_info`, and OpenCode/Kilo lift `output.args`. The DEFECT rows are the nine
 * measured movements; the CONTROL rows are the other direction, that a result
 * genuinely reporting an id still yields it on every family. Copilot and Cursor
 * cannot be driven from this environment, so every payload here is CONSTRUCTED,
 * not observed.
 */
const SPAWNED_ID_ROWS: {
  host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'kilo' | 'windsurf';
  argv: readonly string[];
  label: string;
  stdin: Record<string, unknown>;
  /** The id the RESULT reports. Null when only the prompt names one. */
  expected: string | null;
}[] = (() => {
  const LIVE = 'bff46cd7-3681-4cf0-adcf-263bf55cc301';
  const DEAD = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const RETIRE = `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${DEAD} was retired. Continue the work.`;
  const RETIRE_COPILOT = `${REPLACE_AGENT_MARKER}\nContinue the run. agent_id: senior-frontend-old was retired.`;
  return [
    {
      host: 'claude', argv: [], label: 'claude wrapper, CONTROL: structured agentId in the result',
      expected: 'add5367d74354d9b3',
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', prompt: RETIRE },
        tool_response: { status: 'completed', agentId: 'add5367d74354d9b3', content: [{ type: 'text', text: 'done' }] },
      },
    },
    {
      host: 'claude', argv: [], label: 'claude wrapper, CONTROL: the `agentId:` footer as text only',
      expected: 'add5367d74354d9b3',
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', prompt: RETIRE },
        tool_response: { content: [{ type: 'text', text: "READY\nagentId: add5367d74354d9b3 (use SendMessage with to: 'add5367d74354d9b3')" }] },
      },
    },
    {
      host: 'claude', argv: [], label: 'claude wrapper: the wrapper never contained the prompt, so nothing moved here',
      expected: null,
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', prompt: RETIRE },
        tool_response: { status: 'completed', content: [{ type: 'text', text: 'The agent finished.' }] },
      },
    },
    {
      host: 'codex', argv: [], label: 'codex wrapper, CONTROL: snake_case agent_id in the result',
      expected: '019ebb7f-0691-7281-b686-27e7fe6b393f',
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'spawn_agent',
        tool_input: { task_name: 'senior-frontend', prompt: 'Retire agent_id: 019ebb7f-dead-7281-b686-27e7fe6b393f first.' },
        tool_response: { agent_id: '019ebb7f-0691-7281-b686-27e7fe6b393f', nickname: 'Volta' },
      },
    },
    {
      host: 'cursor', argv: ['after-tool-use'], label: 'cursor flat, CONTROL: the `Agent ID:` line in the top-level output',
      expected: LIVE,
      stdin: {
        tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: 'Build the settings page.' },
        output: `Agent ID: ${LIVE} — shipped the settings page.`, exit_code: 0,
      },
    },
    {
      host: 'cursor', argv: ['after-tool-use'], label: 'cursor flat, DEFECT: the replace prompt quotes the retired id and the result reports none',
      expected: null,
      stdin: {
        tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: RETIRE },
        output: 'The subagent started.', exit_code: 0,
      },
    },
    {
      host: 'cursor', argv: ['after-tool-use'], label: 'cursor flat, DEFECT: the prompt quotes the corpse, the result reports the replacement',
      expected: LIVE,
      stdin: {
        tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', prompt: RETIRE },
        output: `Agent ID: ${LIVE} — replacement running.`,
      },
    },
    {
      host: 'cursor', argv: ['after-tool-use'], label: 'cursor flat, DEFECT: the markdown-link id form, quoted in the prompt only',
      expected: null,
      stdin: {
        tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', prompt: `See the prior run [senior-frontend](${DEAD}) for context.` },
        output: 'The subagent started.',
      },
    },
    {
      host: 'cursor', argv: ['after-tool-use'], label: 'cursor flat, CONTROL: a `resume` continuation whose result reports the id',
      expected: LIVE,
      stdin: {
        tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', resume: LIVE, prompt: 'Only the new task.' },
        output: `Agent ID: ${LIVE} — continued.`,
      },
    },
    {
      // Cursor's continuation field is `resume`, a spelling the extractor's
      // vocabulary never matched. Measured null BEFORE this change too, so
      // narrowing takes nothing away here — this is not a host that reports a
      // spawned id only in its input.
      host: 'cursor', argv: ['after-tool-use'], label: 'cursor flat: a `resume` continuation whose result reports nothing was already silent',
      expected: null,
      stdin: {
        tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend', resume: LIVE, prompt: 'Only the new task.' },
        output: 'Continued the agent.',
      },
    },
    {
      host: 'copilot', argv: ['after-tool-use'], label: 'copilot CLI, CONTROL: agent_id in the telemetry record',
      expected: 'senior-frontend',
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'task',
        tool_args: JSON.stringify({ agent_type: 'traffic-one:senior-frontend', name: 'senior-frontend', mode: 'background', prompt: 'Build the settings page.' }),
        toolTelemetry: { restrictedProperties: { agent_id: 'senior-frontend', agent_name: 'traffic-one:senior-frontend' } },
      },
    },
    {
      host: 'copilot', argv: ['after-tool-use'], label: 'copilot CLI, DEFECT: the replace prompt quotes the retired agent_id',
      expected: null,
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'task',
        tool_args: JSON.stringify({ agent_type: 'traffic-one:senior-frontend', mode: 'background', prompt: RETIRE_COPILOT }),
        execution_record: { status: 'running', text: 'The background task started.' },
      },
    },
    {
      host: 'copilot', argv: ['after-tool-use'], label: 'copilot CLI, DEFECT: the prompt quotes the corpse, the result reports the replacement',
      expected: 'senior-frontend-2',
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'task',
        tool_args: JSON.stringify({ agent_type: 'traffic-one:senior-frontend', prompt: RETIRE_COPILOT }),
        toolTelemetry: { restrictedProperties: { agent_id: 'senior-frontend-2' } },
      },
    },
    {
      // The one input field on any reachable host that really does carry an agent
      // id: Copilot's `task` continuation primitive. It is an id the prompt
      // REQUESTS — handed back out of the registry the reuse gate has just read —
      // not one the result reports, and taking it is exactly how a row retired by
      // the marker comes back to life. Losing it costs nothing: the row it names
      // is either already recorded or deliberately retired, and Copilot's
      // SubagentStart display-name bind records the live one independently.
      host: 'copilot', argv: ['after-tool-use'], label: 'copilot CLI, DEFECT: the continuation input carries agent_id and the result reports none',
      expected: null,
      stdin: {
        hook_event_name: 'PostToolUse', tool_name: 'task',
        tool_args: JSON.stringify({ agent_type: 'traffic-one:senior-frontend', agent_id: 'senior-frontend', prompt: 'Only the new fix task.' }),
        execution_record: { status: 'running' },
      },
    },
    {
      host: 'copilot', argv: ['after-tool-use'], label: 'copilot VS Code, CONTROL: the object (not JSON-string) tool_args surface',
      expected: 'senior-backend',
      stdin: {
        hookSpecificOutput: { hookEventName: 'PostToolUse' },
        hook_event_name: 'PostToolUse', tool_name: 'task',
        tool_args: { agent_type: 'traffic-one:senior-backend', prompt: 'Build the settings page.' },
        toolTelemetry: { restrictedProperties: { agent_id: 'senior-backend' } },
      },
    },
    {
      host: 'opencode', argv: ['after-tool-use'], label: 'opencode output container, CONTROL: the id in output.output',
      expected: 'ses_opencode12345',
      stdin: {
        event: 'tool.execute.after', tool_name: 'task',
        output: { title: 'task', args: { subagent_type: 'senior-frontend', prompt: 'Build the settings page.' }, output: 'agent_id: ses_opencode12345' },
      },
    },
    {
      host: 'opencode', argv: ['after-tool-use'], label: 'opencode output container, DEFECT: the prompt lifted out of output.args quotes a retired id',
      expected: null,
      stdin: {
        event: 'tool.execute.after', tool_name: 'task',
        output: { title: 'task', args: { subagent_type: 'senior-frontend', prompt: 'Retire agent_id: ses_opencodeDEAD1 and restart.' }, output: 'task complete' },
      },
    },
    {
      host: 'kilo', argv: ['after-tool-use'], label: 'kilo output container, CONTROL: the id in output.output',
      expected: 'kilo-task-99887',
      stdin: {
        event: 'tool.execute.after', tool_name: 'task',
        output: { title: 'task', args: { subagent_type: 'senior-tester', prompt: 'Build the settings page.' }, output: 'agent_id: kilo-task-99887' },
      },
    },
    {
      host: 'kilo', argv: ['after-tool-use'], label: 'kilo output container, DEFECT: the prompt lifted out of output.args quotes a retired id',
      expected: null,
      stdin: {
        event: 'tool.execute.after', tool_name: 'task',
        output: { title: 'task', args: { subagent_type: 'senior-tester', prompt: 'Retire agent_id: kilo-task-DEAD11 and restart.' }, output: 'task complete' },
      },
    },
    {
      host: 'windsurf', argv: ['post_mcp_tool_use'], label: 'cascade tool_info, CONTROL: the id beside the prompt in the same record',
      expected: 'devin-agent-77123',
      stdin: {
        agent_action_name: 'post_mcp_tool_use',
        tool_info: {
          mcp_server_name: 'devin', mcp_tool_name: 'run_subagent',
          profile: 'senior-frontend', prompt: 'Build the settings page.', output: 'agent_id: devin-agent-77123',
        },
      },
    },
    {
      host: 'windsurf', argv: ['post_mcp_tool_use'], label: 'cascade tool_info, DEFECT: tool_info.prompt quotes a retired id',
      expected: null,
      stdin: {
        agent_action_name: 'post_mcp_tool_use',
        tool_info: {
          mcp_server_name: 'devin', mcp_tool_name: 'run_subagent',
          profile: 'senior-frontend', prompt: 'Retire agent_id: devin-agent-DEAD11 and restart.', output: 'the subagent started',
        },
      },
    },
    {
      host: 'windsurf', argv: ['post_mcp_tool_use'], label: 'Devin Local (Claude-shaped), CONTROL: the wrapper reports agent_id',
      expected: 'devin-local-55321',
      stdin: {
        agent_action_name: 'post_mcp_tool_use',
        tool_input: { profile: 'senior-frontend', prompt: RETIRE },
        tool_response: { agent_id: 'devin-local-55321' },
      },
    },
  ];
})();

test('the extracted spawn id is the one the RESULT reports, never one the prompt quotes', () => {
  for (const row of SPAWNED_ID_ROWS) {
    assert.equal(
      extractSpawnedAgentId(toolResultPayload(rawFromHost(row.host, row.argv, row.stdin))),
      row.expected,
      row.label,
    );
  }
});

/**
 * A brief spelled outside the SHARED input vocabulary, which is a different
 * question from a brief this reader can see. `tool_info` is a RESULT container,
 * not an input key, so `tool_info.message` survives `toolResultWithoutInput` —
 * and this leak was left open on the argument that the only host shaped that way
 * (legacy Cascade) never reaches the recorder anyway.
 *
 * That argument covered the wrong half. The same residual is reachable at the
 * payload's TOP LEVEL on Cursor and on the Copilot envelope family, both of which
 * DO reach the recorder, so the extractor now carries its own exclusion
 * (`withoutSpawnBrief`) rather than relying on a host stand-down. Cascade closes
 * with them, for free. Admitting `message` to `TOOL_INPUT_KEYS` was and remains
 * refused — it would delete failure evidence from three readers at once — and the
 * private list does not drift, because it IS `role-infer.ts`'s.
 */
test('a brief spelled outside the shared input vocabulary no longer leaks its quoted id', () => {
  const cascade = extractSpawnedAgentId(toolResultPayload(rawFromHost('windsurf', ['post_mcp_tool_use'], {
    agent_action_name: 'post_mcp_tool_use',
    tool_info: {
      mcp_server_name: 'devin', mcp_tool_name: 'run_subagent',
      profile: 'senior-frontend', message: 'Retire agent_id: devin-agent-DEAD22 and restart.',
      output: 'the subagent started',
    },
  })));
  assert.equal(cascade, null, 'the brief is excluded by this reader even where the shared vocabulary cannot');
  assert.equal(
    subagentContinuationAvailable({} as NodeJS.ProcessEnv, 'windsurf'),
    false,
    'and the host was never reached in the first place — which is why this row was not the one that mattered',
  );
  // The other half of the same object: a RESULT that really does report the id in
  // the same container still yields it. The exclusion is by key and by string,
  // not a refusal to read `tool_info`.
  assert.equal(
    extractSpawnedAgentId(toolResultPayload(rawFromHost('windsurf', ['post_mcp_tool_use'], {
      agent_action_name: 'post_mcp_tool_use',
      tool_info: {
        mcp_server_name: 'devin', mcp_tool_name: 'run_subagent',
        profile: 'senior-frontend', message: 'Retire agent_id: devin-agent-DEAD22 and restart.',
        output: 'agent_id: devin-agent-77123',
      },
    }))),
    'devin-agent-77123',
  );
});

/**
 * P2, end to end and in both directions: a spawn BRIEF at the payload's TOP
 * LEVEL, on the two flat hosts that reach this recorder.
 *
 * `TOOL_INPUT_KEYS` deliberately refuses these spellings (a `message` in a status
 * envelope is ordinary failure evidence), and the disclosure used to call the gap
 * "closed in practice" because the three reachable hosts nest a brief under
 * `tool_input`/`tool_args`. The nested half is true. The FLAT half was not:
 * `adapters/cursor.ts` and `adapters/copilot.ts` each read a top-level `message`
 * as prompt text and Cursor passes `raw: data` through verbatim, and measured
 * before the fix every one of these rows returned the id the replacement prompt
 * was quoting as RETIRED — which `recordSpawnedAgent` then wrote into the
 * registry as this run's live agent, `isResumeCapableAgentId` waving it through.
 *
 * Still UNOBSERVED: no fixture or corpus entry in this tree puts a brief at the
 * top level on either host, and neither host can be driven from here, so every
 * payload below is CONSTRUCTED. Iterating `SPAWN_BRIEF_KEYS` rather than a
 * literal is what keeps the extractor's private exclusion tied to the spellings
 * `role-infer.ts` actually reads: a spelling added there is covered here without
 * a second edit, and one removed reddens.
 */
test('a brief at the payload top level is input, on every flat host that reaches the recorder', () => {
  const DEAD_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const LIVE_UUID = 'bff46cd7-3681-4cf0-adcf-263bf55cc301';
  const leaked: string[] = [];
  const lost: string[] = [];
  for (const key of SPAWN_BRIEF_KEYS) {
    const cursor = (brief: Record<string, unknown>, output: string): unknown => rawFromHost('cursor', ['after-tool-use'], {
      tool_name: 'Task',
      tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium' },
      ...brief,
      output,
    });
    const copilot = (brief: Record<string, unknown>, record: Record<string, unknown>): unknown => rawFromHost('copilot', ['after-tool-use'], {
      hook_event_name: 'PostToolUse', tool_name: 'task',
      tool_args: JSON.stringify({ agent_type: 'traffic-one:senior-frontend' }),
      ...brief,
      execution_record: record,
    });
    const rows: { label: string; raw: unknown; expected: string | null }[] = [
      {
        label: `cursor, top-level ${key}: the replace brief quotes the retired id and the result reports none`,
        raw: cursor({ [key]: `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${DEAD_UUID} was retired.` }, 'The subagent started.'),
        expected: null,
      },
      {
        label: `cursor, top-level ${key}: the brief quotes the corpse, the result reports the replacement`,
        raw: cursor({ [key]: `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${DEAD_UUID} was retired.` }, `Agent ID: ${LIVE_UUID} — replacement running.`),
        expected: LIVE_UUID,
      },
      {
        label: `copilot, top-level ${key}: the replace brief quotes the retired agent_id`,
        raw: copilot({ [key]: `${REPLACE_AGENT_MARKER}\nagent_id: senior-frontend-old was retired.` }, { status: 'running', text: 'The background task started.' }),
        expected: null,
      },
    ];
    // A record is an envelope, not a brief — Copilot's own tool is called `task`,
    // so a `task: { … }` result must stay readable. Asserted only for the four
    // spellings the SHARED vocabulary refuses: `prompt` is an argument spelling
    // in that closed set, dropped by name whatever its value, and this reader
    // must not quietly resurrect it.
    if (!TOOL_INPUT_KEYS.has(key)) {
      rows.push({
        label: `copilot, top-level ${key}: a record under the same name is an envelope, not a brief`,
        raw: copilot({ [key]: { agent_id: 'senior-frontend-2' } }, { status: 'running' }),
        expected: 'senior-frontend-2',
      });
    } else {
      rows.push({
        label: `copilot, top-level ${key}: the shared vocabulary owns this spelling, record or string`,
        raw: copilot({ [key]: { agent_id: 'senior-frontend-2' } }, { status: 'running' }),
        expected: null,
      });
    }
    for (const row of rows) {
      const extracted = extractSpawnedAgentId(toolResultPayload(row.raw));
      if (extracted === row.expected) continue;
      (row.expected === null ? leaked : lost).push(`${row.label} → ${String(extracted)}`);
    }
  }
  assert.deepEqual(leaked, [], 'an id only a brief quotes was read as one the result reported');
  assert.deepEqual(lost, [], 'and closing that must not cost an id a result really does report');
});

/**
 * A brief that is not a STRING is still a brief — the respelling that reopened
 * the row above, and the one place a naive fix for it breaks something real.
 *
 * `withoutSpawnBrief` used to drop the four spellings only when the value was a
 * string. A non-string brief did not fire the exclusion, the projection recursed
 * into it, and `collectResponseText`'s `JSON.stringify` handed the quoted id
 * straight to `AGENT_ID_RE`. Measured, ALL SIXTEEN combinations of the four
 * spellings against `{ text }`, an array of strings, `content[]` blocks and one
 * record deeper leaked the retired id — which `recordSpawnedAgent` then writes
 * into `.traffic-one/runs/<runId>/agents.json` as the run's live reusable
 * `senior-frontend`, so the reuse gate demands continuation of an agent that no
 * longer exists.
 *
 * Both obvious remedies were measured and both break the LAST row here. Dropping
 * the subtree regardless of type loses `task: { agent_id: … }`; stripping only its
 * string leaves loses it too, because that id IS a string leaf. What separates
 * them is not the type: an id a result REPORTS arrives under a key that names it,
 * an id a brief QUOTES arrives inside prose. So the exclusion keeps a structured
 * `agent_id`/`agentId` key at any depth inside a brief-named subtree and drops
 * every other leaf.
 */
test('a brief that is not a string still leaks nothing, and a structured id inside one is still read', () => {
  const DEAD_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const brief = `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${DEAD_UUID} was retired. Continue.`;
  const shapes: { label: string; value: (text: string) => unknown }[] = [
    { label: 'object with .text', value: (text) => ({ text }) },
    { label: 'array of strings', value: (text) => [text] },
    { label: 'content blocks', value: (text) => ({ content: [{ type: 'text', text }] }) },
    { label: 'nested one record deeper', value: (text) => ({ detail: { body: text } }) },
  ];
  const leaked: string[] = [];
  for (const key of SPAWN_BRIEF_KEYS.filter((spelling) => !TOOL_INPUT_KEYS.has(spelling))) {
    for (const shape of shapes) {
      const raw = rawFromHost('cursor', ['after-tool-use'], {
        tool_name: 'Task',
        tool_input: { subagent_type: 'senior-frontend' },
        [key]: shape.value(brief),
        output: 'The subagent started.',
      });
      const extracted = extractSpawnedAgentId(toolResultPayload(raw));
      if (extracted !== null) leaked.push(`top-level ${key} (${shape.label}) → ${extracted}`);
    }
  }
  assert.deepEqual(leaked, [], 'a brief spelled as anything but a string leaked the id it quoted');

  // The row both naive remedies break. Copilot's tool is itself called `task`, so
  // a record under a brief name is an envelope and a structured id in it is the
  // RESULT's. Driven through the adapter, which lifts `tool_args` from a JSON
  // string.
  assert.equal(
    extractSpawnedAgentId(toolResultPayload(rawFromHost('copilot', ['after-tool-use'], {
      hook_event_name: 'PostToolUse', tool_name: 'task',
      tool_args: JSON.stringify({ agent_type: 'traffic-one:senior-frontend' }),
      task: { agent_id: 'senior-frontend-2' },
      execution_record: { status: 'running' },
    }))),
    'senior-frontend-2',
    'a structured id key inside a brief-named subtree is the result reporting one',
  );
  // Both halves of the discriminator in one object, so neither can be satisfied
  // by refusing the whole subtree or by keeping all of it.
  assert.equal(
    extractSpawnedAgentId({ task: { agent_id: 'senior-frontend-2', note: `Retire agent_id: ${DEAD_UUID} first.` } }),
    'senior-frontend-2',
    'the structured key wins over prose quoting another id in the same subtree',
  );
  assert.equal(
    extractSpawnedAgentId({ description: { note: `Retire agent_id: ${DEAD_UUID} first.` } }),
    null,
    'and with no structured key there is nothing in a brief to read',
  );
});

/**
 * Why the two exclusions stay SEPARATE, and what each still admits.
 *
 * This row used to assert that "the classifier keeps the brief spellings the id
 * extractor drops", on the argument that no position rule separates a `message` in
 * a status envelope from a brief naming a limit. That argument was about DEPTH, and
 * it was refuted by measurement: an ordinary first-spawn brief at the payload top
 * level retired a live Copilot agent and condemned its model. The rule that
 * separates them is CO-LOCATION — a record either reports a decisive verdict of its
 * own or it does not — so the classifier now has its own exclusion too, a
 * different one. The two readers still want different things from the same key,
 * which is still why neither list may be promoted into `TOOL_INPUT_KEYS`.
 *
 * Both directions remain load-bearing: a mutant admitting `message` to the shared
 * set, and a mutant handing the classifier the ID extractor's exclusion, both
 * downgrade the first row here from `api-limit` to `stopped`. That is the
 * model-rotation signal, not a nicety — `api-limit` records the model as exhausted
 * for the run and rotates off it.
 */
test('the classifier reads a message co-located with a verdict, and drops every brief that is not', () => {
  assert.equal(
    classifySubagentStop({ status: 'error', message: 'you have hit your API usage limit' }, true),
    'api-limit',
    'a `message` inside a status envelope is ordinary failure evidence, at the payload top level',
  );
  assert.equal(
    classifySubagentStop({ execution_record: { status: 'error', message: 'you have hit your API usage limit' } }, true),
    'api-limit',
    'and inside an envelope nothing names, which is where the structured read now also looks',
  );
  // The three spellings nothing in this tree reports a failure through are dropped
  // even beside a decisive verdict. Defaulting to DROP is the point: a fifth
  // spelling added to `role-infer.ts` is closed here without a second edit.
  for (const key of ['task', 'instructions', 'description']) {
    assert.equal(
      classifySubagentStop({ status: 'error', [key]: 'you have hit your API usage limit' }, true),
      'stopped',
      `${key}: a brief spelling is never the failure's own text, verdict beside it or not`,
    );
  }
  // A `message` with nothing to be the message OF is a brief.
  assert.equal(
    classifySubagentStop({ message: 'you have hit your API usage limit', execution_record: { status: 'running' } }, false),
    null,
    'no decisive verdict in the record carrying it, so it is not that record reporting a failure',
  );
  // And Traffic One's own spawn markers are content Traffic One owns: no host
  // result contains one, so a string carrying one is a brief wherever it sits.
  for (const marker of [REPLACE_AGENT_MARKER, '[t1-role: senior-frontend]']) {
    assert.equal(
      classifySubagentStop({ status: 'error', message: `${marker}\nThe previous agent hit an API usage limit. Continue.` }, true),
      'stopped',
      `${marker}: a brief carrying a Traffic One spawn marker is never result evidence`,
    );
  }
  // The id extractor's half of the same key, unchanged.
  assert.equal(
    extractSpawnedAgentId({ status: 'error', message: 'agent_id: senior-frontend-old was retired.' }),
    null,
    'the same field, same position, is never an id source — no reachable host reports one there',
  );
  assert.equal(
    extractSpawnedAgentId({ status: 'error', text: 'agent_id: senior-frontend-2 started.' }),
    'senior-frontend-2',
    'and the result field beside it still reports one',
  );
});

/**
 * The harm the row above prevents, driven through the recorder onto a
 * materialized project rather than asserted at the unit. Before the fix this
 * wrote `aaaaaaaa-…` — the id the `[t1-replace-agent]` brief was quoting as
 * retired — into `.traffic-one/runs/<runId>/agents.json` as the run's live,
 * reusable `senior-frontend`, so the reuse gate went on to demand continuation of
 * an agent that no longer existed.
 */
test('a top-level brief quoting a retired id registers nothing, and a real result still registers', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-top-level-brief');
    const dead = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const live = 'bff46cd7-3681-4cf0-adcf-263bf55cc301';
    const brief = `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${dead} was retired. Resume from what it finished.`;

    const leaked = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium' },
      description: brief,
      output: 'The subagent started.',
    }, 'cursor'));
    assert.equal(leaked.kind, 'noop');
    assert.equal(
      readRunAgentRegistry(cwd, 'run-top-level-brief')['senior-frontend'],
      undefined,
      'the id the top-level brief quoted must not become this run live agent',
    );

    recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium' },
      description: brief,
      output: `Agent ID: ${live} — replacement running.`,
    }, 'cursor'));
    assert.equal(
      readRunAgentRegistry(cwd, 'run-top-level-brief')['senior-frontend']?.agentId,
      live,
      'and the replacement the RESULT reports is still recorded, brief or no brief',
    );
  });
});

/**
 * The FIRST-SPAWN case, end to end, on the host where every consequence lands at
 * once. No marker, no dead agent, no incident anywhere — an ordinary product brief
 * that happens to describe what the UI should do when the provider rate-limits it,
 * and a result that says in so many words that the child is RUNNING.
 *
 * Measured before this round, for four of the five brief spellings (`prompt` was
 * already covered by name in `TOOL_INPUT_KEYS`): the live subagent was marked
 * `replaced` in `.traffic-one/runs/<runId>/agents.json`, the hook returned a
 * respawn directive while the real child kept working, and `composer-2.5-fast` was
 * written into the run's exhaustion ledger — so model rotation moved off a model
 * that never hit a limit. Three harms from one misread string.
 */
test('an ordinary first-spawn brief that mentions an API limit retires nothing and condemns no model', () => {
  const retired: string[] = [];
  // Every POSITION, not only the one this test was written for. Driven end to end
  // because the unit answer and the harm are two different measurements: the
  // array position classified `api-limit` at the unit AND, through the recorder,
  // marked the live agent replaced and wrote `composer-2.5-fast` into the run's
  // exhaustion ledger. The nested position is the control that was always green.
  for (const position of BRIEF_POSITIONS) {
    for (const key of SPAWN_BRIEF_KEYS) {
      withMaterialized({ teamApproved: true }, (cwd) => {
        setCurrentRunId(cwd, 'run-first-spawn-brief');
        freezeRunPolicy(cwd, 'copilot', 'run-first-spawn-brief');
        recordRunAgent(cwd, 'run-first-spawn-brief', 'senior-frontend', {
          agentId: 'copilotchild12345', resumeId: 'copilotchild12345', parentSessionId: 'parent-1',
        });

        const nested = position === 'nested under the input key';
        const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
          tool_input: {
            agent_type: 'traffic-one:senior-frontend',
            model: 'composer-2.5-fast',
            ...(nested ? { [key]: FIRST_SPAWN_BRIEF } : {}),
          },
          ...(position === 'at the payload top level' ? { [key]: FIRST_SPAWN_BRIEF } : {}),
          ...(position === 'behind an array' ? { steps: [{ [key]: FIRST_SPAWN_BRIEF }] } : {}),
          execution_record: { status: 'running' },
        }, 'copilot', 'task'));

        const row = readRunAgentRegistry(cwd, 'run-first-spawn-brief')['senior-frontend'];
        const exhausted = exhaustedModelsForRole(cwd, 'run-first-spawn-brief', 'senior-frontend');
        if (result.kind !== 'noop' || row?.replaced || exhausted.length) {
          retired.push(`${position} ${key} → ${result.kind}, replaced=${String(row?.replaced)}, exhausted=${JSON.stringify(exhausted)}`);
        }
        assert.equal(row?.agentId, 'copilotchild12345', `${position} ${key}: the live agent keeps its row`);
      });
    }
  }
  assert.deepEqual(retired, [], 'a live agent was retired, or a model condemned, by a product brief');
});

/**
 * The two harms an array position reached that no exclusion covered, end to end
 * on the hosts they land on, and the one a nested BARE error reached with nothing
 * failed anywhere. All three were measured through this recorder by a peer review
 * of the previous round; each writes to a different durable place.
 */
test('a brief behind an array registers no corpse, and a nested warning condemns no model', () => {
  const DEAD = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

  // 1. The id, from a Cursor `content[]` tool_use block — the one array shape
  //    this tree documents arriving there, since the adapter passes `raw: data`
  //    through verbatim. Before this round the registry held the retired id.
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-array-brief-cursor');
    const brief = `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${DEAD} was retired. Resume from what it finished.`;
    const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium' },
      content: [{ type: 'tool_use', name: 'Task', input: { prompt: brief } }],
      output: 'The subagent started.',
    }, 'cursor'));
    assert.equal(result.kind, 'noop');
    assert.equal(
      readRunAgentRegistry(cwd, 'run-array-brief-cursor')['senior-frontend'],
      undefined,
      'an id quoted inside a content[] block is still an id the brief is retiring',
    );
  });

  // 2. The id again, from a Copilot step list.
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-array-brief-copilot');
    const brief = `${REPLACE_AGENT_MARKER}\nThe previous agent (agent_id: senior-frontend-old, Agent ID: ${DEAD}) was retired. Continue.`;
    recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: { agent_type: 'traffic-one:senior-frontend', model: 'composer-2.5-fast' },
      execution_record: { status: 'running', steps: [{ message: brief }] },
    }, 'copilot', 'task'));
    assert.equal(
      readRunAgentRegistry(cwd, 'run-array-brief-copilot')['senior-frontend'],
      undefined,
      'nor may a step list hand the corpse back as this run live agent',
    );
  });

  // 3. The nested bare error: nothing failed, the child is explicitly running,
  //    and a live agent was retired while an innocent model was condemned.
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-bare-error');
    freezeRunPolicy(cwd, 'copilot', 'run-bare-error');
    recordRunAgent(cwd, 'run-bare-error', 'senior-frontend', {
      agentId: 'copilotchild12345', resumeId: 'copilotchild12345', parentSessionId: 'parent-1',
    });
    const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: { agent_type: 'traffic-one:senior-frontend', model: 'composer-2.5-fast' },
      metadata: { error: 'a deprecation warning', message: FIRST_SPAWN_BRIEF },
      execution_record: { status: 'running' },
    }, 'copilot', 'task'));
    const row = readRunAgentRegistry(cwd, 'run-bare-error')['senior-frontend'];
    assert.equal(result.kind, 'noop', 'a deprecation warning is not the tool call failing');
    assert.notEqual(row?.replaced, true, 'the live agent keeps its registry row');
    assert.deepEqual(
      exhaustedModelsForRole(cwd, 'run-bare-error', 'senior-frontend'),
      [],
      'and a model that never hit a limit is not written into the exhaustion ledger',
    );
  });
});

/**
 * The Cursor mirror of the row above, which lands in the DURABLE observation
 * ledger rather than in a per-run registry — the `cursor-crash-misclassified`
 * defect this lane already closed once, arriving from the other side.
 *
 * The child really did crash, and nothing in the RESULT names a limit. Measured
 * before this round, two runs byte-identical but for where the brief sat recorded
 * `generic` with the brief nested and `api-limit` with it at the top level, and the
 * second wrote `gpt-5.6-terra-medium` into the exhaustion ledger.
 */
test('a crash whose brief mentions a limit is not an API limit, wherever the brief sits', () => {
  const wrong: string[] = [];
  // The fourth case is not a position but the ECHO, and it is here because this
  // is where the wiring lands: `recordSpawnedAgent` is the only caller that has
  // the spawn input to compare the result against, so dropping that argument at
  // the call site would leave every unit row green. The brief sits under
  // `message`, the one spelling a decisive record keeps, beside a real crash —
  // the residual cell exactly — and the input carries it because the host echoed
  // it. Without the echo read, this run records `api-limit` and condemns
  // `gpt-5.6-terra-medium` in the durable ledger for a crash that named no limit.
  for (const position of [...BRIEF_POSITIONS, 'echoed from the spawn input'] as const) {
    const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    try {
      withMaterialized({ teamApproved: true, level: 'high' }, (cwd) => {
        setCurrentRunId(cwd, 'run-brief-crash');
        freezeRunPolicy(cwd, 'cursor', 'run-brief-crash');
        const toolCallId = 'tool_11111111-1111-4111-8111-111111111111';
        observeCursorSpawn(cwd, 'run-brief-crash', 'senior-frontend', 'gpt-5.6-terra-medium', 'highest', CURSOR_HIGHEST_FAMILY, toolCallId);
        recordRunAgent(cwd, 'run-brief-crash', 'senior-frontend', {
          agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301', toolCallId, parentSessionId: 'parent-1',
        });

        const nested = position === 'nested under the input key';
        const echoed = position === 'echoed from the spawn input';
        recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
          tool_call_id: toolCallId,
          tool_input: {
            subagent_type: 'senior-frontend',
            model: 'gpt-5.6-terra-medium',
            ...(nested || echoed ? { description: FIRST_SPAWN_BRIEF } : {}),
          },
          ...(position === 'at the payload top level' ? { description: FIRST_SPAWN_BRIEF } : {}),
          ...(position === 'behind an array' ? { steps: [{ description: FIRST_SPAWN_BRIEF }] } : {}),
          ...(echoed ? { message: FIRST_SPAWN_BRIEF } : {}),
          ...CRASHED_NO_LIMIT,
        }, 'cursor'));

        const durable = listCursorSpawnObservations(cwd, 'run-brief-crash')[0];
        const exhausted = exhaustedModelsForRole(cwd, 'run-brief-crash', 'senior-frontend');
        if (durable?.outcome !== 'generic' || exhausted.length) {
          wrong.push(`[${position}] outcome=${String(durable?.outcome)} exhausted=${JSON.stringify(exhausted)}`);
        }
        // The crash itself is still a crash: the agent is retired either way, and
        // only the KIND — which is what rotates models — was at stake.
        assert.equal(readRunAgentRegistry(cwd, 'run-brief-crash')['senior-frontend']?.replaced, true, `${position}: the dead agent is still retired`);
      });
    } finally {
      if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
      else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    }
  }
  assert.deepEqual(wrong, [], 'the durable ledger condemned a model over a spawn brief');
});

/**
 * TWO ROTATIONS, which is the shape a discriminator reading the spawn input can
 * break — and did.
 *
 * The recorder's own api-limit directive tells the orchestrator to re-send the
 * task with the replacement marker, and a respawn prompt therefore names the
 * incident it is respawning from; `REPLACEMENT_BRIEF` above is this suite's
 * standing example and `replacementJustified` in model-rotation.ts accepts a
 * prompt on that vocabulary. So limit #2 always arrives with limit vocabulary in
 * the INPUT. Measured end to end before this round, with the echo discriminator
 * comparing the result string against every input string by containment: limit #1
 * classified `api-limit` and wrote its model into the ledger, and limit #2 — same
 * host, byte-identical result — classified `stopped` and wrote nothing, so the
 * next fallback was chosen as if only one model had ever been exhausted. It
 * degraded once per rotation, in the direction that re-picks a model already out
 * of budget.
 *
 * Driven through `recordSpawnedAgent` rather than the unit, because the wiring is
 * half the defect: the recorder is the only caller that has a spawn input to
 * compare against, and the ledger is where the damage shows.
 */
test('a second API limit condemns its own model, even when the respawn brief quotes the first', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const runId = 'run-rotate-twice';
    setCurrentRunId(cwd, runId);
    freezeRunPolicy(cwd, 'copilot', runId);
    // The host's own limit envelope, unchanged between the two rotations.
    const limit = {
      status: 'error',
      message: 'API usage limit',
      execution_record: { status: 'error', agent_id: 'copilotchild12345' },
    };
    const rotate = (brief: string, model: string): HookResult => {
      recordRunAgent(cwd, runId, 'senior-frontend', {
        agentId: 'copilotchild12345', resumeId: 'copilotchild12345', parentSessionId: 'parent-1', model,
      });
      return recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
        tool_input: { agent_type: 'traffic-one:senior-frontend', model, prompt: brief },
        ...limit,
      }, 'copilot', 'task'));
    };

    const first = rotate('Build the billing screen and wire the checkout button.', 'composer-2.5-fast');
    assert.equal(first.kind, 'context', 'the first limit tells the orchestrator to respawn');
    assert.deepEqual(
      exhaustedModelsForRole(cwd, runId, 'senior-frontend'),
      ['composer-2.5-fast'],
      'the first limit condemns the model that hit it',
    );

    const second = rotate(REPLACEMENT_BRIEF, 'gpt-5.6-terra-medium');
    assert.equal(second.kind, 'context', 'the second limit tells the orchestrator to respawn too');
    assert.deepEqual(
      exhaustedModelsForRole(cwd, runId, 'senior-frontend').slice().sort(),
      ['composer-2.5-fast', 'gpt-5.6-terra-medium'],
      'the ledger stopped growing on the respawn the product prescribes',
    );
  });
});

/**
 * The harm, end to end, on the host where the defect lands hardest. No registry
 * row exists for the role; the orchestrator re-sends the task with the
 * replacement marker, quoting the id it was told to retire, and the result names
 * no agent at all. Before the narrowing the recorder read the quoted corpse out
 * of the prompt and wrote it as this run's LIVE senior-frontend, so the reuse gate
 * went on to demand continuation of a dead agent.
 */
test('a replacement spawn whose prompt quotes the retired id registers nothing', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-quoted-corpse');
    const dead = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: {
        subagent_type: 'senior-frontend',
        model: 'gpt-5.6-terra-medium',
        prompt: `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${dead} was retired. Resume from what it finished.`,
      },
      output: 'The subagent started.',
    }, 'cursor'));
    assert.equal(result.kind, 'noop');
    assert.equal(
      readRunAgentRegistry(cwd, 'run-quoted-corpse')['senior-frontend'],
      undefined,
      'the id the prompt quoted must not become this run live agent',
    );

    // Same spawn, same prompt, and this time the result really does report the
    // replacement: the row is written, from the result.
    const live = 'bff46cd7-3681-4cf0-adcf-263bf55cc301';
    recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: {
        subagent_type: 'senior-frontend',
        model: 'gpt-5.6-terra-medium',
        prompt: `${REPLACE_AGENT_MARKER}\nThe previous Agent ID: ${dead} was retired. Resume from what it finished.`,
      },
      output: `Agent ID: ${live} — replacement running.`,
    }, 'cursor'));
    assert.equal(readRunAgentRegistry(cwd, 'run-quoted-corpse')['senior-frontend']?.agentId, live);
  });
});

/**
 * Copilot's result field is an ASSUMPTION — the disclosure at the head of
 * shared/tool-result.ts records what that rests on. Four constructions exist
 * across this tree spanning three incompatible envelope families (the fourth,
 * the bare `toolTelemetry` in the extractor's own unit row above, is a direct
 * call rather than a host payload, so it implies no fourth family), and that
 * spread is the evidence that nobody knows. This does not promote one; it pins
 * that the extractor cannot tell them apart, which is what makes the guess
 * survivable: the reader excludes the input by name and takes whatever remains,
 * so the envelope's name is never consulted.
 */
test('the three constructed Copilot result shapes are indistinguishable to the id extractor', () => {
  const telemetry = { toolTelemetry: { restrictedProperties: { agent_id: 'senior-frontend' } } };
  const shapes: { label: string; envelope: Record<string, unknown> }[] = [
    { label: 'tool_response wrapper (this file Copilot reuse test)', envelope: { tool_response: telemetry } },
    { label: 'execution_record envelope (this file Copilot stop tests)', envelope: { execution_record: telemetry } },
    { label: 'flat tool_output key (tool-result.test.ts, page-speed.test.ts)', envelope: { tool_output: telemetry } },
  ];
  for (const shape of shapes) {
    const raw = rawFromHost('copilot', ['after-tool-use'], {
      hook_event_name: 'PostToolUse', tool_name: 'task',
      tool_args: JSON.stringify({
        agent_type: 'traffic-one:senior-frontend',
        prompt: `${REPLACE_AGENT_MARKER}\nagent_id: senior-frontend-old was retired.`,
      }),
      ...shape.envelope,
    });
    assert.equal(extractSpawnedAgentId(toolResultPayload(raw)), 'senior-frontend', shape.label);
  }
});

/**
 * The same contamination one layer down. The Cursor branch persists the classified
 * text as the observation's `error`, and the durable ledger re-runs
 * classifyModelFailureText over it whenever the row has no outcome yet — so a
 * prompt reaching THAT text condemns the model in the ledger even after the
 * classifier itself answered `stopped`.
 */
test('the durable Cursor observation records the result kind, not the prompt kind', () => {
  withMaterialized({ teamApproved: true, level: 'high' }, (cwd) => {
    setCurrentRunId(cwd, 'run-prompt-kind');
    freezeRunPolicy(cwd, 'cursor', 'run-prompt-kind');
    observeCursorSpawn(
      cwd,
      'run-prompt-kind',
      'senior-frontend',
      'gpt-5.6-terra-medium',
      'highest',
      CURSOR_HIGHEST_FAMILY,
      'tool_88888888-8888-4888-8888-888888888888',
    );
    recordRunAgent(cwd, 'run-prompt-kind', 'senior-frontend', {
      agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301',
      toolCallId: 'tool_88888888-8888-4888-8888-888888888888',
      parentSessionId: 'parent-1',
    });

    const result = recordSpawnedAgent(postSpawnCtxRawResult(cwd, {
      tool_input: { subagent_type: 'senior-frontend', model: 'gpt-5.6-terra-medium', prompt: LIMIT_IN_PROMPT },
      status: 'error',
      output: 'Agent ID: bff46cd7-3681-4cf0-adcf-263bf55cc301 — the child crashed.',
      exit_code: 1,
    }, 'cursor'));
    assert.equal(result.kind, 'noop');

    const durable = listCursorSpawnObservations(cwd, 'run-prompt-kind')[0];
    assert.equal(durable?.outcome, 'generic', 'a crash whose PROMPT mentions a limit is not an API-limit outcome');
    assert.deepEqual(
      exhaustedModelsForRole(cwd, 'run-prompt-kind', 'senior-frontend'),
      [],
      'and no model is retired from the run on the strength of its own task brief',
    );
    assert.ok(
      !(durable?.error || '').includes('retry banner'),
      'the persisted failure text is the result, not the spawn prompt',
    );
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
      CURSOR_HIGHEST_FAMILY,
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
    assert.ok(durable.directive?.includes(CURSOR_HIGHEST_FAMILY), 'enable/retry points back to the original tier recommendation');
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
      CURSOR_HIGHEST_FAMILY,
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
    assert.ok(old?.directive?.includes(CURSOR_HIGHEST_SLUG), 'old immutable highest-tier anchor wins over current balanced state');
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
      // CHANGED GUARD — was `assert.match(duplicate.reason, /Retry after the
      // child rollout is flushed/)`. That sentence offered ONE cause as the
      // entire explanation, and this deny is also reached with
      // `codex-registry-evidence-lock-unavailable`, where nothing is flushing
      // and the operator sent to wait on a rollout waits for an event that
      // already happened. Both causes are pinned rather than one, so the prose
      // cannot silently drop either half again, and the retry prescription the
      // old assertion protected is still required to be present.
      assert.match(duplicate.reason, /a child rollout that has not flushed yet/);
      assert.match(duplicate.reason, /a registry row another process held while this hook ran/);
      assert.match(duplicate.reason, /clear without your intervention/);
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

// CHANGED BEHAVIOUR (was: 'reuse (Windsurf): records returned agent id and denies
// same-role respawn with run_subagent prose'). Windsurf returns a real agent id, but
// Traffic One has no way to verify that the child behind it is the role the spawn
// profile named, and `read_subagent` is a READ of a running child, not a
// continuation — the old deny's own remedy was "call run_subagent again", i.e. spawn
// fresh. Reuse now stands down and the respawn happens without the detour.
test('reuse (Windsurf): the returned agent id is not recorded as reusable, and a same-role respawn is not denied', () => {
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
    assert.equal(readRunAgentRegistry(cwd, 'run-windsurf-reuse')['senior-frontend'], undefined,
      'the PostToolUse recorder writes no reuse row on Windsurf');

    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      profile: 'senior-frontend',
      prompt: '[t1-role: senior-frontend]\npart 2: admin area',
    }, 'parent-1', 'windsurf'));
    assert.equal(duplicate.kind, 'noop', 'part 2 spawns a fresh child rather than continuing an unverified one');
    // The role is still tracked: the fresh spawn stakes exactly one pending claim
    // in the role-keyed CAS slot, so settlement and scope checks still see it.
    assert.deepEqual(
      fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', 'run-windsurf-reuse', 'pending')),
      ['senior-frontend.json'],
    );
  });
});

// CHANGED BEHAVIOUR (was: 'reuse (Kilo): child binding records the live role and
// blocks a duplicate general task'). Same cause as the OpenCode case above: Kilo
// binds through the identical marker path, has no resumable Task field, and
// additionally carries `noTaskCompletionLifecycle` — a finished child can leave a
// fresh `claimed` record behind, so the row the old deny trusted could name a worker
// that had already exited.
test('reuse (Kilo): child binding claims the role without a reusable agent row, and a duplicate general task is allowed', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    setCurrentRunId(cwd, 'run-kilo-reuse');
    freezeRunPolicy(cwd, 'kilo', 'run-kilo-reuse');
    const prompt = '[t1-role: senior-frontend]\nRead .kilo/agents/senior-frontend.md, then implement the UI.';
    opencodeSubagentBind({
      input: { event: 'UserPromptSubmit', host: 'kilo', cwd, raw: { session_id: 'kilo-child-fe', prompt }, prompt },
      host: 'kilo', cwd, now: () => 'x',
    } as unknown as Ctx);

    assert.equal(readRunAgentRegistry(cwd, 'run-kilo-reuse')['senior-frontend'], undefined,
      'no unverifiable reuse row is written on Kilo');
    assert.equal(
      resolveRunAgentContext(cwd, readEffectiveState(cwd), { session_id: 'kilo-child-fe' }, { claimPending: false })?.role,
      'senior-frontend',
      'the Kilo child still resolves its role from its claim',
    );
    const duplicate = agentModelGate(spawnCtxWithSession(cwd, {
      subagent_type: 'general',
      prompt: '[t1-role: senior-frontend]\nApply the next frontend fix.',
    }, 'kilo-parent', 'kilo'));
    assert.equal(duplicate.kind, 'noop', 'the next fix spawns fresh instead of waiting on an unverified child');
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
    assert.deepEqual(fs.readdirSync(pendingDir), ['senior-architect.json']);
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
          subagent_model: CURSOR_HIGHEST_SLUG,
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
    const dup = agentModelGate(spawnCtxWithSession(cwd, { subagent_type: 'senior-architect', model: CURSOR_HIGHEST_SLUG, prompt: 'continue architecture' }, 'orchestrator-parent', 'cursor'));
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
          subagent_model: CURSOR_HIGHEST_SLUG,
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
      subagent_model: CURSOR_HIGHEST_SLUG,
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
    cursorModels: [CURSOR_HIGHEST_SLUG, 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'],
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

// Each of the three protections below is asserted with the EXIT that ends it.
// They used to stop at the refusal, which is the half that reads as a deadlock:
// "the marker is refused while an agent is live" is also what a gate with no
// way out looks like from the inside, and the orchestrator that hit 9ec3325c
// had no failure vocabulary for the state it was in and no other move to try.
// A protection is only correct if it is bounded, so each row now names the
// bound and drives the identical spawn across it — three of them, which is a
// correction: the round that wrote this comment delivered two and retitled the
// third. The exhaustive product of
// (liveness x structural ground) is enumerated in structural-replacement.test.ts;
// what these three add is that each individual refusal an orchestrator can
// actually hit has a reachable exit at GATE level.

test('reuse: a replace marker without a failure reason is denied — until it carries one', () => {
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

      // THE BOUND. What is missing is the reason, and nothing else: the same
      // marker, the same live agent, the same fresh row, plus the failure the
      // gate is asking to be told about, is admitted. Without this the row
      // above cannot tell "the marker needs a reason" apart from "the marker
      // never works while an agent is recorded", and the second is the state
      // that stranded the build.
      const described = agentModelGate(spawnCtxWithSession(
        cwd,
        {
          subagent_type: 'senior-frontend',
          model: 'opus',
          prompt: 'fresh copy [t1-replace-agent] — its replies show context exhaustion',
        },
        'parent-1',
      ));
      // `equal(…, 'noop')`, not `notEqual(…, 'deny')`: the sibling row above
      // asserts the exit by name, and the loose form admits `context` — a
      // verdict that attaches advice and lets the spawn through is a DIFFERENT
      // exit from a clean one, and an orchestrator reading this row needs to
      // know which of the two it gets.
      assert.equal(described.kind, 'noop', 'a described failure is the exit this refusal is asking for');
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-marker-guard')['senior-frontend']?.replaced, true);
    });
  });
});

// The registry records an agent at SPAWN time, so it can name a "live" agent
// that never bound a role and — once the run's ledger closed — never can. The
// orchestrator has no failure vocabulary for that, so the marker was refused
// forever and the build had no exit. Requires BOTH: no bound claim AND a ledger
// that cannot admit one.
test('reuse: a live agent that never bound a claim in a closed run may be replaced', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-reuse-unbindable');
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-architect', model: 'opus', prompt: 'plan the feature' },
        'agentId: architect11aa22bb33',
        'parent-1',
      ));
      // The run settles terminally before the child ever bound its role.
      assert.ok(transitionRunStatus(cwd, 'run-reuse-unbindable', { status: 'active' }));
      assert.ok(transitionRunStatus(cwd, 'run-reuse-unbindable', { status: 'failed', outcome: 'agent-failed' }));
      assert.equal(runLedgerAdmitsClaims(cwd, 'run-reuse-unbindable'), false);

      const replacement = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-architect', model: 'opus', prompt: 'respawn the architect [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(replacement.kind, 'noop', 'an agent that can never bind must not block its own replacement');
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-unbindable')['senior-architect']?.replaced, true);
    });
  });
});

// The old title for this one — "is still protected (it may just be starting
// up)" — stated the refusal as the whole specification, which is how a cell with
// no exit comes to look intended.
//
// AND FOR ONE ROUND THAT IS ALL THAT CHANGED. This row was retitled and its
// assertions were left byte-identical, so it went on asserting only the refusal
// while the summary said three rows had gained bounds; the true number was two.
// Measured: under the mutation that restores 9ec3325c — the reuse gate never
// honouring a replace marker — three of the five rows in this cluster go red and
// this one stayed green.
test('reuse: a claimless agent in a HEALTHY run is protected while startup is still plausible', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-reuse-startup');
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-frontend', model: 'opus', prompt: 'build UI' },
        'agentId: frontend44cc55dd66',
        'parent-1',
      ));
      assert.ok(transitionRunStatus(cwd, 'run-reuse-startup', { status: 'active' }));
      assert.equal(runLedgerAdmitsClaims(cwd, 'run-reuse-startup'), true);

      const duplicate = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-frontend', model: 'opus', prompt: 'fresh copy [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(duplicate.kind, 'deny');
      if (duplicate.kind === 'deny') {
        assert.ok(duplicate.reason.includes('frontend44cc55dd66'), 'denied BY THE REUSE GATE, not another gate');
      }
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-startup')['senior-frontend']?.replaced, false);

      // THE BOUND, and deliberately not the staleness one. The staleness row
      // below covers the same release over a fixture identical to this one down
      // to the aging step, so re-deriving it here would be that test written
      // twice under another role name. What this cell needs, and had nothing
      // for, is the exit an orchestrator can reach IMMEDIATELY: "it may just be
      // starting up" is answered by saying what went wrong instead of waiting
      // out a window, and that has to work while the ledger is still open and
      // the row is seconds old — which is the entire cell this test is about,
      // and the one cell where `structuralReplacementGround` returns nothing.
      const described = agentModelGate(spawnCtxWithSession(
        cwd,
        {
          subagent_type: 'senior-frontend',
          model: 'opus',
          prompt: 'fresh copy [t1-replace-agent] — its replies show context exhaustion',
        },
        'parent-1',
      ));
      assert.equal(described.kind, 'noop', 'a described failure releases the slot without waiting out staleness');
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-startup')['senior-frontend']?.replaced, true);
      // The control, same as the staleness row's: the ledger is STILL OPEN, so
      // it was the described failure that released the slot and not the run
      // closing underneath the fixture — a different mechanism with the same
      // visible outcome.
      assert.equal(runLedgerAdmitsClaims(cwd, 'run-reuse-startup'), true,
        'it is the described failure that released the role, not the run closing underneath the test');
    });
  });
});

test('reuse: a BOUND agent in a closed run is protected by its claim, not by the closed ledger', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-reuse-bound');
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'build the API' },
        'agentId: backend77ee88ff99',
        'parent-1',
      ));
      // Bind the role while the run is still open, THEN close it.
      assert.ok(transitionRunStatus(cwd, 'run-reuse-bound', { status: 'active' }));
      assert.ok(claimThreadRole(cwd, readEffectiveState(cwd), 'backend77ee88ff99', 'senior-backend', {
        parentSessionId: 'parent-1',
      }));
      assert.ok(transitionRunStatus(cwd, 'run-reuse-bound', { status: 'failed', outcome: 'agent-failed' }));

      const duplicate = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'fresh copy [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(duplicate.kind, 'deny', 'a child that DID bind still owns the role slot');
      if (duplicate.kind === 'deny') {
        assert.ok(duplicate.reason.includes('backend77ee88ff99'), 'denied BY THE REUSE GATE, not another gate');
      }
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-bound')['senior-backend']?.replaced, false);

      // THE BOUND, and the reason this row is no longer titled "only unbindable
      // ones are replaceable": that was never true, and stating it here is what
      // made the deadlock look like the specification. A bound claim in a closed
      // run is the WORST cell to be wrong about — the child can never act again
      // and the ledger can never admit a successor — so it has an exit that does
      // not require the marker's prose. Durable evidence that the model itself
      // is spent, written by the recorder rather than claimed by the prompt,
      // retires the row.
      recordExhaustedModel(cwd, 'run-reuse-bound', 'senior-backend', 'opus');
      const condemned = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'fresh copy [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(condemned.kind, 'noop',
        'a bound agent on a model the run has recorded as spent is not worth protecting');
      assert.equal(readRunAgentRegistry(cwd, 'run-reuse-bound')['senior-backend']?.replaced, true);
      assert.deepEqual(exhaustedModelsForRole(cwd, 'run-reuse-bound', 'senior-backend'), ['opus'],
        'and the ground was the ledger this test wrote, not an accident of the prompt');
    });
  });
});

// The bound on all three protections above. Each of them holds because the row
// is SECONDS old; none of them says a row is protected forever, and it used to
// be: liveRunAgent returned a row whose parentSessionId matched with no
// staleness check at all, and a matching parent is the ordinary case, so the
// window applied only to rows the host had told us least about. A role whose
// agent has been silent for longer than the run stores treat any agent as live
// must be replaceable, or the orchestrator has no way to make progress.
test('reuse: protection is bounded — a role whose agent went silent past the staleness window is replaceable', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      setCurrentRunId(cwd, 'run-reuse-stale');
      recordSpawnedAgent(postSpawnCtx(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'build the API' },
        'agentId: backendaabbccddee',
        'parent-1',
      ));
      assert.ok(transitionRunStatus(cwd, 'run-reuse-stale', { status: 'active' }));
      const registryFile = path.join(cwd, '.traffic-one', 'runs', 'run-reuse-stale', 'agents.json');
      const store = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as {
        agents: Record<string, Record<string, unknown>>;
      };

      // PRECONDITIONS: the row is this parent's (so it takes the branch that had
      // no bound), it is not retired, and while it is fresh it IS protected —
      // the same marker-without-a-reason spawn the cluster above asserts.
      assert.equal(store.agents['senior-backend']!.parentSessionId, 'parent-1');
      assert.equal(store.agents['senior-backend']!.replaced, false);
      const whileFresh = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'fresh copy [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(whileFresh.kind, 'deny', 'PRECONDITION: fresh, so protected');

      store.agents['senior-backend']!.recordedAt = new Date(Date.now() - (SUBAGENT_STALE_MS + 60_000)).toISOString();
      fs.writeFileSync(registryFile, JSON.stringify(store), 'utf8');

      const whileStale = agentModelGate(spawnCtxWithSession(
        cwd,
        { subagent_type: 'senior-backend', model: 'opus', prompt: 'fresh copy [t1-replace-agent]' },
        'parent-1',
      ));
      assert.equal(whileStale.kind, 'noop', 'a silent agent must not hold its role slot for the rest of the run');
      // The control the release needs to mean anything: the ledger is STILL
      // OPEN. Without it this row passes just as happily if the run closed
      // underneath the fixture and some other gate let the spawn through, which
      // is a different mechanism with the same visible outcome.
      assert.equal(runLedgerAdmitsClaims(cwd, 'run-reuse-stale'), true,
        'it is the staleness that released the role, not the run closing underneath the test');
    });
  });
});

test('runLedgerAdmitsClaims mirrors what a worker claim actually attempts', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // No ledger at all reads as `planned` — claims are admitted.
    assert.equal(runLedgerAdmitsClaims(cwd, 'ledger-absent'), true);
    assert.equal(runLedgerAdmitsClaims(cwd, ''), false);

    assert.ok(transitionRunStatus(cwd, 'ledger-active', { status: 'active' }));
    assert.equal(runLedgerAdmitsClaims(cwd, 'ledger-active'), true);

    assert.ok(transitionRunStatus(cwd, 'ledger-blocked', { status: 'active' }));
    assert.ok(transitionRunStatus(cwd, 'ledger-blocked', { status: 'blocked', outcome: 'review-cycle-cap' }));
    assert.equal(runLedgerAdmitsClaims(cwd, 'ledger-blocked'), false);

    assert.ok(transitionRunStatus(cwd, 'ledger-failed', { status: 'active' }));
    assert.ok(transitionRunStatus(cwd, 'ledger-failed', { status: 'failed', outcome: 'agent-failed' }));
    assert.equal(runLedgerAdmitsClaims(cwd, 'ledger-failed'), false);
  });
});

test('an unclaimable Codex child is told WHY: a closed ledger is not a retryable atomic failure', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      freezeRunPolicy(cwd, 'codex');
      const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
      const child = '019f8fa1-4444-7000-8000-00000000004a';
      const transcript = path.join(cwd, `rollout-unclaimable-${child}.jsonl`);
      fs.writeFileSync(
        transcript,
        `${JSON.stringify(codexSessionMeta(child, parentThread, '/root/senior_tester'))}\n`,
        'utf8',
      );

      // Close the run the way a review-cycle cap does, then let a fresh child in.
      assert.ok(transitionRunStatus(cwd, 'run-test', { status: 'active' }));
      assert.ok(transitionRunStatus(cwd, 'run-test', { status: 'blocked', outcome: 'review-cycle-cap' }));

      const denied = codexChildModelGate(
        codexChildPreToolCtx(cwd, child, parentThread, transcript, 'gpt-5.6-terra'),
      );
      assert.equal(denied.kind, 'deny');
      if (denied.kind === 'deny') {
        // Observed 10co: the generic "could not be persisted atomically / replace
        // the child" wording sent the parent into an unbounded replacement loop,
        // because every new thread hit the same closed ledger.
        assert.ok(denied.reason.includes('run ledger'), 'the deny must name the ledger as the cause');
        assert.ok(denied.reason.includes('review-cycle-cap'), 'the deny must name the blocking outcome');
        assert.ok(denied.reason.includes('settlement-v2.json'), 'the deny must name the artefact to check');
        assert.ok(!denied.reason.includes('Retry this tool once'), 'a closed run is not retryable');
        assert.ok(
          !denied.reason.includes('model verification passed but'),
          'a closed run must not be reported as an atomicity failure',
        );
        // The resume it prescribes is legal out of `blocked` ONLY.
        // `runLedgerTransitionAllowed` permits nothing at all out of `completed`
        // or `failed`, so an unqualified "resume the RUN first" hands two of the
        // three terminal statuses a command that is refused when they run it.
        // A status discriminator would double this arm's render space for a
        // difference of one sentence; the arm states the precondition instead.
        assert.ok(denied.reason.includes('resume is legal ONLY out of `blocked`'),
          'the resume must carry its own precondition, or it is prescribed to runs that cannot take it');
        assert.ok(denied.reason.includes('minting a new run is the only remedy'),
          'and the other two statuses must be left with the remedy that does work');
      }
    });
  });
});

// The same gate, on the ledger it could not READ. This arm did not exist: the
// boolean answered `true` for a truncated `run.json`, so an illegible ledger
// fell past the closed-ledger probe and inherited the retry-then-replace-the-
// child prescription from the claim-mint failure below it — an unbounded
// replacement loop against a condition no replacement can clear.
test('an illegible run ledger is its own arm: not closed, and not a retryable claim-mint failure', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    withTeamsEnv(() => {
      freezeRunPolicy(cwd, 'codex');
      const parentThread = '019f69fb-334a-7351-8e94-66c97c3fa908';
      const child = '019f8fa1-4444-7000-8000-00000000004b';
      const transcript = path.join(cwd, `rollout-illegible-${child}.jsonl`);
      fs.writeFileSync(
        transcript,
        `${JSON.stringify(codexSessionMeta(child, parentThread, '/root/senior_tester'))}\n`,
        'utf8',
      );

      assert.ok(transitionRunStatus(cwd, 'run-test', { status: 'active' }));
      const ledger = path.join(cwd, '.traffic-one', 'runs', 'run-test', 'run.json');
      assert.ok(fs.existsSync(ledger), 'fixture guard: the ledger must exist before it is truncated');
      fs.writeFileSync(ledger, '{"status":"act', 'utf8');
      assert.equal(runLedgerAdmitsClaims(cwd, 'run-test'), true,
        'the premise: the boolean this arm used to ask still calls a truncated ledger admitting');

      const denied = codexChildModelGate(
        codexChildPreToolCtx(cwd, child, parentThread, transcript, 'gpt-5.6-terra'),
      );
      assert.equal(denied.kind, 'deny');
      if (denied.kind === 'deny') {
        assert.equal(denied.denyId, 'codex-child-model-ledger-illegible',
          'a distinct id, so the per-target budget and the decision record can tell this apart from a closed run');
        assert.ok(denied.reason.includes('cannot be read or parsed'), 'the deny must name what it is');
        assert.ok(denied.reason.includes('ledger-corrupt'),
          'and the code every transition returns, so an operator can match it against the run log');
        // The three prescriptions this arm must NOT inherit. Each is live text in
        // a sibling arm, so a mutation that renders any of those unconditionally
        // turns these red.
        assert.ok(!denied.reason.includes('Retry this tool once'), 'retrying re-reads the same bytes');
        assert.ok(!denied.reason.includes('run-status.cjs'),
          'a resume is refused with `ledger-corrupt` too — prescribing it sends the orchestrator to a command that cannot work');
        assert.ok(!denied.reason.includes('settle it and mint a new one'),
          'and so is the settle: settling reads the same unparseable file');
        assert.ok(denied.reason.includes('ask the USER'),
          'a deny must end in an action, and no agent may write a run sidecar — so the only terminating action leaves the agent');
      }
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
});

// CHANGED BEHAVIOUR: windsurf/opencode were asserted `true` here (and kilo was not
// covered at all). All three are uncertified hosts with no continuation primitive
// and no verifiable role evidence for a recorded child, so the reuse registry stands
// down: the gate reads nothing and the recorders write nothing.
test('agent reuse stands down on the uncertified hosts that cannot verify a recorded child', async () => {
  const { subagentContinuationAvailable } = await import('../../../shared/state/run-agent');
  for (const host of ['opencode', 'kilo', 'windsurf']) {
    assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv, host), false, host);
    assert.equal(subagentContinuationAvailable({ TRAFFIC_ONE_HOST: host } as NodeJS.ProcessEnv), false, `${host} via env`);
    // The stand-down must be an explicit answer, not a fall-through to the Claude
    // agent-teams flag: these hooks run in whatever environment launched them, and
    // an inherited flag would silently switch the registry back on.
    assert.equal(
      subagentContinuationAvailable({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } as NodeJS.ProcessEnv, host),
      false,
      `${host} with an inherited agent-teams flag`,
    );
    assert.equal(
      subagentContinuationAvailable({ TRAFFIC_ONE_HOST: host, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } as NodeJS.ProcessEnv),
      false,
      `${host} via env with an inherited agent-teams flag`,
    );
  }
  // Certified hosts (and Copilot, which does expose a real `agent_id` continuation)
  // are untouched.
  for (const host of ['codex', 'cursor', 'copilot']) {
    assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv, host), true, host);
  }
});

test('Cursor reuse deny names the Task resume recipe and accepts continuation fields', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // First Cursor spawn passes the gate + mints currentRunId + stakes a claim.
    agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    const runId = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    // Simulate the PostToolUse recorder writing the live-agent registry.
    const rd = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'agents.json'), JSON.stringify({
      version: 1, agents: { 'senior-frontend': { agentId: 'cursor-agent-xyz', recordedAt: new Date().toISOString(), tasks: 1, replaced: false } },
    }));
    // Duplicate Cursor spawn → reuse deny with the Task+resume recipe (NOT SendMessage).
    const d = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG }, 'cursor'));
    assert.equal(d.kind, 'deny');
    if (d.kind === 'deny') {
      assert.ok(d.reason.includes('cursor-agent-xyz'), 'names the live agent id');
      assert.ok(/Task/.test(d.reason) && /resume/.test(d.reason), 'uses the Cursor Task resume recipe');
      assert.ok(!d.reason.includes('SendMessage'), 'no Claude SendMessage on Cursor');
    }
    // The RESUME itself (Task carrying resume) must pass the gate — never block the
    // continuation it just asked for. This makes the deny satisfiable → no soft-loop.
    const resume = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG, resume: 'cursor-agent-xyz' }, 'cursor'));
    assert.equal(resume.kind, 'noop', 'a Cursor Task call carrying resume passes the reuse gate');
    const legacyAgentId = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: CURSOR_HIGHEST_SLUG, agentId: 'cursor-agent-xyz' }, 'cursor'));
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
