// Shared agent-model test fixtures, extracted from agent-model.test.ts so the
// sibling gate suites (exploration cap, verify gate) can bind children and
// freeze run policies without duplicating the materialized-project scaffold.
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GENERATED_MARKER } from '../../../shared/materialize';
import { writeArchitectPhaseComplete } from '../../plan-guard/__tests__/architect-phase-fixtures';
import { readEffectiveState } from '../../../shared/state';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';
import { ensureRunModelPolicy } from '../../../shared/run-model-policy';
import { modelTierSnapshot, resolveModel } from '../../../shared/model-tiers';

// Default captured Cursor model list (a realistic higher-plan build, incl.
// screenshot-style reasoning suffixes) — derived from the live catalog, never
// hardcoded, so a tier re-order does not break behavioural gate tests.
export const CURSOR_HIGHEST_FAMILY = resolveModel('highest', 'cursor', 'pro') as string;
export const CURSOR_HIGHEST_SLUG = `${CURSOR_HIGHEST_FAMILY}-thinking-high`;
export const CURSOR_HIGHEST_ALT = `${modelTierSnapshot('cursor', 'pro').highest[1]}-medium`;
export const DEFAULT_CURSOR_MODELS = [
  CURSOR_HIGHEST_SLUG, CURSOR_HIGHEST_ALT,
  'gpt-5.6-terra-medium', 'claude-sonnet-5-thinking-high',
  'composer-2.5-fast', 'gpt-5.4-mini', 'gpt-5.6-luna',
];

// A fully-materialized new-project temp dir with performance/team in local
// prefs so readEffectiveState surfaces only the current user's choices.
export function withMaterialized(opts: { teamApproved: boolean; cursorModels?: string[] | null; architectComplete?: boolean; level?: 'high' | 'balanced' | 'low' }, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-agentmodel-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  const prevXdgState = env.XDG_STATE_HOME;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'state');
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
    if (prevXdgState === undefined) delete env.XDG_STATE_HOME; else env.XDG_STATE_HOME = prevXdgState;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function freezeRunPolicy(cwd: string, host: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'kilo' | 'windsurf', runId?: string): void {
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: host });
  const activeRunId = runId || (typeof state.currentRunId === 'string' ? state.currentRunId : '');
  assert.ok(activeRunId, 'test fixture must have a current run id before freezing policy');
  assert.ok(
    ensureRunModelPolicy(cwd, activeRunId, host, state, { ...process.env, TRAFFIC_ONE_HOST: host }),
    `test fixture could not freeze ${host} run policy`,
  );
}
