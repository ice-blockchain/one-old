// src/shared/state/run-agent/cursor-transcripts.ts
// On-disk Cursor transcript discovery and candidate ranking.

import { obj } from '../../obj';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';

import {
  firstString,
  stringValues,
  uniqueStrings,
} from './run-paths';
import {
  inferRoleFromTranscript,
} from './role-evidence';
import {
  isResumeCapableAgentId,
} from './registry';

function cursorProjectsRoot(): string | null {
  const override = firstString(process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR);
  if (override) return override;
  const home = firstString(process.env.HOME, os.homedir());
  return home ? path.join(home, '.cursor', 'projects') : null;
}

function cursorProjectDirNames(projectRoot: string): string[] {
  const roots: string[] = [projectRoot];
  try {
    const real = fs.realpathSync(projectRoot);
    if (real) roots.push(real);
  } catch {
    // best-effort; cwd may not exist in a unit test or after a deleted project
  }
  return uniqueStrings(roots.map((root) => {
    const normalized = path.resolve(root).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized.replace(/[/:\s]+/g, '-');
  }));
}

function workspaceRootsForCursorLookup(cwd: string, rawInput: unknown): string[] {
  const data = obj(rawInput) || {};
  const payload = obj(data.payload) || {};
  return uniqueStrings([
    cwd,
    ...stringValues(data.workspace_roots),
    ...stringValues(data.workspaceRoots),
    ...stringValues(payload.workspace_roots),
    ...stringValues(payload.workspaceRoots),
  ]);
}

export interface CursorTranscriptCandidate {
  filePath: string;
  parentSessionId: string;
  childTranscriptId: string;
  birthtimeMs: number;
  mtimeMs: number;
}

// Cursor appends to child transcripts, so mtime reflects the last write rather
// than the spawn. birthtime is the correlation anchor when the filesystem
// exposes it; mtime remains available (and is the fallback on filesystems whose
// birthtime is zero/invalid).
export function cursorTranscriptCandidateTimeMs(candidate: CursorTranscriptCandidate): number {
  return Number.isFinite(candidate.birthtimeMs) && candidate.birthtimeMs > 0
    ? candidate.birthtimeMs
    : candidate.mtimeMs;
}

function cursorTranscriptCandidate(
  filePath: string,
  parentSessionId: string,
  childTranscriptId: string,
): CursorTranscriptCandidate | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      filePath,
      parentSessionId,
      childTranscriptId,
      birthtimeMs: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : 0,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sortCursorTranscriptCandidates(candidates: CursorTranscriptCandidate[]): CursorTranscriptCandidate[] {
  return candidates.sort((a, b) => (
    cursorTranscriptCandidateTimeMs(b) - cursorTranscriptCandidateTimeMs(a)
    || b.mtimeMs - a.mtimeMs
    || a.filePath.localeCompare(b.filePath)
  ));
}

function subagentTranscriptCandidates(projectDir: string, sessionId: string): CursorTranscriptCandidate[] {
  const out: CursorTranscriptCandidate[] = [];
  const agentTranscriptsDir = path.join(projectDir, 'agent-transcripts');
  try {
    for (const parent of fs.readdirSync(agentTranscriptsDir, { withFileTypes: true })) {
      if (!parent.isDirectory()) continue;
      const filePath = path.join(agentTranscriptsDir, parent.name, 'subagents', `${sessionId}.jsonl`);
      const candidate = cursorTranscriptCandidate(filePath, parent.name, sessionId);
      if (candidate) out.push(candidate);
    }
  } catch {
    // no Cursor transcript cache for this project
  }
  return out;
}

function allSubagentTranscriptCandidates(projectDir: string, parentSessionId?: string | null): CursorTranscriptCandidate[] {
  const out: CursorTranscriptCandidate[] = [];
  const agentTranscriptsDir = path.join(projectDir, 'agent-transcripts');
  try {
    for (const parent of fs.readdirSync(agentTranscriptsDir, { withFileTypes: true })) {
      if (!parent.isDirectory()) continue;
      if (parentSessionId && parent.name !== parentSessionId) continue;
      const dir = path.join(agentTranscriptsDir, parent.name, 'subagents');
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(dir, entry.name);
        const childTranscriptId = entry.name.slice(0, -'.jsonl'.length);
        const candidate = cursorTranscriptCandidate(filePath, parent.name, childTranscriptId);
        if (candidate) out.push(candidate);
      }
    }
  } catch {
    // no Cursor transcript cache for this project
  }
  return out;
}

// List Cursor CHILD transcripts for the current workspace (optionally one parent
// session). The traversal is intentionally rooted at `subagents/`; it never reads
// or returns the parent `<session>.jsonl`, whose terminal error can be an unrelated
// "User aborted request". Paths are de-duplicated because workspace_roots can name
// the same project through both a symlink and its real path.
export function listCursorSubagentTranscriptCandidates(
  cwd: string,
  rawInput: unknown,
  parentSessionId?: string | null,
): CursorTranscriptCandidate[] {
  if (isNonProjectRoot(cwd)) return [];
  const root = cursorProjectsRoot();
  if (!root) return [];

  const projectRoots = workspaceRootsForCursorLookup(cwd, rawInput);
  const projectDirs: string[] = [];
  for (const projectRoot of projectRoots) {
    for (const dirName of cursorProjectDirNames(projectRoot)) {
      projectDirs.push(path.join(root, dirName));
    }
  }

  const candidates: CursorTranscriptCandidate[] = [];
  for (const projectDir of uniqueStrings(projectDirs)) {
    candidates.push(...allSubagentTranscriptCandidates(projectDir, parentSessionId));
  }

  // Cursor has changed project-key encoding before. Fall back to directories
  // ending in the workspace basename only when exact keys yield no candidates.
  if (candidates.length === 0) {
    const basenames = uniqueStrings(projectRoots.map((projectRoot) => path.basename(projectRoot)).filter(Boolean));
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!basenames.some((base) => entry.name === base || entry.name.endsWith(`-${base}`))) continue;
        candidates.push(...allSubagentTranscriptCandidates(path.join(root, entry.name), parentSessionId));
      }
    } catch {
      // no Cursor projects root
    }
  }

  const unique = new Map<string, CursorTranscriptCandidate>();
  for (const candidate of candidates) {
    const key = path.resolve(candidate.filePath);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return sortCursorTranscriptCandidates([...unique.values()]);
}

// Cursor child tool events currently report only the child conversation/session id
// and `transcript_path: null`. The role marker lives in Cursor's local child
// transcript at:
//   ~/.cursor/projects/<project-key>/agent-transcripts/<parent>/subagents/<child>.jsonl
// Locate that file so the normal transcript role-inference path can bind the child
// session instead of denying it as "main agent".
export function cursorSubagentTranscript(cwd: string, rawInput: unknown, sessionId: string | null): CursorTranscriptCandidate | null {
  if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes('..')) return null;
  const root = cursorProjectsRoot();
  if (!root) return null;

  const projectRoots = workspaceRootsForCursorLookup(cwd, rawInput);
  const projectDirs: string[] = [];
  for (const projectRoot of projectRoots) {
    for (const dirName of cursorProjectDirNames(projectRoot)) {
      projectDirs.push(path.join(root, dirName));
    }
  }

  const candidates: CursorTranscriptCandidate[] = [];
  for (const projectDir of uniqueStrings(projectDirs)) {
    candidates.push(...subagentTranscriptCandidates(projectDir, sessionId));
  }

  // Encoding has changed before; if the exact project key misses, fall back to
  // project dirs that end with the workspace basename. The child session id still
  // has to match exactly, so this remains deterministic in normal Cursor caches.
  if (candidates.length === 0) {
    const basenames = uniqueStrings(projectRoots.map((projectRoot) => path.basename(projectRoot)).filter(Boolean));
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!basenames.some((base) => entry.name === base || entry.name.endsWith(`-${base}`))) continue;
        candidates.push(...subagentTranscriptCandidates(path.join(root, entry.name), sessionId));
      }
    } catch {
      // no Cursor projects root
    }
  }

  if (candidates.length === 0) return null;
  return sortCursorTranscriptCandidates(candidates)[0]!;
}

export function cursorSubagentTranscriptsForRole(
  cwd: string,
  rawInput: unknown,
  role: string,
  parentSessionId?: string | null,
): CursorTranscriptCandidate[] {
  if (!VALID_AGENT_ROLES.has(role)) return [];
  return listCursorSubagentTranscriptCandidates(cwd, rawInput, parentSessionId)
    .filter((candidate) => inferRoleFromTranscript(candidate.filePath) === role)
    .sort((a, b) => cursorTranscriptCandidateTimeMs(b) - cursorTranscriptCandidateTimeMs(a));
}

export function candidateThreadId(candidate: CursorTranscriptCandidate): string | null {
  return isResumeCapableAgentId(candidate.childTranscriptId) ? candidate.childTranscriptId : null;
}

