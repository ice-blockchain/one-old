// tests/replay-corpus/coverage.test.ts
// The corpus's own coverage meter, and the reason it cannot silently rot.
//
// The snapshot next door proves the verdicts this corpus DOES reach never
// change. It says nothing about how much of the refusal surface that is — and
// the corpus was started at 14 of 192 declared deny ids (7.3%), which protects
// almost none of a ~122-message deny-prose rewrite or a retiering of half the
// plan-guard surface. So reach is asserted here, two ways:
//
//   1. Per deny id, as a SUPERSET check against REACHED_DENY_IDS below. If a
//      change stops the corpus from reaching an id it used to reach, this names
//      that exact id instead of reporting a count that shrank. Adding new cases
//      never fails this list; only losing coverage does, which is the asymmetry
//      that lets the corpus grow without churn here.
//   2. As floors on the aggregate tallies (ids, denying gates, hosts, events,
//      tool classes, project states), so a whole DIMENSION cannot quietly
//      collapse either.
//
// It also prints the full reach report — reached and, more usefully, NOT
// reached, grouped by the module that owns each id — because the unreached list
// is the work queue for growing this corpus, and it is only accurate if it is
// derived from a real run rather than maintained by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DENY_IDS } from '../../src/config/deny-ids';
import { ALL_CASES } from './cases';
import { cleanupReplayTempTrees } from './fixtures';
import { replayCase, type CaseSpec, type CaseToolSpec, type ReplayOutcome } from './run-case';
import { instrumentedHandlers, replayHandlers } from './handlers';

test.after(cleanupReplayTempTrees);

// ── the reach target ────────────────────────────────────────────────────────
// STATED TARGET: every deny id that is reachable through the REAL composed
// pipeline from a project state a production writer can actually produce.
// That is deliberately not "all 192": a large minority of ids are unreachable
// by construction from this harness, and the report below prints them so the
// distinction stays honest rather than aspirational. The three structural
// classes, each derived from the source:
//
//   - The digest-completion family (plan-readiness/completion.ts, ~29 ids) and
//     the run-team family (plan-runteam.ts, 10 ids) need a LIVE run: compiled
//     runtime assignments hash-valid for `currentRunId`, per-role claims, and
//     reviewer/tester digests. That state is produced by scripted multi-role
//     runs, which is exactly what src/test-environment (`npm run test:env`)
//     exists to drive; duplicating it here would fork that harness, and
//     hand-writing the state would characterize a shape no writer produces.
//   - The Codex child-model family (codex-child-model.ts, 15 ids) needs a real
//     Codex child thread identity plus a transcript the gate reads back.
//   - `pipeline-handler-crashed` needs a handler that THROWS; the corpus runs
//     the real handler set on purpose, so it has none.
//
// Everything else is fair game and the number below is the floor, not the goal.
// Reach today: 67 of 201 declared ids (33%), which is 67 of the ~140 that are
// reachable at all by the definition above (~48%). Every remaining group is
// named in the printed report's `unreached:` lines and pinned by
// UNREACHED_DENY_IDS below.
//
// ── the rule these floors follow ────────────────────────────────────────────
// Each floor sits at TODAY'S TALLY minus the largest single drop a legitimate
// refactor could cause in that dimension — not at a round number, and not at
// whatever the tally happened to be when the dimension was first counted. A
// floor with more slack than that is not a floor: MIN_PROJECT_STATES was 12
// against an actual 28, so more than half the corpus's project coverage could
// have been deleted without a single test going red.
//
// Raise a floor whenever the tally rises past it by more than its margin.
// LOWER one only together with a written reason for why the coverage it
// protected is genuinely no longer needed — a red floor is the intended
// outcome of losing coverage, not an obstacle to it.
//
//   deny ids       -3  a deny-prose retiering can legitimately merge a small
//                      family of ids into one. REACHED_DENY_IDS already names
//                      each individual loss, so this is only the backstop.
//   denying gates  -1  two gates in one module can legitimately merge; three
//                      cannot happen by accident.
//   project states -2  two fixture builders can legitimately collapse into one
//                      parameterized builder (greenfieldMainAgent and
//                      materializedGreenfield are already one call apart).
const MIN_DENY_IDS_REACHED = 63; // 67 today
const MIN_DENYING_GATES = 12; // 13 today
const MIN_PROJECT_STATES = 32; // 34 today

// Handlers whose `run` is INVOKED at least once, out of the whole registered
// set (all events, not just PreToolUse) — see instrumentedHandlers. A handler
// nothing invokes is protected by nothing, denier or not.
//
// Named, not counted, and deliberately so. A COUNT floor at today's 30-of-31
// looks binding and is not: registering a 32nd handler the corpus never
// invokes leaves the reached count at 30, which still clears a floor of 30, so
// the one thing this tally exists to catch — a new handler arriving with no
// coverage — is exactly what it cannot see. Listing the permitted exceptions
// instead makes that case fail, by name, and keeps the reason for each
// exception next to it. The answer to "should a new handler with no corpus
// coverage fail this test?" is yes: adding the case is cheaper than the next
// person having to work out which handlers were ever exercised.
const HANDLERS_NEVER_INVOKED: Record<string, string> = {
  // PostToolUse(spawn-agent). The corpus has no PostToolUse spawn case because
  // the handler records a spawn that a PRE-tool gate already admitted, and no
  // fixture here holds the runtime assignment that admission needs — the same
  // live-run state the run-team deny family is unreachable behind (above).
  'agent-model.record-spawn': 'PostToolUse(spawn-agent) — needs a live run whose spawn was already admitted',
};

// Every deny id the corpus reaches today. Sorted; regenerate with the block this
// test prints. A missing entry fails the test by name.
const REACHED_DENY_IDS: readonly string[] = [
  'absolute-traffic-one-path',
  'apply-patch-payload-invalid',
  'apply-patch-reconstruction-failed',
  'architect-phase-incomplete',
  'asset-extension-mismatch',
  'authoring-guard',
  'browser-open-denied',
  'claude-wait-background-denied',
  'component-placement',
  'cross-feature-import',
  'css-ts-import',
  'cursor-agent-type-required',
  'deep-relative-package',
  'default-export',
  'deploy-gate-fingerprint-mismatch',
  'deploy-gate-security-check-stale',
  'deploy-gate-shipper-approval-required',
  'expo-route-service-files',
  'kilo-general-agent-required',
  'library-allowlist-forbidden',
  'model-choice-stop-first',
  'model-choice-stop-repeat',
  'monorepo-package-json',
  'monorepo-root-flat-scaffold',
  'monorepo-root-vite',
  'native-dom-tags',
  'native-inline-style',
  'no-any',
  'onboarding-cursor-models-required',
  'onboarding-server-deny-first',
  'onboarding-server-deny-repeat',
  'onboarding-setup-required-opencode',
  'onboarding-use-plugin-question',
  'one-mcp-tool-gate',
  'opencode-external-temp-shell',
  'opencode-named-agent-required',
  'pages-service-files',
  'performance-main-agent',
  'performance-model-param',
  'plan-gate',
  'plan-write-model-choice-pending',
  'plan-write-struct-scan-incomplete',
  'registry-probe-gate',
  'repaired-materialization',
  'run-id-mismatch',
  'runtime-assignments-owner-gate',
  'scaffold-main-agent-plan-gate',
  'scaffold-plan-gate',
  'scaffold-stack-gate',
  'spawn-background-forbidden',
  'spawn-child-cannot-mint-run',
  // Reached from the corpus's very first run, and listed in NEITHER array until
  // now — which is not a hole (an id that stops being reached still fails
  // `newlyUnreached`) but the WRONG failure: that assertion's message says "a
  // new id shipped without a case" and tells the reader to pin it as UNREACHED,
  // so losing real coverage invited a pin instead of a fix. It also left the
  // printed reach count (67) one ahead of this list's length (66), which is the
  // discrepancy that surfaced it.
  'spawn-claim-unavailable',
  'spawn-role-conflict',
  'spawn-run-id-mismatch',
  'state-mode-downgrade',
  'supabase-local-stack-gate',
  'team-mode-downgrade-guard',
  'team-mode-marker-guard',
  'tech-classify-required',
  'user-approval-request',
  'vanilla-extract-import',
  'web-inline-style',
  'websocket-location',
  'windsurf-server-deny-reason',
  'windsurf-server-deny-reason-repeat',
  'workspace-boundary-guard',
  'workspace-boundary-unresolved-expansion',
];

// The mirror image of REACHED_DENY_IDS, and the reason the 134 unreached ids
// are now BOUNDED as well as reported. Sorted; regenerate with the block this
// test prints.
//
// REACHED_DENY_IDS is a superset check on the reached set: it fails when the
// corpus LOSES an id. That leaves the other direction open, and it is the
// direction the deny catalog actually moves in — `src/config/deny-ids.ts`
// grows. A newly declared id that no case reaches raises the unreached tally
// silently: the reached COUNT is unchanged, so MIN_DENY_IDS_REACHED still
// passes, the per-id superset check still passes, and the only trace is one
// more name in a 134-entry printed list nobody diffs. The corpus's reach then
// falls as a fraction of the surface while every assertion stays green.
//
// So this is a subset check on the unreached set — the unreached set may
// SHRINK freely (reaching a new id never fails anything) but may not grow.
// Failure modes it names, both of which are real:
//   - a new deny id declared with no corpus case behind it;
//   - an id that was never reachable becoming a NEW kind of unreachable
//     because a case that used to be its neighbour was deleted.
const UNREACHED_DENY_IDS: readonly string[] = [
  'agent-activity-exploration-cap',
  'agent-materialization-deny',
  'agent-materialization-missing',
  'agent-reuse-await-codex-meta',
  'agent-reuse-await-cursor-id',
  'agent-reuse-continue',
  // Strictly behind `agent-reuse-continue` above, which the corpus does not
  // reach either: both additionally need a LIVE quick-fix agent recorded for
  // the run AND a spawn carrying a valid `[t1-bounded-scope]` marker. Driven
  // instead through the real gate in
  // modules/agent-model/__tests__/scope-regrant.test.ts.
  'agent-reuse-scope-regrant',
  'agent-reuse-scope-regrant-refused',
  'architect-memory-baseline-gate',
  'architect-opencode-queue-gate',
  'architect-opencode-queue-policy-gate',
  'architect-opencode-self-delegation-gate',
  'architect-planning-allowlist-gate',
  'architecture-contract-gate',
  'architecture-input-gate',
  'architecture-input-owner-gate',
  'architecture-input-shell-unverified',
  'bootstrap-publication-gate',
  'capability-no-implementer-gate',
  'claude-wait-link-first',
  'codex-child-model-bootstrap-mismatch',
  'codex-child-model-capability-record-failed',
  'codex-child-model-claim-persist-failed',
  'codex-child-model-identity-conflict',
  'codex-child-model-ledger-closed',
  'codex-child-model-ledger-illegible',
  'codex-child-model-no-child-id',
  'codex-child-model-observation-persist-failed',
  'codex-child-model-policy-missing',
  'codex-child-model-role-held',
  'codex-child-model-role-not-observable',
  'codex-child-model-role-unbound',
  'codex-child-model-run-missing',
  'codex-child-model-status-conflict',
  'codex-child-model-status-unverified',
  'codex-wait-link-first',
  'contract-self-conflict',
  'cursor-api-limit-composer-choice',
  'cursor-api-limit-terminal',
  'cursor-exact-model-required',
  'cursor-failure-composer-floor-choice-pending',
  'cursor-failure-enable-retry-mismatch',
  'cursor-failure-model-unavailable-choice-pending',
  'cursor-failure-no-model-available',
  'cursor-failure-policy-missing',
  'cursor-failure-retry-model-mismatch',
  'cursor-models-capture',
  'cursor-wait-link-first',
  'deploy-gate-fingerprint-error',
  'finding-allowlist-gap',
  'frontend-collapse-gate',
  'frontend-emit-config-gate',
  'frontend-eslint-survival-gate',
  'frontend-structure-completion-gate',
  'frontend-structure-hot-gate',
  'frontend-structure-scan-incomplete',
  'implementer-collapse-gate',
  'implementer-contract-delivery-gate',
  'implementer-crawl-origin-gate',
  'implementer-format-coverage-gate',
  'implementer-format-parity-gate',
  'implementer-format-toolchain-gate',
  'implementer-lint-invocation-gate',
  'implementer-lint-toolchain-gate',
  'implementer-test-toolchain-gate',
  'implementer-typecheck-invocation-gate',
  'implementer-typecheck-toolchain-gate',
  'implementer-verification-skipped-gate',
  'lighthouse-claim-reconciliation-gate',
  'materialization-gate',
  'model-choice-enable-required',
  'model-rotation-exhausted-model',
  'model-rotation-policy-missing',
  'model-rotation-tier-exhausted',
  'model-rotation-tier-missing-from-catalog',
  'model-unavailable-choice',
  'onboarding-model-policy-freeze-failed',
  'onboarding-model-policy-host-mismatch',
  'onboarding-run-bootstrap-unavailable',
  'onboarding-server-deny-links-shown',
  'onboarding-server-not-ready',
  // All three sit behind a launcher that could not start, which the corpus has
  // no fixture for — the same reason their predecessor above is pinned. A real
  // case would be better than a pin: it needs a project whose `~/.traffic-one`
  // path is occupied by a regular file, which is how the onboarding-gate suite
  // makes the failure deterministic.
  'onboarding-server-start-failed',
  'onboarding-server-start-timeout',
  'onboarding-server-start-timeout-exhausted',
  'onboarding-stop-link-posted',
  'onboarding-stop-links-shown',
  'onboarding-stop-required',
  'opencode-plan-batch-required',
  'opencode-reserved-files',
  'opencode-role-delegate',
  'pipeline-handler-crashed',
  'plan-architect-self-gate',
  'plan-main-agent-gate',
  'plan-opencode-queue-gate',
  'plan-opencode-queue-policy-gate',
  'plan-opencode-self-delegation-gate',
  'plan-write-violation-unattributed',
  'reviewer-structure-gate',
  'run-artifact-work-unit-gate',
  'run-team-fallback-taken',
  'run-team-maintenance-contract',
  'run-team-not-subagent',
  'run-team-quick-fix-contract',
  'run-team-runtime-allowlist-gap',
  'run-team-runtime-contract-invalid',
  'run-team-scope-conflict',
  'run-team-shell',
  'run-team-wrong-role',
  'runtime-sidecar-owner-gate',
  'spawn-bootstrap-publish-failed',
  'spawn-bounded-scope-missing',
  'spawn-child-cannot-create-policy',
  'spawn-host-capability-missing',
  'spawn-model-policy-corrupt',
  'spawn-model-policy-host-mismatch',
  'spawn-model-policy-unavailable',
  'spawn-role-no-compiled-assignment',
  'spawn-run-id-unparseable',
  'state-gate',
  'subagent-bind-cursor-policy-missing',
  'subagent-bind-cursor-role-missing',
  'subagent-bind-model-choice-pending',
  'team-confirmation',
  'tester-planned-module-gate',
  'tester-qa-build-identity-mismatch',
  'tester-qa-build-identity-missing',
  'tester-qa-v2-gate',
  'tester-stale-qa-gate',
  'verification-contract-refresh-gate',
  'verification-contract-refresh-gate-approved',
  'verification-contract-refresh-gate-tests-green',
  'verification-contract-scan-gate',
  'verifier-independence-gate',
  'verify-batch-running',
  // Structurally unreachable from this corpus, and it is the deny's own point.
  // `workspace-member-unresolved` fires only when the resolved project root
  // carries `mode: 'workspace'` plus a member registry, and NOTHING writes that
  // mode — the workspace-onboarding producer is a separate, not-yet-built item,
  // so no corpus fixture (and no project on any machine) can be in the state
  // this refuses. The guard ships BEFORE the producer on purpose: shipping them
  // the other way round leaves a window in which a container exists and every
  // gate happily operates on it. Driven instead through the real gates in
  // src/shared/__tests__/tool-scope-fence.test.ts, which builds the workspace
  // fixture the corpus cannot. Move it here to REACHED the day a corpus case
  // can onboard a workspace.
  'workspace-member-unresolved',
];

// PreToolUse handlers that CANNOT produce a deny, so they can never appear in
// the denying-gate tally no matter how the corpus grows. Both are asserted to be
// EXERCISED instead (a case whose tool class / shape reaches them), because
// "reached" for a context-only handler cannot be read off a verdict.
const NON_DENYING_PRE_TOOL_HANDLERS: Record<string, string> = {
  // src/modules/graphify/index.ts: "context-only, runs after the gates".
  'graphify.hint': 'search-class hint, returns context/noop only',
  // src/modules/materialize/index.ts: a manual subcommand, inert whenever a
  // tool is present, and runMaterializeProject returns context/noop only.
  'materialize.materialize-project': 'manual materialize-project command, no deny path',
};

function groupOf(denyId: string): string {
  // `workspace-member-unresolved` is resolved in shared/tool-scope.ts and
  // returned by every PreToolUse gate, so it belongs to no single module — it
  // is grouped with the other workspace/boundary refusals because that is what
  // a reader scanning the report for "did the boundary family regress?" would
  // look under. Without the widened prefix it fell through to the catch-all
  // "plan-guard / static checks", which is simply untrue.
  if (/^(workspace-|apply-patch|authoring-guard)/.test(denyId)) return 'session guards';
  if (/^one-mcp/.test(denyId)) return 'one-mcp-tool-gate';
  if (/^codex-child-model|^agent-activity/.test(denyId)) return 'agent-model / codex child';
  if (/^(spawn-|cursor-models-capture|absolute-traffic-one-path|subagent-bind|agent-reuse|verifier-independence|opencode-plan-batch|verify-batch|opencode-role-delegate|agent-materialization|performance-|team-confirmation|architect-phase|cursor-exact-model|model-unavailable-choice|model-rotation|cursor-api-limit|model-choice-enable|cursor-failure|cursor-agent-type|opencode-named-agent|kilo-general-agent)/.test(denyId)) return 'agent-model / spawn + model';
  if (/^model-choice-stop/.test(denyId)) return 'model-choice-gate';
  if (/^(deploy-gate|supabase-local|scaffold-|library-allowlist)/.test(denyId)) return 'plan-guard / stack gates';
  if (/^(plan-write|run-id-mismatch|registry-probe|state-mode-downgrade|opencode-external-temp|opencode-reserved|run-team)/.test(denyId)) return 'plan-guard / write dispatcher';
  if (/^(onboarding|browser-open|tech-classify|claude-wait|cursor-wait|codex-wait|windsurf-server|team-mode|repaired-materialization)/.test(denyId)) return 'onboarding-gate';
  if (/^(pipeline-handler-crashed|user-approval-request)/.test(denyId)) return 'core';
  // Everything else is a plan-write violation name (plan-static, plan-readiness,
  // completion) — the biggest family, split so the report stays readable.
  if (/(gate|scan-incomplete|collapse|parity|coverage|reconciliation|allowlist-gap|conflict|identity-mis|identity-mis)/.test(denyId)) return 'plan-guard / readiness + completion';
  return 'plan-guard / static checks';
}

// `tool` may be a function of the resolved fixture root (run-case.ts) for the
// commands that must name a per-run temp path. Those are all shell commands by
// construction, and the class is what this file counts, so name it without
// building a fixture just to read it.
function toolClassOf(spec: CaseSpec): string {
  if (typeof spec.tool === 'function') return 'shell';
  return (spec.tool as CaseToolSpec | undefined)?.class ?? '(none)';
}

function report(outcomes: readonly ReplayOutcome[], handlersReached: ReadonlySet<string>): string {
  const reachedIds = new Set(outcomes.filter((o) => o.denyId).map((o) => o.denyId));
  const lines: string[] = [];
  const byGroup = new Map<string, { reached: string[]; missing: string[] }>();
  for (const id of DENY_IDS) {
    const group = groupOf(id);
    const bucket = byGroup.get(group) ?? { reached: [], missing: [] };
    (reachedIds.has(id) ? bucket.reached : bucket.missing).push(id);
    byGroup.set(group, bucket);
  }
  lines.push('');
  lines.push('── replay corpus reach ──────────────────────────────────────────────');
  lines.push(`cases: ${outcomes.length}   deny ids reached: ${reachedIds.size}/${DENY_IDS.length}`
    + ` (${((reachedIds.size / DENY_IDS.length) * 100).toFixed(1)}%)`);
  for (const [group, bucket] of [...byGroup.entries()].sort((a, b) => b[1].reached.length - a[1].reached.length)) {
    lines.push(`  ${group}: ${bucket.reached.length}/${bucket.reached.length + bucket.missing.length}`);
    if (bucket.missing.length) lines.push(`      unreached: ${bucket.missing.join(', ')}`);
  }
  const gates = [...new Set(outcomes.filter((o) => o.gate).map((o) => o.gate))].sort();
  lines.push(`denying gates (${gates.length}): ${gates.join(', ')}`);
  const all = replayHandlers();
  const pre = all.filter((h) => h.event === 'PreToolUse');
  const preReached = pre.filter((h) => handlersReached.has(h.id));
  lines.push(`handlers RUN: ${handlersReached.size}/${all.length} overall,`
    + ` ${preReached.length}/${pre.length} PreToolUse`);
  const neverRun = all.filter((h) => !handlersReached.has(h.id)).map((h) => `${h.id}(${h.event})`);
  if (neverRun.length) lines.push(`      never invoked: ${neverRun.sort().join(', ')}`);
  const ranNoDeny = preReached.filter((h) => !gates.includes(h.id)).map((h) => h.id);
  if (ranNoDeny.length) lines.push(`      PreToolUse invoked but never denying: ${ranNoDeny.sort().join(', ')}`);
  const decisions = new Map<string, number>();
  for (const o of outcomes) decisions.set(o.decision, (decisions.get(o.decision) ?? 0) + 1);
  lines.push(`decisions: ${[...decisions.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`hosts (${new Set(ALL_CASES.map((c) => c.host)).size}): ${[...new Set(ALL_CASES.map((c) => c.host))].sort().join(', ')}`);
  lines.push(`events: ${[...new Set(ALL_CASES.map((c) => c.event))].sort().join(', ')}`);
  lines.push(`project states: ${new Set(ALL_CASES.map((c) => c.project)).size} distinct fixture builders`);
  lines.push(`tool classes: ${[...new Set(ALL_CASES.map(toolClassOf))].sort().join(', ')}`);
  lines.push('');
  lines.push('paste-ready REACHED_DENY_IDS (only ever grows — see the header):');
  lines.push([...reachedIds].sort().map((id) => `  '${id}',`).join('\n'));
  lines.push('');
  lines.push('paste-ready UNREACHED_DENY_IDS (only ever shrinks — see the header):');
  lines.push(DENY_IDS.filter((id) => !reachedIds.has(id)).slice().sort().map((id) => `  '${id}',`).join('\n'));
  lines.push('────────────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

test('replay corpus: per-deny-id reach does not regress', async () => {
  const handlersReached = new Set<string>();
  const handlers = instrumentedHandlers(handlersReached);
  const outcomes: ReplayOutcome[] = [];
  for (const spec of ALL_CASES) outcomes.push(await replayCase(spec, handlers));
  process.stdout.write(`${report(outcomes, handlersReached)}\n`);

  const neverInvoked = replayHandlers().filter((h) => !handlersReached.has(h.id));
  const unexpectedlyNeverInvoked = neverInvoked.filter((h) => !(h.id in HANDLERS_NEVER_INVOKED));
  assert.ok(
    unexpectedlyNeverInvoked.length === 0,
    'replay corpus: registered handler(s) whose run() is never invoked by any case. A handler nothing\n'
    + 'invokes is protected by nothing — add a case whose event/tool class/subcommand reaches it, or, if it\n'
    + 'genuinely cannot be reached from a fixture project state, add it to HANDLERS_NEVER_INVOKED with the\n'
    + `reason:\n\n  ${unexpectedlyNeverInvoked.map((h) => `${h.id} (${h.event})`).join('\n  ')}`,
  );
  // The allowlist is not a floor either: an entry that became reachable has to
  // leave it, or it silently permits the NEXT handler to go uncovered too.
  const staleExceptions = Object.keys(HANDLERS_NEVER_INVOKED).filter((id) => handlersReached.has(id));
  assert.ok(
    staleExceptions.length === 0,
    `HANDLERS_NEVER_INVOKED lists handler(s) the corpus now DOES invoke — remove them:\n\n  ${staleExceptions.join('\n  ')}`,
  );

  const reachedIds = new Set(outcomes.filter((o) => o.denyId).map((o) => o.denyId));
  const lost = REACHED_DENY_IDS.filter((id) => !reachedIds.has(id));
  assert.ok(
    lost.length === 0,
    'replay corpus reach REGRESSED — these deny ids were reached by the checked-in corpus and are\n'
    + 'not reached any more. Either a gate stopped firing (a real behavior change: characterize it\n'
    + 'instead of deleting the entry), or a case\'s fixture stopped satisfying the precondition and\n'
    + `now lands on an earlier gate:\n\n  ${lost.join('\n  ')}`,
  );

  assert.ok(
    reachedIds.size >= MIN_DENY_IDS_REACHED,
    `replay corpus reaches ${reachedIds.size} of ${DENY_IDS.length} deny ids, below the floor of `
    + `${MIN_DENY_IDS_REACHED}. See the printed report for the unreached list.`,
  );

  // The other direction: the unreached set may shrink, never grow.
  const pinnedUnreached = new Set(UNREACHED_DENY_IDS);
  const newlyUnreached = DENY_IDS.filter((id) => !reachedIds.has(id) && !pinnedUnreached.has(id));
  assert.ok(
    newlyUnreached.length === 0,
    'replay corpus: declared deny id(s) that no case reaches and that UNREACHED_DENY_IDS does not\n'
    + 'account for. A new id shipped without a case is the corpus quietly covering a smaller fraction of\n'
    + 'the refusal surface than it did yesterday. Add a case that reaches it, or add it to\n'
    + `UNREACHED_DENY_IDS (the report prints a paste-ready block) with the reason it cannot be reached:\n\n  ${newlyUnreached.join('\n  ')}`,
  );
  const nowReached = UNREACHED_DENY_IDS.filter((id) => reachedIds.has(id));
  assert.ok(
    nowReached.length === 0,
    'UNREACHED_DENY_IDS lists deny id(s) the corpus now DOES reach. Move them to REACHED_DENY_IDS so the\n'
    + `superset check protects them from being lost again:\n\n  ${nowReached.join('\n  ')}`,
  );
  const alsoDeclaredReached = UNREACHED_DENY_IDS.filter((id) => REACHED_DENY_IDS.includes(id));
  assert.ok(
    alsoDeclaredReached.length === 0,
    `deny id(s) listed in BOTH REACHED_DENY_IDS and UNREACHED_DENY_IDS:\n\n  ${alsoDeclaredReached.join('\n  ')}`,
  );

  const gates = new Set(outcomes.filter((o) => o.gate).map((o) => o.gate));
  assert.ok(
    gates.size >= MIN_DENYING_GATES,
    `replay corpus reaches ${gates.size} denying gates, below the floor of ${MIN_DENYING_GATES}: `
    + `${[...gates].sort().join(', ')}`,
  );

  // Every deny id recorded must be a DECLARED one: the pipeline synthesizes
  // `unattributed-handler:<gateId>` for a handler that declared none
  // (core/types.ts's FallbackDenyId), which is a gap rather than a cause. A
  // corpus row carrying one means a real call site is unattributed.
  const declared = new Set<string>(DENY_IDS);
  const unattributed = outcomes.filter((o) => o.denyId && !declared.has(o.denyId));
  assert.ok(
    unattributed.length === 0,
    'replay corpus: deny(s) with an undeclared/synthesized deny id — the handler behind each of these\n'
    + 'never declared one, so a budget or the decision log cannot tell it apart from any other deny\n'
    + `from the same gate:\n\n  ${unattributed.map((o) => `${o.id}: ${o.gate} -> ${o.denyId}`).join('\n  ')}`,
  );
});

test('replay corpus: covers every project state and both non-denying PreToolUse handlers', () => {
  // Project states are the OTHER axis the snapshot cannot see: a corpus that
  // reaches 60 deny ids from two fixtures characterizes two states' worth of
  // behavior. Counted by fixture-builder identity, which is what a state IS
  // here.
  const builders = new Set(ALL_CASES.map((c) => c.project));
  assert.ok(
    builders.size >= MIN_PROJECT_STATES,
    `replay corpus exercises ${builders.size} distinct project-state builders, below the floor of ${MIN_PROJECT_STATES}`,
  );

  const preToolHandlers = replayHandlers().filter((h) => h.event === 'PreToolUse');
  for (const [id, why] of Object.entries(NON_DENYING_PRE_TOOL_HANDLERS)) {
    assert.ok(preToolHandlers.some((h) => h.id === id), `${id} is no longer a registered PreToolUse handler`);
    // If one of these grows a deny path, this stops being true and the tally
    // denominator in the report is wrong — fail so the list gets revisited.
    assert.ok(why.length > 0);
  }
  // graphify.hint only runs for the `search` class; materialize.materialize-project
  // only acts when the PreToolUse payload carries NO tool (its manual-subcommand
  // shape). Assert the corpus contains both shapes, since neither can be observed
  // from a verdict.
  assert.ok(
    ALL_CASES.some((c) => c.event === 'PreToolUse' && toolClassOf(c) === 'search'),
    'no PreToolUse(search) case — graphify.hint never runs',
  );
  assert.ok(
    ALL_CASES.some((c) => c.event === 'PreToolUse' && !c.tool),
    'no tool-less PreToolUse case — materialize.materialize-project never acts',
  );
});
