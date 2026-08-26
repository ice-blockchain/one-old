import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { isExistingProjectMode, isNewProjectMode } from '../../shared/state';
import { runModelGate } from '../model-gate';
import { preSpawnArchitectDirective } from '../onboarding-wait/pre-spawn-directives';
import { initializeToolchainState } from '../../shared/state/toolchain';
import { currentLocalPreferenceTarget } from '../../shared/onboarding/local-prefs';
import { HOST_IDS } from '../../config/model-tiers';

// Eight sites in these five runners used to compare `state.mode` raw while the
// gates beside them read it through the normalizing predicates. One state value
// therefore armed one authority and stood another down — measured elsewhere as
// 39 planned outputs silently leaving a compiled architecture with every deny
// still armed. Two of the eight fence model tiers and pre-spawn behaviour, which
// is the same authorization class as the write gates.
//
// The ROUTING is pinned statically by shared/state/__tests__/lifecycle.test.ts,
// whose widened scan now covers all five files with no debt exemption. What is
// pinned here is the BEHAVIOUR: every hand-editable spelling of one mode has to
// produce one answer.

const NEW_SPELLINGS = ['new-project', ' New-Project ', 'NEW-PROJECT', 'new-project '] as const;
const EXISTING_SPELLINGS = [
  'existing-codebase',
  ' Existing-Codebase ',
  'EXISTING-WITH-SUPABASE',
  'existing-with-supabase ',
] as const;

// The predicate each of the eight sites now reads through. Every raw comparison
// they replaced answered `false` for three of the four spellings in its group.
const SITES: readonly { site: string; predicate: (state: unknown) => boolean; newProject: boolean }[] = [
  { site: 'model-gate/index.ts cursor model-capture stop', predicate: isNewProjectMode, newProject: true },
  { site: 'onboarding-toolchain/index.ts requireScan (existing side)', predicate: isExistingProjectMode, newProject: false },
  { site: 'onboarding-toolchain/index.ts requireScan (supabase spelling)', predicate: isExistingProjectMode, newProject: false },
  { site: 'onboarding-wait/pre-spawn-directives.ts run-id directive', predicate: isNewProjectMode, newProject: true },
  { site: 'onboarding-wait/pre-spawn-directives.ts architect directive', predicate: isNewProjectMode, newProject: true },
  { site: 'onboarding-wait/pre-spawn-model.ts claude spawn map', predicate: isNewProjectMode, newProject: true },
  { site: 'onboarding-wait/pre-spawn-model.ts cursor spawn map', predicate: isNewProjectMode, newProject: true },
  { site: 'opencode/index.ts ensureInitialCommit initIfNeeded', predicate: isNewProjectMode, newProject: true },
];

test('every mode spelling reads identically at all eight routed sites', () => {
  for (const { site, predicate, newProject } of SITES) {
    const armed = NEW_SPELLINGS.map((mode) => predicate({ mode }));
    const stoodDown = EXISTING_SPELLINGS.map((mode) => predicate({ mode }));
    assert.deepEqual(armed, NEW_SPELLINGS.map(() => newProject),
      `${site}: the new-project spellings must not disagree with each other`);
    assert.deepEqual(stoodDown, EXISTING_SPELLINGS.map(() => !newProject),
      `${site}: the existing-project spellings must not disagree with each other`);
  }
});

test('the raw comparison these sites used to make DID disagree — the class is real, not theoretical', () => {
  const raw = (mode: string): boolean => mode === 'new-project';
  assert.deepEqual(NEW_SPELLINGS.map(raw), [true, false, false, false],
    'three of four new-project spellings read as NOT new-project raw');
  const rawExisting = (mode: string): boolean => mode === 'existing-codebase' || mode === 'existing-with-supabase';
  assert.deepEqual(EXISTING_SPELLINGS.map(rawExisting), [true, false, false, false]);
});

// ── Live drives: the two shapes that are not cosmetic ─────────────────────────

function withProject(mode: string, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-mode-spelling-'));
  const env = process.env;
  const prev = {
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    xdg: env.XDG_STATE_HOME,
    plan: env.TRAFFIC_ONE_USER_PLAN,
    ask: env.TRAFFIC_ONE_ASK_USE_PLUGIN,
  };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'state');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  // Written RAW, never through writeState: the spelling under test is exactly
  // what normalization would otherwise take away.
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode,
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    realtime: 'none',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
  }), 'utf8');
  const hosts = Object.fromEntries(HOST_IDS.map((host) => [host, {
    performance: { level: 'high', source: 'prompted', target: currentLocalPreferenceTarget(host, process.env) },
    team: { mode: 'subagents', source: 'prompted', approved: true },
  }]));
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    hosts,
    toolchain: initializeToolchainState({}),
  }), 'utf8');
  try { fn(dir); } finally {
    for (const [key, value] of [
      ['TRAFFIC_ONE_PROJECT_PREFS_PATH', prev.prefs],
      ['TRAFFIC_ONE_STATE_PATH', prev.state],
      ['XDG_STATE_HOME', prev.xdg],
      ['TRAFFIC_ONE_USER_PLAN', prev.plan],
      ['TRAFFIC_ONE_ASK_USE_PLUGIN', prev.ask],
    ] as const) {
      if (value === undefined) delete env[key]; else env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureStdout(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { code: fn(), out: chunks.join('') };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = real;
  }
}

// The model gate fences which model tier a run may be frozen on. Its
// new-project arm demands a fresh Cursor capture before anything is frozen;
// raw, three of four spellings walked straight past that demand.
test('model gate: every new-project spelling reaches the same capture stop', () => {
  const seen = new Set<string>();
  for (const mode of NEW_SPELLINGS) {
    withProject(mode, (cwd) => {
      const { code, out } = captureStdout(() => runModelGate([cwd, '--host=cursor']));
      assert.equal(code, 2, `${mode}: fails closed`);
      seen.add(out.replace(cwd, '<cwd>'));
    });
  }
  assert.equal(seen.size, 1, `all four new-project spellings must produce ONE gate answer, got:\n${[...seen].join('\n---\n')}`);
  assert.match([...seen][0]!, /Cursor model capture is missing or stale/);
});

test('model gate: the existing-project spellings agree with each other, and differ from new-project', () => {
  const seen = new Set<string>();
  for (const mode of EXISTING_SPELLINGS) {
    withProject(mode, (cwd) => {
      const { code, out } = captureStdout(() => runModelGate([cwd, '--host=cursor']));
      assert.equal(code, 2, `${mode}: fails closed`);
      seen.add(out.replace(cwd, '<cwd>'));
    });
  }
  assert.equal(seen.size, 1, `all four existing spellings must produce ONE gate answer, got:\n${[...seen].join('\n---\n')}`);
  assert.ok(!/Cursor model capture is missing or stale/.test([...seen][0]!),
    'an existing codebase is not asked for a new-project capture');
});

// The pre-spawn architect directive is the other authorization-class shape: it
// tells the orchestrator which roles to spawn, in parallel, before any gate runs.
test('pre-spawn architect directive: one answer per mode, whatever the spelling', () => {
  const newAnswers = new Set<string>();
  for (const mode of NEW_SPELLINGS) {
    withProject(mode, (cwd) => {
      newAnswers.add(preSpawnArchitectDirective(cwd, 'windsurf').replace(cwd, '<cwd>'));
    });
  }
  assert.equal(newAnswers.size, 1, `every new-project spelling must yield the same directive, got ${newAnswers.size}`);
  assert.notEqual([...newAnswers][0], '', 'fixture guard: a new project does receive the directive');

  for (const mode of EXISTING_SPELLINGS) {
    withProject(mode, (cwd) => {
      assert.equal(preSpawnArchitectDirective(cwd, 'windsurf'), '', `${mode}: an existing codebase is never pushed to spawn a build team`);
    });
  }
});
