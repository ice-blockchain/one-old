// src/runners/token-report/parseCodexJsonlFile.ts
// Parse a Codex Desktop rollout JSONL into session meta + cumulative stats +
// Traffic One attribution estimate. Ported 1:1 from
// token-report/parseCodexJsonlFile.cjs.

import { obj, type Rec } from '../../shared/obj';
import * as fs from 'fs';

import { emptyStats } from './emptyStats';
import { emptyTrafficOneEstimate, type TrafficOneEstimate } from './emptyTrafficOneEstimate';
import {
  addCodexLargestUsage,
  addTrafficOneOutputEstimate,
  applyCodexCumulativeUsage,
  codexSessionIdFromFile,
  estimateTrafficOneInstructionTokens,
  type Stats,
} from './lib';

interface CodexSession {
  id: string;
  jsonl: string;
  cwd: string | null;
  startedAt: string | null;
  originator: string;
  source: string | null;
  modelProvider: string | null;
  model: string;
}
interface CodexParse { session: CodexSession; stats: Stats; trafficOne: TrafficOneEstimate }

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseCodexJsonlFile(filePath: string): CodexParse {
  const stats = emptyStats();
  const trafficOne = emptyTrafficOneEstimate();
  let session: CodexSession = {
    id: codexSessionIdFromFile(filePath), jsonl: filePath, cwd: null, startedAt: null,
    originator: 'Codex Desktop', source: null, modelProvider: null, model: 'codex',
  };
  let cumulativeUsage: unknown = null;

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { session, stats, trafficOne };
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: Rec | null;
    try { parsed = obj(JSON.parse(line)); } catch { continue; }
    if (!parsed) continue;
    const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
    if (ts) {
      if (!stats.firstAt || ts < stats.firstAt) stats.firstAt = ts;
      if (!stats.lastAt || ts > stats.lastAt) stats.lastAt = ts;
    }

    if (parsed.type === 'session_meta') {
      const payload = obj(parsed.payload) || {};
      session = {
        ...session,
        id: str(payload.id) ?? session.id,
        startedAt: str(payload.timestamp) ?? ts ?? session.startedAt,
        cwd: str(payload.cwd) ?? session.cwd,
        originator: str(payload.originator) ?? session.originator,
        source: str(payload.source) ?? session.source,
        modelProvider: str(payload.model_provider) ?? session.modelProvider,
        model: str(payload.model) ?? session.model,
      };
      trafficOne.instructionApproxTokens += estimateTrafficOneInstructionTokens(obj(payload.base_instructions)?.text);
      trafficOne.instructionApproxTokens += estimateTrafficOneInstructionTokens(obj(payload.instructions)?.text);
      trafficOne.instructionApproxTokens += estimateTrafficOneInstructionTokens(obj(payload.user_instructions)?.text);
      continue;
    }

    if (parsed.type === 'response_item') {
      const payload = obj(parsed.payload) || {};
      if (payload.type === 'function_call') {
        const name = str(payload.name) || str(payload.tool_name) || str(payload.call_name) || 'function_call';
        stats.byTool[name] = (stats.byTool[name] || 0) + 1;
        stats.toolUses += 1;
      } else if (payload.type === 'function_call_output') {
        addTrafficOneOutputEstimate(trafficOne, payload.output);
      }
      continue;
    }

    if (parsed.type === 'event_msg') {
      const payload = obj(parsed.payload) || {};
      if (payload.type !== 'token_count') continue;
      const info = obj(payload.info) || {};
      stats.messages += 1;
      if (typeof info.model_context_window === 'number' && Number.isFinite(info.model_context_window)) {
        stats.modelContextWindow = info.model_context_window;
      }
      if (info.last_token_usage) addCodexLargestUsage(stats, info.last_token_usage, ts);
      if (info.total_token_usage) cumulativeUsage = info.total_token_usage;
    }
  }

  applyCodexCumulativeUsage(stats, cumulativeUsage, session.model);
  return { session, stats, trafficOne };
}
