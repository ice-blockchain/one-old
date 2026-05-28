// src/runners/token-report/aggregateCodexSession.ts
// Ported 1:1 from token-report/aggregateCodexSession.cjs.

import { parseCodexJsonlFile } from './parseCodexJsonlFile';

export function aggregateCodexSession(session: { jsonl: string; [k: string]: unknown }): {
  source: 'codex';
  session: Record<string, unknown>;
  parent: ReturnType<typeof parseCodexJsonlFile>['stats'];
  subagents: never[];
  trafficOne: ReturnType<typeof parseCodexJsonlFile>['trafficOne'];
} {
  const parsed = parseCodexJsonlFile(session.jsonl);
  return {
    source: 'codex',
    session: { ...session, ...parsed.session },
    parent: parsed.stats,
    subagents: [],
    trafficOne: parsed.trafficOne,
  };
}
