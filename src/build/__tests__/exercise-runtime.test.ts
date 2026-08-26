import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  AUTH_DENY,
  EXERCISED_SHIMS,
  exerciseEnv,
  exerciseRuntime,
  type RuntimeExercisePins,
} from '../exercise-runtime';
import { healthyAnswers, makeExerciseWorkspace, makeStubInstall } from './fixtures/stub-install';

const EXPECTED_LEGS = ['claude', 'claude-auth-off-control', 'cursor', 'windsurf', 'devin'];

function pinsFor(home: string, pluginRoot: string, base: NodeJS.ProcessEnv, consent: 'recorded-consent' | 'ask-disabled' = 'recorded-consent'): RuntimeExercisePins {
  return {
    base,
    home,
    pluginRoot,
    statePath: path.join(home, '..', 'machine.json'),
    projectPrefsPath: path.join(home, '..', 'preferences.json'),
    consent,
  };
}

test('a healthy runtime is exercised through every host wire shape, and the population is named', () => {
  const install = makeStubInstall('healthy runtime');
  const workspace = makeExerciseWorkspace();
  try {
    const report = exerciseRuntime({
      scripts: install.scripts,
      pins: pinsFor(workspace.home, install.root, {}),
      projects: workspace.projects,
    });

    assert.equal(report.problem, null);
    // Both halves. `problem === null` alone is what a discovery bug returns
    // too, so the population is asserted explicitly and asserted NON-EMPTY.
    assert.deepEqual(report.exercised, EXPECTED_LEGS);
    assert.ok(report.exercised.length > 0, 'an exercise that reached no host certifies nothing');

    const calls = install.calls();
    assert.equal(calls.length, EXPECTED_LEGS.length, 'one child process per leg');
    assert.deepEqual(
      calls.map((call) => `${call.shim} ${call.subcommand}`),
      [
        'hook-runtime.cjs check-plan-write',
        'hook-runtime.cjs check-plan-write',
        'cursor-hook-runtime.cjs before-shell-execution',
        'windsurf-hook-runtime.cjs pre_run_command',
        'devin-hook-runtime.cjs check-onboarding-gate',
      ],
    );
    // Each leg must be pointed at its OWN project cwd: the onboarding gate the
    // auth gate delegates to writes per-project session markers, so a shared
    // cwd would let the first call's marker steer the next host's branch.
    const cwds = calls.map((call) => JSON.parse(call.stdin).cwd ?? JSON.parse(call.stdin).tool_info?.cwd);
    assert.deepEqual(cwds, [
      workspace.projects.claude,
      workspace.projects.claude,
      workspace.projects.cursor,
      workspace.projects.windsurf,
      workspace.projects.devin,
    ]);
  } finally {
    workspace.cleanup();
    install.cleanup();
  }
});

test('nothing ambient reaches an exercised child — the pins are the whole environment that matters', () => {
  const install = makeStubInstall('ambient isolation');
  const workspace = makeExerciseWorkspace();
  const canary = path.join(workspace.root, 'canary-home');
  fs.mkdirSync(canary, { recursive: true });
  const saved = { ...process.env };
  try {
    // Everything a maintainer shell (or a host session) could plausibly be
    // exporting, all of it pointed somewhere this exercise must never reach.
    process.env.HOME = canary;
    process.env.XDG_STATE_HOME = canary;
    process.env.TRAFFIC_ONE_AUTH = 'off';
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    process.env.TRAFFIC_ONE_STATE_PATH = path.join(canary, 'machine.json');
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(canary, 'preferences.json');
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = canary;
    process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '';

    const pins = pinsFor(workspace.home, install.root, {});
    const report = exerciseRuntime({ scripts: install.scripts, pins, projects: workspace.projects });
    assert.equal(report.problem, null);

    const calls = install.calls();
    assert.ok(calls.length > 0, 'no child ran, so this test would certify isolation it never observed');
    for (const call of calls) {
      assert.equal(call.env.HOME, workspace.home, `${call.shim} ran with the ambient HOME`);
      assert.equal(call.env.XDG_STATE_HOME, undefined, `${call.shim} kept an ambient XDG_STATE_HOME`);
      assert.equal(call.env.TRAFFIC_ONE_PLUGIN_ROOT, install.root);
      assert.equal(call.env.TRAFFIC_ONE_STATE_PATH, pins.statePath);
      assert.equal(call.env.TRAFFIC_ONE_PROJECT_PREFS_PATH, pins.projectPrefsPath);
      // Forced ON by the exercise, not asked of the caller: the delegated
      // onboarding gate would otherwise start a real wizard server on a port.
      assert.equal(call.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN, '1', `${call.shim} could have spawned a live wizard`);
    }
    // Exactly one leg may run with auth off, and it is the control.
    assert.deepEqual(
      calls.map((call) => call.env.TRAFFIC_ONE_AUTH),
      ['on', 'off', 'on', 'on', 'on'],
    );
    assert.deepEqual(fs.readdirSync(canary), [], 'the exercise wrote into the ambient HOME');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    workspace.cleanup();
    install.cleanup();
  }
});

// The by-construction claim, asserted textually because it is a claim about the
// SOURCE rather than about one run: a single `process.env` anywhere in this
// module (or a `= process.env` default on one of its parameters) puts the
// ambient environment back inside the exercise, where a plugin:sync caller
// running on the maintainer's real machine cannot see it. The required fields
// on RuntimeExercisePins are only load-bearing while this holds.
test('exercise-runtime.ts reads no ambient environment', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'exercise-runtime.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
  assert.equal(
    code.includes('process.env'),
    false,
    'exercise-runtime.ts reached for process.env; the required pins stop being a guarantee the moment it does',
  );
});

test('exerciseEnv pins the dangerous variables regardless of what the base carries', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/real/home',
    XDG_STATE_HOME: '/real/xdg',
    TRAFFIC_ONE_ASK_USE_PLUGIN: '1',
    TRAFFIC_ONE_AUTH: 'off',
  };
  const pins: RuntimeExercisePins = {
    base, home: '/scratch/home', pluginRoot: '/scratch/root',
    statePath: '/scratch/machine.json', projectPrefsPath: '/scratch/prefs.json',
    consent: 'recorded-consent',
  };

  const consented = exerciseEnv(pins);
  assert.equal(consented.PATH, '/usr/bin', 'the inherited base is still forwarded');
  assert.equal(consented.HOME, '/scratch/home');
  assert.equal(consented.XDG_STATE_HOME, undefined);
  assert.equal(consented.TRAFFIC_ONE_AUTH, 'on');
  assert.equal(consented.TRAFFIC_ONE_ONBOARDING_NO_SPAWN, '1');
  // The smoke's route: the shipped ask-first default has to be what the
  // exercise runs on, so an ambient override is removed rather than honoured.
  assert.equal(consented.TRAFFIC_ONE_ASK_USE_PLUGIN, undefined);

  // plugin:sync's route: no consent record is created anywhere, so the question
  // is stood down instead and the auth gate speaks first.
  assert.equal(exerciseEnv({ ...pins, consent: 'ask-disabled' }).TRAFFIC_ONE_ASK_USE_PLUGIN, 'off');
});

// One case per leg. A single "something failed" case would pass even if four of
// the five legs had silently stopped being checked.
const BREAKAGES: ReadonlyArray<{ leg: string; shim: string; answers: Record<string, unknown>; expected: string }> = [
  {
    leg: 'claude allows an unauthed write',
    shim: 'hook-runtime.cjs',
    answers: { on: { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) }, off: { stdout: '{}' } },
    expected: 'hook-runtime.cjs shim did not deny an unauthed write',
  },
  {
    leg: 'claude denies, but not as the auth gate',
    shim: 'hook-runtime.cjs',
    answers: {
      on: { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'some other gate objected' } }) },
      off: { stdout: '{}' },
    },
    expected: 'Claude deny did not come from the unauthenticated gate',
  },
  {
    leg: 'claude denies with only the user-channel sentence',
    shim: 'hook-runtime.cjs',
    answers: {
      on: { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Setup needed — I will share the link.' } }) },
      off: { stdout: '{}' },
    },
    expected: 'Claude deny did not come from the unauthenticated gate',
  },
  {
    leg: 'cursor denies with only the user-channel sentence',
    shim: 'cursor-hook-runtime.cjs',
    answers: {
      on: { stdout: JSON.stringify({ permission: 'deny', user_message: 'Setup needed — I will share the link.' }) },
      off: { stdout: '{}' },
    },
    expected: 'Cursor deny did not come from the unauthenticated gate',
  },
  {
    leg: 'the deny survives auth being switched off',
    shim: 'hook-runtime.cjs',
    answers: {
      on: { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: AUTH_DENY } }) },
      off: { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: AUTH_DENY } }) },
    },
    expected: 'the unauthenticated deny fired with auth switched off',
  },
  {
    leg: 'cursor allows an unauthed shell',
    shim: 'cursor-hook-runtime.cjs',
    answers: { on: { stdout: JSON.stringify({ permission: 'allow' }) }, off: { stdout: '{}' } },
    expected: 'cursor-hook-runtime.cjs shim did not deny an unauthed shell',
  },
  {
    leg: 'cursor denies with an empty user_message',
    shim: 'cursor-hook-runtime.cjs',
    answers: { on: { stdout: JSON.stringify({ permission: 'deny', user_message: '' }) }, off: { stdout: '{}' } },
    expected: 'cursor deny had no user_message',
  },
  {
    leg: 'windsurf does not block',
    shim: 'windsurf-hook-runtime.cjs',
    answers: { on: { exit: 0 }, off: { exit: 0 } },
    expected: 'windsurf-hook-runtime.cjs shim did not exit 2 on an unauthed shell (status 0)',
  },
  {
    leg: 'devin does not block',
    shim: 'devin-hook-runtime.cjs',
    answers: { on: { stdout: JSON.stringify({ decision: 'allow' }) }, off: { stdout: '{}' } },
    expected: 'devin-hook-runtime.cjs shim did not block an unauthed exec',
  },
  {
    leg: 'devin blocks, but not as the auth gate',
    shim: 'devin-hook-runtime.cjs',
    answers: { on: { stdout: JSON.stringify({ decision: 'block', reason: 'unrelated' }) }, off: { stdout: '{}' } },
    expected: 'Devin deny did not come from the unauthenticated gate',
  },
];

for (const breakage of BREAKAGES) {
  test(`the exercise reports it when ${breakage.leg}`, () => {
    const install = makeStubInstall(breakage.leg);
    const workspace = makeExerciseWorkspace();
    try {
      install.answer(breakage.shim, breakage.answers as never);
      const report = exerciseRuntime({
        scripts: install.scripts,
        pins: pinsFor(workspace.home, install.root, {}),
        projects: workspace.projects,
      });
      assert.ok(report.problem, 'the broken leg was waved through');
      assert.ok(
        report.problem.includes(breakage.expected),
        `expected a problem naming "${breakage.expected}", got "${report.problem}"`,
      );
    } finally {
      workspace.cleanup();
      install.cleanup();
    }
  });
}

test('a shim missing from the install is reported before anything is spawned', () => {
  const install = makeStubInstall('missing shim');
  const workspace = makeExerciseWorkspace();
  try {
    install.removeShim('devin-hook-runtime.cjs');
    const report = exerciseRuntime({
      scripts: install.scripts,
      pins: pinsFor(workspace.home, install.root, {}),
      projects: workspace.projects,
    });
    assert.equal(report.problem, 'missing shim devin-hook-runtime.cjs');
    assert.deepEqual(report.exercised, [], 'the precheck must run before the first spawn');
    assert.deepEqual(install.calls(), []);
  } finally {
    workspace.cleanup();
    install.cleanup();
  }
});

test('the healthy fixture answers every shim the exercise knows about', () => {
  // Guards the case above from the other direction: if EXERCISED_SHIMS grows
  // and the fixture does not, every case in this file starts passing off
  // `missing shim <new>` instead of the behaviour it names.
  const answered = Object.keys(healthyAnswers()).sort();
  assert.deepEqual(answered, [...EXERCISED_SHIMS].sort());
  assert.ok(answered.length > 0);
});
