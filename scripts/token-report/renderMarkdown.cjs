'use strict';

const { estimateCost } = require('./estimateCost.cjs');
const { priceFor } = require('./priceFor.cjs');
const { totalTokens } = require('./totalTokens.cjs');
const { cacheHitRate } = require('./cacheHitRate.cjs');
const { emptyStats } = require('./emptyStats.cjs');
const {
  renderCodexMarkdown,
  mergeByModel,
  minIso,
  maxIso,
  fmtDuration,
  fmtNum,
  fmtCost,
  sumIntoStats,
} = require('./_helpers.cjs');

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

module.exports = { renderMarkdown };
