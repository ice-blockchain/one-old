import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parsePlanDelegationUnits } from '../opencode-roles/plan-units';
import {
  retargetPlanDelegationUnits,
  retargetPlanOpenCodeQueueToCompiledOutputs,
} from '../opencode-plan/retarget';

const FRONTEND = {
  role: 'senior-frontend',
  scope: {
    include: [
      'apps/web/src/App.tsx',
      'apps/web/src/components/TicketStatusBadge.tsx',
      'apps/web/src/components/TicketStatusBadge.ts',
      'apps/web/src/components/CountdownTimer.tsx',
      'apps/web/src/pages/Home.tsx',
      'packages/i18n/src/locales/en/common.json',
    ],
    exclude: [],
  },
};

const MODULES = [
  { path: 'apps/web/src/App.tsx', ownerRole: 'senior-frontend' },
  { path: 'apps/web/src/components/TicketStatusBadge.tsx', ownerRole: 'senior-frontend' },
  { path: 'apps/web/src/components/TicketStatusBadge.ts', ownerRole: 'senior-frontend' },
  { path: 'apps/web/src/components/CountdownTimer.tsx', ownerRole: 'senior-frontend' },
  { path: 'apps/web/src/pages/Home.tsx', ownerRole: 'senior-frontend' },
];

function unitsFrom(rows: string[]) {
  return parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    ...rows,
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
}

test('retargetPlanDelegationUnits maps kebab component paths onto the unique compiled PascalCase file', () => {
  const units = unitsFrom([
    '- id: badge | role: frontend | kind: component | files: apps/web/src/components/ticket-status-badge.tsx | task: badge visuals',
    '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
    '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
  ]);
  const { units: next, retargets } = retargetPlanDelegationUnits(units, {
    assignments: [FRONTEND],
    moduleOutputs: MODULES,
  });
  assert.equal(retargets.length, 1);
  assert.equal(retargets[0]?.to, 'apps/web/src/components/TicketStatusBadge.tsx');
  assert.equal(next[0]?.files, 'apps/web/src/components/TicketStatusBadge.tsx');
  assert.equal(next[1]?.files, 'packages/i18n/src/locales/en/common.json');
});

test('retargetPlanDelegationUnits maps a conventional short components/ path onto the compiled file', () => {
  const units = unitsFrom([
    '- id: badge | role: frontend | kind: component | files: components/ticket-status-badge.tsx | task: badge visuals',
    '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
    '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
  ]);
  const { retargets } = retargetPlanDelegationUnits(units, {
    assignments: [FRONTEND],
    moduleOutputs: MODULES,
  });
  assert.deepEqual(retargets.map((row) => row.to), ['apps/web/src/components/TicketStatusBadge.tsx']);
});

test('retargetPlanDelegationUnits prefers the matching extension among module variants', () => {
  const units = unitsFrom([
    '- id: badge | role: frontend | kind: component | files: apps/web/src/components/ticket-status-badge.ts | task: badge visuals',
    '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
    '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
  ]);
  const { retargets } = retargetPlanDelegationUnits(units, {
    assignments: [FRONTEND],
    moduleOutputs: MODULES,
  });
  assert.equal(retargets[0]?.to, 'apps/web/src/components/TicketStatusBadge.ts');
});

test('retargetPlanDelegationUnits leaves invented helpers with no compiled module alone', () => {
  const units = unitsFrom([
    '- id: helpers | role: frontend | kind: helper | files: apps/web/src/lib/format.ts | task: pure helpers',
    '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
    '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
  ]);
  const { units: next, retargets } = retargetPlanDelegationUnits(units, {
    assignments: [FRONTEND],
    moduleOutputs: MODULES,
  });
  assert.deepEqual(retargets, []);
  assert.equal(next[0]?.files, 'apps/web/src/lib/format.ts');
});

test('retargetPlanDelegationUnits maps a unique kebab stem onto a compiled file in a different folder', () => {
  const units = unitsFrom([
    '- id: badge | role: frontend | kind: component | files: apps/web/src/components/ticket-status-badge.tsx | task: badge visuals',
    '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
    '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
  ]);
  const { retargets } = retargetPlanDelegationUnits(units, {
    assignments: [{
      role: 'senior-frontend',
      scope: {
        include: ['packages/ui/src/TicketStatusBadge.tsx', 'packages/i18n/src/locales/en/common.json'],
        exclude: [],
      },
    }],
    moduleOutputs: [
      { path: 'packages/ui/src/TicketStatusBadge.tsx', ownerRole: 'senior-frontend' },
    ],
  });
  assert.deepEqual(retargets.map((row) => row.to), ['packages/ui/src/TicketStatusBadge.tsx']);
});

test('retargetPlanDelegationUnits does not guess at generic stems or ambiguous same-stem modules', () => {
  const generic = unitsFrom([
    '- id: barrel | role: frontend | kind: feature | files: apps/web/src/features/catalog/index.tsx | task: barrel',
    '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
    '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
  ]);
  assert.deepEqual(retargetPlanDelegationUnits(generic, {
    assignments: [FRONTEND],
    moduleOutputs: [
      ...MODULES,
      { path: 'apps/web/src/features/catalog/index.tsx', ownerRole: 'senior-frontend' },
      { path: 'apps/web/src/features/other/index.tsx', ownerRole: 'senior-frontend' },
    ],
  }).retargets, []);

  const ambiguous = unitsFrom([
    '- id: badge | role: frontend | kind: component | files: components/status-badge.tsx | task: badge',
    '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
    '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
  ]);
  const { retargets } = retargetPlanDelegationUnits(ambiguous, {
    assignments: [{
      role: 'senior-frontend',
      scope: {
        include: [
          'apps/web/src/components/StatusBadge.tsx',
          'packages/ui/src/components/StatusBadge.tsx',
        ],
        exclude: [],
      },
    }],
    moduleOutputs: [
      { path: 'apps/web/src/components/StatusBadge.tsx', ownerRole: 'senior-frontend' },
      { path: 'packages/ui/src/components/StatusBadge.tsx', ownerRole: 'senior-frontend' },
    ],
  });
  assert.deepEqual(retargets, []);
});

test('retargetPlanOpenCodeQueueToCompiledOutputs rewrites plan.md on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocretarget-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), [
      '# Plan',
      '<!-- opencode-delegate:start -->',
      '- id: badge | role: frontend | kind: component | files: apps/web/src/components/ticket-status-badge.tsx | task: badge visuals',
      '- id: locales | role: frontend | kind: i18n | files: packages/i18n/src/locales/en/common.json | task: copy',
      '- id: home | role: frontend | kind: page | files: apps/web/src/pages/Home.tsx | task: home page',
      '<!-- opencode-delegate:end -->',
      '',
    ].join('\n'), 'utf8');
    const retargets = retargetPlanOpenCodeQueueToCompiledOutputs(dir, {
      assignments: [FRONTEND],
      moduleOutputs: MODULES,
    });
    assert.equal(retargets.length, 1);
    const plan = fs.readFileSync(path.join(dir, '.traffic-one', 'plan.md'), 'utf8');
    assert.match(plan, /TicketStatusBadge\.tsx/);
    assert.doesNotMatch(plan, /ticket-status-badge\.tsx/);
    assert.match(plan, /# Plan/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
