import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  clearTeamModeChangeApproval,
  hasFreshTeamModeChangeApproval,
  hashPromptText,
  isExplicitSubagentsToMainAgentIntent,
  setTeamModeChangeApproval,
  teamModeDowngradeViolation,
  teamModeMarkerWriteViolation,
  updateTeamModeChangeApprovalFromPrompt,
  TEAM_MODE_CHANGE_APPROVAL_TTL_MS,
} from '../team-mode-approval';

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-teammode-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A state-file Write tool input carrying `content` (proposedStateTextFromToolInput
// returns it directly for Write).
function writeStateTool(content: Record<string, unknown>): Record<string, unknown> {
  return { file_path: '.traffic-one/.one.json', content: JSON.stringify(content) };
}

test('isExplicitSubagentsToMainAgentIntent needs both stop-subagents AND main-agent choice', () => {
  assert.equal(isExplicitSubagentsToMainAgentIntent('I no longer want subagents, switch to low mode'), true);
  assert.equal(isExplicitSubagentsToMainAgentIntent('stop the subagents and use main agent only'), true);
  // vague unavailability is not an explicit choice
  assert.equal(isExplicitSubagentsToMainAgentIntent('subagents are unavailable'), false);
  // stop without a main-agent choice
  assert.equal(isExplicitSubagentsToMainAgentIntent('drop the subagents'), false);
  assert.equal(isExplicitSubagentsToMainAgentIntent(''), false);
});

test('hasFreshTeamModeChangeApproval validates shape + TTL', () => {
  const fresh = { team: { modeChangeApproval: { from: 'subagents', to: 'main-agent', source: 'user-prompt', promptHash: hashPromptText('x'), requestedAt: new Date().toISOString() } } };
  assert.equal(hasFreshTeamModeChangeApproval(fresh), true);
  // stale
  const stale = JSON.parse(JSON.stringify(fresh));
  stale.team.modeChangeApproval.requestedAt = new Date(Date.now() - TEAM_MODE_CHANGE_APPROVAL_TTL_MS - 1000).toISOString();
  assert.equal(hasFreshTeamModeChangeApproval(stale), false);
  // wrong direction
  const wrong = JSON.parse(JSON.stringify(fresh));
  wrong.team.modeChangeApproval.to = 'subagents';
  assert.equal(hasFreshTeamModeChangeApproval(wrong), false);
  assert.equal(hasFreshTeamModeChangeApproval({}), false);
});

test('set/clear/update team-mode-change approval round-trips through writeState', () => {
  withProject((cwd) => {
    const state: Record<string, unknown> = { onboardingComplete: true, team: { mode: 'subagents', source: 'prompted' } };
    assert.equal(setTeamModeChangeApproval(cwd, state, 'use main agent only'), true);
    assert.equal(hasFreshTeamModeChangeApproval(state), true);
    assert.equal(clearTeamModeChangeApproval(cwd, state), true);
    assert.equal(hasFreshTeamModeChangeApproval(state), false);
    // update from an explicit prompt records it; a normal prompt clears it
    const u1 = updateTeamModeChangeApprovalFromPrompt(cwd, state, 'I no longer want subagents, use low main-agent mode');
    assert.equal(u1.recorded, true);
    const u2 = updateTeamModeChangeApprovalFromPrompt(cwd, state, 'add a login page');
    assert.equal(u2.cleared, true);
  });
});

test('teamModeMarkerWriteViolation flags a hand-written modeChangeApproval marker', () => {
  withProject((cwd) => {
    const tool = writeStateTool({ mode: 'new-project', team: { mode: 'subagents', source: 'prompted', modeChangeApproval: { from: 'subagents', to: 'main-agent' } } });
    assert.equal(teamModeMarkerWriteViolation(cwd, 'Write', tool), true);
    // a plain write without the marker is fine
    const clean = writeStateTool({ mode: 'new-project', team: { mode: 'subagents', source: 'prompted' } });
    assert.equal(teamModeMarkerWriteViolation(cwd, 'Write', clean), false);
  });
});

test('teamModeDowngradeViolation blocks subagents→main-agent without a fresh approval, consumes a fresh one', () => {
  withProject((cwd) => {
    const tool = writeStateTool({ mode: 'new-project', team: { mode: 'main-agent', source: 'prompted' } });
    const current: Record<string, unknown> = { onboardingComplete: true, team: { mode: 'subagents', source: 'prompted' } };
    assert.equal(teamModeDowngradeViolation(cwd, 'Write', tool, current), true);
    // with a fresh approval marker → allowed (and the marker is consumed)
    setTeamModeChangeApproval(cwd, current, 'use main agent only');
    assert.equal(teamModeDowngradeViolation(cwd, 'Write', tool, current), false);
    assert.equal(hasFreshTeamModeChangeApproval(current), false); // consumed
  });
});
