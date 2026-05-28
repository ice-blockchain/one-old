import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeAgentRole,
  getSpawnIndex,
  isFixCycleSession,
  isMaterialized,
  isSubagentSession,
  stackFingerprint,
} from '../materialization';

test('stackFingerprint joins the four dimensions', () => {
  assert.equal(
    stackFingerprint({ stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'ionic-capacitor' } }),
    'default|react-vite|supabase|ionic-capacitor',
  );
  assert.equal(stackFingerprint({}), 'minimal|none|none|none');
});

test('isMaterialized matches the stamp against the live fingerprint', () => {
  const base = { onboardingComplete: true, stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  assert.equal(isMaterialized({ ...base, materializedStack: stackFingerprint(base) }), true);
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

test('activeAgentRole, spawn index, and fix-cycle detection', () => {
  assert.equal(activeAgentRole({ activeAgentRole: 'senior-frontend' }), 'senior-frontend');
  assert.equal(activeAgentRole({ activeAgentRole: 'bogus' }), null);
  assert.equal(getSpawnIndex({ spawnIndex: { 'senior-frontend': 3 } }, 'senior-frontend'), 3);
  assert.equal(getSpawnIndex({}, 'senior-frontend'), 0);

  const base = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, currentRunId: 'r1' };
  const fp = stackFingerprint(base);
  assert.equal(isFixCycleSession({ ...base, materializedStack: fp, activeAgentRole: 'senior-frontend', spawnIndex: { 'senior-frontend': 2 } }), true);
  assert.equal(isFixCycleSession({ ...base, materializedStack: fp, activeAgentRole: 'senior-frontend', spawnIndex: { 'senior-frontend': 1 } }), false);
});
