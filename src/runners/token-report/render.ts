// src/runners/token-report/render.ts
// Markdown renderers for the token report (Claude multi-phase + Codex). Ported
// 1:1 from token-report/renderMarkdown.cjs + renderCodexMarkdown (_helpers.cjs).

import { cacheHitRate } from './cacheHitRate';
import { emptyStats } from './emptyStats';
import { estimateCost } from './estimateCost';
import { fmtCost, fmtDuration, fmtNum, maxIso, mergeByModel, minIso, type ModelStats, type Stats, sumIntoStats } from './lib';
import { priceFor } from './priceFor';
import { totalTokens } from './totalTokens';

type Rec = Record<string, unknown>;

function renderCodexMarkdown(agg: Rec): string {
  const lines: string[] = [];
  const session = (agg.session as Rec) || {};
  const total = agg.parent as Stats;
  const trafficOne = agg.trafficOne as { directToolOutputTokens: number; directToolOutputs: number; instructionApproxTokens: number } | undefined;

  lines.push('# Token usage report', '', '- Source: Codex Desktop', `- Session: \`${session.id}\``);
  if (session.cwd) lines.push(`- Cwd: \`${session.cwd}\``);
  lines.push(`- Duration: ${fmtDuration(total.firstAt, total.lastAt)}`);
  if (total.firstAt) lines.push(`- Started: ${total.firstAt}`);
  if (total.lastAt) lines.push(`- Ended:   ${total.lastAt}`);
  lines.push('', '## Totals', '', '| Metric | Value |', '|--------|-------|');
  lines.push(`| Total tokens | ${fmtNum(totalTokens(total))} |`);
  lines.push(`| Input (fresh) | ${fmtNum(total.inputTokens)} |`);
  lines.push(`| Cache write | ${fmtNum(total.cacheCreationInputTokens)} |`);
  lines.push(`| Cache read (reported) | ${fmtNum(total.cacheReadInputTokens)} |`);
  lines.push(`| Output | ${fmtNum(total.outputTokens)} |`);
  if (total.reasoningOutputTokens > 0) lines.push(`| Reasoning output | ${fmtNum(total.reasoningOutputTokens)} |`);
  lines.push(`| Cache hit rate | ${cacheHitRate(total).toFixed(1)}% |`);
  lines.push(`| API calls | ${fmtNum(total.messages)} |`);
  lines.push(`| Tool calls | ${fmtNum(total.toolUses)} |`);
  if (total.modelContextWindow) lines.push(`| Model context window | ${fmtNum(total.modelContextWindow)} |`);
  lines.push('');

  const sortedTools = Object.entries(total.byTool || {}).sort((a, b) => b[1] - a[1]);
  if (sortedTools.length > 0) {
    lines.push('## Tool calls', '', '| Tool | Calls |', '|------|-------|');
    for (const [tool, count] of sortedTools) lines.push(`| ${tool} | ${fmtNum(count)} |`);
    lines.push('');
  }

  if (trafficOne && (trafficOne.directToolOutputTokens > 0 || trafficOne.instructionApproxTokens > 0)) {
    lines.push('## Traffic One estimate', '', '| Metric | Value |', '|--------|-------|');
    lines.push(`| Direct Traffic One tool-output tokens | ${fmtNum(trafficOne.directToolOutputTokens)} |`);
    lines.push(`| Matching tool outputs | ${fmtNum(trafficOne.directToolOutputs)} |`);
    lines.push(`| Traffic One instruction approx. | ${fmtNum(trafficOne.instructionApproxTokens)} |`);
    lines.push('');
  }

  lines.push('## Notes', '');
  if (total.largestMessage) lines.push(`- Largest single API call: ${fmtNum(total.largestMessage.tokens)} tokens at ${total.largestMessage.timestamp || '—'}`);
  lines.push('- Source: transcripts under `~/.codex/sessions/**`');
  lines.push('- Codex reports cached input as a subset of input; this report shows fresh input as input minus cached input.');
  lines.push('- Traffic One attribution is best-effort: direct tool-output tokens come from transcript "Original token count" lines whose output references Traffic One files or rules.');
  return `${lines.join('\n')}\n`;
}

interface TotalStats {
  messages: number; toolUses: number; inputTokens: number; cacheCreationInputTokens: number;
  cacheReadInputTokens: number; outputTokens: number; reasoningOutputTokens: number;
  byModel: Record<string, ModelStats>; firstAt: string | null; lastAt: string | null;
}

export function renderMarkdown(agg: Rec): string {
  if (agg && agg.source === 'codex') return renderCodexMarkdown(agg);

  const lines: string[] = [];
  const session = (agg.session as Rec) || {};
  const parent = agg.parent as Stats;
  const subagents = (agg.subagents as Array<{ stats: Stats; agentType: string; description: string }>) || [];
  const allStats = [parent, ...subagents.map((s) => s.stats)];
  const total = allStats.reduce<TotalStats>((acc, s) => ({
    messages: acc.messages + s.messages,
    toolUses: acc.toolUses + s.toolUses,
    inputTokens: acc.inputTokens + s.inputTokens,
    cacheCreationInputTokens: acc.cacheCreationInputTokens + s.cacheCreationInputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens + s.cacheReadInputTokens,
    outputTokens: acc.outputTokens + s.outputTokens,
    reasoningOutputTokens: acc.reasoningOutputTokens + (s.reasoningOutputTokens || 0),
    byModel: mergeByModel(acc.byModel, s.byModel),
    firstAt: minIso(acc.firstAt, s.firstAt),
    lastAt: maxIso(acc.lastAt, s.lastAt),
  }), { messages: 0, toolUses: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, byModel: {}, firstAt: null, lastAt: null });
  const totalCost = estimateCost(total as unknown as Stats);

  lines.push('# Token usage report', '', `- Session: \`${session.id}\``, `- Duration: ${fmtDuration(total.firstAt, total.lastAt)}`);
  if (total.firstAt) lines.push(`- Started: ${total.firstAt}`);
  if (total.lastAt) lines.push(`- Ended:   ${total.lastAt}`);
  lines.push('', '## Totals', '', '| Metric | Value |', '|--------|-------|');
  lines.push(`| Total tokens | ${fmtNum(totalTokens(total as unknown as Stats))} |`);
  lines.push(`| Input (fresh) | ${fmtNum(total.inputTokens)} |`);
  lines.push(`| Cache write | ${fmtNum(total.cacheCreationInputTokens)} |`);
  lines.push(`| Cache read (cheap) | ${fmtNum(total.cacheReadInputTokens)} |`);
  lines.push(`| Output | ${fmtNum(total.outputTokens)} |`);
  lines.push(`| Cache hit rate | ${cacheHitRate(total as unknown as Stats).toFixed(1)}% |`);
  lines.push(`| Messages | ${fmtNum(total.messages)} |`);
  lines.push(`| Tool uses | ${fmtNum(total.toolUses)} |`);
  lines.push(`| Estimated cost | ${fmtCost(totalCost)} (rough — actual billing in Anthropic console) |`);
  lines.push('');

  lines.push('## By phase / role', '', '| Phase / role | Msgs | Tools | Total tokens | Output | Cache hit | Est. cost |', '|--------------|------|-------|--------------|--------|-----------|-----------|');
  lines.push(`| Main agent (parent) | ${fmtNum(parent.messages)} | ${fmtNum(parent.toolUses)} | ${fmtNum(totalTokens(parent))} | ${fmtNum(parent.outputTokens)} | ${cacheHitRate(parent).toFixed(1)}% | ${fmtCost(estimateCost(parent))} |`);
  for (const sub of subagents) {
    const s = sub.stats;
    const label = `${sub.agentType}${sub.description ? ` — "${sub.description.slice(0, 50)}${sub.description.length > 50 ? '…' : ''}"` : ''}`;
    lines.push(`| ${label} | ${fmtNum(s.messages)} | ${fmtNum(s.toolUses)} | ${fmtNum(totalTokens(s))} | ${fmtNum(s.outputTokens)} | ${cacheHitRate(s).toFixed(1)}% | ${fmtCost(estimateCost(s))} |`);
  }
  lines.push('');

  const byRole: Record<string, { spawns: number; stats: Stats }> = {};
  for (const sub of subagents) {
    let entry = byRole[sub.agentType];
    if (!entry) { entry = { spawns: 0, stats: emptyStats() }; byRole[sub.agentType] = entry; }
    entry.spawns += 1;
    sumIntoStats(entry.stats, sub.stats);
  }
  if (Object.keys(byRole).length > 0) {
    lines.push('## By role (aggregated)', '', '| Role | Spawns | Msgs | Tools | Total tokens | Avg tokens/spawn |', '|------|--------|------|-------|--------------|------------------|');
    const sortedRoles = Object.entries(byRole).sort((a, b) => totalTokens(b[1].stats) - totalTokens(a[1].stats));
    for (const [role, info] of sortedRoles) {
      const t = totalTokens(info.stats);
      lines.push(`| ${role} | ${info.spawns} | ${fmtNum(info.stats.messages)} | ${fmtNum(info.stats.toolUses)} | ${fmtNum(t)} | ${fmtNum(Math.round(t / info.spawns))} |`);
    }
    lines.push('');
  }

  const toolTotals: Record<string, number> = {};
  for (const s of allStats) {
    for (const [tool, count] of Object.entries(s.byTool)) toolTotals[tool] = (toolTotals[tool] || 0) + count;
  }
  const sortedTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]);
  if (sortedTools.length > 0) {
    lines.push('## Tool calls (across all phases)', '', '| Tool | Calls |', '|------|-------|');
    for (const [tool, count] of sortedTools) lines.push(`| ${tool} | ${fmtNum(count)} |`);
    lines.push('');
  }

  if (Object.keys(total.byModel).length > 0) {
    lines.push('## By model', '', '| Model | Msgs | Total tokens | Output | Est. cost |', '|-------|------|--------------|--------|-----------|');
    const sortedModels = Object.entries(total.byModel).sort((a, b) => b[1].outputTokens - a[1].outputTokens);
    for (const [model, m] of sortedModels) {
      const t = m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens + m.outputTokens;
      const p = priceFor(model);
      const cost = (m.inputTokens / 1e6) * p.input + (m.cacheCreationInputTokens / 1e6) * p.cacheWrite + (m.cacheReadInputTokens / 1e6) * p.cacheRead + (m.outputTokens / 1e6) * p.output;
      lines.push(`| ${model} | ${fmtNum(m.messages)} | ${fmtNum(t)} | ${fmtNum(m.outputTokens)} | ${fmtCost(cost)} |`);
    }
    lines.push('');
  }

  lines.push('## Notes', '');
  // Matches legacy: the reduced `total` carries no largestMessage, so this line never renders.
  if ((total as { largestMessage?: unknown }).largestMessage && parent.largestMessage) {
    lines.push(`- Largest single message: ${fmtNum(parent.largestMessage.tokens)} tokens at ${parent.largestMessage.timestamp || '—'}`);
  }
  lines.push(`- Subagent spawns: ${subagents.length}`);
  lines.push(`- Source: transcripts under \`~/.claude/projects/<slug>/${session.id}/\``);
  lines.push('- Cost is a rough estimate based on public list pricing; actual billing comes from the Anthropic console.');
  return `${lines.join('\n')}\n`;
}
