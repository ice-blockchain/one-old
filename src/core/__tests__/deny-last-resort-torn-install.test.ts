// src/core/__tests__/deny-last-resort-torn-install.test.ts
// A plugin root with NO skill trees, driven through REAL production gates. This
// file is the proof that prose survives a torn install, and what it proves
// changed when shared/skill-fallbacks.generated.ts landed.
//
// ── what it used to assert, and why that is now the weaker claim ─────────────
// Before the generated table, a fallback-less call site rendered `''` on this
// root and core/result.ts's `deny()` substituted `lastResortDenyReason` — so the
// agent read a last-resort "could not be loaded" notice, correct but content-free:
// the REMEDY was gone, and on the gates whose reason IS the remedy that is the
// whole value of the deny. This file asserted that substitution.
//
// It now asserts the stronger thing: on the same torn root the gate renders its
// REAL prose, byte-identical to the T1BLOCK that ships, because
// shared/skill-block.ts consults the generated table before giving up. The
// substitution is not weakened — it is asserted below against a block that
// exists in NO SKILL.md, which is the only case that can still render empty.
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
//   this file          — torn root, the table is what renders
//   deny-last-resort.test.ts — healthy root, the notice UNREACHABLE (inert)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deny, lastResortDenyReason } from '../result';
import { applyVars, extractBlock, makeSkillBlock } from '../../shared/skill-block';
import { absoluteTrafficOnePathDeny } from '../../modules/agent-model/spawn-hygiene';
import { cursorAgentTypeDeny } from '../../modules/agent-model/spawn-shape';

// Set at module scope, before any test body can warm the assembler's cache. An
// empty directory is the whole fixture: makeSkillBlock looks for
// `<root>/src/modules/<id>/skill/SKILL.md` and then `<root>/scripts/modules/…`,
// and a torn install has neither.
const TORN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'w8d-torn-install-'));
process.env.TRAFFIC_ONE_PLUGIN_ROOT = TORN_ROOT;
process.on('exit', () => { fs.rmSync(TORN_ROOT, { recursive: true, force: true }); });

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const readSkill = (moduleId: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, 'src', 'modules', moduleId, 'skill', 'SKILL.md'), 'utf8');

test('PRECONDITION: the fixture root really has no skill trees', () => {
  assert.equal(fs.existsSync(path.join(TORN_ROOT, 'src', 'modules')), false);
  assert.equal(fs.existsSync(path.join(TORN_ROOT, 'scripts', 'modules')), false);
});

test('a gate whose SKILL.md is unreachable renders its REAL prose, from the generated table', () => {
  const result = absoluteTrafficOnePathDeny(['/other/proj/.traffic-one/runs/1/x.md'], '/proj');
  assert.equal(result.kind, 'deny', 'the refusal itself must be unaffected by the unreadable prose file');
  if (result.kind !== 'deny') return;

  // The original defect, still asserted: the reason used to be `''` here.
  assert.notEqual(result.reason, '', 'a refusal with no explanation is the defect this path closes');

  // …and the stronger claim the table buys. Byte-identity against the SKILL.md
  // that ships, read HERE from the repo — which is a second, independent check
  // that the generated table is a faithful copy, at runtime rather than at
  // generation time. The gate cannot have read this file: TRAFFIC_ONE_PLUGIN_ROOT
  // points at an empty directory, so the only path to these bytes is the
  // generated module Node resolved relative to shared/skill-block.ts.
  const shipped = extractBlock(readSkill('agent-model'), 'absolute-traffic-one-path');
  assert.ok(shipped, 'PRECONDITION: the block exists in the shipped SKILL.md');
  assert.equal(
    result.reason,
    applyVars(shipped!, { PROJECT_ROOT: '/proj', BAD_PATHS: '/other/proj/.traffic-one/runs/1/x.md' }),
    'a torn install must render what a healthy install renders, not a paraphrase and not a notice',
  );

  // The remedy is what was being lost. Name the properties rather than trusting
  // the equality above to keep carrying them.
  assert.match(result.reason, /\.traffic-one\/digests\//, 'it shows the shape the agent should have used');
  assert.match(result.reason, /Re-issue the same spawn/, 'it ends in an action its own addressee can take');
  assert.equal(
    result.reason.includes('could not be loaded'), false,
    'the last-resort notice is for prose that exists NOWHERE — it must not stand in for prose that does',
  );
});

// The same torn root, the same module, a call site that ALSO passes a verbatim
// fallback. The generated table is consulted BEFORE that argument, deliberately:
// a per-site literal is only ever read when SKILL.md is unreadable, so letting
// it win would make a broken install render prose no working install shows.
test('a fallback-carrying gate on the same torn root renders the SHIPPED text, not its call-site copy', () => {
  const result = cursorAgentTypeDeny('senior-frontend', 'general');
  assert.equal(result.kind, 'deny');
  if (result.kind !== 'deny') return;
  assert.equal(
    result.reason.includes('could not be loaded'), false,
    'prose resolved, so there is nothing for the last-resort notice to do',
  );
  assert.match(result.reason, /senior-frontend/, 'the prose is what the agent reads here');
  const shipped = extractBlock(readSkill('agent-model'), 'cursor-agent-type-required');
  assert.ok(shipped, 'PRECONDITION: the block exists in the shipped SKILL.md');
  assert.equal(
    result.reason,
    applyVars(shipped!, {
      ROLE: 'senior-frontend',
      AGENT_TYPE: 'general',
      EXPECTED_AGENT: 'senior-frontend',
      AGENT_PATH: '.cursor/agents/senior-frontend.md',
      FALLBACK_AGENT: 'generalPurpose',
    }),
    'the table wins over the call-site fallback, so torn and healthy render the same bytes',
  );
});

// ── the notice is still REACHABLE, for the one case the table cannot serve ───
// A block name that exists in no SKILL.md has no generated entry either — the
// table is emitted FROM those files — so it renders the call site's own
// fallback, and `''` when there is none. That is the residue
// `lastResortDenyReason` covers, and shared/__tests__/skill-block-coverage.test.ts
// pins the population it can happen to (TS_ONLY_PROSE, both of which do pass a
// verbatim fallback). Driven through the real assembler, not the helper alone,
// so this proves the WIRING and not just the string.
test('a block that exists nowhere still refuses with the last-resort notice rather than with nothing', () => {
  const skillBlock = makeSkillBlock(() => TORN_ROOT);
  const rendered = skillBlock('agent-model', 'no-such-block-anywhere', {});
  assert.equal(rendered, '', 'no live block, no generated entry, no call-site fallback');

  const result = deny(rendered, { denyId: 'absolute-traffic-one-path' });
  assert.equal(result.kind, 'deny');
  if (result.kind !== 'deny') return;
  assert.equal(result.reason, lastResortDenyReason('absolute-traffic-one-path'));
  assert.equal(result.userReason, 'Retry the same action after setup finishes.');
  assert.match(result.reason, /`absolute-traffic-one-path`/, 'it names the gate that refused');
  assert.match(result.reason, /Traffic One doctor/, 'doctor is the first remedy');
  assert.doesNotMatch(result.reason, /Report to the user/);
  assert.doesNotMatch(result.reason, /install is incomplete/);
  assert.equal(/doctor\.cjs/.test(result.reason), false, 'doctor is named in prose, never as a command');
});
