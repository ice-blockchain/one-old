import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { addToStats } from '../lib';
import { cacheHitRate } from '../cacheHitRate';
import { emptyStats } from '../emptyStats';
import { estimateCost } from '../estimateCost';
import { parseJsonlFile } from '../parseJsonlFile';
import { parseOriginalTokenCount } from '../parseOriginalTokenCount';
import { priceFor } from '../priceFor';
import { projectSlugFromCwd } from '../projectSlugFromCwd';
import { totalTokens } from '../totalTokens';

function assistantMsg(model: string, usage: Record<string, number>, tool?: string): unknown {
  return {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', model, usage, content: tool ? [{ type: 'tool_use', name: tool }] : [] },
  };
}

test('addToStats accumulates tokens, per-model, tools, and the largest message', () => {
  const stats = emptyStats();
  addToStats(stats, assistantMsg('claude-opus-4-7', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }, 'Bash'));
  addToStats(stats, assistantMsg('claude-opus-4-7', { input_tokens: 20, output_tokens: 5 }));
  addToStats(stats, { type: 'assistant', message: { role: 'assistant' } }); // no usage → ignored
  assert.equal(stats.messages, 2);
  assert.equal(stats.inputTokens, 120);
  assert.equal(stats.outputTokens, 55);
  assert.equal(stats.cacheReadInputTokens, 10);
  assert.equal(stats.toolUses, 1);
  assert.equal(stats.byTool.Bash, 1);
  assert.equal(stats.byModel['claude-opus-4-7']?.messages, 2);
  assert.equal(stats.largestMessage?.tokens, 165); // first msg total
});

test('totalTokens / cacheHitRate compute from stats', () => {
  const stats = emptyStats();
  Object.assign(stats, { inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 300, outputTokens: 50 });
  assert.equal(totalTokens(stats), 450);
  assert.equal(cacheHitRate(stats), 75); // 300 / 400 input * 100
  assert.equal(cacheHitRate(emptyStats()), 0);
});

test('priceFor matches longest model prefix, falls back to _default', () => {
  assert.equal(priceFor('claude-opus-4-7').output, 25);
  assert.equal(priceFor('claude-opus-4-8').output, 25);
  assert.equal(priceFor('claude-fable-5').output, 50);
  assert.equal(priceFor('claude-opus-4-9').output, 25); // family-prefix match for future point releases
  assert.equal(priceFor('claude-sonnet-4-6-20260101').output, 15); // prefix match
  assert.equal(priceFor('gpt-5').output, 15); // _default (sonnet-class)
  assert.equal(priceFor(null).output, 15);
});

test('estimateCost sums per-model USD', () => {
  const stats = emptyStats();
  stats.byModel['claude-opus-4-7'] = { messages: 1, inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1_000_000 };
  // 1M input * $5 + 1M output * $25 = $30
  assert.equal(estimateCost(stats), 30);
});

test('parseOriginalTokenCount + projectSlugFromCwd', () => {
  assert.equal(parseOriginalTokenCount('… Original token count: 12,345 …'), 12345);
  assert.equal(parseOriginalTokenCount('nope'), 0);
  assert.equal(projectSlugFromCwd('/Users/x/proj'), '-Users-x-proj');
});

test('parseJsonlFile reads assistant records (ignores junk + missing file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tokrep-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify(assistantMsg('claude-sonnet-4-6', { input_tokens: 10, output_tokens: 4 })),
      'not json',
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify(assistantMsg('claude-sonnet-4-6', { input_tokens: 6, output_tokens: 2 })),
    ].join('\n'), 'utf8');
    const stats = parseJsonlFile(file);
    assert.equal(stats.messages, 2);
    assert.equal(stats.inputTokens, 16);
    assert.equal(parseJsonlFile(path.join(dir, 'missing.jsonl')).messages, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
