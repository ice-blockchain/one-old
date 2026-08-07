// The materialization stamp write, and what the spawn gate does when the fence
// refuses it.
//
// `materializeIfNeeded` used to return `void`, so a refused stamp reported
// nothing and `modelEnforcementGates` could only see its read-back — which
// correctly answers "not materialized" but cannot say WHY, and the why is the
// whole cost: a refused stamp is durable, so the assets are rewritten and the
// same deny is re-issued on every later spawn, forever, with nothing naming the
// path that caused it.
//
// The read-back stays authoritative for WHICH deny, deliberately — it is stronger
// than the boolean, because it also catches a stamp that landed over incomplete
// assets, and an already-stamped project whose assets the sweep just restored
// under a refused re-stamp (that project IS complete and owes the re-issue deny,
// which the boolean alone would downgrade). The boolean names the cause only, and
// is carried as the deny's target.
//
// WHY THIS LIVES IN THE CORPUS DIRECTORY, rather than beside the module it tests:
// `materializeProjectAssets` refuses a 'source'-layout plugin root outright
// (paths.ts#classifyPluginRootLayout — this checkout under tsx is exactly that),
// so on a src/ test it returns `skipped` and never reaches its stamp at all. A
// test there passes VACUOUSLY: `stamped` is `true` for the fenced project and the
// unfenced one alike, which is correct behaviour and proves nothing. env.ts's
// synthetic INSTALLED root is the only one in the suite that can reach a real
// materialization without depending on `dist/` being built, and the assertions
// below on the writable baseline are what would catch it if that stopped being
// true.
//
// FENCING: `.one.json` is a MOVE-ASIDE (rename the real file, symlink the
// original name to it), never a dangling link — writeState reads the file it is
// about to replace. A dangling link makes that read fail, the stamp is skipped on
// its own precondition, and the case passes having proved nothing.

import './env';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { cleanupReplayTempTrees, onboardedNotMaterialized } from './fixtures';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from '../../src/modules/agent-model/converge';
import { modelEnforcementGates } from '../../src/modules/agent-model/gate-enforcement';
import { AGENT_MATERIALIZATION_MISSING_FALLBACK } from '../../src/modules/agent-model/handler-prose';
import { readEffectiveState, statePath } from '../../src/shared/state';
import type { GateContext } from '../../src/modules/agent-model/gate-context';
import type { Ctx, HookInput, ToolClass } from '../../src/core/types';

test.after(cleanupReplayTempTrees);

function fenceMoveAside(target: string): void {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the sweep reaches its stamp write');
}

function gateContext(cwd: string): GateContext {
  const input: HookInput = {
    event: 'PreToolUse', host: 'claude', cwd,
    raw: { tool_name: 'Task', tool_input: { subagent_type: 'senior-frontend' } },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  const ctx = { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
  return {
    ctx,
    cwd,
    state: readEffectiveState(cwd) as never,
    raw: {},
    toolName: 'Task',
    toolInput: {},
    role: 'senior-frontend',
    roleEvidence: { role: 'senior-frontend' } as never,
    spawnRunId: '1700000000000',
    runPolicy: null,
    subagentTeam: true,
    spawnPromptText: '',
    allowSpawn: (r) => r,
  } as GateContext;
}

test('materializeIfNeeded forwards its stamp write: true when recorded, false when the fence refused it', () => {
  const open = onboardedNotMaterialized('claude');
  assert.equal(materializeIfNeeded(open), true,
    'writable baseline: an unfenced convergence records its stamp and says so');
  assert.equal(isCompletedTrafficOneMaterialization(open, readEffectiveState(open)), true,
    'writable baseline: and the project the consumer reads back really did materialize — without this the fenced case below proves nothing');

  const fenced = onboardedNotMaterialized('claude');
  fenceMoveAside(statePath(fenced));

  assert.equal(materializeIfNeeded(fenced), false,
    'a refused stamp must be reported: nothing else can tell a project that did not converge from one that converged and could not record it');
  // The consequence, read the way the consumer reads it: the assets DID land, so
  // the sweep keeps re-running and keeps producing them while the read-back keeps
  // answering false — permanently, because a refusal through this layer is durable.
  assert.ok(fs.existsSync(path.join(fenced, '.traffic-one', 'manifest.json')),
    'the assets landed — this is the wasted work the boolean exists to explain');
  assert.equal(isCompletedTrafficOneMaterialization(fenced, readEffectiveState(fenced)), false,
    'while the stamp the read-back looks for never reached disk');
  assert.equal(materializeIfNeeded(fenced), false,
    'and a second call answers the same, which is what makes the re-sweep unbounded rather than transient');
});

test('the spawn gate carries the refused state path on the deny it could not otherwise explain', () => {
  const open = onboardedNotMaterialized('claude');
  const converged = modelEnforcementGates(gateContext(open));
  assert.equal(converged.kind, 'deny', 'writable baseline: an unmaterialized new project denies the spawn');
  if (converged.kind === 'deny') {
    assert.equal(converged.denyId, 'agent-materialization-deny',
      'writable baseline: having converged, the gate asks for the call to be re-issued');
    assert.equal(converged.denyTarget, undefined,
      'writable baseline: and names no refused path, because nothing was refused');
    assert.ok(!converged.reason.includes('WHY THIS REPEATS'),
      'writable baseline: and says nothing about a refusal — this deny is re-issued once and then passes, so a cause clause here would be a lie');
  }

  const fenced = onboardedNotMaterialized('claude');
  fenceMoveAside(statePath(fenced));

  const refused = modelEnforcementGates(gateContext(fenced));
  assert.equal(refused.kind, 'deny');
  if (refused.kind === 'deny') {
    // The VERDICT still comes from the read-back, not the boolean: a project that
    // could not record its materialization does not have one, and that is the deny
    // that fails closed. Unchanged by this fix, and asserted so it stays that way.
    assert.equal(refused.denyId, 'agent-materialization-missing',
      'the read-back remains authoritative for which deny fires');
    assert.equal(refused.denyTarget, statePath(fenced),
      'and the deny now names the refused path — otherwise this exact deny repeats on every spawn with nothing recording its cause');
    // The human-readable half of the same fact. `denyTarget` is read by the
    // per-target budget and the decision record; nothing reads it ALOUD, so the
    // operator still saw a deny with no cause on a loop that never ends.
    assert.ok(refused.reason.includes('WHY THIS REPEATS'),
      'the operator-facing half: without it this deny recurs on every spawn with its reason recorded only in a field nobody renders');
    assert.ok(refused.reason.includes(statePath(fenced)),
      'and it names the same path the machine-readable half carries, so the two cannot drift apart');
    assert.ok(refused.reason.includes('this same deny will be re-issued on the next spawn'),
      'it must say the prescribed command will NOT clear it, or the operator runs it forever');
    assert.ok(/Answer the consent question, or clear whatever occupies that path, then retry the spawn\./.test(refused.reason),
      'and it must still end in an action — naming a cause without one turns a deny into a dead end');
    // The clause is rendered from the same boolean that sets `denyTarget`, and
    // the fallback must carry it too: this deny had NO verbatim fallback at all,
    // so a missing SKILL.md block rendered the whole refusal as empty text.
    assert.ok(AGENT_MATERIALIZATION_MISSING_FALLBACK.includes('materialize-project'),
      'the fallback must carry the remedy command');
    assert.ok(AGENT_MATERIALIZATION_MISSING_FALLBACK.includes('{{CAUSE}}'),
      'and the cause slot, or the fallback path silently drops the clause the SKILL.md path renders');
  }
});
