import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPENCODE_FREE_MODELS } from '../../config/model-tiers';
import { modelTierSnapshot, resolveModel } from '../model-tiers';
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
    { host: 'windsurf', plan: 'free', level: 'low', fallback: 'SWE-1.6 Slow' },
    { host: 'windsurf', plan: 'pro', level: 'balanced', fallback: 'SWE-1.6 Slow', architect: 'SWE-1.7 Lightning Beta' },
    { host: 'kilo', plan: 'free', level: 'low', fallback: 'kilo/kilo-auto/free' },
    { host: 'claude', plan: 'pro', level: 'balanced', fallback: 'claude-haiku-4-5', architect: 'claude-sonnet-5' },
    { host: 'codex', plan: 'plus', level: 'balanced', fallback: 'gpt-5.4-mini', architect: 'gpt-5.6-terra' },
    { host: 'cursor', plan: 'pro', level: 'balanced', fallback: 'composer-2.5', architect: 'gpt-5.6-terra' },
  ];

  for (const c of cases) {
    assert.equal(recommendLevelForPlan(c.host, c.plan), c.level, `${c.host}/${c.plan} performance level`);
    assert.equal(resolveModel('cheapest', c.host, c.plan), c.fallback, `${c.host}/${c.plan} fallback`);
    const lineup = buildTeamLineup(c.level, c.host, null, { host: c.host, plan: c.plan });
    if (!c.architect) {
      assert.deepEqual(lineup, [], `${c.host}/${c.plan} uses main-agent mode`);
      continue;
    }
    assert.equal(lineup.find((member) => member.role === 'senior-architect')?.model, c.architect, `${c.host}/${c.plan} architect model`);
  }

  assert.deepEqual(modelTierSnapshot('opencode', 'plus').cheapest.slice(0, 4), [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/mimo-v2.5',
    'opencode-go/minimax-m3',
    'opencode-go/qwen3.7-plus',
  ]);
  assert.deepEqual(modelTierSnapshot('kilo', 'free').highest, [
    'kilo/kilo-auto/frontier', 'kilo/kilo-auto/balanced', 'kilo/kilo-auto/efficient', 'kilo/kilo-auto/free',
  ]);
});
