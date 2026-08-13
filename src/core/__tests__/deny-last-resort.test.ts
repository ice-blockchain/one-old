// src/core/__tests__/deny-last-resort.test.ts
// The UNREACHABLE half of core/result.ts's lastResortDenyReason, plus the two
// properties the paragraph's shape has to hold.
//
// The REACHABLE half — a plugin root with no skill trees, where the notice is
// what the agent reads instead of `''` — is in the sibling file
// deny-last-resort-torn-install.test.ts. It is a separate FILE because
// shared/skill-block.ts memoizes a module's SKILL.md text per process, so one
// process can only ever demonstrate one of the two roots; see that file's
// header. Both directions are required: a notice that is reachable but not inert
// reddens every other suite, and one that is inert but unreachable is dead code.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askUser, deny, lastResortDenyReason } from '../result';
import { absoluteTrafficOnePathDeny } from '../../modules/agent-model/spawn-hygiene';
import {
  DENY_REPEAT_ESCALATE_AT, PLUGIN_ROOT_SIGNATURE_TOKEN, denySignature, withoutInstallLocation,
} from '../../shared/state/deny-repeat';
import { pluginRoot } from '../../shared/paths';

// ── inert on a healthy tree ──────────────────────────────────────────────────
// The plugin root here is THIS checkout (pinned by src/build/test-preload.mjs),
// so every T1BLOCK resolves. The same gate the torn-install file drives must
// render its real prose and never the notice.
test('on a healthy plugin root the notice is unreachable: the gate renders its own prose', () => {
  const result = absoluteTrafficOnePathDeny(['/other/proj/.traffic-one/runs/1/x.md'], '/proj');
  assert.equal(result.kind, 'deny');
  if (result.kind !== 'deny') return;
  assert.match(result.reason, /^Spawn prompt path gate:/, 'the T1BLOCK resolved');
  assert.equal(
    result.reason.includes('could not be loaded'), false,
    'the last-resort notice must be dead on a healthy tree — otherwise this change is not inert',
  );
});

// The population-level half of the same claim: every block that a fallback-less
// call site renders exists in the SKILL.md that site reads, which is what makes
// the empty reason unreachable across all 28 deny sites rather than just this
// one. That is asserted for the whole census — from a parse, not a grep — by
// shared/__tests__/skill-block-coverage.test.ts ('a block rendered with NO
// verbatim fallback is a live empty-reason risk and must exist'), so it is
// referenced here rather than re-implemented with a second, weaker scanner.

// ── the paragraph's shape ────────────────────────────────────────────────────

test('the notice names the gate, names doctor, refuses a retry, and ends in an action its addressee can take', () => {
  const notice = lastResortDenyReason('architecture-input-owner-gate');
  assert.match(notice, /`architecture-input-owner-gate`/);
  assert.ok(notice.includes(`\`${pluginRoot()}\``), 'it names the install to repair, not just that one is broken');
  assert.match(notice, /Traffic One doctor/);
  assert.match(notice, /refused again/);
  assert.match(notice, /Report to the user/);
  // A command line here would have to be one the gate grammar admits (an
  // absolute path from doctor-command.ts), and this notice cannot promise that
  // `scripts/doctor.cjs` outlived whatever removed the skill trees beside it.
  assert.equal(/doctor\.cjs|node /.test(notice), false, 'doctor is named in prose, never as a command');
  // A missing id degrades to prose rather than rendering `undefined`. Nothing in
  // production reaches this — tests/deny-id-completeness.test.ts requires an
  // inline denyId at every production deny() call site, with no exemption list —
  // but the parameter is optional in the type, so the shape is pinned.
  assert.equal(lastResortDenyReason().includes('undefined'), false);
  assert.match(lastResortDenyReason(), /the gate that refused it/);
});

// ── why the id is interpolated, mechanically ─────────────────────────────────
// shared/state/deny-repeat.ts signs a refusal as `denyTarget` plus the WHOLE
// rendered reason, and escalates at DENY_REPEAT_ESCALATE_AT identical
// signatures. A CONSTANT notice would therefore make all 28 empty-reason sites
// one bucket, and an agent hitting three different broken gates on the same
// target would be told to stop retrying on its third, first attempt. Asserted
// against the real signing function, so the claim cannot rot if the key changes.
test('two different gates going empty stay two different deny-repeat signatures', () => {
  const target = '/proj/src/app.tsx';
  const first = denySignature(target, [lastResortDenyReason('architecture-input-owner-gate')]);
  const second = denySignature(target, [lastResortDenyReason('run-team-quick-fix-contract')]);
  assert.notEqual(first, second, 'a constant notice would collapse every empty deny into one count');
  assert.equal(
    denySignature(target, [lastResortDenyReason('architecture-input-owner-gate')]), first,
    'and the same gate on the same target must still be ONE signature, or nothing ever escalates',
  );
  assert.ok(DENY_REPEAT_ESCALATE_AT >= 2, `escalation threshold is ${DENY_REPEAT_ESCALATE_AT}`);
});

// The counterpart to the id being interpolated: the INSTALL LOCATION must not
// be. The notice names the plugin root so a human can find the tree to repair,
// and deny-repeat.ts folds that root out before signing precisely so the same
// loop counts as one bucket across a version-keyed cache dir, a `plugin:sync`
// and a second host. The fold works by splitting on `pluginRoot()` verbatim, so
// it is defeated by ANY derived spelling — a trailing separator, a
// posix-normalised copy — and the failure is silent: escalation quietly arrives
// on the fifth identical refusal instead of the third. Asserted against the real
// signing function rather than by reading the string.
test('the notice carries the plugin root, and the deny-repeat fold still removes it', () => {
  const notice = lastResortDenyReason('architecture-input-owner-gate');
  assert.ok(notice.includes(pluginRoot()), 'precondition: the root is in the rendered reason');
  assert.equal(
    withoutInstallLocation(notice).includes(pluginRoot()), false,
    'the root this notice interpolates is not the spelling deny-repeat.ts folds — one install location per bucket, '
    + 'so an agent looping on one broken gate escalates late and silently',
  );
  // The two-install case, which one process cannot fold for itself: each
  // process removes the root IT resolved. So the second arm renders the notice
  // from a different install and folds THAT root, exactly as the other process
  // would. Both must land on one signature.
  const elsewhere = '/some/other/install';
  const foreign = notice.split(pluginRoot()).join(elsewhere);
  assert.equal(
    denySignature('/proj/x.ts', [withoutInstallLocation(notice)]),
    denySignature('/proj/x.ts', [foreign.split(elsewhere).join(PLUGIN_ROOT_SIGNATURE_TOKEN)]),
    'two installs rendering the same broken gate must sign as ONE repeat, or nothing ever escalates',
  );
});

// ── the BOUND, asserted rather than described ───────────────────────────────

test('the substitution covers the wholly-empty reason only', () => {
  const empty = deny('', { denyId: 'authoring-guard' });
  assert.equal(empty.kind, 'deny');
  if (empty.kind === 'deny') assert.equal(empty.reason, lastResortDenyReason('authoring-guard'));

  const blank = deny('   \n  ', { denyId: 'authoring-guard' });
  if (blank.kind === 'deny') {
    assert.equal(blank.reason, lastResortDenyReason('authoring-guard'), 'whitespace is not an explanation');
  }

  // A reason assembled from a MISSING block plus surviving TS clauses is not
  // empty, so the notice never sees it. plan-guard's `deny()` helper
  // (plan-runteam.ts) appends `run-team-suffix` to every refusal, which is
  // exactly this shape. Recorded as a limitation, not a defect: the fix for
  // those sites is the fallback argument the assembler already takes.
  const composed = deny(`${''} ${'If subagents are genuinely unavailable…'}`, { denyId: 'run-team-wrong-role' });
  if (composed.kind === 'deny') {
    assert.equal(
      composed.reason.includes('could not be loaded'), false,
      'a hole inside a non-empty reason is outside this notice',
    );
  }
});

// askUser reuses the deny KIND but builds its literal itself, and must keep
// doing so: its `reason` is the question Cursor renders in an approve/reject
// modal, where a "this install is incomplete" notice would be actively wrong.
// The same exception core/pipeline.ts's stampDeny already makes for its
// suffixes.
test('an askUser prompt never receives the last-resort notice, even with an empty question', () => {
  const asked = askUser('', 'on approve proceed; on reject stop');
  assert.equal(asked.kind, 'deny');
  if (asked.kind !== 'deny') return;
  assert.equal(asked.reason, '', 'askUser bypasses deny() and passes the question through verbatim');
  assert.equal(asked.askUser, true);
});
