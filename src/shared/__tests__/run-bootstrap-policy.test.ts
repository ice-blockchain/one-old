import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  activeRunBootstrapPath,
  ensureRunBootstrap,
  readActiveRunBootstrap,
  repairRunBootstrapForBoundChild,
  resolvedRoleSkillIds,
  RUN_BOOTSTRAP_MAX_PER_ROLE,
} from '../run-bootstrap-policy';
import { currentHostModelTarget } from '../current-model-tiers';
import { ensureRunModelPolicy } from '../run-model-policy';
import { roleAgentBody } from '../skill-filters';
import {
  architectureInputPath,
  compileArchitectureForRun,
  compiledArchitecturePath,
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
} from '../host/capabilities';
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

test('a compiled sidecar persisted without published assignments does not invalidate the live architect bootstrap', () => {
  withProject((cwd) => {
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
      host: 'claude',
      hostAgentType: 'senior-architect',
      evidenceSource: 'parent-policy-preflight',
      modelPolicyId: 'policy-1',
    });
    assert.ok(envelope);
    assert.deepEqual(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), envelope);
    // 2cl regression: the completion gate compiled+persisted architecture-v1.json,
    // then DENIED the digest (no verification/assignments/bootstrap republish).
    // The live architect's envelope must survive that on-disk state — before the
    // fix its expected contract hash flipped to the compiled hash and every tool
    // call was denied.
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(UI_INPUT));
    compileArchitectureForRun(cwd, 'R', STATE);
    assert.deepEqual(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), envelope);
  });
});

test('compileArchitectureForRun with persist:false keeps the compiled sidecar off disk', () => {
  withProject((cwd) => {
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(UI_INPUT));
    const compiled = compileArchitectureForRun(cwd, 'R', STATE, { persist: false });
    assert.ok(compiled.contractHash);
    assert.equal(fs.existsSync(compiledArchitecturePath(cwd, 'R')), false);
  });
});

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
    assert.equal(envelope.role.contentHash, sha256(roleAgentBody('senior-architect')!));
    assert.ok(!('content' in envelope.role));
    assert.ok(envelope.rules.length > 0);
    assert.ok(envelope.rules.every((rule) => (
      !('content' in rule) && /^[a-f0-9]{64}$/.test(rule.contentHash)
    )));
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
      const extra = { id: 'rogue-skill', contentHash: sha256('rogue') };
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
    (raw.role as Record<string, unknown>).contentHash = sha256('tampered');
    fs.writeFileSync(activePath, JSON.stringify(raw));
    assert.equal(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), null);
  });
});

test('a schemaVersion-1 body-carrying envelope is rejected and republished as v2 with a stable work-unit contract', () => {
  withProject((cwd) => {
    const options = {
      host: 'codex' as const,
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-v1-migration',
    };
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, options);
    assert.ok(envelope);
    const contractHash = envelope.workUnit.contractHash;
    rewriteEnvelope(cwd, 'R', 'senior-architect', (raw) => {
      // Downgrade both copies to the retired body-carrying v1 shape.
      raw.schemaVersion = 1;
      raw.role = { ...(raw.role as Record<string, unknown>), content: '# Senior Architect (stale body)' };
      raw.rules = (raw.rules as Array<Record<string, unknown>>)
        .map((rule) => ({ ...rule, content: 'stale rule body' }));
      raw.skills = (raw.skills as Array<Record<string, unknown>>)
        .map((skill) => ({ ...skill, content: 'stale skill body' }));
    });
    assert.equal(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), null);
    // The republish path reproduces the same work-unit contract, so
    // maintenance.json fallback markers keyed on contractHash stay valid
    // across the v1→v2 migration.
    const republished = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, options);
    assert.ok(republished);
    assert.equal(republished.schemaVersion, 2);
    assert.equal(republished.workUnit.contractHash, contractHash);
    assert.deepEqual(readActiveRunBootstrap(cwd, 'R', 'senior-architect'), republished);
  });
});

test('an envelope referencing a rule missing from the plugin fails closed', () => {
  withProject((cwd) => {
    const envelope = ensureRunBootstrap(cwd, 'R', 'senior-architect', STATE, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-missing-rule',
    });
    assert.ok(envelope);
    rewriteEnvelope(cwd, 'R', 'senior-architect', (raw) => {
      const rules = raw.rules as Array<{ id: string; contentHash: string }>;
      rules[0] = { id: 'rules/common/does-not-exist.md', contentHash: '0'.repeat(64) };
      const workUnit = raw.workUnit as ReturnType<typeof createWorkUnitContract>;
      raw.workUnit = createWorkUnitContract({
        runId: workUnit.runId,
        unitId: workUnit.unitId,
        trafficOneRole: workUnit.trafficOneRole,
        hostAgentType: workUnit.hostAgentType,
        rules: rules.map(({ id, contentHash }) => ({ id, contentHash })),
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

test('repairRunBootstrapForBoundChild recovers a bounded scope from an invalidated stale envelope', () => {
  withProject((cwd) => {
    const env = {
      ...process.env,
      TRAFFIC_ONE_HOST: 'codex',
      TRAFFIC_ONE_USER_PLAN: 'pro',
      XDG_STATE_HOME: path.join(cwd, 'state'),
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
    };
    const target = currentHostModelTarget('codex', 'pro', env);
    const state = {
      ...STATE,
      mode: 'existing-codebase',
      performance: {
        level: 'balanced',
        source: 'prompted',
        target: {
          plan: 'pro',
          appliedFingerprint: target.appliedFingerprint,
          configVersion: target.configVersion,
        },
      },
      team: { mode: 'subagents', approved: true, source: 'prompted' },
    };
    const policy = ensureRunModelPolicy(cwd, 'M', 'codex', state, env);
    assert.ok(policy);
    const bounded = ensureRunBootstrap(cwd, 'M', 'quick-fix', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'parent-maintenance-preflight',
      modelPolicyId: policy.policyId,
      boundedOutputs: ['src/components/Button.tsx'],
    });
    assert.ok(bounded);
    // Simulate a plugin upgrade landing mid-run: the stale envelope no longer
    // parses, but its self-hashing workUnit still carries the bounded scope.
    rewriteEnvelope(cwd, 'M', 'quick-fix', (raw) => {
      raw.schemaVersion = 1;
      raw.role = { ...(raw.role as Record<string, unknown>), content: 'stale body' };
    });
    assert.equal(readActiveRunBootstrap(cwd, 'M', 'quick-fix'), null);
    const repaired = repairRunBootstrapForBoundChild(cwd, 'M', 'quick-fix', state);
    assert.ok(repaired);
    assert.equal(repaired.schemaVersion, 2);
    assert.equal(repaired.workUnit.contractHash, bounded.workUnit.contractHash);
    assert.deepEqual(repaired.workUnit.outputs, bounded.workUnit.outputs);
    assert.deepEqual(readActiveRunBootstrap(cwd, 'M', 'quick-fix'), repaired);
  });
});

// The child SessionStart header is the delivery surface for the per-run
// contract extras since the context-pack snapshot was removed: integration
// requirements always ride it, and the compact role kernel rides it only when
// the host did NOT deliver the agent doc natively (roleSource
// 'plugin-injected-fallback' — the Codex spawn_agent shape, which used to get
// the role text solely through the removed pager).
test('child SessionStart header renders requirements always, kernel only for plugin-injected-fallback', async () => {
  const { subagentRoleContext } = await import('../../modules/session/session-start-setup');
  const { pluginRoot } = await import('../paths');
  withProject((cwd) => {
    compileRun(cwd, 'R', STATE, UI_INPUT);
    const options = {
      host: 'codex' as const,
      evidenceSource: 'spawn-task-name',
      modelPolicyId: 'policy-header',
    };
    const fallback = ensureRunBootstrap(cwd, 'R', 'senior-frontend', STATE, {
      ...options,
      hostAgentType: null,
    });
    assert.ok(fallback);
    assert.equal(fallback.roleSource, 'plugin-injected-fallback');
    assert.ok((fallback.integrationRequirements || []).length > 0);

    const ctx = { host: 'codex', cwd, input: { raw: {} } } as never;
    const agentContext = { role: 'senior-frontend', runId: 'R', spawnIndex: 1 } as never;
    const res = subagentRoleContext(ctx, STATE as never, agentContext, pluginRoot()) as { kind: string; context?: string };
    assert.equal(res.kind, 'context');
    const body = res.context || '';
    assert.ok(body.includes('## Contract kernel'), 'kernel rides the fallback header');
    assert.ok(body.includes('Integration requirements (deterministic gates verify these)'));
    assert.ok(body.includes('STRUCT_ORPHAN_MODULE'));
    assert.ok(body.length <= 16_000, `child header is ${body.length} chars (budget 16k)`);

    // Host-native role delivery (hostAgentType set) drops the kernel but keeps
    // the requirements — the agent doc reaches the child via the host's own
    // agent file, and duplicating it would double the header for nothing.
    const native = ensureRunBootstrap(cwd, 'R', 'senior-frontend', STATE, {
      ...options,
      hostAgentType: 'senior-frontend',
    });
    assert.ok(native);
    assert.equal(native.roleSource, 'host-native');
    const nativeRes = subagentRoleContext(ctx, STATE as never, agentContext, pluginRoot()) as { kind: string; context?: string };
    const nativeBody = nativeRes.context || '';
    assert.ok(!nativeBody.includes('## Contract kernel'), 'no kernel duplication on host-native delivery');
    assert.ok(nativeBody.includes('Integration requirements (deterministic gates verify these)'));
  });
});
