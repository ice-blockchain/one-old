import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { STRUCTURAL_PROFILE_IDS } from '../index';

type RoutingModule = {
  NEW_PROJECT_PROFILE_RULE_BY_ID: Record<string, string>;
  modeRulesForState: (
    root: string,
    state: Record<string, unknown>,
    profileId?: string,
  ) => string[];
  modeReferenceRulesForState: (
    root: string,
    state: Record<string, unknown>,
    profileId?: string,
  ) => string[];
};

const routing = require(path.join(__dirname, '..', '..', 'materialize', 'cleanup')) as RoutingModule;

test('every structural profile has one exact new-project rule and routing fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-profile-routing-'));
  try {
    const map = routing.NEW_PROJECT_PROFILE_RULE_BY_ID;
    assert.deepEqual(Object.keys(map).sort(), [...STRUCTURAL_PROFILE_IDS].sort());
    assert.equal(new Set(Object.values(map)).size, STRUCTURAL_PROFILE_IDS.length);
    for (const profileId of STRUCTURAL_PROFILE_IDS) {
      assert.equal(map[profileId], `rules/modes/new-project-${profileId}.md`);
    }

    for (const relPath of [
      'rules/modes/new-project.md',
      'rules/modes/new-project-architecture.md',
      'rules/modes/new-project-setup.md',
      ...Object.values(map),
    ]) {
      const target = path.join(root, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `# ${path.basename(relPath)}\n`, 'utf8');
    }

    const customState = { mode: 'new-project', stack: 'custom-stack' };
    for (const profileId of STRUCTURAL_PROFILE_IDS) {
      assert.deepEqual(
        routing.modeRulesForState(root, customState, profileId),
        ['rules/modes/new-project.md', map[profileId]],
      );
      assert.deepEqual(
        routing.modeReferenceRulesForState(root, customState, profileId),
        ['rules/modes/new-project-architecture.md'],
      );
    }

    for (const stack of ['default', 'react-realtime-monorepo']) {
      assert.deepEqual(
        routing.modeReferenceRulesForState(
          root,
          { mode: 'new-project', stack },
          'vite-react',
        ),
        ['rules/modes/new-project-architecture.md', 'rules/modes/new-project-setup.md'],
      );
    }

    assert.deepEqual(
      routing.modeRulesForState(root, customState),
      ['rules/modes/new-project.md'],
    );
    assert.deepEqual(
      routing.modeRulesForState(root, customState, 'future-profile'),
      ['rules/modes/new-project.md'],
    );

    const missingProfileRule = map['next-app'];
    assert.ok(missingProfileRule);
    fs.rmSync(path.join(root, missingProfileRule));
    assert.deepEqual(
      routing.modeRulesForState(root, customState, 'next-app'),
      ['rules/modes/new-project.md'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
