// src/shared/onboarding/team-mode-approval.ts
// The team-mode-change-approval marker subsystem: a single-use, TTL-bounded
// marker written ONLY by the UserPromptSubmit hook after an explicit user
// request to drop subagents, then consumed once by the onboarding gate to allow
// a team.mode="subagents" → "main-agent" downgrade. Ported 1:1 from _helpers.cjs.
// Pure state logic — the guard DENY PROSE lives in the onboarding-gate skill;
// the guards here return a boolean "violates?" so callers map it to prose.

import { detectMode } from '../detection';
import { normalizeState, writeState } from '../state';
import { sha256, nowIsoNoMs } from '../text';
import {
  existingStateFilePath,
  isStateFilePath,
  isStateFileOnlyPatch,
  isWriteLikeToolName,
  normalizedToolName,
  patchTextFromToolInput,
} from '../tool-classify';
import * as fs from 'fs';

type Rec = Record<string, unknown>;

export const TEAM_MODE_CHANGE_APPROVAL_TTL_MS = 10 * 60 * 1000;

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

export function hashPromptText(promptText: unknown): string {
  return sha256(String(promptText || '').trim());
}

// True only for an explicit "I no longer want subagents, use Low/main-agent"
// user statement — both a stop-subagents intent AND a main-agent choice.
export function isExplicitSubagentsToMainAgentIntent(promptText: unknown): boolean {
  const prompt = String(promptText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!prompt) return false;
  const rejectsAsVague = /\b(subagents?\s+(are|is)\s+unavailable|subagents?\s+(are|is)\s+blocked|subagents?\s+(do|does)\s+not\s+work)\b/.test(prompt);
  const rejectsWithoutChoice = rejectsAsVague && !/\b(i|we)\b/.test(prompt);
  if (rejectsWithoutChoice) return false;
  const stopsSubagents = /\b(i|we)\s+(do not|don't|dont|no longer|won't|will not)\s+(want(?:\s+to)?\s+)?(use\s+)?subagents?\b/.test(prompt)
    || /\b(stop|disable|turn off|drop|remove|skip)\s+(the\s+)?subagents?\b/.test(prompt)
    || /\b(no more|without)\s+subagents?\b/.test(prompt)
    || /\b(no longer|do not|don't|dont)\s+use\s+(the\s+)?subagents?\b/.test(prompt);
  const choosesMainAgent = /\b(switch|change|move|go|fall back|fallback|use)\s+(to\s+)?(low|main[- ]agent|main agent only|main thread|same thread|manual)\b/.test(prompt)
    || /\b(low|main[- ]agent|main agent only|main thread|same thread|manual)\s+(mode|only)\b/.test(prompt);
  return stopsSubagents && choosesMainAgent;
}

export function hasFreshTeamModeChangeApproval(state: unknown, nowMs = Date.now()): boolean {
  const s = obj(state);
  const team = s && obj(s.team);
  const approval = team && obj(team.modeChangeApproval);
  if (!approval) return false;
  if (approval.from !== 'subagents' || approval.to !== 'main-agent') return false;
  if (approval.source !== 'user-prompt') return false;
  if (typeof approval.promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(approval.promptHash)) return false;
  const requestedAt = typeof approval.requestedAt === 'string' ? Date.parse(approval.requestedAt) : NaN;
  return Number.isFinite(requestedAt) && requestedAt <= nowMs && nowMs - requestedAt <= TEAM_MODE_CHANGE_APPROVAL_TTL_MS;
}

export function setTeamModeChangeApproval(cwd: string, state: unknown, promptText: unknown): boolean {
  const s = obj(state);
  const team = s && obj(s.team);
  if (!s || !team) return false;
  team.modeChangeApproval = {
    from: 'subagents', to: 'main-agent', source: 'user-prompt',
    requestedAt: nowIsoNoMs(), promptHash: hashPromptText(promptText),
  };
  writeState(cwd, s);
  return true;
}

export function clearTeamModeChangeApproval(cwd: string, state: unknown): boolean {
  const s = obj(state);
  const team = s && obj(s.team);
  if (!s || !team) return false;
  if (!Object.prototype.hasOwnProperty.call(team, 'modeChangeApproval')) return false;
  delete team.modeChangeApproval;
  writeState(cwd, s);
  return true;
}

export function updateTeamModeChangeApprovalFromPrompt(cwd: string, state: unknown, promptText: unknown): { recorded: boolean; cleared: boolean } {
  const s = obj(state);
  const team = s && obj(s.team);
  if (!promptText || !String(promptText).trim()) return { recorded: false, cleared: false };
  if (!s || s.onboardingComplete !== true) return { recorded: false, cleared: false };
  if (!team || team.mode !== 'subagents') return { recorded: false, cleared: false };
  if (isExplicitSubagentsToMainAgentIntent(promptText)) {
    setTeamModeChangeApproval(cwd, s, promptText);
    return { recorded: true, cleared: false };
  }
  return { recorded: false, cleared: clearTeamModeChangeApproval(cwd, s) };
}

export function writeLikeStateFileTarget(toolName: unknown, toolInput: unknown): boolean {
  if (!isWriteLikeToolName(toolName)) return false;
  const ti = obj(toolInput);
  const filePath = ti && typeof ti.file_path === 'string' ? ti.file_path : '';
  return isStateFilePath(filePath) || isStateFileOnlyPatch(toolName, toolInput);
}

function replaceOneOrAll(text: string, oldText: unknown, newText: unknown, replaceAll = false): string {
  if (typeof oldText !== 'string' || oldText === '') return text;
  if (typeof newText !== 'string') return text;
  if (replaceAll) return text.split(oldText).join(newText);
  const index = text.indexOf(oldText);
  if (index === -1) return text;
  return `${text.slice(0, index)}${newText}${text.slice(index + oldText.length)}`;
}

function proposedStateTextFromToolInput(cwd: string, toolName: unknown, toolInput: unknown): string | null {
  const normalized = normalizedToolName(toolName);
  const ti = obj(toolInput) || {};
  const currentStatePath = existingStateFilePath(cwd);
  const currentText = fs.existsSync(currentStatePath) ? fs.readFileSync(currentStatePath, 'utf8') : '';
  if (/^Write$/i.test(normalized)) return typeof ti.content === 'string' ? ti.content : null;
  if (/^Edit$/i.test(normalized)) return replaceOneOrAll(currentText, ti.old_string, ti.new_string, ti.replace_all === true);
  if (/^MultiEdit$/i.test(normalized)) {
    let nextText = currentText;
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    for (const edit of edits) {
      const e = obj(edit) || {};
      nextText = replaceOneOrAll(nextText, e.old_string, e.new_string, e.replace_all === true);
    }
    return nextText;
  }
  return null;
}

function proposedStateFromStateWrite(cwd: string, toolName: unknown, toolInput: unknown): Rec | null {
  const text = proposedStateTextFromToolInput(cwd, toolName, toolInput);
  if (typeof text !== 'string') return null;
  let proposed: unknown;
  try {
    proposed = JSON.parse(text);
  } catch {
    return null;
  }
  const p = obj(proposed);
  if (!p) return null;
  const normalized = JSON.parse(JSON.stringify(p)) as Rec;
  normalizeState(normalized, (normalized.mode as string) || detectMode(cwd));
  return normalized;
}

export function proposedTeamModeFromStateWrite(cwd: string, toolName: unknown, toolInput: unknown): string | null {
  const proposed = proposedStateFromStateWrite(cwd, toolName, toolInput);
  if (proposed) {
    const team = obj(proposed.team);
    return team && typeof team.mode === 'string' ? team.mode : null;
  }
  if (/^apply_patch$/i.test(normalizedToolName(toolName))) {
    const patchText = patchTextFromToolInput(toolInput);
    return /^\+\s*"mode"\s*:\s*"main-agent"\s*,?\s*$/m.test(patchText) ? 'main-agent' : null;
  }
  return null;
}

export function proposedStateWritesModeChangeApproval(cwd: string, toolName: unknown, toolInput: unknown): boolean {
  const proposed = proposedStateFromStateWrite(cwd, toolName, toolInput);
  const team = proposed && obj(proposed.team);
  if (team) return Object.prototype.hasOwnProperty.call(team, 'modeChangeApproval');
  if (/^apply_patch$/i.test(normalizedToolName(toolName))) {
    return /^\+.*"modeChangeApproval"\s*:/m.test(patchTextFromToolInput(toolInput));
  }
  return false;
}

// The state-file write proposes adding/refreshing the internal modeChangeApproval
// marker by hand → violation (only the UserPromptSubmit hook may write it).
export function teamModeMarkerWriteViolation(cwd: string, toolName: unknown, toolInput: unknown): boolean {
  if (!writeLikeStateFileTarget(toolName, toolInput)) return false;
  return proposedStateWritesModeChangeApproval(cwd, toolName, toolInput);
}

// The state-file write would downgrade team.mode subagents → main-agent without
// a fresh user-approval marker → violation. A fresh marker is consumed (cleared)
// and the write is allowed (returns false).
export function teamModeDowngradeViolation(cwd: string, toolName: unknown, toolInput: unknown, currentState: unknown): boolean {
  if (!writeLikeStateFileTarget(toolName, toolInput)) return false;
  const s = obj(currentState);
  if (!s || s.onboardingComplete !== true) return false;
  const team = obj(s.team);
  if (!team || team.mode !== 'subagents') return false;
  if (proposedTeamModeFromStateWrite(cwd, toolName, toolInput) !== 'main-agent') return false;
  if (hasFreshTeamModeChangeApproval(s)) {
    clearTeamModeChangeApproval(cwd, s);
    return false;
  }
  return true;
}
