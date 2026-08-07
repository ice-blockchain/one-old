import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { STATE_FILE } from '../../../config/paths';
import { detectHost } from '../../host';
import { readEffectiveState, writeState } from '../../state';
import { hasFreshTeamModeChangeApproval, teamModeMarkerWriteViolation } from '../team-mode-approval';

// The marker has exactly TWO spellings a state file can carry, because there are
// exactly two places a reader looks for it: the top-level `team` the legacy
// scrub used to route, and the `hosts.<host>.team` bucket extractProjectPrefs
// rescues wholesale. Everything below is about the write-time deny agreeing
// with itself across both, whatever tool proposes the write.
function withProject(fn: (cwd: string, host: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-marker-spellings-')));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try { fn(dir, detectHost(env)); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const APPROVAL = {
  from: 'subagents',
  to: 'main-agent',
  source: 'user-prompt',
  requestedAt: new Date().toISOString(),
  promptHash: 'a'.repeat(64),
};

function writeTool(content: unknown): Record<string, unknown> {
  return { file_path: '.traffic-one/.one.json', content: JSON.stringify(content, null, 2) };
}

function seedStateFile(cwd: string, content: unknown): string {
  const filePath = path.join(cwd, STATE_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  return filePath;
}

test('the nested hosts.<host>.team spelling is denied by every write-like tool, not only apply_patch', () => {
  withProject((cwd, host) => {
    const forged = {
      mode: 'new-project',
      hosts: { [host]: { team: { mode: 'subagents', source: 'prompted', modeChangeApproval: APPROVAL } } },
    };

    // Discriminating baseline FIRST: the identical write with the marker taken
    // out is allowed, so a `true` below is the marker and not the host bucket.
    const clean = JSON.parse(JSON.stringify(forged));
    delete clean.hosts[host].team.modeChangeApproval;
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'Write', writeTool(clean)),
      false,
      'fixture guard: a host bucket without the marker is not a violation, so the marker is what is measured',
    );

    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'Write', writeTool(forged)),
      true,
      'Write of a hand-typed hosts.<host>.team.modeChangeApproval must be denied',
    );

    // Same spelling ALONGSIDE a top-level `team`: reach must not depend on what
    // else the proposed state happens to carry.
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'Write', writeTool({ ...forged, team: { mode: 'subagents', source: 'prompted' } })),
      true,
      'a clean top-level team beside the nested marker must not buy the nested marker a pass',
    );

    const filePath = seedStateFile(cwd, { mode: 'new-project', hosts: { [host]: { team: { mode: 'subagents' } } } });
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'Edit', {
        file_path: filePath,
        old_string: '"mode": "subagents"',
        new_string: `"mode": "subagents", "modeChangeApproval": ${JSON.stringify(APPROVAL)}`,
      }),
      true,
      'Edit inserting the nested marker must be denied, exactly as Write is',
    );
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'MultiEdit', {
        file_path: filePath,
        edits: [{
          old_string: '"mode": "subagents"',
          new_string: `"mode": "subagents", "modeChangeApproval": ${JSON.stringify(APPROVAL)}`,
        }],
      }),
      true,
      'MultiEdit inserting the nested marker must be denied, exactly as Write is',
    );
  });
});

// The false-positive question, answered from the writer rather than from a
// reading of it: `hosts` is a LOCAL_PREF_KEY, so splitLocalPreferences deletes
// it on the way into `.one.json`. No product write can therefore propose a
// state carrying a host bucket at all — which is why extending the deny to the
// nested spelling costs nothing that a legitimate write does.
test('no product write can put a host bucket in .one.json, so the nested deny has no legitimate target', () => {
  withProject((cwd, host) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"demo"}\n', 'utf8');
    assert.equal(
      writeState(cwd, {
        mode: 'new-project',
        stack: 'default',
        onboardingComplete: true,
        hosts: { [host]: { team: { mode: 'subagents', source: 'prompted', modeChangeApproval: APPROVAL } } },
      }),
      true,
      'writable baseline: the state write itself lands',
    );
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, STATE_FILE), 'utf8')) as Record<string, unknown>;
    assert.equal(
      Object.prototype.hasOwnProperty.call(onDisk, 'hosts'),
      false,
      'a state file written by the product carries no `hosts` key, so it can never carry the nested marker',
    );
    assert.equal(
      hasFreshTeamModeChangeApproval(readEffectiveState(cwd)),
      false,
      'and the marker that was offered reached no reader (the prefs split drops it out of a rescued bucket)',
    );
  });
});

test('a write that REMOVES a planted nested marker stays allowed', () => {
  withProject((cwd, host) => {
    const planted = {
      mode: 'new-project',
      hosts: { [host]: { team: { mode: 'subagents', source: 'prompted', modeChangeApproval: APPROVAL } } },
    };
    const filePath = seedStateFile(cwd, planted);
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'Write', writeTool(planted)),
      true,
      'fixture guard: the planted marker is the thing being removed',
    );
    const cleaned = JSON.parse(JSON.stringify(planted));
    delete cleaned.hosts[host].team.modeChangeApproval;
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'Write', writeTool(cleaned)),
      false,
      'an agent cleaning a planted marker out of the state file must not be wedged by the guard',
    );
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'apply_patch', {
        patchText: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-  "modeChangeApproval": {},\n*** End Patch\n`,
      }),
      false,
      'and the patch spelling of the same removal, which only ADDED lines are matched against',
    );
  });
});

// The reach that was already there, pinned so the two arms cannot drift apart
// again: apply_patch never reaches the structured arm at all
// (proposedStateTextFromToolInput has no apply_patch case, so the parsed state
// is always null for it), which is why its text match has always caught the
// nested spelling regardless of any top-level `team`.
test('apply_patch denies the nested spelling with or without a top-level team', () => {
  withProject((cwd) => {
    const patch = (lines: string[]): Record<string, unknown> => ({
      patchText: `*** Begin Patch\n*** Update File: .traffic-one/.one.json\n@@\n${lines.map((l) => `+${l}`).join('\n')}\n*** End Patch\n`,
    });
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'apply_patch', patch([
        '  "hosts": { "claude": { "team": {',
        '    "modeChangeApproval": { "from": "subagents" } } } }',
      ])),
      true,
      'nested marker alone',
    );
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'apply_patch', patch([
        '  "team": { "mode": "subagents" },',
        '  "hosts": { "claude": { "team": {',
        '    "modeChangeApproval": { "from": "subagents" } } } }',
      ])),
      true,
      'nested marker beside a top-level team — the structured arm never runs for apply_patch, so nothing short-circuits this',
    );
    assert.equal(
      teamModeMarkerWriteViolation(cwd, 'apply_patch', patch(['  "team": { "mode": "subagents" }'])),
      false,
      'fixture guard: a patch with no marker line is allowed, so the two above measure the marker',
    );
  });
});
