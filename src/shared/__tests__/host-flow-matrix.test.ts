import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPENCODE_FREE_MODELS } from '../../config/opencode-delegation';
import { WINDSURF_FREE_MODEL, WINDSURF_PAID_MODELS } from '../../config/model-tiers';
import { acceptableModelsFor, resolveModel } from '../model-tiers';
import { buildTeamLineup } from '../onboarding-server/flow';
import { recommendLevelForPlan } from '../performance-config';

type MatrixCase = {
  host: string;
  plan: string;
  level: 'low' | 'balanced' | 'high';
  fallback: string;
  architect?: string;
};

test('host flow matrix: plan, team recommendation, and model routing stay isolated per host', () => {
  const cases: MatrixCase[] = [
    { host: 'opencode', plan: 'free', level: 'low', fallback: OPENCODE_FREE_MODELS[2] ?? 'opencode/nemotron-3-ultra-free' },
    { host: 'opencode', plan: 'plus', level: 'balanced', fallback: 'opencode-go/deepseek-v4-flash', architect: 'opencode-go/glm-5.2' },
    { host: 'windsurf', plan: 'free', level: 'low', fallback: WINDSURF_FREE_MODEL },
    { host: 'windsurf', plan: 'pro', level: 'balanced', fallback: WINDSURF_PAID_MODELS.cheapest, architect: WINDSURF_PAID_MODELS.balanced },
    { host: 'kilo', plan: 'free', level: 'low', fallback: 'kilo-auto/free' },
    { host: 'claude', plan: 'pro', level: 'balanced', fallback: 'haiku', architect: 'sonnet' },
    { host: 'codex', plan: 'plus', level: 'balanced', fallback: 'gpt-5.4-mini', architect: 'gpt-5.4' },
    { host: 'cursor', plan: 'pro', level: 'balanced', fallback: 'composer-2.5', architect: 'claude-4.6-sonnet' },
  ];

  for (const c of cases) {
    assert.equal(recommendLevelForPlan(c.host, c.plan), c.level, `${c.host}/${c.plan} performance level`);
    assert.equal(resolveModel('cheapest', c.host, c.plan), c.fallback, `${c.host}/${c.plan} fallback`);
    const lineup = buildTeamLineup(c.level, c.host, null, { host: c.host, plan: c.plan, useOpenCode: false });
    if (!c.architect) {
      assert.deepEqual(lineup, [], `${c.host}/${c.plan} uses main-agent mode`);
      continue;
    }
    assert.equal(lineup.find((member) => member.role === 'senior-architect')?.model, c.architect, `${c.host}/${c.plan} architect model`);
  }

  assert.deepEqual(acceptableModelsFor('opencode-go/deepseek-v4-flash', 'opencode').slice(0, 4), [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/glm-5.1',
    'opencode-go/qwen3.7-plus',
    'opencode-go/minimax-m2.7',
  ]);
  assert.deepEqual(acceptableModelsFor('kilo-auto/free', 'kilo'), ['kilo-auto/free']);
});
