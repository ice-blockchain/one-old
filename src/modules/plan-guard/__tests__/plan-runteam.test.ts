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
  type RunAgentContext,
} from '../../../shared/state';
import { recordMainOnboardingSession } from '../../../shared/onboarding-server/onboarding-session';
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
