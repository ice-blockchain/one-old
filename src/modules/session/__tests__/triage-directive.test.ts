import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { maintenanceTriageDirective, maintenanceTriageFallbackDirective, unresolvedRunDirective } from '../triage-directive';
import { transitionRunStatus } from '../../../shared/state';
import { ensureRunModelPolicy, runModelPolicyPath } from '../../../shared/run-model-policy';
import { currentHostModelTarget } from '../../../shared/current-model-tiers';
import {
  architectureInputPath,
  compileArchitectureForRun,
  publishRuntimeAssignments,
} from '../../../shared/architecture-contract';
import { compileVerificationContract } from '../../../shared/verification-contract';
import type { Rec } from '../../../shared/obj';

// The maintenance triage directive starts a FRESH run (rotates currentRunId,
// clears spawnIndex) for a new request in subagents mode — but it must NEVER do so
// while the CURRENT orchestrated run is still live (assignments exist, no terminal
// verdict). Rotating then splits run state across two ids and the run-id gate
// resolves no scope for the in-flight role spawns. (The 2026-06-17 tests/9a bug.)

function setup(opts: { reviewer?: string; tester?: string; shipper?: boolean; assignments?: boolean; rolesAssignments?: boolean; orchestratorStamped?: boolean; completedAt?: string }): { dir: string; state: Rec } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-triage-'));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const state: Rec = {
    mode: 'new-project',
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true,
    lifecycle: { phase: 'maintenance', source: opts.orchestratorStamped ? 'orchestrator' : 'heuristic', completedAt: opts.completedAt || new Date().toISOString() },
    team: { mode: 'subagents', approved: true },
    currentRunId: 'OLD',
    spawnIndex: { 'senior-frontend': 1, 'senior-backend': 1 },
  };
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state));
  if (opts.assignments || opts.rolesAssignments) {
    const rd = path.join(dir, '.traffic-one', 'runs', 'OLD');
    fs.mkdirSync(rd, { recursive: true });
    const manifest = opts.rolesAssignments
      // the non-conforming `roles` schema some orchestrators emit (gpt-5.5)
      ? { runId: 'OLD', roles: { 'senior-frontend': { ownedPaths: ['apps/web/**'] } } }
      : { version: 1, runId: 'OLD', assignments: [{ role: 'senior-frontend', scope: { include: ['apps/web/**'] } }] };
    fs.writeFileSync(path.join(rd, 'assignments.json'), JSON.stringify(manifest));
  }
  if (opts.reviewer || opts.tester || opts.shipper) {
    const dd = path.join(dir, '.traffic-one', 'digests', 'OLD');
    fs.mkdirSync(dd, { recursive: true });
    if (opts.reviewer) fs.writeFileSync(path.join(dd, 'reviewer.md'), `# reviewer\nverdict: ${opts.reviewer}\n`);
    if (opts.tester) fs.writeFileSync(path.join(dd, 'tester.md'), `# tester\nverdict: ${opts.tester}\n`);
    if (opts.shipper) fs.writeFileSync(path.join(dd, 'shipper.md'), '# shipper\nverdict: SHIPPED\nurl: https://app.example\n');
    if (opts.tester === 'TESTS_GREEN') {
      const memoryDir = '.traffic' + '-one';
      const qaDir = path.join(dir, memoryDir, 'reports', 'qa', 'OLD');
      fs.mkdirSync(qaDir, { recursive: true });
      fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ ok: true }), 'utf8');
    }
  }
  return { dir, state };
}

function cleanup(dir: string): void {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

const PROMPT = 'change the hero headline to Welcome';

function writeFreshClaim(dir: string, role = 'senior-frontend'): void {
  const runDir = path.join(dir, '.traffic-one', 'runs', 'OLD');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'kilo-leftover.json'), JSON.stringify({
    version: 1,
    runId: 'OLD',
    role,
    status: 'claimed',
    sessionId: 'kilo-child',
    createdAt: new Date().toISOString(),
  }));
}

test('does NOT rotate currentRunId while the current run is live (assignments + non-terminal reviewer)', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD', 'run-id must not rotate while the run is unsettled');
    assert.deepEqual(state.spawnIndex, { 'senior-frontend': 1, 'senior-backend': 1 }, 'spawnIndex must not be cleared');
  } finally {
    cleanup(dir);
  }
});

test('does NOT rotate while a live run carries the non-conforming `roles` manifest (schema-agnostic guard)', () => {
  // The gpt-5.5 deviation: assignments.json uses a `roles` object. The guard must STILL
  // see the run (via raw artifact existence) and refuse to rotate while it is unsettled.
  const { dir, state } = setup({ rolesAssignments: true, reviewer: 'CHANGES_REQUESTED' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD', 'a non-conforming manifest must not defeat the guard');
  } finally {
    cleanup(dir);
  }
});

test('a stale orchestrator lifecycle stamp does NOT green-light rotating a LATER live run', () => {
  // Regression guard: `lifecycle.source==='orchestrator'` is stamped once at the first
  // build and never reset. A 2nd maintenance feature that is mid-fix-cycle (CHANGES_REQUESTED)
  // must STILL be protected — the persistent stamp must not allow rotating it (would split).
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED', orchestratorStamped: true });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD', 'a live run is not rotated just because the project was orchestrator-stamped earlier');
  } finally {
    cleanup(dir);
  }
});

test('does NOT rotate while the run is live with a tester still TESTS_FAILING', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'APPROVED', tester: 'TESTS_FAILING' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.equal(state.currentRunId, 'OLD');
  } finally {
    cleanup(dir);
  }
});

test('rotates currentRunId once the current run terminally settled (APPROVED + TESTS_GREEN)', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'APPROVED', tester: 'TESTS_GREEN' });
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.notEqual(state.currentRunId, 'OLD', 'run-id should rotate for a fresh maintenance run');
    assert.match(String(state.currentRunId), /^\d{13}$/);
    assert.deepEqual(state.spawnIndex, {}, 'spawnIndex cleared for the fresh run');
  } finally {
    cleanup(dir);
  }
});

test('rotation releases the settled run\'s claims (terminal sweep)', () => {
  const { dir, state } = setup({ assignments: true, reviewer: 'APPROVED', tester: 'TESTS_GREEN' });
  // A build-time claim: created BEFORE the completion watermark (so it does not
  // suppress triage) but still fresh on disk — the 3c end-state shape.
  const claimFile = path.join(dir, '.traffic-one', 'runs', 'OLD', 'child9.json');
  fs.writeFileSync(claimFile, JSON.stringify({
    version: 1, runId: 'OLD', claimId: 'senior-frontend-1-z', role: 'senior-frontend',
    status: 'claimed', sessionId: 'child9',
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  }));
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.notEqual(state.currentRunId, 'OLD');
    const released = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    assert.equal(released.status, 'released');
    assert.equal(released.releasedReason, 'terminal-verified-evidence');
  } finally {
    cleanup(dir);
  }
});

test('rotates when there is no orchestrated run (no assignments) — common maintenance edit', () => {
  const { dir, state } = setup({});
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.notEqual(state.currentRunId, 'OLD', 'a plain maintenance edit with no orchestrated run still rotates');
    assert.match(String(state.currentRunId), /^\d{13}$/);
  } finally {
    cleanup(dir);
  }
});

test('Codex child prompt with root session id does not mint a sibling maintenance run', () => {
  const { dir, state } = setup({});
  try {
    const directive = maintenanceTriageDirective(dir, state, PROMPT, {
      session_id: '019fa11e-ad9b-7123-95e6-e41008289e76',
      transcript_path: '/tmp/rollout-2026-07-27T04-11-13-019fa120-4089-7261-9067-1cd3f8dfce65.jsonl',
    }, 'codex');
    assert.equal(directive, '', 'Codex child UserPromptSubmit never receives parent maintenance routing');
    assert.equal(state.currentRunId, 'OLD', 'child startup cannot rotate the parent run id');
    assert.deepEqual(state.spawnIndex, { 'senior-frontend': 1, 'senior-backend': 1 });
  } finally {
    cleanup(dir);
  }
});

test('F3: a rotated maintenance run freezes model-policy at mint (first followup is not denied)', () => {
  const { dir, state } = setup({});
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_HOST = 'codex';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  // The MERGED state must carry the acknowledged catalog (readState strips
  // performance as a host pref, so beginFreshMaintenanceRun freezes off the
  // passed-in state, matching the build-run handler's effectiveState).
  const target = currentHostModelTarget('codex', 'pro', process.env);
  state.performance = {
    level: 'high',
    source: 'prompted',
    target: { plan: 'pro', appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion },
  };
  try {
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'codex');
    assert.notEqual(state.currentRunId, 'OLD', 'a fresh maintenance run should rotate');
    assert.ok(fs.existsSync(runModelPolicyPath(dir, String(state.currentRunId))),
      'the maintenance run must freeze its model-policy at mint so the first followup_task is not denied on a missing policy');
  } finally {
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    cleanup(dir);
  }
});

test('F3: maintenance rotation stays best-effort when the model policy cannot be frozen', () => {
  // No performance level in state → buildRunModelPolicy returns null; the freeze
  // must no-op WITHOUT throwing, and the run must still rotate + route.
  const { dir, state } = setup({});
  try {
    let directive = '';
    assert.doesNotThrow(() => { directive = maintenanceTriageDirective(dir, state, PROMPT, {}, 'codex'); });
    assert.notEqual(state.currentRunId, 'OLD', 'rotation still happens even if the policy freeze no-ops');
    assert.ok(directive.length > 0, 'triage must still return its routing directive');
  } finally {
    cleanup(dir);
  }
});

test('Kilo prompt boundary bypasses stale claim suppression but preserves a nonterminal run id', () => {
  // Kilo does not emit a role-completion/resume event. Its completed task claims
  // therefore remain fresh after the initial build. A new chat.message may bypass
  // that stale claim, but a nonterminal verdict still requires the same run id.
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED', completedAt });
  try {
    writeFreshClaim(dir);
    const directive = maintenanceTriageDirective(dir, state, 'create a new page named news', { session_id: 'kilo-parent' }, 'kilo');
    assert.equal(state.currentRunId, 'OLD', 'unresolved verification retains the same run even at a Kilo boundary');
    assert.deepEqual(state.spawnIndex, { 'senior-frontend': 1, 'senior-backend': 1 }, 'existing role indexes remain resumable');
    assert.match(directive, /MAINTENANCE PHASE/);
    assert.match(directive, /Keyword hint: small/);
    assert.match(directive, /Do NOT spawn `senior-architect`/);
  } finally {
    cleanup(dir);
  }
});

test('runtime-control prompts bypass maintenance workers and do not rotate the run', () => {
  for (const prompt of [
    'start the dev server',
    'stop the preview server',
    'restart the local server',
    'restart the Vite dev server',
    'check port 5173',
    'check process 123456',
    'what process is listening on port 3000',
    'show me the local server logs',
    'show the logs for the Vite dev server',
  ]) {
    const { dir, state } = setup({});
    try {
      const directive = maintenanceTriageDirective(dir, state, prompt, { session_id: 'parent' }, 'claude');
      assert.equal(directive, '', `parent should handle runtime command: ${prompt}`);
      assert.equal(state.currentRunId, 'OLD', 'runtime commands do not mint maintenance runs');
      assert.deepEqual(state.spawnIndex, { 'senior-frontend': 1, 'senior-backend': 1 });
    } finally {
      cleanup(dir);
    }
  }
});

test('server implementation near-misses still use normal maintenance routing', () => {
  for (const prompt of [
    'fix the server startup error',
    'change the server config',
    'add an endpoint',
    'restart the Vite dev server and change its config',
  ]) {
    const { dir, state } = setup({});
    try {
      const directive = maintenanceTriageDirective(dir, state, prompt, { session_id: 'parent' }, 'claude');
      assert.match(directive, /MAINTENANCE PHASE/, `implementation prompt should route: ${prompt}`);
      assert.notEqual(state.currentRunId, 'OLD', 'normal maintenance work gets its own run');
    } finally {
      cleanup(dir);
    }
  }
});

test('active claims still suppress triage on resumable hosts', () => {
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const { dir, state } = setup({ assignments: true, reviewer: 'CHANGES_REQUESTED', completedAt });
  try {
    writeFreshClaim(dir);
    const directive = maintenanceTriageDirective(dir, state, 'create a new page named news', { session_id: 'cursor-parent' }, 'cursor');
    assert.equal(directive, '', 'Cursor keeps its live role session instead of splitting the active run');
    assert.equal(state.currentRunId, 'OLD');
  } finally {
    cleanup(dir);
  }
});

// ── empty failed-run husk: rotate instead of wedging ─────────────────────────
// A `failed` ledger has no transition out, so no role can ever claim in it. When
// the run also holds nothing, capturing every later prompt with the unresolved
// continuation directive left the project permanently stuck.

function failRun(dir: string, runId = 'OLD'): void {
  assert.ok(transitionRunStatus(dir, runId, { status: 'active' }));
  assert.ok(transitionRunStatus(dir, runId, { status: 'failed', outcome: 'agent-failed' }));
}

test('an EMPTY failed run yields no unresolved directive, so triage rotates it away', () => {
  const { dir, state } = setup({});
  try {
    failRun(dir);
    assert.equal(unresolvedRunDirective(dir, state, PROMPT, {}), '', 'an empty failed run has nothing to continue');
    maintenanceTriageDirective(dir, state, PROMPT, {}, 'claude');
    assert.notEqual(state.currentRunId, 'OLD', 'the husk is replaced with a fresh run id');
    assert.match(String(state.currentRunId), /^\d{13}$/);
    assert.deepEqual(state.spawnIndex, {});
  } finally {
    cleanup(dir);
  }
});

test('a failed run that DID produce work still routes to the unresolved continuation', () => {
  const { dir, state } = setup({ assignments: true });
  try {
    failRun(dir);
    const directive = unresolvedRunDirective(dir, state, PROMPT, {});
    assert.match(directive, /UNRESOLVED TRAFFIC ONE RUN/, 'assignments prove real work — never discard it');
    assert.equal(state.currentRunId, 'OLD');
  } finally {
    cleanup(dir);
  }
});

test('a failed run with a live claim still routes to the unresolved continuation', () => {
  const { dir, state } = setup({});
  try {
    failRun(dir);
    writeFreshClaim(dir);
    assert.match(unresolvedRunDirective(dir, state, PROMPT, {}), /UNRESOLVED TRAFFIC ONE RUN/);
    assert.equal(state.currentRunId, 'OLD');
  } finally {
    cleanup(dir);
  }
});

test('a BLOCKED run is untouched: it keeps its explicit user-authorized resume', () => {
  const { dir, state } = setup({});
  try {
    assert.ok(transitionRunStatus(dir, 'OLD', { status: 'active' }));
    assert.ok(transitionRunStatus(dir, 'OLD', { status: 'blocked', outcome: 'review-cycle-cap' }));
    assert.match(unresolvedRunDirective(dir, state, PROMPT, {}), /UNRESOLVED TRAFFIC ONE RUN/);
    assert.equal(state.currentRunId, 'OLD');
  } finally {
    cleanup(dir);
  }
});

// ── routing must never name a run the parent gates refuse ────────────────────
// 16co, 2026-08-02: SessionStart emitted TRAFFIC_ONE_MODEL_POLICY_BLOCKED ("Do
// not spawn a child") at 07:12:09Z and the triage reminder handed the agent that
// same run id for `opencode_delegate` at 07:12:10Z. Two hooks, one turn, opposite
// instructions; the agent followed the newer one and spent the session against a
// gate that denies every parent tool call.
//
// The precondition is CREATE-ONCE: only a run whose model policy is already
// published is unrepairable in place. An unfrozen run is left alone (Performance
// still fixes it) and — critically — the refusal is evaluated AFTER rotation, so
// it can never swallow the escape hatch.

function withFrozenCodexRun(
  opts: { compiled?: boolean },
  fn: (dir: string, state: Rec) => void,
): void {
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_HOST = 'codex';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  const { dir, state } = setup({});
  const target = currentHostModelTarget('codex', 'pro', process.env);
  state.mobile = { framework: 'none' };
  state.performance = {
    level: 'high',
    source: 'prompted',
    target: { plan: 'pro', appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion },
  };
  try {
    if (opts.compiled) {
      // A compiled run is exactly the shape the rotation guard PINS, so it is the
      // only shape that can stay wedged across prompts.
      const inputPath = architectureInputPath(dir, 'OLD');
      fs.mkdirSync(path.dirname(inputPath), { recursive: true });
      fs.writeFileSync(inputPath, JSON.stringify({
        schemaVersion: 1,
        routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
        modules: [
          { id: 'app-shell', name: 'App', kind: 'app-shell' },
          { id: 'home', name: 'Home', kind: 'page' },
          { id: 'catalog', name: 'Catalog', kind: 'feature' },
        ],
      }));
      const architecture = compileArchitectureForRun(dir, 'OLD', state);
      const verification = compileVerificationContract(dir, 'OLD', state, architecture, { changedPaths: [] });
      publishRuntimeAssignments(dir, architecture, verification.contractHash);
      assert.ok(
        ensureRunModelPolicy(dir, 'OLD', 'codex', state, process.env),
        'the run must freeze cleanly BEFORE each wedge is introduced',
      );
    }
    fn(dir, state);
  } finally {
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    cleanup(dir);
  }
}

function writePendingFallbackDebt(dir: string, runId = 'OLD', role = 'senior-frontend'): void {
  fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'maintenance.json'), JSON.stringify({
    version: 1,
    kind: 'opencode-delegation',
    role,
    outcome: 'failed',
    overallOutcome: 'fallback-pending',
    fallbackAllowed: true,
    workUnitContractHash: 'b'.repeat(64),
    allowlistHash: 'c'.repeat(64),
    fallbackSourceBaseline: {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      files: [{ path: 'apps/web/src/pages/NewsArticlePage.tsx', state: 'file', size: 223, hash: 'd'.repeat(64) }],
    },
  }));
}

test('a PINNED run whose frozen policy is unreadable stops routing instead of naming it for delegation', () => {
  withFrozenCodexRun({ compiled: true }, (dir, state) => {
    // Create-once: the parent may never replace this file, so no later prompt in
    // this run repairs it — SessionStart and the PreToolUse gate both refuse it.
    fs.writeFileSync(runModelPolicyPath(dir, 'OLD'), '{ not json', 'utf8');
    const directive = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 'parent' }, 'codex');
    assert.match(directive, /^TRAFFIC_ONE_BOOTSTRAP_BLOCKED\n/);
    assert.match(directive, /Run "OLD"/);
    assert.doesNotMatch(directive, /MAINTENANCE PHASE/, 'no routing rubric may accompany the refusal');
    assert.doesNotMatch(directive, /Keyword hint/, 'no tier hint either — there is nothing to route');
    assert.equal(state.currentRunId, 'OLD', 'a pinned wedged run is not rotated away by the refusal');
  });
});

test('a pinned run frozen for ANOTHER host stops routing, and the rubric is still owed once it is usable', () => {
  withFrozenCodexRun({ compiled: true }, (dir, state) => {
    const blocked = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 'parent' }, 'claude');
    assert.match(blocked, /^TRAFFIC_ONE_BOOTSTRAP_BLOCKED\n/);
    // The refusal returns BEFORE the once-per-session marker is burned: an agent
    // that never received the full rubric must not later get the one-line
    // reminder pointing back at prose it has never seen.
    const routed = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 'parent' }, 'codex');
    assert.match(routed, /MAINTENANCE PHASE — post-build triage/);
    assert.doesNotMatch(routed, /triage reminder/);
  });
});

test('a fallback-pending debt does NOT stop routing — the paid fallback child is what discharges it', () => {
  // The exact 16co shape. The preflight publishes the debt's bounded scope, so
  // the run stays usable; refusing to route here would re-wedge the one path
  // that can settle the debt.
  withFrozenCodexRun({ compiled: true }, (dir, state) => {
    writePendingFallbackDebt(dir);
    const directive = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 'parent' }, 'codex');
    assert.match(directive, /MAINTENANCE PHASE/);
    assert.doesNotMatch(directive, /TRAFFIC_ONE_BOOTSTRAP_BLOCKED/);
    assert.equal(state.currentRunId, 'OLD', 'the debt-owing run is preserved, not rotated away');
  });
});

test('a wedged run with no orchestrated artifacts still ROTATES — the refusal never eats the escape hatch', () => {
  withFrozenCodexRun({}, (dir, state) => {
    fs.mkdirSync(path.dirname(runModelPolicyPath(dir, 'OLD')), { recursive: true });
    fs.writeFileSync(runModelPolicyPath(dir, 'OLD'), '{ not json', 'utf8');
    const directive = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 'parent' }, 'codex');
    assert.notEqual(state.currentRunId, 'OLD', 'rotation already happened — the check runs after it');
    assert.match(directive, /MAINTENANCE PHASE/, 'the fresh run is usable, so the request routes normally');
    assert.doesNotMatch(directive, /TRAFFIC_ONE_BOOTSTRAP_BLOCKED/);
  });
});

test('an UNFROZEN pinned run keeps routing: create-once has not closed the door on it', () => {
  withFrozenCodexRun({ compiled: true }, (dir, state) => {
    fs.rmSync(runModelPolicyPath(dir, 'OLD'), { force: true });
    const directive = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 'parent' }, 'codex');
    assert.match(directive, /MAINTENANCE PHASE/);
    assert.doesNotMatch(directive, /TRAFFIC_ONE_BOOTSTRAP_BLOCKED/);
  });
});

test('main-agent projects never see the refusal — the spawn gates do not deny them either', () => {
  withFrozenCodexRun({ compiled: true }, (dir, state) => {
    fs.writeFileSync(runModelPolicyPath(dir, 'OLD'), '{ not json', 'utf8');
    state.team = { mode: 'main-agent', approved: true };
    const directive = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 'parent' }, 'codex');
    assert.match(directive, /MAINTENANCE PHASE/);
    assert.doesNotMatch(directive, /TRAFFIC_ONE_BOOTSTRAP_BLOCKED/);
  });
});

test('the headless fallback refuses a pinned wedged run instead of naming it for delegation', () => {
  // The 16co hazard through the OTHER delivery path: the first-mutating-call
  // fallback must apply the same refusal, and (like the prompt path) before the
  // once-marker burns, so the full rubric is still owed once the run is usable.
  withFrozenCodexRun({ compiled: true }, (dir, state) => {
    fs.writeFileSync(runModelPolicyPath(dir, 'OLD'), '{ not json', 'utf8');
    const blocked = maintenanceTriageFallbackDirective(dir, state, { session_id: 'headless-w' }, 'codex');
    assert.match(blocked, /^TRAFFIC_ONE_BOOTSTRAP_BLOCKED\n/);
    assert.doesNotMatch(blocked, /MAINTENANCE PHASE/);
    // Refusal did not burn the marker: once usable, the full rubric emits.
    fs.rmSync(runModelPolicyPath(dir, 'OLD'), { force: true });
    const routed = maintenanceTriageFallbackDirective(dir, state, { session_id: 'headless-w' }, 'codex');
    assert.match(routed, /MAINTENANCE PHASE — post-build triage/);
  });
});

// ── The headless fallback ───────────────────────────────────────────────────
// UserPromptSubmit never fires in `claude -p` sessions (verified live in the
// ep-text-edit e2e), so the rubric rides the first mutating/spawn PreToolUse
// via maintenanceTriageFallbackDirective instead. These pin its contract.

test('headless fallback emits the rubric once, without rotating the run', () => {
  const { dir, state } = setup({});
  try {
    const first = maintenanceTriageFallbackDirective(dir, state, { session_id: 'headless-1' }, 'claude');
    assert.match(first, /MAINTENANCE PHASE — post-build triage/);
    assert.match(first, /judge the tier yourself/);
    assert.equal(state.currentRunId, 'OLD', 'the fallback must never rotate — rotation is prompt-boundary only');
    // Same session: the once-marker suppresses a second emission.
    assert.equal(maintenanceTriageFallbackDirective(dir, state, { session_id: 'headless-1' }, 'claude'), '');
  } finally {
    cleanup(dir);
  }
});

test('headless fallback and the prompt directive share one once-marker (no double full rubric)', () => {
  const { dir, state } = setup({});
  try {
    const fallback = maintenanceTriageFallbackDirective(dir, state, { session_id: 's-shared' }, 'claude');
    assert.match(fallback, /MAINTENANCE PHASE — post-build triage/);
    // The prompt-boundary directive in the SAME session degrades to the
    // reminder form instead of re-injecting the full block.
    const prompt = maintenanceTriageDirective(dir, state, PROMPT, { session_id: 's-shared' }, 'claude');
    assert.match(prompt, /triage reminder/);
    assert.doesNotMatch(prompt, /post-build triage\]/);
  } finally {
    cleanup(dir);
  }
});

test('headless fallback stands down outside maintenance, for subagents, and under live claims', () => {
  // Watermark safely in the past: a claim minted in the same millisecond as
  // the lifecycle stamp would not read as "after" it (the sibling suppress
  // test does the same).
  const { dir, state } = setup({ completedAt: new Date(Date.now() - 60_000).toISOString() });
  try {
    // Building phase → silent.
    const building = { ...state, lifecycle: { phase: 'building' } } as typeof state;
    assert.equal(maintenanceTriageFallbackDirective(dir, building, { session_id: 's-b' }, 'claude'), '');
    // Subagent thread → silent.
    assert.equal(maintenanceTriageFallbackDirective(dir, state, {
      session_id: 's-c',
      agent_id: 'w1',
      agent_type: 'traffic-one:senior-frontend',
    }, 'claude'), '');
    // A fresh live claim (worker mid-task) → continuation owns it, no rubric.
    writeFreshClaim(dir);
    assert.equal(maintenanceTriageFallbackDirective(dir, state, { session_id: 's-d' }, 'claude'), '');
  } finally {
    cleanup(dir);
  }
});
