// src/modules/plan-guard/plan-readiness/contracts.ts
// Run contracts: architecture-input validation, role scopes, the full
// structure scan, verification refresh, and architect-phase completeness.

import * as fs from 'fs';
import * as path from 'path';
import { readRegularFile } from '../../../shared/bounded-read';
import {
  buildRuntimeAssignments,
  isRuntimeMaintainedContextPath,
  publishRuntimeAssignments,
  readCompiledArchitecture,
  readRuntimeAssignments,
  validateArchitectureInput,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import {
  BUILD_ARTIFACT_RE,
  FEATURE_SOURCE_RE,
  isTestInfraConfigPath,
  isTestScopePath,
} from '../../../shared/feature-source';
import { obj } from '../../../shared/obj';
import {
  canPublishRunPolicyBootstraps,
  ensureRunPolicyBootstraps,
  readRunModelPolicy,
} from '../../../shared/run-model-policy';
import { matchesScope, type AssignedScope } from '../../../shared/scope';
import {
  activeAgentRole,
  hasRunAgentState,
  isNewProjectMode,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
} from '../../../shared/state';
import {
  browserRequired,
  buildVerificationContract,
  changedPathsFromBaseline,
  publishVerificationContract,
  readVerificationContract,
  skipNameDisclosure,
  type LighthouseThresholdsV1,
  type UiImpact,
} from '../../../shared/verification-contract';
import { readVerificationPlanIntent } from '../../../shared/verification-plan-intent';
import {
  analyzeProjectStructure,
  writeStructureReport,
} from '../react-structure';
// Leaf classifier, not the plan-write dispatcher: `plan-write/targets` imports
// only `shared/**`, so plan-readiness may use it without an import cycle.
import { isCompiledFeatureTarget } from '../plan-write/targets';
import { digestHasVerdictLine, exactDigestVerdict } from '../../../shared/digest-verdict';

import {
  QA_REPORT_ARTIFACT_RE,
  RUN_DIGEST_ARTIFACT_RE,
  RUN_RUNTIME_SIDECAR_RE,
  type Rec,
  boundedScanTruncated,
  exists,
  recordScanBoundHit,
  recordScanIncomplete,
} from './context';
import {
  T1_MEMORY_DIR,
  missingProjectMemoryBaseline,
} from './architect';
import { collapsedProductSourceFile } from './checks';

export function architectureInputErrors(content: string): string[] {
  try {
    return validateArchitectureInput(JSON.parse(content)).errors;
  } catch {
    return ['architecture input must be valid JSON'];
  }
}

export function assignmentScopesForRole(
  projectRoot: string,
  runId: string,
  role: string,
): AssignedScope[] {
  const runtime = readRuntimeAssignments(projectRoot, runId);
  if (runtime) {
    return runtime.assignments
      .filter((assignment) => assignment.role === role)
      .map((assignment) => assignment.scope);
  }
  // Once a compiled v2 sidecar exists, missing/corrupt runtime assignments are
  // a hard absence. Never borrow a sibling/legacy manifest to widen the scan.
  if (readCompiledArchitecture(projectRoot, runId)) return [];
  const manifest = readRunAssignmentsResilient(projectRoot, runId);
  if (!manifest) return [];
  return manifest.assignments
    .filter((assignment) => assignment.role === role)
    .map((assignment) => assignment.scope);
}

// A repo-relative path reference inside a finding: at least one directory
// segment and a file extension, anchored on a token boundary so `https://host/
// a.txt` and other absolute URLs never match. A trailing `:line` is left
// outside the capture, which is exactly the reviewer's `file:line` shape.
const FINDING_PATH_RE = /(?:^|[\s`'"(\[<])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g;
// A finding that is explicitly PARKED is not an order: the role is told the
// item is not its to carry out, which is a satisfiable instruction. Anything
// else reads as "do this", and a role cannot do what the write gate denies.
const FINDING_PARKED_RE = /\b(?:DEFERRED|DEFER|REPLAN|BLOCKED|OUT[ -]OF[ -]SCOPE|NOT ACTIONABLE)\b/i;

/**
 * Paths a finding names that NO role in this run may write.
 *
 * On a compiled run the write gate hard-denies two namespaces — feature source
 * and assigned build artifacts — whenever the target sits outside every
 * runtime-owned WorkUnitContract (`run-team-runtime-allowlist-gap`), and the
 * only remedy it offers is a replan, which a fix cycle cannot perform. So a
 * finding naming such a path is an order no role can carry out: the implementer
 * is denied, the reviewer never reaches `APPROVED`, and the run deadlocks on a
 * file nobody owns (observed 12co — finding 5 ordered
 * `apps/web/public/llms.txt`, which was in no allowlist; that specific path now
 * has a compiled home, this stops the next one).
 *
 * Deliberately narrow. Anything the write gate would let through — root docs,
 * `.traffic-one/**`, build output, a path any role owns — is not reported, and
 * an abbreviated reference to a compiled output ("src/pages/Home.tsx" for
 * "apps/web/src/pages/Home.tsx") counts as owned rather than as a defect.
 */
export function unsatisfiableFindingPaths(
  projectRoot: string,
  runId: string,
  content: string,
): string[] {
  if (!runId || !content) return [];
  const architecture = readCompiledArchitecture(projectRoot, runId);
  const assignments = readRuntimeAssignments(projectRoot, runId);
  if (!architecture || !assignments) return [];
  const scopes = assignments.assignments.map((assignment) => assignment.scope);
  const includes = scopes.flatMap((scope) => scope.include);
  const ordered = new Set<string>();
  const parked = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const bucket = FINDING_PARKED_RE.test(line) ? parked : ordered;
    for (const match of line.matchAll(FINDING_PATH_RE)) {
      bucket.add(match[1]!.replace(/^\.\/+/, ''));
    }
  }
  const unsatisfiable = new Set<string>();
  for (const target of ordered) {
    if (parked.has(target)) continue;
    if (!FEATURE_SOURCE_RE.test(target)
      && !BUILD_ARTIFACT_RE.test(target)
      && !isCompiledFeatureTarget(architecture, target)) continue;
    if (scopes.some((scope) => matchesScope(target, scope))) continue;
    if (includes.some((include) => include.endsWith(`/${target}`))) continue;
    unsatisfiable.add(target);
  }
  return [...unsatisfiable].sort();
}

export function roleContract(
  contract: CompiledArchitectureV1,
  role: string,
): CompiledArchitectureV1 {
  const modules = contract.modules.filter((module) => module.ownerRole === role);
  const moduleOutputs = new Set(modules.map((module) => module.output));
  const entrypoints = role === 'senior-frontend' ? contract.entrypoints : [];
  return {
    ...contract,
    entrypoints,
    modules,
    routes: contract.routes.filter((route) => route.redirect || moduleOutputs.has(route.moduleOutput)),
    allowedOutputs: [...new Set([...entrypoints, ...modules.map((module) => module.output)])],
  };
}

export function runFullStructureScan(
  projectRoot: string,
  runId: string,
  contract: CompiledArchitectureV1,
  role?: string,
  greenfield = false,
  notScaffolded = false,
): ReturnType<typeof analyzeProjectStructure> {
  const scopedContract = role ? roleContract(contract, role) : contract;
  const scopes = role ? assignmentScopesForRole(projectRoot, runId, role) : [];
  // Multiple same-role work units are allowed. Their union is represented as a
  // pattern list here; exact per-unit coverage was already checked at PLAN_READY.
  const allowlist = scopes.flatMap((scope) => scope.include);
  const report = analyzeProjectStructure(projectRoot, scopedContract, {
    allowlist: role && allowlist.length > 0 ? allowlist : undefined,
    // Integration findings block only where Traffic One owns the structure;
    // on a project it did not scaffold they stay advisory
    // (StructureScanOptions.notScaffolded lists the exact ids that survive).
    greenfield,
    notScaffolded,
  });
  writeStructureReport(projectRoot, runId, report);
  // Part of this project's source went unread. That raises the verification
  // contract's `uiImpact` floor — which is the whole licence for
  // STRUCT_SCAN_INCOMPLETE and STRUCT_SCAN_SKIPPED being warnings rather than
  // the deny they used to be, so the record and the demotion travel together.
  //
  // TWO causes, one consequence, because the consequence is a fact about
  // coverage and neither cause is worse than the other from here. The file CAP
  // withdraws the tail of the walk; a SKIPPED entry withdraws the subtree behind
  // it, and a directory symlink is one `ln -s` away — measured, a collapsed
  // source file planted behind one produced `status: warnings` with the defect
  // absent from the report. `unresolvable` is deliberately not here: it keeps
  // its error, and a floor over a report about nothing would be evidence owed
  // for a scan that read no tree at all.
  const boundCause = report.truncationKind === 'bound'
    ? `structure scan bound: ${report.findings.find((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE')?.message || 'source scan exceeded its file bound'}`
    : report.skippedEntries > 0
      ? `structure scan skipped ${report.skippedEntries} entr${report.skippedEntries === 1 ? 'y' : 'ies'} inside a compiled source root: ${report.findings.find((finding) => finding.id === 'STRUCT_SCAN_SKIPPED')?.message || 'an entry inside a source root could not be read'}`
      : '';
  if (boundCause) recordScanBoundHit(projectRoot, runId, boundCause);
  return report;
}

function verificationImpactRank(value: UiImpact): number {
  return {
    none: 0,
    nonvisual: 1,
    behavioral: 2,
    visual: 3,
    'native-ui': 4,
  }[value];
}

function thresholdsWeakened(
  before: LighthouseThresholdsV1 | undefined,
  after: LighthouseThresholdsV1 | undefined,
): boolean {
  if (!before) return false;
  for (const [key, previous] of Object.entries(before)) {
    const next = after?.[key as keyof LighthouseThresholdsV1];
    if (typeof next !== 'number') return true;
    if (key.endsWith('Min') ? next < previous : next > previous) return true;
  }
  return false;
}

// True when the digest CLAIMS the given verdict token.
//
// When any `verdict:` line exists, this mirrors settlement's exactDigestVerdict
// (shared/digest-verdict.ts): every verdict line counts, a trailing other
// machine token fails closed, and conflicting lines fail closed. True iff the
// agreed token equals `token`.
//
// When no verdict line exists, a bare body word-match remains ONLY as the
// fallback for completion-gate claims (fail-closed: prose claiming IMPLEMENTED
// without the contract line still triggers those gates). The compile trigger
// (PLAN_READY write that starts runtime compilation) passes
// `{ allowBareWord: false }` so a mention in architect prose cannot compile.
// Matching the whole body blocked honest failure reports: observed 5co-codex, a
// `verdict: BLOCKED …` digest was denied by the IMPLEMENTED completion gates
// because its blocker section said "…before this role can emit `IMPLEMENTED`"
// — the agent got through only by rewording, so gates were selecting for
// phrasing, not truth.
export function digestClaimsVerdict(
  content: string,
  token: string,
  options?: { allowBareWord?: boolean },
): boolean {
  if (digestHasVerdictLine(content)) {
    return exactDigestVerdict(content) === token;
  }
  if (options?.allowBareWord === false) return false;
  return new RegExp(`\\b${token}\\b`).test(content);
}

export function allImplementationRolesDelivered(
  projectRoot: string,
  runId: string,
  proposedDigestPath: string,
): boolean {
  const assignments = readRuntimeAssignments(projectRoot, runId);
  if (!assignments) return false;
  const roles = assignments.assignments
    .map((assignment) => assignment.role)
    .filter((role) => role === 'senior-frontend' || role === 'senior-backend');
  return roles.every((role) => {
    const suffix = role.replace(/^senior-/, '');
    const rel = `.traffic-one/digests/${runId}/${suffix}.md`;
    if (rel === proposedDigestPath) return true;
    try {
      // BOUNDED, like every other digest read on this hook path: a digest is a
      // project-controlled path, and a non-regular object there answers `null`
      // (no verdict claimed) instead of blocking the gate forever.
      const digest = readRegularFile(path.join(projectRoot, rel));
      return digest === null ? false : digestClaimsVerdict(digest, 'IMPLEMENTED');
    } catch {
      return false;
    }
  });
}

export function refreshVerificationAfterImplementation(
  projectRoot: string,
  runId: string,
  state: Rec,
): { error: string | null; changed: boolean } {
  const architecture = readCompiledArchitecture(projectRoot, runId);
  if (!architecture) return { error: 'CompiledArchitectureV1 is missing or invalid', changed: false };
  try {
    const previous = readVerificationContract(projectRoot, runId);
    if (!previous) {
      return { error: 'the current VerificationContractV2 is missing or invalid', changed: false };
    }
    const currentDiff = changedPathsFromBaseline(projectRoot, architecture);
    // The skip-authority name disclosure is excluded, and the prose below is why
    // rather than a convenience. Every sentence of it is FALSE for that class:
    // the diff is not truncated (the walk finished and named what it skipped),
    // the run CAN be certified (`currentVerificationSourceHash` qualifies it and
    // the QA report carries the qualification), and none of the three repairs it
    // orders applies to a `dist/assets/app-<hash>.js` the run's own build step
    // just wrote. Delivering it would send an implementer to resolve a worktree
    // that is fine, on a run that is already settling.
    //
    // Nothing is lost by staying quiet here. The fact is re-derived live at every
    // consumption point and recorded durably in the artifact that claims the
    // evidence, which is more than this ledger entry offered: `recordScanIncomplete`
    // banks a WARNING for the fix-cycle document, and this class needs no fix
    // cycle. `skipNameDisclosure` keeps the exclusion fail-closed — every other
    // incompleteness reason still records, and still means what this text says.
    if (!currentDiff.complete && !skipNameDisclosure(currentDiff.reason)) {
      // Recorded, not refused. The sweep below is a SECOND net over ownership,
      // not the first: the run-team write gate enforces `matchesScope` on every
      // write as it happens, with the same matcher and the same manifest, so a
      // truncated diff here narrows a redundant check rather than opening the
      // authority. Truncation can only hide a path from the sweep, never invent
      // one, so every unauthorized path it DOES see still refuses below.
      recordScanIncomplete(projectRoot, runId,
        `STRUCT_SCAN_INCOMPLETE: ${currentDiff.reason || 'baseline diff is incomplete'}. This run CANNOT be certified while the baseline diff is truncated: the QA report is rejected as \`scan-incomplete\` at settlement, whatever evidence it carries. Remove the cause named above — resolve the git worktree, drop the symlink, or narrow the generated/output roots the walk is counting — and re-emit so the diff recompiles complete.`);
    }
    const authorizedPaths = new Set(previous.changedPaths);
    // The write surface and the verification authority are the SAME set:
    // whatever the runtime assignment already authorizes a role to write is a
    // legitimately-changed path here, never a frozen-authority breach. Three
    // shapes land through this (all observed 13cl/14cl):
    //   - sibling files under a folder-shaped module directory: a feature
    //     assignment includes the module DIRECTORY, so the compiled scope
    //     covers children the exact planned-output list never named (14cl
    //     wrote 26 legitimate sibling files; the old exact-set deny pushed the
    //     role to delete its split and ship a monolith);
    //   - tester-owned test files/config: test-scope paths are tester-owned
    //     regardless of the surrounding directory — the run-team gate's own
    //     ownership rule — so a new test file is authorized whenever this run
    //     compiled a tester assignment (13cl: `tests/i18n-parity.test.ts`);
    //   - runtime-maintained root context (AGENTS.md/CLAUDE.md), which
    //     materialization re-appends every session.
    // `matchesScope` over the hash-valid runtime assignments is the exact
    // matcher and manifest the run-team write gate enforces with — no second
    // matcher. A missing/invalid manifest contributes no scopes, so the check
    // stays fail-closed on the frozen exact set. This widens only what
    // verification RECOGNIZES; no role may claim anything new, and a genuinely
    // unowned path (the 12co `llms.txt` class) still denies below.
    const runtimeAssignments = readRuntimeAssignments(projectRoot, runId);
    const assignmentScopes = runtimeAssignments
      ? runtimeAssignments.assignments.map((assignment) => assignment.scope)
      : [];
    const testerAssigned = Boolean(runtimeAssignments
      ?.assignments.some((assignment) => assignment.role === 'senior-tester'));
    const unauthorized = currentDiff.paths.filter((entry) => (
      !authorizedPaths.has(entry)
      && !assignmentScopes.some((scope) => matchesScope(entry, scope))
      && !(testerAssigned && (isTestScopePath(entry) || isTestInfraConfigPath(entry)))
      && !isRuntimeMaintainedContextPath(entry)
    ));
    if (unauthorized.length > 0) {
      return {
        error: `changed paths outside the frozen verification/WorkUnit authority: ${unauthorized.slice(0, 20).join(', ')}`,
        changed: false,
      };
    }
    // RE-DERIVE the collapse bound here rather than trusting the record to have
    // survived. `recordScanBoundHit`'s own prose says the fact is "re-derived
    // rather than remembered: the next runFullStructureScan over the same source
    // roots records it again", and that was true of the STRUCTURE walk and false
    // of the collapse walk — `runFullStructureScan` never performs one, because
    // `repairCollapsedSource` runs only on an implementer digest.
    //
    // The window that opened in the gap is real and composable: two implementer
    // roles, frontend first. The frontend digest trips the collapse cap and
    // records the bound, but the refresh below requires
    // `allImplementationRolesDelivered`, which the backend has not satisfied, so
    // no pinned contract is published yet. Delete the record in that window and
    // the backend digest refreshes against a predecessor that was never pinned,
    // publishes `nonvisual`, and no later scan re-derives the collapse cap. The
    // floor is gone for the run. The same composition also lifted a genuine
    // dual-cause pin, because `truncationPinLifted` below reads this same flag.
    //
    // One bounded whole-project walk closes it, at the one site that can: the
    // refresh is where the floor is decided, so deriving it here makes the
    // durability of `scan-bound.json` an optimization rather than the guarantee.
    // Measured on a warm cache, 15 runs: 12.9 ms p50 at 50 source files, 100.6 ms
    // at 200, 243.5 ms at the 600-file cap and 243.1 ms past it — bounded by
    // COLLAPSE_MAX_FILES, so the ceiling is the cap and not the project size.
    // Paid once per implementer digest that reaches this refresh.
    // Deliberately unscoped — the refresh is judging the RUN, not one role's
    // assignment, and a per-role scope is what let the cap read differently on
    // the two digests in the first place.
    //
    // This does not weaken round 5's achievement, which was to make the pin
    // depend on a hash-verified predecessor carrying `uiImpactPinned: true`
    // rather than on a forgeable local fact. That dependency is untouched: this
    // can only RAISE the flag, never clear it, so a deleted or corrupt
    // predecessor still fails closed exactly as before.
    const rederived = collapsedProductSourceFile(projectRoot, state);
    if (rederived.incomplete || rederived.withdrawn.length > 0) {
      recordScanBoundHit(projectRoot, runId, rederived.incomplete
        ? `collapse scan bound: ${rederived.scanned} product source files`
        : `collapse scan did not read ${rederived.withdrawn.length} entries: ${rederived.withdrawn[0]}`);
    }
    const scanBoundStillRecorded = boundedScanTruncated(projectRoot, runId)
      || rederived.incomplete
      || rederived.withdrawn.length > 0;
    const verification = buildVerificationContract(
      projectRoot,
      runId,
      state,
      architecture,
      {
        ...readVerificationPlanIntent(projectRoot),
        boundedScanTruncated: scanBoundStillRecorded,
      },
    );
    if (!verification.scanComplete) {
      recordScanIncomplete(projectRoot, runId,
        `STRUCT_SCAN_INCOMPLETE: ${verification.scanReason || 'baseline diff is incomplete'}. This run CANNOT be certified while the baseline diff is truncated: the QA report is rejected as \`scan-incomplete\` at settlement, whatever evidence it carries. Remove the cause named above — resolve the git worktree, drop the symlink, or narrow the generated/output roots the walk is counting — and re-emit so the diff recompiles complete.`);
    }
    // The one direction the ratchet must NOT refuse, and it exists only because
    // the truncation floor exists. A contract published from an incomplete diff
    // carries `truncatedScanUiImpactFloor` — the domain maximum, asserted from
    // ignorance rather than earned from evidence — so when the refresh finally
    // reads a COMPLETE diff, the honest answer is usually lower, and an
    // unconditional ratchet would read the correction as a weakening and
    // dead-end the run on a requirement nothing ever observed.
    //
    // Manufacturing the predecessor is CHEAP and the exemption is written on
    // that assumption. A scan is incomplete when the diff exceeds
    // VERIFICATION_SCAN_MAX_FILES, when a symlink or unreadable directory sits
    // in the walk, or when the Git worktree context will not resolve — an agent
    // can arrange the first two in one command (`ln -s`, or a build that emits
    // a cache the skip predicate does not name). What that buys is the
    // OPPOSITE of leverage: the truncated predecessor is pinned to the domain
    // maximum, so the attacker's own first contract is the most demanding one
    // available, and the exempted refresh republishes at
    // `max(complete-scan evidence, plannedUiImpactFloor)` — bit for bit the
    // contract an honest complete-diff run would have published at that moment,
    // over a compiled architecture whose hash is frozen so the planned floor
    // cannot have moved either. There is no number the truncation lets a run
    // choose; there is only a floor asserted from ignorance being withdrawn.
    //
    // Two bounds keep that argument true rather than merely plausible.
    //
    // FIRST, the exemption covers only what the truncation floor can inflate.
    // The floor moves `uiImpact`, and `browserRequired`/`requiredScreenshotWidths`
    // are computed from it. It does NOT reach the performance budget:
    // `performance.required` is `webUi && (explicit || redesign ||
    // performanceRisk)` — plan intent, never impact — and both threshold sets
    // come from the same intent. Exempting those would have let a run drop a
    // declared page-speed budget by way of a truncation that had nothing to do
    // with it, so they ratchet unconditionally, truncated predecessor or not.
    //
    // SECOND, the previous number must actually BE the pin, and the exemption
    // may withdraw only as far as the pin reached.
    //
    // Both halves used to be one comparison — `previous.uiImpact ===
    // truncatedScanUiImpactFloor(profile)` — and it settled neither. It is a
    // test of the VALUE, and for a web profile the floor's value and the
    // commonest earned value are the same string `visual`, so it could not tell
    // a pin from evidence: measured, a truncated-first-scan run shed the 768px
    // tablet width — real evidence, read off a stylesheet path the partial scan
    // did see — where the identical honest pair was refused. And having decided
    // the predecessor was pinned it forgave the ENTIRE disjunction below,
    // including whatever the agent's own edits had weakened in between.
    //
    // The contract now publishes the provenance itself (`uiImpactPinned`) and
    // what the same evidence read without the floor (`unpinnedUiImpact`), so
    // the exemption lowers the bar to that unpinned contract and to nothing
    // below it. `browserRequired` and the widths are recomputed from it by the
    // same rules that produced them, rather than being waived wholesale: the
    // widths keep the predecessor's OWN `tabletRisk`, because tablet evidence
    // is read off changed paths and the pin never invented any of it.
    // The pin lifts when its CAUSE clears, and `verification.scanComplete` is
    // the cause of only ONE of the two pins there are. A contract is pinned when
    // the baseline diff is incomplete OR when a bounded scan hit its bound
    // (`scanTruncated` in buildVerificationContract), and the second cause is
    // recorded in a sidecar the diff knows nothing about — so keyed on the diff
    // alone, a sidecar-sourced pin lifted the moment the RECORD of the bound
    // stopped being readable, which is not the bound clearing. Measured end to
    // end with nothing else changed between two refreshes, no edit and no new
    // evidence: predecessor `visual`, pinned, browser required, widths 390/1440,
    // 10 required checks; successor `nonvisual`, no browser, no widths, 3 checks,
    // ratchet silent — because a lifted pin lowers the bar to
    // `unpinnedUiImpact`, and the unpinned reading of a diff that touches no UI
    // is `nonvisual`.
    //
    // So the pin's own PROVENANCE decides, read off the predecessor rather than
    // off today's filesystem: `previous.scanComplete === false` says that
    // contract was published over an incomplete DIFF, and a complete diff now is
    // exactly the ignorance being dispelled that the argument below is about. A
    // pin published with `scanComplete: true` came from the bounded scan, whose
    // bound is a fact about how much source exists — nothing within the run
    // shrinks it, the runtime never clears the record, and no complete diff is
    // evidence about it. That pin does not lift, and deliberately does not
    // consult the sidecar to decide so: a decision that reads a deletable file
    // is a decision an agent can change by deleting it (the four shell channels
    // sidecar-shell.ts now closes were exactly that). The sidecar is still
    // required to be absent as well, so a bound recorded LATER cannot be
    // withdrawn by a diff that happens to complete in the same refresh.
    const truncationPinLifted = previous.uiImpactPinned === true
      && previous.scanComplete === false
      && verification.scanComplete
      && !scanBoundStillRecorded;
    const floorBaseImpact = truncationPinLifted
      ? previous.unpinnedUiImpact || previous.uiImpact
      : previous.uiImpact;
    const floorBaseWidths = truncationPinLifted
      ? (floorBaseImpact === 'visual' ? [390, ...(previous.tabletRisk ? [768] : []), 1440] : [])
      : previous.requiredScreenshotWidths;
    const impactWeakened = verificationImpactRank(verification.uiImpact) < verificationImpactRank(floorBaseImpact)
      || (browserRequired(floorBaseImpact) && !verification.browserRequired)
      || floorBaseWidths.some((width) => !verification.requiredScreenshotWidths.includes(width));
    const budgetWeakened = (previous.performance.required && !verification.performance.required)
      || thresholdsWeakened(
        previous.performance.explicitThresholds,
        verification.performance.explicitThresholds,
      )
      || thresholdsWeakened(
        previous.performance.advisoryThresholds,
        verification.performance.advisoryThresholds,
      );
    if (budgetWeakened || impactWeakened) {
      return {
        error: 'the refreshed plan/diff would weaken an already-published verification requirement',
        changed: false,
      };
    }
    if (verification.contractHash === previous.contractHash) {
      return { error: null, changed: false };
    }
    const assignments = buildRuntimeAssignments(architecture, verification.contractHash);
    const modelPolicy = readRunModelPolicy(projectRoot, runId);
    if (obj(state.team)?.mode === 'subagents' && !modelPolicy) {
      return { error: 'immutable model-policy.json is missing or invalid', changed: false };
    }
    if (modelPolicy && !canPublishRunPolicyBootstraps(
      projectRoot,
      modelPolicy,
      state,
      { architecture, verification, assignments },
    )) {
      return {
        error: 'refreshed role/rule/skill materials or WorkUnitContract preflight failed',
        changed: false,
      };
    }
    // A refused publish (fsjson.ts's consent/symlink/containment fence) used to
    // fall through to `changed: true`, so the IMPLEMENTED refresh reported a
    // raised contract that was never on disk — and architectPhaseIncompleteReasons
    // below then read verification-v2.json back and called the run incomplete,
    // with nothing connecting the two. Refuse the refresh instead.
    if (!publishVerificationContract(projectRoot, verification)) {
      return {
        error: 'the refreshed VerificationContractV2 could not be persisted',
        changed: false,
      };
    }
    publishRuntimeAssignments(projectRoot, architecture, verification.contractHash);
    if (modelPolicy && !ensureRunPolicyBootstraps(projectRoot, modelPolicy, state)) {
      return {
        error: 'refreshed bootstrap publication failed after a successful preflight',
        changed: true,
      };
    }
    return { error: null, changed: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      changed: false,
    };
  }
}

function missingArchitectureContract(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return ['.traffic-one/runs/<runId>/architecture-input-v1.json (currentRunId missing)'];
  const inputRel = `.traffic-one/runs/${runId}/architecture-input-v1.json`;
  if (!exists(projectRoot, inputRel)) return [inputRel];
  const compiledRel = `.traffic-one/runs/${runId}/architecture-v1.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readCompiledArchitecture(projectRoot, runId)) return [compiledRel];
  const verificationRel = `.traffic-one/runs/${runId}/verification-v2.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readVerificationContract(projectRoot, runId)) return [verificationRel];
  const assignmentsRel = `.traffic-one/runs/${runId}/assignments.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readRuntimeAssignments(projectRoot, runId)) {
    return [`${assignmentsRel} (runtime-owned hash-valid manifest required)`];
  }
  return [];
}

function missingAssignmentsManifest(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return ['.traffic-one/runs/<runId>/assignments.json (currentRunId missing)'];
  const relPath = `.traffic-one/runs/${runId}/assignments.json`;
  if (!readRuntimeAssignments(projectRoot, runId)) {
    return [`${relPath} (runtime-owned hash-valid manifest required)`];
  }
  return [];
}

function missingArchitectDigest(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  if (architectPlanReadyOnDisk(projectRoot, state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '<runId>';
  return [`.traffic-one/digests/${runId}/architect.md (must contain PLAN_READY)`];
}

export function architectPhaseIncompleteReasons(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  return [
    ...(isNewProjectMode(state) ? missingProjectMemoryBaseline(projectRoot, state) : []),
    ...missingArchitectureContract(projectRoot, state),
    ...missingAssignmentsManifest(projectRoot, state),
    ...missingArchitectDigest(projectRoot, state),
  ];
}

export function isArchitectPhaseComplete(projectRoot: string, state: Rec): boolean {
  return architectPhaseIncompleteReasons(projectRoot, state).length === 0;
}

function architectPlanReadyOnDisk(projectRoot: string, state: Rec): boolean {
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return false;
  try {
    // BOUNDED — see the IMPLEMENTED digest read above.
    const digest = readRegularFile(path.join(projectRoot, T1_MEMORY_DIR, 'digests', runId, 'architect.md'));
    return digest === null ? false : digestClaimsVerdict(digest, 'PLAN_READY');
  } catch {
    return false;
  }
}

export function assignmentWriterRole(projectRoot: string, state: Rec, rawData: unknown, host?: string): string | null {
  const ctx = rawData ? resolveRunAgentContext(projectRoot, state, rawData, { claimPending: true, host }) : null;
  const resolved = ctx && typeof ctx.role === 'string' ? ctx.role : null;
  if (resolved) return resolved;
  // Mirror plan-runteam.ts: `activeAgentRole` is a forgeable shared field.
  // Once run-agent state exists, the parent must not mint APPROVED /
  // TESTS_GREEN / PLAN_READY (or any other writer-owned artifact) by typing
  // it. Legacy runs without claims/assignments/registry still fall back.
  return hasRunAgentState(projectRoot, state) ? null : activeAgentRole(state);
}

const ARCHITECT_MEMORY_RE =
  /^\.traffic-one\/(?:plan|product|stack|coding|security|known-issues|deployment|environment-setup|agent-log|api|database)\.md$/;

// ADRs live in `.traffic-one/decisions/` under whatever name the record needs —
// `project-memory` prose hands the architect that directory (README + ADR files)
// and `senior-engineer-team` lists `decisions/*` among the memory it owns, while
// this gate used to accept exactly ONE filename nothing documented. Observed
// 1cu-cursor: `decisions/README.md` and `decisions/0001-<slug>.md` were denied
// three times and the architect gave up on recording the ADR at all — for a
// non-default stack, `missingPlanArtifacts` then REQUIRES a file the architect
// was never allowed to write.
//
// The run-exactness this replaces still holds where it matters: `decisions/` is
// APPEND-ONLY across runs (project-memory: "never rewrite prior decisions
// silently"), so an ADR that already exists may be overwritten only under this
// run's own prefix. Markdown, one level deep, no traversal.
const ARCHITECT_DECISION_RE = /^\.traffic-one\/decisions\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function architectMayWriteDecision(projectRoot: string, filePath: string, runId: string): boolean {
  if (!ARCHITECT_DECISION_RE.test(filePath) || filePath.includes('..')) return false;
  const name = filePath.slice('.traffic-one/decisions/'.length);
  if (name === 'README.md') return true;
  if (runId && (name === `${runId}-architecture.md` || name.startsWith(`${runId}-`))) return true;
  // A brand-new ADR is a new decision; an existing one belongs to whoever
  // recorded it. Unreadable project root → treat as existing (fail closed).
  try {
    return !fs.existsSync(path.join(projectRoot, filePath));
  } catch {
    return false;
  }
}

export function architectMayWrite(projectRoot: string, filePath: string, runId: string): boolean {
  if (ARCHITECT_MEMORY_RE.test(filePath)
    || filePath === '.traffic-one/.agentignore'
    || filePath === '.traffic-one/schema.sql') return true;
  if (architectMayWriteDecision(projectRoot, filePath, runId)) return true;
  if (!runId) return false;
  return filePath === `.traffic-one/runs/${runId}/architecture-input-v1.json`
    || filePath === `.traffic-one/digests/${runId}/architect.md`;
}

function requiresRunContracts(state: Rec): boolean {
  if (isNewProjectMode(state)) return true;
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  return Boolean(runId && obj(state.team)?.mode === 'subagents');
}

export function runtimeOwnedRunSidecar(filePath: string): boolean {
  const matched = RUN_RUNTIME_SIDECAR_RE.exec(filePath);
  return Boolean(matched && matched[2] !== 'architecture-input-v1.json');
}

export function artifactContract(filePath: string, currentRunId: string): {
  runId: string;
  role: string;
} | null {
  const digest = RUN_DIGEST_ARTIFACT_RE.exec(filePath);
  if (digest) {
    return {
      runId: digest[1] || '',
      role: `senior-${digest[2] || ''}`,
    };
  }
  const report = QA_REPORT_ARTIFACT_RE.exec(filePath);
  if (report) return { runId: report[1] || '', role: 'senior-tester' };
  if (filePath === '.traffic-one/deployments.jsonl' && currentRunId) {
    return { runId: currentRunId, role: 'senior-shipper' };
  }
  return null;
}

export function usesMainAgentTeam(state: Rec): boolean {
  return obj(state.team)?.mode === 'main-agent';
}
