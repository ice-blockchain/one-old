import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractProjectPrefs } from '../prefs-split';

test('rescued host buckets drop entire team and performance, not only modeChangeApproval', () => {
  const prefs = extractProjectPrefs({
    hosts: {
      claude: {
        team: {
          mode: 'subagents',
          source: 'prompted',
          approved: true,
          modeChangeApproval: {
            from: 'subagents',
            to: 'main-agent',
            source: 'user-prompt',
          },
        },
        performance: { level: 'high', source: 'prompted' },
        leftover: 'keep',
      },
    },
  });
  const hosts = prefs.hosts as Record<string, Record<string, unknown>> | undefined;
  const claude = hosts?.claude;
  assert.ok(claude, 'non-authorization host fields are still rescued');
  assert.equal(Object.prototype.hasOwnProperty.call(claude, 'team'), false,
    'nested team is not attributed to the scrubbing host');
  assert.equal(Object.prototype.hasOwnProperty.call(claude, 'performance'), false,
    'nested performance is not attributed to the scrubbing host');
  assert.equal(claude.leftover, 'keep');
});

test('a host bucket that is only team/performance is not rescued as an empty approval', () => {
  const prefs = extractProjectPrefs({
    hosts: {
      claude: {
        team: { mode: 'main-agent', source: 'prompted' },
        performance: { level: 'low', source: 'prompted' },
      },
    },
  });
  assert.equal(prefs.hosts, undefined,
    'a bucket that carried only host authorizations leaves nothing to attribute');
});
