// src/runners/token-report/index.ts
// CLI entry for the token-usage report (compiles to scripts/token-report.cjs).
// Ported 1:1 from scripts/token-report.cjs + parseArgs/selectTargetSessions
// (_helpers.cjs). Selects Claude / Codex sessions for the cwd/project, aggregates,
// and renders markdown (or --json) to --out or stdout.

import * as fs from 'fs';
import * as path from 'path';

import { aggregateBySource, aggregateSession } from './aggregate';
import { aggregateCodexSession } from './aggregateCodexSession';
import { aggregateCursorSqliteEstimate, findCursorSqliteEstimateTargets } from './aggregateCursorSqliteEstimate';
import {
  findClaudeProjectsDir,
  findCodexSessionsDir,
  findCodexSessionsForCwd,
  findSessionsForProject,
} from './discovery';
import { projectSlugFromCwd } from './projectSlugFromCwd';
import { renderMarkdown } from './render';

type Rec = Record<string, unknown>;
interface TokenReportArgs {
  json: boolean; all: boolean; source: string;
  session?: string; project?: string; out?: string; cwd?: string;
}

export function parseArgs(argv: string[]): TokenReportArgs {
  const out: TokenReportArgs = { json: false, all: false, source: 'auto' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--codex') out.source = 'codex';
    else if (arg === '--claude') out.source = 'claude';
    else if (arg === '--cursor') out.source = 'cursor';
    else if (arg === '--source') { out.source = argv[i + 1] || 'auto'; i += 1; }
    else if (arg === '--session') { out.session = argv[i + 1]; i += 1; }
    else if (arg === '--project') { out.project = argv[i + 1]; i += 1; }
    else if (arg === '--out') { out.out = argv[i + 1]; i += 1; }
    else if (arg === '--cwd') { out.cwd = argv[i + 1]; i += 1; }
  }
  return out;
}

export function selectTargetSessions<T extends Rec>(sessions: T[], args: TokenReportArgs, label: string): T[] {
  if (args.session) {
    const match = sessions.find((s) => (
      s.id === args.session || path.basename(String(s.jsonl || s.parentJsonl || '')) === args.session
    ));
    if (!match) {
      const list = sessions.slice(0, 5).map((s) => `  - ${s.id}`).join('\n');
      process.stderr.write(`Session ${args.session} not found in ${label}. Recent sessions:\n${list}\n`);
      process.exit(1);
    }
    return [match];
  }
  if (args.all) return sessions;
  return sessions.length > 0 ? [sessions[0] as T] : [];
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const cwd = args.cwd || process.cwd();
  const projectSlug = args.project || projectSlugFromCwd(cwd);
  const source = ['auto', 'claude', 'codex', 'cursor'].includes(args.source) ? args.source : 'auto';
  let reports: Rec[] = [];

  if (source === 'auto') {
    const mixedSessions = [
      ...findSessionsForProject(projectSlug).map((session) => ({ ...session, sourceType: 'claude' })),
      ...findCodexSessionsForCwd(cwd).map((session) => ({ ...session, sourceType: 'codex' })),
      ...findCursorSqliteEstimateTargets(cwd).filter((target) => target.exists).map((session) => ({ ...session, sourceType: 'cursor' as const })),
    ].sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (mixedSessions.length > 0) {
      reports = selectTargetSessions(mixedSessions as unknown as Rec[], args, 'Claude Code, Codex Desktop, or Cursor state').map(aggregateBySource) as unknown as Rec[];
    }
  } else if (source === 'claude') {
    const claudeSessions = findSessionsForProject(projectSlug);
    if (claudeSessions.length > 0) {
      reports = selectTargetSessions(claudeSessions as unknown as Rec[], args, 'Claude Code transcripts').map((s) => aggregateSession(s as unknown as { parentJsonl: string; dir: string })) as unknown as Rec[];
    }
  } else if (source === 'codex') {
    const codexSessions = findCodexSessionsForCwd(cwd);
    if (codexSessions.length > 0) {
      reports = selectTargetSessions(codexSessions as unknown as Rec[], args, 'Codex Desktop transcripts').map((s) => aggregateCodexSession(s as unknown as { jsonl: string })) as unknown as Rec[];
    }
  } else if (source === 'cursor') {
    reports = selectTargetSessions(findCursorSqliteEstimateTargets(cwd) as unknown as Rec[], args, 'Cursor SQLite state').map((s) => aggregateCursorSqliteEstimate(s as unknown as Parameters<typeof aggregateCursorSqliteEstimate>[0])) as unknown as Rec[];
  }

  if (reports.length === 0) {
    const looked = source === 'codex'
      ? `Looked in: ${findCodexSessionsDir()}`
      : source === 'claude'
        ? `Looked in: ${path.join(findClaudeProjectsDir(), projectSlug)}`
        : source === 'cursor'
          ? `Looked in: ${findCursorSqliteEstimateTargets(cwd).map((t) => t.dbPath).join(', ')}`
        : `Looked in: ${path.join(findClaudeProjectsDir(), projectSlug)} and ${findCodexSessionsDir()}`;
    const label = source === 'auto' ? 'Claude Code, Codex Desktop, or Cursor' : source;
    const message = `No ${label} transcripts found for cwd: ${cwd}\n${looked}`;
    process.stdout.write(args.json ? `${JSON.stringify({ ok: false, error: message })}\n` : `${message}\n`);
    return;
  }

  const body = args.json ? `${JSON.stringify(reports, null, 2)}\n` : reports.map(renderMarkdown).join('\n---\n\n');

  if (args.out) {
    try {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, body, 'utf8');
      process.stderr.write(`Report written to: ${args.out}\n`);
    } catch (err) {
      process.stderr.write(`Failed to write to ${args.out}: ${(err as Error).message}\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write(body);
  }
}

if (require.main === module) main();
