// src/modules/plan-guard/plan-readiness/completion.ts
// Digest completion gates: the frontend/implementer/reviewer/tester sections
// of the readiness walk, extracted verbatim from planReadinessViolations.
// Order and side effects are unchanged; the orchestrator calls this exactly
// where the sections used to sit.

import {
  capabilityProfileForRun,
  readCompiledArchitecture,
  readRuntimeAssignments,
  uiAstLintLayer,
} from '../../../shared/architecture-contract';
import {
  TEST_EVIDENCE_CHECK_IDS,
  readQaReportV2,
  reportSettledWithoutTestEvidence,
} from '../../../shared/qa-report-v2';
import {
  formatFileWithPrettier,
  resolveProjectPrettier,
} from '../../../shared/prettier-fix';
import { isNewProjectMode } from '../../../shared/state';
import { consolidateQualityFindings } from '../../../shared/state/quality-findings';
import {
  readVerificationContract,
} from '../../../shared/verification-contract';
import {
  COLLAPSE_LINE_CHARS,
  FIX_CYCLE_CONTEXT_RE,
  FRONTEND_DIGEST_RE,
  IMPLEMENTER_DIGEST_RE,
  REVIEWER_DIGEST_RE,
  TESTER_DIGEST_RE,
  type Block,
  type Rec,
  exists,
  recordScanBoundHit,
  recordScanIncomplete,
} from './context';
import {
  builtAppIdentities,
  canonicalLighthousePerformance,
  claimedLighthousePerformance,
  collapsedProductSourceFile,
  missingPlannedModulesForRole,
  qaReportOlderThanImplementation,
  qaReportVerifiedBuild,
  structureFindingSummary,
  undeliveredContractOutputs,
} from './checks';
import {
  compiledFormatToolchainForRole,
  compiledLintToolchainForRole,
  compiledOutputPaths,
  crawlOriginProblem,
  emitConfigProblems,
  eslintRuleSurvivalProblems,
  formatParityViolation,
  lintInvocationGap,
  lintParityViolation,
  lintableOutputPaths,
  roleOwnedTsOutputs,
  skippedVerificationLine,
  testToolchainGaps,
  typecheckInvocationGap,
  typecheckParityViolation,
} from './toolchain';

// A Lighthouse score an agent TYPED, judged against the score the canonical
// runner MEASURED. Tolerant by design: page-speed audits are noisy, so only a
// gap no re-run explains is a false claim.
const LIGHTHOUSE_CLAIM_TOLERANCE = 5;
import { type AssignedScope } from '../../../shared/scope';

import {
  allImplementationRolesDelivered,
  assignmentScopesForRole,
  digestClaimsVerdict,
  refreshVerificationAfterImplementation,
  runFullStructureScan,
  unsatisfiableFindingPaths,
} from './contracts';


/**
 * Format collapsed product source in place, then re-scan, until nothing is left
 * or the formatter cannot fix the next file.
 *
 * This is where formatting BELONGS: the file exists on disk, so `--write` can
 * actually change it, and a failure still ends in a deny. The write gate cannot
 * do this — it only ever sees proposed content and has no way to substitute it
 * (see shared/prettier-fix.ts) — so collapse denies there unconditionally and
 * the repair happens here.
 */
function repairCollapsedSource(
  projectRoot: string,
  state: Rec,
  scopes: readonly AssignedScope[] = [],
): ReturnType<typeof collapsedProductSourceFile> {
  let collapsed = collapsedProductSourceFile(projectRoot, state, scopes);
  const formatAttempted = new Set<string>();
  while (collapsed.file && !collapsed.incomplete) {
    const rel = collapsed.file.replace(/:\d+$/, '');
    if (formatAttempted.has(rel)) break;
    formatAttempted.add(rel);
    const bin = resolveProjectPrettier(projectRoot, rel);
    if (!bin || !formatFileWithPrettier(bin, projectRoot, rel)) break;
    collapsed = collapsedProductSourceFile(projectRoot, state, scopes);
  }
  return collapsed;
}

/**
 * The collapse scan's own compensation, at every branch that runs the scan.
 *
 * It used to live inline in the FRONTEND branch only, keyed on
 * `collapsed.incomplete`, and the non-frontend implementer branch read
 * `collapsed.file` and nothing else. So a backend collapse scan that hit
 * COLLAPSE_MAX_FILES returned `file: null`, the gate passed, and no floor was
 * raised — and with the scope filter absent (a missing or hash-invalid
 * manifest) that walk is whole-project, where 600 files is ordinary. Measured
 * end to end through `planReadinessViolations` over one tree with the cap blown:
 * frontend digest `scan-bound.json` present, ledger entry 1; backend digest
 * `scan-bound.json` absent, ledger entry 0.
 *
 * `incomplete` is no longer the whole question either. The scan now reports
 * what it did NOT read (`withdrawn`), and an unread subtree is the same fact as
 * an unfinished walk: the floor compensates both identically, so both are
 * recorded here rather than one of them.
 */
function recordCollapseCoverage(
  projectRoot: string,
  runId: string,
  role: string,
  collapsed: ReturnType<typeof collapsedProductSourceFile>,
  block: Block,
): void {
  if (!collapsed.incomplete && collapsed.withdrawn.length === 0) return;
  const cause = collapsed.incomplete
    ? `collapse scan bound: ${collapsed.scanned} product source files`
    : `collapse scan did not read ${collapsed.withdrawn.length} entr`
      + `${collapsed.withdrawn.length === 1 ? 'y' : 'ies'} it walked past: ${collapsed.withdrawn[0]}`;
  // Record the BOUND before the message that leans on it. The verification
  // contract raises `uiImpact` to the truncated-scan floor from this flag, and
  // that raise is the entire licence for recording rather than denying — an
  // unrecorded bound would leave the prose promising a compensation that never
  // happened, which is what the demotion originally shipped as.
  recordScanBoundHit(projectRoot, runId, cause);
  recordScanIncomplete(projectRoot, runId,
    block('frontend-structure-scan-incomplete',
      `Frontend completion gate: STRUCT_SCAN_INCOMPLETE after ${collapsed.scanned} product source files. This is recorded, not blocking: hitting the scan bound raises \`uiImpact\` to the truncated-scan floor on this run's verification contract, so the run owes more browser evidence rather than less. Narrow generated/output roots or split the project contract so the whole owned tree is judged.`,
      { SCANNED: collapsed.scanned, ROLE: role, CAUSE: cause }));
}

export function digestCompletionGates(ctx: {
  projectRoot: string;
  state: Rec;
  filePath: string;
  content: string;
  shellBody?: string;
  currentRunId: string;
  violations: string[];
  block: Block;
}): void {
  const { projectRoot, state, filePath, content, currentRunId, violations, block } = ctx;
  // Frontend completion gate: an `IMPLEMENTED` digest must not ship collapsed
  // product source. build/typecheck/lint all pass on a one-line-per-function
  // App.tsx, so nothing else stops it before the tester's format:check — and a
  // run interrupted before Phase 3 delivers a monolithic collapsed app with
  // empty scaffolded module dirs (observed 16c).
  const frontendDigest = FRONTEND_DIGEST_RE.exec(filePath);
  if (frontendDigest && digestClaimsVerdict(content, 'IMPLEMENTED')) {
    // Scoped to the files this role owns. The scan runs in BOTH modes — the
    // strict/raw split that keeps it safe on an existing codebase lives in the
    // detector (see `collapsedProductSourceFile`), not here, so a genuinely
    // minified file is still caught during maintenance.
    const frontendRunId = frontendDigest[2] || '';
    const collapsed = repairCollapsedSource(
      projectRoot,
      state,
      assignmentScopesForRole(projectRoot, frontendRunId, 'senior-frontend'),
    );
    recordCollapseCoverage(projectRoot, frontendRunId, 'senior-frontend', collapsed, block);
    if (collapsed.file) {
      violations.push(block('frontend-collapse-gate',
        // No character threshold in this text. Two detectors feed it — JS/TS
        // masks comments and strings and thresholds at 140 code chars (80 on a
        // JSX line), CSS uses raw >500 — so any single number printed here is a
        // lie for the other arm. Naming a bar the writer can then argue with is
        // worse than naming the file and the remedy, which is all that is
        // actionable anyway.
        `Frontend completion gate: do not write \`IMPLEMENTED\` with collapsed source. \`${collapsed.file}\` packs an entire component/route onto a single line — collapsed/minified source is a defect even when build and typecheck pass. Run the project formatter (\`format\` script), and split routes, pages, features, and shared components into their own files under the scaffolded module dirs (\`App.tsx\` is the router/shell only, not the whole app). Then re-run \`format:check\` and re-emit \`IMPLEMENTED\`.`,
        { FILE: collapsed.file }));
    }
    // Deterministic emit-config gate (new-project only; the pre-existing tsc -b
    // choices of an existing codebase are the user's, and maintenance must
    // never dead-end on them). Formatter parity is implementer-owner scoped
    // below and intentionally does not share this frontend-only branch.
    const frontendProfile = capabilityProfileForRun(projectRoot, state);
    if (isNewProjectMode(state) && frontendProfile.profileId === 'vite-react') {
      const emitProblems = emitConfigProblems(projectRoot, frontendProfile);
      if (emitProblems.length > 0) {
        const problems = emitProblems.join('; ');
        violations.push(block('frontend-emit-config-gate',
          `Frontend completion gate: ${problems}. The stock Vite template emits compiled \`.js\`/\`.d.ts\` next to every source on the first build, and the stale output can shadow the module at import time. Fix exactly this: set \`"noEmit": true\` in the app tsconfig, remove \`"composite": true\`, and use \`"build": "tsc --noEmit && vite build"\`, \`"typecheck": "tsc --noEmit"\`. Then re-emit \`IMPLEMENTED\`.`,
          { PROBLEMS: problems }));
      }
    }
    // The compiled lint layer is where the retired STRUCT_* heuristics became
    // real enforcement — which holds only while the rules SURVIVE. 16co: an
    // implementer rewrote eslint.config.js, `max-lines` vanished silently, and
    // its absence later cost the whole news delegation batch. New-project only:
    // an existing codebase's lint config is the user's.
    if (isNewProjectMode(state)) {
      const missingRules = eslintRuleSurvivalProblems(projectRoot, frontendProfile);
      if (missingRules.length > 0) {
        const problems = missingRules.join('; ');
        violations.push(block('frontend-eslint-survival-gate',
          `Frontend completion gate: ${problems}. The scaffolded eslint config is the project's quality bar — the error-grade rules (\`max-lines\`, \`no-restricted-imports\`) replaced retired deterministic gates and CI runs them after this build ends. Extend the config freely, but restore the scaffolded error rules before re-emitting \`IMPLEMENTED\`.`,
          { PROBLEMS: problems }));
      }
    }
    const runId = frontendRunId;
    const architecture = runId ? readCompiledArchitecture(projectRoot, runId) : null;
    if (architecture) {
      if (!readRuntimeAssignments(projectRoot, runId)) {
        violations.push(block('frontend-structure-completion-gate',
          'Frontend completion gate: STRUCT_ASSIGNMENT_ALLOWLIST_GAP — current-run assignments are missing, stale, or hash-invalid. A complete structural scan cannot prove that this worker stayed within its runtime-owned WorkUnitContract; recompile the run before writing `IMPLEMENTED`.',
          { FINDINGS: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP' }));
      } else {
        // `greenfield` decides whether the integration findings block or advise.
        // Left unwired it defaulted to false, which silently demoted
        // STRUCT_ORPHAN_MODULE, STRUCT_API_CLIENT_UNUSED and
        // STRUCT_TAILWIND_NO_TOOLCHAIN to warnings on NEW projects too — the very
        // case Traffic One owns the structure and must block.
        //
        // The two arguments are exact complements, and one predicate decides
        // both. An UNDECLARED mode used to be neither: greenfield false (so the
        // gates around this one stood down) and notScaffolded false (so these
        // findings stayed error-grade). That is the most opinion applied where
        // the least is known.
        const report = runFullStructureScan(
          projectRoot,
          runId,
          architecture,
          'senior-frontend',
          isNewProjectMode(state),
          !isNewProjectMode(state),
        );
        const errors = report.findings.filter((finding) => finding.severity === 'error');
        if (errors.length > 0) {
          const summary = structureFindingSummary(errors);
          violations.push(block('frontend-structure-completion-gate',
            `Frontend completion gate: runtime structure report failed (${summary}). Fix every blocking finding and re-run the complete scan before writing \`IMPLEMENTED\`. Per-component LOC, function-count, and component-count findings remain warnings during this rollout; module size is owned by the compiled eslint \`max-lines\` rule — the project's own \`lint\` run refuses an oversized module, so split it. Integration findings block too: orphan modules, unused API packages, inert styling, a missing i18n runtime (\`STRUCT_I18N_RUNTIME\`), and catalog validation (\`STRUCT_I18N_CATALOG\` — keys non-empty in every declared locale). Hardcoded-copy findings (\`STRUCT_HARDCODED_COPY\`, \`STRUCT_I18N_REACT_TRANS\`) block only on profiles without a compiled AST lint layer; where the scaffolded eslint config carries the i18n rule, the project's own \`lint\` run owns them. React child copy uses \`<Trans>\` with namespace, key, and fallback. On a project Traffic One did NOT scaffold — an existing codebase, or one whose \`.one.json\` declares no mode at all — every finding named above is an opinion about code the plugin did not write and is recorded as a warning instead; only ownership (\`STRUCT_ASSIGNMENT_ALLOWLIST_GAP\`) and plan delivery (\`STRUCT_MISSING_PLANNED_MODULE\`) can reach this gate there.`,
            { FINDINGS: summary }));
        }
      }
    }
  }

  // PLAN_READY is necessarily compiled before implementation exists. Refresh
  // the runtime-owned verification contract at the first terminal implementer
  // handoff so uiImpact, tablet risk, changed routes, and performance evidence
  // come from the real immutable-baseline diff. Candidate assignments and every
  // bootstrap are preflighted against the new hash before publication.
  const implementedDigest = IMPLEMENTER_DIGEST_RE.exec(filePath);
  // The digest BEING WRITTEN, whichever channel carries it. A shell-derived
  // write leaves `content` empty, and heredocs targeting `.traffic-one/digests/`
  // are explicitly exempt from the shell-write deny as run-state bookkeeping —
  // so an implementer publishing `cat > …/backend.md <<'EOF'` skipped this whole
  // battery, while the identical digest through `Write` was judged. The gates
  // below judge the digest's CLAIM; how the bytes arrived is not part of it.
  const implementerBody = content || ctx.shellBody || '';
  if (
    implementedDigest
    && digestClaimsVerdict(implementerBody, 'IMPLEMENTED')
    && isNewProjectMode(state)
  ) {
    const runId = implementedDigest[2] || '';
    const ownerRole = `senior-${implementedDigest[3] || ''}`;
    // Collapse is a defect in EVERY language, not just the frontend's. The scan
    // + on-disk repair used to hang off the frontend digest only, so a Go or
    // Python backend could ship collapsed source and nothing looked. Skip the
    // frontend here — its own branch above already ran the same repair, and
    // running it twice would double the walk for no new coverage.
    if (ownerRole !== 'senior-frontend') {
      // Scoped to what THIS role owns. Unscoped, the whole-project walk blamed
      // `senior-backend` for a collapsed `App.tsx` it cannot legally edit under
      // the assignment allowlist — a deny with no legal remedy.
      const collapsed = repairCollapsedSource(
        projectRoot,
        state,
        assignmentScopesForRole(projectRoot, runId, ownerRole),
      );
      recordCollapseCoverage(projectRoot, runId, ownerRole, collapsed, block);
      if (collapsed.file) {
        violations.push(block('implementer-collapse-gate',
          `Implementer completion gate: do not write \`IMPLEMENTED\` with collapsed source. \`${collapsed.file}\` packs an entire function/component onto a single line — collapsed/minified source is a defect even when build, typecheck and lint pass, and the project formatter could not repair it. Write one statement per line, run the project formatter, and re-emit \`IMPLEMENTED\`.`,
          { FILE: collapsed.file }));
      }
    }
    // NO read-receipt gate here, by measurement. A gate keyed on rules-ack
    // receipts was written and REMOVED after 9co proved the receipts are not
    // evidence of ingestion: every role satisfied it by batching the pager
    // (`Promise.all(Array.from({length:10}, i => exec(... --part ${i})))` with
    // `max_output_tokens: 3000`), so all parts were "served", the ack was
    // complete — and the aggregated exec output was still truncated
    // (11k-28k tokens across five role children). The receipt proves the
    // runner ran, not that the agent read it. The pack + pager themselves were
    // later removed with the same lesson applied: children read the
    // materialized `.traffic-one/rules|skills` tree one file per command, and
    // ingestion is enforced only by the deterministic output gates below —
    // never by read receipts.
    const architecture = runId ? readCompiledArchitecture(projectRoot, runId) : null;
    const tooling = architecture
      ? compiledFormatToolchainForRole(architecture, ownerRole)
      : null;
    if (tooling) {
      // Reaching here means this role OWNS the compiled `.prettierrc`, so it is
      // accountable for the script reading the whole compiled tree — not just
      // its own share. The remedy is a one-line edit in its own manifest
      // (`prettier --check .` plus `.prettierignore`), never formatting another
      // role's files, so this cannot deadlock across roles.
      const parity = formatParityViolation(
        projectRoot,
        tooling,
        architecture ? compiledOutputPaths(architecture) : [],
      );
      if (parity?.kind === 'uncovered-outputs') {
        const sample = parity.uncovered.map((output) => `\`${output}\``).join(', ');
        violations.push(block('implementer-format-coverage-gate',
          `Implementer format coverage gate: the \`${tooling.manifestPath}\` "${parity.script}" script runs \`${parity.command}\`, whose arguments never reach compiled outputs including ${sample}. A formatter that skips owned source proves nothing — it passes while those files are unformatted. Check the whole project instead (\`prettier --check .\`) and put build output, lockfiles, and \`.traffic-one\` in \`.prettierignore\`, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            MANIFEST: tooling.manifestPath,
            SCRIPT: parity.script,
            COMMAND: parity.command,
            UNCOVERED: sample,
          }));
      } else if (parity?.kind === 'missing-dependency') {
        violations.push(block('implementer-format-parity-gate',
          `Implementer format parity gate: role \`${ownerRole}\` owns formatter config \`${tooling.configPath}\`, but \`prettier\` is not declared in \`${tooling.manifestPath}\` dependencies/devDependencies. A script or config that names an absent tool makes verification meaningless. Add \`prettier\` with the selected package manager at tooling root \`${tooling.toolingRoot}\`, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            CONFIG: tooling.configPath,
            MANIFEST: tooling.manifestPath,
            TOOLING_ROOT: tooling.toolingRoot,
          }));
      } else if (parity?.kind === 'missing-toolchain') {
        violations.push(block('implementer-format-toolchain-gate',
          `Implementer format toolchain gate: role \`${ownerRole}\` owns compiled formatter outputs at \`${tooling.toolingRoot}\`, but no Prettier config, \`format\`/\`format:check\` scripts, or \`prettier\` dependency is present. Create \`${tooling.configPath}\`, add matching scripts and the dependency to \`${tooling.manifestPath}\`, run the formatter, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            CONFIG: tooling.configPath,
            MANIFEST: tooling.manifestPath,
            TOOLING_ROOT: tooling.toolingRoot,
          }));
      }
    }
    if (architecture) {
      const tsOutputs = roleOwnedTsOutputs(architecture, ownerRole);
      const typecheckGap = tsOutputs.length > 0
        ? typecheckParityViolation(projectRoot, tsOutputs)
        : null;
      const invocationGap = tsOutputs.length > 0 && !typecheckGap
        ? typecheckInvocationGap(projectRoot, tsOutputs)
        : null;
      if (invocationGap) {
        const manifestList = invocationGap.unreached.map((manifest) => `\`${manifest}\``).join(', ');
        violations.push(block('implementer-typecheck-invocation-gate',
          `Implementer typecheck gate: the root \`package.json\` "typecheck" script runs \`${invocationGap.script}\`, which never invokes the per-package \`typecheck\` this contract demanded in ${manifestList}. A compiler that is installed, scripted, and never run is not coverage — the project's own command reports success while the errors stay unreported. Broadcast to every workspace member (\`pnpm -r typecheck\`, \`turbo run typecheck\` with no filter) or name each package in the filter, run it clean, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            SCRIPT: invocationGap.script,
            MANIFESTS: manifestList,
          }));
      }
      if (typecheckGap) {
        const manifestList = typecheckGap.manifests.map((manifest) => `\`${manifest}\``).join(', ');
        violations.push(block('implementer-typecheck-toolchain-gate',
          `Implementer typecheck gate: role \`${ownerRole}\` owns compiled TypeScript outputs, but no \`typescript\` dependency or \`typecheck\` script exists in ${manifestList}. \`IMPLEMENTED\` without a runnable compiler is unverifiable — the type errors surface later in a sibling role's build instead. Add \`typescript\` and a \`typecheck\` script (\`tsc --noEmit\`) to the tooling root, run it clean, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            MANIFESTS: manifestList,
          }));
      }
      // Lint parity triad, only where the compiled eslint config carries real
      // AST rules (React-family, Vue) — those profiles' write-time lexical
      // copy findings were demoted to warnings on exactly the promise that the
      // project's own `lint` run owns the quality verdict, so a lint layer
      // that cannot run or never reaches a package would be an enforcement
      // coverage gap, not a style nit.
      const lintTooling = uiAstLintLayer(architecture.profile)
        ? compiledLintToolchainForRole(architecture, ownerRole)
        : null;
      if (lintTooling) {
        const lintParity = lintParityViolation(projectRoot, lintTooling);
        const lintGap = !lintParity
          ? lintInvocationGap(projectRoot, lintableOutputPaths(architecture))
          : null;
        if (lintParity) {
          const missing = lintParity.missing.join(' and ');
          violations.push(block('implementer-lint-toolchain-gate',
            `Implementer lint gate: role \`${ownerRole}\` owns the compiled \`${lintTooling.configPath}\`, whose AST rules are this run's quality verdict for UI source, but ${missing} is absent from \`${lintTooling.manifestPath}\`. The write-time lexical copy scanners are warnings on this profile on exactly the promise that the project's own \`lint\` runs — a lint layer that cannot run is an enforcement gap, not a style nit. Add the missing entries (the scaffold seeds \`eslint\` plus the plugins the config imports), run \`lint\` clean, then re-emit \`IMPLEMENTED\`.`,
            {
              ROLE: ownerRole,
              CONFIG: lintTooling.configPath,
              MANIFEST: lintTooling.manifestPath,
              MISSING: missing,
            }));
        } else if (lintGap) {
          const manifestList = lintGap.unreached.map((manifest) => `\`${manifest}\``).join(', ');
          violations.push(block('implementer-lint-invocation-gate',
            `Implementer lint gate: the root \`package.json\` "lint" script runs \`${lintGap.script}\`, which never invokes the per-package \`lint\` in ${manifestList}. A linter that is installed, scripted, and never run is not coverage — the compiled AST quality rules silently stop applying to those packages. Broadcast to every workspace member (\`pnpm -r lint\`, \`turbo run lint\` with no filter) or name each package in the filter, run it clean, then re-emit \`IMPLEMENTED\`.`,
            {
              ROLE: ownerRole,
              SCRIPT: lintGap.script,
              MANIFESTS: manifestList,
            }));
        }
      }
    }
    if (architecture) {
      const origin = crawlOriginProblem(projectRoot, architecture, ownerRole);
      if (origin) {
        violations.push(block('implementer-crawl-origin-gate',
          `Implementer crawl origin gate: \`${origin.file}\` ships an unusable production origin — ${origin.detail}. Crawl assets are published verbatim, so an invented origin is a live defect, not a placeholder. Generate these files from the public site-url env var (\`VITE_SITE_URL\` or the framework equivalent) and fail generation when it is unset; leave the deploy origin \`Unverified\` in project memory until the user supplies it. Then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            FILE: origin.file,
            DETAIL: origin.detail,
          }));
      }
      // Advisory counts too: an advisory contract still AUDITS page speed, it
      // just does not veto the run. Keying this on `required` alone would drop
      // `lighthouse` from the manifest and silently lose the measurement — the
      // one thing the advisory reclassification must not do.
      const performanceContract = readVerificationContract(
        projectRoot,
        implementedDigest[2] || '',
      )?.performance;
      const performanceAudited = Boolean(performanceContract?.required || performanceContract?.advisory);
      const testGaps = testToolchainGaps(projectRoot, architecture, ownerRole, performanceAudited);
      if (testGaps) {
        const missing = testGaps.missing.join(', ');
        violations.push(block('implementer-test-toolchain-gate',
          `Implementer test toolchain gate: role \`${ownerRole}\` owns \`${testGaps.manifest}\`, and the contract compiles tester-owned runner configs there, but ${missing} is absent. The tester owns the configs and never the manifest, so it cannot install its own runner — it inherits a config for a tool that is not there and has no way to run the suite. When the verification contract requires performance evidence, project-local \`lighthouse\` belongs in the same manifest for the same reason. Add the missing dependencies and scripts to \`${testGaps.manifest}\`, then re-emit \`IMPLEMENTED\`.`,
          {
            ROLE: ownerRole,
            MANIFEST: testGaps.manifest,
            MISSING: missing,
          }));
      }
    }
    // Contract-delivery gate. `changedPaths` is the UNION of the observed diff
    // and every planned output, so a contract can assert 15 changed files while
    // `observedChangedPaths` holds none and one file exists on disk (observed
    // 10co-e2e). A verdict is a claim about the role's OWN compiled work unit;
    // this compares that unit against what was actually delivered.
    const delivery = undeliveredContractOutputs(projectRoot, runId, ownerRole);
    if (delivery) {
      const missing = delivery.missing.slice(0, 10).join(', ');
      violations.push(block('implementer-contract-delivery-gate',
        `Implementer completion gate: \`IMPLEMENTED\` is forbidden while ${delivery.missing.length} of role \`${ownerRole}\`'s ${delivery.planned} compiled modules do not exist and were never observed as changed (${missing}). \`changedPaths\` unions the observed diff with every PLANNED output, so a contract can look complete while the files were never written — a verdict must describe what was delivered, not what was planned. Write the missing modules, or report \`BLOCKED\` naming them. Do not re-emit \`IMPLEMENTED\` until each one exists.`,
        {
          ROLE: ownerRole,
          MISSING: missing,
          COUNT: delivery.missing.length,
          PLANNED: delivery.planned,
        }));
    }
    const implementerLighthouseClaim = claimedLighthousePerformance(content);
    const implementerMeasured = implementerLighthouseClaim
      ? canonicalLighthousePerformance(projectRoot, runId)
      : null;
    if (implementerLighthouseClaim
      && implementerMeasured !== null
      && implementerLighthouseClaim.value - implementerMeasured > LIGHTHOUSE_CLAIM_TOLERANCE) {
      violations.push(block('lighthouse-claim-reconciliation-gate',
        `Page-speed claim gate: this digest reports Lighthouse performance ${implementerLighthouseClaim.value} — "${implementerLighthouseClaim.line}" — but the canonical QA runner measured ${implementerMeasured} for run \`${runId}\`. A self-run audit is not the run's evidence: it can use a different Lighthouse version, a dev server, or a build from another run, and its report files are not run-scoped. Quote the runner's number (\`.traffic-one/reports/qa/${runId}/lighthouse-evidence-v1.json\`), or re-run the canonical sweep and quote the fresh one.`,
        {
          CLAIMED: implementerLighthouseClaim.value,
          MEASURED: implementerMeasured,
          RUN_ID: runId,
          EVIDENCE: implementerLighthouseClaim.line,
        }));
    }
    // Read the heredoc payload too. A shell-derived digest write carries
    // `resultContent: ''`, so a role that published its digest through
    // `cat > … <<'EOF'` — an explicitly permitted way to write run bookkeeping —
    // skipped this gate entirely while the identical digest through `Write` was
    // denied. The reviewer satisfiability gate below already reads `shellBody`
    // for the same reason; this is the same channel, not a new one.
    const skipped = skippedVerificationLine(implementerBody);
    if (skipped) {
      violations.push(block('implementer-verification-skipped-gate',
        `Implementer verification gate: this digest reports a required command as skipped or unavailable — "${skipped}" — directly alongside \`IMPLEMENTED\`. A verdict is a claim that the owned scope was verified, so an unrun build/typecheck/lint makes it unverifiable and the errors surface later in a sibling role's build. Install the toolchain at its owning manifest, run the command to completion, record the real outcome, then re-emit \`IMPLEMENTED\`. If the command genuinely does not apply, say why without claiming it was skipped.`,
        { EVIDENCE: skipped }));
    }
  }
  // Batched quality delivery: at the role's completion digest, consolidate the
  // write-time findings its writes accumulated (instead of interrupting each
  // write) into ONE fix-cycle document —
  // `.traffic-one/fix-cycles/<runId>/<role>-quality-findings.md` — that the
  // fix-cycle mechanism (orchestrator context file + SessionStart fix-cycle
  // header) hands to the implementer as a single "apply ALL findings in this
  // one turn" list. Delivery only: the completion structure scan above still
  // denies while blocking findings remain on disk.
  if (implementedDigest && digestClaimsVerdict(content, 'IMPLEMENTED')) {
    consolidateQualityFindings(
      projectRoot,
      implementedDigest[2] || '',
      `senior-${implementedDigest[3] || ''}`,
    );
  }
  if (implementedDigest
    && implementedDigest[2] === currentRunId
    && digestClaimsVerdict(content, 'IMPLEMENTED')
    && violations.length === 0) {
    const runId = implementedDigest[2] || '';
    if (allImplementationRolesDelivered(projectRoot, runId, filePath)) {
      const refresh = refreshVerificationAfterImplementation(projectRoot, runId, state);
      if (refresh.error) {
        violations.push(block('verification-contract-refresh-gate',
          `Verification refresh gate: \`IMPLEMENTED\` is forbidden because runtime could not rederive and atomically republish VerificationContractV2 from the immutable baseline (${refresh.error}). No stale nonvisual/behavioral classification may reach QA; repair the semantic plan/runtime prerequisite and retry the same digest.`,
          { ERROR: refresh.error }));
      }
    }
  }

  const reviewerDigest = REVIEWER_DIGEST_RE.exec(filePath);
  // Finding-satisfiability gate. A `CHANGES_REQUESTED` finding is an ORDER, and
  // the orchestrator copies it verbatim into the fix-cycle context; the same
  // check therefore runs on that file. A named path that no role may write is
  // an order the receiving role is structurally forbidden to carry out — the
  // implementer is denied `run-team-runtime-allowlist-gap`, whose remedy is a
  // replan the fix cycle cannot perform, so the reviewer never reaches
  // `APPROVED` and the run deadlocks (observed 12co on `apps/web/public/llms.txt`).
  //
  // The reviewer is read-only by contract and publishes its digest as a
  // `cat > … <<'EOF'` heredoc, so this is the one gate that must read the
  // shell payload: with `content` alone it would be permanently blind on the
  // exact write it exists to judge.
  const fixCycleContext = FIX_CYCLE_CONTEXT_RE.exec(filePath);
  const findingText = content || ctx.shellBody || '';
  const findingRunId = fixCycleContext
    ? (fixCycleContext[2] || '')
    : (reviewerDigest && digestClaimsVerdict(findingText, 'CHANGES_REQUESTED') ? (reviewerDigest[2] || '') : '');
  if (findingRunId) {
    const unowned = unsatisfiableFindingPaths(projectRoot, findingRunId, findingText);
    if (unowned.length > 0) {
      const paths = unowned.map((target) => `\`${target}\``).join(', ');
      violations.push(block('finding-allowlist-gap',
        `Finding-satisfiability gate: ${paths} is named as work to do, but it is outside EVERY role's runtime-owned WorkUnitContract for run \`${findingRunId}\`. The role you would hand this to cannot write it — the run-team gate denies the write with STRUCT_ASSIGNMENT_ALLOWLIST_GAP, and a fix cycle cannot replan, so the loop never closes. Do one of three things instead: point the finding at a path a role already owns; drop it; or record it explicitly as DEFERRED (or REPLAN) on the same line, with the reason, so the next run's ArchitectureInputV1 compiles a home for it. Never hand a role an instruction its allowlist forbids.`,
        { PATHS: paths, RUN_ID: findingRunId }));
    }
  }
  if (reviewerDigest && digestClaimsVerdict(content, 'APPROVED') && !digestClaimsVerdict(content, 'CHANGES_REQUESTED')) {
    const runId = reviewerDigest[2] || '';
    const architecture = runId ? readCompiledArchitecture(projectRoot, runId) : null;
    if (architecture) {
      if (!readRuntimeAssignments(projectRoot, runId)) {
        violations.push(block('reviewer-structure-gate',
          'Reviewer gate: `APPROVED` is forbidden with STRUCT_ASSIGNMENT_ALLOWLIST_GAP. Current-run assignments are missing, stale, or hash-invalid, so the complete structural scan cannot establish WorkUnit coverage.',
          { FINDINGS: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP' }));
      } else {
        // Same mode gate as the frontend branch: Traffic One owns the structure of
        // a project it scaffolded, and only advises on one it did not.
        const report = runFullStructureScan(
          projectRoot,
          runId,
          architecture,
          undefined,
          isNewProjectMode(state),
          !isNewProjectMode(state),
        );
        const errors = report.findings.filter((finding) => finding.severity === 'error');
        if (errors.length > 0) {
          const summary = structureFindingSummary(errors);
          violations.push(block('reviewer-structure-gate',
            `Reviewer gate: \`APPROVED\` is forbidden while the complete runtime structure report contains errors (${summary}). Review the compiled architecture and request fixes.`,
            { FINDINGS: summary }));
        }
      }
    }
    if (runId === currentRunId && violations.length === 0) {
      const refresh = refreshVerificationAfterImplementation(projectRoot, runId, state);
      if (refresh.error || refresh.changed) {
        const reason = refresh.error
          || 'runtime raised VerificationContractV2 from the final implementation diff; the current review bootstrap predates that contract';
        violations.push(block('verification-contract-refresh-gate-approved',
          `Verification refresh gate: \`APPROVED\` is forbidden because ${reason}. Re-read the newly published bootstrap/verification hash and repeat the review under the final risk contract.`,
          { ERROR: reason }));
      }
    }
  }

  // Tester completion gate: `TESTS_GREEN` must not rest on a QA report that predates the
  // implementation it claims to verify. The settlement floor already REFUSES such a report
  // (strictQaReportResult uses max(qaContractActivatedAt, frontend digest mtime)), but it
  // refuses SILENTLY: observed live in cursor-16c the frontend re-emitted its digest 11s
  // after the sweep ran, so reviewer APPROVED + tester TESTS_GREEN + a `passed` report still
  // left the run non-terminal — and it only recovered by accident when an unrelated feature
  // request triggered a fresh sweep. The orchestrator prose already tells the tester to
  // re-run the sweep after a fix cycle; this turns "ignored instruction, silent stall" into
  // an actionable deny at the moment the stale verdict is written.
  const testerDigest = TESTER_DIGEST_RE.exec(filePath);
  // The VERDICT line, not the token anywhere in the body — every sibling gate in
  // this file already reads it that way, and contracts.ts records why: whole-body
  // matching once blocked honest failure reports, "gates were selecting for
  // phrasing, not truth". A tester writing `verdict: TESTS_FAILING` and then
  // EXPLAINING why it cannot claim TESTS_GREEN was tripping this whole battery.
  if (testerDigest && digestClaimsVerdict(content, 'TESTS_GREEN')) {
    const runId = testerDigest[2] || '';
    if (runId === currentRunId && violations.length === 0) {
      const refresh = refreshVerificationAfterImplementation(projectRoot, runId, state);
      if (refresh.error || refresh.changed) {
        const reason = refresh.error
          || 'runtime raised VerificationContractV2 from the final implementation diff; the current QA report/bootstrap predates that contract';
        violations.push(block('verification-contract-refresh-gate-tests-green',
          `Verification refresh gate: \`TESTS_GREEN\` is forbidden because ${reason}. Re-read the newly published verification hash, regenerate risk-proportional evidence, and retry the tester verdict.`,
          { ERROR: reason }));
      }
    }
    // Planned test modules are known from PLAN_READY, but the only gate that
    // checked their existence ran at the reviewer's `APPROVED` — i.e. after both
    // fix cycles were already spent. Observed 10co: a single missing
    // `tests/route-smoke.test.ts` surfaced at the last approval, hit the
    // two-cycle cap, and cost a user authorization to recover. The tester owns
    // these paths, so raise it here while budget remains.
    const missingTestModules = missingPlannedModulesForRole(projectRoot, runId, 'senior-tester');
    if (missingTestModules.length > 0) {
      const list = missingTestModules.join(', ');
      violations.push(block('tester-planned-module-gate',
        `Tester completion gate: \`TESTS_GREEN\` is forbidden while a compiled test module the tester owns is missing (${list}). The complete structure scan blocks the reviewer's \`APPROVED\` on the same finding, so writing this verdict now spends a fix cycle to discover it. Create the module, run it, then re-emit \`TESTS_GREEN\`.`,
        { MISSING: list }));
    }
    // Same reconciliation as the implementer branch: a page-speed number in a
    // TESTS_GREEN digest must be the runner's, not a self-run audit's.
    const testerLighthouseClaim = claimedLighthousePerformance(content);
    const testerMeasured = testerLighthouseClaim
      ? canonicalLighthousePerformance(projectRoot, runId)
      : null;
    if (testerLighthouseClaim
      && testerMeasured !== null
      && testerLighthouseClaim.value - testerMeasured > LIGHTHOUSE_CLAIM_TOLERANCE) {
      violations.push(block('lighthouse-claim-reconciliation-gate',
        `Page-speed claim gate: this digest reports Lighthouse performance ${testerLighthouseClaim.value} — "${testerLighthouseClaim.line}" — but the canonical QA runner measured ${testerMeasured} for run \`${runId}\`. A self-run audit is not the run's evidence: it can use a different Lighthouse version, a dev server, or a build from another run, and its report files are not run-scoped. Quote the runner's number (\`.traffic-one/reports/qa/${runId}/lighthouse-evidence-v1.json\`), or re-run the canonical sweep and quote the fresh one.`,
        {
          CLAIMED: testerLighthouseClaim.value,
          MEASURED: testerMeasured,
          RUN_ID: runId,
          EVIDENCE: testerLighthouseClaim.line,
        }));
    }
    const verification = runId ? readVerificationContract(projectRoot, runId) : null;
    if (verification) {
      const result = readQaReportV2(projectRoot, runId);
      if (!result.ok) {
        // Name WHICH dimension failed. A single aggregate verdict sent roles
        // re-running the whole matrix to find out (observed 10co: 4 QA cycles,
        // 27m44s of tester activity for 2m24s of actual browser time).
        const d = result.dimensions;
        const breakdown = `functional=${d.functionalQaStatus} accessibility=${d.accessibilityStatus} responsive=${d.responsiveStatus} lighthouse=${d.lighthouseStatus}`;
        violations.push(block('tester-qa-v2-gate',
          `Tester completion gate: VerificationContractV2 rejected this verdict (${result.code}: ${result.message}). Dimensions: ${breakdown}. Re-run only the failing dimension for uiImpact=${verification.uiImpact}; a blocked environment is not \`TESTS_GREEN\`, and an \`advisory-warning\` is never the thing to fix. The sidecar is runtime evidence: produce it with the canonical runner — \`node ~/.traffic-one/bin/qa-evidence-runner.cjs browser …\` per the browser-qa skill, or \`stack --run-id <id>\` for no-browser contracts (the shim runs the plugin's \`scripts/qa-evidence-runner.cjs\`) — never by hand-editing \`report-v2.json\`. Hand-authoring it does not work: on a browser contract the runtime Playwright evidence is content-hashed against the report, and on a no-browser contract every excused check is cross-checked against the runner's own resolution record under \`.traffic-one/runs/<id>/\`, which is a runtime-owned sidecar no agent may write.`,
          { ERROR: `${result.code}: ${result.message}`, DIMENSIONS: breakdown, UI_IMPACT: verification.uiImpact }));
      }
      // THE DISCLOSURE, ON THE PATH THAT HAD NO USER-FACING TEXT AT ALL.
      //
      // The product decision: a Node or plain-PHP project with a build script
      // and no test script may still settle as verified, but the ABSENCE of test
      // evidence must be explicit in the verdict, in the durable artifact, and
      // in what the user is told. The first two are the validator's advisory and
      // `settledWithoutTestEvidence` in report-v2.json. This is the third, and
      // before it the only route that existed stopped at the artifact: the
      // verdict said `passed`, `publishStackReport` dropped advisories from its
      // return type, and this gate read `result.code` and `result.message` on
      // failure and nothing at all on success.
      //
      // A DENY RATHER THAN A NOTICE, because this gate has no notice channel —
      // `planReadinessViolations` returns blocking strings and nothing else —
      // and inventing one is a cross-cutting change to every hook entry. It is
      // still DISCLOSE and not REFUSE: the run settles, and what is refused is a
      // verdict that omits the disclosure. The tester already learned this at
      // the moment it ran the sweep (the runner prints the same advisory to
      // stderr and into its stdout JSON), so the well-behaved path never reaches
      // here, and the remedy is one line rather than a re-run.
      //
      // Derived from the CHECKS the validator accepted, not from the report's
      // own `settledWithoutTestEvidence` flag: the flag is a convenience for a
      // later reader of the artifact, and a gate that trusted it would be
      // trusting the report to volunteer its own bad news.
      if (result.ok && reportSettledWithoutTestEvidence(result.report.checks)) {
        // The TEST-EVIDENCE ids only. The same run usually excuses `stack-lint`
        // and `stack-format` too — an ordinary Node project declares neither —
        // and naming those here would tell the tester to disclose a missing
        // formatter as missing test coverage, which is both false and the
        // fastest way to make the token meaningless.
        const excused = result.report.checks
          .filter((check) => (TEST_EVIDENCE_CHECK_IDS as readonly string[]).includes(check.id)
            && check.status === 'not-applicable'
            && check.notApplicable === 'no-command-declared')
          .map((check) => check.id)
          .join(', ');
        if (!/NO_TEST_EVIDENCE/.test(content)) {
          violations.push(block('tester-no-test-evidence-disclosure',
            `Tester completion gate: this run settled with NO TEST EVIDENCE and the digest does not say so. The QA runner excused ${excused} because this project declares no such command — no manifest script and no pinned language default — so nothing was measured for it and nothing here says the code is covered. That is allowed to settle, and it is not allowed to settle quietly: a reader of this digest must not have to open \`report-v2.json\` to discover that the test dimension was skipped rather than passed. Add a line to this digest containing the token \`NO_TEST_EVIDENCE\` and naming what was not measured (for example: "NO_TEST_EVIDENCE — ${excused} was excused: this project declares no test command, so no tests ran"), then re-emit \`TESTS_GREEN\`. Do not add a placeholder test script to silence this; a script that runs nothing is worse than the honest absence.`,
            { EXCUSED: excused }));
        }
      }
    }
    if (!verification) {
    const staleQa = qaReportOlderThanImplementation(projectRoot, testerDigest[2] || '');
    if (staleQa) {
      violations.push(block('tester-stale-qa-gate',
        `Tester completion gate: do not write \`TESTS_GREEN\` on a stale QA report. The report was generated at ${staleQa.generatedAt} but \`${staleQa.digest}\` was re-emitted at ${staleQa.digestAt}, so the sweep did not see the current implementation and the run cannot settle. Re-run the visual QA sweep now, write the fresh report, and only then re-emit \`TESTS_GREEN\`.`,
        { GENERATED_AT: staleQa.generatedAt, DIGEST: staleQa.digest, DIGEST_AT: staleQa.digestAt }));
    }
    // Every other QA freshness check is TEMPORAL, so a sweep aimed at a leftover
    // preview server passes them all: it genuinely ran, just against another app.
    // Only the served build identity answers "which application answered?".
    const expectedBuilds = builtAppIdentities(projectRoot);
    if (expectedBuilds.length > 0) {
      const observed = qaReportVerifiedBuild(projectRoot, testerDigest[2] || '');
      if (observed && !observed.present) {
        violations.push(block('tester-qa-build-identity-missing',
          `Tester completion gate: do not write \`TESTS_GREEN\` on a QA report that does not name the build it loaded. This run's fresh build is \`${expectedBuilds.join(', ')}\`, but the QA report has no \`verifiedBuild\`. Start the preview on a port THIS run owns (\`--strictPort\`, never a shared default like 4173/5173/3000), fetch the base URL, read the entry asset the served HTML references, record it as \`verifiedBuild\`, and re-run the sweep.`,
          { EXPECTED: expectedBuilds.join(', ') }));
      } else if (observed && observed.present && !expectedBuilds.includes(observed.value)) {
        violations.push(block('tester-qa-build-identity-mismatch',
          `Tester completion gate: the QA sweep validated a DIFFERENT application. The report records \`verifiedBuild: ${observed.value}\` but this run's fresh build is \`${expectedBuilds.join(', ')}\` — the base URL answered a leftover preview server (observed live: a previous project's \`vite preview\` still held the port, so every check passed against another app). Kill the foreign server or bind your own free port with \`--strictPort\`, re-run the sweep against it, and only then re-emit \`TESTS_GREEN\`.`,
          { EXPECTED: expectedBuilds.join(', '), OBSERVED: observed.value }));
      }
    }
    }
  }
}
