import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildOrchestrationDirective, shouldEmitArchitectCompletionReminder, shouldEmitBuildOrchestration } from '../build-orchestration-directive';
import { writeArchitectPhaseComplete } from '../../modules/plan-guard/__tests__/architect-phase-fixtures';

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-build-orch-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SUBAGENTS_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  onboardingComplete: true,
  performance: { level: 'balanced', source: 'prompted' },
  team: { mode: 'subagents', source: 'prompted', approved: true },
};

function subagentsState(): typeof SUBAGENTS_STATE {
  return {
    ...SUBAGENTS_STATE,
    performance: { ...SUBAGENTS_STATE.performance },
    team: { ...SUBAGENTS_STATE.team },
  };
}

test('shouldEmitBuildOrchestration: kilo new-project subagents without plan', () => {
  withProject((dir) => {
    const state = subagentsState();
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(state), 'utf8');
    assert.equal(shouldEmitBuildOrchestration(dir, state, 'kilo'), true);
    assert.equal(shouldEmitBuildOrchestration(dir, state, 'opencode'), true);
    assert.equal(shouldEmitBuildOrchestration(dir, state, 'cursor'), false);
  });
});

test('shouldEmitBuildOrchestration: false once plan.md exists', () => {
  withProject((dir) => {
    const state = subagentsState();
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(state), 'utf8');
    fs.writeFileSync(path.join(t1, 'plan.md'), '# plan', 'utf8');
    assert.equal(shouldEmitBuildOrchestration(dir, state, 'kilo'), false);
  });
});

test('build-start architect directive is never emitted for a maintenance project', () => {
  withProject((dir) => {
    const state = {
      ...subagentsState(),
      lifecycle: { phase: 'maintenance', source: 'orchestrator', completedAt: '2026-07-10T00:00:00Z' },
    };
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(state), 'utf8');
    assert.equal(shouldEmitBuildOrchestration(dir, state, 'kilo'), false);
    assert.equal(shouldEmitBuildOrchestration(dir, state, 'opencode'), false);
    assert.equal(shouldEmitArchitectCompletionReminder(dir, state, 'kilo'), false);
    assert.equal(buildOrchestrationDirective(dir, 'kilo', state), '');
  });
});

test('buildOrchestrationDirective: Kilo uses general with the senior-architect role contract', () => {
  withProject((dir) => {
    const state = subagentsState();
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(state), 'utf8');
    const d = buildOrchestrationDirective(dir, 'kilo', state);
    assert.match(d, /senior-architect/i);
    assert.match(d, /subagent_type/i);
    assert.match(d, /subagent_type: "general"/);
    assert.doesNotMatch(d, /subagent_type: "senior-architect"/);
    assert.match(d, /\.kilo\/agents\/senior-architect\.md/);
    assert.match(d, /\[t1-role: senior-<role>\]/);
    assert.doesNotMatch(d, /\[t1-role: senior-(?:architect|frontend|backend|reviewer|tester|shipper)\]/);
    assert.match(d, /real subagent/i);
    assert.match(d, /read `.kilo\/agents\/senior-architect\.md` before acting/i);
    assert.match(d, /apps\/web/i);
    assert.match(d, /profile=vite-react/);
    assert.match(d, /playwright/i);
  });
});

test('buildOrchestrationDirective: names the project-scoped global architect, not general, for OpenCode', () => {
  withProject((dir) => {
    const state = subagentsState();
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(state), 'utf8');
    const d = buildOrchestrationDirective(dir, 'opencode', state);
    assert.match(d, /OpenCode build start/i);
    assert.match(d, /subagent_type: "traffic-one-[a-f0-9]{12}-senior-architect"/);
    assert.doesNotMatch(d, /subagent_type: "general"/);
    assert.match(d, /\.config\/opencode\/agents\/traffic-one-[a-f0-9]{12}-senior-architect\.md/);
    assert.match(d, /\[t1-role: senior-<role>\]/);
    assert.doesNotMatch(d, /\[t1-role: senior-(?:architect|frontend|backend|reviewer|tester|shipper)\]/);
  });
});

test('buildOrchestrationDirective: non Kilo/OpenCode hosts are side-effect free', () => {
  withProject((dir) => {
    const state = subagentsState();
    const t1 = path.join(dir, '.traffic-one');
    const onePath = path.join(t1, '.one.json');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(onePath, JSON.stringify(state), 'utf8');

    assert.equal(buildOrchestrationDirective(dir, 'cursor', subagentsState()), '');
    assert.equal(buildOrchestrationDirective(dir, 'codex', subagentsState()), '');
    assert.equal(buildOrchestrationDirective(dir, 'claude', subagentsState()), '');

    const persisted = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    assert.equal(persisted.currentRunId, undefined);
    assert.equal(fs.existsSync(path.join(t1, 'runs')), false);
  });
});

test('shouldEmitArchitectCompletionReminder: true when plan exists but phase incomplete', () => {
  withProject((dir) => {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({ ...SUBAGENTS_STATE, currentRunId: 'R' }), 'utf8');
    fs.writeFileSync(path.join(t1, 'plan.md'), '# plan', 'utf8');
    assert.equal(shouldEmitArchitectCompletionReminder(dir, { ...SUBAGENTS_STATE, currentRunId: 'R' }, 'kilo'), true);
  });
});

test('buildOrchestrationDirective: architect-incomplete reminder when plan exists without baseline', () => {
  withProject((dir) => {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({ ...SUBAGENTS_STATE, currentRunId: 'R' }), 'utf8');
    fs.writeFileSync(path.join(t1, 'plan.md'), '# plan', 'utf8');
    const d = buildOrchestrationDirective(dir, 'kilo', { ...SUBAGENTS_STATE, currentRunId: 'R' });
    assert.match(d, /architect phase is INCOMPLETE/i);
    assert.match(d, /coding\.md/);
    assert.match(d, /senior-architect/i);
    assert.match(d, /subagent_type: "general"/);
  });
});

test('shouldEmitArchitectCompletionReminder: false once architect phase is complete', () => {
  withProject((dir) => {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({ ...SUBAGENTS_STATE, currentRunId: 'R' }), 'utf8');
    fs.writeFileSync(path.join(t1, 'plan.md'), '# plan', 'utf8');
    writeArchitectPhaseComplete(dir, 'R', SUBAGENTS_STATE);
    assert.equal(shouldEmitArchitectCompletionReminder(dir, { ...SUBAGENTS_STATE, currentRunId: 'R' }, 'kilo'), false);
  });
});

test('backend-only OpenCode directive selects backend role and stack-native QA without React leakage', () => {
  withProject((dir) => {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    const state = {
      ...subagentsState(),
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    };
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state));
    const directive = buildOrchestrationDirective(dir, 'opencode', state);
    assert.match(directive, /profile=backend-only/);
    assert.match(directive, /framework=go/);
    assert.match(directive, /spawn only `senior-backend`/);
    assert.doesNotMatch(directive, /spawn (?:only )?`senior-frontend`/);
    assert.match(directive, /no UI surface/i);
    assert.doesNotMatch(directive, /React\/Vite|Turborepo|apps\/web/);
  });
});

test('native Kilo directive selects only frontend role and native emulator QA', () => {
  withProject((dir) => {
    fs.writeFileSync(path.join(dir, 'Package.swift'), '// swift-tools-version: 6.0\n');
    const state = {
      ...subagentsState(),
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { enabled: true, framework: 'swift-native' },
    };
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state));
    const directive = buildOrchestrationDirective(dir, 'kilo', state);
    assert.match(directive, /profile=swift-native/);
    assert.match(directive, /spawn only `senior-frontend`/);
    assert.doesNotMatch(directive, /spawn (?:only )?`senior-backend`/);
    assert.match(directive, /xcode-simulator/);
    assert.match(directive, /do not use browser QA/i);
  });
});

test('custom Next OpenCode directive preserves the detected framework roots', () => {
  withProject((dir) => {
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const state = {
      ...subagentsState(),
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'none',
      mobile: { framework: 'none' },
    };
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state));
    const directive = buildOrchestrationDirective(dir, 'opencode', state);
    assert.match(directive, /profile=next-app/);
    assert.match(directive, /framework=nextjs/);
    assert.match(directive, /source roots=app, src\/app/);
    assert.doesNotMatch(directive, /React\/Vite|Turborepo|apps\/web/);
  });
});
