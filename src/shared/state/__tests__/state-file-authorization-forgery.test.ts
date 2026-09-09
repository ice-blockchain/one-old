import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mergeProjectPrefs, readEffectiveState, readProjectPrefs } from '../local-prefs';
import { scrubProjectStateLocalPrefs } from '../normalize';
import { openCodeDelegationActive } from '../../performance';
import { applyAnswer } from '../../onboarding-server/flow';
import {
  hasFreshTeamModeChangeApproval,
  teamModeDowngradeViolation,
} from '../../onboarding/team-mode-approval';

// Two AUTHORIZATIONS live in the per-user preferences store: the OpenCode
// delegation consent (`openCode`) and the single-use team-mode downgrade marker
// (`hosts.<host>.team.modeChangeApproval`). `.traffic-one/.one.json` is the one
// file an agent may write freely — the onboarding gate stands down for
// state-file writes, because its own prose asks the agent to write that file —
// and it is committed, so it also carries one teammate's answer into another's
// checkout. These tests pin that no spelling of a state-file field becomes
// either authorization, measured on what the CONSUMER reads
// (readProjectPrefs / readEffectiveState / openCodeDelegationActive /
// hasFreshTeamModeChangeApproval), never on a writer's returned boolean, because
// only the read-back catches a write that LANDED with the field transformed en
// route.
const HOST = 'claude';
const STAMP = { opencode: { installedVersion: '9.9.9', installedAt: '2026-08-07T10:00:00Z' } };

function withAgentAuthoredState(
  raw: Record<string, unknown>,
  fn: (cwd: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-consent-forgery-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({
    version: 1, mode: 'maintenance', stack: 'default', confirmed: true, onboardingComplete: true,
    ...raw,
  }, null, 2), 'utf8');
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  // Outside the project tree, exactly like the real per-user store.
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'user-store', 'preferences.json');
  try {
    fn(cwd);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const openCodeOf = (state: Record<string, unknown>): Record<string, unknown> | undefined => (
  state.openCode as Record<string, unknown> | undefined
);

// The full SessionStart chain: session-start.ts runs scrubProjectStateLocalPrefs
// unconditionally, which re-writes the RAW on-disk file through writeState →
// splitLocalPreferences → the per-user store. `toolchain` is the companion field
// that trips hasLocalPreferenceFields (every LOCAL_PREF_KEYS member does, and it
// is the one an agent writing a state file would include anyway).
test('an agent-authored openCodeDelegation record never becomes per-user consent', () => {
  withAgentAuthoredState({
    openCodeDelegation: { approved: true, source: 'onboarding', decidedAt: '2026-08-07T10:00:00Z' },
    toolchain: STAMP,
  }, (cwd) => {
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), false, 'not active before the scrub');
    assert.equal(scrubProjectStateLocalPrefs(cwd), true, 'the scrub still runs and still routes the real prefs');

    assert.equal(openCodeOf(readProjectPrefs(cwd)), undefined, 'the per-user store records no consent');
    assert.equal(openCodeOf(readEffectiveState(cwd)), undefined, 'effective state records no consent');
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), false);
    // The scrub's own subject still works: the leaked toolchain stamp is routed.
    assert.equal(
      ((readProjectPrefs(cwd).toolchain as Record<string, Record<string, unknown>>).opencode ?? {}).installedVersion,
      '9.9.9',
      'non-authorization local prefs are still rescued out of the committed file',
    );
  });
});

// The second door: `openCode` is itself a PROJECT_PREF_KEYS member, so a
// top-level record needs no `openCodeDelegation` promotion to reach the store. A
// fix that closed only the promotion would be theatre.
test('an agent-authored top-level openCode never becomes per-user consent', () => {
  withAgentAuthoredState({
    openCode: { enabled: true, source: 'prompted', decidedAt: '2026-08-07T10:00:00Z' },
    toolchain: STAMP,
  }, (cwd) => {
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), false, 'not active before the scrub');
    scrubProjectStateLocalPrefs(cwd);
    assert.equal(openCodeOf(readProjectPrefs(cwd)), undefined, 'the per-user store records no consent');
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')) as Record<string, unknown>;
    assert.ok(!('openCode' in onDisk), 'and the leaked field is still stripped from the committed file');
  });
});

// No write is needed at all: readEffectiveState extracts embedded prefs out of
// the raw state file on every read, so the forgery used to be live from the
// moment the file existed — with no companion field and nothing persisted.
test('reading effective state never promotes a state-file consent, with or without a stored answer', () => {
  withAgentAuthoredState({
    openCodeDelegation: { approved: true, source: 'onboarding', decidedAt: '2026-08-07T10:00:00Z' },
  }, (cwd) => {
    mergeProjectPrefs(cwd, { toolchain: STAMP });
    assert.equal(openCodeOf(readEffectiveState(cwd)), undefined, 'unanswered stays unanswered');
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), false);

    // And the worse direction: a consent the user explicitly DECLINED must not be
    // reversed by the state file (mergeProjectPrefsObject replaces an `openCode`
    // patch carrying `enabled`, so the forged record used to win outright).
    mergeProjectPrefs(cwd, { openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' } });
    scrubProjectStateLocalPrefs(cwd);
    assert.equal(openCodeOf(readEffectiveState(cwd))?.enabled, false, 'the decline survives');
    assert.equal(openCodeOf(readProjectPrefs(cwd))?.enabled, false);
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), false);
  });
});

// The OTHER authorization in this store, reached through the `hosts` bucket.
// Nested `team` / `performance` are dropped on rescue (prefs-split.ts); a
// leaked `hosts.<host>.team.modeChangeApproval` must not become a downgrade
// authorization, and nested `team.mode` must not be attributed to a host.
test('an agent-authored hosts.<host>.team.modeChangeApproval never becomes a downgrade authorization', () => {
  const marker = {
    from: 'subagents',
    to: 'main-agent',
    source: 'user-prompt',
    requestedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    promptHash: 'a'.repeat(64),
  };
  withAgentAuthoredState({
    mode: 'new-project',
    hosts: { [HOST]: { team: { mode: 'subagents', source: 'prompted', approved: true, modeChangeApproval: marker } } },
  }, (cwd) => {
    const prevHost = process.env.TRAFFIC_ONE_HOST;
    process.env.TRAFFIC_ONE_HOST = HOST;
    try {
      scrubProjectStateLocalPrefs(cwd);
      const effective = readEffectiveState(cwd);
      assert.equal(
        hasFreshTeamModeChangeApproval(effective),
        false,
        'the gate\'s own predicate, on the gate\'s own data source, sees no authorization',
      );
      // Nested team/performance are no longer rescued — a leaked bucket
      // re-prompts rather than attributing team.mode to the scrubbing host.
      assert.equal(effective.team, undefined, 'hosts.*.team is not a host-attributed approval');
      assert.equal(teamModeDowngradeViolation(cwd, 'Write', {
        file_path: path.join(cwd, '.traffic-one', '.one.json'),
        content: JSON.stringify({ mode: 'new-project', stack: 'default', onboardingComplete: true, team: { mode: 'main-agent', source: 'prompted' } }),
      }, effective), false, 'the downgrade guard is unarmed: leaked team.mode was not attributed');
    } finally {
      if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
      else process.env.TRAFFIC_ONE_HOST = prevHost;
    }
  });
});

// The control. Closing the hole by breaking real consent would be worse than the
// hole, so this drives the wizard's OWN answer handler — not the raw writer —
// and reads the answer back through the consumer.
test('a genuine wizard answer still enables (and still declines) OpenCode delegation', () => {
  withAgentAuthoredState({}, (cwd) => {
    mergeProjectPrefs(cwd, { toolchain: STAMP });

    assert.deepEqual(applyAnswer(cwd, 'open-code', true), { ok: true });
    assert.equal(openCodeOf(readProjectPrefs(cwd))?.enabled, true, 'consent is recorded in the per-user store');
    assert.equal(openCodeOf(readEffectiveState(cwd))?.enabled, true);
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), true, 'delegation is live for a user who answered yes');
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    assert.equal(onDisk.openCodeDelegation?.approved, true, 'the durable authorization record the spawn gate cites still lands');

    assert.deepEqual(applyAnswer(cwd, 'open-code', false), { ok: true });
    assert.equal(openCodeOf(readProjectPrefs(cwd))?.enabled, false, 'and a later decline is honoured');
    assert.equal(openCodeDelegationActive(readEffectiveState(cwd), HOST), false);
  });
});
