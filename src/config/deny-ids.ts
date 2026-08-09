// src/config/deny-ids.ts
// The full, enumerable catalog of deny ids: declared, stable, machine-readable
// identifiers for "the distinct CAUSE a call was refused" — never derived
// from rendered prose (deny text is resolved from SKILL.md at runtime and
// interpolates paths/counts/agent ids, so a text key never repeats, and an
// unresolvable skill block makes every deny render as `''`, collapsing all
// ~120 gates into one bucket). This lives in src/config/ (not src/core/)
// because it is a plain, side-effect-free constant consumed by both core
// (core/types.ts's DenyId, core/pipeline.ts's fallback) and every module that
// calls `deny(...)` — the same layer as the rest of this directory's shared
// enums/config (config/model-tiers.ts, config/stacks.ts, etc.), never the
// other way around (core does not depend on modules/).
//
// Enumerability is the point: a later deny budget's non-overridable
// exclusion list, the decision log, a "every deny id has prose" build gate,
// and a deny-prose conformance test all need to iterate the full set instead
// of re-deriving it from call sites. Import DENY_IDS / DENY_ID_SET for that;
// import DenyId for the compile-time union (a typo in a call site's
// `denyId:` is then a type error, not a silent new bucket).
//
// Naming rules (apply consistently; see the work-item report for the merge/
// split judgement calls):
//   - kebab-case, scoped `<gate-area>-<cause>` where that reads naturally.
//   - Stable across a prose rewrite — a later item rewrites ~120 messages and
//     no id may change as a result. Never named after the CURRENT wording.
//   - One id per distinct CAUSE, not per call site: two sites that refuse the
//     same way with the same remedy share an id (`gateId` still tells them
//     apart per-handler); one site reached for genuinely different reasons
//     gets two ids, chosen at the call site.
//   - Reuse existing vocabulary where the codebase already names a cause
//     (e.g. planReadinessViolations' `runtime-assignments-owner-gate`) rather
//     than inventing a parallel name.

export const DENY_IDS = [
  // ── core/pipeline: fail-closed crash path ───────────────────────────────
  // A handler threw instead of returning a HookResult. One cause, one id,
  // regardless of which handler crashed (gateId already distinguishes those).
  'pipeline-handler-crashed',

  // ── core/result: askUser ────────────────────────────────────────────────
  // NOT a refusal. `askUser()` reuses the deny KIND so merge/short-circuit
  // semantics are unchanged, but what it produces is a live human
  // approve/reject prompt (Cursor `permission:"ask"`), so it needs an
  // identity of its own — without one the pipeline minted
  // `unattributed-handler:<gateId>` for it and the decision log recorded an
  // approval question as an anonymous deny. Names the PROMPT class, not a
  // cause; `gateId` still says which gate asked.
  //
  // A deny budget (allow-at-N per denyId) MUST SKIP records carrying this id
  // — counting an approval prompt as a refusal would spend a bucket on a
  // question the user answered, and there is nothing here to bound: the human
  // is the rate limit. `askUser: true` on the result is the same signal for
  // any consumer holding a HookResult rather than a log record.
  'user-approval-request',

  // ── modules/session/workspace-boundary-guard.ts ─────────────────────────
  'workspace-boundary-guard',
  'workspace-boundary-unresolved-expansion',

  // ── modules/session/authoring-guard.ts ──────────────────────────────────
  'authoring-guard',

  // Shared by workspace-boundary-guard.ts, authoring-guard.ts and
  // plan-guard/plan-write/index.ts: an apply_patch payload could not be
  // parsed into per-file operations. Same root cause and same remedy (fix
  // the patch envelope) no matter which gate needed to inspect it first.
  'apply-patch-payload-invalid',
  // NOT the same cause: the envelope parsed, then reconstruction against the
  // on-disk baseDir failed (plan-write/index.ts's second parseApplyPatch) —
  // the patch's context drifted from the file, so the remedy is "re-read the
  // file and rebuild the hunks", not "fix the patch syntax". Split out so a
  // budget can bound a drifting agent without spending the malformed-envelope
  // bucket, and so the two are distinguishable in the decision log (they
  // render the same sentence with a different embedded parser error).
  'apply-patch-reconstruction-failed',

  // ── modules/one-mcp-tool-gate/index.ts ───────────────────────────────────
  'one-mcp-tool-gate',

  // ── modules/agent-model/codex-child-model.ts ────────────────────────────
  'agent-activity-exploration-cap',
  'codex-child-model-policy-missing',
  'codex-child-model-role-unbound',
  'codex-child-model-bootstrap-mismatch',
  'codex-child-model-identity-conflict',
  'codex-child-model-run-missing',
  'codex-child-model-no-child-id',
  'codex-child-model-role-not-observable',
  // The observation store returning NOTHING is three answers, not one, and
  // `codex-child-model-status-unverified` used to carry all three. Nothing else
  // on those denies could tell them apart: the gate writes no per-branch record,
  // and `denyTarget` is the same `role` string on every branch, so `denyId` was
  // the ONLY discriminator in the decision log — and it said the same word for a
  // two-second lock and a run whose policy is gone. Split at the call site, in
  // the order codex-child-model.ts probes:
  //   - the frozen model policy is missing/corrupt/foreign-host. That is the
  //     cause this same file's non-Codex branch already names, at the same
  //     severity and with a verbatim-equivalent remedy, so that branch REUSES
  //     `codex-child-model-policy-missing` instead of minting a parallel name
  //     for one cause. The two sites are host-disjoint and the decision log
  //     records `host`, so sharing loses nothing.
  //   - the policy is intact and the observed-model RECORD could not be
  //     written: the store's own lock or refused write, nothing about the child
  //     rejected, remedy one bounded retry. Named for the store and the failure
  //     rather than for either wording, and it takes
  //     `codex-child-model-claim-persist-failed`'s `-persist-failed` suffix
  //     because that id is this one's twin two probes later — same lock, same
  //     "retry once, then replace the child from the parent".
  'codex-child-model-observation-persist-failed',
  'codex-child-model-status-conflict',
  // Narrowed by that split back to what the name always said: a record EXISTS
  // and its status is not `verified` (`pending-role` — no model was observed for
  // this child on any event). Unlike the two above, a respawn IS the fix here,
  // because a respawn can carry the model.
  'codex-child-model-status-unverified',
  'codex-child-model-ledger-closed',
  // The ledger could not be READ, which is not the same refusal as a closed one
  // and does not share its remedy: a closed run can be resumed (out of `blocked`)
  // or settled and replaced, while an illegible one refuses the claim mint, the
  // resume AND the settlement with `ledger-corrupt`, and no agent may repair the
  // file because it is a runtime-owned run sidecar. Split from
  // `codex-child-model-ledger-closed` rather than folded into it so the deny
  // budget and the decision record can tell "this run is over" from "this run's
  // ledger is unreadable", which are different operator actions.
  'codex-child-model-ledger-illegible',
  'codex-child-model-role-held',
  'codex-child-model-claim-persist-failed',
  'codex-child-model-capability-record-failed',

  // ── modules/agent-model/spawn-shape.ts ───────────────────────────────────
  'cursor-agent-type-required',
  'opencode-named-agent-required',
  'kilo-general-agent-required',

  // ── modules/agent-model/spawn-hygiene.ts ─────────────────────────────────
  'absolute-traffic-one-path',

  // ── modules/agent-model/subagent-bind.ts ────────────────────────────────
  'subagent-bind-cursor-policy-missing',
  'subagent-bind-cursor-role-missing',
  'subagent-bind-model-choice-pending',

  // ── modules/agent-model/gate-opencode-first.ts ──────────────────────────
  'opencode-plan-batch-required',
  'verify-batch-running',
  'opencode-role-delegate',

  // ── modules/agent-model/gate-reuse.ts ────────────────────────────────────
  'agent-reuse-await-codex-meta',
  'agent-reuse-await-cursor-id',
  'agent-reuse-continue',
  // Two SPLITS off `agent-reuse-continue`, not a rename of it. All three refuse
  // the same duplicate spawn, but the question the orchestrator is left holding
  // is different in each, and `denyId` is the only thing a budget or the
  // decision log can read it off — the rendered text is resolved from SKILL.md
  // and interpolates the file list, so it is never a key.
  //   - `-continue`: nothing about the contract changed. Continue the agent.
  //   - `-scope-regrant`: the spawn's `[t1-bounded-scope]` marker WAS applied to
  //     the live agent's WorkUnitContract before the deny. The scope change the
  //     orchestrator wanted already happened, so re-sending the marker is a
  //     no-op and `[t1-replace-agent]` would destroy a live agent for nothing.
  //   - `-scope-regrant-refused`: the same marker was NOT applied — the
  //     republish was refused and consumed rather than dropped. Its remedy is
  //     the opposite of the one above (retry once, then work within the OLD
  //     scope), and merging the two would tell an orchestrator whose widening
  //     silently failed that it had succeeded.
  // Both are ESCALATABLE (absent from NEVER_ESCALATED_DENY_IDS, the default),
  // and each one's prose is written to survive that. `-scope-regrant` renders
  // only when the envelope hash actually MOVED, so three byte-identical draws
  // mean an orchestrator re-sending a marker its own text told it not to
  // re-send. `-scope-regrant-refused` prescribes exactly ONE retry and then
  // "report BLOCKED", which is what escalation says at three.
  'agent-reuse-scope-regrant',
  'agent-reuse-scope-regrant-refused',
  'verifier-independence-gate',

  // ── modules/agent-model/gate-enforcement.ts ──────────────────────────────
  'agent-materialization-deny',
  'agent-materialization-missing',
  'performance-main-agent',
  'team-confirmation',
  'architect-phase-incomplete',
  // The claim mint could not be RECORDED — a contended claims/ledger lock or a
  // refused state write, after a retry (see state/run-agent/mutation-result.ts's
  // split rule). Deliberately NOT shared with codex-child-model.ts's
  // `codex-child-model-claim-persist-failed`, which is the same underlying
  // failure at a different point with a different remedy: that one refuses a
  // child's first TOOL CALL after its model was verified, this one refuses the
  // SPAWN before a child exists, so its remedy is "retry the spawn" rather than
  // "replace the child from the parent". Distinct causes for a budget too — a
  // parent looping on spawns must not spend the child gate's bucket.
  'spawn-claim-unavailable',

  // ── modules/agent-model/model-denies.ts ──────────────────────────────────
  'performance-model-param',
  'cursor-exact-model-required',
  'model-unavailable-choice',

  // ── modules/agent-model/model-rotation.ts ────────────────────────────────
  'model-rotation-policy-missing',
  'cursor-api-limit-composer-choice',
  // Shared with cursor-failures.ts: both paths reach the same "Cursor API
  // limit hit at a terminal, no further rotation possible" cause.
  'cursor-api-limit-terminal',
  'model-rotation-tier-missing-from-catalog',
  'model-rotation-tier-exhausted',
  'model-rotation-exhausted-model',
  'model-choice-enable-required',

  // ── modules/agent-model/cursor-failures.ts ───────────────────────────────
  'cursor-failure-policy-missing',
  'cursor-failure-enable-retry-mismatch',
  'cursor-failure-composer-floor-choice-pending',
  'cursor-failure-model-unavailable-choice-pending',
  'cursor-failure-no-model-available',
  'cursor-failure-retry-model-mismatch',

  // ── modules/agent-model/handler.ts ───────────────────────────────────────
  'spawn-role-conflict',
  'spawn-background-forbidden',
  'spawn-child-cannot-mint-run',
  'spawn-run-id-unparseable',
  'spawn-model-policy-corrupt',
  'spawn-model-policy-host-mismatch',
  'spawn-child-cannot-create-policy',
  'cursor-models-capture',
  'spawn-model-policy-unavailable',
  'spawn-run-id-mismatch',
  'spawn-host-capability-missing',
  'spawn-role-no-compiled-assignment',
  'spawn-bounded-scope-missing',
  'spawn-bootstrap-publish-failed',

  // ── modules/model-choice-gate/index.ts ───────────────────────────────────
  'model-choice-stop-first',
  'model-choice-stop-repeat',

  // ── modules/plan-guard/handler.ts ────────────────────────────────────────
  'library-allowlist-forbidden',

  // ── modules/plan-guard/deploy-gate.ts ────────────────────────────────────
  // No `deploy-gate-security-check-failed`: it existed only as the `??` arm of
  // `securityCheck.denyId ?? …` while every failing branch of
  // checkSecurityDeployStamp already declared one of the three below — dead,
  // but typed, so it would have shown up in any enumeration of real causes.
  // The StampCheck failure shape now REQUIRES reason + denyId, which removes
  // the arm instead of leaving an id that can never be recorded.
  'deploy-gate-shipper-approval-required',
  'deploy-gate-security-check-stale',
  'deploy-gate-fingerprint-error',
  'deploy-gate-fingerprint-mismatch',

  // ── modules/plan-guard/supabase-local-gate.ts ────────────────────────────
  'supabase-local-stack-gate',

  // ── modules/plan-guard/scaffold-gate.ts ──────────────────────────────────
  'scaffold-stack-gate',
  'scaffold-main-agent-plan-gate',
  'scaffold-plan-gate',

  // ── modules/plan-guard/plan-write/index.ts (direct, not via block()) ─────
  'plan-write-struct-scan-incomplete',
  'plan-write-model-choice-pending',
  // Fallback denyId for the plan-write violation aggregator (see
  // makeViolationBlock in plan-write/index.ts) — used only if a future
  // violation source produces a block name outside this registry. Real
  // violation names below are mined 1:1 from the existing block() call sites
  // in plan-static.ts / plan-readiness/index.ts / plan-runteam.ts /
  // plan-runid.ts, so this should never actually fire.
  'plan-write-violation-unattributed',

  // ── modules/plan-guard/plan-write/plan-static.ts (via block()) ───────────
  'asset-extension-mismatch',
  'pages-service-files',
  'expo-route-service-files',
  'component-placement',
  'cross-feature-import',
  'deep-relative-package',
  'default-export',
  'native-inline-style',
  'native-dom-tags',
  'web-inline-style',
  'vanilla-extract-import',
  'css-ts-import',
  'no-any',
  'websocket-location',

  // ── modules/plan-guard/plan-write/plan-readiness/index.ts (via block()) ──
  'runtime-assignments-owner-gate',
  'runtime-sidecar-owner-gate',
  'run-artifact-work-unit-gate',
  'architect-planning-allowlist-gate',
  'architecture-input-owner-gate',
  'architecture-input-gate',
  'architecture-input-shell-unverified',
  'monorepo-package-json',
  'monorepo-root-vite',
  'monorepo-root-flat-scaffold',
  'frontend-structure-hot-gate',
  'architect-memory-baseline-gate',
  'architect-opencode-queue-gate',
  'architect-opencode-self-delegation-gate',
  'bootstrap-publication-gate',
  'capability-no-implementer-gate',
  'verification-contract-scan-gate',
  'contract-self-conflict',
  'architect-opencode-queue-policy-gate',
  'architecture-contract-gate',
  'plan-opencode-queue-gate',
  'plan-opencode-self-delegation-gate',
  'plan-opencode-queue-policy-gate',
  'state-gate',
  'materialization-gate',
  'plan-main-agent-gate',
  'plan-architect-self-gate',
  'plan-gate',

  // ── modules/plan-guard/plan-readiness/completion.ts (via block()) ────────
  // Digest-completion gates: extracted verbatim from planReadinessViolations
  // (see completion.ts's header) but still reached only through the same
  // planWriteGate aggregator — one id per named STRUCT_*/gate finding.
  'frontend-structure-scan-incomplete',
  'frontend-collapse-gate',
  'frontend-emit-config-gate',
  'frontend-eslint-survival-gate',
  'frontend-structure-completion-gate',
  'implementer-collapse-gate',
  'implementer-format-coverage-gate',
  'implementer-format-parity-gate',
  'implementer-format-toolchain-gate',
  'implementer-typecheck-invocation-gate',
  'implementer-typecheck-toolchain-gate',
  'implementer-lint-toolchain-gate',
  'implementer-lint-invocation-gate',
  'implementer-crawl-origin-gate',
  'implementer-test-toolchain-gate',
  'implementer-contract-delivery-gate',
  'lighthouse-claim-reconciliation-gate',
  'implementer-verification-skipped-gate',
  'verification-contract-refresh-gate',
  'finding-allowlist-gap',
  'reviewer-structure-gate',
  'verification-contract-refresh-gate-approved',
  'tester-planned-module-gate',
  'tester-qa-v2-gate',
  'tester-stale-qa-gate',
  'tester-qa-build-identity-missing',
  'tester-qa-build-identity-mismatch',
  'verification-contract-refresh-gate-tests-green',

  // ── modules/plan-guard/plan-write/plan-runteam.ts (via block()) ──────────
  // NOT listed: `run-team-suffix` — a decorative fragment glued onto a
  // DIFFERENT violation's text (see plan-runteam.ts), never itself a firing
  // cause, and plan-write/index.ts's block() wrapper explicitly skips it
  // rather than ever recording it as a denyId.
  'opencode-reserved-files',
  'run-team-shell',
  'run-team-quick-fix-contract',
  'run-team-runtime-contract-invalid',
  'run-team-maintenance-contract',
  'run-team-not-subagent',
  'run-team-scope-conflict',
  'run-team-runtime-allowlist-gap',
  'run-team-fallback-taken',
  'run-team-wrong-role',

  // ── modules/plan-guard/plan-write/plan-runid.ts (via block()) ────────────
  'run-id-mismatch',

  // ── modules/plan-guard/plan-write/index.ts (via block(), file-scoped) ────
  'opencode-external-temp-shell',
  'registry-probe-gate',
  'state-mode-downgrade',

  // ── modules/onboarding-gate/handler.ts ───────────────────────────────────
  'team-mode-marker-guard',
  'team-mode-downgrade-guard',
  'claude-wait-background-denied',
  'browser-open-denied',
  'tech-classify-required',
  'cursor-wait-link-first',
  'claude-wait-link-first',
  'codex-wait-link-first',
  'onboarding-use-plugin-question',
  // Narrowed to what the name says: the wizard server is not up YET and the
  // host's hook sandbox cannot start it, so the deny carries the approved
  // bootstrap + waiter commands. It used to cover the LAUNCHER-FAILED branch of
  // the same call site as well, which is the merge this file's naming rule
  // forbids: one site, three genuinely different reasons (a permission the user
  // can grant, a broken install, and a clock), rendering three different
  // remedies under one id. The other two are split out below.
  'onboarding-server-not-ready',
  // The launcher ran out of time. Split from the packaging failure because it
  // is the one cause in that branch that is routinely TRANSIENT — ensure.ts
  // documents two hooks racing to launch as normal — so its remedy is one
  // bounded retry, not "reinstall the plugin". A decision log that could not
  // tell the two apart sent operators to reinstall over ordinary contention.
  //
  // ESCALATABLE (absent from NEVER_ESCALATED_DENY_IDS, the default) and that is
  // deliberate for a deny whose own text prescribes a retry. The prescribed
  // retry cannot reach the escalation threshold: launch-timeout.ts hands out at
  // most ONE retry per (project, host) per ten minutes, so the second attempt
  // renders `-exhausted` below instead — different text, different id, a
  // different deny-repeat signature. Reaching three IDENTICAL retryable denies
  // therefore means twenty-plus minutes of repeated launch timeouts, or a bound
  // that failed to persist; in both cases "report BLOCKED" is the correct
  // instruction, and this is the backstop for the bound rather than a collision
  // with it.
  'onboarding-server-start-timeout',
  // The same timeout after that retry was spent. Its REMEDY text overlaps
  // `onboarding-server-start-failed` (stop, run doctor, report), but the
  // DIAGNOSIS is the opposite one — nothing here says the installation is
  // broken — and merging them would put "we timed out twice" and "the runner is
  // missing" in one bucket, which is precisely the distinction this work item
  // exists to preserve.
  'onboarding-server-start-timeout-exhausted',
  // The genuine packaging/runtime failure: a missing runner, an unusable state
  // root, a child that cannot run. Terminal, and correctly so — approval and
  // retries repair none of it. Previously indistinguishable from both ids above
  // under `onboarding-server-not-ready`.
  'onboarding-server-start-failed',
  'onboarding-setup-required-opencode',
  'windsurf-server-deny-reason',
  'windsurf-server-deny-reason-repeat',
  'onboarding-server-deny-links-shown',
  'onboarding-server-deny-first',
  'onboarding-server-deny-repeat',
  'onboarding-cursor-models-required',
  'onboarding-model-policy-host-mismatch',
  'onboarding-run-bootstrap-unavailable',
  'onboarding-model-policy-freeze-failed',
  'repaired-materialization',

  // ── modules/onboarding-gate/stop.ts ──────────────────────────────────────
  'onboarding-stop-links-shown',
  'onboarding-stop-link-posted',
  'onboarding-stop-required',
] as const;

export type DenyId = (typeof DENY_IDS)[number];

export const DENY_ID_SET: ReadonlySet<DenyId> = new Set(DENY_IDS);

export function isDenyId(value: unknown): value is DenyId {
  return typeof value === 'string' && DENY_ID_SET.has(value as DenyId);
}

// ── The never-overridable set ────────────────────────────────────────────────
// The refusals no mechanism may lift, at any count, for any operator. ONE
// list, consumed by every RELAXATION primitive rather than restated by each:
// today the operator override (shared/override/**, which reads it in
// core/pipeline.ts before honouring a token), tomorrow the deny budget's
// allow-at-N exclusion list. Two lists would diverge on the first entry added
// to one of them, and the direction they diverge in is a hole.
//
// "Every relaxation primitive" is the whole scope of that claim, and it used to
// read as though it covered any exclusion list a later feature might want. It
// does not: escalation (deny-repeat.ts) changes no verdict, so it is not a
// relaxation, and its exclusion list is a different set with a different rule —
// NEVER_ESCALATED_DENY_IDS below.
//
// The bar for membership is not "important". It is: LIFTING THIS PARTICULAR
// REFUSAL PRODUCES AN OUTCOME NOBODY CAN LATER TELL APART FROM A LEGITIMATE
// ONE. A write outside the workspace looks like a write inside it; a child
// whose model was never verified looks like one that was; a reviewer that
// reviewed itself looks like an independent reviewer. Every entry below fails
// that test, so it stays enforced and the honest answer to an operator who
// needs it lifted is "fix the cause, or settle the run".
//
// A gate NOT listed here is overridable. That is the deliberate default: the
// ~110 remaining ids are ordinary process/sequencing refusals whose worst case
// is a lower-quality run, and that run is already marked ineligible for
// `verified`/`shipped` the moment a token is minted for it
// (run-settlement/io.ts).
export const NEVER_OVERRIDABLE_DENY_IDS = [
  // The fail-closed crash deny. It fires precisely when the runtime could not
  // decide, so "lift it" means "run the tool call with NO gate evaluated" —
  // the one state this whole boundary exists to make unreachable. There is
  // also nothing to override: no gate formed an opinion to disagree with.
  'pipeline-handler-crashed',

  // Not a refusal at all — a live human approve/reject prompt (core/result.ts).
  // A token that suppressed it would answer a question on the user's behalf,
  // which is the exact inversion of an operator escape hatch.
  'user-approval-request',

  // Writes outside the opened workspace. Nothing downstream can distinguish a
  // file this gate would have refused from one it allowed, and the blast
  // radius is the whole filesystem.
  'workspace-boundary-guard',
  'workspace-boundary-unresolved-expansion',

  // The plugin's own source tree / a machine-config root. Same argument, plus:
  // an override that admits a write HERE can rewrite the override primitive.
  'authoring-guard',

  // The apply_patch envelope did not parse into per-file operations. Shared by
  // workspace-boundary-guard, authoring-guard and plan-write, so it is reached
  // from INSIDE two never-overridable guards: lifting it hands them a payload
  // whose targets they were unable to enumerate, which is indistinguishable
  // from lifting the guards themselves. `apply-patch-reconstruction-failed` is
  // deliberately NOT here — that one means the envelope parsed and its context
  // drifted from disk, a plan-write-only condition with a real remedy.
  'apply-patch-payload-invalid',

  // The public One MCP tool boundary. Opt-in by contract; an override would
  // make an un-consented project's data reachable.
  'one-mcp-tool-gate',

  // Shipping. A deploy whose security stamp is stale/mismatched, or which no
  // shipper approved, is the one action in this product with consequences
  // outside the user's machine.
  'deploy-gate-shipper-approval-required',
  'deploy-gate-security-check-stale',
  'deploy-gate-fingerprint-error',
  'deploy-gate-fingerprint-mismatch',

  // Child/agent identity. The whole codex-child-model family, not a hand-picked
  // subset: every branch of that gate exists to answer "is this thread the role
  // and model the frozen policy says it is", and a subset chosen by reading
  // branch names is a judgement I would have to get right fourteen times, where
  // one miss is a forged identity that every later artefact inherits. The
  // documented remedy for all of them is "the parent replaces the child", which
  // needs no override.
  //
  // That "whole family" rule is what decides the newest member rather than a
  // re-argument: `codex-child-model-observation-persist-failed` is TRANSIENT,
  // and a transient refusal reads like the safest thing in the family to let an
  // operator wave through. It is not. Lifting it admits a child whose observed
  // model was never recorded against the frozen policy — precisely this list's
  // own bar ("a child whose model was never verified looks like one that was"),
  // and the store being merely busy changes nothing about what the override
  // would produce. Its remedy is a retry that costs one message, so there is
  // also nothing here an override buys.
  'codex-child-model-policy-missing',
  'codex-child-model-role-unbound',
  'codex-child-model-bootstrap-mismatch',
  'codex-child-model-identity-conflict',
  'codex-child-model-run-missing',
  'codex-child-model-no-child-id',
  'codex-child-model-role-not-observable',
  'codex-child-model-observation-persist-failed',
  'codex-child-model-status-conflict',
  'codex-child-model-status-unverified',
  'codex-child-model-ledger-closed',
  'codex-child-model-ledger-illegible',
  'codex-child-model-role-held',
  'codex-child-model-claim-persist-failed',
  'codex-child-model-capability-record-failed',

  // The other half of the same binding, on the hosts that do it at spawn time.
  'subagent-bind-cursor-policy-missing',
  'subagent-bind-cursor-role-missing',
  'subagent-bind-model-choice-pending',

  // Verifier independence: the agent that wrote the code may not also be the
  // agent that approves it. Overriding this manufactures a green verdict that
  // reads exactly like an earned one.
  'verifier-independence-gate',

  // plan-runteam OWNERSHIP: who may write which file. Not the run-team contract
  // /shape denies (`run-team-shell`, `run-team-quick-fix-contract`,
  // `run-team-runtime-contract-invalid`, `run-team-maintenance-contract`),
  // which are malformed-input refusals with an in-session fix.
  'run-team-not-subagent',
  'run-team-wrong-role',
  'run-team-scope-conflict',
  'run-team-runtime-allowlist-gap',
  'run-team-fallback-taken',

  // Deliberately NOT here: `agent-reuse-scope-regrant` and
  // `-scope-regrant-refused`, checked against the bar rather than inherited from
  // their sibling. Lifting either admits a SECOND live agent for the role, which
  // is the same worst case as lifting `agent-reuse-continue` — a duplicated,
  // more expensive round — and it is not indistinguishable from a legitimate
  // outcome: both agents are recorded in the run's agent registry, so the
  // duplication is legible afterwards. Neither carries the AUTHORITY either. The
  // widened contract is published by `ensureRunBootstrap`, which hash-verifies
  // its own write and refuses a widening the maintenance-debt guard forbids; an
  // override changes nothing about what the child may write, only whether a
  // duplicate child starts. The compile-time family obligation below covers
  // `codex-child-model-*` only, so these two are unlisted by choice, not by
  // omission.
  //
  // Deliberately NOT here: `onboarding-server-start-timeout`,
  // `-start-timeout-exhausted` and `-start-failed`. All three mean "the local
  // setup wizard could not be started", which is an INFRASTRUCTURE fact about
  // this machine, not a judgement about the agent's work — and the user whose
  // launcher is broken is exactly the user who may legitimately need to keep
  // working while they repair it. Their sibling `onboarding-server-not-ready`
  // was already overridable for that reason; splitting the id must not silently
  // change the escape hatch. An override here admits UNONBOARDED work, which is
  // recoverable (onboarding converges later); a permanently stuck user is not.
] as const satisfies readonly DenyId[];

export const NEVER_OVERRIDABLE_DENY_ID_SET: ReadonlySet<string> = new Set(NEVER_OVERRIDABLE_DENY_IDS);

// "The whole codex-child-model family, not a hand-picked subset" was stated
// above and enforced by nothing: `satisfies readonly DenyId[]` checks that every
// listed id is declared, never that every family member is listed, and the
// override test iterates this list — so an id missing from it is an id that
// test never looks at. A fifteenth `codex-child-model-*` cause could therefore
// ship OVERRIDABLE (the default for an unlisted id) with the whole suite green,
// which is a forged child identity behind a token, in the one place the file
// says it refuses to make that judgement per-branch. Stated as a type instead,
// so the compiler makes it: any member of the family missing below leaves a
// residue in the Exclude and `tsc` rejects the assignment to `never`.
type CodexChildDenyId = Extract<DenyId, `codex-child-model-${string}`>;
type UnlistedCodexChildDenyId = Exclude<CodexChildDenyId, (typeof NEVER_OVERRIDABLE_DENY_IDS)[number]>;
type _CodexChildFamilyIsNeverOverridable = UnlistedCodexChildDenyId extends never ? true : UnlistedCodexChildDenyId;
const _codexChildFamilyIsNeverOverridable: _CodexChildFamilyIsNeverOverridable = true;
void _codexChildFamilyIsNeverOverridable;

// ── The never-escalated set ──────────────────────────────────────────────────
// The refusals that are allowed to repeat forever without being told they are
// looping (shared/state/deny-repeat.ts). A SECOND list, next to the
// never-overridable one above so both set-properties of an id are read and
// audited in one place — but deliberately not the same list, because the two
// answer different questions and disagree in both directions:
//
//   never-overridable  "a human may not lift this"
//   never-escalated    "re-issuing this is legitimate, so do not nag"
//
// `pipeline-handler-crashed` is the clearest disagreement: nothing may lift it,
// and a gate that crashed three times will crash the fourth, so it is exactly
// the loop worth naming. `onboarding-use-plugin-question` is the other
// direction: an operator could lift it, and an agent re-issuing it is doing the
// right thing. The two lists overlap only where a refusal happens to be both
// (see the disjointness test), and merging them would have silenced escalation
// on every identity/boundary gate in the product.
//
// The bar for membership is: THE AGENT RE-ISSUING THIS IS NOT A LOOP THE AGENT
// CAN BREAK. Two shapes qualify, and nothing else does:
//
//   1. The refusal is waiting on an answer only a human or an out-of-process
//      event can give — a setup link the user must open, a `fallback`/`enable`
//      reply, a team approval, a host transcript that has not flushed yet.
//      Escalation's honest exit is "report BLOCKED", and telling a run that is
//      correctly WAITING to report BLOCKED aborts it. That is precisely the
//      false positive deny-repeat.ts's header calls worse than never firing.
//   2. The gate already counts its own repeats and issues its own escalating
//      instruction (the `firstEmitThisSession` first/repeat pairs below). A
//      second, generic "STOP RETRYING" would contradict prose that already
//      told the agent what to do on a repeat.
//
// "Important", "expensive" and "fires often" are NOT reasons to be here. A
// refusal an agent could satisfy by ACTING belongs to the counter no matter how
// severe it is, and severity is what makes the escalation worth reading.
//
// An id NOT listed here escalates from the third byte-identical attempt. That
// is the deliberate default: the remaining ~110 ids are refusals with an
// in-session remedy the deny text already names, which is the whole 17cl
// failure (seven identical refusals, 25 minutes, the fix in the text).
export const NEVER_ESCALATED_DENY_IDS = [
  // Not a refusal — a live approve/reject modal. `askUser: true` on the result
  // is the same signal for a consumer holding a HookResult (core/result.ts sets
  // both together), and deny-repeat.ts checks that too, so a future askUser
  // carrying a different id is covered without editing this list.
  'user-approval-request',

  // ── Waiting on the user: onboarding ──────────────────────────────────────
  // Every one of these is the deny that CARRIES the setup link, the question,
  // or the wait command. The agent's only correct move is to show it and retry,
  // so the repeat IS the mechanism. `onboarding-server-deny-first`/`-repeat`,
  // `windsurf-server-deny-reason`/`-repeat` and the two `*-links-shown` ids are
  // additionally shape 2: onboarding-gate/handler.ts splits them on its own
  // `firstEmitThisSession` marker.
  'onboarding-use-plugin-question',
  'onboarding-server-not-ready',
  'onboarding-setup-required-opencode',
  'onboarding-server-deny-links-shown',
  'onboarding-server-deny-first',
  'onboarding-server-deny-repeat',
  'windsurf-server-deny-reason',
  'windsurf-server-deny-reason-repeat',
  'cursor-wait-link-first',
  'claude-wait-link-first',
  'codex-wait-link-first',
  'onboarding-stop-links-shown',
  'onboarding-stop-link-posted',
  'onboarding-stop-required',
  // `onboarding-server-not-ready` above is the sandbox-permission branch ONLY
  // (see its entry in DENY_IDS). Its two former co-tenants stay OUT, and the
  // contrast is the same rule working:
  //   - `onboarding-server-start-failed` names a broken installation and says
  //     "stop and report this error". An agent that draws it three times
  //     identically is looping against an explicit instruction, which is
  //     exactly when escalation's "report BLOCKED" is the honest next step —
  //     and while these three shared one id, that population was silenced.
  //   - `onboarding-server-start-timeout` DOES prescribe a retry, which is the
  //     shape this list exists for, and it still stays out: the retry is
  //     bounded at ONE per (project, host) per ten minutes by
  //     launch-timeout.ts, so the prescribed recovery renders
  //     `-exhausted` on its second draw and can never reach three identical
  //     ones. Listing it would remove the only backstop for a bound that
  //     failed to persist — and unlike `spawn-claim-unavailable`, whose prose
  //     legislates its own repeat count, this deny's answer on a repeat is
  //     already "stop", which escalation reinforces rather than contradicts.
  //   - `onboarding-server-start-timeout-exhausted` says "stop retrying:
  //     another attempt will produce this same message". Same argument.
  //
  // NOT listed, and the contrast is the rule working: `tech-classify-required`
  // ("setup is pending on the AGENT, not the user" — its own comment) and
  // `onboarding-cursor-models-required` (the gate admits the agent's own
  // capture command) are agent-actionable, so an agent stuck on either is
  // looping and gets told. Nor are `browser-open-denied` /
  // `claude-wait-background-denied`: both name an action the agent takes
  // instead (don't open the link, run the waiter in the foreground).

  // ── Waiting on the user: the model choice ────────────────────────────────
  // All of these end in "reply `fallback` or `enable`" or "enable it in host
  // settings". The build is PAUSED on a human by design; the agent re-asking is
  // how the pause is held. `model-choice-stop-first`/`-repeat` are shape 2 as
  // well (model-choice-gate/index.ts's own firstEmitThisSession).
  'model-choice-stop-first',
  'model-choice-stop-repeat',
  'plan-write-model-choice-pending',
  'subagent-bind-model-choice-pending',
  'model-unavailable-choice',
  'model-choice-enable-required',
  'cursor-api-limit-composer-choice',
  'cursor-failure-composer-floor-choice-pending',
  'cursor-failure-model-unavailable-choice-pending',
  // NOT listed: `cursor-failure-enable-retry-mismatch`. It fires only when the
  // agent re-sent the WRONG model, so there is an action of its own to take.

  // ── Waiting on the user: team approval ──────────────────────────────────
  'team-confirmation',

  // ── Waiting on an out-of-process event ──────────────────────────────────
  // "Retry after the rollout is flushed" / retry until the host surfaces a
  // continuation id. Retrying is the PRESCRIBED action, on a condition no
  // action of the agent's can advance, and both gates say so in their prose.
  'agent-reuse-await-codex-meta',
  'agent-reuse-await-cursor-id',

  // ── Waiting on a lock another PROCESS holds, and gates that count for
  //    themselves ──────────────────────────────────────────────────────────
  // Found by auditing every escalatable id's own prose against the rule above
  // rather than by reasoning about which ones felt important; these two were the
  // only hits in 167. Both are shape 2, and the first is also shape 1.
  //
  // `spawn-claim-unavailable` tells the agent, verbatim: "Retry the SAME spawn,
  // unchanged, in your next message… A concurrent hook holding the run's claims
  // or ledger lock clears in about two seconds. If the same deny repeats more
  // than twice… run doctor --run <id>… Do NOT change the role, the model, or the
  // task to work around it." Generic escalation would fire at exactly the count
  // that prose already legislates and offer a contradictory menu: its option (a)
  // is "apply the remedy above literally", and here the remedy IS re-issuing
  // unchanged, which the escalation's own opening line calls futile; its option
  // (c) would report BLOCKED on a lock due to clear in two seconds.
  //
  // `codex-child-model-claim-persist-failed` is "a claim-lock or filesystem
  // failure, not a closed run. Retry this tool once; if it repeats, replace the
  // child from the parent." Its remedy on a repeat is a specific parent-side
  // action, not the digest verdict this escalation prescribes.
  //
  // Their siblings deliberately stay OUT, and the contrast is the rule working:
  // `codex-child-model-role-held` says "retrying this tool cannot succeed" and
  // names an action, and `spawn-role-conflict` says "do NOT retry it unchanged"
  // — an agent that draws either three times identically is looping against
  // explicit instructions, which is precisely when it should be told.
  //
  // `codex-child-model-observation-persist-failed` is the closest call of all
  // and also stays out. Its prose IS the claim-persist entry's, word for word
  // ("Retry this tool once; if it repeats, replace the child from the parent"),
  // so the twin above reads as an invitation. Declining it is a deliberate
  // behaviour choice, not an oversight: the two are the same shape, listing it
  // would be defensible, and nothing today needs it — the retry is bounded at
  // one against a threshold of three, so an agent only reaches escalation by
  // ignoring the instruction twice, which is when being told is right. Adding
  // it later is a one-line decision that now costs nothing else; before the
  // split it would have silenced the durable "the run's policy is gone" answer
  // in the same breath, which is the trap the split exists to remove.
  //
  // `run-team-not-subagent` stays out too, and that one is worth writing down
  // because it looks like it belongs. It renders three remedies from one id —
  // bounded retry (a contended claims/ledger/observation lock),
  // neither-retry-nor-respawn (a closed run ledger), and stop-or-replace (a
  // genuinely absent role claim) — and the first reads exactly like the two
  // entries below. Listing it would still be wrong, because the SAME id also
  // covers the parent writing feature source directly, whose remedy is "spawn
  // the owning role": the most agent-actionable refusal in the product, and the
  // loop escalation exists to break. It would silence that population to spare
  // one escalation cannot reach anyway. Splitting the id first would not change
  // the answer either — the remedies are not three branches but orthogonal axes
  // (who is writing × whether the ledger is closed) that compose freely with a
  // fourth, the identity-drift diagnosis appended to any of them, so there is no
  // seam that isolates a transient half to list here.
  'spawn-claim-unavailable',
  'codex-child-model-claim-persist-failed',
] as const satisfies readonly DenyId[];

export const NEVER_ESCALATED_DENY_ID_SET: ReadonlySet<string> = new Set(NEVER_ESCALATED_DENY_IDS);

/**
 * Would telling an agent "you have now been refused this three times" be a
 * useful instruction rather than a lie?
 *
 * Fails CLOSED on anything it does not recognize — the pipeline's synthetic
 * `unattributed-handler:<gateId>` and any id from another build — for the same
 * reason isOverridableDenyId does, read the same way round: an unreviewed id
 * gets neither relaxation nor escalation. A gate with no declared id has not
 * been classified against the rule above, so it cannot be asserted to have an
 * in-session remedy, and the honest default for a refusal nobody has read is to
 * keep reading exactly as it does today. A new gate becomes escalatable the
 * moment it declares an id, which tests/deny-id-completeness.test.ts already
 * requires of every real call site.
 */
export function isEscalatableDenyId(value: unknown): boolean {
  return isDenyId(value) && !NEVER_ESCALATED_DENY_ID_SET.has(value);
}

/**
 * May a relaxation primitive lift a deny carrying this id?
 *
 * Fails CLOSED on anything it does not recognize, which covers the two shapes
 * that are not declared ids: the pipeline's synthetic
 * `unattributed-handler:<gateId>` (a gate that has not declared an id yet —
 * unreviewed, so not yet eligible) and any string from a future/other build.
 * A relaxation primitive that guessed "overridable" for an unknown id would
 * treat every id added after this build as pre-approved.
 */
export function isOverridableDenyId(value: unknown): boolean {
  return isDenyId(value) && !NEVER_OVERRIDABLE_DENY_ID_SET.has(value);
}
