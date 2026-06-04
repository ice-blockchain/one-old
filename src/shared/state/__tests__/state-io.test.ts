import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stateTimestamp } from '../io';
import {
  MOBILE_SOURCE_ALIASES,
  TEAM_MODE_ALIASES,
  TEAM_MODE_IDS,
  VALID_AGENT_ROLES,
} from '../../../config/state';

test('stateTimestamp drops milliseconds (legacy on-disk format)', () => {
  assert.match(stateTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('constants: team-mode ids + aliases match legacy', () => {
  assert.ok(TEAM_MODE_IDS.has('subagents'));
  assert.ok(TEAM_MODE_IDS.has('main-agent'));
  assert.equal(TEAM_MODE_ALIASES.get('enabled'), 'subagents');
  assert.equal(TEAM_MODE_ALIASES.get('disabled'), 'main-agent');
});

test('constants: agent roles + mobile-source aliases match legacy', () => {
  assert.ok(VALID_AGENT_ROLES.has('senior-architect'));
  assert.equal(MOBILE_SOURCE_ALIASES.get('web-only'), 'none');
  assert.equal(MOBILE_SOURCE_ALIASES.get('requested'), 'explicit');
});
