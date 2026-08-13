import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { libraryAllowlistGate } from '../handler';
import { compileArchitecture, type ArchitectureInputV1 } from '../../../shared/architecture-contract';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function withProject(stateObj: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-plan-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(stateObj), 'utf8');
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: {}, tool: { class: 'shell' as ToolClass, rawName: 'Bash', command } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

// A library preference the gate matched but did not refuse: the install runs and
// the advice is delivered on the same command.
function assertAdvised(cwd: string, command: string, needle: string): void {
  const result = libraryAllowlistGate(ctxFor(cwd, command));
  assert.equal(result.kind, 'context', `${command} must advise, never refuse`);
  if (result.kind === 'context') assert.ok(result.context.includes(needle), result.context);
}

// Every row in the table prescribes a stack, so the gate speaks only about a
// project Traffic One is scaffolding. The mode is part of every fixture below
// for that reason, and its ABSENCE is its own test rather than an accident of
// whichever fixture happened to omit it.
const WEB = { mode: 'new-project', stack: 'default', frontend: 'react-vite' };
const NEXT = { mode: 'new-project', stack: 'default', frontend: 'nextjs' };
const NATIVE = {
  mode: 'new-project',
  stack: 'custom-frontend',
  frontend: 'none',
  mobile: { framework: 'react-native-expo' },
};

test('web stack: a library preference advises instead of refusing the install', () => {
  withProject(WEB, (cwd) => {
    assertAdvised(cwd, 'pnpm add mobx', 'Redux Toolkit');
  });
});

test('web stack: allows an approved library install', () => {
  withProject(WEB, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add zod')).kind, 'noop');
  });
});

// An UNDECLARED mode is not an existing codebase and it is not a scaffolded one
// either. The gate used to treat it as the latter: `isExistingProjectMode` was
// false, so the table ran, and with no `stack` to read it judged the command
// against `defaultStateForStack('minimal')` — a project that never asked for an
// opinion getting one derived from a guess, which is the harm the re-tiering
// exists to end. Both tiers stand down, including the `next` refusal, whose
// licence is a run's frozen contracts and which therefore has nothing to protect
// before onboarding writes a mode.
// The undeclared mode takes exactly half the table, and the split is the point:
// an ADVISORY row is an opinion derived from `defaultStateForStack` — a guess —
// and a project that declared no stack must not receive one. A BLOCKING row is
// an install that makes the run's frozen contracts false about the project, and
// that is true whatever `.one.json` says. Fencing the whole gate behind the mode
// made `{"mode": ""}` a way to stand the `next` row down.
test('an undeclared mode draws no guessed advice but stays behind the machine boundary', () => {
  for (const state of [
    {},
    { stack: 'default', frontend: 'react-vite' },
    { onboardingComplete: true, stack: 'default', frontend: 'react-vite' },
    // Unrecognized rather than absent, and a non-string: both are "not the mode
    // this gate speaks about". (`workspace` is deliberately not in this list —
    // a container root is refused by the tool-scope fence before any gate reads
    // a mode.)
    { mode: 'brand-new', stack: 'default', frontend: 'react-vite' },
    { mode: 42, stack: 'default', frontend: 'react-vite' },
  ]) {
    withProject(state, (cwd) => {
      for (const command of [
        'pnpm add mobx',
        'pnpm add @mui/material',
        'npm install left-pad',
      ]) {
        assert.equal(
          libraryAllowlistGate(ctxFor(cwd, command)).kind,
          'noop',
          `${command} against ${JSON.stringify(state)} must draw neither a deny nor advice`,
        );
      }
      for (const command of ['pnpm add next', 'pnpm add next-auth', 'pnpm add vue']) {
        const result = libraryAllowlistGate(ctxFor(cwd, command));
        assert.equal(result.kind, 'deny',
          `${command} against ${JSON.stringify(state)} must stay refused`);
        assert.ok(!/not blocking/.test(JSON.stringify(result)),
          'and it must carry no guessed stack advice alongside');
      }
    });
  }

  // An existing codebase keeps its own dependency choices in full: nothing here
  // is about a stack Traffic One prescribed, because it prescribed none.
  withProject({ mode: 'existing-codebase', stack: 'default', frontend: 'react-vite' }, (cwd) => {
    for (const command of ['pnpm add mobx', 'pnpm add next', 'pnpm add vue']) {
      assert.equal(libraryAllowlistGate(ctxFor(cwd, command)).kind, 'noop', command);
    }
  });

  // And the gate reads the mode through the same normalization its sibling
  // `isExistingProjectMode` uses, so hand-edited casing cannot switch the
  // advisory half off while every other reader still calls the project
  // scaffolded.
  withProject({ mode: ' New-Project ', stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add next')).kind, 'deny');
    assertAdvised(cwd, 'pnpm add mobx', 'Redux Toolkit');
  });
});

// MAJOR 1, and the other half of the assertion above: pinning the GATE side
// alone is what let the two sides come apart. Every deny in this file reads the
// mode through `isNewProjectMode`, which trims and lowercases; the architecture
// compiler compared the raw string, so one hand-edited `.one.json` armed every
// refusal while standing the compiler down. Measured before the fix: 43 scaffold
// outputs for `new-project`, 4 for `" New-Project "` and 4 for `"NEW-PROJECT"` —
// 39 planned outputs leaving the compiled architecture, which narrows the
// authorization surface `changedPaths` unions AND the planned `uiImpact` floor
// derived from it, with no deny anywhere saying so.
test('the compiler reads the mode the way the gate does, so one file cannot arm one and disarm the other', () => {
  const PLAN: ArchitectureInputV1 = {
    schemaVersion: 1,
    routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
    modules: [
      { id: 'app-shell', name: 'App', kind: 'app-shell' },
      { id: 'home', name: 'Home', kind: 'page' },
    ],
  };
  const baseline: Array<{ mode: string; outputs: number; scaffold: number }> = [];
  for (const mode of ['new-project', ' New-Project ', 'NEW-PROJECT', '\tnew-project\n']) {
    withProject({ mode, stack: 'default', frontend: 'react-vite', backend: 'none', mobile: { framework: 'none' } }, (cwd) => {
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
        dependencies: { react: '19.0.0', vite: '7.0.0', 'react-router-dom': '7.0.0' },
      }), 'utf8');
      const state = { mode, stack: 'default', frontend: 'react-vite', backend: 'none', mobile: { framework: 'none' } };
      const compiled = compileArchitecture(cwd, 'R', state, PLAN);
      baseline.push({
        mode,
        outputs: compiled.allowedOutputs.length,
        scaffold: (compiled.scaffoldOutputs || []).length,
      });
      // And the gate agrees on the same fixture, so the row is a comparison of
      // two readers of one value rather than of two fixtures.
      assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add next')).kind, 'deny', mode);
    });
  }
  const canonical = baseline[0]!;
  assert.ok(canonical.scaffold > 10, `fixture guard: a scaffolded plan compiles outputs (${canonical.scaffold})`);
  for (const row of baseline.slice(1)) {
    assert.deepEqual(
      { outputs: row.outputs, scaffold: row.scaffold },
      { outputs: canonical.outputs, scaffold: canonical.scaffold },
      `${JSON.stringify(row.mode)} compiled ${row.scaffold} scaffold outputs where the canonical spelling `
      + `compiled ${canonical.scaffold} — the compiler is reading the mode raw again`,
    );
  }
});

// M7: the `next` row's licence is "this install changes what the profile
// detects while the run's contracts stay frozen against the old answer", and
// that is a claim about the DETECTOR, not about Next.js. Measured against
// `capabilityProfileForProject` on a react-vite fixture, nine dependencies move
// profileId/framework/entrypoints and two controls move nothing.
test('every dependency that flips the detected framework is a machine boundary', () => {
  withProject({ mode: 'new-project', stack: 'default', frontend: 'react-vite' }, (cwd) => {
    for (const command of [
      'pnpm add next', 'pnpm add nuxt', 'pnpm add @sveltejs/kit', 'pnpm add astro',
      'pnpm add @angular/core', 'pnpm add vue', 'pnpm add @vitejs/plugin-vue',
      'pnpm add svelte', 'pnpm add @remix-run/react', 'pnpm add solid-js',
    ]) {
      assert.equal(libraryAllowlistGate(ctxFor(cwd, command)).kind, 'deny', command);
    }
    // The controls the same probe measured as moving nothing stay advisory.
    assertAdvised(cwd, 'pnpm add mobx', 'Redux Toolkit');
    assertAdvised(cwd, 'pnpm add @mui/material', 'not MUI');
  });

  // Detection returns the FIRST match in its own order, so a marker that ranks
  // later than the project's own framework cannot move the answer and must not
  // be refused. A Vue project installing Svelte is the case: `vue` is consulted
  // first, so the detected framework does not change.
  withProject({ mode: 'new-project', stack: 'default', frontend: 'vue' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add svelte')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add vue')).kind, 'noop',
      'and the project may install its own framework');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add nuxt')).kind, 'deny',
      'while one that ranks earlier still moves it');
  });
});

// The RESOLUTION still has to be right — the active UI system must never draw
// its own advice, or the table would nag every legitimate install. What changed
// is the verdict for the second system: a project may add one, and hears why it
// probably should not.
test('resolved shadcn adapter is silent while a second UI system is advised', () => {
  withProject({ mode: 'new-project', stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn')).kind, 'noop');
    assertAdvised(cwd, 'pnpm add @mui/material', 'not MUI');
  });
  withProject({ mode: 'new-project', stack: 'custom-frontend', frontend: 'vue' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn-vue')).kind, 'noop');
    assertAdvised(cwd, 'pnpm add -D shadcn', 'not shadcn');
  });
});

test('explicit or detected external UI library wins and advises against a parallel shadcn', () => {
  withProject({
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'react-vite',
    uiLibrary: 'mui',
  }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @mui/material @emotion/react')).kind, 'noop');
    assertAdvised(cwd, 'pnpm add -D shadcn', 'not shadcn');
    assertAdvised(cwd, 'pnpm add @chakra-ui/react', 'not Chakra UI');
  });

});

test('existing codebase: the forbidden-library install gate stands down entirely', () => {
  // Every rule the gate can emit enforces the prescribed stack; a repository
  // Traffic One did not create keeps its own dependency choices, so on
  // existing-* modes even architectural conflicts (a second UI system, an
  // off-stack state library) are the repo owner's call — guidance, never a deny.
  withProject({
    mode: 'existing-codebase',
    stack: 'custom-frontend',
    frontend: 'react-vite',
  }, (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0', '@mui/material': '7.0.0' },
    }));
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @mui/material')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add mobx')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @vanilla-extract/css')).kind, 'noop');
  });
  withProject({ mode: 'existing-with-supabase', stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add mobx')).kind, 'noop');
  });
});

test('explicit framework-native choice advises against adding a component library', () => {
  withProject({
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'angular',
    uiLibrary: 'framework-native',
  }, (cwd) => {
    assertAdvised(cwd, 'pnpm add @angular/material', 'not Angular Material');
    assertAdvised(cwd, 'pnpm add -D shadcn', 'not shadcn');
  });
});

test('ignores non-install commands', () => {
  withProject(WEB, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm build')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'ls -la')).kind, 'noop');
  });
});

test('native stack: advises Expo Router over react-router-dom', () => {
  withProject(NATIVE, (cwd) => {
    assertAdvised(cwd, 'pnpm add react-router-dom', 'Expo Router');
  });
});

test('forbidden-library gate stands down inside the plugin authoring repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoring-lib-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'gen', 'index.ts'), 'export {};\n', 'utf8');
    resetAuthoringRootCache();
    // mobx and vitest draw advice in an end-user stack; the authoring repo is
    // exempt from the table entirely, so neither may produce even that.
    assert.equal(libraryAllowlistGate(ctxFor(dir, 'pnpm add mobx')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(dir, 'pnpm add vitest')).kind, 'noop');
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('react/vite stack: allows vitest installs (Vitest is the web runner)', () => {
  withProject(WEB, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D @vitest/coverage-v8')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add vitest')).kind, 'noop');
  });
});

test('nextjs frontend: still allows vitest', () => {
  withProject(NEXT, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D @vitest/ui')).kind, 'noop');
  });
});

test('native stack: advises Jest over vitest', () => {
  withProject(NATIVE, (cwd) => {
    assertAdvised(cwd, 'pnpm add -D @vitest/coverage-v8', 'Jest');
  });
});

// Stack-aware Next.js gating (ported behaviors from the legacy core-onboarding suite).
// The sole surviving refusal in the table: `next` rewrites what the capability
// profile DETECTS, so a run whose architecture and verification contracts are
// already frozen would gather every check against a different project.
test('react/vite stack: still denies next packages (Next.js not chosen)', () => {
  withProject(WEB, (cwd) => {
    const r = libraryAllowlistGate(ctxFor(cwd, 'pnpm add next'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('NextAuth/Auth.js'));
  });
});

// A command that trips both tiers must refuse AND still deliver the advice —
// demoting a rule may not make it disappear whenever a sibling rule denies.
test('a mixed install denies on the stack boundary and still reports the advisory rows', () => {
  withProject(WEB, (cwd) => {
    const r = libraryAllowlistGate(ctxFor(cwd, 'pnpm add next mobx'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes('NextAuth/Auth.js'));
      assert.ok((r.context || '').includes('Redux Toolkit'), r.context);
    }
  });
});

test('explicit nextjs frontend: allows next', () => {
  withProject(NEXT, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add next')).kind, 'noop');
  });
});

test('existing next dependency: allows next-auth', () => {
  withProject(WEB, (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }), 'utf8');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add next-auth')).kind, 'noop');
  });
});
