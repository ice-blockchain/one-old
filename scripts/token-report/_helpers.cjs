'use strict';

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

function looksTrafficOneRelated(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /\btraffic-one\b|Traffic One|\.traffic-one|AGENTS\.md|CLAUDE\.md|hook-runtime|skills-templates|rules\/common|rules\/frontend|token-report\.cjs/.test(text);
}

function addTrafficOneOutputEstimate(estimate, output) {
  const { parseOriginalTokenCount } = require('./parseOriginalTokenCount.cjs');
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

function findClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

function fmtCost(usd) {
  return `$${usd.toFixed(4)}`;
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

function renderCodexMarkdown(agg) {
  const { totalTokens } = require('./totalTokens.cjs');
  const { cacheHitRate } = require('./cacheHitRate.cjs');
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
  const { aggregateCodexSession } = require('./aggregateCodexSession.cjs');
  const { aggregateSession } = require('./aggregateSession.cjs');
  return session.sourceType === 'codex'
    ? aggregateCodexSession(session)
    : aggregateSession(session);
}

module.exports = {
  PRICING,
  addToStats,
  numberValue,
  codexUsageFields,
  addCodexLargestUsage,
  applyCodexCumulativeUsage,
  looksTrafficOneRelated,
  addTrafficOneOutputEstimate,
  estimateTrafficOneInstructionTokens,
  codexSessionIdFromFile,
  readFirstLine,
  pathsRelated,
  findCodexSessionsDir,
  walkCodexSessionFiles,
  findClaudeProjectsDir,
  fmtNum,
  fmtCost,
  fmtDuration,
  renderCodexMarkdown,
  sumIntoStats,
  mergeByModel,
  minIso,
  maxIso,
  parseArgs,
  selectTargetSessions,
  aggregateBySource,
};
