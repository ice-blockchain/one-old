// src/runners/token-report/aggregate.ts
// Aggregate a Claude session (parent + subagents) and dispatch by source type.
// Ported 1:1 from token-report/aggregateSession.cjs + aggregateBySource.

import { aggregateCodexSession } from './aggregateCodexSession';
import { aggregateCursorSqliteEstimate } from './aggregateCursorSqliteEstimate';
import { discoverSubagents } from './discovery';
import { parseJsonlFile } from './parseJsonlFile';
import type { Stats } from './lib';

type Rec = Record<string, unknown>;

export interface ClaudeAggregate {
  source: 'claude';
  session: Rec;
  parent: Stats;
  subagents: Array<{ id: string; jsonl: string; agentType: string; description: string; stats: Stats }>;
}

export function aggregateSession(session: { parentJsonl: string; dir: string; [k: string]: unknown }): ClaudeAggregate {
  const parent = parseJsonlFile(session.parentJsonl);
  const subagents = discoverSubagents(session.dir).map((s) => ({ ...s, stats: parseJsonlFile(s.jsonl) }));
  return { source: 'claude', session, parent, subagents };
}

export function aggregateBySource(session: Rec): ClaudeAggregate | ReturnType<typeof aggregateCodexSession> | ReturnType<typeof aggregateCursorSqliteEstimate> {
  if (session.sourceType === 'cursor') return aggregateCursorSqliteEstimate(session as unknown as Parameters<typeof aggregateCursorSqliteEstimate>[0]);
  return session.sourceType === 'codex'
    ? aggregateCodexSession(session as { jsonl: string })
    : aggregateSession(session as { parentJsonl: string; dir: string });
}
