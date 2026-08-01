// src/shared/onboarding-server/link-evidence.ts
// Evidence that the ASSISTANT already posted the setup link in the live host
// conversation. Validated live (16cl Claude + 019fbca1 Codex, 1.0.45): the
// model posted the link immediately after bootstrap, and the wait-link-first
// deny — whose only stand-down was browser arrival — ordered a SECOND post in
// the seconds before the user could click, so the same URL rendered twice.
//
// This is deliberately NARROWER than the removed "some surface produced the
// text" marker (stamped by bootstrap stdout and deny reasons, which the user
// never sees): only a message AUTHORED BY THE ASSISTANT counts, read from the
// host's own transcript. Tool outputs, deny reasons, and injected context are
// excluded by record type. Every failure path returns false — the gate then
// still orders the post (repetition is the cheap failure; silence is not).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Rec = Record<string, unknown>;

// Transcripts grow past onboarding; the link post happens near the tail of the
// current turn sequence, so a bounded tail read keeps this hook-cheap.
const TAIL_BYTES = 512 * 1024;
// Codex day-directory walk ceiling: sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl.
// The session being probed is LIVE, so it sits in the newest day dirs; a small
// bound keeps a years-old archive from turning this into a filesystem crawl.
const CODEX_DAY_DIR_LIMIT = 14;

function asRec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
}

function readTail(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return '';
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const length = stat.size - start;
  if (length <= 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    // Drop the partial first line of a mid-file window.
    if (start === 0) return text;
    const newline = text.indexOf('\n');
    return newline >= 0 ? text.slice(newline + 1) : '';
  } finally {
    fs.closeSync(fd);
  }
}

// Claude Code transcript line: {"type":"assistant","message":{"role":"assistant",
// "content":[{"type":"text","text":"…"}]}}. Tool results live in type:"user"
// records and hook banners in type:"system" — neither counts.
function claudeAssistantLineHasUrl(line: string, url: string): boolean {
  try {
    const rec = asRec(JSON.parse(line));
    if (!rec || rec.type !== 'assistant') return false;
    const message = asRec(rec.message);
    const content = message?.content;
    if (typeof content === 'string') return content.includes(url);
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      const p = asRec(part);
      return p?.type === 'text' && typeof p.text === 'string' && p.text.includes(url);
    });
  } catch {
    return false;
  }
}

// Codex rollout line shapes that carry assistant-authored chat text:
//   {"type":"event_msg","payload":{"type":"agent_message","message":"…"}}
//   {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"…"}]}}
// custom_tool_call_output (bootstrap stdout, deny reasons) never counts.
function codexAssistantLineHasUrl(line: string, url: string): boolean {
  try {
    const rec = asRec(JSON.parse(line));
    const payload = rec ? asRec(rec.payload) : null;
    if (!rec || !payload) return false;
    if (rec.type === 'event_msg' && payload.type === 'agent_message') {
      return typeof payload.message === 'string' && payload.message.includes(url);
    }
    if (rec.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const content = payload.content;
      if (typeof content === 'string') return content.includes(url);
      if (!Array.isArray(content)) return false;
      return content.some((part) => {
        const p = asRec(part);
        return typeof p?.text === 'string' && p.text.includes(url);
      });
    }
    return false;
  } catch {
    return false;
  }
}

function transcriptHasAssistantUrl(
  filePath: string,
  url: string,
  lineHasUrl: (line: string, url: string) => boolean,
): boolean {
  try {
    const tail = readTail(filePath);
    if (!tail.includes(url)) return false;
    return tail.split('\n').some((line) => line.includes(url) && lineHasUrl(line, url));
  } catch {
    return false;
  }
}

function codexSessionsRoot(env: NodeJS.ProcessEnv): string {
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function sortedDesc(entries: string[]): string[] {
  return entries.filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
}

// sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl, newest days first.
function findCodexRollout(sessionId: string, env: NodeJS.ProcessEnv): string | null {
  const root = codexSessionsRoot(env);
  const suffix = `-${sessionId}.jsonl`;
  let dayDirsVisited = 0;
  try {
    for (const year of sortedDesc(fs.readdirSync(root))) {
      for (const month of sortedDesc(fs.readdirSync(path.join(root, year)))) {
        for (const day of sortedDesc(fs.readdirSync(path.join(root, year, month)))) {
          if (dayDirsVisited >= CODEX_DAY_DIR_LIMIT) return null;
          dayDirsVisited += 1;
          const dayDir = path.join(root, year, month, day);
          const match = fs.readdirSync(dayDir).find(
            (name) => name.startsWith('rollout-') && name.endsWith(suffix),
          );
          if (match) return path.join(dayDir, match);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface AssistantLinkEvidenceInput {
  url: string;
  host: string;
  /** The raw hook payload — Claude carries transcript_path on it. */
  raw: Rec;
  /** Codex conversation id (rollout filename suffix). */
  sessionId?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function assistantPostedLink(input: AssistantLinkEvidenceInput): boolean {
  const url = (input.url || '').trim();
  if (!url) return false;
  try {
    if (input.host === 'claude') {
      const transcriptPath = typeof input.raw.transcript_path === 'string'
        ? input.raw.transcript_path
        : (typeof input.raw.transcriptPath === 'string' ? input.raw.transcriptPath : '');
      if (!transcriptPath) return false;
      return transcriptHasAssistantUrl(transcriptPath, url, claudeAssistantLineHasUrl);
    }
    if (input.host === 'codex') {
      const sessionId = (input.sessionId || '').trim();
      if (!sessionId) return false;
      const rollout = findCodexRollout(sessionId, input.env ?? process.env);
      if (!rollout) return false;
      return transcriptHasAssistantUrl(rollout, url, codexAssistantLineHasUrl);
    }
    // Other hosts have no readable assistant transcript here — no evidence.
    return false;
  } catch {
    return false;
  }
}
