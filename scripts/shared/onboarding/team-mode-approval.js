"use strict";
// src/shared/onboarding/team-mode-approval.ts
// The team-mode-change-approval marker subsystem: a single-use, TTL-bounded
// marker written ONLY by the UserPromptSubmit hook after an explicit user
// request to drop subagents, then consumed once by the onboarding gate to allow
// a team.mode="subagents" → "main-agent" downgrade. Ported 1:1 from _helpers.cjs.
// Pure state logic — the guard DENY PROSE lives in the onboarding-gate skill;
// the guards here return a boolean "violates?" so callers map it to prose.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEAM_MODE_CHANGE_APPROVAL_TTL_MS = void 0;
exports.hashPromptText = hashPromptText;
exports.isExplicitSubagentsToMainAgentIntent = isExplicitSubagentsToMainAgentIntent;
exports.hasFreshTeamModeChangeApproval = hasFreshTeamModeChangeApproval;
exports.setTeamModeChangeApproval = setTeamModeChangeApproval;
exports.clearTeamModeChangeApproval = clearTeamModeChangeApproval;
exports.updateTeamModeChangeApprovalFromPrompt = updateTeamModeChangeApprovalFromPrompt;
exports.writeLikeStateFileTarget = writeLikeStateFileTarget;
exports.proposedTeamModeFromStateWrite = proposedTeamModeFromStateWrite;
exports.proposedStateWritesModeChangeApproval = proposedStateWritesModeChangeApproval;
exports.teamModeMarkerWriteViolation = teamModeMarkerWriteViolation;
exports.teamModeDowngradeViolation = teamModeDowngradeViolation;
const obj_1 = require("../obj");
const detection_1 = require("../detection");
const state_1 = require("../state");
const text_1 = require("../text");
const tool_classify_1 = require("../tool-classify");
const fs = __importStar(require("fs"));
exports.TEAM_MODE_CHANGE_APPROVAL_TTL_MS = 10 * 60 * 1000;
function hashPromptText(promptText) {
    return (0, text_1.sha256)(String(promptText || '').trim());
}
// True only for an explicit "I no longer want subagents, use Low/main-agent"
// user statement — both a stop-subagents intent AND a main-agent choice.
function isExplicitSubagentsToMainAgentIntent(promptText) {
    const prompt = String(promptText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!prompt)
        return false;
    const rejectsAsVague = /\b(subagents?\s+(are|is)\s+unavailable|subagents?\s+(are|is)\s+blocked|subagents?\s+(do|does)\s+not\s+work)\b/.test(prompt);
    const rejectsWithoutChoice = rejectsAsVague && !/\b(i|we)\b/.test(prompt);
    if (rejectsWithoutChoice)
        return false;
    const stopsSubagents = /\b(i|we)\s+(do not|don't|dont|no longer|won't|will not)\s+(want(?:\s+to)?\s+)?(use\s+)?subagents?\b/.test(prompt)
        || /\b(stop|disable|turn off|drop|remove|skip)\s+(the\s+)?subagents?\b/.test(prompt)
        || /\b(no more|without)\s+subagents?\b/.test(prompt)
        || /\b(no longer|do not|don't|dont)\s+use\s+(the\s+)?subagents?\b/.test(prompt);
    const choosesMainAgent = /\b(switch|change|move|go|fall back|fallback|use)\s+(to\s+)?(low|main[- ]agent|main agent only|main thread|same thread|manual)\b/.test(prompt)
        || /\b(low|main[- ]agent|main agent only|main thread|same thread|manual)\s+(mode|only)\b/.test(prompt);
    return stopsSubagents && choosesMainAgent;
}
function hasFreshTeamModeChangeApproval(state, nowMs = Date.now()) {
    const s = (0, obj_1.obj)(state);
    const team = s && (0, obj_1.obj)(s.team);
    const approval = team && (0, obj_1.obj)(team.modeChangeApproval);
    if (!approval)
        return false;
    if (approval.from !== 'subagents' || approval.to !== 'main-agent')
        return false;
    if (approval.source !== 'user-prompt')
        return false;
    if (typeof approval.promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(approval.promptHash))
        return false;
    const requestedAt = typeof approval.requestedAt === 'string' ? Date.parse(approval.requestedAt) : NaN;
    return Number.isFinite(requestedAt) && requestedAt <= nowMs && nowMs - requestedAt <= exports.TEAM_MODE_CHANGE_APPROVAL_TTL_MS;
}
function setTeamModeChangeApproval(cwd, state, promptText) {
    const s = (0, obj_1.obj)(state);
    const team = s && (0, obj_1.obj)(s.team);
    if (!s || !team)
        return false;
    team.modeChangeApproval = {
        from: 'subagents', to: 'main-agent', source: 'user-prompt',
        requestedAt: (0, text_1.nowIsoNoMs)(), promptHash: hashPromptText(promptText),
    };
    (0, state_1.writeState)(cwd, s);
    return true;
}
function clearTeamModeChangeApproval(cwd, state) {
    const s = (0, obj_1.obj)(state);
    const team = s && (0, obj_1.obj)(s.team);
    if (!s || !team)
        return false;
    if (!Object.prototype.hasOwnProperty.call(team, 'modeChangeApproval'))
        return false;
    delete team.modeChangeApproval;
    (0, state_1.writeState)(cwd, s);
    return true;
}
function updateTeamModeChangeApprovalFromPrompt(cwd, state, promptText) {
    const s = (0, obj_1.obj)(state);
    const team = s && (0, obj_1.obj)(s.team);
    if (!promptText || !String(promptText).trim())
        return { recorded: false, cleared: false };
    if (!s || s.onboardingComplete !== true)
        return { recorded: false, cleared: false };
    if (!team || team.mode !== 'subagents')
        return { recorded: false, cleared: false };
    if (isExplicitSubagentsToMainAgentIntent(promptText)) {
        setTeamModeChangeApproval(cwd, s, promptText);
        return { recorded: true, cleared: false };
    }
    return { recorded: false, cleared: clearTeamModeChangeApproval(cwd, s) };
}
function writeLikeStateFileTarget(toolName, toolInput) {
    if (!(0, tool_classify_1.isWriteLikeToolName)(toolName))
        return false;
    const ti = (0, obj_1.obj)(toolInput);
    const filePath = ti && typeof ti.file_path === 'string' ? ti.file_path : '';
    return (0, tool_classify_1.isStateFilePath)(filePath) || (0, tool_classify_1.isStateFileOnlyPatch)(toolName, toolInput);
}
function replaceOneOrAll(text, oldText, newText, replaceAll = false) {
    if (typeof oldText !== 'string' || oldText === '')
        return text;
    if (typeof newText !== 'string')
        return text;
    if (replaceAll)
        return text.split(oldText).join(newText);
    const index = text.indexOf(oldText);
    if (index === -1)
        return text;
    return `${text.slice(0, index)}${newText}${text.slice(index + oldText.length)}`;
}
function proposedStateTextFromToolInput(cwd, toolName, toolInput) {
    const normalized = (0, tool_classify_1.normalizedToolName)(toolName);
    const ti = (0, obj_1.obj)(toolInput) || {};
    const currentStatePath = (0, tool_classify_1.existingStateFilePath)(cwd);
    const currentText = fs.existsSync(currentStatePath) ? fs.readFileSync(currentStatePath, 'utf8') : '';
    if (/^Write$/i.test(normalized))
        return typeof ti.content === 'string' ? ti.content : null;
    if (/^Edit$/i.test(normalized))
        return replaceOneOrAll(currentText, ti.old_string, ti.new_string, ti.replace_all === true);
    if (/^MultiEdit$/i.test(normalized)) {
        let nextText = currentText;
        const edits = Array.isArray(ti.edits) ? ti.edits : [];
        for (const edit of edits) {
            const e = (0, obj_1.obj)(edit) || {};
            nextText = replaceOneOrAll(nextText, e.old_string, e.new_string, e.replace_all === true);
        }
        return nextText;
    }
    return null;
}
function proposedStateFromStateWrite(cwd, toolName, toolInput) {
    const text = proposedStateTextFromToolInput(cwd, toolName, toolInput);
    if (typeof text !== 'string')
        return null;
    let proposed;
    try {
        proposed = JSON.parse(text);
    }
    catch {
        return null;
    }
    const p = (0, obj_1.obj)(proposed);
    if (!p)
        return null;
    const normalized = JSON.parse(JSON.stringify(p));
    (0, state_1.normalizeState)(normalized, normalized.mode || (0, detection_1.detectMode)(cwd));
    return normalized;
}
function proposedTeamModeFromStateWrite(cwd, toolName, toolInput) {
    const proposed = proposedStateFromStateWrite(cwd, toolName, toolInput);
    if (proposed) {
        const team = (0, obj_1.obj)(proposed.team);
        return team && typeof team.mode === 'string' ? team.mode : null;
    }
    if (/^apply_patch$/i.test((0, tool_classify_1.normalizedToolName)(toolName))) {
        const patchText = (0, tool_classify_1.patchTextFromToolInput)(toolInput);
        return /^\+\s*"mode"\s*:\s*"main-agent"\s*,?\s*$/m.test(patchText) ? 'main-agent' : null;
    }
    return null;
}
function proposedStateWritesModeChangeApproval(cwd, toolName, toolInput) {
    const proposed = proposedStateFromStateWrite(cwd, toolName, toolInput);
    const team = proposed && (0, obj_1.obj)(proposed.team);
    if (team)
        return Object.prototype.hasOwnProperty.call(team, 'modeChangeApproval');
    if (/^apply_patch$/i.test((0, tool_classify_1.normalizedToolName)(toolName))) {
        return /^\+.*"modeChangeApproval"\s*:/m.test((0, tool_classify_1.patchTextFromToolInput)(toolInput));
    }
    return false;
}
// The state-file write proposes adding/refreshing the internal modeChangeApproval
// marker by hand → violation (only the UserPromptSubmit hook may write it).
function teamModeMarkerWriteViolation(cwd, toolName, toolInput) {
    if (!writeLikeStateFileTarget(toolName, toolInput))
        return false;
    return proposedStateWritesModeChangeApproval(cwd, toolName, toolInput);
}
// The state-file write would downgrade team.mode subagents → main-agent without
// a fresh user-approval marker → violation. A fresh marker is consumed (cleared)
// and the write is allowed (returns false).
function teamModeDowngradeViolation(cwd, toolName, toolInput, currentState) {
    if (!writeLikeStateFileTarget(toolName, toolInput))
        return false;
    const s = (0, obj_1.obj)(currentState);
    if (!s || s.onboardingComplete !== true)
        return false;
    const team = (0, obj_1.obj)(s.team);
    if (!team || team.mode !== 'subagents')
        return false;
    if (proposedTeamModeFromStateWrite(cwd, toolName, toolInput) !== 'main-agent')
        return false;
    if (hasFreshTeamModeChangeApproval(s)) {
        clearTeamModeChangeApproval(cwd, s);
        return false;
    }
    return true;
}
