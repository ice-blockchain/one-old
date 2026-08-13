// src/modules/agent-model/__tests__/run-sidecar-denies.test.ts
// The three RUN-SIDECAR spawn denies — `spawn-model-policy-corrupt`,
// `spawn-host-capability-missing`, `spawn-bootstrap-publish-failed` — pinned
// clause by clause, for the reason run-id-unresolved.test.ts pins its sibling:
// the reason IS the remedy, so a clause that is false in the state it prints in
// is a product defect and not a typo.
//
// What was wrong in the three sentences this file now guards:
//   * "immutable model-policy.json IS CORRUPT" was announced in every state the
//     branch fires in. `readRunModelPolicy` folds a bounded-read failure, a JSON
//     failure and a whole schema+digest validation into one `null`, so the word
//     was printed over a DIRECTORY, over a mode-0000 file, and over three
//     perfectly intact policies (wrong run, wrong schema version, tampered
//     field). The rows below assert the state is read off disk instead.
//   * "start a repaired parent run" named no path, no command and no actor, and
//     the one thing it implied — try again — is the one thing create-once
//     guarantees can never work. The rows assert the retry is called out, the
//     agent's refusal is stated, and the user's two routes are named; the
//     `traffic-one-reset` route is asserted PRESENT on a `failed` ledger and
//     ABSENT otherwise, because the runner accepts only that status.
//   * "Repair the parent materialization/policy and retry" was attached to two
//     host-capability states that behave oppositely (one is repaired by the
//     request path before the gate even runs; the other is never replaced at
//     all) and to two bootstrap states whose cause is not materialization in
//     either case. The rows separate them.
//
// Fixtures are mkdtemp roots (withMaterialized) — MANDATORY here: this checkout
// is the plugin authoring root, where the product stands down, so a fixture
// under it would measure the stand-down and not the gate.
//
// ── A THIRD BOOTSTRAP ARM, ADDED WHEN THE CALL SITE WAS GUARDED ────────────────
// The last section of this file covers three states that used to reach NO deny of
// this gate: `ensureRunBootstrap` threw (fsjson's writers rethrow every errno but
// ELOOP) and core/pipeline.ts answered `pipeline-handler-crashed` instead. Folding
// them into either arm above would have been this file's own defect class, so the
// errno is carried into a third arm and the negative assertions pin that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { freezeRunPolicy, withMaterialized } from './agent-model-fixtures';
import { observeCurrentRunHostCapabilityFromHook, readRunHostCapability, runHostCapabilityPath } from '../../../shared/host/capabilities';
import { readRunModelPolicy, runModelPolicyPath } from '../../../shared/run-model-policy';
import { ensureRunLedger, readEffectiveState, transitionRunStatus } from '../../../shared/state';
import type { Ctx, HookInput, HookResult, ToolClass } from '../../../core/types';

const T1 = '.traffic-one';
// The id withMaterialized stamps as `currentRunId`; every sidecar below is the
// one the runtime itself opens for it, never a path templated by hand.
const RUN = 'run-test';
const POLICY = 'spawn-model-policy-corrupt';
const CAPABILITY = 'spawn-host-capability-missing';
const BOOTSTRAP = 'spawn-bootstrap-publish-failed';

function spawnInput(cwd: string, role: string): HookInput {
  return {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: {
      tool_name: 'Task',
      tool_input: { subagent_type: role, model: 'opus', prompt: 'build the thing' },
      session_id: 'parent-1',
    },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  } as unknown as HookInput;
}

function spawnCtx(cwd: string, role = 'senior-frontend'): Ctx {
  return { input: spawnInput(cwd, role), host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function denyReason(result: HookResult, denyId: string): string {
  assert.equal(result.kind, 'deny');
  if (result.kind !== 'deny') return '';
  assert.equal(result.denyId, denyId, result.reason);
  return result.reason;
}

function mutatePolicy(cwd: string, mutate: (policy: Record<string, unknown>) => void): void {
  const file = runModelPolicyPath(cwd, RUN);
  const policy = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  mutate(policy);
  fs.writeFileSync(file, JSON.stringify(policy), 'utf8');
}

// Asserted in every model-policy arm, whatever the file's shape. The prohibition
// is the reason this deny exists and it survives the rewrite verbatim in intent;
// the rest is what the old sentence lacked.
function assertPolicyInvariants(reason: string): void {
  assert.match(reason, /Do NOT reconstruct it from the current plan, the One MCP cache, or the project's `availableModels`/,
    'the prohibition is the incident this deny exists for — rebuilding an immutable policy from live sources');
  assert.match(reason, /do not hand-write a replacement/);
  assert.match(reason, /bound to the `policyId` in that file/,
    'the prohibition now states its reason rather than asserting itself');
  assert.match(reason, /RETRYING CANNOT CLEAR THIS: the freeze is create-once/,
    'the one action the old text implied is the one create-once guarantees cannot work');
  assert.match(reason, /refused for you, because it is a runtime-owned run sidecar/,
    'the actor split: the routes that would clear this are not the agent\'s');
  assert.match(reason, /`\.traffic-one\/runs\/` is gitignored by design/);
  assert.doesNotMatch(reason, /backups/,
    'no run sidecar is ever written under `.traffic-one/backups/` — that was the sibling defect');
  assert.doesNotMatch(reason, /git show|git restore/,
    'runs/ is gitignored, so a version-control restore names bytes that were never committed');
  assert.doesNotMatch(reason, /start a repaired parent run/,
    'the original remedy named no path, no command and no actor');
}

test('a torn model policy is named as torn, and the agent is told it has no route', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    fs.writeFileSync(runModelPolicyPath(cwd, RUN), '{"schemaVersion":1,"po', 'utf8');
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assertPolicyInvariants(reason);
    assert.match(reason, /`\.traffic-one\/runs\/run-test\/model-policy\.json` is there and its bytes do not parse\./);
    // The one thing the agent MAY do, measured as permitted in this state.
    assert.match(reason, /`cat \.traffic-one\/runs\/run-test\/model-policy\.json` is permitted/);
    assert.match(reason, /So this is the USER's move, and there are two/);
    assert.match(reason, /Ask them to delete that ONE file/);
  });
});

test('a model policy nothing can READ is not reported as corrupt bytes', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    // A directory where the policy belongs: the bounded read never reads a byte,
    // so "is corrupt" describes bytes nobody saw, and "delete that ONE file"
    // names a file that is not a file.
    const file = runModelPolicyPath(cwd, RUN);
    fs.rmSync(file);
    fs.mkdirSync(file);
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assertPolicyInvariants(reason);
    assert.match(reason, /Nothing can be read at `\.traffic-one\/runs\/run-test\/model-policy\.json` \(EISDIR\)/);
    assert.match(reason, /no policy bytes there to judge/);
    assert.match(reason, /Ask them to remove whatever is at that path/);
    assert.doesNotMatch(reason, /bytes do not parse/);
    assert.doesNotMatch(reason, /delete that ONE file/);
  });
});

test('an UNREADABLE model policy is reported by its errno, not as corruption', { skip: process.getuid?.() === 0 ? 'root reads mode 0000' : false }, () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    fs.chmodSync(runModelPolicyPath(cwd, RUN), 0o000);
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assertPolicyInvariants(reason);
    assert.match(reason, /Nothing can be read at `\.traffic-one\/runs\/run-test\/model-policy\.json` \(EACCES\)/);
    assert.doesNotMatch(reason, /bytes do not parse/);
    // Not a directory, so the removal is of a file — the two arms must not share
    // one instruction, which is why `removable` is computed rather than fixed.
    assert.match(reason, /Ask them to delete that ONE file/);
  });
});

test('valid JSON that is not a record is named as that, not as unparseable', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    fs.writeFileSync(runModelPolicyPath(cwd, RUN), '[1,2,3]', 'utf8');
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assertPolicyInvariants(reason);
    assert.match(reason, /holds valid JSON that is not an object \(a JSON array\), so it is not a policy record at all/);
    assert.doesNotMatch(reason, /bytes do not parse/, 'the bytes parsed perfectly; only the shape is wrong');
  });
});

test('an INTACT policy frozen for another run is named as that run\'s policy', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    mutatePolicy(cwd, (policy) => { policy.runId = 'some-other-run'; });
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assertPolicyInvariants(reason);
    assert.match(reason, /is intact, but it is run `some-other-run`'s policy and this spawn is in run `run-test`/);
    assert.doesNotMatch(reason, /bytes do not parse|Nothing can be read/,
      'nothing is wrong with the file — it belongs to a different run');
  });
});

test('a policy from a FUTURE schema version is named by its version', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    mutatePolicy(cwd, (policy) => { policy.schemaVersion = 2; });
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assertPolicyInvariants(reason);
    assert.match(reason, /declares `schemaVersion` 2, and this runtime freezes and reads version 1 only/);
    assert.doesNotMatch(reason, /bytes do not parse/);
  });
});

test('a TAMPERED policy is named as a failed validation, and the digest is named', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    mutatePolicy(cwd, (policy) => { policy.performanceLevel = 'low'; });
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assertPolicyInvariants(reason);
    assert.match(reason, /parses as a JSON object but does not validate as run `run-test`'s frozen policy/);
    assert.match(reason, /the `policyId` digest taken over it, does not match what was frozen/);
    assert.doesNotMatch(reason, /bytes do not parse/);
  });
});

test('`traffic-one-reset` is offered ONLY on a failed ledger, and its refusal is named otherwise', () => {
  // The conditional the sibling deny's `.one.json.corrupt` clause is: a command
  // printed in a state where the runner declines it teaches the agent to
  // distrust the prose. MEASURED: `failed` → ok, `planned` → run-not-failed,
  // no ledger → ledger-absent.
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    fs.writeFileSync(runModelPolicyPath(cwd, RUN), '{"a', 'utf8');
    const noLedger = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assert.match(noLedger, /Retiring the run is not available in this state: run run-test's ledger is `absent`/);
    assert.match(noLedger, /recovers only a terminally `failed` run/);
    assert.doesNotMatch(noLedger, /traffic-one-reset\.cjs/,
      'the command must not be printed where the runner refuses it');

    ensureRunLedger(cwd, RUN, readEffectiveState(cwd, process.env));
    const planned = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assert.match(planned, /Retiring the run is not available in this state/);
    assert.doesNotMatch(planned, /traffic-one-reset\.cjs/);

    transitionRunStatus(cwd, RUN, { status: 'failed', outcome: 'agent-failed' });
    const failed = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assert.match(failed, /A terminally `failed` run has ONE sanctioned recovery/);
    assert.match(failed, /traffic-one-reset\.cjs' --run-id run-test/);
    assert.doesNotMatch(failed, /Retiring the run is not available/);
  });
});

test('retrying does NOT clear a torn policy, and the deny says so', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const file = runModelPolicyPath(cwd, RUN);
    fs.writeFileSync(file, '{"a', 'utf8');
    const first = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    const second = denyReason(agentModelGate(spawnCtx(cwd)), POLICY);
    assert.equal(first, second, 'create-once means the freeze never republishes over an existing path');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a', 'and the torn bytes are not touched either');
  });
});

test('the removal the deny asks the USER for is what actually clears it', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const file = runModelPolicyPath(cwd, RUN);
    fs.writeFileSync(file, '{"a', 'utf8');
    denyReason(agentModelGate(spawnCtx(cwd)), POLICY);

    fs.rmSync(file);
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') {
      assert.notEqual(after.denyId, POLICY, 'the prescribed removal must actually clear this deny');
    }
    const rebuilt = readRunModelPolicy(cwd, RUN);
    assert.ok(rebuilt, 'and a fresh policy is frozen — for the SAME run, which is why it is the user\'s decision');
    assert.equal(rebuilt?.runId, RUN);
  });
});

test('a healthy frozen policy does not reach the corrupt deny at all', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const result = agentModelGate(spawnCtx(cwd));
    if (result.kind === 'deny') {
      assert.notEqual(result.denyId, POLICY, 'the control: an instrument that fires on a healthy fixture proves nothing');
    }
  });
});

test('an ABSENT host-capability record is named as self-clearing, and it really is', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const file = runHostCapabilityPath(cwd, RUN);
    fs.rmSync(file);
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), CAPABILITY);
    assert.match(reason, /`\.traffic-one\/runs\/run-test\/host-capability-v1\.json` is not on disk/);
    assert.match(reason, /This one is SELF-CLEARING/);
    assert.match(reason, /Re-send the SAME spawn, unchanged — same role, same model, same prompt/);
    assert.doesNotMatch(reason, /Ask the USER/, 'a state the request path repairs is not the user\'s errand');
    assert.doesNotMatch(reason, /Repair the parent run and retry/);

    // The claim "the request path writes that record before any gate runs" is
    // dispatch.ts's pre-pipeline observation, so it is driven here rather than
    // asserted: after it, the record is valid and the spawn is no longer denied.
    observeCurrentRunHostCapabilityFromHook(cwd, spawnInput(cwd, 'senior-frontend'));
    assert.ok(readRunHostCapability(cwd, RUN, 'claude'), 'the record the deny promises is written');
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') assert.notEqual(after.denyId, CAPABILITY);
  });
});

test('a PUBLISHED-but-invalid host-capability record is never replaced, and the deny says so', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const file = runHostCapabilityPath(cwd, RUN);
    fs.writeFileSync(file, '{"schemaVe', 'utf8');
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), CAPABILITY);
    assert.match(reason, /is on disk but does not validate as run run-test's claude capability record\./);
    assert.match(reason, /RETRYING CANNOT CLEAR THIS: a published-but-invalid capability record is evidence loss/);
    assert.match(reason, /it is refused for YOU/);
    assert.match(reason, /`\.traffic-one\/runs\/` is gitignored by design/);
    assert.match(reason, /Ask the USER to delete that ONE file/);
    assert.doesNotMatch(reason, /SELF-CLEARING/, 'this is the state the old sentence folded in with the absent one');
    assert.doesNotMatch(reason, /git show|git restore|backups/);

    // Both halves measured: the request path does NOT repair it…
    observeCurrentRunHostCapabilityFromHook(cwd, spawnInput(cwd, 'senior-frontend'));
    assert.equal(readRunHostCapability(cwd, RUN, 'claude'), null, 'evidence loss is never silently overwritten');
    denyReason(agentModelGate(spawnCtx(cwd)), CAPABILITY);
    // …and the removal the deny asks for does.
    fs.rmSync(file);
    observeCurrentRunHostCapabilityFromHook(cwd, spawnInput(cwd, 'senior-frontend'));
    assert.ok(readRunHostCapability(cwd, RUN, 'claude'), 'the prescribed removal is what clears it');
  });
});

test('a DIRECTORY at the host-capability path is reported by errno, with a removal to match', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const file = runHostCapabilityPath(cwd, RUN);
    fs.rmSync(file);
    fs.mkdirSync(file);
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), CAPABILITY);
    assert.match(reason, /Nothing can be read at `\.traffic-one\/runs\/run-test\/host-capability-v1\.json` \(EISDIR\)/);
    assert.match(reason, /Ask the USER to remove whatever is at that path/);
    assert.doesNotMatch(reason, /is not on disk/, 'existsSync finds it; it is published, not missing');
    assert.doesNotMatch(reason, /SELF-CLEARING/);
  });
});

test('a healthy host-capability record does not reach its deny', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    observeCurrentRunHostCapabilityFromHook(cwd, spawnInput(cwd, 'senior-frontend'));
    const result = agentModelGate(spawnCtx(cwd));
    if (result.kind === 'deny') assert.notEqual(result.denyId, CAPABILITY);
  });
});

test('an uncompiled run names the ARCHITECT phase, not the materialization', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // A maintenance run with no compiled architecture and no published
    // assignments: `senior-reviewer` has nothing to compile a work unit FROM,
    // and the sibling "no compiled assignment" refusal cannot claim this state
    // because it needs a published assignment set to consult.
    const onePath = path.join(cwd, T1, '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8')) as Record<string, unknown>;
    one.currentRunId = RUN;
    one.mode = 'existing-codebase';
    one.lifecycle = { phase: 'maintenance', source: 'test' };
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    freezeRunPolicy(cwd, 'claude');

    const reason = denyReason(agentModelGate(spawnCtx(cwd, 'senior-reviewer')), BOOTSTRAP);
    assert.match(reason, /no compiled architecture and no published assignments/);
    assert.match(reason, /The architect phase is what produces both, and no retry of this spawn compiles a plan/);
    assert.match(reason, /`\.traffic-one\/runs\/run-test\/bootstrap\/senior-reviewer\/active\.json` is writable/,
      'the destination is measured, not assumed — the fence really does permit it here');
    assert.doesNotMatch(reason, /Repair the parent materialization/,
      'materialization is intact in this state; the old remedy named the wrong subsystem');
    assert.doesNotMatch(reason, /write fence REFUSES/, 'the fence arm must not print where the fence said yes');
  });
});

test('a publish destination the FENCE refuses is named as that, and not as an uncompiled plan', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    // A symlink out of the state directory: `stateWritePermitted` is false, so
    // the envelope write is refused before any bytes are computed.
    const roleDir = path.join(cwd, T1, 'runs', RUN, 'bootstrap', 'senior-frontend');
    fs.rmSync(roleDir, { recursive: true, force: true });
    const away = fs.mkdtempSync(path.join(os.tmpdir(), 't1-escape-'));
    try {
      fs.mkdirSync(path.dirname(roleDir), { recursive: true });
      fs.symlinkSync(away, roleDir);
      const reason = denyReason(agentModelGate(spawnCtx(cwd)), BOOTSTRAP);
      assert.match(reason, /the state write fence REFUSES its destination, `\.traffic-one\/runs\/run-test\/bootstrap\/senior-frontend\/active\.json`, before any envelope bytes are computed/);
      assert.match(reason, /nothing about the plan or the model is wrong/);
      assert.match(reason, /an unanswered "use Traffic One here\?" consent question/);
      assert.match(reason, /report this to the USER, naming that exact path/);
      assert.doesNotMatch(reason, /is writable/, 'the fence said no; claiming the destination is writable is the defect');
      assert.doesNotMatch(reason, /Repair the parent materialization/);
    } finally {
      fs.rmSync(away, { recursive: true, force: true });
    }
  });
});

test('a compiled run publishes its envelope and does not reach the publish deny', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const result = agentModelGate(spawnCtx(cwd));
    if (result.kind === 'deny') {
      assert.notEqual(result.denyId, BOOTSTRAP, 'the control for all three bootstrap arms');
    }
  });
});

// ── THE DESTINATION THE FILESYSTEM REFUSED ─────────────────────────────────────
// Three states where `ensureRunBootstrap` THROWS rather than answering null, so
// before the guard at the call site this gate returned no deny of its own at all:
// core/pipeline.ts's PreToolUse arm answered `pipeline-handler-crashed`, a deny no
// gate chose and one nothing may lift. The rows drive each state and assert the
// errno reaches the prose, because the errno is the only thing that distinguishes
// them once the throw is contained.
//
// THEY MUST NOT LAND IN EITHER EXISTING ARM, and that is what the negative
// assertions are for: `stateWritePermitted` answers TRUE in all three, so the
// fence arm cannot fire and the uncompiled arm would tell the agent the
// destination "is writable" — the one thing that is false about them.

/** Every throwing state asserts these: the errno arm's shared claims. */
function assertDestinationArm(reason: string, errno: string): void {
  assert.match(reason, new RegExp(`the filesystem refused its destination: \`${errno}\``));
  assert.match(reason, /the state write fence PERMITS this path, so this is the disk answering/);
  assert.match(reason, /Retrying changes none of that — the same errno returns on every spawn/);
  assert.match(reason, /repairing it is refused for you/);
  assert.match(reason, /their move in their own terminal/);
  // The two arms this must never be folded into.
  assert.doesNotMatch(reason, /is writable/,
    'the destination is exactly what is wrong; the uncompiled arm would claim it is writable');
  assert.doesNotMatch(reason, /write fence REFUSES/, 'the fence permits this path — measured');
  assert.doesNotMatch(reason, /no compiled architecture/, 'the plan is intact in all three of these states');
  assert.doesNotMatch(reason, /git show|git restore|backups/, 'run sidecars are gitignored');
}

test('a role bootstrap directory the process may not write is named by its errno, not as a crash', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const roleDir = path.join(cwd, T1, 'runs', RUN, 'bootstrap', 'senior-frontend');
    fs.mkdirSync(roleDir, { recursive: true });
    fs.chmodSync(roleDir, 0o555);
    try {
      // Unguarded this line threw EACCES straight out of the gate; the row is
      // therefore as much about the guard as about the prose.
      const reason = denyReason(agentModelGate(spawnCtx(cwd)), BOOTSTRAP);
      assertDestinationArm(reason, 'EACCES');
      assert.match(reason, /`\.traffic-one\/runs\/run-test\/bootstrap\/senior-frontend\/`/);
      assert.match(reason, /a `chmod u\+w`, or removing the file that is standing where a directory belongs/);
    } finally {
      // Not tidiness: a 0o555 directory survives the fixture teardown and fails a
      // LATER unrelated test in a shape that looks like the defect under test.
      fs.chmodSync(roleDir, 0o755);
    }
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') {
      assert.notEqual(after.denyId, BOOTSTRAP, 'the chmod the deny asks the USER for is what clears it');
    }
  });
});

test('a FILE where the `bootstrap` directory belongs is reported as ENOTDIR', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    const bootstrap = path.join(cwd, T1, 'runs', RUN, 'bootstrap');
    fs.rmSync(bootstrap, { recursive: true, force: true });
    fs.writeFileSync(bootstrap, 'not a directory', 'utf8');

    const reason = denyReason(agentModelGate(spawnCtx(cwd)), BOOTSTRAP);
    assertDestinationArm(reason, 'ENOTDIR');
    // Named as a class, because the throw reports the errno and not WHICH
    // component of the path is the file — this one is a level above the
    // destination directory the sentence names.
    assert.match(reason, /Something at or above that directory is not what it has to be/);

    fs.rmSync(bootstrap, { force: true });
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') {
      assert.notEqual(after.denyId, BOOTSTRAP, 'removing the file is what clears it');
    }
  });
});

test('a FILE where the ROLE directory belongs is reported as EEXIST', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    // The third throw, and one this lane found by measurement rather than
    // inheriting: `mkdirSync` on an existing FILE raises EEXIST, not ENOTDIR.
    const roleDir = path.join(cwd, T1, 'runs', RUN, 'bootstrap', 'senior-frontend');
    fs.rmSync(roleDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(roleDir), { recursive: true });
    fs.writeFileSync(roleDir, 'not a directory', 'utf8');

    assertDestinationArm(denyReason(agentModelGate(spawnCtx(cwd)), BOOTSTRAP), 'EEXIST');

    fs.rmSync(roleDir, { force: true });
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') assert.notEqual(after.denyId, BOOTSTRAP);
  });
});

test('the run directory at 0555 is NOT this deny — an earlier gate claims it', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    // The control for the arm's SCOPE. `runs/<id>` unwritable looks like the same
    // family and never reaches here: `spawn-claim-unavailable` fires first. So the
    // arm speaks about the bootstrap subtree and must not blame the run directory.
    freezeRunPolicy(cwd, 'claude');
    const runDir = path.join(cwd, T1, 'runs', RUN);
    fs.rmSync(path.join(runDir, 'bootstrap'), { recursive: true, force: true });
    fs.chmodSync(runDir, 0o555);
    try {
      const result = agentModelGate(spawnCtx(cwd));
      assert.equal(result.kind, 'deny');
      if (result.kind === 'deny') {
        assert.notEqual(result.denyId, BOOTSTRAP,
          'an earlier gate owns this state; claiming it here would be a deny for a state we never reach');
      }
    } finally {
      fs.chmodSync(runDir, 0o755);
    }
  });
});
