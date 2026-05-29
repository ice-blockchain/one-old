import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { emptyStats } from '../emptyStats';
import {
  codexSessionIdFromFile,
  codexUsageFields,
  estimateTrafficOneInstructionTokens,
  fmtCost,
  fmtDuration,
  fmtNum,
  looksTrafficOneRelated,
  maxIso,
  mergeByModel,
  minIso,
  sumIntoStats,
} from '../lib';
import { parseCodexJsonlFile } from '../parseCodexJsonlFile';

test('codexUsageFields splits fresh input from cached + handles missing usage', () => {
  const f = codexUsageFields({ input_tokens: 100, cached_input_tokens: 30, output_tokens: 20, total_tokens: 120 });
  assert.equal(f.inputTokens, 70); // 100 - 30 cached
  assert.equal(f.cacheReadInputTokens, 30);
  assert.equal(f.outputTokens, 20);
  assert.equal(codexUsageFields(null).reportedTotalTokens, 0);
});

test('sumIntoStats + mergeByModel accumulate across sessions', () => {
  const a = emptyStats();
  a.inputTokens = 10; a.byModel['m'] = { messages: 1, inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 2 };
  const b = emptyStats();
  b.inputTokens = 5; b.byModel['m'] = { messages: 1, inputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };
  sumIntoStats(a, b);
  assert.equal(a.inputTokens, 15);
  assert.equal(a.byModel['m']?.inputTokens, 15);
  const merged = mergeByModel({}, b.byModel);
  assert.equal(merged['m']?.outputTokens, 1);
});

test('minIso/maxIso + formatters', () => {
  assert.equal(minIso(null, '2026-01-02'), '2026-01-02');
  assert.equal(minIso('2026-01-02', '2026-01-01'), '2026-01-01');
  assert.equal(maxIso('2026-01-02', '2026-01-03'), '2026-01-03');
  assert.equal(fmtNum(1234567), '1,234,567');
  assert.equal(fmtCost(1.23456), '$1.2346');
  assert.equal(fmtDuration('2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'), '30 min');
  assert.equal(fmtDuration('2026-01-01T00:00:00Z', '2026-01-01T02:15:00Z'), '2h 15m');
  assert.equal(fmtDuration(null, 'x'), '—');
});

test('Traffic One attribution detection + instruction estimate', () => {
  assert.equal(looksTrafficOneRelated('see .traffic-one/rules/common/x'), true);
  assert.equal(looksTrafficOneRelated('unrelated text'), false);
  assert.ok(estimateTrafficOneInstructionTokens('AGENTS.md guidance\n\nmore') > 0);
  assert.equal(estimateTrafficOneInstructionTokens('nothing relevant'), 0);
});

test('codexSessionIdFromFile strips rollout- prefix + .jsonl', () => {
  assert.equal(codexSessionIdFromFile('/x/rollout-abc123.jsonl'), 'abc123');
  assert.equal(codexSessionIdFromFile('/x/plain.jsonl'), 'plain');
});

test('parseCodexJsonlFile reads session meta + cumulative token usage + tool calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-'));
  try {
    const file = path.join(dir, 'rollout-sess1.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'sess1', cwd: '/proj', model: 'gpt-5' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:05:00Z', payload: { type: 'token_count', info: { model_context_window: 200000, total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 25 } } } }),
    ].join('\n'), 'utf8');
    const { session, stats } = parseCodexJsonlFile(file);
    assert.equal(session.id, 'sess1');
    assert.equal(session.cwd, '/proj');
    assert.equal(session.model, 'gpt-5');
    assert.equal(stats.messages, 1);
    assert.equal(stats.toolUses, 1);
    assert.equal(stats.byTool.shell, 1);
    assert.equal(stats.inputTokens, 60); // 100 - 40 cached
    assert.equal(stats.cacheReadInputTokens, 40);
    assert.equal(stats.outputTokens, 25);
    assert.equal(stats.modelContextWindow, 200000);
    assert.equal(stats.byModel['gpt-5']?.inputTokens, 60);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
