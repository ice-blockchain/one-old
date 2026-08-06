// src/runners/doctor/__tests__/wedged-run-fixture.ts
// A real wedged run on disk, for `doctor --run <id>`: one live bound claim with
// its registry row, one expired pending claim, one registry row past its
// liveness window, an active (non-terminal) ledger, and a decision log with
// repeated denies.
//
// Every artefact is produced by the RUNTIME's own writers (claimThreadRole,
// ensureRunAgentClaim, recordRunAgent, appendDecision) so the shapes cannot
// drift from what a real run leaves behind — a hand-rolled agents.json would
// pass a test forever while doctor read a field the runtime stopped writing.
// The only hand edits are two TIMESTAMPS, aged backwards: no writer can
// produce a stale row on demand, and staleness is the whole subject.

import * as fs from 'fs';
import * as path from 'path';

import { PENDING_AGENT_CLAIM_STALE_MS, SUBAGENT_STALE_MS } from '../../../config/state';
import { appendDecision, type DecisionRecord } from '../../../shared/state/decision-log';
import { recordPluginUseChoice, resetPluginUseCache } from '../../../shared/state/plugin-use';
import { claimThreadRole } from '../../../shared/state/run-agent/claim-thread-role';
import { ensureRunAgentClaim } from '../../../shared/state/run-agent/claims-store';
import { agentRegistryFile, recordRunAgent } from '../../../shared/state/run-agent/registry';
import { pendingDir } from '../../../shared/state/run-agent/run-paths';

export const FIXTURE_RUN_ID = '1785169657252';
export const FIXTURE_PARENT_SESSION = 'parent-session-01';
export const FIXTURE_TOP_DENY_ID = 'plan-write-model-choice-pending';
export const FIXTURE_SECOND_DENY_ID = 'plan-main-agent-gate';

function ageIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function ageRegistryRow(cwd: string, runId: string, role: string, byMs: number): void {
  const file = agentRegistryFile(cwd, runId);
  const registry = JSON.parse(fs.readFileSync(file, 'utf8')) as { agents?: Record<string, Record<string, unknown>> };
  const row = registry.agents?.[role];
  if (!row) throw new Error(`fixture: no registry row for ${role}`);
  row.recordedAt = ageIso(byMs);
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

function agePendingClaim(cwd: string, runId: string, role: string, byMs: number): void {
  const dir = pendingDir(cwd, runId);
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (claim.role !== role) continue;
    claim.createdAt = ageIso(byMs);
    fs.writeFileSync(file, JSON.stringify(claim, null, 2));
    return;
  }
  throw new Error(`fixture: no pending claim for ${role}`);
}

function decision(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    ts: '2026-08-04T09:00:00.000Z',
    correlationId: `${FIXTURE_RUN_ID}:1:4242`,
    runId: FIXTURE_RUN_ID,
    hookSeq: 1,
    pid: 4242,
    event: 'PreToolUse',
    host: 'claude',
    decision: 'deny',
    inputs: { hostHookPoint: 'PreToolUse' },
    stateWrites: [],
    ...over,
  };
}

export interface WedgedRunFixture {
  readonly cwd: string;
  readonly runId: string;
  readonly prefsPath: string;
}

/**
 * Populates `cwd` (an existing empty dir) with the wedged run described above.
 * Sets TRAFFIC_ONE_PROJECT_PREFS_PATH for the calling process so the consent
 * the decision log requires is recorded outside the project tree, exactly as
 * it is in production.
 */
export function buildWedgedRunFixture(cwd: string): WedgedRunFixture {
  const runId = FIXTURE_RUN_ID;
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'wedged-fixture', version: '0.0.0', private: true }, null, 2));
  const prefsPath = path.join(cwd, 'project-prefs.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsPath;
  resetPluginUseCache();
  recordPluginUseChoice(cwd, true, 'doctor-fixture');
  resetPluginUseCache();

  const state = { mode: 'existing-codebase', stack: 'default', frontend: 'react-vite', backend: 'supabase', currentRunId: runId };
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state, null, 2));

  // Live: a bound ("claimed") claim and a fresh registry row for the same role.
  claimThreadRole(cwd, state, 'thread-frontend-01', 'senior-frontend', {
    parentSessionId: FIXTURE_PARENT_SESSION,
    recordAgent: true,
    model: 'claude-sonnet',
  });
  recordRunAgent(cwd, runId, 'senior-frontend', {
    agentId: 'agent-frontend-01',
    parentSessionId: FIXTURE_PARENT_SESSION,
    model: 'claude-sonnet',
  });
  // Wedged: a pending claim nobody ever bound, aged past its 5-minute window.
  ensureRunAgentClaim(cwd, state, 'senior-backend', { session_id: FIXTURE_PARENT_SESSION }, { toolName: 'Task', model: 'claude-sonnet' });
  agePendingClaim(cwd, runId, 'senior-backend', PENDING_AGENT_CLAIM_STALE_MS + 60_000);
  // Wedged: a registry row whose agent stopped reporting 40 minutes ago.
  recordRunAgent(cwd, runId, 'senior-architect', {
    agentId: 'agent-architect-01',
    parentSessionId: FIXTURE_PARENT_SESSION,
    model: 'claude-opus',
  });
  ageRegistryRow(cwd, runId, 'senior-architect', SUBAGENT_STALE_MS + 10 * 60_000);

  // Real deny ids (config/deny-ids.ts), so the probe's `recognized` flag reads
  // as it would on a real run rather than tripping the version-skew warning.
  for (let index = 0; index < 4; index += 1) {
    appendDecision(cwd, decision({
      ts: `2026-08-04T09:0${index}:00.000Z`,
      hookSeq: index + 1,
      gateId: 'plan-guard',
      denyId: FIXTURE_TOP_DENY_ID,
      denyTarget: 'src/app.tsx',
      repeatCount: index + 1,
    }));
  }
  appendDecision(cwd, decision({ ts: '2026-08-04T09:05:00.000Z', hookSeq: 5, gateId: 'plan-guard', denyId: FIXTURE_SECOND_DENY_ID }));
  appendDecision(cwd, decision({ ts: '2026-08-04T09:06:00.000Z', hookSeq: 6, gateId: 'plan-guard', denyId: FIXTURE_SECOND_DENY_ID }));
  appendDecision(cwd, decision({ ts: '2026-08-04T09:07:00.000Z', hookSeq: 7, decision: 'allow', gateId: null, denyId: null }));

  return { cwd, runId, prefsPath };
}
