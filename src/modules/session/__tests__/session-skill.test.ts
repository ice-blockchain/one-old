import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSkillBlock } from '../../../shared/skill-block';
import { pluginRoot } from '../../../shared/paths';

const skillBlock = makeSkillBlock(pluginRoot);

test('session authoring guard prose remains available and substitutes paths', () => {
  const guard = skillBlock('session', 'authoring-write-guard', {
    PATH: '/plugin/.traffic-one/.one.json',
    ROOT: '/plugin',
  });
  assert.ok(guard.includes('/plugin/.traffic-one/.one.json'));
  assert.ok(guard.includes('plugin source repository'));
  assert.ok(!guard.includes('{{PATH}}'));
  assert.ok(!guard.includes('{{ROOT}}'));
});
