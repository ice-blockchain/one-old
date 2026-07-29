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
  persistCompiledArchitecture,
  publishRuntimeAssignments,
  readCompiledArchitecture,
  readRuntimeAssignments,
  validateArchitectureInput,
  webPackageRoot,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import { profileHasWebUi, type CapabilityProfileV1 } from '../../../shared/capabilities';
import { isKnownStack } from '../../../shared/config';
import { isPluginAuthoringRoot } from '../../../shared/authoring-root';
import { detectMode } from '../../../shared/detection';
import { packageJsonDeclaresWorkspace, stateRequiresNewProjectMonorepo } from '../../../shared/hook/paths';
import { hasMaterializedProjectAssets } from '../../../shared/materialize';
import { canonicalHost } from '../../../shared/model-tiers';
import { openCodeDelegationActive } from '../../../shared/performance';
import { OPENCODE_PLAN_MIN_UNITS, parsePlanDelegationUnits, planDelegationUnitCount } from '../../../shared/opencode-roles';
import { obj } from '../../../shared/obj';
import { readQaReportV2 } from '../../../shared/qa-report-v2';
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
import { matchesPattern, matchesScope, normalizeRelPath, type AssignedScope } from '../../../shared/scope';
import {
  activeAgentRole,
  isMaterialized,
  legacyStatePath,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
  stackFingerprint,
  statePath,
} from '../../../shared/state';
import {
  buildVerificationContract,
  changedPathsFromBaseline,
  publishVerificationContract,
  readVerificationContract,
  type LighthouseThresholdsV1,
  type UiImpact,
} from '../../../shared/verification-contract';
import { readVerificationPlanIntent } from '../../../shared/verification-plan-intent';
import {
  analyzeProjectStructure,
  analyzeStructureText,
  analyzeStructureTextAgainstContract,
  invalidateStructureCache,
  writeStructureReport,
  type StructureFinding,
} from '../react-structure';

import {
  ARCHITECTURE_INPUT_RE,
  ARCHITECT_DIGEST_RE,
  ASSIGNMENTS_FILE_RE,
  COLLAPSE_LINE_CHARS,
  FRONTEND_DIGEST_RE,
  IMPLEMENTER_DIGEST_RE,
  PLAN_FILE_RE,
  REVIEWER_DIGEST_RE,
  TESTER_DIGEST_RE,
  type Block,
  type Rec,
  exists,
} from './context';
import {
  builtAppIdentities,
  collapsedProductSourceFile,
  qaReportOlderThanImplementation,
  qaReportVerifiedBuild,
  structureFindingSummary,
} from './checks';
import {
  compiledFormatToolchainForRole,
  compiledOutputPaths,
  crawlOriginProblem,
  emitConfigProblems,
  formatParityViolation,
  roleOwnedTsOutputs,
  skippedVerificationLine,
  testToolchainGaps,
  typecheckParityViolation,
} from './toolchain';
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
  allImplementationRolesDelivered,
  architectMayWrite,
  architectureInputErrors,
  artifactContract,
  assignmentScopesForRole,
  assignmentWriterRole,
  digestClaimsVerdict,
  refreshVerificationAfterImplementation,
  roleContract,
  runFullStructureScan,
  runtimeOwnedRunSidecar,
  usesMainAgentTeam,
} from './contracts';
import { digestCompletionGates } from './completion';

export interface ReadinessArgs {
  filePath: string;          // project-relative target path
  content: string;           // write content (Write.content / Edit.new_string)
  // False when the target was inferred from a shell command whose write payload
  // cannot be reconstructed (e.g. `node -e` naming the file). Content-shape
  // gates then judge the on-disk artifact instead of an empty pseudo-payload.
  contentVerified?: boolean;
  projectRoot: string;       // resolved project root for the target
  state: Rec;                // readEffectiveState(projectRoot)
  writingFeatureSource: boolean;
  host?: string;
  rawData?: unknown;
  block: Block;
}

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
      violations.push(block('run-artifact-work-unit-gate',
        `Run artifact gate: \`${filePath}\` may be written only by the parent-bound \`${childArtifact.role}\` child whose current, hash-valid WorkUnitContract names this exact output. Active role is \`${writerRole || 'unresolved'}\`; no digest, QA report, or deployment claim may self-authorize or borrow another run's bootstrap.`,
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
          `Architecture input gate: ArchitectureInputV1 may contain only semantic routes, modules, and narrow exception requests. Runtime owns profiles, roots, roles, limits, output paths, and the baseline. Fix: ${errors.join('; ')}.`,
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
  if (writingFeatureSource && /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|php)$/i.test(filePath)) {
    const profile = capabilityProfileForRun(projectRoot, state);
    if (profileHasWebUi(profile)) {
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
      const findings = (scopedArchitecture
        ? analyzeStructureTextAgainstContract(
            filePath,
            content,
            scopedArchitecture,
            writerRole ? { allowlist } : {},
          )
        : analyzeStructureText(filePath, content, profile, []))
        .filter((finding) => finding.severity === 'error');
      if (findings.length > 0) {
        // Carry each finding's own message. Reporting only `ID (file:line)`
        // withheld the one fact that resolves the deny — which route/module is
        // wrong and what the compiled contract expects instead — so the writer
        // guessed: observed 2cu, three of four routes were correct and only the
        // catch-all failed, but the frontend read the generic prose as "routes
        // are forbidden here", reported BLOCKED twice, and burned a re-plan.
        const summary = structureFindingSummary(findings);
        violations.push(block('frontend-structure-hot-gate',
          `Structural gate: ${summary}. Entrypoints may only bootstrap the app; route pages must be separate compiled modules. Formatting the same monolith across more lines does not satisfy this gate.`,
          { FINDINGS: summary }));
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
    if (state.mode === 'new-project' && openCodeDelegationActive(state, host) && planOnDiskMissingOpenCodeBlock(projectRoot) && opencodeQueueBlocks(host)) {
      violations.push(block('architect-opencode-queue-gate',
        `Architect completion gate: OpenCode is enabled but \`.traffic-one/plan.md\` is missing at least ${OPENCODE_PLAN_MIN_UNITS} runnable machine-readable delegation units. Include \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` with 3–6 bounded units (\`- id: <stable-unit-id> | role: … | files: … | task: …\`) before emitting \`PLAN_READY\`. The orchestrator runs \`opencode_delegate_from_plan\` from that block BEFORE spawning implementers.`));
    }
    if (state.mode === 'new-project' && (currentHost === 'opencode' || currentHost === 'kilo') && planOnDiskHasOpenCodeDelegateMarker(projectRoot)) {
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
          if (queuePolicyErrors.length > 0) {
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
              publishVerificationContract(projectRoot, verification);
              const assignments = publishRuntimeAssignments(
                projectRoot,
                compiled,
                verification.contractHash,
              );
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(block('architecture-contract-gate',
          `Architecture contract gate: do not emit \`PLAN_READY\` until \`.traffic-one/runs/${runId || '<runId>'}/architecture-input-v1.json\` is valid and runtime compilation succeeds. ${message}. The architect may change only semantic routes/modules/exceptions; runtime owns roots, roles, outputs, baseline, and hashes.`,
          { ERROR: message }));
      }
    }
  }

  digestCompletionGates({ projectRoot, state, filePath, content, currentRunId, violations, block });

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && openCodeDelegationActive(state, host) && missingOpenCodeDelegateBlock(content) && opencodeQueueBlocks(host)) {
    violations.push(block('plan-opencode-queue-gate',
      `Plan gate: OpenCode is enabled — \`.traffic-one/plan.md\` must include the machine-readable \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` block with at least ${OPENCODE_PLAN_MIN_UNITS} runnable bounded units (\`- id: <stable-unit-id> | role: frontend|backend|tester|docs | files: … | task: …\`). Prose-only or incomplete OpenCode lists are ignored by \`opencode_delegate_from_plan\`.`));
  }

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && (currentHost === 'opencode' || currentHost === 'kilo') && hasOpenCodeDelegateMarker(content)) {
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
  architectPlanReadyOnDisk,
  isArchitectPhaseComplete,
} from './contracts';
