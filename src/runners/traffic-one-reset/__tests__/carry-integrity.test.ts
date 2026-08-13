// THE CARRY'S THREE INTEGRITY PROPERTIES, none of which obligations.test.ts can
// see, because each of them is about something OTHER than the value that lands
// in the successor:
//
//   1. CONCURRENCY.  Three of the carried rows live in stores with their own
//      per-run lease, and the project state lock the transaction holds is a
//      different path and a different lease. An unlocked read-modify-write
//      lands the right value and then loses it to whichever live child commits
//      the base it had already read.
//   2. THE PREDICATE.  The model-choice latch is carried on a conditional, and
//      the conditional has to be the same question the PAUSE is defined by. A
//      cheaper spelling of it (does the answer FILE exist) released a pause
//      waiting on a human, which is the one thing the row must never do.
//   3. WHAT A CARRIED ROW IS ALLOWED TO CAUSE.  A carried spawn observation is
//      a finished resolution. Re-derived against the successor it re-mints,
//      from its own carried inputs, bounds the table deliberately withheld —
//      one row silently overriding its neighbours' conditionals.
//   4. WHICH ROWS THAT IS TRUE OF.  Only the ones that RESOLVED, and a
//      resolution is the DIRECTIVE, not the outcome. The stamp applied to every
//      carried row, then to every row with an outcome — which is still one write
//      too early, because a correlated failure records its outcome and derives
//      its resolution in two separate passes, and a reset landing between them
//      stamped a row whose resolution had never been derived. Either way the
//      successor's own failure was suppressed permanently. Worse than the defect
//      in 3: over-strict is live, silent is not.
//   5. THE CARRY IS NON-FATAL, which was documented and false. No row had an
//      error boundary, so one throw took the pointer-move's own transaction out
//      through the CLI, with the rows after it never attempted and unnamed.
//
// Every fixture here is driven through the PRODUCT's own writers and read back
// through the PRODUCT's own readers, for the reason obligations.test.ts states:
// a hand-rolled blob measures a file shape nothing writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AGENT_ROLES } from '../../../config/performance';
import {
  clearExhaustedModels,
  exhaustedModelsForRole,
  modelExhaustionTerminalForRole,
  recordExhaustedModel,
} from '../../../modules/agent-model/exhausted-models';
import {
  claimCursorParentPendingFollowups,
  refreshPendingResolution,
} from '../../../modules/agent-model/cursor-failure-select';
// The product's own FIRST write of a correlated failure — the outcome, with the
// resolution deliberately left to a later pass. The window this file's third
// direction is about is the gap between the two.
import { persistTerminalClassification } from '../../../modules/agent-model/cursor-failure-persist';
import {
  markModelChoicePrompted,
  modelChoicePrompted,
  modelChoiceReplyPending,
  readModelChoice,
  writeModelChoice,
} from '../../../modules/agent-model/model-choice';
import { canonicalPlan } from '../../../shared/model-tiers';
import { RUN_HOST_CAPABILITY_RELATIVE_FILE } from '../../../shared/host/capabilities';
import { sha256 } from '../../../shared/run-model-policy-schema';
import { resetPluginUseCache } from '../../../shared/state/plugin-use';
import {
  claimCursorSpawnObservation,
  listCursorSpawnObservations,
  recordCursorSpawnObservation,
  updateCursorSpawnObservation,
} from '../../../shared/state/run-agent/cursor-observations';
import { consumeCursorSpawnObservation } from '../../../shared/state/run-agent/cursor-followups';
import { bumpRunAgentActivity } from '../../../shared/state/run-agent/activity';
import { recordDenyRepeat } from '../../../shared/state/deny-repeat';
import { readRunAgentRegistry, recordRunAgent } from '../../../shared/state/run-agent/registry';
// The FENCE the suppression stamp rests on, asked of the product's own gate
// rather than of a copy of its rule. Reading plan-guard here is deliberate: the
// stamp's provenance has no check of its own, so the only honest witness is the
// gate that owns writes under `.traffic-one/runs/`.
import { planReadinessViolations } from '../../../modules/plan-guard/plan-readiness';
import { carryRunObligations, type CarryOutcome } from '../obligations';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HOLDER = path.join(__dirname, 'registry-lease-holder.ts');

function fixture(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `one-carry-${tag}-`)));
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({
    pluginUse: { enabled: true, source: 'test', decidedAt: new Date().toISOString() },
  }), 'utf8');
  resetPluginUseCache();
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', 'OLD'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', 'NEW'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', onboardingComplete: true, confirmed: true,
  }), 'utf8');
  return dir;
}

function discard(dir: string): void {
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  resetPluginUseCache();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 1. concurrency ──────────────────────────────────────────────────────────

// A SECOND REAL PROCESS, because that is the only thing that proves this. Within
// one process the lease is not the mechanism under test: these locks are
// advisory over the filesystem, and a same-process caller can be re-entrant or
// simply cooperative. The defect is a cross-process LOST UPDATE — a live child
// in the successor takes the registry lease, reads its base, and commits it
// after the carry has written straight through that lease — so the fixture has
// to be a real holder of a real lease.

// All THREE contended stores, because the defect was one omission repeated
// three times and a fix proven on one of them is a fix asserted on the other
// two. Each row seeds the retired run with what the carry must move, and reads
// the successor back through the store's own reader.
const CONTENDED: ReadonlyArray<{
  readonly store: 'agents' | 'spawns' | 'exhausted';
  readonly entry: string;
  readonly seed: (dir: string) => void;
  readonly successor: (dir: string) => string[];
  readonly expected: readonly string[];
}> = [
  {
    // The bound this whole row exists to protect: which agent id a role was
    // bound to. Lost, the conflict check cannot see that the frontend role was
    // already taken and a reviewer may continue it — the laundering path.
    store: 'agents',
    entry: 'agents.json',
    seed: (dir) => {
      recordRunAgent(dir, 'OLD', 'senior-frontend', { agentId: 'agent-old-frontend', parentSessionId: 'parent-A' });
      recordRunAgent(dir, 'OLD', 'senior-reviewer', { agentId: 'agent-old-reviewer', parentSessionId: 'parent-A' });
    },
    successor: (dir) => Object.keys(readRunAgentRegistry(dir, 'NEW')).sort(),
    expected: ['live-child-role', 'senior-frontend', 'senior-reviewer'],
  },
  {
    store: 'spawns',
    entry: 'cursor-spawns.json',
    seed: (dir) => {
      recordCursorSpawnObservation(dir, 'OLD', {
        parentSessionId: 'parent-A',
        toolCallId: 'tool_old',
        role: 'senior-frontend',
        requestedModel: TIERS.highest[0],
        tier: 'highest',
        expectedModel: TIERS.highest[0],
        startedAtMs: Date.now() - 60_000,
      });
    },
    successor: (dir) => listCursorSpawnObservations(dir, 'NEW').map((row) => row.toolCallId).sort(),
    expected: ['live-child-role', 'tool_old'],
  },
  {
    store: 'exhausted',
    entry: 'exhausted-models.json',
    seed: (dir) => { recordExhaustedModel(dir, 'OLD', 'senior-frontend', TIERS.highest[0]); },
    successor: (dir) => ['senior-frontend', LIVE_CHILD_ROLE]
      .filter((role) => exhaustedModelsForRole(dir, 'NEW', role).length > 0).sort(),
    expected: ['live-child-role', 'senior-frontend'],
  },
];

// The holder always records under this role name, whichever store it is holding,
// so one expectation spells the live child's row for all three.
const LIVE_CHILD_ROLE = 'senior-tester';

function holderRow(name: string): string {
  return name === LIVE_CHILD_ROLE || name === 'tool_live_child' ? 'live-child-role' : name;
}

for (const row of CONTENDED) {
  test(`${row.store}: a live child that writes AFTER the carry does not erase it`, () => {
    // The reverse interleaving, and the cheaper half of the property. It is the
    // direction the successor-wins rule is stated in: the child's own row is the
    // newer fact and must win, without taking the carried rows down with it.
    const dir = fixture(`race-after-${row.store}`);
    row.seed(dir);

    const outcome = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
    assert.deepEqual(outcome.failed, [], 'an uncontended lock must never produce a failed carry');

    const holder = spawnSync(process.execPath, [
      '--import', './src/build/test-preload.mjs', '--import', 'tsx', HOLDER, dir, '0', row.store,
    ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
    assert.equal(holder.status, 0, `the lock holder failed: ${holder.stderr}`);

    assert.deepEqual(row.successor(dir).map(holderRow).sort(), [...row.expected].sort());
    discard(dir);
  });

  test(`${row.store}: a lock held past the store's own acquire timeout is waited out, not written through`, () => {
    const dir = fixture(`race-live-${row.store}`);
    row.seed(dir);

    // A background process that publishes a marker once it is demonstrably
    // inside its critical section, holds for 2.5s — past every one of these
    // stores' own acquire timeouts, which is the interesting number: at that
    // timeout a single-attempt carry answers "busy" and reports the row as not
    // carried, losing the same bound by a politer route.
    const child = spawn(process.execPath, [
      '--import', './src/build/test-preload.mjs', '--import', 'tsx', HOLDER, dir, '2500', row.store,
    ], { cwd: REPO_ROOT, stdio: 'ignore' });
    let exited = false;
    child.on('exit', () => { exited = true; });

    const inside = path.join(dir, 'holder-inside');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 2_000 && !fs.existsSync(inside); i += 1) Atomics.wait(wait, 0, 0, 10);
    assert.ok(fs.existsSync(inside), 'fixture guard: the second process never reached its critical section');
    assert.ok(!exited, 'fixture guard: the holder had already finished, so nothing was contended');

    const outcome = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
    assert.deepEqual(outcome.failed, [],
      'a contended lock must be waited out: reporting the row as failed loses the same bound');
    assert.ok(outcome.carried.includes(row.entry), `${row.entry} must be reported carried`);

    // The discriminator. Written THROUGH the lock, the holder's later commit
    // (base = the store as it was BEFORE the carry) erases the carried rows and
    // leaves only its own. Waited out, everything is present — and the base the
    // holder recorded is the proof that it really did read first.
    assert.deepEqual(row.successor(dir).map(holderRow).sort(), [...row.expected].sort(),
      'the carried rows and the live child\'s row must all survive');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'holder-read.json'), 'utf8')), [],
      'fixture guard: the holder must have read its base BEFORE the carry, or nothing was raced');
    discard(dir);
  });
}

// ── 2. the latch predicate ──────────────────────────────────────────────────

// NEITHER DIRECTION OF THIS CONDITIONAL WAS COVERED, which is how it survived
// as `existsSync(model-choice.json)` while the pause it conserves is defined by
// `readModelChoice(...) !== null`. Both cases below are ones the writer's own
// refusal path documents as reachable — an unrecognised status and a partial
// write — and in both the retired run is genuinely paused on a human.
for (const [label, bytes] of [
  ['an unrecognised status', JSON.stringify({ status: 'enable' })],
  ['a torn write', '{"status":"use-fal'],
] as const) {
  test(`a latch the retired run is genuinely holding follows the pointer: ${label}`, () => {
    const dir = fixture('latch');
    markModelChoicePrompted(dir, 'OLD');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', 'OLD', 'model-choice.json'), bytes, 'utf8');

    // The two questions, and the whole defect is that they disagree: the file
    // is THERE, and the product's reader says there is no answer in it.
    assert.equal(readModelChoice(dir, 'OLD'), null, 'fixture guard: no answer the product can read');
    assert.equal(modelChoiceReplyPending(dir, { currentRunId: 'OLD' }), true,
      'fixture guard: the retired run is paused on a human reply');

    carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
    assert.equal(modelChoiceReplyPending(dir, { currentRunId: 'NEW' }), true,
      'a pointer move released a latch waiting on a human');
    discard(dir);
  });
}

test('a latch the retired run ANSWERED does not follow the pointer, and the reply still releases one that does', () => {
  const answered = fixture('latch-answered');
  markModelChoicePrompted(answered, 'OLD');
  assert.ok(writeModelChoice(answered, 'OLD', 'use-fallback'));
  carryRunObligations(answered, 'OLD', 'NEW', { priorResets: 0 });
  assert.equal(modelChoicePrompted(answered, 'NEW'), false,
    'copying the marker over an answered run manufactures a pause the retired run was never in');
  discard(answered);

  // The other direction is not a wedge, and this is the assertion that says so:
  // a carried marker is released by the reply it is waiting for.
  const waiting = fixture('latch-waiting');
  markModelChoicePrompted(waiting, 'OLD');
  carryRunObligations(waiting, 'OLD', 'NEW', { priorResets: 0 });
  assert.equal(modelChoiceReplyPending(waiting, { currentRunId: 'NEW' }), true);
  assert.ok(writeModelChoice(waiting, 'NEW', 'use-fallback'));
  assert.equal(modelChoiceReplyPending(waiting, { currentRunId: 'NEW' }), false,
    'the pause is a cost with a remedy, not a wedge');
  discard(waiting);
});

// ── 3. what a carried row may cause ─────────────────────────────────────────

const TIERS = {
  highest: ['gpt-5.6-terra-medium', 'claude-opus-5-thinking-high'],
  balanced: ['claude-4.6-sonnet-medium-thinking'],
  cheapest: ['composer-2.5-fast'],
} as const;

const ROLE_TIER: Record<string, keyof typeof TIERS> = {
  'senior-architect': 'highest',
  'senior-frontend': 'highest',
  'senior-backend': 'highest',
  'senior-reviewer': 'balanced',
  'senior-tester': 'balanced',
  'senior-shipper': 'cheapest',
  'quick-fix': 'cheapest',
};

/** A `model-policy.json` the product's own parsePolicy accepts, built exactly
 *  the way that parser canonicalizes so the derived policy id verifies. Without
 *  a valid policy every resolution short-circuits on "policy missing or
 *  corrupt" and the re-derivation under test never runs at all. */
function writeCursorPolicy(dir: string, runId: string): void {
  const roles: Record<string, unknown> = {};
  for (const role of [...AGENT_ROLES, 'quick-fix']) {
    const tier = ROLE_TIER[role] as keyof typeof TIERS;
    const row = [...TIERS[tier]];
    roles[role] = { tier, preferredModel: row[0], acceptableModels: row };
  }
  const canonical = {
    schemaVersion: 1 as const,
    runId,
    host: 'cursor',
    hostCapabilityFile: RUN_HOST_CAPABILITY_RELATIVE_FILE,
    plan: canonicalPlan('cursor', 'pro'),
    source: 'bundled' as const,
    configVersion: null,
    payloadFingerprint: sha256('payload'),
    appliedFingerprint: sha256('applied'),
    performanceLevel: 'balanced',
    teamOverrides: {},
    tiers: { highest: [...TIERS.highest], balanced: [...TIERS.balanced], cheapest: [...TIERS.cheapest] },
    roles,
    cursorAvailableModels: [...TIERS.highest, ...TIERS.balanced, ...TIERS.cheapest],
  };
  const file = path.join(dir, '.traffic-one', 'runs', runId, 'model-policy.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    ...canonical,
    policyId: sha256(JSON.stringify(canonical)),
    capturedAt: new Date().toISOString(),
  }), 'utf8');
}

/** A role whose whole tier has been API-limited, with the failure correlated to
 *  a child and its OUTCOME recorded — the first of the two writes every
 *  correlated failure takes, and the state from which `resolutionFor` derives
 *  `terminal`. The second write is `finishResolution` below; the tests that need
 *  a FINISHED resolution ask for it, and the ones about the window between them
 *  deliberately do not. */
function exhaustTier(dir: string, runId: string, role: string, tier: keyof typeof TIERS): void {
  const row = [...TIERS[tier]];
  writeCursorPolicy(dir, runId);
  recordCursorSpawnObservation(dir, runId, {
    parentSessionId: 'parent-A',
    toolCallId: 'tool_old',
    role,
    requestedModel: row[0] as string,
    tier,
    expectedModel: row[0] as string,
    startedAtMs: Date.now() - 60_000,
  });
  claimCursorSpawnObservation(dir, runId, 'tool_old', 'child-1');
  updateCursorSpawnObservation(dir, runId, 'child-1', { outcome: 'api-limit', error: 'usage limit reached' });
  for (const model of row) recordExhaustedModel(dir, runId, role, model);
}

/**
 * THE SECOND WRITE: the run derives the resolution for the failure it recorded,
 * which is what turns an outcome into a RESOLUTION — the directive the follow-up
 * driver requires and the only thing a carried row can conserve.
 *
 * Through `refreshPendingResolution`, the product's own derivation step, and
 * asserted rather than assumed: these fixtures used to stop at the outcome and
 * call the row "resolved", which is precisely the confusion the carry's stamp
 * predicate was built on.
 */
function finishResolution(dir: string, runId: string, childId: string = 'child-1'): void {
  const row = listCursorSpawnObservations(dir, runId).find((item) => item.childTranscriptId === childId);
  assert.ok(row?.outcome, 'fixture guard: an outcome has to be recorded before it can be resolved');
  const resolved = refreshPendingResolution(dir, runId, row);
  assert.ok(resolved.directive,
    'fixture guard: the retired run must derive its OWN resolution, or there is nothing here to carry');
}

// THE LADDER IS A GATE ON THE STATE, NOT ON THE COPY. `roles[*].terminal` is
// withheld until WIDEN_AT resets, and the successor used to re-derive it on the
// FIRST reset from a different row's carry: the carried exhaustion entries plus
// the carried finalized failure resolve to terminal, and one product refresh
// minted it. Both tiers, because the derivation needs `composerWasAccepted`,
// which a cheapest-tier role has for free and a higher one gets by answering
// the pause the latch carried.
for (const [role, tier, answer] of [
  ['quick-fix', 'cheapest', null],
  ['senior-frontend', 'highest', 'use-fallback'],
] as const) {
  test(`a first reset does not re-derive the terminal bound WIDEN_AT reserves (${tier} tier)`, () => {
    const dir = fixture('rederive');
    exhaustTier(dir, 'OLD', role, tier);
    markModelChoicePrompted(dir, 'OLD');
    // The retired run RESOLVES its own failure, which is what makes the row a
    // finished resolution and therefore a row this property is about at all.
    // The retired run's own terminal marker is beside the point and is not
    // asserted here: whether it reached one or not, a first reset does not carry
    // it (widen is false), so the successor's state below is checked directly.
    finishResolution(dir, 'OLD');

    const outcome = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
    assert.deepEqual(outcome.widened, [], 'fixture guard: a first reset widens nothing');
    assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', role), false,
      'fixture guard: the bound did not arrive by being CARRIED, so anything below is re-derivation');
    writeCursorPolicy(dir, 'NEW');
    if (answer) assert.ok(writeModelChoice(dir, 'NEW', answer));

    const carried = listCursorSpawnObservations(dir, 'NEW')[0];
    assert.ok(carried, 'fixture guard: the observation carried');
    assert.equal(carried?.carriedFromRunId, 'OLD',
      'a carried row must name the run that observed it, or nothing downstream can tell it apart');

    refreshPendingResolution(dir, 'NEW', carried!);
    assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', role), false,
      'the first reset minted the bound the table reserves for the third');
    discard(dir);
  });
}

// THE ORDERING, on its own, because it is a defect independent of the carry and
// outlives the fix above: the driver refreshed the finalized head BEFORE testing
// the one-shot flags that decide whether a follow-up can be emitted at all. A
// head whose follow-up was already spent therefore still drove the refresh's
// side effects — it could MINT a bound while the very next line suppressed the
// question that would have explained it. Nothing the refresh writes is one of
// those three flags, so asking first is the same answer, taken before anything
// can be written.
test('a spent head does not mint a bound through the follow-up driver that then stays silent', () => {
  const dir = fixture('spent-head');
  exhaustTier(dir, 'NEW', 'quick-fix', 'cheapest');
  const claimed = claimCursorSpawnObservation(dir, 'NEW', 'tool_old', 'child-1');
  assert.ok(claimed, 'fixture guard: the failure is correlated to a child');
  consumeCursorSpawnObservation(dir, 'NEW', 'child-1');
  assert.ok(updateCursorSpawnObservation(dir, 'NEW', 'child-1', { followupEmitted: true }),
    'fixture guard: the one-shot follow-up for this head is already spent');
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'quick-fix'), false,
    'fixture guard: nothing has minted the bound yet');

  const emitted = claimCursorParentPendingFollowups(dir, 'NEW', {}, {}, 'parent-A', Date.now());
  assert.deepEqual(emitted, [], 'a spent head emits nothing, which is the whole point of the flags');
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'quick-fix'), false,
    'a pass that emits no question must not leave a bound behind to explain');
  discard(dir);
});

test('a genuinely new failure in the successor still mints the bound on its own merits', () => {
  // The other side of the suppression, and the one that keeps it from being a
  // laundering vector of its own: what is refused is re-deriving a row this run
  // did not observe, never deriving from a row it did.
  const dir = fixture('fresh');
  exhaustTier(dir, 'OLD', 'quick-fix', 'cheapest');
  carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
  writeCursorPolicy(dir, 'NEW');

  recordCursorSpawnObservation(dir, 'NEW', {
    parentSessionId: 'parent-A',
    toolCallId: 'tool_new',
    role: 'quick-fix',
    requestedModel: TIERS.cheapest[0],
    tier: 'cheapest',
    expectedModel: TIERS.cheapest[0],
  });
  claimCursorSpawnObservation(dir, 'NEW', 'tool_new', 'child-2');
  const fresh = updateCursorSpawnObservation(dir, 'NEW', 'child-2', {
    outcome: 'api-limit', error: 'usage limit reached',
  });
  assert.ok(fresh);
  assert.equal(fresh?.carriedFromRunId, null, 'fixture guard: a row recorded here carries no stamp');

  refreshPendingResolution(dir, 'NEW', fresh!);
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'quick-fix'), true,
    'the successor must still be able to reach terminal on a failure it actually saw');

  // And the documented remedy releases it — `enable-retry` recorded, then the
  // ledger cleared, which is the order choice-reply.ts performs them in. The
  // recorded choice is what keeps the next refresh from re-minting: clearing the
  // ledger alone leaves the requested model in the resolution's own exhausted
  // set, so a cheapest-tier role resolves straight back to terminal.
  assert.ok(writeModelChoice(dir, 'NEW', 'enable-retry'));
  clearExhaustedModels(dir, 'NEW');
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'quick-fix'), false);
  const again = refreshPendingResolution(dir, 'NEW', listCursorSpawnObservations(dir, 'NEW')
    .find((row) => row.toolCallId === 'tool_new')!);
  assert.equal(modelExhaustionTerminalForRole(dir, 'NEW', 'quick-fix'), false,
    'the remedy must hold for the cheapest tier, which has no lower row to fall to');
  assert.equal(again.prescribedModel, TIERS.cheapest[0],
    'and it must prescribe the model the user just restored, not nothing');
  discard(dir);
});

// ── 4. the stamp's boundary: an unresolved row is not a resolution ───────────
//
// The transaction releases CLAIMS and terminates nothing (the obligation table's
// own admission rule 4), so a child spawned in the retired run is still alive at
// reset time and its observation has NO outcome. Stamping it as a finished
// resolution made `refreshPendingResolution` hand the row back untouched when
// that child's failure was finally recorded — in the SUCCESSOR, by the successor
// — so the follow-up driver dropped it at its no-directive guard: the parent was
// never told its child failed, and never given the retry prescription. The
// silence was permanent, because nothing clears the stamp.
//
// MEASURED AGAINST A CONTROL that differs only in whether a reset happened in
// between, which is the only way to tell a suppression from an absence: the same
// spawn, the same child, the same failure, driven through the same product
// writers and the same follow-up driver.

/** A child spawned and correlated in `runId`, and NOT resolved: exactly the row
 *  a reset leaves behind for a child it did not kill. */
function spawnLiveChild(dir: string, runId: string): void {
  writeCursorPolicy(dir, runId);
  recordCursorSpawnObservation(dir, runId, {
    parentSessionId: 'parent-A',
    toolCallId: 'tool_live',
    role: 'quick-fix',
    requestedModel: TIERS.cheapest[0],
    tier: 'cheapest',
    expectedModel: TIERS.cheapest[0],
    startedAtMs: Date.now() - 60_000,
  });
  assert.ok(claimCursorSpawnObservation(dir, runId, 'tool_live', 'child-live'),
    'fixture guard: the live child is correlated to its spawn');
}

/**
 * WRITE ONE: the child's Stop hook records the death onto the row.
 *
 * Through `persistTerminalClassification`, which is the product function that
 * performs exactly this write and nothing more — the outcome and the error text.
 * The resolution is derived by a LATER pass, and the gap between the two is a
 * state a reset can land in; `recordChildDeath` therefore asserts it leaves the
 * row unresolved rather than trusting that it does.
 */
function recordChildDeath(dir: string, runId: string): void {
  const row = listCursorSpawnObservations(dir, runId).find((item) => item.childTranscriptId === 'child-live');
  assert.ok(row, 'fixture guard: the live child is on the store before it dies');
  const classified = persistTerminalClassification(dir, runId, row, {
    candidate: {
      filePath: '',
      parentSessionId: row.parentSessionId,
      childTranscriptId: 'child-live',
      birthtimeMs: row.startedAtMs,
      mtimeMs: row.startedAtMs,
    },
    role: row.role,
    lineCount: 1,
    terminal: true,
    failed: true,
    error: 'usage limit reached',
  });
  assert.ok(classified, 'fixture guard: the Stop hook recorded the failure');
  assert.equal(classified.observation.outcome, 'api-limit', 'fixture guard: the outcome is on the row');
  assert.equal(classified.observation.directive, null,
    'fixture guard: and the resolution is NOT — that gap is the window this file is about');
}

/** WRITE TWO: the head is finalized and the parent's own follow-up pass derives
 *  the resolution and emits it. What the parent gets for its dead child. */
function parentFollowupPass(dir: string, runId: string): {
  stamp: string | null;
  directive: boolean;
  followups: number;
} {
  assert.ok(consumeCursorSpawnObservation(dir, runId, 'child-live'),
    'fixture guard: the child terminated, which is what finalizes the head');
  const followups = claimCursorParentPendingFollowups(dir, runId, {}, {}, 'parent-A', Date.now());
  const row = listCursorSpawnObservations(dir, runId).find((item) => item.childTranscriptId === 'child-live');
  return {
    stamp: row?.carriedFromRunId ?? null,
    directive: Boolean(row?.directive),
    followups: followups.length,
  };
}

/** The failure the child records in `runId`, and what the parent gets for it —
 *  both writes, with no reset between them. */
function failLiveChild(dir: string, runId: string): ReturnType<typeof parentFollowupPass> {
  recordChildDeath(dir, runId);
  return parentFollowupPass(dir, runId);
}

test('a live child that fails AFTER the reset still reaches its parent', () => {
  const control = fixture('live-child-control');
  spawnLiveChild(control, 'NEW');
  const withoutReset = failLiveChild(control, 'NEW');
  // The control has to be LIVE or the comparison below proves nothing.
  assert.deepEqual(withoutReset, { stamp: null, directive: true, followups: 1 },
    'fixture guard: with no reset in the way, the parent gets a directive and one follow-up');
  discard(control);

  const reset = fixture('live-child-reset');
  spawnLiveChild(reset, 'OLD');
  const outcome = carryRunObligations(reset, 'OLD', 'NEW', { priorResets: 0 });
  assert.ok(outcome.carried.includes('cursor-spawns.json'), 'fixture guard: the row carried');
  writeCursorPolicy(reset, 'NEW');

  assert.deepEqual(failLiveChild(reset, 'NEW'), withoutReset,
    'a reset must not silence the failure of a child it left running: the row must carry no suppression '
    + 'stamp, the resolution must be derived, and the parent must get its one follow-up');
  discard(reset);
});

test('a reset landing BETWEEN the recorded death and its resolution still reaches the parent', () => {
  // THE THIRD DIRECTION, and the one the two above agree on by accident. They
  // pin the ends — a row with no outcome, and a row with a finished resolution —
  // and a predicate that stamps on `outcome !== null` gets both right while
  // getting the middle wrong. The middle is not an exotic interleaving: it is the
  // ordinary two-write sequence of every correlated failure, held open only for
  // as long as it takes the next pass to run.
  //
  //   write one  persistTerminalClassification  → outcome recorded
  //   ── a reset landing HERE stamps a row whose resolution was never derived,
  //      and the stamp then suppresses the derivation permanently ──
  //   write two  the parent's follow-up pass    → resolution derived, emitted
  //
  // MEASURED against a control differing only in whether the reset landed in the
  // window. Before the predicate was corrected: control `{stamp: null, directive:
  // true, followups: 1}`, with the reset `{stamp: 'OLD', directive: false,
  // followups: 0}` — the parent never told its child died, with no retry
  // prescription and no route back, because nothing clears the stamp.
  const control = fixture('window-control');
  spawnLiveChild(control, 'NEW');
  recordChildDeath(control, 'NEW');
  const withoutReset = parentFollowupPass(control, 'NEW');
  assert.deepEqual(withoutReset, { stamp: null, directive: true, followups: 1 },
    'fixture guard: with no reset in the window, the parent gets a directive and one follow-up');
  discard(control);

  const reset = fixture('window-reset');
  spawnLiveChild(reset, 'OLD');
  recordChildDeath(reset, 'OLD');
  const outcome = carryRunObligations(reset, 'OLD', 'NEW', { priorResets: 0 });
  assert.ok(outcome.carried.includes('cursor-spawns.json'), 'fixture guard: the row carried');
  writeCursorPolicy(reset, 'NEW');

  assert.deepEqual(parentFollowupPass(reset, 'NEW'), withoutReset,
    'a reset that lands between a child\'s recorded death and its resolution must not suppress the '
    + 'resolution: an outcome is not a resolution, and the row it stamps must be one');
  discard(reset);
});

test('the stamp lands on the resolved row and only on it, and a chained reset keeps naming the first run', () => {
  // BOTH DIRECTIONS IN ONE FIXTURE, because the property is a discriminator
  // rather than two independent facts: same store, same carry, two rows that
  // differ only in whether the retired run reached a resolution.
  const dir = fixture('stamp-boundary');
  exhaustTier(dir, 'OLD', 'quick-fix', 'cheapest');
  finishResolution(dir, 'OLD');                        // resolves `tool_old`/`child-1`
  spawnLiveChild(dir, 'OLD');                          // leaves `tool_live` unresolved

  carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
  const stamps = new Map(listCursorSpawnObservations(dir, 'NEW')
    .map((row) => [row.toolCallId, row.carriedFromRunId ?? null]));
  assert.equal(stamps.get('tool_old'), 'OLD',
    'a row that RESOLVED in the retired run is a finished resolution and must be suppressed');
  assert.equal(stamps.get('tool_live'), null,
    'a row with no outcome is not a resolution: stamping it silences the successor\'s own failure');

  // THE CHAINED-RESET WITNESS. "The stamp of an already-carried row is left
  // alone" was documented and behaviourally indistinguishable to every other
  // assertion here — re-stamping with the intermediate run would have passed
  // them all. It names the run that OBSERVED the spawn, which is not the run it
  // was last copied from.
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', 'NEWER'), { recursive: true });
  carryRunObligations(dir, 'NEW', 'NEWER', { priorResets: 1 });
  const chained = new Map(listCursorSpawnObservations(dir, 'NEWER')
    .map((row) => [row.toolCallId, row.carriedFromRunId ?? null]));
  assert.equal(chained.get('tool_old'), 'OLD',
    'a second reset must not re-stamp the row with the run it was copied from');
  assert.equal(chained.get('tool_live'), null,
    'and an unresolved row stays unstamped however many resets it survives');
  discard(dir);
});

// ── 5. the carry's error boundary ───────────────────────────────────────────

test('a carry row that THROWS is that row\'s failure, and the rows after it still run', () => {
  // The measured cause, planted verbatim: a NON-DIRECTORY at the successor's run
  // path. `withAgentRegistryLock`'s first statement is an unguarded recursive
  // directory create, so the carry threw ENOTDIR — through this function, through
  // the transaction, and out of the CLI as a stack trace, with the pointer already
  // moved and the retired claims already released.
  const dir = fixture('carry-throws');
  exhaustTier(dir, 'OLD', 'quick-fix', 'cheapest');
  recordRunAgent(dir, 'OLD', 'senior-frontend', { agentId: 'agent-old', parentSessionId: 'parent-A' });
  markModelChoicePrompted(dir, 'OLD');
  bumpRunAgentActivity(dir, 'OLD', 'senior-frontend', 'child-A');
  recordDenyRepeat(dir, 'OLD', 'plan-guard.write|src/app.tsx');

  const blocked = path.join(dir, '.traffic-one', 'runs', 'BLOCKED');
  fs.writeFileSync(blocked, 'not a directory\n', 'utf8');

  const started = Date.now();
  let outcome: CarryOutcome | null = null;
  assert.doesNotThrow(() => { outcome = carryRunObligations(dir, 'OLD', 'BLOCKED', { priorResets: 0 }); },
    'a carry failure is documented non-fatal; an exception out of here is the reset crashing');
  const elapsed = Date.now() - started;
  const failed = [...(outcome as unknown as CarryOutcome).failed].sort();
  assert.deepEqual((outcome as unknown as CarryOutcome).carried, [],
    'nothing can be carried into a path that is a file');
  // EVERY row with something to carry is named, including the ones after the
  // first failure — which used to be skipped silently because the thrower never
  // returned and the caller that assembles warnings never resumed.
  assert.deepEqual(failed, [
    'agent-activity',
    'agents.json',
    'cursor-spawns.json',
    'debug/deny-repeats.json',
    'exhausted-models.json',
    'model-choice-prompted',
  ], 'every row that could not carry must be NAMED, or the caller warns about none of them');

  // What this fixture actually costs, corrected: ~8s, which is ONE budget, not
  // three. A row whose lock THROWS costs nothing (the throw lands on the first
  // attempt), and only the store that answers an unusable path as "lease
  // unavailable" waits — so the comment that used to sit here, claiming this
  // measured the shared budget "for free", was measuring one store's budget and
  // a per-store-budget mutant survived it. The sharing across SEVERAL contended
  // stores is measured in the test below.
  assert.ok(elapsed < 14_000,
    `no row may wait out more than the one shared lease budget (took ${elapsed}ms)`);
  discard(dir);
});

test('the lease budget is ONE budget for the carry, not one per contended store', () => {
  // Contention with no second process: a regular FILE at a store's lock path is
  // a lock that can never be acquired, so the acquire loop runs to its own
  // timeout exactly as it does against a live holder — and unlike a holder, it
  // cannot finish early and make this test flaky in the direction of passing.
  //
  // Two contended stores. Against a per-store budget each burns 8s before its
  // final inner attempt (~18s for these two, ~24s for three); against one shared
  // deadline the pair costs 8s plus the ONE inner acquire the second store is
  // still entitled to once the deadline has lapsed — measured 10.3s, and the
  // third contended store would add its own 500ms attempt and nothing more.
  //
  // None of it is paid under the project state lock any longer (reset.ts's
  // settleReset runs after the transaction releases), so this bounds the
  // operator's own command rather than every other process on the machine.
  const dir = fixture('shared-budget');
  recordRunAgent(dir, 'OLD', 'senior-frontend', { agentId: 'agent-old', parentSessionId: 'parent-A' });
  recordCursorSpawnObservation(dir, 'OLD', {
    parentSessionId: 'parent-A',
    toolCallId: 'tool_1',
    role: 'senior-frontend',
    requestedModel: TIERS.cheapest[0],
    tier: 'cheapest',
    expectedModel: TIERS.cheapest[0],
  });
  const successor = path.join(dir, '.traffic-one', 'runs', 'NEW');
  fs.mkdirSync(successor, { recursive: true });
  for (const lock of ['.agents.lock', '.cursor-spawns.lock']) {
    fs.writeFileSync(path.join(successor, lock), 'a lock nobody can take\n', 'utf8');
  }

  const started = Date.now();
  const outcome = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
  const elapsed = Date.now() - started;

  assert.deepEqual([...outcome.failed].sort(), ['agents.json', 'cursor-spawns.json'],
    'fixture guard: both stores must really be contended, or the timing below measures nothing');
  assert.ok(elapsed >= 8_000,
    `fixture guard: a contended carry must actually wait out the budget (took ${elapsed}ms)`);
  assert.ok(elapsed < 14_000,
    `two contended stores must SHARE one lease budget, not take one each (took ${elapsed}ms)`);
  discard(dir);
});

test('a spawn-store write the writer REFUSED is reported as failed, not as carried', () => {
  // The signal that was dropped on the way through the store writer. The lease
  // was held, so the carry returned success; the write itself had been refused,
  // and "carried" went into the warnings AND into the audit record — while the
  // neighbouring registry carry propagated its own writer's boolean the whole
  // time. Held-the-lease and wrote-the-file are two different answers.
  //
  // A SYMLINK at the destination is the refusal that isolates the signal: the
  // lease is taken normally, the store reads normally (a link to nothing reads
  // as an empty store), and only the WRITE is refused — `writeFileNoFollow`
  // opens O_NOFOLLOW, which is the same false a containment refusal returns. A
  // directory at the destination would fail the row too, but through a THROW
  // caught by the error boundary, which is a different property and leaves this
  // one untested.
  const dir = fixture('spawn-write-refused');
  recordCursorSpawnObservation(dir, 'OLD', {
    parentSessionId: 'parent-A',
    toolCallId: 'tool_1',
    role: 'senior-frontend',
    requestedModel: TIERS.cheapest[0],
    tier: 'cheapest',
    expectedModel: TIERS.cheapest[0],
  });
  const successor = path.join(dir, '.traffic-one', 'runs', 'NEW');
  fs.mkdirSync(successor, { recursive: true });
  fs.symlinkSync(path.join(dir, 'elsewhere.json'), path.join(successor, 'cursor-spawns.json'));

  const outcome = carryRunObligations(dir, 'OLD', 'NEW', { priorResets: 0 });
  assert.ok(outcome.failed.includes('cursor-spawns.json'),
    'a refused write is a failed carry; the lease being held says nothing about the bytes');
  assert.ok(!outcome.carried.includes('cursor-spawns.json'),
    'and it is not simultaneously reported as carried');
  discard(dir);
});

// ── 6. the stamp's own fence ────────────────────────────────────────────────

test('the suppression stamp is not agent-writable: the whole store is a runtime-owned sidecar', () => {
  // NOT ESTABLISHED BEFORE, and it is the question the stamp raises: the field is
  // read straight off disk and no writer validates its provenance, so a forged
  // `carriedFromRunId` on a row the run genuinely observed would suppress that
  // run's own resolution — the WIDEN_AT bound included. Nothing in this store
  // could tell the forgery from a carry.
  //
  // The fence is not in this store and should not be: `runtime-sidecar-owner-gate`
  // refuses every agent write under `.traffic-one/runs/<id>/` at FILE granularity,
  // on a predicate that is purely the path shape — no role, no state, no content —
  // with `architecture-input-v1.json` as its single carve-out. So the forged stamp
  // is refused by the same gate that refuses forging the exhaustion entries the
  // stamp guards, and a field-level provenance check would buy nothing the file
  // fence does not already give.
  //
  // The residual, stated rather than closed: anything that can bypass that gate
  // (a shell channel plan-guard cannot see a path token in, or any process that is
  // not an agent) can forge the stamp exactly as it can forge the bounds.
  const dir = fixture('stamp-fence');
  const forged = JSON.stringify({
    version: 1,
    observations: [{ toolCallId: 'tool_new', carriedFromRunId: 'OLD' }],
  });
  for (const runId of ['OLD', 'NEW']) {
    const target = `.traffic-one/runs/${runId}/cursor-spawns.json`;
    assert.ok(planReadinessViolations({
      filePath: target,
      content: forged,
      projectRoot: dir,
      state: { currentRunId: 'NEW', team: { mode: 'subagents' }, activeAgentRole: 'senior-frontend' },
      writingFeatureSource: false,
      block: (id: string) => id,
    }).includes('runtime-sidecar-owner-gate'), target);
  }
  discard(dir);
});
