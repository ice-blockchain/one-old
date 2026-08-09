// src/core/__tests__/deny-last-resort-torn-install.test.ts
// The REACHABLE half of the last-resort deny notice (core/result.ts's
// lastResortDenyReason): a plugin root with NO skill trees, driven through a
// REAL production gate, must produce the notice instead of `reason: ''`.
//
// ── why this is its own FILE and not a second test next door ─────────────────
// shared/skill-block.ts's assembler memoizes the SKILL.md TEXT per module id,
// per assembler instance, and every gate builds its assembler once at module
// scope (`makeSkillBlock(pluginRoot)`). So the FIRST block call for a given
// module in a process fixes what every later call in that process sees: a torn
// root caches `''` and a healthy root caches the real prose, and no amount of
// env juggling inside one process can show both. `node --test` runs one child
// process per test FILE (see src/build/test-preload.mjs's header, which relies
// on exactly that), so the two directions live in two files:
//   this file          — torn root, notice REACHABLE
//   deny-last-resort.test.ts — healthy root, notice UNREACHABLE (inert)
// Neither is sufficient alone. A test that only checked the helper's output in
// isolation would prove nothing about the wiring, which is why both go through
// `absoluteTrafficOnePathDeny` — a real exported gate builder whose block is one
// of the 33 pinned fallback-less renders in
// shared/__tests__/skill-block-coverage.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { lastResortDenyReason } from '../result';
import { absoluteTrafficOnePathDeny } from '../../modules/agent-model/spawn-hygiene';
import { cursorAgentTypeDeny } from '../../modules/agent-model/spawn-shape';

// Set at module scope, before any test body can warm the assembler's cache. An
// empty directory is the whole fixture: makeSkillBlock looks for
// `<root>/src/modules/<id>/skill/SKILL.md` and then `<root>/scripts/modules/…`,
// and a torn install has neither.
const TORN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'w8d-torn-install-'));
process.env.TRAFFIC_ONE_PLUGIN_ROOT = TORN_ROOT;
process.on('exit', () => { fs.rmSync(TORN_ROOT, { recursive: true, force: true }); });

test('PRECONDITION: the fixture root really has no skill trees', () => {
  assert.equal(fs.existsSync(path.join(TORN_ROOT, 'src', 'modules')), false);
  assert.equal(fs.existsSync(path.join(TORN_ROOT, 'scripts', 'modules')), false);
});

test('a gate whose block is unreachable refuses with the last-resort notice, not with nothing', () => {
  const result = absoluteTrafficOnePathDeny(['/other/proj/.traffic-one/runs/1/x.md'], '/proj');
  assert.equal(result.kind, 'deny', 'the refusal itself must be unaffected by the missing prose');
  if (result.kind !== 'deny') return;

  // This is the defect, stated as the assertion that would have caught it: the
  // reason used to be the empty string here.
  assert.notEqual(result.reason, '', 'a refusal with no explanation is the defect this notice closes');
  assert.equal(result.reason, lastResortDenyReason('absolute-traffic-one-path'));

  // The four properties the paragraph is required to carry.
  assert.match(result.reason, /`absolute-traffic-one-path`/, 'it names the gate that refused');
  assert.match(result.reason, /Traffic One doctor/, 'doctor is the first remedy');
  assert.match(result.reason, /refused again/, 'retrying is explicitly futile');
  assert.match(result.reason, /Report to the user/, 'it ends in an action its own addressee can take');

  // …and no command line, because the gate grammar only admits the absolute
  // spellings doctor-command.ts prints and this notice cannot promise that
  // `scripts/doctor.cjs` survived whatever removed the skill trees.
  assert.equal(/doctor\.cjs/.test(result.reason), false, 'doctor is named in prose, never as a command');
});

// The same torn root, the same module, the same missing SKILL.md — but a call
// site that DOES pass a verbatim fallback. It renders that prose and must not
// see the notice. This is what pins the substitution to a wholly-empty reason
// rather than to "the block was missing", and it is also the non-vacuity of the
// emptiness check: if `deny()` had started substituting unconditionally, this
// assertion is the one that goes red.
test('a fallback-carrying gate on the same torn root renders its prose and never sees the notice', () => {
  const result = cursorAgentTypeDeny('senior-frontend', 'general');
  assert.equal(result.kind, 'deny');
  if (result.kind !== 'deny') return;
  assert.equal(
    result.reason.includes('could not be loaded'), false,
    'the TS fallback rendered, so there is nothing for the last-resort notice to do',
  );
  assert.match(result.reason, /senior-frontend/, 'the fallback prose is what the agent reads here');
});
