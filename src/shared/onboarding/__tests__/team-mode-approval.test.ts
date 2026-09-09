import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { TEAM_MODE_CHANGE_APPROVAL_TTL_MS } from '../../../config/onboarding';
import { STATE_FILE } from '../../../config/paths';
import { detectHost } from '../../host';
import { mergeProjectHostPrefs, readEffectiveState, writeState } from '../../state';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';
import {
  clearTeamModeChangeApproval,
  hasFreshTeamModeChangeApproval,
  hashPromptText,
  isExplicitSubagentsToMainAgentIntent,
  setTeamModeChangeApproval,
  teamModeDowngradeViolation,
  teamModeMarkerWriteViolation,
  updateTeamModeChangeApprovalFromPrompt,
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

// ── the marker has to cross a PROCESS boundary ───────────────────────────────
// UserPromptSubmit records the approval; a later PreToolUse event reads it. Hooks
// run one process per event, so the in-memory state object every test above
// shares is not a channel — disk is the only one. These cases therefore never
// hand the gate the object the writer mutated: they re-read through
// readEffectiveState, exactly as modules/onboarding-gate/handler.ts does.
//
// A fully consented, onboarded, subagents-mode project, because that is the only
// shape in which the downgrade guard is armed at all.
function withOnboardedSubagentsProject(fn: (project: string, blockPrefsStore: () => void) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-teammode-e2e-')));
  const project = path.join(base, 'project');
  const env = process.env;
  const saved = {
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    ask: env.TRAFFIC_ONE_ASK_USE_PLUGIN,
    home: env.HOME,
    xdg: env.XDG_STATE_HOME,
  };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}\n', 'utf8');
  resetPluginUseCache();
  recordPluginUseChoice(project, true, 'test');
  resetPluginUseCache();
  writeState(project, { mode: 'new-project', stack: 'default', onboardingComplete: true });
  mergeProjectHostPrefs(project, detectHost(), { team: { mode: 'subagents', source: 'prompted', approved: true } });

  // The single-path instrument. The per-user prefs store is NOT reachable by the
  // consent/symlink fence in shared/fsjson.ts (it is outside every project, so
  // classifyStateWrite calls it 'plain'), and writeProjectPrefsFile uses raw fs
  // and re-throws. So the one refusal that reaches this writer is an errno on
  // that store: point the prefs path at a child of a regular FILE and its
  // recursive mkdir can only fail with ENOTDIR. The project tree, `.one.json` and
  // every other path stay writable.
  const blockPrefsStore = (): void => {
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a directory\n', 'utf8');
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(blocker, 'prefs.json');
  };
  try { fn(project, blockPrefsStore); } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ASK_USE_PLUGIN: saved.ask,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
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

test('set/clear/update team-mode-change approval round-trips in memory', () => {
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

test('teamModeDowngradeViolation reads nested hosts.*.team.mode, not only top-level team.mode', () => {
  withProject((cwd) => {
    const current: Record<string, unknown> = { onboardingComplete: true, team: { mode: 'subagents', source: 'prompted' } };
    const nested = writeStateTool({
      mode: 'new-project',
      hosts: { claude: { team: { mode: 'main-agent', source: 'prompted' } } },
    });
    assert.equal(
      teamModeDowngradeViolation(cwd, 'Write', nested, current),
      true,
      'hosts.<host>.team.mode=main-agent is the downgrade the guard exists to see',
    );
    const stillSubagents = writeStateTool({
      mode: 'new-project',
      hosts: { claude: { team: { mode: 'subagents', source: 'prompted' } } },
    });
    assert.equal(
      teamModeDowngradeViolation(cwd, 'Write', stillSubagents, current),
      false,
      'a nested team.mode that stays subagents is not a downgrade',
    );
  });
});

test('teamModeDowngradeViolation sees a case-folded state file path and ignores .traffic-one-backup', () => {
  withProject((cwd) => {
    const current: Record<string, unknown> = { onboardingComplete: true, team: { mode: 'subagents', source: 'prompted' } };
    const content = JSON.stringify({ mode: 'new-project', team: { mode: 'main-agent', source: 'prompted' } });
    assert.equal(
      teamModeDowngradeViolation(cwd, 'Write', { file_path: '.Traffic-One/.one.json', content }, current),
      true,
    );
    assert.equal(
      teamModeDowngradeViolation(cwd, 'Write', { file_path: '.TRAFFIC-ONE/.one.json', content }, current),
      true,
    );
    assert.equal(
      teamModeDowngradeViolation(cwd, 'Write', { file_path: '.traffic-one-backup/.one.json', content }, current),
      false,
    );
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

// A state-file Write proposing the subagents -> main-agent downgrade: the tool
// call the marker exists to authorize.
const DOWNGRADE_TOOL = {
  file_path: '.traffic-one/.one.json',
  content: JSON.stringify({ mode: 'new-project', team: { mode: 'main-agent', source: 'prompted' } }),
};

// The failure this pair of writers was reported for: `true` meaning "the user's
// authorization is recorded" while nothing a later hook process can read exists.
//
// It was NOT a dropped boolean. Both writers persisted through
// `writeState(cwd, s)`, and `team` is a HOST preference, so
// splitLocalPreferences stripped it out of `.one.json` and extractProjectPrefs
// declined to route a generic top-level `team` into the per-user store: the write
// SUCCEEDED and the field was gone before it. A boolean forwarded out of
// writeState would have been `true`, so only reading back what the consumer reads
// can catch this — which is why the assertion below is the GATE's verdict and not
// the writer's return value alone.
test('the approval a caller is told was recorded is the one the downgrade gate reads', () => {
  withOnboardedSubagentsProject((project) => {
    // Baseline first: on this project the gate is armed and denies without a marker.
    assert.equal(
      teamModeDowngradeViolation(project, 'Write', DOWNGRADE_TOOL, readEffectiveState(project)),
      true,
      'fixture guard: the downgrade guard is armed here, so a later `false` means the marker was read',
    );

    const promptState = readEffectiveState(project);
    const verdict = updateTeamModeChangeApprovalFromPrompt(
      project,
      promptState,
      'I no longer want subagents, use main agent only',
    );
    assert.equal(verdict.recorded, true, 'the writable baseline: a real approval is recorded');

    // The cross-process read. `readEffectiveState` is the gate's own source, and
    // this object was never touched by the writer.
    assert.equal(
      hasFreshTeamModeChangeApproval(readEffectiveState(project)),
      true,
      'the recorded approval must be READABLE by a later hook process, not just in the writer\'s object',
    );
    assert.equal(
      teamModeDowngradeViolation(project, 'Write', DOWNGRADE_TOOL, readEffectiveState(project)),
      false,
      'and it must actually admit the downgrade it authorized — producer and consumer agreeing',
    );
    // Single-use: the marker is spent by the write it admitted.
    assert.equal(hasFreshTeamModeChangeApproval(readEffectiveState(project)), false, 'consumed on disk, not only in memory');
    assert.equal(
      teamModeDowngradeViolation(project, 'Write', DOWNGRADE_TOOL, readEffectiveState(project)),
      true,
      'a spent authorization cannot admit a second downgrade',
    );
  });
});

test('an approval that could not be persisted is reported as NOT recorded', () => {
  withOnboardedSubagentsProject((project, blockPrefsStore) => {
    const state = readEffectiveState(project);
    assert.equal(hasFreshTeamModeChangeApproval(state), false, 'fixture guard: no marker yet');
    assert.ok(state.team, 'fixture guard: the writer needs a team object to attach the approval to');

    blockPrefsStore();
    assert.equal(
      setTeamModeChangeApproval(project, state, 'stop the subagents and use main agent only'),
      false,
      'a permission that reached no store is not a permission the user granted',
    );
    // And the caller prompt-submit actually consults says the same, because it
    // forwards rather than asserting.
    const fresh = readEffectiveState(project);
    fresh.team = { mode: 'subagents', source: 'prompted' };
    fresh.onboardingComplete = true;
    assert.deepEqual(
      updateTeamModeChangeApprovalFromPrompt(project, fresh, 'I no longer want subagents, use main agent only'),
      { recorded: false, cleared: false },
      'so the user is never told "[team mode switch authorized]" over a marker that does not exist',
    );
  });
});

test('a fresh approval whose withdrawal is refused keeps denying, rather than spending a token it cannot cancel', () => {
  withOnboardedSubagentsProject((project, blockPrefsStore) => {
    const state = readEffectiveState(project);
    assert.equal(setTeamModeChangeApproval(project, state, 'use main agent only'), true, 'writable baseline');
    // Re-read so the gate holds a marker it did not mint, then take the store
    // away: the approval is still readable, the withdrawal cannot land.
    const gateState = readEffectiveState(project);
    assert.equal(hasFreshTeamModeChangeApproval(gateState), true, 'fixture guard: the gate can still read the marker');
    blockPrefsStore();

    assert.equal(
      clearTeamModeChangeApproval(project, JSON.parse(JSON.stringify(gateState))),
      false,
      'a withdrawal that did not land must not report itself withdrawn',
    );
    assert.equal(
      teamModeDowngradeViolation(project, 'Write', DOWNGRADE_TOOL, gateState),
      true,
      'so the gate denies: a single-use marker it cannot retire would admit every later downgrade in its TTL',
    );
  });
});
