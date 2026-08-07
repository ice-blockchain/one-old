// src/modules/plan-guard/plan-readiness/index.ts
// The plan-readiness orchestrator: planReadinessViolations walks every gate
// in order. Helpers live in the sibling modules; digest completion gates in
// completion.ts. Deny PROSE comes from skill/SKILL.md via skillBlock.

import * as fs from 'fs';
import * as path from 'path';
import {
  buildRuntimeAssignments,
  capabilityProfileForRun,
  compileArchitectureForRun,
  ensureScaffoldContent,
  persistCompiledArchitecture,
  publishRuntimeAssignments,
  readCompiledArchitecture,
  uiAstLintLayer,
  validateArchitectureInput,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import { profileHasWebUi } from '../../../shared/capabilities';
import { collapsedLineNumber } from '../../../shared/collapsed-source';
import { supersedeSkippedDelegationFallback } from '../../../shared/maintenance/fallback';
import { isKnownStack } from '../../../shared/config';
import { isPluginAuthoringRoot } from '../../../shared/authoring-root';
import { detectMode } from '../../../shared/detection';
import {  stateRequiresNewProjectMonorepo } from '../../../shared/hook/paths';
import { hasMaterializedProjectAssets } from '../../../shared/materialize';
import { canonicalHost } from '../../../shared/model-tiers';
import { hostFlags } from '../../../shared/host/capability-flags';
import { openCodeDelegationActive } from '../../../shared/performance';
import { OPENCODE_PLAN_MIN_UNITS } from '../../../shared/opencode-roles';
import {
  preserveOpenCodeDelegateBlockForWrite,
  restorePlanOpenCodeDelegateBlock,
} from '../../../shared/opencode-plan/preserve';
import { obj } from '../../../shared/obj';
import {
  activateRunV2RollbackBarrier,
  writeRunSettlement,
} from '../../../shared/run-settlement';
import {
  canPublishRunPolicyBootstraps,
  ensureRunPolicyBootstraps,
  readRunModelPolicy,
} from '../../../shared/run-model-policy';
import { readActiveRunBootstrap } from '../../../shared/run-bootstrap-policy';
import {  matchesScope } from '../../../shared/scope';
import {
  analyzeI18nSourceText,
  detectExistingI18nContract,
  I18N_CATALOG_RE,
  I18N_SOURCE_RE,
  projectDeclaresI18nRuntime,
  validateI18nCatalogs,
} from '../../../shared/i18n-enforcement';
import {
  isExistingProjectMode,
  isMaterialized,
  isNativeState,
  legacyStatePath,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
  runLedgerClaimAdmission,
  stackFingerprint,
  statePath,
} from '../../../shared/state';
import { appendQualityFindings } from '../../../shared/state/quality-findings';
import { seedI18nCatalogKeys } from '../../../shared/i18n-seed';
import {
  buildVerificationContract,
  publishVerificationContract,
} from '../../../shared/verification-contract';
import { readVerificationPlanIntent } from '../../../shared/verification-plan-intent';
import {
  analyzeStructureText,
  analyzeStructureTextAgainstContract,
  invalidateStructureCache,
} from '../react-structure';

import {
  ARCHITECTURE_INPUT_RE,
  ARCHITECT_DIGEST_RE,
  ASSIGNMENTS_FILE_RE,
  PLAN_FILE_RE,
  type Block,
  type Rec,
  exists,
} from './context';
import {
  noImplementerRoleFallback,
  noImplementerRoleSummary,
  structureFindingSummary,
} from './checks';
import {
  ADR_OR_DOC_RE,
  ROOT_MONOREPO_FLAT_RE,
  ROOT_VITE_RE,
  hasOpenCodeDelegateMarker,
  missingOpenCodeDelegateBlock,
  missingProjectMemoryBaseline,
  openCodeQueuePolicyErrors,
  opencodeQueueBlocks,
  packageJsonMatchesWorkspaceRoot,
  planOnDiskHasOpenCodeDelegateMarker,
  planOnDiskMissingOpenCodeBlock,
  planOnDiskOpenCodeQueuePolicyErrors,
} from './architect';
import {
  architectMayWrite,
  architectureInputErrors,
  artifactContract,
  assignmentScopesForRole,
  assignmentWriterRole,
  digestClaimsVerdict,
  roleContract,
  runtimeOwnedRunSidecar,
  usesMainAgentTeam,
} from './contracts';
import { digestCompletionGates } from './completion';
import {
  contractSelfConflictFallback,
  contractSelfConflictSummary,
  contractSelfConflicts,
} from './satisfiability';

interface ReadinessArgs {
  filePath: string;          // project-relative target path
  content: string;           // write content (Write.content / Edit.new_string)
  // The bytes THIS write authors (Write content, Edit new_string, patch added
  // lines) as opposed to `content`, which for Edit/apply_patch is the whole
  // reconstructed post-write file. The existing-mode collapse scoping keys on
  // it: pre-existing collapse in the reconstructed file must not deny an
  // unrelated maintenance edit. Absent → fall back to judging `content`.
  addedContent?: string;
  // False when the target was inferred from a shell command whose write payload
  // cannot be reconstructed (e.g. `node -e` naming the file). Content-shape
  // gates then judge the on-disk artifact instead of an empty pseudo-payload.
  contentVerified?: boolean;
  // Heredoc payload behind a shell-derived target. Unverified shell text: only
  // gates that explicitly opt in may read it, and it never becomes `content`.
  shellBody?: string;
  projectRoot: string;       // resolved project root for the target
  state: Rec;                // readEffectiveState(projectRoot)
  writingFeatureSource: boolean;
  host?: string;
  rawData?: unknown;
  block: Block;
}

// The only write-time structural/i18n finding ids that still DENY: compiled-
// contract violations no tool can auto-fix, scope gaps, catalog data
// validation (single-file classes only — cross-locale parity findings carry
// `crossLocaleParity` and accumulate instead; see the split below), and
// collapse (an unconditional deny: write it formatted, see below).
// Every other finding accumulates into the run-scoped quality ledger and is
// batched into one document at the completion digest.
const HOT_WRITE_BLOCKING_IDS = new Set<string>([
  'STRUCT_ROUTE_MODULE_MISMATCH',
  'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
  'STRUCT_I18N_CATALOG',
  'STRUCT_COLLAPSED_LINE',
]);

// Readiness violations for a single write/edit. Empty array == nothing to block.
export function planReadinessViolations(args: ReadinessArgs): string[] {
  const { filePath, content, projectRoot, state, writingFeatureSource, rawData, block, host } = args;
  const contentVerified = args.contentVerified !== false;
  const violations: string[] = [];
  const currentHost = canonicalHost(host);
  const currentRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  const writerRole = assignmentWriterRole(projectRoot, state, rawData, host);

  const requiresMonorepoScaffold = stateRequiresNewProjectMonorepo(state);
  const architectureInputTarget = ARCHITECTURE_INPUT_RE.exec(filePath);

  if (ASSIGNMENTS_FILE_RE.test(filePath)) {
    violations.push(block('runtime-assignments-owner-gate',
      'Runtime contract gate: `.traffic-one/runs/<runId>/assignments.json` is generated atomically from CompiledArchitectureV1 and VerificationContractV2. Agents and the parent may not create, edit, widen, or replace it; change ArchitectureInputV1 and re-run PLAN_READY compilation instead.'));
  }

  if (runtimeOwnedRunSidecar(filePath) && !ASSIGNMENTS_FILE_RE.test(filePath)) {
    violations.push(block('runtime-sidecar-owner-gate',
      `Runtime sidecar gate: \`${filePath}\` is generated and atomically published by Traffic One runtime. Agents, children, and the parent may read it but may not create, edit, delete, widen, replace, or repair it through Write/Edit/apply_patch/shell. Change the semantic ArchitectureInputV1 or invoke the owning runtime transition instead.`,
      { TARGET: filePath }));
  }

  const childArtifact = artifactContract(filePath, currentRunId);
  if (obj(state.team)?.mode === 'subagents' && childArtifact) {
    const bootstrap = writerRole === childArtifact.role
      ? readActiveRunBootstrap(projectRoot, childArtifact.runId, childArtifact.role)
      : null;
    const scope = bootstrap
      ? {
          include: bootstrap.workUnit.allowlist,
          exclude: bootstrap.workUnit.allowlistExclude,
        }
      : null;
    if (childArtifact.runId !== currentRunId
      || !bootstrap
      || !bootstrap.workUnit.outputs.includes(filePath)
      || !scope
      || !matchesScope(filePath, scope)) {
      // Name WHY the role is unresolved. `Active role is unresolved` alone sent
      // orchestrators into respawn loops chasing a spawn-ordering race, when the
      // real cause was a closed run ledger that no respawn could fix.
      //
      // Three-valued, because the boolean this used to ask cannot distinguish a
      // closed ledger from one it could not READ: `runLedgerAdmitsClaims` answers
      // `true` for both an active run and a truncated `run.json`, so an illegible
      // ledger produced NO note at all — the deny then said only "Active role is
      // `unresolved`", which is the bare wording this note exists to replace. The
      // `closed` arm is left exactly as it was, including its answer for an empty
      // `currentRunId` (`runLedgerClaimAdmission` reports `closed` for a blank id,
      // as the boolean did), so only the previously-silent case moves.
      const admission = runLedgerClaimAdmission(projectRoot, currentRunId);
      const unresolvedNote = writerRole
        ? ''
        : admission === 'closed'
          ? ` The run ledger for \`${currentRunId}\` is settled, so NO child can bind a role in it — respawning cannot fix this; the run must be replaced.`
          : admission === 'unknown'
            ? ` The run ledger for \`${currentRunId}\` (\`.traffic-one/runs/${currentRunId}/run.json\`) cannot be read or parsed, so NO child can bind a role in it and neither resuming nor settling the run will work — every one of those returns \`ledger-corrupt\`. Respawning cannot fix this and no agent may repair that file; ask the user to restore it from version control or delete it, then mint a fresh run.`
            : '';
      violations.push(block('run-artifact-work-unit-gate',
        `Run artifact gate: \`${filePath}\` may be written only by the parent-bound \`${childArtifact.role}\` child whose current, hash-valid WorkUnitContract names this exact output. Active role is \`${writerRole || 'unresolved'}\`; no digest, QA report, or deployment claim may self-authorize or borrow another run's bootstrap.${unresolvedNote}`,
        {
          TARGET: filePath,
          ROLE: writerRole || 'unresolved',
          EXPECTED_ROLE: childArtifact.role,
        }));
    }
  }

  if (writerRole === 'senior-architect'
    && filePath
    && !ASSIGNMENTS_FILE_RE.test(filePath)
    && !architectMayWrite(projectRoot, filePath, currentRunId)) {
    violations.push(block('architect-planning-allowlist-gate',
      `Architect scope gate: \`senior-architect\` may write only the semantic plan/project-memory files, NEW ADRs under \`.traffic-one/decisions/<name>.md\` (existing ones are append-only across runs — use the \`${currentRunId || '<runId>'}-\` prefix to rewrite your own), \`.traffic-one/runs/${currentRunId || '<runId>'}/architecture-input-v1.json\`, and its architect digest. \`${filePath}\` is runtime- or implementer-owned. Do not scaffold packages, workspace/config/source files, barrels, Tailwind assets, tests, or assignments; emit semantic ArchitectureInputV1 and let runtime compile the work units.`,
      { TARGET: filePath }));
  }

  if (architectureInputTarget) {
    if (writerRole && writerRole !== 'senior-architect') {
      violations.push(block('architecture-input-owner-gate',
        `Architecture input gate: only the parent-bound \`senior-architect\` planning role may write ArchitectureInputV1; active role is \`${writerRole}\`.`,
        { ROLE: writerRole }));
    }
    if (contentVerified) {
      const errors = architectureInputErrors(content);
      if (errors.length > 0) {
        violations.push(block('architecture-input-gate',
          `Architecture input gate: ArchitectureInputV1 may contain only semantic routes, modules (including component placement), exact UI primitive identifiers, i18n locale/exact-brand intent, and narrow exception requests. Runtime owns profiles, roots, roles, limits, output paths, and the baseline. Fix: ${errors.join('; ')}.`,
          { ERRORS: errors.join('; ') }));
      }
    } else {
      // Shell-inferred target: the payload is not reconstructable, so judge the
      // artifact already on disk. A valid on-disk file means this is almost
      // certainly a read/diagnostic (observed 3co: the architect running the
      // plugin's own validateArchitectureInput via `node -e` was denied with a
      // message blaming a file that was valid the whole time). Only a missing
      // or invalid on-disk artifact keeps the deny — and says what is actually
      // wrong instead of accusing the file when the COMMAND is the unknown.
      const diskErrors = ((): string[] => {
        try {
          return architectureInputErrors(
            fs.readFileSync(path.join(projectRoot, filePath), 'utf8'),
          );
        } catch {
          return ['architecture input file does not exist on disk yet'];
        }
      })();
      if (diskErrors.length > 0) {
        violations.push(block('architecture-input-shell-unverified',
          `Architecture input gate: this shell command references \`${filePath}\` but its write payload cannot be reconstructed for validation, and the current on-disk file is not valid ArchitectureInputV1 (${diskErrors.join('; ')}). Read-only checks pass once the on-disk file is valid; to (re)write it, use the role-scoped Write/Edit tools with the complete semantic JSON instead of shell eval.`,
          { TARGET: filePath, ERRORS: diskErrors.join('; ') }));
      }
    }
  }

  if (requiresMonorepoScaffold && filePath === 'package.json' && !packageJsonMatchesWorkspaceRoot(projectRoot, content)) {
    violations.push(block('monorepo-package-json',
      'New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: `private: true`, `packageManager: pnpm@...`, and a workspace declaration (`pnpm-workspace.yaml` or package.json `workspaces`) for `apps/*` and `packages/*`. Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.'));
  }

  if (requiresMonorepoScaffold && ROOT_VITE_RE.test(filePath)) {
    violations.push(block('monorepo-root-vite',
      'New-project monorepo gate: root Vite app files are not allowed for this stack. Use `apps/web/` for the React app and create the required `packages/*` workspaces first; see `rules/modes/new-project.md`.'));
  }

  if (requiresMonorepoScaffold && ROOT_MONOREPO_FLAT_RE.test(filePath)) {
    violations.push(block('monorepo-root-flat-scaffold',
      'New-project monorepo gate: root-level TypeScript config files (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, etc.) are not allowed for this stack. Complete the architect phase and scaffold the Turborepo workspace (`pnpm-workspace.yaml`, `apps/web/`, `packages/*`, `tsconfig.base.json`) instead of creating a flat root Vite layout.'));
  }

  // Hot structural path: analyze only the touched file against the immutable
  // compiled contract and current work-unit allowlist. Numeric limits remain
  // warnings; robust responsibility/route/assignment findings deny immediately.
  if (
    (writingFeatureSource || writerRole === 'senior-frontend')
    && (
      /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|php)$/i.test(filePath)
      || I18N_SOURCE_RE.test(filePath)
      || I18N_CATALOG_RE.test(filePath)
    )
  ) {
    const profile = capabilityProfileForRun(projectRoot, state);
    if (profileHasWebUi(profile) || profile.surfaces.includes('native-ui')) {
      invalidateStructureCache(path.join(projectRoot, filePath));
      const architecture = currentRunId
        ? readCompiledArchitecture(projectRoot, currentRunId)
        : null;
      const scopedArchitecture = architecture && writerRole
        ? roleContract(architecture, writerRole)
        : architecture;
      const scopes = architecture && writerRole
        ? assignmentScopesForRole(projectRoot, currentRunId, writerRole)
        : [];
      const allowlist = scopes.flatMap((scope) => scope.include);
      const structuralFindings = profileHasWebUi(profile)
        ? (scopedArchitecture
          ? analyzeStructureTextAgainstContract(
              filePath,
              content,
              scopedArchitecture,
              writerRole ? { allowlist } : {},
            )
          : analyzeStructureText(filePath, content, profile, []))
        : [];
      const enforceI18n = state.mode === 'new-project'
        || projectDeclaresI18nRuntime(projectRoot, architecture || undefined);
      const i18n = architecture?.i18n || (enforceI18n ? detectExistingI18nContract(projectRoot) : undefined);
      const sourceI18n = enforceI18n && I18N_SOURCE_RE.test(filePath)
        ? analyzeI18nSourceText(filePath, content, profile, i18n)
        : null;
      const sourceI18nFindings = sourceI18n?.findings || [];
      // Deterministic catalog seeding: a missing key that a `<Trans ns
      // i18nKey>fallback</Trans> in THIS change references is auto-fixed, not
      // denied — the fallback is the declared source copy, so runtime seeds it
      // into the source locale and a marked TODO into the other locales before
      // any validator can trip over it. Empty-value/extra-key parity findings
      // are untouched: they carry no in-change fallback to seed from.
      if (contentVerified && i18n && sourceI18n?.references.some((reference) => reference.fallback)) {
        seedI18nCatalogKeys(projectRoot, i18n, sourceI18n.references);
      }
      const changedCatalog = i18n?.catalogs.find((catalog) => catalog.path === filePath);
      const catalogI18nFindings = enforceI18n && changedCatalog
        ? validateI18nCatalogs(projectRoot, i18n!, {
            namespaces: changedCatalog.namespaces,
            requireAllCatalogs: false,
            contentOverrides: { [filePath]: content },
          })
        : [];
      // Write-time demotion, mirroring the completion-scan severity in
      // react-structure/contract.ts: where the compiled eslint config carries
      // a real AST i18n rule, the lexical copy findings advise instead of
      // deny — the project's own `lint` run owns the blocking verdict there.
      // Catalog/runtime findings are data validation and always block.
      const lexicalCopyDemoted = uiAstLintLayer(profile) !== null;
      const i18nFindings = [...sourceI18nFindings, ...catalogI18nFindings]
        .map((finding) => ({
          ...finding,
          severity: lexicalCopyDemoted
            && (finding.id === 'STRUCT_HARDCODED_COPY' || finding.id === 'STRUCT_I18N_REACT_TRANS')
            ? 'warning' as const
            : 'error' as const,
        }));
      const allFindings = [...structuralFindings, ...i18nFindings];
      // Write-time blocking set: intent-level violations only — compiled-
      // contract breaks (a route pointing away from its module), scope
      // (allowlist gaps), catalog DATA validation, and collapse the formatter
      // could not fix. Everything else — entrypoint conventions, copy/Trans
      // findings, advisory route notes — accumulates into the run-scoped
      // quality ledger and is delivered ONCE, batched, at the completion
      // digest (observed 13co: 16 per-write denies, each atomically rejecting
      // a whole multi-file patch, for findings that were all fixable in one
      // batched pass).
      // STRUCT_I18N_CATALOG splits by scope: parity is a property of the
      // namespace's locale PAIR, and a role cannot write two files atomically,
      // so every legitimate intermediate state costs a deny (observed 13cl: ~8
      // denies including a perfect oscillation on one key — "en has extra key"
      // → the counterpart write itself denied → "en is missing key"). The
      // cross-locale parity classes therefore accumulate into the quality
      // ledger as warnings; the single-file classes (unparseable JSON, empty
      // catalog, empty values) stay immediate denies, and the completion scan
      // keeps full-parity blocking exactly as before.
      const isCrossLocaleParity = (finding: { id: string; crossLocaleParity?: boolean }): boolean => (
        finding.crossLocaleParity === true
      );
      // Existing-codebase demotion: STRUCT_ROUTE_MODULE_MISMATCH enforces the
      // compiled routing architecture, and a repo Traffic One did not create
      // keeps its own routing conventions — a maintenance edit adding a route
      // the plan never mentioned must not be hard-denied. It accumulates into
      // the quality ledger as a warning instead. STRUCT_COLLAPSED_LINE demotes
      // too UNLESS the collapse is in the bytes this write authors: the
      // analyzer judges the reconstructed whole file, so a legacy wide line
      // would otherwise deny every unrelated edit to that file forever
      // (verified repro: a ~115-char pre-existing JSX row denied a one-token
      // Edit on a different line, identically on every retry). The other
      // blocking ids stay: allowlist gaps are ownership and catalog classes
      // are data validation.
      const existingCodebase = isExistingProjectMode(state);
      const writeAuthorsCollapse = existingCodebase
        && collapsedLineNumber(
          filePath,
          args.addedContent !== undefined ? args.addedContent : content,
        ) !== null;
      const demotedOnExisting = (finding: { id: string }): boolean => {
        if (!existingCodebase) return false;
        if (finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH') return true;
        return finding.id === 'STRUCT_COLLAPSED_LINE' && !writeAuthorsCollapse;
      };
      let blocking = allFindings.filter((finding) => (
        finding.severity === 'error'
        && HOT_WRITE_BLOCKING_IDS.has(finding.id)
        && !isCrossLocaleParity(finding)
        && !demotedOnExisting(finding)
      ));
      // `STRUCT_COLLAPSED_LINE` is NOT waved through when a formatter could fix
      // it. That branch (v1.0.44) computed the formatted text, used it only as a
      // predicate, and threw it away — so the ORIGINAL collapsed content still
      // landed on disk, and the deferred repair it pointed at is calibrated 3.5x
      // looser (completion scans raw >500 chars; this gate masks and thresholds
      // at 140/80), leaving that whole band collapsed forever. Observed 15co:
      // `pnpm format:check` stayed red for an entire run; 14co: 25 unformatted
      // source files at the tester.
      //
      // The argument that settles it is determinism, not the dropped string:
      // `resolveProjectPrettier` walks for `node_modules/.bin/prettier`, so the
      // SAME byte-identical write was denied before install and allowed after. A
      // gate whose verdict depends on install state is not a gate — every other
      // HOT_WRITE_BLOCKING_ID is a pure function of path + content. Substituting
      // the formatted text instead is not available either: `updatedToolInput` is
      // Claude-only and Codex cannot rewrite tool input, which would make this
      // host-conditional enforcement.
      //
      // This reverses part of v1.0.44's "auto-fix over deny" direction, and that
      // direction stays right for BATCHED quality findings (13co: 16 per-write
      // denies for one pass of fixes). It is wrong for collapse, where the deny
      // is one write, one file, and one directly actionable instruction.
      if (blocking.length > 0) {
        // Carry each finding's own message. Reporting only `ID (file:line)`
        // withheld the one fact that resolves the deny — which route/module is
        // wrong and what the compiled contract expects instead — so the writer
        // guessed: observed 2cu, three of four routes were correct and only the
        // catch-all failed, but the frontend read the generic prose as "routes
        // are forbidden here", reported BLOCKED twice, and burned a re-plan.
        const summary = structureFindingSummary(blocking);
        violations.push(block('frontend-structure-hot-gate',
          `Structural/i18n gate: ${summary}. Entrypoints may only bootstrap the app; route pages must be separate compiled modules. React child copy uses <Trans ns="…" i18nKey="…">fallback</Trans>; t() is reserved for string props, metadata, and imperative APIs.`,
          { FINDINGS: summary }));
      } else if (currentRunId) {
        // The write proceeds: bank the non-blocking findings (per role, deduped)
        // instead of interrupting. The completion digest consolidates them into
        // one fix-cycle document, and the completion structure scan still holds
        // the bar — batching changes the delivery, never the standard.
        const accumulated = allFindings
          .filter((finding) => !HOT_WRITE_BLOCKING_IDS.has(finding.id)
            || isCrossLocaleParity(finding)
            || demotedOnExisting(finding))
          .map((finding) => (isCrossLocaleParity(finding) || demotedOnExisting(finding)
            ? { ...finding, severity: 'warning' as const }
            : finding));
        appendQualityFindings(projectRoot, currentRunId, writerRole || 'main-agent', accumulated);
      }
    }
  }

  const architectDigest = ARCHITECT_DIGEST_RE.exec(filePath);
  if (architectDigest && digestClaimsVerdict(content, 'PLAN_READY')) {
    const runId = architectDigest[2] || '';
    const missingMemory = missingProjectMemoryBaseline(projectRoot, state);
    if (missingMemory.length > 0) {
      violations.push(block('architect-memory-baseline-gate',
        `Architect completion gate: do not write \`PLAN_READY\` until the required .traffic-one project-memory baseline exists with real content. Missing or incomplete: ${missingMemory.join(', ')}. Write the missing memory files yourself (do not delegate .traffic-one/* to OpenCode), then update \`.traffic-one/digests/<runId>/architect.md\` and only then emit \`PLAN_READY\`.`,
        { MISSING: missingMemory.join(', ') }));
    }
    // Runtime touchpoint for the preserved-queue auto-fix (see the plan gate
    // below): a plan rewrite was allowed to land without the block because a
    // previously-accepted queue survives — re-append it here, on disk, before
    // judging PLAN_READY. Deny only when nothing is recoverable.
    if (state.mode === 'new-project' && openCodeDelegationActive(state, host) && planOnDiskMissingOpenCodeBlock(projectRoot) && opencodeQueueBlocks(host)
      && !restorePlanOpenCodeDelegateBlock(projectRoot, runId)) {
      violations.push(block('architect-opencode-queue-gate',
        `Architect completion gate: OpenCode is enabled but \`.traffic-one/plan.md\` is missing at least ${OPENCODE_PLAN_MIN_UNITS} runnable machine-readable delegation units. Include \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` with 3–6 bounded units (\`- id: <stable-unit-id> | role: … | files: … | task: …\`) before emitting \`PLAN_READY\`. The orchestrator runs \`opencode_delegate_from_plan\` from that block BEFORE spawning implementers.`));
    }
    if (state.mode === 'new-project' && hostFlags(currentHost).opencodeSelfHosted && planOnDiskHasOpenCodeDelegateMarker(projectRoot)) {
      violations.push(block('architect-opencode-self-delegation-gate',
        'Architect completion gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block before emitting `PLAN_READY`; implementer work runs directly on the current host.'));
    }
    const modelPolicy = readRunModelPolicy(projectRoot, runId);
    const subagentMode = obj(state.team)?.mode === 'subagents';
    if (subagentMode && !modelPolicy) {
      violations.push(block('bootstrap-publication-gate',
        'Bootstrap gate: immutable parent model-policy.json is missing or corrupt. No architecture assignments or implementation bootstrap may be published until parent preflight creates it.',
        { ERROR: 'model policy missing' }));
    }
    // Zero-implementer stop, BEFORE compilation. A profile with neither
    // implementer cannot build anything, and the architecture compiler THROWS on
    // the first route/app-shell/page/component module for a no-UI profile — so
    // without this the honest cause surfaces as `architecture-contract-gate`
    // blaming the architect's semantic input for a defect that lives in
    // `.one.json`, and the architect re-plans forever against a contract it can
    // never satisfy. Denying here also keeps the 2cl invariant: the
    // `violations.length === 0` guard below means no capability snapshot,
    // baseline, verification contract, assignment set, or child envelope is
    // minted for a run that can never produce code.
    const noImplementer = noImplementerRoleSummary(projectRoot, state);
    if (noImplementer) {
      violations.push(block('capability-no-implementer-gate',
        noImplementerRoleFallback(noImplementer, runId || '<runId>'),
        { PROFILE: noImplementer, RUN_ID: runId || '<runId>' }));
    }
    const inputExists = Boolean(runId) && exists(projectRoot, `.traffic-one/runs/${runId}/architecture-input-v1.json`);
    if (violations.length === 0 && (state.mode === 'new-project' || inputExists)) {
      try {
        // Compile in memory only: nothing may reach disk until every
        // completion check has passed. A persisted architecture-v1.json next
        // to a DENIED digest invalidates the live architect's bootstrap
        // envelope and revokes its tools mid-flight (observed 2cl).
        const compiled = compileArchitectureForRun(projectRoot, runId, state, { persist: false });
        const verification = buildVerificationContract(
          projectRoot,
          runId,
          state,
          compiled,
          readVerificationPlanIntent(projectRoot),
        );
        if (!verification.scanComplete) {
          violations.push(block('verification-contract-scan-gate',
            `Verification contract gate: STRUCT_SCAN_INCOMPLETE (${verification.scanReason || 'unknown reason'}). Runtime could not derive the complete diff from the immutable baseline, so \`PLAN_READY\` is forbidden.`,
            { ERROR: verification.scanReason || 'scan incomplete' }));
        } else {
          const candidateAssignments = buildRuntimeAssignments(
            compiled,
            verification.contractHash,
          );
          // Satisfiability is a compiler invariant: every output the compiled
          // contract demands must be writable under the compiled contract's own
          // blocking write gates. A contract that fails this sweep would spawn
          // implementers into a guaranteed deadlock (12co/13co class: the
          // mandatory file is hard-denied and only a replan — which the fix
          // cycle cannot perform — could ever fix it). Deny PLAN_READY here,
          // naming both sides, while the architect can still change the input.
          const selfConflicts = contractSelfConflicts(compiled, candidateAssignments, {
            isNative: isNativeState(state),
            enforceI18n: state.mode === 'new-project'
              || projectDeclaresI18nRuntime(projectRoot, compiled),
            existingMode: isExistingProjectMode(state),
          });
          // Full queue checks: metadata (stable ids, depends edges, parseable
          // files, unit-kind heuristics) AND the file-vs-assignment scope
          // cross-check. The compiled allowlist is born in THIS call, so the
          // scope check runs against `candidateAssignments` and its deny
          // prints the REAL in-scope file lists — the architect never has to
          // guess compiled paths (the 2cl failure mode that once forced this
          // check to be deferred). Deferring it to Step-0 delegation silently
          // wasted the whole batch instead: observed 5cl-claude, 0/3 units
          // delegable because every unit invented conventional Next paths
          // (components/course-card.tsx, …) that the compiled scope never
          // contained, and the run lost the entire OpenCode economy with no
          // signal to the architect.
          const queuePolicyErrors = openCodeDelegationActive(state, host)
            && !planOnDiskMissingOpenCodeBlock(projectRoot)
            ? planOnDiskOpenCodeQueuePolicyErrors(projectRoot, {
              assignments: candidateAssignments.assignments,
            })
            : [];
          if (selfConflicts.length > 0) {
            const summary = contractSelfConflictSummary(selfConflicts);
            violations.push(block('contract-self-conflict',
              contractSelfConflictFallback(summary),
              { CONFLICTS: summary }));
          } else if (queuePolicyErrors.length > 0) {
            violations.push(block('architect-opencode-queue-policy-gate',
              `Architect completion gate: OpenCode queue metadata is unsafe: ${queuePolicyErrors.join('; ')}. Fix the queue block in \`.traffic-one/plan.md\` (stable unique ids, parseable \`files:\`, explicit \`depends:\` edges for overlaps) and re-emit \`PLAN_READY\`. Scope errors above list the owning role's real compiled in-scope files — retarget each unit's \`files:\` to those exact paths, or declare the module in ArchitectureInputV1 so runtime compiles the output you need.`,
              { ERRORS: queuePolicyErrors.join('; ') }));
          } else if (modelPolicy && !canPublishRunPolicyBootstraps(
            projectRoot,
            modelPolicy,
            state,
            {
              architecture: compiled,
              verification,
              assignments: candidateAssignments,
            },
          )) {
            violations.push(block('bootstrap-publication-gate',
              'Bootstrap gate: canonical role/rule/skill materials or a candidate WorkUnitContract could not be resolved before publication. No assignments or child envelope were published; repair the parent policy/materialization and retry PLAN_READY.',
              { ERROR: 'bootstrap preflight failed' }));
          } else {
            // This atomic legacy projection MUST precede verification-v2.json.
            // If the process dies on the next instruction, runtime 1.0.19 sees
            // blocked while the current runtime recovers canonical `active`.
            const rollbackBarrier = activateRunV2RollbackBarrier(projectRoot, runId);
            if (!rollbackBarrier) {
              violations.push(block('architecture-contract-gate',
                `Architecture contract gate: the runtime could not atomically activate the V2 rollback barrier for run \`${runId}\`. No V2 verification contract or implementation bootstrap was published.`,
                { ERROR: 'V2 rollback barrier activation failed' }));
            } else {
              // Accept path: persist the compiled architecture first — the
              // verification/assignments sidecars published below reference
              // its contractHash, and ensureRunPolicyBootstraps re-reads it
              // from disk at the end of this same call.
              persistCompiledArchitecture(projectRoot, compiled);
              // Seed canonical content for scaffold files whose body is runtime
              // knowledge (.prettierignore skip list, .env.example VITE_SITE_URL
              // contract) — only when missing/blank, never over agent content.
              // On greenfield runs the same call also materializes the compliant
              // module skeletons the satisfiability sweep above just certified,
              // with their catalog keys seeded into every declared locale —
              // implementers EDIT compliant code instead of authoring de novo.
              ensureScaffoldContent(projectRoot, compiled.scaffoldOutputs || [], compiled.profile, {
                compiled,
                newProject: state.mode === 'new-project',
              });
              // The publish is fenced (fsjson.ts: an unanswered consent
              // question, a planted symlink, a path that escapes the state
              // dir), and its refusal used to be dropped — so the accept path
              // went on to publish assignments, settle the run `active` and
              // hand implementers a bootstrap that all reference a contract
              // hash no file on disk carries. Every sidecar below depends on
              // this one landing, so a refusal ends the accept path here.
              const publishedVerification = publishVerificationContract(projectRoot, verification);
              if (!publishedVerification) {
                violations.push(block('architecture-contract-gate',
                  `Architecture contract gate: the V2 rollback barrier is active, but the runtime could not persist \`.traffic-one/runs/${runId}/verification-v2.json\`. No assignments, settlement or implementation bootstrap was published; the run remains fail-closed.`,
                  { ERROR: 'V2 verification contract publication was refused' }));
              } else {
                const assignments = publishRuntimeAssignments(
                  projectRoot,
                  compiled,
                  verification.contractHash,
                );
                // A SKIPPED delegation's pending-fallback pin is superseded by
                // the freshly compiled contracts — without this the bounded
                // 2-file hashes veto every envelope this same accept path is
                // about to publish (see supersedeSkippedDelegationFallback).
                supersedeSkippedDelegationFallback(projectRoot, runId, compiled.contractHash);
                const settlement = writeRunSettlement(projectRoot, runId, {
                  status: 'active',
                  incompleteChecks: ['verification-not-started'],
                });
                if (!settlement) {
                  violations.push(block('architecture-contract-gate',
                    `Architecture contract gate: the V2 rollback barrier is active, but the canonical run settlement could not be published for run \`${runId}\`. The run remains fail-closed and no implementer may spawn.`,
                    { ERROR: 'canonical V2 settlement publication failed' }));
                } else if (modelPolicy) {
                  if (!ensureRunPolicyBootstraps(projectRoot, modelPolicy, state)) {
                    violations.push(block('bootstrap-publication-gate',
                      `Bootstrap gate: the parent could not atomically publish role/rule/skill and work-unit envelopes against architecture=${compiled.contractHash}, verification=${verification.contractHash}, and assignments=${assignments.assignmentsHash}. No implementer may spawn until the immutable envelopes are published.`,
                      { ERROR: 'bootstrap publication failed' }));
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(block('architecture-contract-gate',
          `Architecture contract gate: do not emit \`PLAN_READY\` until \`.traffic-one/runs/${runId || '<runId>'}/architecture-input-v1.json\` is valid and runtime compilation succeeds. ${message}. The architect may change only semantic routes/modules/component placement/uiPrimitives/i18n/exceptions; runtime owns roots, roles, outputs, baseline, and hashes.`,
          { ERROR: message }));
      }
    }
  }

  digestCompletionGates({
    projectRoot, state, filePath, content, shellBody: args.shellBody, currentRunId, violations, block,
  });

  // Auto-fix over deny (13cl replan: two identical 'block missing' denies 30s
  // apart — the architect rewrites prose and cannot reconstruct machine
  // metadata from memory). A plan write carrying NO delegate marker while a
  // previously-accepted queue exists for the current run is preserved: the
  // write proceeds and runtime re-appends the prior block at the next
  // touchpoint (PLAN_READY gate / --from-plan). A write that DOES carry the
  // marker is the architect authoring the block, so an incomplete one still
  // denies with the concrete fix; a first-ever write with nothing recoverable
  // denies too.
  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && openCodeDelegationActive(state, host) && missingOpenCodeDelegateBlock(content) && opencodeQueueBlocks(host)
    && (hasOpenCodeDelegateMarker(content) || !preserveOpenCodeDelegateBlockForWrite(projectRoot, currentRunId))) {
    violations.push(block('plan-opencode-queue-gate',
      `Plan gate: OpenCode is enabled — \`.traffic-one/plan.md\` must include the machine-readable \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` block with at least ${OPENCODE_PLAN_MIN_UNITS} runnable bounded units (\`- id: <stable-unit-id> | role: frontend|backend|tester|docs | files: … | task: …\`). Prose-only or incomplete OpenCode lists are ignored by \`opencode_delegate_from_plan\`. A rewrite may omit the block only after a queue was accepted for the current run — runtime then preserves and re-appends it. Concrete example of a runnable unit row:\n\`<!-- opencode-delegate:start -->\`\n\`- id: seed-demo-data | role: backend | files: supabase/seed.sql | task: Seed the demo rows the plan data section describes\`\n\`<!-- opencode-delegate:end -->\``));
  }

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && hostFlags(currentHost).opencodeSelfHosted && hasOpenCodeDelegateMarker(content)) {
    violations.push(block('plan-opencode-self-delegation-gate',
      'Plan gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block; implementer work runs directly on the current host.'));
  }

  if (PLAN_FILE_RE.test(filePath) && openCodeDelegationActive(state, host) && !missingOpenCodeDelegateBlock(content)) {
    const policyErrors = openCodeQueuePolicyErrors(content);
    if (policyErrors.length > 0) {
      violations.push(block('plan-opencode-queue-policy-gate',
        `Plan gate: OpenCode queue metadata is unsafe: ${policyErrors.join('; ')}. Add stable unique ids, exact files allowlists, and depends edges for overlapping areas.`,
        { ERRORS: policyErrors.join('; ') }));
    }
  }

  const validStateStack = Boolean(state.stack && isKnownStack(state.stack));
  const stateMissing = !fs.existsSync(statePath(projectRoot)) && !fs.existsSync(legacyStatePath(projectRoot));
  const memoryPresent = fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'))
    || fs.existsSync(path.join(projectRoot, '.traffic-one', 'stack.md'));
  const detectedModeForState = state.mode || (stateMissing ? detectMode(projectRoot) : null);

  if (writingFeatureSource && !validStateStack && (detectedModeForState === 'new-project' || memoryPresent)) {
    violations.push(block('state-gate',
      'State gate: root .traffic-one/.one.json is missing or incomplete. Write the Traffic One state file with mode, stack, backend, realtime, confirmed, onboardingComplete, and confirmedAt before writing feature source. The .traffic-one/ folder is project memory, not the stack-selection state file.'));
  }

  const hasMaterializedAssets = hasMaterializedProjectAssets(projectRoot, state);
  const featureContextMaterialized = isPluginAuthoringRoot(projectRoot)
    || !state.onboardingComplete
    || (isMaterialized(state) && hasMaterializedAssets);

  if (writingFeatureSource && !featureContextMaterialized) {
    violations.push(block('materialization-gate',
      `Materialization gate: stack context for ${stackFingerprint(state)} has not been materialized on disk yet. Run \`node -e "const p=require('node:path'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,'traffic-one-runtime');require(p.join(r,'scripts','hook-runtime.cjs'))" materialize-project\` from the project root and verify \`.traffic-one/rules/**\`, \`.traffic-one/skills/**\`, \`.traffic-one/manifest.json\`, root \`AGENTS.md\`, and root \`CLAUDE.md\` exist before writing feature source.`,
      { FINGERPRINT: stackFingerprint(state) }));
  }

  const isNewProject = state.mode === 'new-project';
  const planMissing = !fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'));
  const writingPlan = PLAN_FILE_RE.test(filePath);
  const writingDoc = ADR_OR_DOC_RE.test(filePath);
  if (isNewProject && planMissing && writingFeatureSource && !writingPlan && !writingDoc
  ) {
    if (usesMainAgentTeam(state)) {
      violations.push(block('plan-main-agent-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project in Low/main-agent mode. Do NOT call `run_subagent`, `Task`, `spawn_agent`, `task`, or another subagent tool. You are the architect in this thread: write `.traffic-one/plan.md` and required `.traffic-one/` project memory before root config, workspace scaffold, or feature-source writes; then resume the same ordered phases. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    } else if (writerRole === 'senior-architect') {
      // Never tell the architect to "run the senior-architect subagent" (B8) —
      // it IS that subagent. Tell it to write the plan itself.
      violations.push(block('plan-architect-self-gate',
        'Plan gate: .traffic-one/plan.md is missing on this new project. You ARE the `senior-architect` for this run — write `.traffic-one/plan.md`, project memory, and semantic ArchitectureInputV1; do not spawn another architect and do not scaffold implementation files.'));
    } else {
      violations.push(block('plan-gate',
        'Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    }
  }

  return violations;
}

export {
  architectPhaseIncompleteReasons,
  isArchitectPhaseComplete,
} from './contracts';
