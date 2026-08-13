// src/runners/token-report/discovery.ts
// Session + subagent discovery for the token report: walk ~/.claude/projects
// and ~/.codex/sessions. Ported 1:1 from token-report/_helpers.cjs +
// discoverSubagents/findSessionsForProject/findCodexSessionsForCwd/
// readCodexSessionMeta.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { codexSessionIdFromFile } from './lib';
import { openRegularFd, readRegularFileOrThrow } from '../../shared/bounded-read';

type Rec = Record<string, unknown>;

export function readFirstLine(filePath: string, maxBytes = 4 * 1024 * 1024): string {
  let fd: number | undefined;
  try {
    fd = openRegularFd(filePath);
    const chunks: Buffer[] = [];
    let offset = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (offset < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      if (newline >= 0) { chunks.push(chunk.subarray(0, newline)); break; }
      chunks.push(Buffer.from(chunk));
      offset += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

export function pathsRelated(left: unknown, right: unknown): boolean {
  if (!left || !right) return false;
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

export function findCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export function walkCodexSessionFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkCodexSessionFiles(fullPath, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(fullPath);
  }
  return out;
}

export function findClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export interface Subagent { id: string; jsonl: string; agentType: string; description: string }
export function discoverSubagents(sessionDir: string): Subagent[] {
  const subagentsDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(subagentsDir, { withFileTypes: true }); } catch { return []; }
  const out: Subagent[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const id = e.name.replace(/\.jsonl$/, '');
    const metaPath = path.join(subagentsDir, `${id}.meta.json`);
    let meta: Rec = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(readRegularFileOrThrow(metaPath)) as Rec; } catch { meta = {}; }
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

export interface ClaudeSession { id: string; dir: string; parentJsonl: string; mtimeMs: number; sourceType?: string }
export function findSessionsForProject(projectSlug: string): ClaudeSession[] {
  const projectDir = path.join(findClaudeProjectsDir(), projectSlug);
  if (!fs.existsSync(projectDir)) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return []; }
  const sessions: ClaudeSession[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const id = e.name;
    const parentJsonl = path.join(projectDir, `${id}.jsonl`);
    if (!fs.existsSync(parentJsonl)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(parentJsonl).mtimeMs; } catch { mtime = 0; }
    sessions.push({ id, dir: path.join(projectDir, id), parentJsonl, mtimeMs: mtime });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

export interface CodexSessionMeta {
  id: string; startedAt: string | null; cwd: string | null; originator: string;
  source: string | null; modelProvider: string | null; model: string;
}
export function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  const line = readFirstLine(filePath).trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || parsed.type !== 'session_meta') return null;
    const payload = parsed.payload && typeof parsed.payload === 'object' ? (parsed.payload as Rec) : {};
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    return {
      id: str(payload.id) ?? codexSessionIdFromFile(filePath),
      startedAt: (str(payload.timestamp) ?? str(parsed.timestamp)) ?? null,
      cwd: str(payload.cwd) ?? null,
      originator: str(payload.originator) ?? 'Codex Desktop',
      source: str(payload.source) ?? null,
      modelProvider: str(payload.model_provider) ?? null,
      model: str(payload.model) ?? 'codex',
    };
  } catch {
    return null;
  }
}

export function findCodexSessionsForCwd(cwd: string, sessionsDir: string = findCodexSessionsDir()): Array<CodexSessionMeta & { jsonl: string; mtimeMs: number }> {
  const sessions: Array<CodexSessionMeta & { jsonl: string; mtimeMs: number }> = [];
  for (const filePath of walkCodexSessionFiles(sessionsDir)) {
    const meta = readCodexSessionMeta(filePath);
    if (!meta || !pathsRelated(cwd, meta.cwd)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { mtime = 0; }
    sessions.push({ ...meta, jsonl: filePath, mtimeMs: mtime });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}
