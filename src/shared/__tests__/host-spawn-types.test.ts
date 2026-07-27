import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_ROLES } from '../../config/performance';
import {
  acceptableSpawnTypes,
  canonicalHostAgentType,
  hostSpawnType,
  spawnTypeRow,
} from '../host-spawn-types';

test('Cursor offers the role type first and a built-in fallback for a stale type set', () => {
  // Live failure this exists for: Cursor's Task enum held `senior-backend` but not
  // `senior-architect`/`senior-shipper`, because those agent files were written
  // during onboarding — after the session captured its accepted types. The spawn
  // failed inside Cursor's schema validation, before any hook could intervene.
  for (const role of AGENT_ROLES) {
    const spawn = hostSpawnType('cursor', role);
    assert.equal(spawn.primary, role, `${role}: the file name IS the type`);
    assert.equal(spawn.fallback, 'generalPurpose', `${role}: a recovery type exists`);
    assert.equal(spawn.parameter, 'subagent_type');
    assert.equal(spawn.contractPath, `.cursor/agents/${role}.md`, `${role}: the fallback child must read its contract`);
    assert.deepEqual(acceptableSpawnTypes('cursor', role), [role, 'generalPurpose']);
    assert.match(spawnTypeRow('cursor', role), /subagent_type: "senior-.+" \(if that type is rejected: `generalPurpose`/);
  }
});

test('hosts whose custom types are never registered pin the built-in as PRIMARY', () => {
  // Kilo agent files are role contracts, not Task types; Windsurf profiles are not
  // registered until a new Devin session. For these the built-in is the only path,
  // so it must not be modelled as a fallback anyone could skip.
  const kilo = hostSpawnType('kilo', 'senior-frontend');
  assert.equal(kilo.primary, 'general');
  assert.equal(kilo.fallback, null);
  assert.equal(kilo.contractPath, '.kilo/agents/senior-frontend.md');

  const windsurf = hostSpawnType('windsurf', 'senior-frontend');
  assert.equal(windsurf.primary, 'subagent_general');
  assert.equal(windsurf.parameter, 'profile');
  assert.equal(windsurf.contractPath, '.devin/agents/senior-frontend/AGENT.md');

  // OpenCode's built-in `general` inherits the parent model, so it is never a safe
  // fallback — the recovery there is a host restart, not a generic worker.
  assert.equal(hostSpawnType('opencode', 'senior-frontend').fallback, null);

  // Codex takes the canonical underscore form on a differently-named parameter.
  const codex = hostSpawnType('codex', 'senior-frontend');
  assert.equal(codex.primary, 'senior_frontend');
  assert.equal(codex.parameter, 'task_name');
});

test('a fallback spawn records the CANONICAL type so it reuses the published bootstrap', () => {
  // hostAgentType feeds the work-unit contract and the bootstrap envelope hash. If
  // the generic value were recorded verbatim, a fallback spawn would miss the
  // bootstrap the parent already published for this role and stall the child.
  assert.equal(canonicalHostAgentType('cursor', 'senior-backend', 'generalPurpose', true), 'senior-backend');
  assert.equal(canonicalHostAgentType('cursor', 'senior-backend', 'GENERALPURPOSE', true), 'senior-backend');
  // The typed spawn is unchanged, and an unrelated type is reported as-is so the
  // gate can still refuse it.
  assert.equal(canonicalHostAgentType('cursor', 'senior-backend', 'senior-backend', true), 'senior-backend');
  assert.equal(canonicalHostAgentType('cursor', 'senior-backend', 'reviewer', true), 'reviewer');
  // Hosts without typed subagents keep reporting null.
  assert.equal(canonicalHostAgentType('cursor', 'senior-backend', 'generalPurpose', false), null);
  assert.equal(canonicalHostAgentType('cursor', 'senior-backend', '', true), null);
});
