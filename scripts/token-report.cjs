#!/usr/bin/env node
'use strict';

// scripts/token-report.cjs
// Exact token-usage report for the current Claude Code session, parsed from
// the on-disk transcripts under ~/.claude/projects/<slug>/. Source of truth =
// the `usage` object on every assistant message (input_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, output_tokens).
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
    firstAt: null,
    lastAt: null,
    byTool: {},        // toolName -> count
    byModel: {},       // model -> { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, messages }
    largestMessage: null, // { tokens, timestamp, role }
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
  return { session, parent, subagents };
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
      byModel: mergeByModel(acc.byModel, s.byModel),
      firstAt: minIso(acc.firstAt, s.firstAt),
      lastAt:  maxIso(acc.lastAt, s.lastAt),
    }),
    {
      messages: 0, toolUses: 0,
      inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0,
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

function sumIntoStats(target, source) {
  target.messages += source.messages;
  target.toolUses += source.toolUses;
  target.inputTokens += source.inputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.outputTokens += source.outputTokens;
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
  const out = { json: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--session') { out.session = argv[i + 1]; i += 1; }
    else if (arg === '--project') { out.project = argv[i + 1]; i += 1; }
    else if (arg === '--out')     { out.out = argv[i + 1]; i += 1; }
    else if (arg === '--cwd')     { out.cwd = argv[i + 1]; i += 1; }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  const projectSlug = args.project || projectSlugFromCwd(cwd);
  const sessions = findSessionsForProject(projectSlug);

  if (sessions.length === 0) {
    const message = `No Claude Code transcripts found for project slug: ${projectSlug}\nLooked in: ${path.join(findClaudeProjectsDir(), projectSlug)}`;
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stdout.write(`${message}\n`);
    }
    return;
  }

  let targets;
  if (args.session) {
    const match = sessions.find((s) => s.id === args.session);
    if (!match) {
      const list = sessions.slice(0, 5).map((s) => `  - ${s.id}`).join('\n');
      process.stderr.write(`Session ${args.session} not found. Recent sessions:\n${list}\n`);
      process.exit(1);
    }
    targets = [match];
  } else if (args.all) {
    targets = sessions;
  } else {
    targets = [sessions[0]];
  }

  const reports = targets.map(aggregateSession);
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
  aggregateSession,
  projectSlugFromCwd,
  findSessionsForProject,
  discoverSubagents,
  emptyStats,
  totalTokens,
  cacheHitRate,
  estimateCost,
  priceFor,
  renderMarkdown,
};
