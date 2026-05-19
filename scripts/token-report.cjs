#!/usr/bin/env node
'use strict';

// scripts/token-report.cjs
// Exact token-usage report for Claude Code sessions, parsed from the on-disk
// transcripts under ~/.claude/projects/<slug>/. Source of truth = the `usage`
// object on every assistant message (input_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, output_tokens).
//
// Codex Desktop sessions are supported too via ~/.codex/sessions/**. Source of
// truth = the `event_msg` token_count payloads
// (total_token_usage/last_token_usage).
//
// Aggregates by phase:
//   - Main agent (parent transcript)
//   - Each subagent (one .jsonl + .meta.json per spawn under subagents/)
//     attributed by `agentType` from the .meta.json (e.g. traffic-one:senior-frontend)
//
// Also breaks down by tool name (Bash / Write / Read / Edit / Task / ...) and
// surfaces cache hit rate so users can see if prompt caching is working.
//
// Usage:
//   node scripts/token-report.cjs              # auto-detect cwd → latest session
//   node scripts/token-report.cjs --session <id>
//   node scripts/token-report.cjs --project <slug>
//   node scripts/token-report.cjs --json       # JSON output instead of markdown
//   node scripts/token-report.cjs --out <path> # write to file
//   node scripts/token-report.cjs --all        # all sessions for the project
//
// Exits 0 always (informational); prints "no transcripts found" if none.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Anthropic public pricing (per 1M tokens). Used only to give an order-of-
// magnitude cost estimate; users are reminded actual billing comes from the
// Anthropic console.
const PRICING = {
  'claude-opus-4-7':       { input: 15, cacheWrite: 18.75, cacheRead: 1.5,  output: 75 },
  'claude-opus-4-6':       { input: 15, cacheWrite: 18.75, cacheRead: 1.5,  output: 75 },
  'claude-sonnet-4-6':     { input: 3,  cacheWrite: 3.75,  cacheRead: 0.3,  output: 15 },
  'claude-sonnet-4-5':     { input: 3,  cacheWrite: 3.75,  cacheRead: 0.3,  output: 15 },
  'claude-haiku-4-5':      { input: 1,  cacheWrite: 1.25,  cacheRead: 0.1,  output: 5  },
  // Fallback when model is unrecognized — assume sonnet-class pricing.
  _default:                { input: 3,  cacheWrite: 3.75,  cacheRead: 0.3,  output: 15 },
};

function priceFor(model) {
  if (!model || typeof model !== 'string') return PRICING._default;
  // Match longest prefix first.
  const matches = Object.keys(PRICING).filter((k) => k !== '_default' && model.startsWith(k));
  if (matches.length === 0) return PRICING._default;
  matches.sort((a, b) => b.length - a.length);
  return PRICING[matches[0]];
}

function estimateCost(stats) {
  let total = 0;
  for (const [model, m] of Object.entries(stats.byModel || {})) {
    const p = priceFor(model);
    total += (m.inputTokens / 1_000_000) * p.input;
    total += (m.cacheCreationInputTokens / 1_000_000) * p.cacheWrite;
    total += (m.cacheReadInputTokens / 1_000_000) * p.cacheRead;
    total += (m.outputTokens / 1_000_000) * p.output;
  }
  return total;
}

function emptyStats() {
  return {
    messages: 0,
    toolUses: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    firstAt: null,
    lastAt: null,
    byTool: {},        // toolName -> count
    byModel: {},       // model -> { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, messages }
    largestMessage: null, // { tokens, timestamp, role }
    modelContextWindow: null,
  };
}

function emptyTrafficOneEstimate() {
  return {
    directToolOutputTokens: 0,
    directToolOutputs: 0,
    instructionApproxTokens: 0,
  };
}

function addToStats(stats, msg) {
  const usage = msg && msg.message && msg.message.usage;
  if (!usage || typeof usage !== 'object') return;
  stats.messages += 1;
  const ts = msg.timestamp || null;
  if (ts) {
    if (!stats.firstAt || ts < stats.firstAt) stats.firstAt = ts;
    if (!stats.lastAt  || ts > stats.lastAt)  stats.lastAt  = ts;
  }
  const ip   = usage.input_tokens                || 0;
  const ccr  = usage.cache_creation_input_tokens || 0;
  const cr   = usage.cache_read_input_tokens     || 0;
  const op   = usage.output_tokens               || 0;
  stats.inputTokens             += ip;
  stats.cacheCreationInputTokens += ccr;
  stats.cacheReadInputTokens     += cr;
  stats.outputTokens             += op;
  const totalThisMsg = ip + ccr + cr + op;
  if (!stats.largestMessage || totalThisMsg > stats.largestMessage.tokens) {
    stats.largestMessage = {
      tokens: totalThisMsg,
      timestamp: ts,
      role: msg.message && msg.message.role,
    };
  }
  const model = msg.message && msg.message.model;
  if (model) {
    if (!stats.byModel[model]) {
      stats.byModel[model] = {
        messages: 0,
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      };
    }
    const m = stats.byModel[model];
    m.messages += 1;
    m.inputTokens             += ip;
    m.cacheCreationInputTokens += ccr;
    m.cacheReadInputTokens     += cr;
    m.outputTokens             += op;
  }
  const content = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
  for (const block of content) {
    if (block && block.type === 'tool_use' && block.name) {
      stats.byTool[block.name] = (stats.byTool[block.name] || 0) + 1;
      stats.toolUses += 1;
    }
  }
}

function parseJsonlFile(filePath) {
  const stats = emptyStats();
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return stats;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || parsed.type !== 'assistant') continue;
    addToStats(stats, parsed);
  }
  return stats;
}

function numberValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function codexUsageFields(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      reportedTotalTokens: 0,
    };
  }
  const totalInput = numberValue(usage.input_tokens);
  const cachedInput = Math.min(numberValue(usage.cached_input_tokens), totalInput);
  const outputTokens = numberValue(usage.output_tokens);
  return {
    inputTokens: Math.max(0, totalInput - cachedInput),
    cacheCreationInputTokens: numberValue(usage.cache_creation_input_tokens),
    cacheReadInputTokens: cachedInput,
    outputTokens,
    reasoningOutputTokens: numberValue(usage.reasoning_output_tokens),
    reportedTotalTokens: numberValue(usage.total_tokens) || totalInput + outputTokens,
  };
}

function addCodexLargestUsage(stats, usage, timestamp) {
  const fields = codexUsageFields(usage);
  const totalThisCall = fields.inputTokens
    + fields.cacheCreationInputTokens
    + fields.cacheReadInputTokens
    + fields.outputTokens;
  if (!stats.largestMessage || totalThisCall > stats.largestMessage.tokens) {
    stats.largestMessage = {
      tokens: totalThisCall,
      timestamp,
      role: 'codex-api-call',
    };
  }
}

function applyCodexCumulativeUsage(stats, usage, model) {
  const fields = codexUsageFields(usage);
  stats.inputTokens = fields.inputTokens;
  stats.cacheCreationInputTokens = fields.cacheCreationInputTokens;
  stats.cacheReadInputTokens = fields.cacheReadInputTokens;
  stats.outputTokens = fields.outputTokens;
  stats.reasoningOutputTokens = fields.reasoningOutputTokens;

  const modelName = model || 'codex';
  stats.byModel = {
    [modelName]: {
      messages: stats.messages,
      inputTokens: fields.inputTokens,
      cacheCreationInputTokens: fields.cacheCreationInputTokens,
      cacheReadInputTokens: fields.cacheReadInputTokens,
      outputTokens: fields.outputTokens,
    },
  };
}

function parseOriginalTokenCount(output) {
  if (typeof output !== 'string') return 0;
  const match = /Original token count:\s*([0-9][0-9,]*)/.exec(output);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, '')) || 0;
}

function looksTrafficOneRelated(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /\btraffic-one\b|Traffic One|\.traffic-one|AGENTS\.md|CLAUDE\.md|hook-runtime|skills-templates|rules\/common|rules\/frontend|token-report\.cjs/.test(text);
}

function addTrafficOneOutputEstimate(estimate, output) {
  if (!looksTrafficOneRelated(output)) return;
  const tokens = parseOriginalTokenCount(output);
  if (tokens <= 0) return;
  estimate.directToolOutputTokens += tokens;
  estimate.directToolOutputs += 1;
}

function estimateTrafficOneInstructionTokens(text) {
  if (!looksTrafficOneRelated(text)) return 0;
  const blocks = String(text).split(/\n{2,}/);
  let chars = 0;
  for (const block of blocks) {
    if (looksTrafficOneRelated(block)) chars += Buffer.byteLength(block, 'utf8');
  }
  return Math.ceil(chars / 4);
}

function codexSessionIdFromFile(filePath) {
  return path.basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}

function readFirstLine(filePath, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks = [];
    let offset = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (offset < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk);
      offset += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readCodexSessionMeta(filePath) {
  const line = readFirstLine(filePath).trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || parsed.type !== 'session_meta') return null;
    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
    return {
      id: typeof payload.id === 'string' ? payload.id : codexSessionIdFromFile(filePath),
      startedAt: payload.timestamp || parsed.timestamp || null,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      originator: typeof payload.originator === 'string' ? payload.originator : 'Codex Desktop',
      source: typeof payload.source === 'string' ? payload.source : null,
      modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : null,
      model: typeof payload.model === 'string' ? payload.model : 'codex',
    };
  } catch {
    return null;
  }
}

function pathsRelated(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function findCodexSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function walkCodexSessionFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCodexSessionFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(fullPath);
    }
  }
  return out;
}

function findCodexSessionsForCwd(cwd, sessionsDir = findCodexSessionsDir()) {
  const sessions = [];
  for (const filePath of walkCodexSessionFiles(sessionsDir)) {
    const meta = readCodexSessionMeta(filePath);
    if (!meta || !pathsRelated(cwd, meta.cwd)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { mtime = 0; }
    sessions.push({
      id: meta.id,
      jsonl: filePath,
      mtimeMs: mtime,
      ...meta,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

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

function projectSlugFromCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

function findClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function findSessionsForProject(projectSlug) {
  const projectsDir = findClaudeProjectsDir();
  const projectDir = path.join(projectsDir, projectSlug);
  if (!fs.existsSync(projectDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const id = e.name;
    const parentJsonl = path.join(projectDir, `${id}.jsonl`);
    if (!fs.existsSync(parentJsonl)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(parentJsonl).mtimeMs; } catch { mtime = 0; }
    sessions.push({ id, dir: path.join(projectDir, id), parentJsonl, mtimeMs: mtime });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  return sessions;
}

function discoverSubagents(sessionDir) {
  const subagentsDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const id = e.name.replace(/\.jsonl$/, '');
    const metaPath = path.join(subagentsDir, `${id}.meta.json`);
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = {}; }
    }
    out.push({
      id,
      jsonl: path.join(subagentsDir, e.name),
      agentType: typeof meta.agentType === 'string' ? meta.agentType : 'unknown',
      description: typeof meta.description === 'string' ? meta.description : '',
    });
  }
  return out;
}

function aggregateSession(session) {
  const parent = parseJsonlFile(session.parentJsonl);
  const subagents = discoverSubagents(session.dir).map((s) => ({
    ...s,
    stats: parseJsonlFile(s.jsonl),
  }));
  return { source: 'claude', session, parent, subagents };
}

function aggregateCodexSession(session) {
  const parsed = parseCodexJsonlFile(session.jsonl);
  return {
    source: 'codex',
    session: { ...session, ...parsed.session },
    parent: parsed.stats,
    subagents: [],
    trafficOne: parsed.trafficOne,
  };
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

function fmtCost(usd) {
  return `$${usd.toFixed(4)}`;
}

function totalTokens(stats) {
  return stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens + stats.outputTokens;
}

function cacheHitRate(stats) {
  const cacheReads = stats.cacheReadInputTokens;
  const totalInput = stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens;
  if (totalInput === 0) return 0;
  return (cacheReads / totalInput) * 100;
}

function fmtDuration(firstAt, lastAt) {
  if (!firstAt || !lastAt) return '—';
  const ms = Date.parse(lastAt) - Date.parse(firstAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function renderMarkdown(agg) {
  if (agg && agg.source === 'codex') return renderCodexMarkdown(agg);

  const lines = [];
  const { session, parent, subagents } = agg;
  const allStats = [parent, ...subagents.map((s) => s.stats)];
  const total = allStats.reduce(
    (acc, s) => ({
      messages: acc.messages + s.messages,
      toolUses: acc.toolUses + s.toolUses,
      inputTokens: acc.inputTokens + s.inputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens + s.cacheCreationInputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens + s.cacheReadInputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + (s.reasoningOutputTokens || 0),
      byModel: mergeByModel(acc.byModel, s.byModel),
      firstAt: minIso(acc.firstAt, s.firstAt),
      lastAt:  maxIso(acc.lastAt, s.lastAt),
    }),
    {
      messages: 0, toolUses: 0,
      inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
      byModel: {}, firstAt: null, lastAt: null,
    },
  );
  const totalCost = estimateCost(total);

  lines.push(`# Token usage report`);
  lines.push('');
  lines.push(`- Session: \`${session.id}\``);
  lines.push(`- Duration: ${fmtDuration(total.firstAt, total.lastAt)}`);
  if (total.firstAt) lines.push(`- Started: ${total.firstAt}`);
  if (total.lastAt)  lines.push(`- Ended:   ${total.lastAt}`);
  lines.push('');

  lines.push('## Totals');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tokens | ${fmtNum(totalTokens(total))} |`);
  lines.push(`| Input (fresh) | ${fmtNum(total.inputTokens)} |`);
  lines.push(`| Cache write | ${fmtNum(total.cacheCreationInputTokens)} |`);
  lines.push(`| Cache read (cheap) | ${fmtNum(total.cacheReadInputTokens)} |`);
  lines.push(`| Output | ${fmtNum(total.outputTokens)} |`);
  lines.push(`| Cache hit rate | ${cacheHitRate(total).toFixed(1)}% |`);
  lines.push(`| Messages | ${fmtNum(total.messages)} |`);
  lines.push(`| Tool uses | ${fmtNum(total.toolUses)} |`);
  lines.push(`| Estimated cost | ${fmtCost(totalCost)} (rough — actual billing in Anthropic console) |`);
  lines.push('');

  lines.push('## By phase / role');
  lines.push('');
  lines.push(`| Phase / role | Msgs | Tools | Total tokens | Output | Cache hit | Est. cost |`);
  lines.push(`|--------------|------|-------|--------------|--------|-----------|-----------|`);
  lines.push(`| Main agent (parent) | ${fmtNum(parent.messages)} | ${fmtNum(parent.toolUses)} | ${fmtNum(totalTokens(parent))} | ${fmtNum(parent.outputTokens)} | ${cacheHitRate(parent).toFixed(1)}% | ${fmtCost(estimateCost(parent))} |`);
  for (const sub of subagents) {
    const s = sub.stats;
    const label = `${sub.agentType}${sub.description ? ` — "${sub.description.slice(0, 50)}${sub.description.length > 50 ? '…' : ''}"` : ''}`;
    lines.push(`| ${label} | ${fmtNum(s.messages)} | ${fmtNum(s.toolUses)} | ${fmtNum(totalTokens(s))} | ${fmtNum(s.outputTokens)} | ${cacheHitRate(s).toFixed(1)}% | ${fmtCost(estimateCost(s))} |`);
  }
  lines.push('');

  // Subagent role aggregation (multiple spawns of same agentType collapsed)
  const byRole = {};
  for (const sub of subagents) {
    if (!byRole[sub.agentType]) byRole[sub.agentType] = { spawns: 0, stats: emptyStats() };
    byRole[sub.agentType].spawns += 1;
    sumIntoStats(byRole[sub.agentType].stats, sub.stats);
  }
  if (Object.keys(byRole).length > 0) {
    lines.push('## By role (aggregated)');
    lines.push('');
    lines.push(`| Role | Spawns | Msgs | Tools | Total tokens | Avg tokens/spawn |`);
    lines.push(`|------|--------|------|-------|--------------|------------------|`);
    const sortedRoles = Object.entries(byRole).sort((a, b) => totalTokens(b[1].stats) - totalTokens(a[1].stats));
    for (const [role, info] of sortedRoles) {
      const t = totalTokens(info.stats);
      lines.push(`| ${role} | ${info.spawns} | ${fmtNum(info.stats.messages)} | ${fmtNum(info.stats.toolUses)} | ${fmtNum(t)} | ${fmtNum(Math.round(t / info.spawns))} |`);
    }
    lines.push('');
  }

  // Tool breakdown across everything
  const toolTotals = {};
  for (const s of allStats) {
    for (const [tool, count] of Object.entries(s.byTool)) {
      toolTotals[tool] = (toolTotals[tool] || 0) + count;
    }
  }
  const sortedTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]);
  if (sortedTools.length > 0) {
    lines.push('## Tool calls (across all phases)');
    lines.push('');
    lines.push(`| Tool | Calls |`);
    lines.push(`|------|-------|`);
    for (const [tool, count] of sortedTools) {
      lines.push(`| ${tool} | ${fmtNum(count)} |`);
    }
    lines.push('');
  }

  // Model usage
  if (Object.keys(total.byModel).length > 0) {
    lines.push('## By model');
    lines.push('');
    lines.push(`| Model | Msgs | Total tokens | Output | Est. cost |`);
    lines.push(`|-------|------|--------------|--------|-----------|`);
    const sortedModels = Object.entries(total.byModel).sort((a, b) => b[1].outputTokens - a[1].outputTokens);
    for (const [model, m] of sortedModels) {
      const t = m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens + m.outputTokens;
      const p = priceFor(model);
      const cost = (m.inputTokens / 1e6) * p.input
        + (m.cacheCreationInputTokens / 1e6) * p.cacheWrite
        + (m.cacheReadInputTokens / 1e6) * p.cacheRead
        + (m.outputTokens / 1e6) * p.output;
      lines.push(`| ${model} | ${fmtNum(m.messages)} | ${fmtNum(t)} | ${fmtNum(m.outputTokens)} | ${fmtCost(cost)} |`);
    }
    lines.push('');
  }

  // Notes
  lines.push('## Notes');
  lines.push('');
  if (total.largestMessage && parent.largestMessage) {
    lines.push(`- Largest single message: ${fmtNum(parent.largestMessage.tokens)} tokens at ${parent.largestMessage.timestamp || '—'}`);
  }
  lines.push(`- Subagent spawns: ${subagents.length}`);
  lines.push(`- Source: transcripts under \`~/.claude/projects/<slug>/${session.id}/\``);
  lines.push(`- Cost is a rough estimate based on public list pricing; actual billing comes from the Anthropic console.`);
  return lines.join('\n') + '\n';
}

function renderCodexMarkdown(agg) {
  const lines = [];
  const { session, parent: total, trafficOne } = agg;

  lines.push(`# Token usage report`);
  lines.push('');
  lines.push(`- Source: Codex Desktop`);
  lines.push(`- Session: \`${session.id}\``);
  if (session.cwd) lines.push(`- Cwd: \`${session.cwd}\``);
  lines.push(`- Duration: ${fmtDuration(total.firstAt, total.lastAt)}`);
  if (total.firstAt) lines.push(`- Started: ${total.firstAt}`);
  if (total.lastAt) lines.push(`- Ended:   ${total.lastAt}`);
  lines.push('');

  lines.push('## Totals');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tokens | ${fmtNum(totalTokens(total))} |`);
  lines.push(`| Input (fresh) | ${fmtNum(total.inputTokens)} |`);
  lines.push(`| Cache write | ${fmtNum(total.cacheCreationInputTokens)} |`);
  lines.push(`| Cache read (reported) | ${fmtNum(total.cacheReadInputTokens)} |`);
  lines.push(`| Output | ${fmtNum(total.outputTokens)} |`);
  if (total.reasoningOutputTokens > 0) {
    lines.push(`| Reasoning output | ${fmtNum(total.reasoningOutputTokens)} |`);
  }
  lines.push(`| Cache hit rate | ${cacheHitRate(total).toFixed(1)}% |`);
  lines.push(`| API calls | ${fmtNum(total.messages)} |`);
  lines.push(`| Tool calls | ${fmtNum(total.toolUses)} |`);
  if (total.modelContextWindow) {
    lines.push(`| Model context window | ${fmtNum(total.modelContextWindow)} |`);
  }
  lines.push('');

  const sortedTools = Object.entries(total.byTool || {}).sort((a, b) => b[1] - a[1]);
  if (sortedTools.length > 0) {
    lines.push('## Tool calls');
    lines.push('');
    lines.push(`| Tool | Calls |`);
    lines.push(`|------|-------|`);
    for (const [tool, count] of sortedTools) {
      lines.push(`| ${tool} | ${fmtNum(count)} |`);
    }
    lines.push('');
  }

  if (trafficOne && (
    trafficOne.directToolOutputTokens > 0
    || trafficOne.instructionApproxTokens > 0
  )) {
    lines.push('## Traffic One estimate');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Direct Traffic One tool-output tokens | ${fmtNum(trafficOne.directToolOutputTokens)} |`);
    lines.push(`| Matching tool outputs | ${fmtNum(trafficOne.directToolOutputs)} |`);
    lines.push(`| Traffic One instruction approx. | ${fmtNum(trafficOne.instructionApproxTokens)} |`);
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  if (total.largestMessage) {
    lines.push(`- Largest single API call: ${fmtNum(total.largestMessage.tokens)} tokens at ${total.largestMessage.timestamp || '—'}`);
  }
  lines.push(`- Source: transcripts under \`~/.codex/sessions/**\``);
  lines.push(`- Codex reports cached input as a subset of input; this report shows fresh input as input minus cached input.`);
  lines.push(`- Traffic One attribution is best-effort: direct tool-output tokens come from transcript "Original token count" lines whose output references Traffic One files or rules.`);
  return lines.join('\n') + '\n';
}

function sumIntoStats(target, source) {
  target.messages += source.messages;
  target.toolUses += source.toolUses;
  target.inputTokens += source.inputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens || 0;
  for (const [tool, count] of Object.entries(source.byTool || {})) {
    target.byTool[tool] = (target.byTool[tool] || 0) + count;
  }
  for (const [model, m] of Object.entries(source.byModel || {})) {
    if (!target.byModel[model]) {
      target.byModel[model] = { messages: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
    }
    target.byModel[model].messages += m.messages;
    target.byModel[model].inputTokens += m.inputTokens;
    target.byModel[model].cacheCreationInputTokens += m.cacheCreationInputTokens;
    target.byModel[model].cacheReadInputTokens += m.cacheReadInputTokens;
    target.byModel[model].outputTokens += m.outputTokens;
  }
  target.firstAt = minIso(target.firstAt, source.firstAt);
  target.lastAt = maxIso(target.lastAt, source.lastAt);
}

function mergeByModel(left, right) {
  const out = { ...left };
  for (const [model, m] of Object.entries(right || {})) {
    if (!out[model]) {
      out[model] = { messages: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
    }
    out[model].messages += m.messages;
    out[model].inputTokens += m.inputTokens;
    out[model].cacheCreationInputTokens += m.cacheCreationInputTokens;
    out[model].cacheReadInputTokens += m.cacheReadInputTokens;
    out[model].outputTokens += m.outputTokens;
  }
  return out;
}

function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function parseArgs(argv) {
  const out = { json: false, all: false, source: 'auto' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--codex') out.source = 'codex';
    else if (arg === '--claude') out.source = 'claude';
    else if (arg === '--source') { out.source = argv[i + 1] || 'auto'; i += 1; }
    else if (arg === '--session') { out.session = argv[i + 1]; i += 1; }
    else if (arg === '--project') { out.project = argv[i + 1]; i += 1; }
    else if (arg === '--out')     { out.out = argv[i + 1]; i += 1; }
    else if (arg === '--cwd')     { out.cwd = argv[i + 1]; i += 1; }
  }
  return out;
}

function selectTargetSessions(sessions, args, label) {
  if (args.session) {
    const match = sessions.find((s) => (
      s.id === args.session
      || path.basename(s.jsonl || s.parentJsonl || '') === args.session
    ));
    if (!match) {
      const list = sessions.slice(0, 5).map((s) => `  - ${s.id}`).join('\n');
      process.stderr.write(`Session ${args.session} not found in ${label}. Recent sessions:\n${list}\n`);
      process.exit(1);
    }
    return [match];
  }
  if (args.all) return sessions;
  return [sessions[0]];
}

function aggregateBySource(session) {
  return session.sourceType === 'codex'
    ? aggregateCodexSession(session)
    : aggregateSession(session);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  const projectSlug = args.project || projectSlugFromCwd(cwd);
  const source = ['auto', 'claude', 'codex'].includes(args.source) ? args.source : 'auto';
  let reports = [];

  if (source === 'auto') {
    const mixedSessions = [
      ...findSessionsForProject(projectSlug).map((session) => ({ ...session, sourceType: 'claude' })),
      ...findCodexSessionsForCwd(cwd).map((session) => ({ ...session, sourceType: 'codex' })),
    ].sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (mixedSessions.length > 0) {
      reports = selectTargetSessions(mixedSessions, args, 'Claude Code or Codex Desktop transcripts').map(aggregateBySource);
    }
  } else if (source === 'claude') {
    const claudeSessions = findSessionsForProject(projectSlug);
    if (claudeSessions.length > 0) {
      reports = selectTargetSessions(claudeSessions, args, 'Claude Code transcripts').map(aggregateSession);
    }
  } else if (source === 'codex') {
    const codexSessions = findCodexSessionsForCwd(cwd);
    if (codexSessions.length > 0) {
      reports = selectTargetSessions(codexSessions, args, 'Codex Desktop transcripts').map(aggregateCodexSession);
    }
  }

  if (reports.length === 0) {
    const looked = source === 'codex'
      ? `Looked in: ${findCodexSessionsDir()}`
      : source === 'claude'
        ? `Looked in: ${path.join(findClaudeProjectsDir(), projectSlug)}`
        : `Looked in: ${path.join(findClaudeProjectsDir(), projectSlug)} and ${findCodexSessionsDir()}`;
    const label = source === 'auto' ? 'Claude Code or Codex Desktop' : source;
    const message = `No ${label} transcripts found for cwd: ${cwd}\n${looked}`;
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stdout.write(`${message}\n`);
    }
    return;
  }

  let body;
  if (args.json) {
    body = `${JSON.stringify(reports, null, 2)}\n`;
  } else {
    body = reports.map(renderMarkdown).join('\n---\n\n');
  }

  if (args.out) {
    try {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, body, 'utf8');
      process.stderr.write(`Report written to: ${args.out}\n`);
    } catch (err) {
      process.stderr.write(`Failed to write to ${args.out}: ${err.message}\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write(body);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseJsonlFile,
  parseCodexJsonlFile,
  aggregateSession,
  aggregateCodexSession,
  projectSlugFromCwd,
  findSessionsForProject,
  findCodexSessionsForCwd,
  readCodexSessionMeta,
  discoverSubagents,
  emptyStats,
  emptyTrafficOneEstimate,
  totalTokens,
  cacheHitRate,
  estimateCost,
  priceFor,
  parseOriginalTokenCount,
  renderMarkdown,
};
