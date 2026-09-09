// src/config/paths.ts
// State file locations + IO limits. THE knobs for where Traffic One persists its
// per-project state. pluginRoot / cache helpers are logic and live in shared/paths.ts.

import * as path from 'path';

// `.one.json` is COMMITTED — deliberately. It is not in the generated ignore
// body (architecture-contract/scaffold-content.ts `TRAFFIC_ONE_RUN_STATE_ENTRIES`
// covers `runs/`, `reports/`, `backups/`, `debug/` and `one-mcp-report.json`),
// and `git check-ignore` on a real materialized project confirms it: tracked,
// alongside `.traffic-one/manifest.json` and `.traffic-one/rules/**`.
//
// ── IF YOU ARE HERE TO ADD A SECOND, RUNTIME STATE FILE, READ THIS FIRST ─────
// Measured over 509 real projects that have a committed `.one.json` baseline and
// then ran one full session (~/traffic-one-test-runs): 509/509 came out dirty,
// and the dirt is exactly three keys — `currentRunId` (509/509), `spawnIndex`
// (166/509) and `lifecycle` (97/509), plus `materializedAt` re-stamped in
// 19/509. Nothing is ever removed. Every other key in the file — stack, mode,
// frontend/backend/mobile, technologies, projectContext, confirmedAt,
// openCodeDelegation, supabase*, version, materializedStack/Version — was
// byte-identical across the session, and `materializedStack`/`materializedVersion`
// describe artifacts (`.traffic-one/rules/**`, `manifest.json`) that ARE
// committed, so they belong here.
//
// Three consequences for anyone planning the split:
//   - The runtime population is three fields, not a class. Sizing the work off
//     "runtime bookkeeping" overestimates it by an order of magnitude.
//   - The split already has a home and it is not a second file in this
//     directory. shared/state/local-prefs/** routes LOCAL_PREF_KEYS to
//     `~/.traffic-one/projects/<hash>/preferences.json` — outside the repo, so
//     no gitignore line, no new path for the consent fence to cover, and
//     `scrubProjectStateLocalPrefs` already migrates leaked fields on
//     SessionStart. A second file under `.traffic-one/` buys none of that.
//   - A second file here is a cross-path divergence pair. `.one.json` landing
//     without the runtime half means a blanked `currentRunId`, and a blanked
//     `currentRunId` makes the next claim mint a SECOND run — observation 11c,
//     the incident project-state-lock.ts `preserveCurrentRunId` exists for. The
//     split would reintroduce it through a different door.
export const STATE_DIR = '.traffic-one';
const STATE_BASENAME = '.one.json';
export const STATE_FILE = path.join(STATE_DIR, STATE_BASENAME);
export const LEGACY_STATE_FILE = STATE_FILE;
export const LEGACY_LOCK_FILE = '.claude-plugin-mode';

// Agent-facing fences must recognize `.Traffic-One` / `.TRAFFIC-ONE` as the
// state dir: macOS default FS and Windows treat those as the same directory.
// Runtime already folds (plugin-use, fsjson); these helpers are the shared
// agent-facing side. Match the SEGMENT, never a mid-word substring
// (`.traffic-one-backup`). Indices come from a regex on the original string,
// never from `toLowerCase().indexOf()` — lowercasing is not length-preserving
// for every Unicode code point (U+0130).
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function caseInsensitiveLiteral(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    const code = value.charCodeAt(i);
    if (code >= 97 && code <= 122) out += `[${ch}${ch.toUpperCase()}]`;
    else if (code >= 65 && code <= 90) out += `[${ch.toLowerCase()}${ch}]`;
    else out += escapeRegExp(ch);
  }
  return out;
}

/** STATE_DIR as a regex source matching that one path segment, ASCII-case-insensitive. */
export const STATE_DIR_SEGMENT_SOURCE = caseInsensitiveLiteral(STATE_DIR);

const STATE_DIR_SEGMENT_EXACT_RE = new RegExp(`^${escapeRegExp(STATE_DIR)}$`, 'i');

/** STATE_DIR as a complete path segment inside a larger string (path or command). */
export const STATE_DIR_MENTION_RE = new RegExp(
  `(?:^|[/\\\\]|[^/\\\\.\\w])${STATE_DIR_SEGMENT_SOURCE}(?=[/\\\\]|$)`,
);

export function isStateDirSegment(segment: string): boolean {
  return STATE_DIR_SEGMENT_EXACT_RE.test(segment);
}

export function mentionsStateDirSegment(text: string): boolean {
  return STATE_DIR_MENTION_RE.test(text);
}

/** Fold each path segment that equals STATE_DIR (case-insensitive) to STATE_DIR. */
export function canonicalizeStateDirSegments(posixPath: string): string {
  if (!posixPath) return posixPath;
  return posixPath.split('/').map((seg) => (isStateDirSegment(seg) ? STATE_DIR : seg)).join('/');
}
