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
} from '../materialization';
import { stateVersion } from '../io';

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
