"use strict";
// src/runners/token-report/aggregateCodexSession.ts
// Ported 1:1 from token-report/aggregateCodexSession.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateCodexSession = aggregateCodexSession;
const parseCodexJsonlFile_1 = require("./parseCodexJsonlFile");
function aggregateCodexSession(session) {
    const parsed = (0, parseCodexJsonlFile_1.parseCodexJsonlFile)(session.jsonl);
    return {
        source: 'codex',
        session: { ...session, ...parsed.session },
        parent: parsed.stats,
        subagents: [],
        trafficOne: parsed.trafficOne,
    };
}
