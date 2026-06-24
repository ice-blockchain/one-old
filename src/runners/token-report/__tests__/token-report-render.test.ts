import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { emptyStats } from '../emptyStats';
import { emptyTrafficOneEstimate } from '../emptyTrafficOneEstimate';
import { renderMarkdown } from '../render';
import { parseArgs, selectTargetSessions } from '../index';
import { discoverSubagents, readCodexSessionMeta, walkCodexSessionFiles } from '../discovery';
import { aggregateCursorSqliteEstimate } from '../aggregateCursorSqliteEstimate';

function statsWith(over: Partial<ReturnType<typeof emptyStats>>): ReturnType<typeof emptyStats> {
  return { ...emptyStats(), ...over };
}

test('renderMarkdown (claude) renders totals + by-phase + by-model sections', () => {
  const parent = statsWith({ messages: 3, toolUses: 2, inputTokens: 100, outputTokens: 50, byTool: { Bash: 2 }, byModel: { 'claude-opus-4-7': { messages: 3, inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 50 } } });
  const md = renderMarkdown({ source: 'claude', session: { id: 's1' }, parent, subagents: [] });
  assert.ok(md.includes('# Token usage report'));
  assert.ok(md.includes('## Totals'));
  assert.ok(md.includes('| Total tokens | 150 |'));
  assert.ok(md.includes('## By phase / role'));
  assert.ok(md.includes('Main agent (parent)'));
  assert.ok(md.includes('## By model'));
  assert.ok(md.includes('claude-opus-4-7'));
  assert.ok(md.includes('## Tool calls'));
});

test('renderMarkdown (codex) renders the codex report with traffic-one estimate', () => {
  const parent = statsWith({ messages: 1, inputTokens: 60, cacheReadInputTokens: 40, outputTokens: 25 });
  const trafficOne = { ...emptyTrafficOneEstimate(), directToolOutputTokens: 500, directToolOutputs: 2, instructionApproxTokens: 1200 };
  const md = renderMarkdown({ source: 'codex', session: { id: 'c1', cwd: '/proj' }, parent, subagents: [], trafficOne });
  assert.ok(md.includes('Source: Codex Desktop'));
  assert.ok(md.includes('`c1`'));
  assert.ok(md.includes('## Traffic One estimate'));
  assert.ok(md.includes('| Traffic One instruction approx. | 1,200 |'));
});

test('renderMarkdown (cursor) renders estimate-only limitation', () => {
  const parent = statsWith({ messages: 2, inputTokens: 123 });
  const md = renderMarkdown({
    source: 'cursor',
    session: { id: 'cursor-sqlite:state.vscdb', cwd: '/proj' },
    parent,
    subagents: [],
    cursorEstimate: {
      dbPath: '/tmp/state.vscdb',
      rowsScanned: 10,
      matchedRows: 2,
      estimatedTextChars: 492,
      estimatedTokens: 123,
      warnings: ['estimate-only warning'],
    },
  });
  assert.ok(md.includes('Source: Cursor SQLite estimate'));
  assert.ok(md.includes('not billed-token data'));
  assert.ok(md.includes('| Estimated tokens | 123 |'));
});

test('aggregateCursorSqliteEstimate reports missing DB as estimate-only warning', () => {
  const agg = aggregateCursorSqliteEstimate({ id: 'cursor', cwd: '/proj', dbPath: '/no/such/state.vscdb', exists: false, mtimeMs: 0 });
  assert.equal(agg.source, 'cursor');
  assert.equal(agg.parent.inputTokens, 0);
  assert.ok(agg.cursorEstimate.warnings.some((w) => w.includes('estimate-only')));
  assert.ok(agg.cursorEstimate.warnings.some((w) => w.includes('not found')));
});

test('parseArgs reads flags + valued options', () => {
  const a = parseArgs(['--json', '--all', '--codex', '--session', 'abc', '--out', '/tmp/r.md']);
  assert.equal(a.json, true);
  assert.equal(a.all, true);
  assert.equal(a.source, 'codex');
  assert.equal(a.session, 'abc');
  assert.equal(a.out, '/tmp/r.md');
  assert.equal(parseArgs([]).source, 'auto');
  assert.equal(parseArgs(['--cursor']).source, 'cursor');
  assert.equal(parseArgs(['--source', 'cursor']).source, 'cursor');
});

test('selectTargetSessions: --all → all, default → first, --session → match', () => {
  const sessions = [{ id: 's1', jsonl: 'a.jsonl' }, { id: 's2', jsonl: 'b.jsonl' }];
  assert.equal(selectTargetSessions(sessions, parseArgs(['--all']), 'x').length, 2);
  assert.deepEqual(selectTargetSessions(sessions, parseArgs([]), 'x'), [sessions[0]]);
  assert.deepEqual(selectTargetSessions(sessions, parseArgs(['--session', 's2']), 'x'), [sessions[1]]);
  assert.deepEqual(selectTargetSessions([], parseArgs([]), 'x'), []);
});

test('discoverSubagents + walkCodexSessionFiles + readCodexSessionMeta on temp dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tokdisc-'));
  try {
    // subagents
    const sub = path.join(dir, 'sess', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'a1.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(sub, 'a1.meta.json'), JSON.stringify({ agentType: 'senior-frontend', description: 'build UI' }), 'utf8');
    const subs = discoverSubagents(path.join(dir, 'sess'));
    assert.equal(subs.length, 1);
    assert.equal(subs[0]?.agentType, 'senior-frontend');
    // codex session walk + meta
    const codexDir = path.join(dir, 'codex');
    fs.mkdirSync(path.join(codexDir, '2026', '01'), { recursive: true });
    const rollout = path.join(codexDir, '2026', '01', 'rollout-sess9.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: 'sess9', cwd: '/p' } })}\n`, 'utf8');
    assert.deepEqual(walkCodexSessionFiles(codexDir), [rollout]);
    assert.equal(readCodexSessionMeta(rollout)?.id, 'sess9');
    assert.equal(readCodexSessionMeta(rollout)?.cwd, '/p');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
