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
import { isMaterialized, legacyStatePath, stackFingerprint, statePath } from '../../shared/state';

type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

const PLAN_FILE_RE = /(^|\/)\.traffic-one\/plan\.md$/;
const ARCHITECT_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/[^/]+\/architect\.md$/;
const ADR_OR_DOC_RE = /(^|\/)(docs|architecture|README|ADR)/i;
const ROOT_VITE_RE = /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/;

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

export interface ReadinessArgs {
  filePath: string;          // project-relative target path
  content: string;           // write content (Write.content / Edit.new_string)
  projectRoot: string;       // resolved project root for the target
  state: Rec;                // readEffectiveState(projectRoot)
  writingFeatureSource: boolean;
  block: Block;
}

// Readiness violations for a single write/edit. Empty array == nothing to block.
export function planReadinessViolations(args: ReadinessArgs): string[] {
  const { filePath, content, projectRoot, state, writingFeatureSource, block } = args;
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
