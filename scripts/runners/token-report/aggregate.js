"use strict";
// src/runners/token-report/aggregate.ts
// Aggregate a Claude session (parent + subagents) and dispatch by source type.
// Ported 1:1 from token-report/aggregateSession.cjs + aggregateBySource.
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateSession = aggregateSession;
exports.aggregateBySource = aggregateBySource;
const aggregateCodexSession_1 = require("./aggregateCodexSession");
const discovery_1 = require("./discovery");
const parseJsonlFile_1 = require("./parseJsonlFile");
function aggregateSession(session) {
    const parent = (0, parseJsonlFile_1.parseJsonlFile)(session.parentJsonl);
    const subagents = (0, discovery_1.discoverSubagents)(session.dir).map((s) => ({ ...s, stats: (0, parseJsonlFile_1.parseJsonlFile)(s.jsonl) }));
    return { source: 'claude', session, parent, subagents };
}
function aggregateBySource(session) {
    return session.sourceType === 'codex'
        ? (0, aggregateCodexSession_1.aggregateCodexSession)(session)
        : aggregateSession(session);
}
