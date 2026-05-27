'use strict';

const fs = require('fs');
const { emptyStats } = require('./emptyStats.cjs');
const { emptyTrafficOneEstimate } = require('./emptyTrafficOneEstimate.cjs');
const {
  codexSessionIdFromFile,
  estimateTrafficOneInstructionTokens,
  addTrafficOneOutputEstimate,
  addCodexLargestUsage,
  applyCodexCumulativeUsage,
} = require('./_helpers.cjs');

function parseCodexJsonlFile(filePath) {
  const stats = emptyStats();
  const trafficOne = emptyTrafficOneEstimate();
  let session = {
    id: codexSessionIdFromFile(filePath),
    jsonl: filePath,
    cwd: null,
    startedAt: null,
    originator: 'Codex Desktop',
    source: null,
    modelProvider: null,
    model: 'codex',
  };
  let cumulativeUsage = null;

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { session, stats, trafficOne };
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const ts = parsed.timestamp || null;
    if (ts) {
      if (!stats.firstAt || ts < stats.firstAt) stats.firstAt = ts;
      if (!stats.lastAt || ts > stats.lastAt) stats.lastAt = ts;
    }

    if (parsed.type === 'session_meta') {
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      session = {
        ...session,
        id: typeof payload.id === 'string' ? payload.id : session.id,
        startedAt: payload.timestamp || ts || session.startedAt,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : session.cwd,
        originator: typeof payload.originator === 'string' ? payload.originator : session.originator,
        source: typeof payload.source === 'string' ? payload.source : session.source,
        modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : session.modelProvider,
        model: typeof payload.model === 'string' ? payload.model : session.model,
      };
      trafficOne.instructionApproxTokens += estimateTrafficOneInstructionTokens(payload.base_instructions && payload.base_instructions.text);
      trafficOne.instructionApproxTokens += estimateTrafficOneInstructionTokens(payload.instructions && payload.instructions.text);
      trafficOne.instructionApproxTokens += estimateTrafficOneInstructionTokens(payload.user_instructions && payload.user_instructions.text);
      continue;
    }

    if (parsed.type === 'response_item') {
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      if (payload.type === 'function_call') {
        const name = payload.name || payload.tool_name || payload.call_name || 'function_call';
        stats.byTool[name] = (stats.byTool[name] || 0) + 1;
        stats.toolUses += 1;
      } else if (payload.type === 'function_call_output') {
        addTrafficOneOutputEstimate(trafficOne, payload.output);
      }
      continue;
    }

    if (parsed.type === 'event_msg') {
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      if (payload.type !== 'token_count') continue;
      const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
      stats.messages += 1;
      if (Number.isFinite(info.model_context_window)) {
        stats.modelContextWindow = info.model_context_window;
      }
      if (info.last_token_usage) {
        addCodexLargestUsage(stats, info.last_token_usage, ts);
      }
      if (info.total_token_usage) {
        cumulativeUsage = info.total_token_usage;
      }
    }
  }

  applyCodexCumulativeUsage(stats, cumulativeUsage, session.model);
  return { session, stats, trafficOne };
}

module.exports = { parseCodexJsonlFile };
