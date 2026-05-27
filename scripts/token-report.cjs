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

const { parseJsonlFile } = require('./token-report/parseJsonlFile.cjs');
const { parseCodexJsonlFile } = require('./token-report/parseCodexJsonlFile.cjs');
const { aggregateSession } = require('./token-report/aggregateSession.cjs');
const { aggregateCodexSession } = require('./token-report/aggregateCodexSession.cjs');
const { projectSlugFromCwd } = require('./token-report/projectSlugFromCwd.cjs');
const { findSessionsForProject } = require('./token-report/findSessionsForProject.cjs');
const { findCodexSessionsForCwd } = require('./token-report/findCodexSessionsForCwd.cjs');
const { readCodexSessionMeta } = require('./token-report/readCodexSessionMeta.cjs');
const { discoverSubagents } = require('./token-report/discoverSubagents.cjs');
const { emptyStats } = require('./token-report/emptyStats.cjs');
const { emptyTrafficOneEstimate } = require('./token-report/emptyTrafficOneEstimate.cjs');
const { totalTokens } = require('./token-report/totalTokens.cjs');
const { cacheHitRate } = require('./token-report/cacheHitRate.cjs');
const { estimateCost } = require('./token-report/estimateCost.cjs');
const { priceFor } = require('./token-report/priceFor.cjs');
const { parseOriginalTokenCount } = require('./token-report/parseOriginalTokenCount.cjs');
const { renderMarkdown } = require('./token-report/renderMarkdown.cjs');

const {
  findCodexSessionsDir,
  findClaudeProjectsDir,
  parseArgs,
  selectTargetSessions,
  aggregateBySource,
} = require('./token-report/_helpers.cjs');

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
