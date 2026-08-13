// src/shared/onboarding/team-mode-approval.ts
// The team-mode-change-approval marker subsystem: a single-use, TTL-bounded
// marker written ONLY by the UserPromptSubmit hook after an explicit user
// request to drop subagents, then consumed once by the onboarding gate to allow
// a team.mode="subagents" → "main-agent" downgrade. Ported 1:1 from _helpers.cjs.
// Pure state logic — the guard DENY PROSE lives in the onboarding-gate skill;
// the guards here return a boolean "violates?" so callers map it to prose.

import { obj, type Rec } from '../obj';
import { detectMode } from '../detection';
import { detectHost } from '../host';
import { mergeProjectHostPrefs, normalizeState, readEffectiveState } from '../state';
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

import { TEAM_MODE_CHANGE_APPROVAL_TTL_MS } from '../../config/onboarding';
import { readRegularFileOrThrow } from '../bounded-read';

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

/**
 * Persist (or withdraw) the marker WHERE THE GATE READS IT, and answer whether
 * the gate can now see it.
 *
 * Not `writeState`, which is what both writers used to call, and the reason this
 * subsystem never worked: `team` is a HOST preference
 * (state/local-prefs/pref-schema.ts's HOST_PREF_KEYS), so writeState's
 * splitLocalPreferences STRIPS it out of the shared state file, while
 * extractProjectPrefs deliberately refuses to route a generic top-level `team`
 * into the per-user store ("so they cannot be attributed to whichever host
 * happens to scrub the shared file first"). Measured on a consented, onboarded,
 * subagents-mode project: writeState reported no error, `.one.json` came back
 * with no `team` at all, the per-user prefs were untouched, and
 * `hasFreshTeamModeChangeApproval(readEffectiveState(cwd))` — the exact question
 * the downgrade gate asks — was false. So a returned boolean from the write
 * could not have caught this: the write LANDED, and the field was gone before
 * it. Only reading back what the consumer reads can.
 *
 * The per-user host bucket is where `team.mode` itself lives, so the
 * authorization sits beside the setting it authorizes, and the prefs schema
 * already expects it there: `normalizeTeam` keeps `modeChangeApproval` while
 * mode is `subagents` and drops it otherwise — which also retires the marker for
 * free once the downgrade it authorized has landed.
 *
 * What the placement does NOT buy on its own is unforgeability, and the earlier
 * version of this note claimed it did. Being outside the project tree is not a
 * fence: writeState routes local-preference fields FROM the agent-writable,
 * committed state file INTO this store, so what actually keeps a hand-typed
 * marker out is that state/local-prefs/prefs-split.ts refuses to carry it. For a
 * generic top-level `team` that refusal was already there ("cannot be attributed
 * to whichever host happens to scrub the shared file first"), and it is what
 * makes teamModeMarkerWriteViolation's top-level check sufficient. The
 * `hosts.<host>.team.modeChangeApproval` spelling was not covered by either:
 * `hosts` is rescued wholesale, so — measured on an agent-authored
 * `.one.json` — the SessionStart scrub routed a hand-typed marker into this
 * store, `hasFreshTeamModeChangeApproval(readEffectiveState(cwd))` answered
 * true, and teamModeDowngradeViolation then ALLOWED the downgrade it exists to
 * deny. extractProjectPrefs now drops `modeChangeApproval` out of any rescued
 * host bucket (state/__tests__/state-file-authorization-forgery.test.ts).
 */
function persistTeamModeApproval(cwd: string, team: Rec, approval: Rec | null): boolean {
  const nextTeam: Rec = { ...team };
  if (approval) nextTeam.modeChangeApproval = approval;
  else delete nextTeam.modeChangeApproval;
  try {
    mergeProjectHostPrefs(cwd, detectHost(), { team: nextTeam });
  } catch {
    // The per-user store re-throws a real errno (EACCES/ENOSPC). Nothing landed,
    // and a hook must not fail a tool call over it — report the refusal instead.
    return false;
  }
  const readBack = obj(readEffectiveState(cwd).team);
  return approval
    // The consumer's own predicate on the consumer's own data source: stronger
    // than a hash compare here, because it is not a proxy for what the gate will
    // conclude, it IS what the gate concludes.
    ? hasFreshTeamModeChangeApproval(readEffectiveState(cwd))
    // Absence, not staleness: `hasFreshTeamModeChangeApproval` is also false for
    // an EXPIRED marker, so testing it here would report a refused withdrawal of
    // a stale marker as a successful one.
    : !(readBack && Object.prototype.hasOwnProperty.call(readBack, 'modeChangeApproval'));
}

// True only when the approval is READABLE BY THE GATE afterwards. `true` here is
// the claim "the user's authorization to move team mode from subagents to
// main-agent is recorded", and prompt-submit tells the user exactly that, so it
// may not be minted by this function — it has to be observed.
export function setTeamModeChangeApproval(cwd: string, state: unknown, promptText: unknown): boolean {
  const s = obj(state);
  const team = s && obj(s.team);
  if (!s || !team) return false;
  const approval: Rec = {
    from: 'subagents', to: 'main-agent', source: 'user-prompt',
    requestedAt: nowIsoNoMs(), promptHash: hashPromptText(promptText),
  };
  team.modeChangeApproval = approval;
  return persistTeamModeApproval(cwd, team, approval);
}

// True only when the approval is GONE from the gate's view afterwards. A `true`
// that outlives the marker is a single-use authorization nobody can withdraw.
export function clearTeamModeChangeApproval(cwd: string, state: unknown): boolean {
  const s = obj(state);
  const team = s && obj(s.team);
  if (!s || !team) return false;
  if (!Object.prototype.hasOwnProperty.call(team, 'modeChangeApproval')) return false;
  delete team.modeChangeApproval;
  return persistTeamModeApproval(cwd, team, null);
}

export function updateTeamModeChangeApprovalFromPrompt(cwd: string, state: unknown, promptText: unknown): { recorded: boolean; cleared: boolean } {
  const s = obj(state);
  const team = s && obj(s.team);
  if (!promptText || !String(promptText).trim()) return { recorded: false, cleared: false };
  if (!s || s.onboardingComplete !== true) return { recorded: false, cleared: false };
  if (!team || team.mode !== 'subagents') return { recorded: false, cleared: false };
  if (isExplicitSubagentsToMainAgentIntent(promptText)) {
    // Forwarded, never asserted. `recorded: true` reaches the user as
    // "[team mode switch authorized]" on the very next prompt (session/
    // prompt-submit.ts), and the only thing that can honour it is the marker the
    // downgrade gate reads out of the per-user store in a LATER hook process.
    return { recorded: setTeamModeChangeApproval(cwd, s, promptText), cleared: false };
  }
  return { recorded: false, cleared: clearTeamModeChangeApproval(cwd, s) };
}

function writeLikeStateFileTarget(toolName: unknown, toolInput: unknown): boolean {
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
  const currentText = fs.existsSync(currentStatePath) ? readRegularFileOrThrow(currentStatePath) : '';
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

function proposedTeamModeFromStateWrite(cwd: string, toolName: unknown, toolInput: unknown): string | null {
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

// Every `team` object a state file can carry that some reader will look at —
// which is the whole vocabulary of spellings the marker HAS. Top-level `team` is
// what the legacy generic scrub used to route; `hosts.<host>.team` is the bucket
// extractProjectPrefs rescues wholesale, and the one an agent-authored
// `.one.json` used to smuggle a marker through (prefs-split.ts's
// hostsWithoutForgedApprovals). A `modeChangeApproval` key anywhere ELSE in the
// state file is not this predicate's business: no reader resolves it.
function proposedTeamObjects(proposed: Rec): Rec[] {
  const teams: Rec[] = [];
  const top = obj(proposed.team);
  if (top) teams.push(top);
  const hosts = obj(proposed.hosts);
  if (hosts) {
    for (const bucket of Object.values(hosts)) {
      const team = obj(obj(bucket)?.team);
      if (team) teams.push(team);
    }
  }
  return teams;
}

function proposedStateWritesModeChangeApproval(cwd: string, toolName: unknown, toolInput: unknown): boolean {
  const proposed = proposedStateFromStateWrite(cwd, toolName, toolInput);
  if (proposed) {
    return proposedTeamObjects(proposed)
      .some((team) => Object.prototype.hasOwnProperty.call(team, 'modeChangeApproval'));
  }
  if (/^apply_patch$/i.test(normalizedToolName(toolName))) {
    return /^\+.*"modeChangeApproval"\s*:/m.test(patchTextFromToolInput(toolInput));
  }
  return false;
}

// The state-file write proposes adding/refreshing the internal modeChangeApproval
// marker by hand → violation (only the UserPromptSubmit hook may write it).
//
// REACH, stated exactly, because the two arms below still do not agree and it is
// worth knowing where. The split is by TOOL, not by input: for apply_patch,
// proposedStateTextFromToolInput has no case at all, so the parsed state is
// ALWAYS null and the text arm ALWAYS runs — the structured arm's early return
// can never short-circuit it. Measured on a state-file patch carrying both a
// top-level `team` line and a nested marker line: denied.
//
// So the structured arm owns Write/Edit/MultiEdit and the text arm owns
// apply_patch, and what remains between them is a difference of KIND rather
// than of coverage. The structured arm now asks about both spellings a reader
// resolves (top-level `team`, and every `hosts.<host>.team` — see
// proposedTeamObjects); the text arm matches the key name on any added line, so
// it also denies a `modeChangeApproval` buried somewhere no reader looks. That
// residual over-reach is left alone deliberately: narrowing a deny to close a
// cosmetic disagreement trades a false positive nobody has hit for a hole.
//
// This predicate is a SECOND LINE and must not be read as the fence around the
// marker. The first line is the prefs split: extractProjectPrefs drops
// modeChangeApproval out of any rescued host bucket, so the nested write already
// reaches nothing (see persistTeamModeApproval's header for the measurement).
// The nested arm is here for the same reason the top-level arm is — that one is
// also redundant with a prefs-layer refusal, and it is kept because an agent
// hand-writing the marker should be TOLD, not silently ignored. The cost was
// measured before it shipped: `hosts` is a LOCAL_PREF_KEY, so
// splitLocalPreferences deletes it on the way into `.one.json` and no product
// write can propose a state carrying a host bucket at all
// (__tests__/team-mode-marker-spellings.test.ts).
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
    // Allowing this write is how the marker is SPENT, so a withdrawal that did
    // not land leaves the same authorization readable for the rest of its TTL and
    // admits every further downgrade inside it. Deny rather than spend a token we
    // could not cancel: the header calls this marker single-use, and the deny
    // prose tells the user how to re-authorize, whereas a token that never
    // retires is silent. (The `return true` below is the other half of the same
    // fail-closed rule — absent approval, absent authorization.)
    return !clearTeamModeChangeApproval(cwd, s);
  }
  return true;
}
