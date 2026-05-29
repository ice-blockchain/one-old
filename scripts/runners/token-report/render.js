"use strict";
// src/runners/token-report/render.ts
// Markdown renderers for the token report (Claude multi-phase + Codex). Ported
// 1:1 from token-report/renderMarkdown.cjs + renderCodexMarkdown (_helpers.cjs).
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderMarkdown = renderMarkdown;
const cacheHitRate_1 = require("./cacheHitRate");
const emptyStats_1 = require("./emptyStats");
const estimateCost_1 = require("./estimateCost");
const lib_1 = require("./lib");
const priceFor_1 = require("./priceFor");
const totalTokens_1 = require("./totalTokens");
function renderCodexMarkdown(agg) {
    const lines = [];
    const session = agg.session || {};
    const total = agg.parent;
    const trafficOne = agg.trafficOne;
    lines.push('# Token usage report', '', '- Source: Codex Desktop', `- Session: \`${session.id}\``);
    if (session.cwd)
        lines.push(`- Cwd: \`${session.cwd}\``);
    lines.push(`- Duration: ${(0, lib_1.fmtDuration)(total.firstAt, total.lastAt)}`);
    if (total.firstAt)
        lines.push(`- Started: ${total.firstAt}`);
    if (total.lastAt)
        lines.push(`- Ended:   ${total.lastAt}`);
    lines.push('', '## Totals', '', '| Metric | Value |', '|--------|-------|');
    lines.push(`| Total tokens | ${(0, lib_1.fmtNum)((0, totalTokens_1.totalTokens)(total))} |`);
    lines.push(`| Input (fresh) | ${(0, lib_1.fmtNum)(total.inputTokens)} |`);
    lines.push(`| Cache write | ${(0, lib_1.fmtNum)(total.cacheCreationInputTokens)} |`);
    lines.push(`| Cache read (reported) | ${(0, lib_1.fmtNum)(total.cacheReadInputTokens)} |`);
    lines.push(`| Output | ${(0, lib_1.fmtNum)(total.outputTokens)} |`);
    if (total.reasoningOutputTokens > 0)
        lines.push(`| Reasoning output | ${(0, lib_1.fmtNum)(total.reasoningOutputTokens)} |`);
    lines.push(`| Cache hit rate | ${(0, cacheHitRate_1.cacheHitRate)(total).toFixed(1)}% |`);
    lines.push(`| API calls | ${(0, lib_1.fmtNum)(total.messages)} |`);
    lines.push(`| Tool calls | ${(0, lib_1.fmtNum)(total.toolUses)} |`);
    if (total.modelContextWindow)
        lines.push(`| Model context window | ${(0, lib_1.fmtNum)(total.modelContextWindow)} |`);
    lines.push('');
    const sortedTools = Object.entries(total.byTool || {}).sort((a, b) => b[1] - a[1]);
    if (sortedTools.length > 0) {
        lines.push('## Tool calls', '', '| Tool | Calls |', '|------|-------|');
        for (const [tool, count] of sortedTools)
            lines.push(`| ${tool} | ${(0, lib_1.fmtNum)(count)} |`);
        lines.push('');
    }
    if (trafficOne && (trafficOne.directToolOutputTokens > 0 || trafficOne.instructionApproxTokens > 0)) {
        lines.push('## Traffic One estimate', '', '| Metric | Value |', '|--------|-------|');
        lines.push(`| Direct Traffic One tool-output tokens | ${(0, lib_1.fmtNum)(trafficOne.directToolOutputTokens)} |`);
        lines.push(`| Matching tool outputs | ${(0, lib_1.fmtNum)(trafficOne.directToolOutputs)} |`);
        lines.push(`| Traffic One instruction approx. | ${(0, lib_1.fmtNum)(trafficOne.instructionApproxTokens)} |`);
        lines.push('');
    }
    lines.push('## Notes', '');
    if (total.largestMessage)
        lines.push(`- Largest single API call: ${(0, lib_1.fmtNum)(total.largestMessage.tokens)} tokens at ${total.largestMessage.timestamp || '—'}`);
    lines.push('- Source: transcripts under `~/.codex/sessions/**`');
    lines.push('- Codex reports cached input as a subset of input; this report shows fresh input as input minus cached input.');
    lines.push('- Traffic One attribution is best-effort: direct tool-output tokens come from transcript "Original token count" lines whose output references Traffic One files or rules.');
    return `${lines.join('\n')}\n`;
}
function renderMarkdown(agg) {
    if (agg && agg.source === 'codex')
        return renderCodexMarkdown(agg);
    const lines = [];
    const session = agg.session || {};
    const parent = agg.parent;
    const subagents = agg.subagents || [];
    const allStats = [parent, ...subagents.map((s) => s.stats)];
    const total = allStats.reduce((acc, s) => ({
        messages: acc.messages + s.messages,
        toolUses: acc.toolUses + s.toolUses,
        inputTokens: acc.inputTokens + s.inputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + s.cacheCreationInputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + s.cacheReadInputTokens,
        outputTokens: acc.outputTokens + s.outputTokens,
        reasoningOutputTokens: acc.reasoningOutputTokens + (s.reasoningOutputTokens || 0),
        byModel: (0, lib_1.mergeByModel)(acc.byModel, s.byModel),
        firstAt: (0, lib_1.minIso)(acc.firstAt, s.firstAt),
        lastAt: (0, lib_1.maxIso)(acc.lastAt, s.lastAt),
    }), { messages: 0, toolUses: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, byModel: {}, firstAt: null, lastAt: null });
    const totalCost = (0, estimateCost_1.estimateCost)(total);
    lines.push('# Token usage report', '', `- Session: \`${session.id}\``, `- Duration: ${(0, lib_1.fmtDuration)(total.firstAt, total.lastAt)}`);
    if (total.firstAt)
        lines.push(`- Started: ${total.firstAt}`);
    if (total.lastAt)
        lines.push(`- Ended:   ${total.lastAt}`);
    lines.push('', '## Totals', '', '| Metric | Value |', '|--------|-------|');
    lines.push(`| Total tokens | ${(0, lib_1.fmtNum)((0, totalTokens_1.totalTokens)(total))} |`);
    lines.push(`| Input (fresh) | ${(0, lib_1.fmtNum)(total.inputTokens)} |`);
    lines.push(`| Cache write | ${(0, lib_1.fmtNum)(total.cacheCreationInputTokens)} |`);
    lines.push(`| Cache read (cheap) | ${(0, lib_1.fmtNum)(total.cacheReadInputTokens)} |`);
    lines.push(`| Output | ${(0, lib_1.fmtNum)(total.outputTokens)} |`);
    lines.push(`| Cache hit rate | ${(0, cacheHitRate_1.cacheHitRate)(total).toFixed(1)}% |`);
    lines.push(`| Messages | ${(0, lib_1.fmtNum)(total.messages)} |`);
    lines.push(`| Tool uses | ${(0, lib_1.fmtNum)(total.toolUses)} |`);
    lines.push(`| Estimated cost | ${(0, lib_1.fmtCost)(totalCost)} (rough — actual billing in Anthropic console) |`);
    lines.push('');
    lines.push('## By phase / role', '', '| Phase / role | Msgs | Tools | Total tokens | Output | Cache hit | Est. cost |', '|--------------|------|-------|--------------|--------|-----------|-----------|');
    lines.push(`| Main agent (parent) | ${(0, lib_1.fmtNum)(parent.messages)} | ${(0, lib_1.fmtNum)(parent.toolUses)} | ${(0, lib_1.fmtNum)((0, totalTokens_1.totalTokens)(parent))} | ${(0, lib_1.fmtNum)(parent.outputTokens)} | ${(0, cacheHitRate_1.cacheHitRate)(parent).toFixed(1)}% | ${(0, lib_1.fmtCost)((0, estimateCost_1.estimateCost)(parent))} |`);
    for (const sub of subagents) {
        const s = sub.stats;
        const label = `${sub.agentType}${sub.description ? ` — "${sub.description.slice(0, 50)}${sub.description.length > 50 ? '…' : ''}"` : ''}`;
        lines.push(`| ${label} | ${(0, lib_1.fmtNum)(s.messages)} | ${(0, lib_1.fmtNum)(s.toolUses)} | ${(0, lib_1.fmtNum)((0, totalTokens_1.totalTokens)(s))} | ${(0, lib_1.fmtNum)(s.outputTokens)} | ${(0, cacheHitRate_1.cacheHitRate)(s).toFixed(1)}% | ${(0, lib_1.fmtCost)((0, estimateCost_1.estimateCost)(s))} |`);
    }
    lines.push('');
    const byRole = {};
    for (const sub of subagents) {
        let entry = byRole[sub.agentType];
        if (!entry) {
            entry = { spawns: 0, stats: (0, emptyStats_1.emptyStats)() };
            byRole[sub.agentType] = entry;
        }
        entry.spawns += 1;
        (0, lib_1.sumIntoStats)(entry.stats, sub.stats);
    }
    if (Object.keys(byRole).length > 0) {
        lines.push('## By role (aggregated)', '', '| Role | Spawns | Msgs | Tools | Total tokens | Avg tokens/spawn |', '|------|--------|------|-------|--------------|------------------|');
        const sortedRoles = Object.entries(byRole).sort((a, b) => (0, totalTokens_1.totalTokens)(b[1].stats) - (0, totalTokens_1.totalTokens)(a[1].stats));
        for (const [role, info] of sortedRoles) {
            const t = (0, totalTokens_1.totalTokens)(info.stats);
            lines.push(`| ${role} | ${info.spawns} | ${(0, lib_1.fmtNum)(info.stats.messages)} | ${(0, lib_1.fmtNum)(info.stats.toolUses)} | ${(0, lib_1.fmtNum)(t)} | ${(0, lib_1.fmtNum)(Math.round(t / info.spawns))} |`);
        }
        lines.push('');
    }
    const toolTotals = {};
    for (const s of allStats) {
        for (const [tool, count] of Object.entries(s.byTool))
            toolTotals[tool] = (toolTotals[tool] || 0) + count;
    }
    const sortedTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]);
    if (sortedTools.length > 0) {
        lines.push('## Tool calls (across all phases)', '', '| Tool | Calls |', '|------|-------|');
        for (const [tool, count] of sortedTools)
            lines.push(`| ${tool} | ${(0, lib_1.fmtNum)(count)} |`);
        lines.push('');
    }
    if (Object.keys(total.byModel).length > 0) {
        lines.push('## By model', '', '| Model | Msgs | Total tokens | Output | Est. cost |', '|-------|------|--------------|--------|-----------|');
        const sortedModels = Object.entries(total.byModel).sort((a, b) => b[1].outputTokens - a[1].outputTokens);
        for (const [model, m] of sortedModels) {
            const t = m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens + m.outputTokens;
            const p = (0, priceFor_1.priceFor)(model);
            const cost = (m.inputTokens / 1e6) * p.input + (m.cacheCreationInputTokens / 1e6) * p.cacheWrite + (m.cacheReadInputTokens / 1e6) * p.cacheRead + (m.outputTokens / 1e6) * p.output;
            lines.push(`| ${model} | ${(0, lib_1.fmtNum)(m.messages)} | ${(0, lib_1.fmtNum)(t)} | ${(0, lib_1.fmtNum)(m.outputTokens)} | ${(0, lib_1.fmtCost)(cost)} |`);
        }
        lines.push('');
    }
    lines.push('## Notes', '');
    // Matches legacy: the reduced `total` carries no largestMessage, so this line never renders.
    if (total.largestMessage && parent.largestMessage) {
        lines.push(`- Largest single message: ${(0, lib_1.fmtNum)(parent.largestMessage.tokens)} tokens at ${parent.largestMessage.timestamp || '—'}`);
    }
    lines.push(`- Subagent spawns: ${subagents.length}`);
    lines.push(`- Source: transcripts under \`~/.claude/projects/<slug>/${session.id}/\``);
    lines.push('- Cost is a rough estimate based on public list pricing; actual billing comes from the Anthropic console.');
    return `${lines.join('\n')}\n`;
}
