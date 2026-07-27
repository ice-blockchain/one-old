import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  activeRunBootstrapPath,
  ensureRunBootstrap,
  readActiveRunBootstrap,
  resolvedRoleSkillIds,
  RUN_BOOTSTRAP_MAX_PER_ROLE,
} from '../run-bootstrap-policy';
import {
  architectureInputPath,
  compileArchitectureForRun,
  createWorkUnitContract,
  publishRuntimeAssignments,
  stableContractJson,
  type ArchitectureInputV1,
} from '../architecture-contract';
import {
  compileVerificationContract,
  verificationContractPath,
} from '../verification-contract';
import {
  ensureRunHostCapability,
  observeRunHostCapabilityFromHook,
} from '../host-capabilities';
import { sha256 } from '../text';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-bootstrap-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  onboardingComplete: true,
  mobile: { framework: 'none' },
};

const UI_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home', name: 'Home', kind: 'page' },
    { id: 'catalog', name: 'Catalog', kind: 'feature' },
  ],
};

test('missing role skill frontmatter fails closed instead of authorizing every active skill', () => {
  assert.equal(resolvedRoleSkillIds(['browser-qa', 'verification-loop'], null), null);
  assert.deepEqual(
    resolvedRoleSkillIds(
      ['browser-qa', 'verification-loop'],
      new Set(['verification-loop']),
    ),
    ['verification-loop'],
  );
});

function compileRun(
  cwd: string,
  runId: string,
  state: Record<string, unknown>,
  input: ArchitectureInputV1,
) {
  const inputPath = architectureInputPath(cwd, runId);
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const architecture = compileArchitectureForRun(cwd, runId, state);
  const verification = compileVerificationContract(cwd, runId, state, architecture, {
    changedPaths: [],
  });
  const assignments = publishRuntimeAssignments(cwd, architecture, verification.contractHash);
  return { architecture, verification, assignments };
}

function rewriteEnvelope(
  cwd: string,
  runId: string,
  role: string,
  mutate: (raw: Record<string, unknown>) => void,
): void {
  const activePath = activeRunBootstrapPath(cwd, runId, role);
  const raw = JSON.parse(fs.readFileSync(activePath, 'utf8')) as Record<string, unknown>;
  mutate(raw);
  const { envelopeHash: _oldHash, createdAt: _createdAt, ...canonical } = raw;
  const envelopeHash = sha256(stableContractJson(canonical));
  raw.envelopeHash = envelopeHash;
  const immutable = path.join(path.dirname(activePath), `${envelopeHash}.json`);
  fs.writeFileSync(immutable, JSON.stringify(raw));
  fs.writeFileSync(activePath, JSON.stringify(raw));
}

test('precompile publishes only a complete architect planning envelope with real hashes', () => {
  withProject((cwd) => {
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-1',
    });
    assert.ok(envelope);
    assert.equal(envelope.trafficOneRole, 'senior-architect');
    assert.equal(envelope.hostAgentType, null);
    assert.equal(envelope.roleSource, 'plugin-injected-fallback');
    assert.equal(envelope.hostCapability.prevention, 'completion-only');
    assert.equal(envelope.hostCapability.primaryBlockingPointObserved, false);
    assert.ok(envelope.role.content.includes('# Senior Architect'));
    assert.ok(envelope.rules.length > 0);
    assert.match(envelope.architectureHash, /^[a-f0-9]{64}$/);
    assert.match(envelope.workUnit.verificationHash, /^[a-f0-9]{64}$/);
    assert.ok(envelope.workUnit.outputs.includes('.traffic-one/runs/R/architecture-input-v1.json'));
    assert.ok(envelope.workUnit.outputs.includes('.traffic-one/digests/R/architect.md'));
    assert.ok(envelope.workUnit.allowlist.includes('.traffic-one/decisions/R-architecture.md'));
    assert.ok(!envelope.workUnit.allowlist.includes('.traffic-one/decisions/**'));
    assert.deepEqual(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), envelope);

    for (const role of [
      'senior-frontend',
      'senior-backend',
      'senior-reviewer',
      'senior-tester',
      'senior-shipper',
      'quick-fix',
    ]) {
      assert.equal(ensureRunBootstrap(cwd, 'R', role, STATE, {
        host: 'codex',
        hostAgentType: null,
        evidenceSource: 'spawn-task-name',
        modelPolicyId: 'policy-1',
      }), null, `${role} must not receive an empty precompile work unit`);
    }
  });
});

test('quick-fix requires and hashes a nonempty parent-bounded maintenance scope', () => {
  withProject((cwd) => {
    const options = {
      host: 'codex' as const,
      hostAgentType: null,
      evidenceSource: 'parent-maintenance-preflight',
      modelPolicyId: 'policy-maintenance',
    };
    assert.equal(ensureRunBootstrap(cwd, 'M', 'quick-fix', {
      ...STATE,
      mode: 'existing-codebase',
    }, options), null);

    const bounded = ensureRunBootstrap(cwd, 'M', 'quick-fix', {
      ...STATE,
      mode: 'existing-codebase',
    }, {
      ...options,
      boundedOutputs: ['src/components/Button.tsx'],
      boundedAllowlist: ['src/components/Button.tsx'],
    });
    assert.ok(bounded);
    assert.deepEqual(bounded.workUnit.outputs, [
      '.traffic-one/digests/M/quick-fix.md',
      'src/components/Button.tsx',
    ]);
    assert.deepEqual(bounded.workUnit.allowlist, [
      '.traffic-one/digests/M/quick-fix.md',
      'src/components/Button.tsx',
    ]);
    assert.match(bounded.workUnit.contractHash, /^[a-f0-9]{64}$/);
    assert.match(bounded.workUnit.architectureHash, /^[a-f0-9]{64}$/);
    assert.match(bounded.workUnit.verificationHash, /^[a-f0-9]{64}$/);
    const maintenancePath = path.join(cwd, '.traffic-one', 'runs', 'M', 'maintenance.json');
    fs.writeFileSync(maintenancePath, JSON.stringify({
      version: 1,
      role: 'quick-fix',
      overallOutcome: 'fallback-pending',
      workUnitContractHash: bounded.workUnit.contractHash,
      allowlistHash: sha256(JSON.stringify({
        include: bounded.workUnit.allowlist,
        exclude: bounded.workUnit.allowlistExclude,
      })),
    }));
    assert.equal(ensureRunBootstrap(cwd, 'M', 'quick-fix', {
      ...STATE,
      mode: 'existing-codebase',
    }, {
      ...options,
      boundedOutputs: ['src/components/Button.tsx'],
    })?.workUnit.contractHash, bounded.workUnit.contractHash);
    assert.equal(ensureRunBootstrap(cwd, 'M', 'quick-fix', {
      ...STATE,
      mode: 'existing-codebase',
    }, {
      ...options,
      boundedOutputs: ['src/components/Other.tsx'],
    }), null, 'fallback cannot widen or replace the original work unit');

    assert.equal(ensureRunBootstrap(cwd, 'M2', 'quick-fix', STATE, {
      ...options,
      boundedOutputs: ['../outside.ts'],
      boundedAllowlist: ['../outside.ts'],
    }), null);
    assert.equal(ensureRunBootstrap(cwd, 'M3', 'quick-fix', STATE, {
      ...options,
      boundedOutputs: ['src/**'],
      boundedAllowlist: ['src/**'],
    }), null, 'quick-fix scope must be exact and may not contain globs');
  });
});

test('frontend maintenance can publish and re-read an exact bounded WorkUnit without compiled architecture', () => {
  withProject((cwd) => {
    const state = {
      ...STATE,
      mode: 'existing-codebase',
    };
    const bounded = ensureRunBootstrap(cwd, 'MF', 'senior-frontend', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: 'policy-maintenance',
      boundedOutputs: ['src/pages/Home.tsx'],
      boundedAllowlist: ['src/pages/Home.tsx'],
    });
    assert.ok(bounded);
    assert.equal(bounded.workUnit.unitId, 'senior-frontend:bounded-maintenance');
    assert.deepEqual(bounded.workUnit.outputs, [
      '.traffic-one/digests/MF/frontend.md',
      'src/pages/Home.tsx',
    ]);
    assert.deepEqual(bounded.workUnit.allowlist, [
      '.traffic-one/digests/MF/frontend.md',
      'src/pages/Home.tsx',
    ]);
    assert.equal(
      readActiveRunBootstrap(cwd, 'MF', 'senior-frontend')?.workUnit.contractHash,
      bounded.workUnit.contractHash,
    );
  });
});

test('compiled UI roles receive exact source, scaffold, test, QA, and digest artifacts', () => {
  withProject((cwd) => {
    const { architecture, verification } = compileRun(cwd, 'R', STATE, UI_INPUT);
    const options = {
      host: 'codex' as const,
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-ui',
    };
    const frontend = ensureRunBootstrap(cwd, 'R', 'senior-frontend', STATE, options);
    const tester = ensureRunBootstrap(cwd, 'R', 'senior-tester', STATE, options);
    const reviewer = ensureRunBootstrap(cwd, 'R', 'senior-reviewer', STATE, options);
    const shipper = ensureRunBootstrap(cwd, 'R', 'senior-shipper', STATE, options);
    assert.ok(frontend);
    assert.ok(tester);
    assert.ok(reviewer);
    assert.ok(shipper);

    assert.equal(frontend.workUnit.architectureHash, architecture.contractHash);
    assert.equal(frontend.workUnit.verificationHash, verification.contractHash);
    assert.ok(frontend.workUnit.outputs.includes('apps/web/src/pages/Home.tsx'));
    assert.ok(frontend.workUnit.outputs.includes('apps/web/package.json'));
    assert.ok(frontend.workUnit.outputs.includes('.traffic-one/digests/R/frontend.md'));
    assert.ok(frontend.workUnit.allowlist.every((output) => !output.includes('*')));

    assert.ok(tester.workUnit.outputs.includes('tests/home.test.ts'));
    assert.ok(tester.workUnit.outputs.includes('playwright.config.ts'));
    assert.ok(tester.workUnit.outputs.includes('.traffic-one/reports/qa/R/report-v2.json'));
    assert.ok(!tester.workUnit.outputs.includes('.traffic-one/runs/R/qa-acceptance-v1.json'));
    assert.ok(!tester.workUnit.allowlist.includes('.traffic-one/runs/R/qa-acceptance-v1.json'));
    assert.ok(tester.workUnit.outputs.includes('.traffic-one/digests/R/tester.md'));
    assert.deepEqual(reviewer.workUnit.outputs, ['.traffic-one/digests/R/reviewer.md']);
    assert.deepEqual(shipper.workUnit.outputs, [
      '.traffic-one/deployments.jsonl',
      '.traffic-one/digests/R/shipper.md',
    ]);
    assert.equal(ensureRunBootstrap(cwd, 'R', 'quick-fix', STATE, options), null);
  });
});

test('typed backend-only profiles expose no frontend bootstrap or UI skills and no web scaffold', () => {
  withProject((cwd) => {
    const state = {
      ...STATE,
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
    };
    compileRun(cwd, 'R', state, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'health-service', name: 'Health Service', kind: 'service' }],
    });
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-backend', state, {
      host: 'claude',
      hostAgentType: 'senior-backend',
      evidenceSource: 'host-agent-type',
      modelPolicyId: 'policy-2',
    });
    assert.ok(envelope);
    assert.equal(envelope.hostAgentType, 'senior-backend');
    assert.equal(envelope.roleSource, 'host-native');
    assert.ok(envelope.skills.some((skill) => skill.id === 'golang-patterns'));
    assert.ok(!envelope.skills.some((skill) => skill.id === 'browser-qa'));
    assert.ok(envelope.workUnit.outputs.includes('go.mod'));
    assert.ok(envelope.workUnit.outputs.includes('.traffic-one/digests/R/backend.md'));
    assert.ok(!envelope.workUnit.outputs.some((output) => (
      /(?:^|\/)(?:apps\/web|pnpm-workspace|tailwind|playwright)/i.test(output)
    )));
    assert.equal(ensureRunBootstrap(cwd, 'R', 'senior-frontend', state, {
      host: 'claude',
      hostAgentType: 'senior-frontend',
      evidenceSource: 'host-agent-type',
      modelPolicyId: 'policy-2',
    }), null);

    const tester = ensureRunBootstrap(cwd, 'R', 'senior-tester', state, {
      host: 'claude',
      hostAgentType: 'senior-tester',
      evidenceSource: 'host-agent-type',
      modelPolicyId: 'policy-2',
    });
    assert.ok(tester);
    assert.ok(tester.workUnit.outputs.includes('.traffic-one/reports/qa/R/report-v2.json'));
    assert.ok(!tester.workUnit.outputs.includes('.traffic-one/runs/R/qa-acceptance-v1.json'));
  });
});

test('active bootstrap rejects dropped canonical materials even after attacker re-hashes both copies', () => {
  withProject((cwd) => {
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-materials',
    });
    assert.ok(envelope);
    assert.ok(envelope.rules.length > 1);
    rewriteEnvelope(cwd, 'R', 'senior-architect', (raw) => {
      raw.rules = (raw.rules as unknown[]).slice(1);
      const workUnit = raw.workUnit as ReturnType<typeof createWorkUnitContract>;
      raw.workUnit = createWorkUnitContract({
        runId: workUnit.runId,
        unitId: workUnit.unitId,
        trafficOneRole: workUnit.trafficOneRole,
        hostAgentType: workUnit.hostAgentType,
        rules: (raw.rules as Array<{ id: string; contentHash: string }>)
          .map(({ id, contentHash }) => ({ id, contentHash })),
        skills: workUnit.skills,
        outputs: workUnit.outputs,
        allowlist: workUnit.allowlist,
        allowlistExclude: workUnit.allowlistExclude,
        architectureHash: workUnit.architectureHash,
        verificationHash: workUnit.verificationHash,
      });
    });
    assert.equal(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), null);
  });
});

test('active bootstrap rejects added policy material even after attacker re-hashes both copies', () => {
  withProject((cwd) => {
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-extra-material',
    });
    assert.ok(envelope);
    rewriteEnvelope(cwd, 'R', 'senior-architect', (raw) => {
      const workUnit = raw.workUnit as ReturnType<typeof createWorkUnitContract>;
      const extra = { id: 'rogue-skill', content: 'rogue', contentHash: sha256('rogue') };
      raw.skills = [...(raw.skills as unknown[]), extra];
      raw.workUnit = createWorkUnitContract({
        runId: workUnit.runId,
        unitId: workUnit.unitId,
        trafficOneRole: workUnit.trafficOneRole,
        hostAgentType: workUnit.hostAgentType,
        rules: workUnit.rules,
        skills: [...workUnit.skills, { id: extra.id, contentHash: extra.contentHash }],
        outputs: workUnit.outputs,
        allowlist: workUnit.allowlist,
        allowlistExclude: workUnit.allowlistExclude,
        architectureHash: workUnit.architectureHash,
        verificationHash: workUnit.verificationHash,
      });
    });
    assert.equal(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), null);
  });
});

test('active bootstrap rejects a self-rehashed widened WorkUnitContract', () => {
  withProject((cwd) => {
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-work-unit',
    });
    assert.ok(envelope);
    rewriteEnvelope(cwd, 'R', 'senior-architect', (raw) => {
      const workUnit = raw.workUnit as ReturnType<typeof createWorkUnitContract>;
      raw.workUnit = createWorkUnitContract({
        runId: workUnit.runId,
        unitId: workUnit.unitId,
        trafficOneRole: workUnit.trafficOneRole,
        hostAgentType: workUnit.hostAgentType,
        rules: workUnit.rules,
        skills: workUnit.skills,
        outputs: [...workUnit.outputs, 'src/**'],
        allowlist: [...workUnit.allowlist, 'src/**'],
        allowlistExclude: workUnit.allowlistExclude,
        architectureHash: workUnit.architectureHash,
        verificationHash: workUnit.verificationHash,
      });
    });
    assert.equal(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), null);
  });
});

test('stale verification sidecars invalidate assignments and block implementation bootstrap', () => {
  withProject((cwd) => {
    compileRun(cwd, 'R', STATE, UI_INPUT);
    const verificationPath = verificationContractPath(cwd, 'R');
    const raw = JSON.parse(fs.readFileSync(verificationPath, 'utf8')) as Record<string, unknown>;
    raw.changedPaths = [];
    fs.writeFileSync(verificationPath, JSON.stringify(raw));
    assert.equal(ensureRunBootstrap(cwd, 'R', 'senior-frontend', STATE, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-stale',
    }), null);
  });
});

test('active bootstrap survives a child first-tool observation from a different session', () => {
  withProject((cwd) => {
    const parentCapability = ensureRunHostCapability(cwd, 'R', 'codex', {
      event: 'SessionStart',
      source: 'parent-session',
      sessionId: 'parent-session',
      observedAt: '2026-07-27T00:00:00.000Z',
    });
    assert.ok(parentCapability);
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-stable-capability',
    });
    assert.ok(envelope);

    const childCapability = observeRunHostCapabilityFromHook(cwd, 'R', {
      event: 'PreToolUse',
      host: 'codex',
      cwd,
      raw: { hook_event_name: 'PreToolUse', session_id: 'child-session' },
      tool: { class: 'file-read', rawName: 'Read' },
    });
    assert.ok(childCapability);
    assert.equal(childCapability.prevention, 'completion-only');
    assert.equal(childCapability.primaryBlockingPointObserved, true);
    assert.equal(childCapability.requiredBlockingPointsObserved, false);
    assert.equal(childCapability.capabilityHash, parentCapability.capabilityHash);
    assert.deepEqual(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), envelope);
  });
});

test('tampering invalidates active bootstrap and pruning never evicts the active envelope', () => {
  withProject((cwd) => {
    let activeHash = '';
    for (let index = 0; index < RUN_BOOTSTRAP_MAX_PER_ROLE + 5; index += 1) {
      const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
        host: 'codex',
        hostAgentType: null,
        evidenceSource: 'spawn-task-name',
        modelPolicyId: `policy-${index}`,
      });
      assert.ok(envelope);
      activeHash = envelope.envelopeHash;
    }
    const roleDir = path.dirname(activeRunBootstrapPath(cwd, 'R', 'senior-architect'));
    const immutable = fs.readdirSync(roleDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    assert.ok(immutable.length <= RUN_BOOTSTRAP_MAX_PER_ROLE);
    assert.ok(fs.existsSync(path.join(roleDir, `${activeHash}.json`)));

    const activePath = activeRunBootstrapPath(cwd, 'R', 'senior-architect');
    const raw = JSON.parse(fs.readFileSync(activePath, 'utf8')) as Record<string, unknown>;
    (raw.role as Record<string, unknown>).content = 'tampered';
    fs.writeFileSync(activePath, JSON.stringify(raw));
    assert.equal(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), null);
  });
});
