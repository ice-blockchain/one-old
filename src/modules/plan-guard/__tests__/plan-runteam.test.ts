import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runTeamEnforcementViolation, type RunTeamArgs } from '../plan-runteam';
import {
  assignmentForContext,
  claimThreadRole,
  ensureRunAgentClaim,
  readRunAssignments,
  runLedgerAdmitsClaims,
  transitionRunStatus,
  type RunAgentContext,
} from '../../../shared/state';
// Not a test file (see its header): it holds one of the four run-scoped owned-dir
// locks from THIS process so a mutation under test reports the contended case.
import { holdRunLock, runLockDir } from '../../../shared/state/__tests__/owned-lock-fixture';
import { ONBOARDING_MAIN_TTL_MS, recordMainOnboardingSession } from '../../../shared/onboarding-server/onboarding-session';
import { ensureRunBootstrap } from '../../../shared/run-bootstrap-policy';
import {
  architectureInputPath,
  compileArchitectureForRun,
  publishRuntimeAssignments,
} from '../../../shared/architecture-contract';
import { compileVerificationContract } from '../../../shared/verification-contract';

const STACK = 'default|react-vite|supabase|none';
const RUN = 'run-1';
const THREAD = '019e7390-ca45-7e03-84d3-284bda1ba905';

// A BUILDING-phase subagents project — the context run-team enforcement is for
// (parallel implementers coordinated by the architect's assignments manifest).
// In maintenance phase the gate stands down (separate test below), so these
// enforcement cases pin the building phase explicitly via mode:new-project.
function baseState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' }, onboardingComplete: true, materializedStack: STACK,
    currentRunId: RUN, team: { mode: 'subagents', source: 'prompted', approved: true },
    ...extra,
  };
}

// Test block(): the gate's fallback string is already fully interpolated via template
// literals, so returning it verbatim is what the runtime does when SKILL.md is absent.
const block = (_name: string, fallback: string) => fallback;

function rawFor(threadId: string): Record<string, unknown> {
  return { session_id: 'orchestrator', transcript_path: `/tmp/rollout-2026-06-07T00-00-00-${threadId}.jsonl` };
}
function writeTranscript(dir: string, threadId: string, body: string): string {
  const file = path.join(dir, `rollout-2026-06-07T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
  })}\n`, 'utf8');
  return file;
}

function safeKey(p: string): string {
  return p.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}
function manifestFile(dir: string, runId = RUN): string {
  return path.join(dir, '.traffic-one', 'runs', runId, 'assignments.json');
}
function claimsDir(dir: string, runId = RUN): string {
  return path.join(dir, '.traffic-one', 'runs', runId, 'claims');
}
function writeManifest(dir: string, assignments: unknown[], runId = RUN): void {
  const file = manifestFile(dir, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, runId, assignments }), 'utf8');
}

function writeRuntimeContracts(dir: string, state: Record<string, unknown>, runId = RUN): void {
  const inputPath = architectureInputPath(dir, runId);
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify({
    schemaVersion: 1,
    routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
    modules: [
      { id: 'app-shell', name: 'App', kind: 'app-shell' },
      { id: 'home', name: 'Home', kind: 'page' },
    ],
  }));
  const architecture = compileArchitectureForRun(dir, runId, state);
  const verification = compileVerificationContract(dir, runId, state, architecture, {
    changedPaths: [],
  });
  publishRuntimeAssignments(dir, architecture, verification.contractHash);
}
function seedFallbackClaim(dir: string, target: string, holder: string, createdAt: string): void {
  const file = path.join(claimsDir(dir), `${safeKey(target)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, runId: RUN, path: target, holder, createdAt }), 'utf8');
}

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runteam-'));
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function gate(dir: string, state: Record<string, unknown>, filePath: string, raw: unknown, overrides: Partial<RunTeamArgs> = {}): string | null {
  return runTeamEnforcementViolation({
    projectRoot: dir,
    filePath,
    state: state as RunTeamArgs['state'],
    rawData: raw,
    featureTargetPaths: [filePath],
    writingFeatureSource: true,
    writingFeatureSourceViaCommand: false,
    block,
    ...overrides,
  });
}

// FE owns all of src/app except the api carve-out; BE owns the api carve-out + server.
const FE_BE_MANIFEST = [
  { role: 'senior-frontend', agentKey: 'senior-frontend', scope: { include: ['src/app/', 'src/components/'], exclude: ['src/app/api/'] } },
  { role: 'senior-backend', agentKey: 'senior-backend', scope: { include: ['src/app/api/', 'src/server/'] } },
];

test('manifest mode: writing inside my assigned scope is allowed', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    assert.equal(gate(dir, state, 'src/app/(public)/news/page.tsx', rawFor(THREAD)), null);
    assert.equal(gate(dir, state, 'src/components/Button.tsx', rawFor(THREAD)), null);
  });
});

test('manifest mode: writing inside another role\'s scope is a scope conflict', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    const reason = gate(dir, state, 'src/app/api/route.ts', rawFor(THREAD)); // carved out of FE, owned by BE
    assert.ok(reason && reason.includes('assigned scope'));
    assert.ok(reason && reason.includes('src/app/api/route.ts'));
    assert.ok(reason && reason.includes('senior-backend'));
  });
});

test('compiled v2 scope ignores stray-run manifests and fails closed when current assignments are tampered', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    writeRuntimeContracts(dir, state);
    writeManifest(dir, [
      { role: 'senior-frontend', scope: { include: ['apps/web/**'] } },
    ], 'stray-run');

    assert.equal(gate(dir, state, 'apps/web/src/pages/Home.tsx', rawFor(THREAD)), null);
    const outside = gate(dir, state, 'apps/web/src/pages/Other.tsx', rawFor(THREAD));
    assert.ok(outside && outside.includes('STRUCT_ASSIGNMENT_ALLOWLIST_GAP'));

    const currentPath = manifestFile(dir);
    const tampered = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;
    const assignments = tampered.assignments as Array<Record<string, unknown>>;
    (assignments[0]!.scope as Record<string, unknown>).include = ['apps/web/**'];
    fs.writeFileSync(currentPath, JSON.stringify(tampered));
    const invalid = gate(dir, state, 'apps/web/src/pages/Home.tsx', rawFor(THREAD));
    assert.ok(invalid && invalid.includes('missing, stale, or tampered'));
  });
});

test('tester overlay: senior-tester may write test files inside implementer scopes (B2)', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-tester', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    // test file inside senior-frontend's scope
    assert.equal(gate(dir, state, 'src/components/Button.test.tsx', rawFor(THREAD)), null);
    // test file inside senior-backend's scope
    assert.equal(gate(dir, state, 'src/app/api/__tests__/route.test.ts', rawFor(THREAD)), null);
  });
});

test('tester overlay: test-runner configs are tester-owned even inside FE scope (8c/11c/12c)', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-tester', { parentSessionId: 'orchestrator' }));
    // 12c shape: the architect's frontend assignment explicitly covers the
    // root test configs, which used to deny every tester write to them.
    writeManifest(dir, [
      {
        role: 'senior-frontend',
        agentKey: 'senior-frontend',
        scope: { include: ['src/app/', 'src/components/', 'vitest.setup.ts', 'playwright.config.ts', 'apps/web/jest.config.js', 'next.config.js'] },
      },
      { role: 'senior-backend', agentKey: 'senior-backend', scope: { include: ['src/app/api/'] } },
    ]);
    assert.equal(gate(dir, state, 'vitest.setup.ts', rawFor(THREAD)), null);
    assert.equal(gate(dir, state, 'playwright.config.ts', rawFor(THREAD)), null);
    assert.equal(gate(dir, state, 'apps/web/jest.config.js', rawFor(THREAD)), null);
    // app bundler config is NOT test infra — still frontend-owned
    const reason = gate(dir, state, 'next.config.js', rawFor(THREAD));
    assert.ok(reason && reason.includes('assigned scope'));
    // mixed test-config + app-config patch stays all-or-nothing → denied
    const mixed = gate(dir, state, 'playwright.config.ts', rawFor(THREAD), {
      featureTargetPaths: ['playwright.config.ts', 'next.config.js'],
    });
    assert.ok(mixed && mixed.includes('assigned scope'));
  });
});

test('tester overlay: non-test feature source is still denied for senior-tester', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-tester', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    const reason = gate(dir, state, 'src/app/api/route.ts', rawFor(THREAD));
    assert.ok(reason && reason.includes('assigned scope'));
    // mixed test + source patch is not exempted either (all-or-nothing)
    const mixed = gate(dir, state, 'src/components/Button.test.tsx', rawFor(THREAD), {
      featureTargetPaths: ['src/components/Button.test.tsx', 'src/app/api/route.ts'],
    });
    assert.ok(mixed && mixed.includes('assigned scope'));
  });
});

test('tester overlay: works without an assignments manifest (legacy mode)', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-tester', { parentSessionId: 'orchestrator' }));
    // no manifest written — legacy regex-ownership branch previously denied with run-team-wrong-role
    assert.equal(gate(dir, state, 'src/components/Button.test.tsx', rawFor(THREAD)), null);
    const reason = gate(dir, state, 'src/app/api/route.ts', rawFor(THREAD));
    assert.ok(reason && reason.includes('does not own'));
  });
});

test('manifest mode: assignment-owned non-source writes bind a pending backend claim', () => {
  withDir((dir) => {
    const state = baseState();
    ensureRunAgentClaim(dir, state, 'senior-backend', { session_id: 'orchestrator' }, { toolName: 'Task' });
    writeManifest(dir, [
      { role: 'senior-backend', scope: { include: ['supabase/**', '.env.example', 'README.md'] } },
    ]);
    const transcript = writeTranscript(dir, THREAD, '[t1-role: senior-backend]\nImplement Supabase migrations and README for run run-1.');

    const reason = runTeamEnforcementViolation({
      projectRoot: dir,
      filePath: 'README.md',
      state: state as RunTeamArgs['state'],
      rawData: { session_id: 'orchestrator', transcript_path: transcript },
      writeTargetPaths: ['README.md'],
      featureTargetPaths: [],
      writingFeatureSource: false,
      writingFeatureSourceViaCommand: false,
      block,
    });

    assert.equal(reason, null);
    assert.ok(fs.existsSync(path.join(dir, '.traffic-one', 'runs', RUN, `${THREAD}.json`)),
      'backend child claim should be persisted even though README.md is not feature source');
    const pending = path.join(dir, '.traffic-one', 'runs', RUN, 'pending');
    assert.deepEqual(fs.readdirSync(pending).filter((name) => name.endsWith('.json')), []);
  });
});

test('manifest mode: unassigned path -> first writer allowed and a claim is recorded', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    const target = 'scripts/seed-data.ts'; // outside every assignment
    assert.equal(gate(dir, state, target, rawFor(THREAD)), null);
    const lock = JSON.parse(fs.readFileSync(path.join(claimsDir(dir), `${safeKey(target)}.json`), 'utf8'));
    assert.equal(lock.holder, THREAD);
    assert.equal(lock.path, target);
  });
});

test('manifest mode: unassigned path already held by another live agent is blocked', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    const target = 'scripts/seed-data.ts';
    seedFallbackClaim(dir, target, 'another-thread-id', new Date().toISOString());
    const reason = gate(dir, state, target, rawFor(THREAD));
    assert.ok(reason && reason.includes('already being written'));
    assert.ok(reason && reason.includes('another-thread-id'));
  });
});

test('manifest mode: a stale fallback claim is reclaimable', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    const target = 'scripts/seed-data.ts';
    seedFallbackClaim(dir, target, 'abandoned-thread', '2000-01-01T00:00:00.000Z');
    assert.equal(gate(dir, state, target, rawFor(THREAD)), null); // stale -> reclaimed, allowed
  });
});

// --- Cursor scope-attribution: a worker write with NO transcript/parent/role linkage
// (transcript_path:null) is attributed by assigned scope (the tests/3c build-fatal fix). ---

test('cursor scope-attribution: a foreign worker write with no linkage is attributed by assigned scope', () => {
  withDir((dir) => {
    const state = baseState();
    recordMainOnboardingSession(dir, 'orchestrator'); // SubagentStart records the parent as MAIN
    writeManifest(dir, FE_BE_MANIFEST);
    // A Cursor child worker write: only its own session_id — no transcript_path, no
    // parent_session_id, no subagent_type, no [t1-role] marker (the real 3c shape).
    const childRaw = { session_id: 'cursor-child-fe', tool_name: 'Write' };
    // src/app/... is in senior-frontend's scope → attributed → allowed (was hard-denied).
    assert.equal(gate(dir, state, 'src/app/(public)/news/page.tsx', childRaw), null);
    const claimFile = path.join(dir, '.traffic-one', 'runs', RUN, 'cursor-child-fe.json');
    assert.ok(fs.existsSync(claimFile), 'a claim is staked for the worker session');
    assert.equal(JSON.parse(fs.readFileSync(claimFile, 'utf8')).role, 'senior-frontend');
    // A parallel backend worker writing the api carve-out is attributed to senior-backend.
    assert.equal(gate(dir, state, 'src/app/api/route.ts', { session_id: 'cursor-child-be', tool_name: 'Write' }), null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', RUN, 'cursor-child-be.json'), 'utf8')).role, 'senior-backend');
  });
});

test('cursor scope-attribution: the orchestrator (recorded main) session is NOT attributed — parent feature write stays denied', () => {
  withDir((dir) => {
    const state = baseState();
    recordMainOnboardingSession(dir, 'orchestrator');
    writeManifest(dir, FE_BE_MANIFEST);
    // The orchestrator's OWN write — its session is a recorded MAIN session, not foreign.
    const reason = gate(dir, state, 'src/app/(public)/news/page.tsx', { session_id: 'orchestrator', tool_name: 'Write' });
    assert.ok(reason && reason.includes('team.mode'), 'parent feature-source write is still denied');
  });
});

test('cursor scope-attribution: a foreign worker write to an unowned path is not attributed (denied)', () => {
  withDir((dir) => {
    const state = baseState();
    recordMainOnboardingSession(dir, 'orchestrator');
    writeManifest(dir, FE_BE_MANIFEST);
    // scripts/seed.ts is outside every assignment scope → no unique owner → not attributed.
    const reason = gate(dir, state, 'scripts/seed.ts', { session_id: 'cursor-child-x', tool_name: 'Write' });
    assert.ok(reason && reason.includes('team.mode'), 'an unowned foreign write is not silently attributed');
  });
});

test('shell-command feature write is denied (cannot verify ownership)', () => {
  withDir((dir) => {
    const state = baseState();
    const reason = gate(dir, state, 'src/app/page.tsx', rawFor(THREAD), { writingFeatureSourceViaCommand: true });
    assert.ok(reason && reason.includes('shell command'));
  });
});

test('architect cannot create empty package barrel scaffold before runtime assignments exist', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-architect', { parentSessionId: 'orchestrator' }));
    const ui = gate(dir, state, 'packages/ui/src/index.ts', rawFor(THREAD), {
      content: '// @app/ui scaffold\nexport {};\n',
    });
    const i18n = gate(dir, state, 'packages/i18n/src/index.ts', rawFor(THREAD), {
      content: '/* filled by senior-frontend */\n',
    });
    assert.ok(ui && ui.includes('does not own'));
    assert.ok(i18n && i18n.includes('does not own'));
  });
});

test('architect empty-barrel exception does not allow package implementation source', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-architect', { parentSessionId: 'orchestrator' }));
    const reason = gate(dir, state, 'packages/ui/src/index.ts', rawFor(THREAD), {
      content: 'export function Button() { return null; }\n',
    });
    assert.ok(reason && reason.includes('does not own'));
    assert.ok(reason && reason.includes('packages/ui/src/index.ts'));
  });
});

test('manifest mode: an architect scaffold reservation conflicts and cannot be ignored', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-backend', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, [
      { role: 'senior-architect', scope: { include: ['packages/types/src/index.ts'] } },
      { role: 'senior-backend', scope: { include: ['packages/types/'], exclude: ['packages/types/src/index.ts'] } },
    ]);
    const reason = gate(dir, state, 'packages/types/src/index.ts', rawFor(THREAD));
    assert.ok(reason && reason.includes('senior-architect'));
    assert.ok(reason && reason.includes('assigned scope'));
  });
});

test('not a subagent session in a subagents project is denied (building phase)', () => {
  withDir((dir) => {
    const state = baseState({ currentRunId: undefined }); // no run state, no claim -> main agent
    const reason = gate(dir, state, 'src/app/page.tsx', {});
    assert.ok(reason && reason.includes('team.mode'));
  });
});

test('maintenance phase fails closed for an unattributed write without a bounded contract', () => {
  withDir((dir) => {
    // existing-codebase infers maintenance (also covers a new-project flipped to it).
    // The host where this bit users keeps every run-claim `pending`, so the worker's
    // write resolves to no context → would deny run-team-not-subagent in a build.
    const state = baseState({ mode: 'existing-codebase' });
    const first = gate(dir, state, 'src/app/(public)/news/page.tsx', {});
    assert.ok(first && first.includes('maintenance writes fail closed'));
    // Even a stale BUILD manifest that scopes the path to another role must not block
    // a maintenance edit (the quick-fix worker is never in that manifest).
    writeManifest(dir, FE_BE_MANIFEST);
    const second = gate(dir, state, 'src/app/api/route.ts', rawFor(THREAD));
    assert.ok(second && second.includes('maintenance writes fail closed'));
  });
});

test('legacy mode (no manifest): a path owned by the active role is allowed', () => {
  withDir((dir) => {
    const state = baseState({ frontend: 'nextjs', materializedStack: 'default|nextjs|supabase|none' });
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    // no manifest written
    assert.equal(gate(dir, state, 'src/app/(public)/news/page.tsx', rawFor(THREAD)), null);
  });
});

test('quick-fix writes require the exact parent-bounded bootstrap scope', () => {
  withDir((dir) => {
    const state = baseState({
      mode: 'existing-codebase',
      frontend: 'nextjs',
      materializedStack: 'default|nextjs|supabase|none',
    });
    assert.ok(claimThreadRole(dir, state, THREAD, 'quick-fix', { parentSessionId: 'orchestrator' }));
    const absent = gate(dir, state, 'src/components/Button.tsx', rawFor(THREAD));
    assert.ok(absent && absent.includes('no valid parent-published WorkUnitContract'));
    const bootstrap = ensureRunBootstrap(dir, RUN, 'quick-fix', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'test-parent-maintenance',
      modelPolicyId: 'test-policy',
      boundedOutputs: [
        'src/components/Button.tsx',
        'src/app/api/join/route.ts',
      ],
    });
    assert.ok(bootstrap);
    assert.equal(gate(dir, state, 'src/components/Button.tsx', rawFor(THREAD)), null);
    assert.equal(gate(dir, state, 'src/app/api/join/route.ts', rawFor(THREAD)), null);
    const outside = gate(dir, state, 'src/components/Other.tsx', rawFor(THREAD));
    assert.ok(outside && outside.includes('no valid parent-published WorkUnitContract'));
  });
});

test('maintenance run-team applies to non-web source layouts (the Go internal/ hole)', () => {
  withDir((dir) => {
    const state = baseState({
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      materializedStack: 'custom-backend|none|go|none',
    });
    // `internal/store.go` is not feature source under FEATURE_SOURCE_RE (that
    // regex models the prescribed web layouts), so the caller classifies it
    // false — before the fix that bypassed run-team entirely and the parent
    // could edit Go source directly in a subagents maintenance project.
    const asProduction = { writingFeatureSource: false, featureTargetPaths: [] as string[] };
    const parent = gate(dir, state, 'internal/store.go', {}, asProduction);
    assert.ok(parent && parent.includes('maintenance writes fail closed'));
    // A bound quick-fix without a contract fails closed on Go paths too…
    assert.ok(claimThreadRole(dir, state, THREAD, 'quick-fix', { parentSessionId: 'orchestrator' }));
    const noContract = gate(dir, state, 'internal/store.go', rawFor(THREAD), asProduction);
    assert.ok(noContract && noContract.includes('no valid parent-published WorkUnitContract'));
    // …inside the parent-bounded allowlist it is allowed, outside it stays denied.
    const bootstrap = ensureRunBootstrap(dir, RUN, 'quick-fix', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'test-parent-maintenance',
      modelPolicyId: 'test-policy',
      boundedOutputs: ['internal/store.go'],
    });
    assert.ok(bootstrap);
    assert.equal(gate(dir, state, 'internal/store.go', rawFor(THREAD), asProduction), null);
    const outside = gate(dir, state, 'cmd/catalogue/main.go', rawFor(THREAD), asProduction);
    assert.ok(outside && outside.includes('no valid parent-published WorkUnitContract'));
    // Non-source parent writes (docs, configs outside the artifact set) are
    // still not run-team targets — maintenance does not lock the whole repo.
    assert.equal(gate(dir, state, 'README.md', {}, asProduction), null);
  });
});

test('legacy mode (no manifest): an unowned path falls back to a first-write claim, not a deadlock', () => {
  withDir((dir) => {
    const state = baseState({ frontend: 'nextjs', materializedStack: 'default|nextjs|supabase|none' });
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    const target = 'src/models/user.ts'; // unowned by the legacy regex -> would have hard-deadlocked before
    assert.equal(gate(dir, state, target, rawFor(THREAD)), null);
    assert.ok(fs.existsSync(path.join(claimsDir(dir), `${safeKey(target)}.json`)));
  });
});

test('totality invariant: the gate never hard-deadlocks (no run-team-not-owned prose, never throws)', () => {
  withDir((dir) => {
    const state = baseState();
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    writeManifest(dir, FE_BE_MANIFEST);
    const probes = [
      'src/app/page.tsx',         // mine
      'src/app/api/route.ts',     // another's
      'scripts/x.ts',             // unassigned
      'src/models/user.ts',       // unassigned, would deadlock under old regex
      'packages/core/src/i.ts',   // unassigned monorepo pkg, would deadlock under old regex
      'weird/totally/novel.kt',   // any stack
    ];
    for (const p of probes) {
      let result: string | null = null;
      assert.doesNotThrow(() => { result = gate(dir, state, p, rawFor(THREAD)); });
      // result is exactly null (allow) or a deny string — never the old deadlock/"gate bug" prose.
      if (result !== null) {
        assert.equal(typeof result, 'string');
        assert.ok(!(result as string).includes('not under any Traffic One role'));
        assert.ok(!(result as string).includes('gate bug'));
      }
    }
  });
});

// --- pure-function coverage: readRunAssignments + assignmentForContext --------

test('readRunAssignments accepts arbitrary role labels and N>2 streams', () => {
  withDir((dir) => {
    writeManifest(dir, [
      { role: 'web', scope: { include: ['resources/js/'] } },
      { role: 'api', scope: { include: ['app/Http/', 'routes/'] } },
      { role: 'worker', scope: { include: ['app/Jobs/'] } },
    ]);
    const manifest = readRunAssignments(dir, RUN);
    assert.ok(manifest);
    assert.equal(manifest!.assignments.length, 3);
    assert.deepEqual(manifest!.assignments.map((a) => a.role), ['web', 'api', 'worker']);
  });
});

test('assignmentForContext joins by indexed agentKey, then role key, then sole role', () => {
  const manifest = {
    version: 1, runId: RUN, assignments: [
      { role: 'senior-frontend', agentKey: 'senior-frontend#2', scope: { include: ['b/'] } },
      { role: 'senior-frontend', agentKey: 'senior-frontend', scope: { include: ['a/'] } },
      { role: 'senior-backend', scope: { include: ['c/'] } },
    ],
  };
  const ctx = (role: string, spawnIndex = 1): RunAgentContext =>
    ({ source: 't', runId: RUN, role, spawnIndex, sessionId: null, claimId: null });
  assert.equal(assignmentForContext(manifest, ctx('senior-frontend', 2))?.agentKey, 'senior-frontend#2');
  assert.equal(assignmentForContext(manifest, ctx('senior-frontend', 9))?.agentKey, 'senior-frontend'); // role-key fallback
  assert.equal(assignmentForContext(manifest, ctx('senior-backend'))?.role, 'senior-backend'); // sole role
});

test('readRunAssignments returns null for absent or malformed manifests', () => {
  withDir((dir) => {
    assert.equal(readRunAssignments(dir, RUN), null); // absent
    writeManifest(dir, 'not-an-array' as unknown as unknown[]);
    assert.equal(readRunAssignments(dir, RUN), null); // assignments not an array
    writeManifest(dir, [{ role: 'x', scope: { include: [] } }, { scope: { include: ['a/'] } }]);
    assert.equal(readRunAssignments(dir, RUN), null); // no entry has both a role and a non-empty include
  });
});

// A maintenance request rotates a FRESH run with no compiled architecture, so
// `runtimeAssignments` is always null by the time this gate runs. `quick-fix`
// has always had a door — it consults its own bootstrap contract — and the two
// senior implementers never did, even though the runtime mints them
// `${role}:bounded-maintenance` envelopes and the spawn gate already recognizes
// those. So the paid fallback the task-triage skill prescribes ("if OpenCode
// declines, spawn that paid role subagent") was dead on its FIRST write, on
// every host, since v1.0.20. Found by fanning out over the 16co run.
test('maintenance: a senior implementer with a bounded contract may write inside it', () => {
  withDir((dir) => {
    const state = baseState({
      mode: 'existing-codebase',
      currentRunId: 'MNT',
      lifecycle: { phase: 'maintenance', completedAt: '2026-08-01T18:36:01Z' },
    });
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    const bounded = ensureRunBootstrap(dir, 'MNT', 'senior-frontend', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'parent-maintenance-preflight',
      modelPolicyId: 'policy-maintenance',
      boundedOutputs: ['src/pages/Pricing.tsx'],
      boundedAllowlist: ['src/pages/Pricing.tsx'],
    });
    assert.ok(bounded, 'the runtime must mint a bounded-maintenance envelope for a senior role');
    assert.equal(bounded.workUnit.unitId, 'senior-frontend:bounded-maintenance');

    assert.equal(
      gate(dir, state, 'src/pages/Pricing.tsx', rawFor(THREAD)),
      null,
      'a write the bounded allowlist covers must be allowed',
    );

    // Negative row 1: the contract binds, so a target OUTSIDE the allowlist is
    // still refused. Without this the fix would be a hole, not a door.
    const outside = gate(dir, state, 'src/pages/Checkout.tsx', rawFor(THREAD));
    assert.ok(outside, 'a target outside the bounded allowlist must still be denied');
    assert.match(String(outside), /maintenance writes fail closed/);
  });
});

test('maintenance: a senior implementer with NO bounded contract is still refused', () => {
  withDir((dir) => {
    const state = baseState({
      mode: 'existing-codebase',
      currentRunId: 'MNT2',
      lifecycle: { phase: 'maintenance', completedAt: '2026-08-01T18:36:01Z' },
    });
    assert.ok(claimThreadRole(dir, state, THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' }));
    // No ensureRunBootstrap call: nothing published, so nothing to bind to.
    const denied = gate(dir, state, 'src/pages/Pricing.tsx', rawFor(THREAD));
    assert.ok(denied, 'an unattributed maintenance write must fail closed');
    assert.match(String(denied), /maintenance writes fail closed/);
  });
});

// --- run-team-not-subagent: the remedy must match the CAUSE. ---
//
// Resolution collapses at least three causes into one `null`, and the child
// branch answered all of them with the same destructive instruction: "the
// PARENT/orchestrator must stop or replace this child". Two of the three do not
// deserve it. These rows pin the discrimination, not the wording — each one
// asserts what the deny PRESCRIBES and, where the cause is transient, that the
// prescription actually works.

// A claims lock another hook holds for ~2s stops claimThreadRole from minting,
// resolution then reports NO role, and this in-scope write is denied as `main
// agent`. Nothing about the child is wrong: the second half of this test runs
// the retry the deny now prescribes FIRST, and the same write goes through.
test('a contended claims lock prescribes retrying the write before replacing the child', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    const transcript = writeTranscript(dir, THREAD, '[t1-role: senior-frontend]\nImplement the news page for run run-1.');
    const raw = { session_id: 'orchestrator', transcript_path: transcript };
    const target = 'src/app/(public)/news/page.tsx';

    holdRunLock(dir, RUN, 'claims');
    const started = Date.now();
    const denied = gate(dir, state, target, raw);
    const elapsed = Date.now() - started;
    assert.ok(denied, 'a claim that could not be minted still fails closed — the write is refused either way');
    assert.ok(elapsed >= 1_500,
      `expected a full claims-lock timeout, got ${elapsed}ms — without it this row measures no contention`);

    assert.match(denied!, /Retry this exact write ONCE before anything else/);
    assert.match(denied!, /claims or model-observation lock/);
    assert.doesNotMatch(denied!, /Do not retry the edit/,
      'the old text forbade the one action that actually recovers this');
    // The teeth stay, CONDITIONED on the retry having already failed.
    assert.match(denied!, /If the same deny repeats, the claim is genuinely absent and the PARENT\/orchestrator must stop or replace this child/);
    assert.ok(
      denied!.indexOf('Retry this exact write ONCE') < denied!.indexOf('stop or replace this child'),
      'the cheap recovery must be prescribed before the destructive one, not after it',
    );

    // The prescribed retry, with the contention gone: the claim mints and the
    // write is allowed. This is what makes "retry first" true rather than softer.
    fs.rmSync(runLockDir(dir, RUN, 'claims'), { recursive: true, force: true });
    assert.equal(gate(dir, state, target, raw), null,
      'the retry the deny prescribes must actually bind the claim and pass the write');
  });
});

// The one cause a respawn CANNOT fix, and the reason the retry above can be
// prescribed honestly: a closed run admits no claim from any child, so both
// "retry" and "replace the child" are futile there (the 10co respawn loop).
// Probed first, exactly as codex-child-model.ts orders its own claim probes.
test('a closed run ledger names the run, and forbids both the retry and the respawn', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    const transcript = writeTranscript(dir, THREAD, '[t1-role: senior-frontend]\nImplement the news page for run run-1.');
    const raw = { session_id: 'orchestrator', transcript_path: transcript };
    assert.ok(transitionRunStatus(dir, RUN, { status: 'active' }));
    assert.ok(transitionRunStatus(dir, RUN, { status: 'blocked', outcome: 'test-cycle-cap' }));

    const denied = gate(dir, state, 'src/app/(public)/news/page.tsx', raw);
    assert.ok(denied, 'a closed run still refuses the write');
    assert.match(denied!, /run ledger for `run-1` is `blocked` \(test-cycle-cap\), which admits NO claim from any child/);
    assert.match(denied!, /resumes the RUN first/);
    assert.match(denied!, /do not stop or replace this child/);
    assert.doesNotMatch(denied!, /must stop or replace this child/,
      'a replacement binds no claim in a closed run either — ordering one is the respawn loop');
    assert.doesNotMatch(denied!, /Retry this exact write ONCE/,
      'nothing clears here on its own, so the retry must not be offered');
    assert.doesNotMatch(denied!, /task_name/,
      'naming the spawn contract reads as an instruction to respawn, which is the wrong action here');
  });
});

// …and the run is closed for the PARENT too. The closed-ledger fact was computed
// unconditionally but read only by the child arm, so a parent write into a closed
// run rendered byte-for-byte as an open one and was told to "Spawn the owning
// role" — a role that cannot bind a claim in that run either. That is the same
// respawn loop the child arm exists to prevent, reached from the other side.
// The open half is the mutation guard: the suppression must be the LEDGER's doing.
test('a closed run ledger stops the parent arm ordering a spawn into it', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    // No child signal anywhere on this payload: no transcript, no parent id, no
    // subagent marker — so `unresolvedChild` is false and the parent arm renders.
    const raw = { session_id: 'orchestrator', tool_name: 'Write' };
    const target = 'src/app/(public)/news/page.tsx';

    assert.ok(transitionRunStatus(dir, RUN, { status: 'active' }));
    assert.equal(runLedgerAdmitsClaims(dir, RUN), true,
      'fixture: the control half must run against a run that genuinely ADMITS claims, '
      + 'or it measures nothing and the closed half proves no discrimination');
    const open = gate(dir, state, target, raw);
    assert.ok(open, 'a parent feature-source write is denied in a subagents project');
    assert.match(open!, /Spawn the owning role, or message its already-live agent/,
      'in a run that admits claims, spawning the owner is the action that works');
    assert.match(open!, /task_name/);

    assert.ok(transitionRunStatus(dir, RUN, { status: 'blocked', outcome: 'test-cycle-cap' }));
    assert.equal(runLedgerAdmitsClaims(dir, RUN), false,
      'fixture: the run must actually be closed to claims — that is the whole input');

    const closed = gate(dir, state, target, raw);
    assert.ok(closed, 'a closed run still refuses the parent write');
    assert.match(closed!, /You are the PARENT\/orchestrator/,
      'this row is about the PARENT arm; matching the child arm here would prove nothing');
    assert.match(closed!, /run ledger for `run-1` is `blocked` \(test-cycle-cap\), which admits NO claim from any child/,
      'the closed-run fact must be CONSULTED by the arm that renders, not computed and dropped');
    assert.doesNotMatch(closed!, /Spawn the owning role/,
      'the spawned role cannot bind a claim in a closed run either — ordering one is the respawn loop');
    assert.doesNotMatch(closed!, /task_name/,
      'naming the spawn contract reads as an instruction to take it (CHILD_SPAWN_CONTRACT says so itself)');
    // The reader must never be left with a paragraph that names no action — the
    // failure mode of suppressing the spawn tail without replacing it.
    assert.match(closed!, /Resume the RUN first \(only if the user authorized another cycle\), or settle it and mint a fresh one/,
      'the orchestrator is the actor here, so the remedy is addressed to them directly');
    // The taxonomy is the child arm's, but the addressee is not: nothing here may
    // report what some third party does, or talk about a child that is not present.
    assert.doesNotMatch(closed!, /The PARENT\/orchestrator resumes the RUN/,
      'the reader IS the orchestrator on this arm');
    assert.doesNotMatch(closed!, /This appears to be a spawned child/);
  });
});

// The case the destructive prose was WRITTEN for, and it must keep its teeth: a
// child-shaped write with no claim, no pending handoff and no role evidence
// anywhere. A blanket softening would have traded one defect for a worse one.
test('a child that never claimed a role still gets the firm parent instruction', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    // No transcript on disk, so nothing names a role: a self-asserted role in
    // prose creates no claim, which is precisely what the deny says.
    const denied = gate(dir, state, 'src/app/(public)/news/page.tsx', rawFor(THREAD));
    assert.ok(denied);
    assert.match(denied!, /PARENT\/orchestrator must stop or replace this child and retry the same role/);
    assert.match(denied!, /prose cannot create a claim/);
    assert.match(denied!, /`senior_frontend`/, 'the respawn contract belongs on the branch that ends in a respawn');
  });
});

// --- run-team-not-subagent: the drift DIAGNOSIS and the recovery paragraph are
// two answers to the SAME question, so they compose instead of concatenating. ---
//
// The diagnosis was appended to whichever recovery arm was chosen, and two of the
// three arms END in a respawn order. Those two renders told the operator to
// replace a child (or to spawn a role) and then, in the next sentence, that
// respawning will NOT fix it. Measured over the full 3-arm x drift/no-drift render
// space: exactly two of the six renders carried both orders, and they are the two
// pinned below. The remaining four are byte-identical to their pre-fix bytes,
// which is what the two no-drift rows and the closed-ledger row here defend.

// A claim that EXISTS under `key` and is rejected on IDENTITY, which is the only
// thing the drift arm reacts to. Minted for real first — that is what freezes the
// run ledger's fingerprint — then drifted, because a hand-written claim beside a
// ledger with no frozen stamp is not a mismatch at all (claimRejectReason falls
// back to run-id scoping) and the row would pass while measuring nothing.
function seedIdentityDriftedClaim(dir: string, state: Record<string, unknown>, key: string, role = 'senior-frontend'): void {
  assert.ok(claimThreadRole(dir, state, key, role, { parentSessionId: 'orchestrator' }),
    'fixture: the claim must mint before it can drift');
  const file = path.join(dir, '.traffic-one', 'runs', RUN, `${key}.json`);
  const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(typeof claim.stackFingerprint, 'string',
    'fixture: a minted claim must carry the stamp this row drifts');
  claim.stackFingerprint = 'drifted|none|none|none';
  fs.writeFileSync(file, JSON.stringify(claim), 'utf8');
}

// The core contradiction: a child whose claim was REJECTED on identity was told
// the claim is "genuinely absent" and that the parent "must stop or replace this
// child" — immediately followed by "Respawning will NOT fix this". A claim that
// exists is not absent, and the replacement is rejected the same way, so the
// order goes and the diagnosis keeps the remedy.
test('an identity-rejected claim suppresses the respawn order it used to contradict', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    seedIdentityDriftedClaim(dir, state, THREAD);

    const denied = gate(dir, state, 'src/app/(public)/news/page.tsx', rawFor(THREAD));
    assert.ok(denied, 'an unbindable claim still fails closed — the write is refused either way');
    assert.match(denied!, /DIAGNOSIS: a role claim for `senior-frontend` exists under run `run-1` but was rejected \(fingerprint-mismatch/,
      'without the diagnosis this row is measuring the no-drift arm and proves nothing');
    assert.doesNotMatch(denied!, /must stop or replace this child/,
      'the same deny already says respawning will not fix this');
    assert.doesNotMatch(denied!, /task_name/,
      'naming the spawn contract reads as an instruction to take it (CHILD_SPAWN_CONTRACT says so itself)');
    // What survives: the cheapest recovery, which is respawn-free and still
    // possible (a held claims lock can coexist with a drifted claim elsewhere on
    // disk), plus the two remedies that actually terminate here.
    assert.match(denied!, /Retry this exact write ONCE before anything else/);
    assert.match(denied!, /settle this run so a fresh one mints with the current identity/);
  });
});

// The parent arm had the same defect, and it is REACHABLE: `unresolvedChild` reads
// the payload's own child signals, while the diagnosis keys its claim lookup on
// [agentId, threadId, sessionId] — session id included. So a claim under the
// session id the payload carries, with no child signal on that payload, renders
// "Spawn the owning role" and "Respawning will NOT fix this" together. The
// no-drift half is the mutation guard: the suppression must be conditional.
test('an identity-rejected claim suppresses the parent arm\'s spawn order, and keeps it without drift', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    const raw = { session_id: 'orchestrator', tool_name: 'Write' };

    const clean = gate(dir, state, 'src/app/(public)/news/page.tsx', raw);
    assert.ok(clean, 'a parent feature-source write is denied in a subagents project');
    assert.match(clean!, /Spawn the owning role, or message its already-live agent/,
      'with no drift the parent arm must still name the action that works');
    assert.match(clean!, /task_name/);

    seedIdentityDriftedClaim(dir, state, 'orchestrator');
    const drifted = gate(dir, state, 'src/app/(public)/news/page.tsx', raw);
    assert.ok(drifted);
    assert.match(drifted!, /DIAGNOSIS: a role claim for `senior-frontend` exists under run `run-1` but was rejected \(fingerprint-mismatch/);
    assert.doesNotMatch(drifted!, /Spawn the owning role/,
      'the next sentence says respawning will not fix this');
    assert.doesNotMatch(drifted!, /task_name/);
    // The refusal itself and a terminating remedy both survive the suppression.
    assert.match(drifted!, /do not edit owned implementation artifacts yourself/);
    assert.match(drifted!, /Let the next SessionStart reconcile it, or settle this run/);
  });
});

// …and the actor that render is addressed to is not always the parent. A Cursor
// worker's write can carry NO linkage at all (transcript_path null, no parent id,
// no subagent_type), so `unresolvedChild` is false for a REAL child, and the gate's
// own scope attribution stakes that child's claim under its SESSION id — the key
// the diagnosis looks up. Once attribution stops (here the recorded main session
// ages past its 15-minute TTL, so nothing is foreign any more; a missing manifest
// or a scope-spanning patch do it too) the same child gets the parent arm. This is
// the construction that makes the parent-arm contradiction a live render rather
// than a theoretical one.
test('the parent arm renders for a real child whose own staked claim drifted', () => {
  withDir((dir) => {
    const state = baseState();
    recordMainOnboardingSession(dir, 'orchestrator-main');
    writeManifest(dir, FE_BE_MANIFEST);
    const childRaw = { session_id: 'cursor-child-fe', tool_name: 'Write' };

    assert.equal(gate(dir, state, 'src/app/(public)/news/page.tsx', childRaw), null,
      'fixture: the foreign worker write must be attributed by scope first');
    const claimFile = path.join(dir, '.traffic-one', 'runs', RUN, 'cursor-child-fe.json');
    assert.ok(fs.existsSync(claimFile),
      'fixture: the gate must stake the claim under the SESSION id — that provenance is the point');
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8')) as Record<string, unknown>;
    claim.stackFingerprint = 'drifted|none|none|none';
    fs.writeFileSync(claimFile, JSON.stringify(claim), 'utf8');
    // Age the recorded orchestrator out of its TTL: with no fresh main session,
    // no thread is foreign, so scope attribution stops re-binding this worker.
    recordMainOnboardingSession(dir, 'orchestrator-main', Date.now() - ONBOARDING_MAIN_TTL_MS - 60_000);

    const denied = gate(dir, state, 'src/app/(public)/news/page.tsx', childRaw);
    assert.ok(denied, 'an unattributable worker write fails closed');
    assert.match(denied!, /You are the PARENT\/orchestrator/,
      'this is the render the parent arm hands a child the gate could not attribute');
    assert.match(denied!, /DIAGNOSIS: a role claim for `senior-frontend` exists under run `run-1` but was rejected \(fingerprint-mismatch/);
    assert.doesNotMatch(denied!, /Spawn the owning role/);
  });
});

// The constraint that makes this a composition and not a deletion: on the
// closed-ledger arm the diagnosis is purely ADDITIVE. That arm already forbids the
// respawn and already offers settle-and-remint, so the diagnosis only adds the
// fingerprints — a blanket "stop appending the diagnosis" fix would delete a
// useful reading of a run nobody can write in.
test('a closed run ledger keeps the drift diagnosis alongside its own remedy', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    seedIdentityDriftedClaim(dir, state, THREAD);
    assert.ok(transitionRunStatus(dir, RUN, { status: 'blocked', outcome: 'test-cycle-cap' }));

    const denied = gate(dir, state, 'src/app/(public)/news/page.tsx', rawFor(THREAD));
    assert.ok(denied);
    // Both halves, in one render: the closed-ledger prescription…
    assert.match(denied!, /which admits NO claim from any child/);
    assert.match(denied!, /resumes the RUN first/);
    assert.match(denied!, /do not stop or replace this child/);
    // …and the fingerprints, which are the whole value of the diagnosis here.
    assert.match(denied!, /claim `drifted\|none\|none\|none` vs run `default\|react-vite\|supabase\|none`/);
    assert.match(denied!, /Respawning will NOT fix this/);
  });
});

// The same additivity on the PARENT side, and it is the row that keeps the two
// suppressors composing instead of one swallowing the other: a closed ledger
// selects the arm, drift decides whether the OPEN arm keeps its tail. Neither may
// silence the other, and both halves of this render answer the same question the
// same way — spawn nothing, settle or resume the run.
test('a closed run ledger keeps the drift diagnosis on the parent arm too', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    // Keyed by the SESSION id the payload carries: that is the key the diagnosis
    // looks up, and the reason the parent arm sees drift at all.
    seedIdentityDriftedClaim(dir, state, 'orchestrator');
    assert.ok(transitionRunStatus(dir, RUN, { status: 'blocked', outcome: 'test-cycle-cap' }));
    assert.equal(runLedgerAdmitsClaims(dir, RUN), false,
      'fixture: without a genuinely closed run this row measures the open parent arm');

    const denied = gate(dir, state, 'src/app/(public)/news/page.tsx', { session_id: 'orchestrator', tool_name: 'Write' });
    assert.ok(denied);
    assert.match(denied!, /You are the PARENT\/orchestrator/);
    // The closed-run arm, whole…
    assert.match(denied!, /which admits NO claim from any child/);
    assert.match(denied!, /Resume the RUN first \(only if the user authorized another cycle\), or settle it and mint a fresh one/);
    // …and the fingerprints, which are the whole value of the diagnosis here.
    assert.match(denied!, /claim `drifted\|none\|none\|none` vs run `default\|react-vite\|supabase\|none`/);
    assert.match(denied!, /Respawning will NOT fix this/);
    assert.doesNotMatch(denied!, /Spawn the owning role/);
  });
});

// The suppression above is only correct for a claim that is THIS run's. A host
// that reuses one session id across runs (Cursor) leaves the previous run's
// claims on disk under the same key, and explainUnresolvedRunAgent scans every
// run directory — so a child that never claimed in this run used to be handed the
// drift diagnosis built from the PREVIOUS run's leftover, and the suppression
// then took away the respawn order, which is exactly the remedy a child with no
// live context needs. The reason is now `foreign-run-claim`, which `driftReason`
// deliberately does not key on: this row is what stops it from being added.
test('residue from an earlier run renders no drift clause and keeps the respawn order', () => {
  withDir((dir) => {
    const state = baseState();
    writeManifest(dir, FE_BE_MANIFEST);
    const SESSION = 'cursor-session-that-outlives-the-run';

    // Run 0: a real claim under the reused session key, minted against a run that
    // freezes its own identity — the shape a finished feature leaves behind.
    const previous = 'run-0';
    assert.ok(claimThreadRole(dir, { ...state, currentRunId: previous }, SESSION, 'senior-frontend',
      { parentSessionId: 'orchestrator' }), 'fixture: the previous run must hold a real minted claim');
    const leftover = path.join(dir, '.traffic-one', 'runs', previous, `${SESSION}.json`);
    assert.equal(fs.existsSync(leftover), true, 'fixture: and it must still be on disk in run 0');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', RUN, `${SESSION}.json`)), false,
      'fixture: while nothing claimed under the same key in run 1 — the child never claimed');

    const raw = { session_id: SESSION, tool_name: 'Write' };
    const denied = gate(dir, state, 'src/app/(public)/news/page.tsx', raw);
    assert.ok(denied, 'the write is still refused — this is about WHICH remedy the child is given');
    assert.doesNotMatch(denied!, /DIAGNOSIS: a role claim/,
      'a claim under a different run is not evidence that THIS run drifted');
    assert.doesNotMatch(denied!, /Respawning will NOT fix this/);
    assert.match(denied!, /Spawn the owning role, or message its already-live agent/,
      'the respawn order is restored: a child that never claimed has no live context to preserve');
    assert.match(denied!, /task_name/, 'and the spawn contract comes back with it');
  });
});
