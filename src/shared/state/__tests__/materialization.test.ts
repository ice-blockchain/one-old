import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeAgentRole,
  getSpawnIndex,
  isMaterialized,
  isSubagentSession,
  isUnknownStackFingerprint,
  stackFingerprint,
  UNKNOWN_STACK_FINGERPRINT,
  WORKSPACE_STACK_FINGERPRINT,
} from '../materialization';
import { stateVersion } from '../io';
import { STACK_IDS } from '../../../config/stacks';
import { WORKSPACE_PROJECT_MODE } from '../../hook/workspace-members';

test('stackFingerprint joins the four dimensions', () => {
  assert.equal(
    stackFingerprint({ stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'ionic-capacitor' } }),
    'default|react-vite|supabase|ionic-capacitor',
  );
  // A REAL minimal project carries `stack: 'minimal'`.
  assert.equal(stackFingerprint({ stack: 'minimal' }), 'minimal|none|none|none');
  // A degraded/absent read must stay distinguishable from it, so no writer can
  // stamp a fabricated identity that mismatches the project forever after.
  assert.equal(stackFingerprint({}), UNKNOWN_STACK_FINGERPRINT);
  assert.equal(stackFingerprint(null), UNKNOWN_STACK_FINGERPRINT);
  assert.equal(isUnknownStackFingerprint(stackFingerprint({})), true);
  assert.equal(isUnknownStackFingerprint(stackFingerprint({ stack: 'minimal' })), false);
});

// ── the fingerprint is FROZEN, and this is the table that says so ────────────
//
// `stackFingerprint`'s 4-tuple is written into every run ledger, every claim,
// the rebind journal and the assignments manifest, and a claim whose
// fingerprint disagrees with the run's is rejected as `fingerprint-mismatch`
// (state/run-agent/claims-pending.ts) — a deny that no respawn, resume or
// settlement can clear. So a widening of this function is only safe if it moves
// NOTHING that produces a fingerprint today, and "nothing" has to be checked
// against literal strings rather than against the function's own output.
const FROZEN_FINGERPRINTS: readonly [label: string, state: unknown, fingerprint: string][] = [
  ['minimal', { stack: 'minimal' }, 'minimal|none|none|none'],
  ['default', { stack: 'default' }, 'default|none|none|none'],
  ['custom-frontend', { stack: 'custom-frontend' }, 'custom-frontend|none|none|none'],
  ['custom-backend', { stack: 'custom-backend' }, 'custom-backend|none|none|none'],
  ['custom-stack', { stack: 'custom-stack' }, 'custom-stack|none|none|none'],
  ['the full four-dimensional shape', {
    stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'ionic-capacitor' },
  }, 'default|react-vite|supabase|ionic-capacitor'],
  ['a stackless record carrying only a frontend', { frontend: 'react-vite' }, 'minimal|react-vite|none|none'],
  ['a stackless record carrying only a backend', { backend: 'node' }, 'minimal|none|node|none'],
  ['a stackless record carrying only a mobile object', { mobile: { framework: 'react-native-expo' } }, 'minimal|none|none|react-native-expo'],
  ['an EMPTY mobile object still counts as an identity-bearing key', { mobile: {} }, 'minimal|none|none|none'],
  ['a new-project record with nothing in it', { mode: 'new-project' }, UNKNOWN_STACK_FINGERPRINT],
  ['an existing-codebase record with nothing in it', { mode: 'existing-codebase' }, UNKNOWN_STACK_FINGERPRINT],
  ['an existing-with-supabase record with nothing in it', { mode: 'existing-with-supabase' }, UNKNOWN_STACK_FINGERPRINT],
  ['a record with no mode at all', {}, UNKNOWN_STACK_FINGERPRINT],
  ['a degraded read', null, UNKNOWN_STACK_FINGERPRINT],
  // `workspace` is a RESERVED value in the stack slot, so a record that joins
  // to the container identity without saying it is a container is an illegible
  // record wearing a reserved name. No writer can produce it — `stack` is
  // written from `STACK_IDS`, which does not contain it — and a project that
  // somehow carried it would share one fingerprint with every container on the
  // machine, which is the collision the dedicated value exists to prevent.
  ['a record claiming the reserved stack name', { stack: 'workspace' }, UNKNOWN_STACK_FINGERPRINT],
  ['…even with a mode', { mode: 'new-project', stack: 'workspace' }, UNKNOWN_STACK_FINGERPRINT],
  // Only the whole 4-tuple is reserved; the stem alone is not.
  ['…but only the WHOLE tuple is reserved', { stack: 'workspace', frontend: 'react-vite' }, 'workspace|react-vite|none|none'],
];

test('stackFingerprint: every shape that produces a fingerprint today produces the SAME one', () => {
  for (const [label, state, fingerprint] of FROZEN_FINGERPRINTS) {
    assert.equal(stackFingerprint(state), fingerprint, label);
  }
  // The table above is only a proof of "nothing moved" if it covers the whole
  // stack vocabulary. Fail loudly when a stack is added rather than quietly
  // testing a subset of it.
  const covered = new Set(FROZEN_FINGERPRINTS
    .map(([, state]) => (state as { stack?: string } | null)?.stack)
    .filter((stack): stack is string => typeof stack === 'string'));
  for (const stack of STACK_IDS) {
    assert.equal(covered.has(stack), true, `${stack} is missing from the frozen table`);
  }
});

test('stackFingerprint: a stackless WORKSPACE record is an identity, not a degraded read', () => {
  const container = { mode: WORKSPACE_PROJECT_MODE, onboardingComplete: true, workspaceMembers: [{ path: 'svc' }] };
  assert.equal(stackFingerprint(container), WORKSPACE_STACK_FINGERPRINT);
  assert.equal(isUnknownStackFingerprint(stackFingerprint(container)), false,
    'a container has no stack BY CONSTRUCTION — that is a fact about it, not a failure to read it');
  // …and it is its own identity, never the fabricated `minimal|none|none|none`
  // the note at the top of materialization.ts records as a live defect.
  assert.notEqual(stackFingerprint(container), stackFingerprint({ stack: 'minimal' }));
  assert.equal(STACK_IDS.has('workspace'), false,
    'the value in the stack slot cannot collide with a real stack id');
});

test('stackFingerprint: the container answer is keyed on the MODE, not on emptiness', () => {
  // Keyed on "no identity-bearing key at all", a container carrying ONE
  // incidental field fell through to the join, whose `stack` slot defaults to
  // `'minimal'`. `frontend: 'none'` is the measured case and `'none'` is a real
  // value the wizard writes, so the container's identity became exactly the
  // fabricated `minimal|none|none|none` this module exists to keep out of a run
  // ledger.
  for (const incidental of [
    { frontend: 'none' },
    { backend: 'none' },
    { mobile: {} },
    { backend: 'node' },
    { stack: '' },
  ]) {
    assert.equal(
      stackFingerprint({ mode: WORKSPACE_PROJECT_MODE, ...incidental }),
      WORKSPACE_STACK_FINGERPRINT,
      `a container carrying ${JSON.stringify(incidental)} is still a container`,
    );
  }
  // A workspace record that DOES carry a stack is a legacy state path or a
  // hand-edit, and it keeps the fingerprint it has today.
  assert.equal(
    stackFingerprint({ mode: WORKSPACE_PROJECT_MODE, stack: 'default', frontend: 'react-vite' }),
    'default|react-vite|none|none',
  );
  // And no OTHER mode gets the container answer.
  for (const mode of ['new-project', 'existing-codebase', 'existing-with-supabase', 'Workspace', '']) {
    assert.equal(stackFingerprint({ mode }), UNKNOWN_STACK_FINGERPRINT, `mode ${JSON.stringify(mode)}`);
  }
});

test('stackFingerprint: NOTHING but a workspace-mode record produces the container identity', () => {
  // The property that actually matters, and the one the previous version of
  // this file did not assert: it checked only that every STACK_ID had a row in
  // the frozen table, which says nothing about what ELSE can reach the reserved
  // value. `{ stack: 'workspace' }` did reach it — a project and every
  // container on the machine sharing one fingerprint, which is the collision
  // the dedicated value was introduced to prevent, arriving through the other
  // door. A claim whose fingerprint disagrees with its run's is rejected as
  // `fingerprint-mismatch`, a deny no respawn can clear.
  const population: readonly unknown[] = [
    null, undefined, {}, 'workspace', 42,
    { stack: 'workspace' },
    { stack: 'workspace', mode: 'new-project' },
    { stack: 'workspace', mode: 'existing-codebase' },
    { stack: 'workspace', frontend: 'none', backend: 'none' },
    { stack: 'workspace', mobile: { framework: 'none' } },
    { mode: 'Workspace' },
    { mode: 'workspaces' },
    ...[...STACK_IDS].map((stack) => ({ stack })),
    ...[...STACK_IDS].map((stack) => ({ stack, mode: WORKSPACE_PROJECT_MODE })),
    // …and the records that SHOULD reach it, so the population is not a
    // degenerate all-negative one that would pass with the guard deleted.
    { mode: WORKSPACE_PROJECT_MODE },
    { mode: WORKSPACE_PROJECT_MODE, onboardingComplete: true, workspaceMembers: [{ path: 'svc' }] },
    { mode: WORKSPACE_PROJECT_MODE, frontend: 'none' },
  ];
  const saysItIsAContainer = (state: unknown): boolean => {
    const record = state as { mode?: unknown; stack?: unknown } | null;
    return Boolean(record) && record!.mode === WORKSPACE_PROJECT_MODE && !record!.stack;
  };
  for (const state of population) {
    assert.equal(
      stackFingerprint(state) === WORKSPACE_STACK_FINGERPRINT,
      saysItIsAContainer(state),
      `${JSON.stringify(state)} must reach the container identity only by SAYING it is a container`,
    );
  }
  // Both degeneracies would leave the loop above passing.
  assert.equal(population.some(saysItIsAContainer), true, 'the population still contains containers');
  assert.equal(population.some((state) => !saysItIsAContainer(state)), true, 'and still contains non-containers');
});

test('isMaterialized: the container identity is a DURABILITY guard, and the migration surface is empty', () => {
  // Stated as a bug fix — "a container could never stamp an identity that
  // matched itself, so every convergence pass re-materialized it" — this was
  // describing a state no writer creates. `writeWorkspaceMemberRegistry`
  // commits `mode`, `version` and `workspaceMembers` and NOTHING else, and
  // `isMaterialized` short-circuits on a falsy `onboardingComplete` before it
  // ever compares a stamp. So a container as written never reached the
  // comparison, with UNKNOWN or with the dedicated value, and no container on
  // disk carries a `materializedStack` for anything to reinterpret.
  const asWritten = { mode: WORKSPACE_PROJECT_MODE, version: 1, workspaceMembers: [{ path: 'svc' }] };
  assert.equal(isMaterialized(asWritten), true,
    'pre-onboarding never blocks — the stamp comparison is not reached at all');
  assert.equal('materializedStack' in asWritten, false, 'so there is no stamp to migrate');

  // What the value buys is that the comparison means something the day a
  // container's onboarding does complete: UNKNOWN is what it would stamp AND
  // what it would re-derive, equal by accident and equal to every unreadable
  // record on the machine.
  const completed = { mode: WORKSPACE_PROJECT_MODE, onboardingComplete: true };
  assert.equal(isMaterialized({ ...completed, materializedStack: WORKSPACE_STACK_FINGERPRINT }), true);
  assert.equal(isMaterialized({ ...completed, materializedStack: UNKNOWN_STACK_FINGERPRINT }), false,
    'a stamp written before the container had an identity does not pass as current');
});

test('isMaterialized matches the stamp against the live fingerprint and plugin version', () => {
  const base = { onboardingComplete: true, stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  assert.equal(isMaterialized({ ...base, materializedStack: stackFingerprint(base) }), true);
  assert.equal(isMaterialized({ ...base, materializedStack: stackFingerprint(base), materializedVersion: stateVersion() }), true);
  assert.equal(isMaterialized({ ...base, materializedStack: stackFingerprint(base), materializedVersion: '0.0.0' }), false);
  assert.equal(isMaterialized({ ...base, materializedStack: 'stale' }), false);
  assert.equal(isMaterialized({ ...base }), false);
  assert.equal(isMaterialized({ stack: 'default' }), true); // pre-onboarding never blocks
});

test('isSubagentSession requires a run id + fresh, matching stamp', () => {
  const base = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, currentRunId: 'r1' };
  const fp = stackFingerprint(base);
  assert.equal(isSubagentSession({ ...base, materializedStack: fp, materializedAt: new Date().toISOString() }), true);
  assert.equal(isSubagentSession({ ...base, materializedStack: fp, materializedAt: '2000-01-01T00:00:00Z' }), false);
  assert.equal(isSubagentSession({ ...base, materializedStack: fp }), true);
  assert.equal(isSubagentSession({ ...base }), false);
});

test('activeAgentRole and the state-side spawn index', () => {
  assert.equal(activeAgentRole({ activeAgentRole: 'senior-frontend' }), 'senior-frontend');
  assert.equal(activeAgentRole({ activeAgentRole: 'bogus' }), null);
  assert.equal(getSpawnIndex({ spawnIndex: { 'senior-frontend': 3 } }, 'senior-frontend'), 3);
  // 0 is the REAL value on Codex and Claude agent-teams: `bindThreadRole`
  // declines writeState, so `.one.json` never carries `spawnIndex` there. The
  // deleted `isFixCycleSession()` read only this and was therefore permanently
  // false on those hosts; fix-cycle detection reads the resolved claim instead.
  assert.equal(getSpawnIndex({}, 'senior-frontend'), 0);
});
