// src/shared/materialize/cursor-agent-model.ts
// Dependency-free reader for the per-role Cursor subagent model, shared by the writer
// (cursor-agents.ts) and the agent-model spawn gate. Kept fs-only and separate from the
// writer so importing it into the hook runtime does NOT pull the onboarding flow
// (buildTeamLineup) into that bundle.

import * as fs from 'fs';
import * as path from 'path';

export const CURSOR_AGENTS_REL = path.join('.cursor', 'agents');

// The per-role model the orchestrator must read from `.cursor/agents/<role>.md` and pass as the
// Task `model` parameter. Cursor does NOT reliably auto-apply this frontmatter on spawn; the
// spawn gate validates the passed tool parameter. Returns null when there's no agent file or no
// `model:` line.
export function cursorAgentModel(cwd: string, role: string): string | null {
  if (!role) return null;
  try {
    const txt = fs.readFileSync(path.join(cwd, CURSOR_AGENTS_REL, `${role}.md`), 'utf8');
    const m = /^model:[ \t]*(\S+)[ \t]*$/m.exec(txt);
    return m && m[1] ? m[1].trim() : null;
  } catch {
    return null;
  }
}
