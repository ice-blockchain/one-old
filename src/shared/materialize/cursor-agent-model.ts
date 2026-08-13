// src/shared/materialize/cursor-agent-model.ts
// Dependency-free reader for the per-role Cursor subagent model, shared by the writer
// (cursor-agents.ts) and the agent-model spawn gate. Kept fs-only and separate from the
// writer so importing it into the hook runtime does NOT pull the onboarding flow
// (buildTeamLineup) into that bundle.

import * as path from 'path';
import { readRegularFileOrThrow } from '../bounded-read';

export const CURSOR_AGENTS_REL = path.join('.cursor', 'agents');

// Legacy inspection helper. Traffic One-generated project contracts are now
// model-agnostic and runtime routing comes from local preferences/the spawn map;
// this returns a value only for an older or user-authored profile with `model:`.
export function cursorAgentModel(cwd: string, role: string): string | null {
  if (!role) return null;
  try {
    const txt = readRegularFileOrThrow(path.join(cwd, CURSOR_AGENTS_REL, `${role}.md`));
    const m = /^model:[ \t]*(\S+)[ \t]*$/m.exec(txt);
    return m && m[1] ? m[1].trim() : null;
  } catch {
    return null;
  }
}
