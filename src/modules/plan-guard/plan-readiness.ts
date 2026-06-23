// src/modules/plan-guard/plan-readiness.ts
// The project-readiness half of the plan-write gate: monorepo scaffold,
// state-file presence, materialization, and plan gates. Ported 1:1 from
// runCheckPlanWrite, minus the run-team enforcement
// gate (which lands separately). `writingFeatureSource` is precomputed by the
// caller from the feature-source helpers — this keeps the readiness logic
// independently testable. Deny PROSE comes from skill/SKILL.md via skillBlock.

import * as fs from 'fs';
import * as path from 'path';

import { isKnownStack } from '../../shared/config';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { detectMode } from '../../shared/detection';
import { packageJsonDeclaresWorkspace, stateRequiresNewProjectMonorepo } from '../../shared/hook-paths';
import { hasMaterializedProjectAssets } from '../../shared/materialize';
import { openCodeDelegationActive } from '../../shared/performance';
import { OPENCODE_PLAN_MIN_UNITS, parsePlanDelegationUnits, planDelegationUnitCount } from '../../shared/opencode-roles';
import { openCodeQueuePolicyViolations } from '../../shared/opencode-queue';
import { obj } from '../../shared/obj';
import { activeAgentRole, isMaterialized, legacyStatePath, resolveRunAgentContext, stackFingerprint, statePath } from '../../shared/state';

type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

const PLAN_FILE_RE = /(^|\/)\.traffic-one\/plan\.md$/;
const ASSIGNMENTS_FILE_RE = /(^|\/)\.traffic-one\/runs\/[^/]+\/assignments\.json$/;
const ARCHITECT_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/[^/]+\/architect\.md$/;
const ADR_OR_DOC_RE = /(^|\/)(docs|architecture|README|ADR)/i;
const ROOT_VITE_RE = /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/;
const T1_MEMORY_DIR = '.traffic' + '-one';

function exists(projectRoot: string, relPath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relPath));
}

function existsAny(projectRoot: string, relPaths: string[]): boolean {
  return relPaths.some((relPath) => exists(projectRoot, relPath));
}

function hasAnyAppPackage(projectRoot: string): boolean {
  const appsDir = path.join(projectRoot, 'apps');
  try {
    return fs.readdirSync(appsDir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && fs.existsSync(path.join(appsDir, entry.name, 'package.json')));
  } catch {
    return false;
  }
}

function packageJsonMatchesWorkspaceRoot(projectRoot: string, content: string): boolean {
  if (packageJsonDeclaresWorkspace(content)) return true;
  if (!existsAny(projectRoot, ['pnpm-workspace.yaml', 'pnpm-workspace.yml'])) return false;
  try {
    const pkg = JSON.parse(content);
    const hasPnpmPackageManager = typeof pkg?.packageManager === 'string' && /^pnpm@\d/.test(pkg.packageManager);
    return pkg?.private === true && hasPnpmPackageManager;
  } catch {
    return true;
  }
}

function rootPackageJsonMatchesWorkspaceRoot(projectRoot: string): boolean {
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    return packageJsonMatchesWorkspaceRoot(projectRoot, content);
  } catch {
    return false;
  }
}

function missingArchitectScaffold(projectRoot: string, state: Rec): string[] {
  if (!stateRequiresNewProjectMonorepo(state)) return [];
  const missing: string[] = [];
  if (!existsAny(projectRoot, ['pnpm-workspace.yaml', 'pnpm-workspace.yml'])) missing.push('pnpm-workspace.yaml');
  if (!exists(projectRoot, 'turbo.json')) missing.push('turbo.json');
  if (!exists(projectRoot, 'tsconfig.base.json')) missing.push('tsconfig.base.json');
  if (!rootPackageJsonMatchesWorkspaceRoot(projectRoot)) {
    missing.push('package.json (private + pnpm packageManager + workspace declaration)');
  }
  if (!hasAnyAppPackage(projectRoot)) missing.push('apps/<name>/package.json');
  if (!exists(projectRoot, 'packages/ui/package.json')) missing.push('packages/ui/package.json');
  if (!exists(projectRoot, 'packages/ui/src/index.ts')) missing.push('packages/ui/src/index.ts');
  if (!exists(projectRoot, 'packages/tailwind-config/package.json')) missing.push('packages/tailwind-config/package.json');
  if (!existsAny(projectRoot, ['packages/tailwind-config/index.ts', 'packages/tailwind-config/tailwind.config.ts'])) {
    missing.push('packages/tailwind-config/index.ts');
  }
  if (!exists(projectRoot, 'packages/i18n/package.json')) missing.push('packages/i18n/package.json');
  if (!exists(projectRoot, 'packages/i18n/src/index.ts')) missing.push('packages/i18n/src/index.ts');
  return missing;
}

function missingOpenCodeDelegateBlock(content: string): boolean {
  return planDelegationUnitCount(content) < OPENCODE_PLAN_MIN_UNITS;
}

function openCodeQueuePolicyErrors(content: string): string[] {
  return openCodeQueuePolicyViolations(parsePlanDelegationUnits(content));
}

function planOnDiskMissingOpenCodeBlock(projectRoot: string): boolean {
  try {
    const plan = fs.readFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), 'utf8');
    return missingOpenCodeDelegateBlock(plan);
  } catch {
    return true;
  }
}

function planOnDiskOpenCodeQueuePolicyErrors(projectRoot: string): string[] {
  try {
    const plan = fs.readFileSync(path.join(projectRoot, T1_MEMORY_DIR, 'plan.md'), 'utf8');
    return openCodeQueuePolicyErrors(plan);
  } catch {
    return [];
  }
}

function assignmentsUsesCanonicalShape(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(obj(parsed)?.assignments);
  } catch {
    return false;
  }
}

function assignmentRoleErrors(content: string): string[] {
  const allowed = new Set(['senior-frontend', 'senior-backend']);
  try {
    const parsed = obj(JSON.parse(content) as unknown);
    const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : [];
    const roles = assignments
      .map((entry) => obj(entry)?.role)
      .filter((role): role is string => typeof role === 'string' && role.trim().length > 0);
    const invalid = roles.filter((role) => !allowed.has(role));
    return invalid.length ? [`Assignments manifest may include only senior-frontend and senior-backend entries in this version; remove: ${[...new Set(invalid)].join(', ')}`] : [];
  } catch {
    return [];
  }
}

function architectPlanReadyOnDisk(projectRoot: string, state: Rec): boolean {
  const runIds: string[] = [];
  if (typeof state.currentRunId === 'string' && state.currentRunId.trim()) runIds.push(state.currentRunId.trim());
  try {
    const digestsDir = path.join(projectRoot, T1_MEMORY_DIR, 'digests');
    for (const entry of fs.readdirSync(digestsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !runIds.includes(entry.name)) runIds.push(entry.name);
    }
  } catch {
    // no digests
  }
  return runIds.some((runId) => {
    try {
      return /\bPLAN_READY\b/.test(fs.readFileSync(path.join(projectRoot, T1_MEMORY_DIR, 'digests', runId, 'architect.md'), 'utf8'));
    } catch {
      return false;
    }
  });
}

function assignmentWriterRole(projectRoot: string, state: Rec, rawData: unknown): string | null {
  const ctx = rawData ? resolveRunAgentContext(projectRoot, state, rawData, { claimPending: false }) : null;
  return (ctx && typeof ctx.role === 'string' ? ctx.role : null) || activeAgentRole(state);
}

export interface ReadinessArgs {
  filePath: string;          // project-relative target path
  content: string;           // write content (Write.content / Edit.new_string)
  projectRoot: string;       // resolved project root for the target
  state: Rec;                // readEffectiveState(projectRoot)
  writingFeatureSource: boolean;
  rawData?: unknown;
  block: Block;
}

// Readiness violations for a single write/edit. Empty array == nothing to block.
export function planReadinessViolations(args: ReadinessArgs): string[] {
  const { filePath, content, projectRoot, state, writingFeatureSource, rawData, block } = args;
  const violations: string[] = [];

  const requiresMonorepoScaffold = stateRequiresNewProjectMonorepo(state);

  if (requiresMonorepoScaffold && filePath === 'package.json' && !packageJsonMatchesWorkspaceRoot(projectRoot, content)) {
    violations.push(block('monorepo-package-json',
      'New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: `private: true`, `packageManager: pnpm@...`, and a workspace declaration (`pnpm-workspace.yaml` or package.json `workspaces`) for `apps/*` and `packages/*`. Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.'));
  }

  if (requiresMonorepoScaffold && ROOT_VITE_RE.test(filePath)) {
    violations.push(block('monorepo-root-vite',
      'New-project monorepo gate: root Vite app files are not allowed for this stack. Use `apps/web/` for the React app and create the required `packages/*` workspaces first; see `rules/modes/new-project.md`.'));
  }

  if (ARCHITECT_DIGEST_RE.test(filePath) && /\bPLAN_READY\b/.test(content)) {
    const missing = missingArchitectScaffold(projectRoot, state);
    if (missing.length > 0) {
      violations.push(block('architect-scaffold-gate',
        `Architect completion gate: do not write \`PLAN_READY\` until the required Traffic One workspace scaffold exists. Missing: ${missing.join(', ')}. Write the missing baseline files, then update \`.traffic-one/digests/<runId>/architect.md\` and only then emit \`PLAN_READY\`.`,
        { MISSING: missing.join(', ') }));
    }
    if (state.mode === 'new-project' && openCodeDelegationActive(state) && planOnDiskMissingOpenCodeBlock(projectRoot)) {
      violations.push(block('architect-opencode-queue-gate',
        `Architect completion gate: OpenCode is enabled but \`.traffic-one/plan.md\` is missing at least ${OPENCODE_PLAN_MIN_UNITS} runnable machine-readable delegation units. Include \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` with 3–6 bounded units (\`- role: … | files: … | task: …\`) before emitting \`PLAN_READY\`. The orchestrator runs \`opencode_delegate_from_plan\` from that block BEFORE spawning implementers.`));
    }
  }

  if (ARCHITECT_DIGEST_RE.test(filePath) && /\bPLAN_READY\b/.test(content) && state.mode === 'new-project' && openCodeDelegationActive(state) && !planOnDiskMissingOpenCodeBlock(projectRoot)) {
    const policyErrors = planOnDiskOpenCodeQueuePolicyErrors(projectRoot);
    if (policyErrors.length > 0) {
      violations.push(block('architect-opencode-queue-policy-gate',
        `Architect completion gate: OpenCode queue metadata is unsafe: ${policyErrors.join('; ')}. Add stable unique ids, exact files allowlists, and depends edges for overlapping areas before emitting \`PLAN_READY\`.`,
        { ERRORS: policyErrors.join('; ') }));
    }
  }

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && openCodeDelegationActive(state) && missingOpenCodeDelegateBlock(content)) {
    violations.push(block('plan-opencode-queue-gate',
      `Plan gate: OpenCode is enabled — \`.traffic-one/plan.md\` must include the machine-readable \`<!-- opencode-delegate:start -->\` … \`<!-- opencode-delegate:end -->\` block with at least ${OPENCODE_PLAN_MIN_UNITS} runnable bounded units (\`- role: frontend|backend|tester|docs | files: … | task: …\`). Prose-only or incomplete OpenCode lists are ignored by \`opencode_delegate_from_plan\`.`));
  }

  if (PLAN_FILE_RE.test(filePath) && state.mode === 'new-project' && openCodeDelegationActive(state) && !missingOpenCodeDelegateBlock(content)) {
    const policyErrors = openCodeQueuePolicyErrors(content);
    if (policyErrors.length > 0) {
      violations.push(block('plan-opencode-queue-policy-gate',
        `Plan gate: OpenCode queue metadata is unsafe: ${policyErrors.join('; ')}. Add stable unique ids, exact files allowlists, and depends edges for overlapping areas.`,
        { ERRORS: policyErrors.join('; ') }));
    }
  }

  if (ASSIGNMENTS_FILE_RE.test(filePath) && state.mode === 'new-project' && !assignmentsUsesCanonicalShape(content)) {
    violations.push(block('assignments-shape-gate',
      'Assignments gate: `.traffic-one/runs/<runId>/assignments.json` must use the canonical shape with a top-level `assignments` ARRAY of `{ role, scope: { include, exclude? } }` entries — not a `roles` object or `ownedPaths` fields. See `agents/senior-architect.md` § Assignments manifest.'));
  }

  if (ASSIGNMENTS_FILE_RE.test(filePath) && state.mode === 'new-project' && assignmentsUsesCanonicalShape(content)) {
    const roleErrors = assignmentRoleErrors(content);
    if (roleErrors.length > 0) {
      violations.push(block('assignments-roles-gate',
        roleErrors.join('; '),
        { ERRORS: roleErrors.join('; ') }));
    }
    const writerRole = assignmentWriterRole(projectRoot, state, rawData);
    if (writerRole && writerRole !== 'senior-architect' && architectPlanReadyOnDisk(projectRoot, state)) {
      violations.push(block('assignments-owner-gate',
        `Assignments gate: \`.traffic-one/runs/<runId>/assignments.json\` is architect/orchestrator-owned and must not be changed by \`${writerRole}\` after \`PLAN_READY\`. Surface the needed scope change in the role digest instead.`,
        { ROLE: writerRole }));
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
      `Materialization gate: stack context for ${stackFingerprint(state)} has not been materialized on disk yet. Run \`node "\${TRAFFIC_ONE_PLUGIN_ROOT:-\${CURSOR_PLUGIN_ROOT:-\${CODEX_PLUGIN_ROOT:-\${CLAUDE_PLUGIN_ROOT:-.}}}}/scripts/hook-runtime.cjs" materialize-project\` from the project root and verify \`.traffic-one/rules/**\`, \`.traffic-one/skills/**\`, \`.traffic-one/manifest.json\`, root \`AGENTS.md\`, and root \`CLAUDE.md\` exist before writing feature source.`,
      { FINGERPRINT: stackFingerprint(state) }));
  }

  const isNewProject = state.mode === 'new-project';
  const planMissing = !fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'));
  const writingPlan = PLAN_FILE_RE.test(filePath);
  const writingDoc = ADR_OR_DOC_RE.test(filePath);

  if (isNewProject && planMissing && writingFeatureSource && !writingPlan && !writingDoc) {
    violations.push(block('plan-gate',
      'Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
  }

  return violations;
}
