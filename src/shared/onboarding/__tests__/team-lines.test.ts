import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTeamLines, resolveTeamTiers } from '../team-lines';

test('resolveTeamTiers returns the configured tier map for high/balanced', () => {
  const high = resolveTeamTiers('high');
  assert.equal(high['senior-architect'], 'highest');
  assert.equal(high['senior-tester'], 'cheapest');
  const balanced = resolveTeamTiers('balanced');
  assert.equal(balanced['senior-architect'], 'balanced');
  // low has no subagents
  assert.deepEqual(resolveTeamTiers('low'), {});
  assert.deepEqual(resolveTeamTiers('bogus'), {});
});

test('resolveTeamTiers applies valid per-role overrides, ignores junk', () => {
  const tiers = resolveTeamTiers('high', { 'senior-tester': 'highest', 'senior-architect': 'not-a-tier', 'unknown-role': 'highest' });
  assert.equal(tiers['senior-tester'], 'highest'); // overridden
  assert.equal(tiers['senior-architect'], 'highest'); // junk override ignored → keeps config
  assert.equal(tiers['unknown-role'], undefined); // override for non-configured role ignored
});

test('renderTeamLines renders role → tier → per-host model columns', () => {
  const lines = renderTeamLines('high');
  const architect = lines.find((l) => l.includes('senior-architect'));
  assert.ok(architect);
  assert.ok(architect!.includes('highest'));
  assert.ok(architect!.includes('claude:'));
  assert.ok(architect!.includes('codex:'));
  assert.ok(architect!.includes('cursor:'));
  // an override is annotated
  const overridden = renderTeamLines('high', { 'senior-tester': 'highest' }).find((l) => l.includes('senior-tester'));
  assert.ok(overridden!.includes('(override)'));
});
