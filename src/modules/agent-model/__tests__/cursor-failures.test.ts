import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

import type { Ctx, HookInput } from '../../../core/types';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import {
  listCursorSpawnObservations,
  markCursorSpawnObservationRetryHandled,
  readRunAgentRegistry,
  updateCursorSpawnObservation,
  readEffectiveState,
} from '../../../shared/state';
import {
  ensureRunModelPolicy,
  runModelPolicyPath,
} from '../../../shared/run-model-policy';
import {
  hostScopedPerformancePrefs,
  withCursorAvailableModels,
} from '../../../test-support/host-prefs';
import {
  correlatedCursorFailureGate,
  cursorFailureReconcileHook,
  reconcileCursorSubagentFailures,
  settleCorrelatedCursorRetryOnStart,
} from '../cursor-failures';
import {
  EXHAUSTED_MODEL_TTL_MS,
  exhaustedModelsForRole,
  modelExhaustionTerminalForRole,
  recordExhaustedModel,
} from '../exhausted-models';
import { agentModelGate } from '../handler';
import { modelChoicePrompted, writeModelChoice } from '../model-choice';
import { recordSpawnedAgent } from '../record-agent';
import { subagentStartBind } from '../subagent-bind';

const API_LIMIT_ERROR = 'API usage limit reached Switched to composer-2.5 after reaching API limit.';
const REQUESTED_MODEL = 'gpt-5.6-terra-medium';
const RUN_ID = 'run-cursor-failure-test';
const PARENT_ID = '9c5e9932-478d-4f21-b31e-c7f64f46156b';
const CURSOR_MODELS = [
  REQUESTED_MODEL,
  'claude-sonnet-5-thinking-high',
  'gpt-5.5-medium',
  'claude-4.6-sonnet-thinking',
  'composer-2.5-fast',
  'gpt-5.4-mini',
  'gemini-3.5-flash',
  'claude-4.5-haiku',
];

interface CursorFixture {
  base: string;
  cwd: string;
  cursorRoot: string;
  prefsPath: string;
  parentDir: string;
  subagentsDir: string;
}

function projectCacheKey(cwd: string): string {
  return path.resolve(cwd)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/[/\s:]+/g, '-');
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function freezeCursorPolicy(cwd: string, resetFixturePolicy = false): void {
  if (resetFixturePolicy) fs.rmSync(runModelPolicyPath(cwd, RUN_ID), { force: true });
  const env = { ...process.env, TRAFFIC_ONE_HOST: 'cursor', TRAFFIC_ONE_USER_PLAN: 'pro' };
  const state = readEffectiveState(cwd, env);
  assert.ok(ensureRunModelPolicy(cwd, RUN_ID, 'cursor', state, env));
}

function withCursorFixture<T>(fn: (fixture: CursorFixture) => T): T {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-failure-'));
  const cwd = path.join(base, 'project');
  const cursorRoot = path.join(base, 'cursor-projects');
  const prefsPath = path.join(base, 'preferences.json');
  const statePath = path.join(base, 'machine.json');
  const previous = {
    TRAFFIC_ONE_CURSOR_PROJECTS_DIR: process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    TRAFFIC_ONE_STATE_PATH: process.env.TRAFFIC_ONE_STATE_PATH,
    TRAFFIC_ONE_HOST: process.env.TRAFFIC_ONE_HOST,
    TRAFFIC_ONE_USER_PLAN: process.env.TRAFFIC_ONE_USER_PLAN,
  };

  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), `${JSON.stringify({
    mode: 'existing-codebase',
    stack: 'default',
    onboardingComplete: true,
    currentRunId: RUN_ID,
  })}\n`, 'utf8');

  const prefs = hostScopedPerformancePrefs(
    { level: 'balanced', source: 'prompted' },
    { mode: 'subagents', source: 'prompted', approved: true },
    'pro',
  );
  withCursorAvailableModels(prefs, CURSOR_MODELS, 'pro');
  fs.writeFileSync(prefsPath, `${JSON.stringify(prefs)}\n`, 'utf8');

  const parentDir = path.join(
    cursorRoot,
    projectCacheKey(cwd),
    'agent-transcripts',
    PARENT_ID,
  );
  const subagentsDir = path.join(parentDir, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsPath;
  process.env.TRAFFIC_ONE_STATE_PATH = statePath;
  process.env.TRAFFIC_ONE_HOST = 'cursor';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  freezeCursorPolicy(cwd);

  const cleanup = (): void => {
    restoreEnv('TRAFFIC_ONE_CURSOR_PROJECTS_DIR', previous.TRAFFIC_ONE_CURSOR_PROJECTS_DIR);
    restoreEnv('TRAFFIC_ONE_PROJECT_PREFS_PATH', previous.TRAFFIC_ONE_PROJECT_PREFS_PATH);
    restoreEnv('TRAFFIC_ONE_STATE_PATH', previous.TRAFFIC_ONE_STATE_PATH);
    restoreEnv('TRAFFIC_ONE_HOST', previous.TRAFFIC_ONE_HOST);
    restoreEnv('TRAFFIC_ONE_USER_PLAN', previous.TRAFFIC_ONE_USER_PLAN);
    fs.rmSync(base, { recursive: true, force: true });
  };
  try {
    const result = fn({ base, cwd, cursorRoot, prefsPath, parentDir, subagentsDir });
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return Promise.resolve(result).finally(cleanup) as T;
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function overrideRoleTier(
  fixture: CursorFixture,
  role: 'senior-architect' | 'senior-frontend' | 'senior-backend',
  tier: 'highest' | 'balanced' | 'cheapest',
): void {
  const prefs = JSON.parse(fs.readFileSync(fixture.prefsPath, 'utf8')) as {
    hosts: Record<string, { team?: Record<string, unknown> }>;
  };
  const cursor = prefs.hosts.cursor!;
  const team = cursor.team || {};
  const overrides = team.overrides && typeof team.overrides === 'object'
    ? team.overrides as Record<string, unknown>
    : {};
  cursor.team = { ...team, overrides: { ...overrides, [role]: tier } };
  fs.writeFileSync(fixture.prefsPath, `${JSON.stringify(prefs)}\n`, 'utf8');
  freezeCursorPolicy(fixture.cwd, true);
}

function setCapturedCursorModels(fixture: CursorFixture, models: readonly string[]): void {
  const prefs = JSON.parse(fs.readFileSync(fixture.prefsPath, 'utf8')) as {
    hosts: Record<string, Record<string, unknown>>;
  };
  withCursorAvailableModels(prefs, [...models], 'pro');
  fs.writeFileSync(fixture.prefsPath, `${JSON.stringify(prefs)}\n`, 'utf8');
  freezeCursorPolicy(fixture.cwd, true);
}

function ctxFor(
  cwd: string,
  event: HookInput['event'],
  raw: Record<string, unknown> = {},
): Ctx {
  const input: HookInput = {
    event,
    host: 'cursor',
    cwd,
    workspaceRoot: cwd,
    raw,
  };
  return { input, host: 'cursor', cwd, now: () => 'x' } as unknown as Ctx;
}

function startSubagent(
  cwd: string,
  role: 'senior-architect' | 'senior-frontend' | 'senior-backend',
  toolCallId: string,
  model: string = REQUESTED_MODEL,
  startedAtMs: number = Date.now(),
  parentSessionId: string = PARENT_ID,
): void {
  const result = subagentStartBind(ctxFor(cwd, 'SubagentStart', {
    hook_event_name: 'subagentStart',
    session_id: parentSessionId,
    parent_conversation_id: parentSessionId,
    subagent_id: toolCallId,
    subagent_type: role,
    subagent_model: model,
    task: `[t1-role: ${role}] Execute the assigned Traffic One role.`,
    started_at: new Date(startedAtMs).toISOString(),
  }));
  assert.equal(result.kind, 'noop', `expected ${role} SubagentStart to be recorded`);
}

function postToolFailure(
  cwd: string,
  role: 'senior-architect' | 'senior-frontend' | 'senior-backend',
  toolCallId: string,
  error: string = API_LIMIT_ERROR,
) {
  return recordSpawnedAgent(ctxFor(cwd, 'PostToolUse', {
    hook_event_name: 'postToolUse',
    session_id: PARENT_ID,
    parent_conversation_id: PARENT_ID,
    tool_call_id: toolCallId,
    tool_name: 'Task',
    tool_input: {
      subagent_type: role,
      model: REQUESTED_MODEL,
      prompt: `[t1-role: ${role}] Execute the assigned Traffic One role.`,
    },
    tool_response: { status: 'error', error },
  }));
}

function ageRunAgent(
  cwd: string,
  runId: string,
  role: string,
  ageMs: number,
): void {
  const file = path.join(cwd, '.traffic-one', 'runs', runId, 'agents.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  assert.ok(store.agents[role], `expected ${role} registry row`);
  store.agents[role]!.recordedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(store)}\n`, 'utf8');
}

function taskPreflight(
  cwd: string,
  role: 'senior-architect' | 'senior-frontend' | 'senior-backend',
  attemptId: string,
) {
  return agentModelGate({
    input: {
      event: 'PreToolUse',
      host: 'cursor',
      cwd,
      workspaceRoot: cwd,
      raw: {
        hook_event_name: 'preToolUse',
        session_id: PARENT_ID,
        tool_call_id: attemptId,
        tool_name: 'Task',
        tool_input: {
          subagent_type: role,
          model: REQUESTED_MODEL,
          prompt: `[t1-role: ${role}] Execute the assigned Traffic One role.`,
        },
      },
      tool: { class: 'spawn-agent', rawName: 'Task' },
    },
    host: 'cursor',
    cwd,
    now: () => 'x',
  } as Ctx);
}

function waitPast(timestampMs: number): void {
  while (Date.now() <= timestampMs) {
    // Keep this fixture deterministic without the former 2.1s wall-clock sleep.
  }
}

function writeJsonl(file: string, records: readonly Record<string, unknown>[]): void {
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function writeTerminalError(
  fixture: CursorFixture,
  childId: string,
  error: string = API_LIMIT_ERROR,
): string {
  const file = path.join(fixture.subagentsDir, `${childId}.jsonl`);
  writeJsonl(file, [{ type: 'turn_ended', status: 'error', error }]);
  return file;
}

function writeRoleTerminalError(
  fixture: CursorFixture,
  childId: string,
  role: 'senior-architect' | 'senior-frontend' | 'senior-backend',
  error: string,
): string {
  const file = path.join(fixture.subagentsDir, `${childId}.jsonl`);
  writeJsonl(file, [
    { role: 'user', message: { content: `[t1-role: ${role}] Execute the assigned role.` } },
    { type: 'turn_ended', status: 'error', error },
  ]);
  return file;
}

function writeParentRoleTerminalError(
  fixture: CursorFixture,
  parentSessionId: string,
  childId: string,
  role: 'senior-architect' | 'senior-frontend' | 'senior-backend',
  error: string = API_LIMIT_ERROR,
): string {
  const dir = path.join(
    fixture.cursorRoot,
    projectCacheKey(fixture.cwd),
    'agent-transcripts',
    parentSessionId,
    'subagents',
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${childId}.jsonl`);
  writeJsonl(file, [
    { role: 'user', message: { content: `[t1-role: ${role}] Execute the assigned role.` } },
    { type: 'turn_ended', status: 'error', error },
  ]);
  return file;
}

test('Cursor incident: five Task preflights yield three starts and correlate only the two identical roleless API failures', () => {
  withCursorFixture((fixture) => {
    const preflights = [];

    preflights.push(taskPreflight(fixture.cwd, 'senior-architect', 'attempt_architect'));
    assert.notEqual(preflights.at(-1)?.kind, 'deny');
    startSubagent(fixture.cwd, 'senior-architect', 'tool_architect');

    // Create the roleless child before the later starts, but leave it
    // non-terminal while their Task preflights run. Rewriting the same inode to
    // the terminal incident payload below preserves its birthtime, so the test
    // exercises birthtime correlation without sleeping for 2.1 seconds.
    const architectTranscript = path.join(fixture.subagentsDir, 'child-architect-error.jsonl');
    writeJsonl(architectTranscript, [
      { role: 'assistant', message: { content: 'Starting.' } },
    ]);
    const architectBirth = fs.statSync(architectTranscript).birthtimeMs;
    assert.ok(architectBirth > 0);
    const laterStartedAt = architectBirth + 1_501;

    preflights.push(taskPreflight(fixture.cwd, 'senior-frontend', 'attempt_frontend'));
    assert.notEqual(preflights.at(-1)?.kind, 'deny');
    startSubagent(fixture.cwd, 'senior-frontend', 'tool_frontend', REQUESTED_MODEL, laterStartedAt);

    preflights.push(taskPreflight(fixture.cwd, 'senior-backend', 'attempt_backend'));
    assert.notEqual(preflights.at(-1)?.kind, 'deny');
    startSubagent(fixture.cwd, 'senior-backend', 'tool_backend', REQUESTED_MODEL, laterStartedAt + 1);

    // These are the two reuse-gate denials from the incident. Because Cursor
    // never emitted SubagentStart for them, the fixture deliberately creates no
    // observation and no child transcript for either attempt.
    preflights.push(taskPreflight(fixture.cwd, 'senior-architect', 'attempt_architect_denied'));
    preflights.push(taskPreflight(fixture.cwd, 'senior-backend', 'attempt_backend_denied'));
    assert.equal(preflights.length, 5);
    assert.deepEqual(
      preflights.map((result) => result.kind === 'deny'),
      [false, false, false, true, true],
    );

    // One filesystem tick is enough for the later children to fall inside the
    // scanner's 1.5s early tolerance while the older architect child stays just
    // outside it for those starts.
    waitPast(Math.ceil(architectBirth) + 2);
    const frontendTranscript = path.join(fixture.subagentsDir, 'child-frontend.jsonl');
    writeJsonl(frontendTranscript, [
      { role: 'user', message: { content: '[t1-role: senior-frontend] Build the UI.' } },
      { role: 'assistant', message: { content: 'Working.' } },
    ]);
    const backendTranscript = writeTerminalError(fixture, 'child-backend-error');
    writeTerminalError(fixture, 'child-architect-error');

    const frontendBirth = fs.statSync(frontendTranscript).birthtimeMs;
    const backendBirth = fs.statSync(backendTranscript).birthtimeMs;
    assert.ok(architectBirth > 0 && frontendBirth > 0 && backendBirth > 0);
    assert.ok(frontendBirth > architectBirth && backendBirth > architectBirth);
    assert.equal(
      fs.readFileSync(architectTranscript, 'utf8'),
      fs.readFileSync(backendTranscript, 'utf8'),
      'the two roleless API-limit transcripts reproduce Cursor\'s byte-identical incident payloads',
    );
    assert.deepEqual(
      fs.readdirSync(fixture.subagentsDir).sort(),
      ['child-architect-error.jsonl', 'child-backend-error.jsonl', 'child-frontend.jsonl'],
      'the two denied Task attempts produce no child transcript',
    );

    // Cursor appends to a healthy child for minutes. A deliberately late mtime
    // must not move this role-bearing transcript onto the backend start.
    const lateMtime = new Date(Date.now() + 60_000);
    fs.utimesSync(frontendTranscript, lateMtime, lateMtime);
    assert.ok(fs.statSync(frontendTranscript).mtimeMs > backendBirth);

    // Parent transcript is outside subagents/ and therefore cannot be consumed as
    // a subagent result, even though its terminal status is also an error.
    writeJsonl(path.join(fixture.parentDir, `${PARENT_ID}.jsonl`), [
      { type: 'turn_ended', status: 'error', error: 'User aborted request' },
    ]);

    const result = reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
      workspace_roots: [fixture.cwd],
    }));
    assert.deepEqual(result.ambiguousTranscriptIds, []);
    assert.deepEqual(
      result.processed.map((item) => item.role).sort(),
      ['senior-architect', 'senior-backend'],
    );

    const observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.equal(observations.length, 3, 'only real SubagentStart events prove a model ran');
    assert.deepEqual(
      observations.map((item) => item.toolCallId).sort(),
      ['tool_architect', 'tool_backend', 'tool_frontend'],
      'denied preflights produce no immutable spawn observation',
    );
    assert.ok(observations.every((item) => item.requestedModel === REQUESTED_MODEL));
    assert.ok(!observations.some((item) => /composer/i.test(item.requestedModel)), 'error prose must not manufacture a Composer spawn');

    const byRole = Object.fromEntries(observations.map((item) => [item.role, item]));
    assert.equal(byRole['senior-architect']?.childTranscriptId, 'child-architect-error');
    assert.equal(byRole['senior-backend']?.childTranscriptId, 'child-backend-error');
    assert.equal(byRole['senior-frontend']?.childTranscriptId, 'child-frontend');
    assert.equal(byRole['senior-architect']?.outcome, 'api-limit');
    assert.equal(byRole['senior-backend']?.outcome, 'api-limit');
    assert.equal(byRole['senior-frontend']?.outcome, null);
    assert.equal(byRole['senior-architect']?.prescribedModel, 'claude-sonnet-5-thinking-high');
    assert.equal(byRole['senior-backend']?.prescribedModel, 'claude-sonnet-5-thinking-high');

    assert.deepEqual(exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-architect'), [REQUESTED_MODEL]);
    assert.deepEqual(exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-backend'), [REQUESTED_MODEL]);
    assert.deepEqual(exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-frontend'), []);

    const registry = readRunAgentRegistry(fixture.cwd, RUN_ID);
    assert.equal(registry['senior-architect']?.replaced, true);
    assert.equal(registry['senior-backend']?.replaced, true);
    assert.equal(registry['senior-frontend']?.replaced, false);
  });
});

test('Cursor ambiguity: two roleless errors compatible with two starts condemn and retire neither role', () => {
  withCursorFixture((fixture) => {
    const startedAt = Date.now();
    startSubagent(fixture.cwd, 'senior-architect', 'tool_ambiguous_architect', REQUESTED_MODEL, startedAt);
    startSubagent(fixture.cwd, 'senior-backend', 'tool_ambiguous_backend', REQUESTED_MODEL, startedAt + 1);
    writeTerminalError(fixture, 'child-ambiguous-a');
    writeTerminalError(fixture, 'child-ambiguous-b');

    const result = reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));
    assert.deepEqual(result.processed, []);
    assert.deepEqual([...result.ambiguousTranscriptIds].sort(), ['child-ambiguous-a', 'child-ambiguous-b']);

    const observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.ok(observations.every((item) => item.childTranscriptId === null));
    assert.ok(observations.every((item) => item.outcome === null));
    assert.deepEqual(exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-architect'), []);
    assert.deepEqual(exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-backend'), []);

    const registry = readRunAgentRegistry(fixture.cwd, RUN_ID);
    assert.equal(registry['senior-architect']?.replaced, false);
    assert.equal(registry['senior-backend']?.replaced, false);
  });
});

test('Cursor terminal transcript classifies API limit from error_message and nested errorMessage', () => {
  for (const [index, terminal] of [
    { type: 'turn_ended', status: 'error', error_message: API_LIMIT_ERROR },
    { type: 'turn_ended', status: 'error', error: { errorMessage: API_LIMIT_ERROR } },
  ].entries()) {
    withCursorFixture((fixture) => {
      startSubagent(fixture.cwd, 'senior-backend', `tool_error_message_${index}`);
      writeJsonl(path.join(fixture.subagentsDir, `child-error-message-${index}.jsonl`), [terminal]);
      const [failure] = reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
        session_id: PARENT_ID,
      })).processed;
      assert.equal(failure?.outcome, 'api-limit');
      assert.match(failure?.error || '', /API usage limit reached/i);
      assert.deepEqual(exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-backend'), [REQUESTED_MODEL]);
    });
  }
});

test('Cursor SubagentStart records camelCase and payload parent aliases', () => {
  const cases: Array<{ raw: Record<string, unknown>; expectedParent: string }> = [
    { raw: { parentConversationId: 'parent-camel-case' }, expectedParent: 'parent-camel-case' },
    {
      raw: { payload: { parent_conversation_id: 'parent-from-payload' } },
      expectedParent: 'parent-from-payload',
    },
    {
      raw: { payload: { parentConversationId: 'parent-payload-camel' } },
      expectedParent: 'parent-payload-camel',
    },
  ];
  for (const [index, item] of cases.entries()) {
    withCursorFixture((fixture) => {
      const result = subagentStartBind(ctxFor(fixture.cwd, 'SubagentStart', {
        hook_event_name: 'subagentStart',
        session_id: 'fallback-session-that-must-not-win',
        subagent_id: `tool_parent_alias_${index}`,
        subagent_type: 'senior-backend',
        subagent_model: REQUESTED_MODEL,
        task: '[t1-role: senior-backend] Execute the assigned role.',
        ...item.raw,
      }));
      assert.equal(result.kind, 'noop');
      const [observation] = listCursorSpawnObservations(fixture.cwd, RUN_ID);
      assert.equal(observation?.parentSessionId, item.expectedParent);
      assert.equal(
        readRunAgentRegistry(fixture.cwd, RUN_ID)['senior-backend']?.parentSessionId,
        item.expectedParent,
      );
    });
  }
});

test('Cursor runtime Settings choice requires positive unavailable vocabulary; network/auth/abort stay generic', () => {
  const cases = [
    {
      error: `Model ${REQUESTED_MODEL} is not enabled for this account.`,
      outcome: 'model-unavailable',
      settings: true,
    },
    { error: 'Network connection reset while calling the API.', outcome: 'generic', settings: false },
    { error: 'ERROR_UNAUTHORIZED: the authentication token expired.', outcome: 'generic', settings: false },
    { error: 'User aborted request', outcome: 'generic', settings: false },
  ] as const;

  for (const [index, expected] of cases.entries()) {
    withCursorFixture((fixture) => {
      startSubagent(fixture.cwd, 'senior-backend', `tool_failure_kind_${index}`);
      writeTerminalError(fixture, `child-failure-kind-${index}`, expected.error);
      const result = reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
        session_id: PARENT_ID,
      }));
      assert.equal(result.processed.length, 1, expected.error);
      const failure = result.processed[0]!;
      assert.equal(failure.outcome, expected.outcome, expected.error);
      if (expected.settings) {
        assert.match(failure.directive || '', /Settings\s*→\s*Models/i);
        assert.match(failure.directive || '', /\*\*enable\*\*/i);
        assert.match(failure.directive || '', /\*\*fallback\*\*/i);
      } else {
        assert.doesNotMatch(failure.directive || '', /Settings\s*→\s*Models/i, expected.error);
      }
      assert.deepEqual(exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-backend'), []);
    });
  }
});

test('concurrent explicit model-unavailable failures never prescribe either failed model to the other role', () => {
  withCursorFixture((fixture) => {
    const sonnet = 'claude-sonnet-5-thinking-high';
    const startedAt = Date.now();
    startSubagent(fixture.cwd, 'senior-architect', 'tool_unavailable_terra', REQUESTED_MODEL, startedAt);
    startSubagent(fixture.cwd, 'senior-backend', 'tool_unavailable_sonnet', sonnet, startedAt + 1);
    writeRoleTerminalError(
      fixture,
      'child-unavailable-terra',
      'senior-architect',
      `Model ${REQUESTED_MODEL} is not enabled for this account.`,
    );
    writeRoleTerminalError(
      fixture,
      'child-unavailable-sonnet',
      'senior-backend',
      `Model ${sonnet} is unavailable for this account.`,
    );

    const result = reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));
    assert.equal(result.processed.length, 2);
    const byRole = Object.fromEntries(result.processed.map((item) => [item.role, item]));

    assert.equal(byRole['senior-architect']?.outcome, 'model-unavailable');
    assert.equal(byRole['senior-backend']?.outcome, 'model-unavailable');
    assert.equal(byRole['senior-architect']?.prescribedModel, 'gpt-5.5-medium');
    assert.equal(byRole['senior-backend']?.prescribedModel, 'gpt-5.5-medium');
    assert.notEqual(byRole['senior-architect']?.prescribedModel, sonnet);
    assert.notEqual(byRole['senior-backend']?.prescribedModel, REQUESTED_MODEL);
  });
});

test('Cursor stop emits one followup for a correlated failure and suppresses it after parent user abort', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_stop_once');
    writeTerminalError(fixture, 'child-stop-once');

    const first = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    }));
    assert.equal(first.kind, 'context');
    if (first.kind === 'context') {
      assert.match(first.followupMessage || '', /claude-sonnet-5-thinking-high/);
      assert.match(first.followupMessage || '', /senior-backend/);
    }
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    })).kind, 'noop', 'the same correlated result can enqueue only one continuation');
  });

  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_stop_aborted');
    writeTerminalError(fixture, 'child-stop-aborted');
    const stopped = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
      status: 'aborted',
    }));
    assert.equal(stopped.kind, 'noop');
    const observation = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(observation.outcome, 'api-limit', 'reconciliation remains durable even when continuation is suppressed');
    assert.equal(observation.followupEmitted, false);
  });

  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_stop_parent_transcript_abort');
    writeTerminalError(fixture, 'child-stop-parent-transcript-abort');
    writeJsonl(path.join(fixture.parentDir, `${PARENT_ID}.jsonl`), [
      { type: 'turn_ended', status: 'error', error: 'User aborted request' },
    ]);
    const stopped = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    }));
    assert.equal(stopped.kind, 'noop');
    const observation = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(observation.outcome, 'api-limit');
    assert.equal(observation.followupEmitted, false, 'the parent transcript abort suppresses continuation');
  });
});

test('Cursor lifecycle followup is scoped to the correlated parent and SubagentStop can deliver it', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_scoped_subagent_stop');
    writeTerminalError(fixture, 'child-scoped-subagent-stop');
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    const unrelated = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: 'another-parent-session',
    }));
    assert.equal(unrelated.kind, 'noop', 'an unrelated parent Stop must not claim this continuation');
    assert.equal(
      listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]?.followupEmitted,
      false,
    );

    const subagentStop = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'SubagentStop', {
      session_id: PARENT_ID,
      parent_conversation_id: PARENT_ID,
      subagent_id: 'tool_scoped_subagent_stop',
    }));
    assert.equal(subagentStop.kind, 'context');
    if (subagentStop.kind === 'context') {
      assert.match(subagentStop.followupMessage || '', /senior-backend/);
      assert.match(subagentStop.followupMessage || '', /claude-sonnet-5-thinking-high/);
    }
    assert.equal(
      listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]?.followupEmitted,
      true,
    );
  });
});

test('Cursor PostTool failure persists only and the next Stop owns delivery exactly once', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_posttool_then_stop');

    assert.equal(
      postToolFailure(fixture.cwd, 'senior-backend', 'tool_posttool_then_stop').kind,
      'noop',
      'PostTool cannot bypass complete-parent delivery ownership',
    );
    let observation = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(observation.outcome, 'api-limit');
    assert.ok(observation.consumedAtMs);
    assert.ok(observation.directive);
    assert.equal(observation.followupEmitted, false);

    const stop = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    }));
    assert.equal(stop.kind, 'context');
    if (stop.kind === 'context') {
      assert.match(stop.followupMessage || '', /senior-backend/);
      assert.match(stop.followupMessage || '', /claude-sonnet-5-thinking-high/);
    }
    observation = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(observation.followupEmitted, true);
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    })).kind, 'noop', 'the PostTool result cannot be delivered a second time');
  });
});

test('two Cursor PostTool failures stay silent until one combined parent Stop batch', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-architect', 'tool_posttool_batch_architect');
    startSubagent(fixture.cwd, 'senior-backend', 'tool_posttool_batch_backend');

    assert.equal(
      postToolFailure(fixture.cwd, 'senior-architect', 'tool_posttool_batch_architect').kind,
      'noop',
    );
    assert.equal(
      postToolFailure(fixture.cwd, 'senior-backend', 'tool_posttool_batch_backend').kind,
      'noop',
    );
    let observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.equal(observations.length, 2);
    assert.ok(observations.every((observation) => (
      observation.outcome === 'api-limit'
      && Boolean(observation.consumedAtMs)
      && observation.followupEmitted === false
    )));

    const stop = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    }));
    assert.equal(stop.kind, 'context');
    if (stop.kind === 'context') {
      assert.match(stop.followupMessage || '', /senior-architect/);
      assert.match(stop.followupMessage || '', /senior-backend/);
    }
    observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.ok(observations.every((observation) => observation.followupEmitted));
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    })).kind, 'noop');
  });
});

test('non-lifecycle delivery requires one coherent parent identity', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_context_parent_conflict');
    writeRoleTerminalError(
      fixture,
      'child-context-parent-conflict',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    const conflicted = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      parent_conversation_id: PARENT_ID,
      payload: { parentConversationId: 'contradictory-parent' },
      workspace_roots: [fixture.cwd],
    }));
    assert.equal(conflicted.kind, 'noop', 'contradictory parent ids allow reconciliation but not delivery');
    let observation = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(observation.outcome, 'api-limit');
    assert.equal(observation.followupEmitted, false);

    const coherent = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      parent_conversation_id: PARENT_ID,
      workspace_roots: [fixture.cwd],
    }));
    assert.equal(coherent.kind, 'context');
    observation = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(observation.followupEmitted, true);
  });
});

test('a prescribed retry is settled only by a real SubagentStart on the prescribed slug', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_failed_before_retry');
    writeTerminalError(fixture, 'child-before-retry');
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    let failed = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(failed.prescribedModel, 'claude-sonnet-5-thinking-high');
    assert.equal(failed.retryHandled, false);

    const accepted = correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      failed.prescribedModel!,
    );
    assert.equal(accepted, null, 'preflight accepts the exact prescription');
    failed = listCursorSpawnObservations(fixture.cwd, RUN_ID)
      .find((item) => item.toolCallId === 'tool_failed_before_retry')!;
    assert.equal(failed.retryHandled, false, 'PreToolUse acceptance is not proof the model ran');

    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_real_prescribed_retry',
      failed.prescribedModel!,
    );
    const observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.equal(
      observations.find((item) => item.toolCallId === 'tool_failed_before_retry')?.retryHandled,
      true,
    );
    assert.equal(
      observations.find((item) => item.toolCallId === 'tool_real_prescribed_retry')?.requestedModel,
      'claude-sonnet-5-thinking-high',
    );
  });
});

test('a correlated Cursor retry requires the exact prescribed slug, not a bare family or alternate slug', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_exact_slug_failure');
    writeTerminalError(fixture, 'child-exact-slug-failure');
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    const failed = listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]!;
    assert.equal(failed.prescribedModel, 'claude-sonnet-5-thinking-high');
    for (const inexact of ['claude-sonnet-5', 'claude-sonnet-5-thinking']) {
      const gate = correlatedCursorFailureGate(
        ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
        fixture.cwd,
        RUN_ID,
        'senior-backend',
        inexact,
      );
      assert.equal(gate?.kind, 'deny', `${inexact} is not the exact captured Cursor slug`);
      assert.equal(
        listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]?.retryHandled,
        false,
      );
    }

    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      failed.prescribedModel!,
    ), null);
    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_exact_slug_retry_start',
      failed.prescribedModel!,
    );
    assert.equal(listCursorSpawnObservations(fixture.cwd, RUN_ID)[0]?.retryHandled, true);
  });
});

test('correlated retry selection is parent-scoped and a real start settles only that parent stream', () => {
  withCursorFixture((fixture) => {
    const otherParent = 'parent-session-b';
    startSubagent(fixture.cwd, 'senior-backend', 'tool_parent_a_failure');
    writeParentRoleTerminalError(
      fixture,
      PARENT_ID,
      'child-parent-a-failure',
      'senior-backend',
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    assert.equal(
      correlatedCursorFailureGate(
        ctxFor(fixture.cwd, 'PreToolUse', {}),
        fixture.cwd,
        RUN_ID,
        'senior-backend',
        REQUESTED_MODEL,
      )?.kind,
      'deny',
      'a missing parent id may use the one unique role parent',
    );

    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_parent_b_failure',
      REQUESTED_MODEL,
      Date.now(),
      otherParent,
    );
    writeParentRoleTerminalError(
      fixture,
      otherParent,
      'child-parent-b-failure',
      'senior-backend',
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: otherParent,
    }));

    assert.equal(
      correlatedCursorFailureGate(
        ctxFor(fixture.cwd, 'PreToolUse', {}),
        fixture.cwd,
        RUN_ID,
        'senior-backend',
        REQUESTED_MODEL,
      ),
      null,
      'a missing parent id is not guessed after two parent streams exist',
    );

    const beforeRetry = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    const parentBFailure = beforeRetry.find((item) => item.toolCallId === 'tool_parent_b_failure')!;
    assert.ok(parentBFailure.prescribedModel);
    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_parent_b_retry',
      parentBFailure.prescribedModel!,
      Date.now(),
      otherParent,
    );

    const afterRetry = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.equal(
      afterRetry.find((item) => item.toolCallId === 'tool_parent_b_failure')?.retryHandled,
      true,
    );
    assert.equal(
      afterRetry.find((item) => item.toolCallId === 'tool_parent_a_failure')?.retryHandled,
      false,
      'the object-form settlement cannot consume the same-role failure from another parent',
    );
    assert.equal(
      correlatedCursorFailureGate(
        ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
        fixture.cwd,
        RUN_ID,
        'senior-backend',
        REQUESTED_MODEL,
      )?.kind,
      'deny',
      'the other parent stream remains independently enforceable',
    );
  });
});

test('the latest finalized row permanently shadows older failures after it is handled', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_old_finalized');
    writeRoleTerminalError(
      fixture,
      'child-old-finalized',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_new_finalized',
      'gpt-5.5-medium',
    );
    writeRoleTerminalError(
      fixture,
      'child-new-finalized',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    assert.ok(markCursorSpawnObservationRetryHandled(
      fixture.cwd,
      RUN_ID,
      'child-new-finalized',
    ));
    assert.equal(
      correlatedCursorFailureGate(
        ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
        fixture.cwd,
        RUN_ID,
        'senior-backend',
        REQUESTED_MODEL,
      ),
      null,
      'handling the head must not resurrect the older unhandled failure',
    );
    const observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.equal(observations.find((item) => item.toolCallId === 'tool_old_finalized')?.retryHandled, false);
  });
});

test('a newer successful terminal row shadows an old failure even after a late old-row update', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_old_failure_before_success');
    writeRoleTerminalError(
      fixture,
      'child-old-failure-before-success',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_new_success',
      'gpt-5.5-medium',
    );
    writeJsonl(path.join(fixture.subagentsDir, 'child-new-success.jsonl'), [
      { role: 'user', message: { content: '[t1-role: senior-backend] Execute the assigned role.' } },
      { type: 'turn_ended', status: 'completed' },
    ]);
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));
    const beforeLateUpdate = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.ok(beforeLateUpdate.find((item) => item.toolCallId === 'tool_new_success')?.consumedAtMs);

    assert.ok(updateCursorSpawnObservation(
      fixture.cwd,
      RUN_ID,
      'child-old-failure-before-success',
      { directive: 'late diagnostic refresh that must not affect start ordering' },
      Date.now() + 60_000,
    ));
    const afterLateUpdate = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    const old = afterLateUpdate.find((item) => item.toolCallId === 'tool_old_failure_before_success')!;
    const success = afterLateUpdate.find((item) => item.toolCallId === 'tool_new_success')!;
    assert.ok(old.updatedAtMs > success.updatedAtMs, 'fixture proves updatedAt now favors the old row');
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      REQUESTED_MODEL,
    ), null, 'immutable startedAt/toolCallId ordering keeps the successful row as head');
  });
});

test('unterminated retries mask finalized failures for 270s, or 90s with durable corroboration', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    writeRoleTerminalError(
      fixture,
      'child-hard-timer-failure',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));
    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'gpt-5.5-medium',
    );

    ageRunAgent(fixture.cwd, RUN_ID, 'senior-backend', 2 * 60 * 1000);
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      REQUESTED_MODEL,
    ), null, 'a signal-less blocker remains live before the 270-second hard timer');

    ageRunAgent(fixture.cwd, RUN_ID, 'senior-backend', 271 * 1000);
    const expiredHardTimer = correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      REQUESTED_MODEL,
    );
    assert.equal(expiredHardTimer?.kind, 'deny', JSON.stringify({
      registry: readRunAgentRegistry(fixture.cwd, RUN_ID)['senior-backend'],
      observations: listCursorSpawnObservations(fixture.cwd, RUN_ID),
      exhausted: exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-backend'),
    }));
    assert.equal(readRunAgentRegistry(fixture.cwd, RUN_ID)['senior-backend']?.replaced, true);
    assert.deepEqual(
      exhaustedModelsForRole(fixture.cwd, RUN_ID, 'senior-backend'),
      [REQUESTED_MODEL],
      'expiring an unterminated blocker retires it without condemning its model',
    );
  });

  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    writeRoleTerminalError(
      fixture,
      'child-grace-timer-failure',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));
    // Reusing a model already present in the durable exhaustion ledger is
    // corroborated evidence for liveness only; the unterminated row itself is
    // never classified or added to the ledger.
    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      REQUESTED_MODEL,
    );

    ageRunAgent(fixture.cwd, RUN_ID, 'senior-backend', 89 * 1000);
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      REQUESTED_MODEL,
    ), null);
    ageRunAgent(fixture.cwd, RUN_ID, 'senior-backend', 91 * 1000);
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      REQUESTED_MODEL,
    )?.kind, 'deny');
  });
});

test('a compatible role transcript upgrades an unterminated start to a durable resume id', () => {
  withCursorFixture((fixture) => {
    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    );
    writeRoleTerminalError(
      fixture,
      'child-resume-old-failure',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_ffffffff-ffff-4fff-8fff-ffffffffffff',
      'gpt-5.5-medium',
    );
    const childId = '123e4567-e89b-42d3-a456-426614174000';
    writeJsonl(path.join(fixture.subagentsDir, `${childId}.jsonl`), [
      { role: 'user', message: { content: '[t1-role: senior-backend] Continue implementation.' } },
      { role: 'assistant', message: { content: 'Working.' } },
    ]);
    ageRunAgent(fixture.cwd, RUN_ID, 'senior-backend', 271 * 1000);

    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', {
        session_id: PARENT_ID,
        workspace_roots: [fixture.cwd],
      }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      REQUESTED_MODEL,
    ), null, 'a real resume UUID keeps the newer child live beyond the hard timer');
    const live = readRunAgentRegistry(fixture.cwd, RUN_ID)['senior-backend'];
    assert.equal(live?.resumeId, childId);
    assert.equal(live?.toolCallId, 'tool_ffffffff-ffff-4fff-8fff-ffffffffffff');
    assert.equal(live?.replaced, false);
  });
});

test('a non-abort SubagentStop claims the parent batch; dual child ids agree and conflicting ids do not', () => {
  withCursorFixture((fixture) => {
    const otherParent = 'unrelated-parent';
    startSubagent(fixture.cwd, 'senior-architect', 'tool_batch_architect');
    startSubagent(fixture.cwd, 'senior-backend', 'tool_batch_backend');
    startSubagent(
      fixture.cwd,
      'senior-frontend',
      'tool_other_parent',
      REQUESTED_MODEL,
      Date.now(),
      otherParent,
    );
    writeRoleTerminalError(
      fixture,
      'child-batch-architect',
      'senior-architect',
      API_LIMIT_ERROR,
    );
    writeRoleTerminalError(
      fixture,
      'child-batch-backend',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    writeParentRoleTerminalError(
      fixture,
      otherParent,
      'child-other-parent',
      'senior-frontend',
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    const conflicting = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'SubagentStop', {
      parent_conversation_id: PARENT_ID,
      tool_call_id: 'tool_batch_backend',
      subagent_id: 'child-batch-architect',
    }));
    assert.equal(conflicting.kind, 'noop');
    assert.ok(listCursorSpawnObservations(fixture.cwd, RUN_ID)
      .filter((item) => item.parentSessionId === PARENT_ID)
      .every((item) => item.followupEmitted === false));

    const combined = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'SubagentStop', {
      parent_conversation_id: PARENT_ID,
      tool_call_id: 'tool_batch_backend',
      subagent_id: 'child-batch-backend',
    }));
    assert.equal(combined.kind, 'context');
    if (combined.kind === 'context') {
      assert.match(combined.followupMessage || '', /senior-architect/);
      assert.match(combined.followupMessage || '', /senior-backend/);
      assert.doesNotMatch(combined.followupMessage || '', /senior-frontend/);
    }
    const observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.ok(observations
      .filter((item) => item.parentSessionId === PARENT_ID)
      .every((item) => item.followupEmitted));
    assert.equal(
      observations.find((item) => item.parentSessionId === otherParent)?.followupEmitted,
      false,
    );
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    })).kind, 'noop', 'the aggregate batch is one-shot across lifecycle event kinds');
  });
});

test('prompt-context and Stop concurrently claim one complete multi-role parent batch', async () => {
  await withCursorFixture(async (fixture) => {
    startSubagent(fixture.cwd, 'senior-architect', 'tool_context_stop_architect');
    startSubagent(fixture.cwd, 'senior-backend', 'tool_context_stop_backend');
    writeRoleTerminalError(
      fixture,
      'child-context-stop-architect',
      'senior-architect',
      API_LIMIT_ERROR,
    );
    writeRoleTerminalError(
      fixture,
      'child-context-stop-backend',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    const source = [
      "const { cursorFailureReconcileHook } = require('./src/modules/agent-model/cursor-failures.ts');",
      'const [event, cwd, parent] = process.argv.slice(1);',
      'const result = cursorFailureReconcileHook({',
      "  input: { event, host: 'cursor', cwd, workspaceRoot: cwd, raw: { session_id: parent, parent_conversation_id: parent, workspace_roots: [cwd] } },",
      "  host: 'cursor', cwd, now: () => 'x',",
      '});',
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n');
    const lockDir = path.join(
      fixture.cwd,
      '.traffic-one',
      'runs',
      RUN_ID,
      '.cursor-spawns.lock',
    );
    fs.mkdirSync(lockDir, { recursive: true });
    let exited = 0;
    const children = ['UserPromptSubmit', 'Stop'].map((event) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import',
        'tsx',
        '-e',
        source,
        event,
        fixture.cwd,
        PARENT_ID,
      ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => {
        exited += 1;
        if (code === 0) resolve(JSON.parse(stdout) as Record<string, unknown>);
        else reject(new Error(`Cursor ${event} claimant exited ${code}`));
      });
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(exited, 0, 'both hook processes wait on the shared observation lock');
    fs.rmSync(lockDir, { recursive: true, force: true });

    const outputs = await Promise.all(children);
    assert.deepEqual(outputs.map((output) => output.kind).sort(), ['context', 'noop']);
    const winner = outputs.find((output) => output.kind === 'context')!;
    const message = String(winner.context || winner.followupMessage || '');
    assert.match(message, /senior-architect/);
    assert.match(message, /senior-backend/);
    assert.ok(listCursorSpawnObservations(fixture.cwd, RUN_ID).every((item) => item.followupEmitted));
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    })).kind, 'noop');
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    })).kind, 'noop');
  });
});

test('abort scopes suppress only automatic followup; explicit Task recovery stays enforceable and settleable', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-architect', 'tool_abort_architect');
    startSubagent(fixture.cwd, 'senior-backend', 'tool_abort_backend');
    writeRoleTerminalError(
      fixture,
      'child-abort-architect',
      'senior-architect',
      API_LIMIT_ERROR,
    );
    writeRoleTerminalError(
      fixture,
      'child-abort-backend',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));

    const childAbort = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'SubagentStop', {
      parent_conversation_id: PARENT_ID,
      subagent_id: 'tool_abort_backend',
      error_message: 'User aborted request',
    }));
    assert.equal(childAbort.kind, 'noop', 'an aborted child event cannot authorize sibling continuation');
    let observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    const backendFailure = observations.find((item) => item.toolCallId === 'tool_abort_backend')!;
    assert.equal(backendFailure.followupSuppressed, true);
    assert.equal(backendFailure.followupSuppressionReason, 'subagent-stop-user-abort');
    assert.equal(
      observations.find((item) => item.toolCallId === 'tool_abort_architect')?.followupSuppressed,
      false,
      'child abort suppression is child-only',
    );

    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      REQUESTED_MODEL,
    )?.kind, 'deny', 'suppression does not disable the explicit recovery gate');
    assert.ok(backendFailure.prescribedModel);
    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_abort_backend_retry',
      backendFailure.prescribedModel!,
    );
    observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.equal(
      observations.find((item) => item.toolCallId === 'tool_abort_backend')?.retryHandled,
      true,
      'a real prescribed start settles a lifecycle-suppressed failure',
    );

    const laterStop = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    }));
    assert.equal(laterStop.kind, 'context');
    if (laterStop.kind === 'context') {
      assert.match(laterStop.followupMessage || '', /senior-architect/);
      assert.doesNotMatch(laterStop.followupMessage || '', /senior-backend/);
    }
  });

  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-architect', 'tool_parent_abort_architect');
    startSubagent(fixture.cwd, 'senior-backend', 'tool_parent_abort_backend');
    writeRoleTerminalError(
      fixture,
      'child-parent-abort-architect',
      'senior-architect',
      API_LIMIT_ERROR,
    );
    writeRoleTerminalError(
      fixture,
      'child-parent-abort-backend',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    const parentAbort = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'SubagentStop', {
      parent_conversation_id: PARENT_ID,
      subagent_id: 'tool_parent_abort_backend',
      parent_status: 'user_aborted',
      parent_error_message: 'User aborted request',
    }));
    assert.equal(parentAbort.kind, 'noop');
    const observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.ok(observations.every((item) => item.followupSuppressed));
    assert.ok(observations.every((item) => (
      item.followupSuppressionReason === 'subagent-stop-parent-user-abort'
    )));
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-architect',
      REQUESTED_MODEL,
    )?.kind, 'deny');
  });

  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_abort_text_negative');
    writeTerminalError(fixture, 'child-abort-text-negative');
    const result = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
      prompt: 'Explain the text User aborted request without changing state.',
      payload: { task: 'The string status: aborted appears in a fixture.' },
    }));
    assert.equal(result.kind, 'context', 'free-form prompt/task prose is not structured abort evidence');
  });
});

test('parent transcript cancellation uses the latest terminal turn only', () => {
  withCursorFixture((fixture) => {
    startSubagent(fixture.cwd, 'senior-backend', 'tool_parent_latest_success');
    writeTerminalError(fixture, 'child-parent-latest-success');
    writeJsonl(path.join(fixture.parentDir, `${PARENT_ID}.jsonl`), [
      { type: 'turn_ended', status: 'error', error_message: 'User aborted request' },
      { type: 'turn_ended', status: 'completed' },
    ]);
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    })).kind, 'context', 'an older abort cannot suppress after a newer completed parent turn');
  });
});

test('balanced API rotation pauses exactly once before Composer until the user selects fallback', () => {
  withCursorFixture((fixture) => {
    recordExhaustedModel(fixture.cwd, RUN_ID, 'senior-backend', REQUESTED_MODEL);
    recordExhaustedModel(fixture.cwd, RUN_ID, 'senior-backend', 'claude-sonnet-5-thinking-high');
    recordExhaustedModel(fixture.cwd, RUN_ID, 'senior-backend', 'gpt-5.5-medium');
    startSubagent(
      fixture.cwd,
      'senior-backend',
      'tool_before_composer_floor',
      'claude-4.6-sonnet-thinking',
    );
    writeTerminalError(fixture, 'child-before-composer-floor');

    const [failure] = reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    })).processed;
    assert.equal(failure?.prescribedModel, 'composer-2.5-fast');
    assert.match(failure?.directive || '', /\*\*enable\*\*/i);
    assert.match(failure?.directive || '', /\*\*fallback\*\*/i);
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      'composer-2.5-fast',
    )?.kind, 'deny');

    assert.equal(writeModelChoice(fixture.cwd, RUN_ID, 'use-fallback'), true);
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      'composer-2.5-fast',
    ), null);
  });
});

test('limited Cursor lineup follows Terra failure to a real Sonnet start, then asks once before Composer', () => {
  withCursorFixture((fixture) => {
    const sonnet = 'claude-sonnet-5-thinking-high';
    const composer = 'composer-2.5-fast';
    setCapturedCursorModels(fixture, [REQUESTED_MODEL, sonnet, composer]);

    startSubagent(fixture.cwd, 'senior-backend', 'tool_limited_terra');
    writeRoleTerminalError(
      fixture,
      'child-limited-terra',
      'senior-backend',
      API_LIMIT_ERROR,
    );
    const [terraFailure] = reconcileCursorSubagentFailures(ctxFor(
      fixture.cwd,
      'UserPromptSubmit',
      { session_id: PARENT_ID },
    )).processed;
    assert.equal(terraFailure?.prescribedModel, sonnet);

    startSubagent(fixture.cwd, 'senior-backend', 'tool_limited_sonnet', sonnet);
    let observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    assert.equal(
      observations.find((item) => item.toolCallId === 'tool_limited_terra')?.retryHandled,
      true,
      'the exact real Sonnet SubagentStart settles the Terra prescription',
    );
    assert.equal(
      observations.find((item) => item.toolCallId === 'tool_limited_sonnet')?.requestedModel,
      sonnet,
    );
    writeRoleTerminalError(
      fixture,
      'child-limited-sonnet',
      'senior-backend',
      API_LIMIT_ERROR,
    );

    const choice = cursorFailureReconcileHook(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    }));
    assert.equal(choice.kind, 'context');
    if (choice.kind === 'context') {
      assert.match(choice.context, /\*\*enable\*\*/i);
      assert.match(choice.context, /\*\*fallback\*\*/i);
      assert.match(choice.context, /composer-2\.5-fast/i);
    }
    assert.equal(modelChoicePrompted(fixture.cwd, RUN_ID), true);
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'UserPromptSubmit', {
      session_id: PARENT_ID,
    })).kind, 'noop', 'the same failure cannot emit a second Composer choice');
    assert.equal(cursorFailureReconcileHook(ctxFor(fixture.cwd, 'Stop', {
      session_id: PARENT_ID,
    })).kind, 'noop', 'Stop cannot duplicate a Composer choice already displayed on prompt submit');

    observations = listCursorSpawnObservations(fixture.cwd, RUN_ID);
    const sonnetFailure = observations.find((item) => item.toolCallId === 'tool_limited_sonnet')!;
    assert.equal(sonnetFailure.prescribedModel, composer);
    assert.equal(sonnetFailure.followupEmitted, true, 'display ownership is persisted only when context returns');
    assert.equal(correlatedCursorFailureGate(
      ctxFor(fixture.cwd, 'PreToolUse', { session_id: PARENT_ID }),
      fixture.cwd,
      RUN_ID,
      'senior-backend',
      composer,
    )?.kind, 'deny', 'Composer cannot start before the user explicitly chooses fallback');
  });
});

test('cheapest tier rotates automatically past Composer and keeps its all-limited terminal marker after TTL', () => {
  withCursorFixture((fixture) => {
    overrideRoleTier(fixture, 'senior-backend', 'cheapest');
    const attempts = [
      ['composer-2.5-fast', 'gpt-5.4-mini'],
      ['gpt-5.4-mini', 'gemini-3.5-flash'],
      ['gemini-3.5-flash', 'claude-4.5-haiku'],
      ['claude-4.5-haiku', null],
    ] as const;

    for (const [index, [attempted, next]] of attempts.entries()) {
      startSubagent(fixture.cwd, 'senior-backend', `tool_cheapest_${index}`, attempted);
      writeTerminalError(fixture, `child-cheapest-${index}`);
      const [failure] = reconcileCursorSubagentFailures(ctxFor(fixture.cwd, 'UserPromptSubmit', {
        session_id: PARENT_ID,
      })).processed;
      assert.equal(failure?.prescribedModel, next);
      if (next) {
        assert.doesNotMatch(failure?.directive || '', /\*\*enable\*\*/i, 'cheapest rotation is automatic');
      }
    }

    assert.equal(modelExhaustionTerminalForRole(fixture.cwd, RUN_ID, 'senior-backend'), true);
    assert.deepEqual(
      exhaustedModelsForRole(
        fixture.cwd,
        RUN_ID,
        'senior-backend',
        Date.now() + EXHAUSTED_MODEL_TTL_MS + 1,
      ),
      [],
      'TTL expiry removes transient model entries',
    );
    assert.equal(
      modelExhaustionTerminalForRole(fixture.cwd, RUN_ID, 'senior-backend'),
      true,
      'the run+role terminal marker does not expire with the entries',
    );
  });
});

test('Cursor reconciliation never writes run state in the plugin authoring root', () => {
  const authoringRoot = path.resolve(process.cwd());
  assert.equal(JSON.parse(fs.readFileSync(path.join(authoringRoot, 'package.json'), 'utf8')).name, 'traffic-one');
  const forbidden = path.join(authoringRoot, '.traffic-one');
  const existedBefore = fs.existsSync(forbidden);

  const result = reconcileCursorSubagentFailures(ctxFor(authoringRoot, 'SessionStart', {
    session_id: PARENT_ID,
    workspace_roots: [authoringRoot],
  }));
  assert.deepEqual(result, { processed: [], ambiguousTranscriptIds: [] });
  assert.equal(fs.existsSync(forbidden), existedBefore);
});

test('Cursor reconciliation never writes run state in a generated plugin root', () => {
  const generatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-generated-plugin-'));
  const scripts = path.join(generatedRoot, 'scripts');
  const manifestDir = path.join(generatedRoot, '.codex-plugin');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'hook-runtime.cjs'), 'module.exports = {};\n', 'utf8');
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), '{"name":"traffic-one"}\n', 'utf8');
  resetAuthoringRootCache();

  try {
    const forbidden = path.join(generatedRoot, '.traffic-one');
    const result = reconcileCursorSubagentFailures(ctxFor(generatedRoot, 'SessionStart', {
      session_id: PARENT_ID,
      workspace_roots: [generatedRoot],
    }));
    assert.deepEqual(result, { processed: [], ambiguousTranscriptIds: [] });
    assert.equal(fs.existsSync(forbidden), false);
  } finally {
    fs.rmSync(generatedRoot, { recursive: true, force: true });
    resetAuthoringRootCache();
  }
});
