'use strict';

// scripts/hook-runtime/handlers/gates.cjs
// PreToolUse gate handlers: the new-project onboarding gate, the per-agent
// performance-model gate, the architecture write/edit guard, and the library
// allowlist + deploy gate. Also the forbidden-library table (forbiddenForStack)
// shared with the allowlist gate. Function bodies are moved verbatim from the
// original single-file handlers.cjs.

const {
  fs,
  path,
  spawn,
  parseJsonText,
  safeReadJson,
  readState,
  statePath,
  legacyStatePath,
  writeState,
  normalizeState,
  detectMode,
  pluginRoot,
  isKnownStack,
  isNativeState,
  isWebState,
  isPluginAuthoringRoot,
  isMaterialized,
  hasMaterializedProjectAssets,
  stackFingerprint,
  stateRequiresNewProjectMonorepo,
  findProjectRootForHookFile,
  projectRelativeHookPath,
  packageJsonDeclaresWorkspace,
  normalizedToolName,
  isShellToolName,
  isStateFilePath,
  isStateFileOnlyPatch,
  commandFromToolInput,
  commandAppearsToWriteFeatureSource,
  applyPatchTargetPaths,
  isMutatingPreToolUse,
  isReadOnlyOrientationToolUse,
  isNewProjectOnboardingIncomplete,
  repairNewProjectOnboardingState,
  repairedMaterializationDenyReason,
  materializeProjectIfNeeded,
  isCompletedTrafficOneMaterialization,
  needsTeamConfirmation,
  onboardingGateFallbackReason,
  teamConfirmationGateFallbackReason,
  teamConfirmationPromptRequest,
  nextOnboardingPromptRequest,
  teamModeApprovalMarkerWriteGuard,
  teamModeDowngradeGuard,
  denyPreToolUse,
  agentMaterializationDenyReason,
  agentMaterializationMissingReason,
  roleCanWriteFeatureSource,
  subagentMayWriteFeatureSource,
  activeAgentRole,
  isSubagentSession,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
  ensureRunAgentClaim,
  VALID_AGENT_ROLES,
  PERFORMANCE_LEVEL_IDS,
  isTeamApproved,
  teamModeForLevel,
  modelForRoleHost,
  loadPackageJson,
  dependenciesFromPackage,
  computeProjectFingerprint,
} = require('./_helpers.cjs');

const { authPreToolGate } = require('./auth.cjs');

// ── PreToolUse: new-project onboarding gate ──────────────────────────────────
function runCheckOnboardingGate(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const cwd = process.cwd();
  if (isPluginAuthoringRoot(cwd)) return { stdout: '', exitCode: 0 };
  const authGate = authPreToolGate(toolName, toolInput);
  if (authGate) return authGate;

  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  const state = readState(cwd);
  const mode = state.mode || detectMode(cwd);
  const effectiveState = {
    ...state,
    mode,
  };
  normalizeState(effectiveState, mode);

  const teamModeApprovalMarkerGuard = teamModeApprovalMarkerWriteGuard(cwd, toolName, toolInput);
  if (teamModeApprovalMarkerGuard) return teamModeApprovalMarkerGuard;

  const teamModeGuard = teamModeDowngradeGuard(cwd, toolName, toolInput, effectiveState);
  if (teamModeGuard) return teamModeGuard;

  if (isStateFilePath(filePath) || isStateFileOnlyPatch(toolName, toolInput)) {
    return { stdout: '', exitCode: 0 };
  }

  if (mode === 'new-project' && isNewProjectOnboardingIncomplete(effectiveState)) {
    const repaired = repairNewProjectOnboardingState(cwd, effectiveState, 'generic pre-tool onboarding repair');
    if (repaired) {
      if (isMutatingPreToolUse(toolName, toolInput)) {
        return denyPreToolUse(repairedMaterializationDenyReason());
      }
      return repaired;
    }
    // Allow read-only orientation (pwd, ls, Read, Glob, Grep) while onboarding
    // is incomplete so the agent can locate its cwd and write
    // `.traffic-one/.one.json` to the right place. Mutating tools, agent spawns, and
    // installs fall through to the deny below.
    if (isReadOnlyOrientationToolUse(toolName, toolInput)) {
      return { stdout: '', exitCode: 0 };
    }
    if (needsTeamConfirmation(effectiveState)) {
      const reason = teamConfirmationGateFallbackReason(effectiveState);
      return denyPreToolUse(reason, teamConfirmationPromptRequest(effectiveState, reason));
    }
    const reason = onboardingGateFallbackReason(effectiveState);
    return denyPreToolUse(reason, nextOnboardingPromptRequest(effectiveState, 'gate'));
  }

  const materialized = materializeProjectIfNeeded(cwd, 'generic pre-tool convergence');
  if (materialized && materialized.stdout) {
    if (isMutatingPreToolUse(toolName, toolInput)) {
      return denyPreToolUse(repairedMaterializationDenyReason());
    }
    return materialized;
  }

  return { stdout: '', exitCode: 0 };
}

// ── PreToolUse(Task): enforce per-agent model for the performance level ──────
// The subagent model is set ONLY by the spawn tool's `model` parameter; the
// model directive in prompt text has no effect, so without this gate Balanced/
// High silently inherit the parent model. We block a Traffic One role spawn
// when the `model` param is missing/wrong for the role's tier.
function detectHookHost() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude';
  if (process.env.CODEX_PLUGIN_ROOT) return 'codex';
  if (process.env.CURSOR_PLUGIN_ROOT) return 'cursor';
  const root = pluginRoot();
  if (root.includes(`${path.sep}.codex${path.sep}`)) return 'codex';
  if (root.includes(`${path.sep}.cursor${path.sep}`)) return 'cursor';
  return 'claude';
}

function normalizeSubagentRole(subagentType) {
  if (typeof subagentType !== 'string' || !subagentType) return null;
  const role = subagentType.includes(':') ? subagentType.split(':').pop() : subagentType;
  return VALID_AGENT_ROLES.has(role) ? role : null;
}

function inferTrafficOneSpawnRole(toolInput) {
  const direct = normalizeSubagentRole(
    toolInput.subagent_type
    || toolInput.subagentType
    || toolInput.agent
    || toolInput.role
    || toolInput.type,
  );
  if (direct) return direct;

  const message = [
    toolInput.message,
    toolInput.prompt,
    toolInput.instructions,
    toolInput.description,
  ].filter((value) => typeof value === 'string').join('\n');
  if (!/\bTraffic One\b/i.test(message)) return null;

  const matches = Array.from(VALID_AGENT_ROLES)
    .filter((role) => new RegExp(`\\b${role}\\b`, 'i').test(message));
  return matches.length === 1 ? matches[0] : null;
}

function runCheckAgentModel(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const authGate = authPreToolGate(toolName, toolInput);
  if (authGate) return authGate;

  if (toolName && !/^(Task|Agent|spawn_agent)$/i.test(String(toolName))) {
    return { stdout: '', exitCode: 0 };
  }

  const role = inferTrafficOneSpawnRole(toolInput);
  if (!role) {
    return { stdout: '', exitCode: 0 }; // not a Traffic One role spawn
  }

  const cwd = process.cwd();
  const state = readState(cwd);
  if (!state || typeof state !== 'object') return { stdout: '', exitCode: 0 };

  // Onboarding-only: enforce the performance-level model just for the first
  // new-project build. Once the project is established, manual agent spawns are
  // never gated.
  if (state.mode !== 'new-project') return { stdout: '', exitCode: 0 };

  if (!isCompletedTrafficOneMaterialization(cwd, state)) {
    materializeProjectIfNeeded(cwd, 'agent spawn preflight convergence');
    const refreshed = readState(cwd);
    if (isCompletedTrafficOneMaterialization(cwd, refreshed)) {
      return denyPreToolUse(agentMaterializationDenyReason());
    }
    return denyPreToolUse(agentMaterializationMissingReason());
  }

  const performance = state.performance && typeof state.performance === 'object' ? state.performance : null;
  const level = performance && PERFORMANCE_LEVEL_IDS.has(performance.level) ? performance.level : null;
  if (!level) return { stdout: '', exitCode: 0 }; // no level recorded → can't enforce

  // Low: the team runs in-thread, not as spawned subagents. Spawning a role
  // subagent contradicts the recorded level — usually the level was mis-recorded
  // (e.g. user picked Balanced but state says low). Block and ask to fix first.
  if (teamModeForLevel(level) === 'main-agent') {
    return denyPreToolUse(
      `Performance gate: \`.traffic-one/.one.json\` records performance.level="${level}" (main-agent only), but you are spawning the \`${role}\` subagent. `
      + 'If the user chose Balanced or High, first correct `.traffic-one/.one.json` (`performance.level` plus matching `team.mode="subagents"`) so the right model tier applies, then re-spawn passing the `model` parameter. '
      + 'If the user really chose Low, do NOT spawn subagents — run the roles in this thread as the role roadmap checklist.',
    );
  }

  // Team Confirmation gate: for balanced/high, the user MUST have
  // explicitly approved the team line-up by clicking Approve in popup 2,
  // which writes `team.approved: true`. This denial is the teeth that
  // prevents the orchestrator from skipping confirmation with "I'll auto-approve
  // the default".
  if (!isTeamApproved(state.team)) {
    return denyPreToolUse(
      `Team Confirmation gate: performance.level="${level}" requires the user to explicitly approve the subagent role/model line-up before ANY subagent can be spawned. `
      + '`.traffic-one/.one.json` currently has `team.approved !== true`, so the user has not yet confirmed. '
      + 'Ask the host popup tool (Codex `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI) with header "Team", question "Here is the subagent team for ' + level + ' mode — approve or change?", body containing the role→tier→model line-up (use `tierModelTable` from `model-tiers.cjs`), and options "Approve" / "Re-pick performance" / "Customise". '
      + 'When the user replies "Approve", re-write `.traffic-one/.one.json` with `team.approved: true` (and any `team.overrides` collected), then re-spawn. '
      + 'If subagents or popup confirmation are genuinely unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting `.traffic-one/.one.json`; do not bypass this gate for `team.mode="subagents"`.',
    );
  }

  // Balanced / High: the spawn MUST pass the model param for the role's tier.
  const host = detectHookHost();
  const overrides = state.team && typeof state.team === 'object' && state.team.overrides && typeof state.team.overrides === 'object'
    ? state.team.overrides
    : null;
  const expected = modelForRoleHost(level, role, host, overrides);
  if (!expected) return { stdout: '', exitCode: 0 };

  const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
  if (passedModel !== expected) {
    return denyPreToolUse(
      `Performance gate (level=${level}, host=${host}): spawning \`${role}\` requires the \`model\` tool parameter set to "${expected}". `
      + (passedModel
        ? `You passed model="${passedModel}". `
        : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ')
      + `Re-issue the spawn with \`model: "${expected}"\`. The model is set ONLY by this parameter — a model name in the prompt text has no effect. `
      + 'Per-role model tiers live in `performance-config.cjs` / `model-tiers.cjs`.',
    );
  }

  ensureRunAgentClaim(cwd, state, role, data, {
    toolName,
    agentType: toolInput.agent_type || toolInput.agentType || toolInput.subagent_type || toolInput.type || null,
    model: passedModel,
  });

  return { stdout: '', exitCode: 0 };
}

// ── PreToolUse: architecture write/edit guard ────────────────────────────────
function readStack() {
  const state = readState(process.cwd());
  return typeof state.stack === 'string' ? state.stack : null;
}

function runCheckArchitectureWrite(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const toolName = data.tool_name || data.toolName || 'Bash';
  const authGate = authPreToolGate(toolName, toolInput);
  if (authGate) return authGate;

  const rawFilePath = (typeof toolInput.file_path === 'string' ? toolInput.file_path : '').replace(/\\/g, '/');
  const rawCommand = commandFromToolInput(toolInput);
  const patchTargetPaths = normalizedToolName(toolName) === 'apply_patch'
    ? applyPatchTargetPaths(rawCommand)
    : [];
  const cwd = process.cwd();
  const projectRoot = findProjectRootForHookFile(cwd, rawFilePath || patchTargetPaths[0] || '');
  const filePath = projectRelativeHookPath(cwd, projectRoot, rawFilePath);
  materializeProjectIfNeeded(projectRoot, 'architecture preflight convergence');
  const content =
    typeof toolInput.content === 'string'
      ? toolInput.content
      : typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : '';
  const stateForArchitecture = readState(projectRoot);
  const isNative = isNativeState(stateForArchitecture);
  const violations = [];

  // Plan gate: on a new project, deny feature-source writes until the architect
  // has produced .traffic-one/plan.md. The plan file itself, .traffic-one/
  // project memory, root docs, ADRs, and legacy docs/ are exempt so the
  // architect can write the plan without self-blocking.
  const FEATURE_SOURCE_RE = /^(apps\/[^/]+\/(src|app)\/|packages\/[^/]+\/src\/|src\/|services\/[^/]+\/src\/)/;
  const PLAN_FILE_RE      = /(^|\/)\.traffic-one\/plan\.md$/;
  const ADR_OR_DOC_RE     = /(^|\/)(docs|architecture|README|ADR)/i;

  const stateForPlan      = stateForArchitecture;
  const stateMissing      = !fs.existsSync(statePath(projectRoot))
    && !fs.existsSync(legacyStatePath(projectRoot));
  const validStateStack   = stateForPlan.stack && isKnownStack(stateForPlan.stack);
  const memoryPresent     = fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'))
    || fs.existsSync(path.join(projectRoot, '.traffic-one', 'stack.md'));
  const detectedModeForState = stateForPlan.mode || (stateMissing ? detectMode(projectRoot) : null);
  const isNewProject      = stateForPlan.mode === 'new-project';
  const planAbsPath       = path.join(projectRoot, '.traffic-one', 'plan.md');
  const planMissing       = !fs.existsSync(planAbsPath);
  const writingPlan       = PLAN_FILE_RE.test(filePath);
  const writingDoc        = ADR_OR_DOC_RE.test(filePath);
  const featureTargetPaths = [];
  if (FEATURE_SOURCE_RE.test(filePath)) {
    featureTargetPaths.push(filePath);
  }
  for (const targetPath of patchTargetPaths) {
    const relativePath = projectRelativeHookPath(cwd, projectRoot, targetPath);
    if (FEATURE_SOURCE_RE.test(relativePath) && !featureTargetPaths.includes(relativePath)) {
      featureTargetPaths.push(relativePath);
    }
  }
  const writingFeatureSourceViaCommand = isShellToolName(toolName) && commandAppearsToWriteFeatureSource(rawCommand);
  const writingFeatureSource = featureTargetPaths.length > 0 || writingFeatureSourceViaCommand;
  const requiresMonorepoScaffold = stateRequiresNewProjectMonorepo(stateForPlan);

  if (
    requiresMonorepoScaffold
    && filePath === 'package.json'
    && !packageJsonDeclaresWorkspace(content)
  ) {
    violations.push(
      'New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: '
      + '`private: true`, `packageManager: pnpm@...`, and workspaces for `apps/*` and `packages/*`. '
      + 'Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.'
    );
  }

  if (
    requiresMonorepoScaffold
    && /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/.test(filePath)
  ) {
    violations.push(
      'New-project monorepo gate: root Vite app files are not allowed for this stack. '
      + 'Use `apps/web/` for the React app and create the required `packages/*` workspaces first; '
      + 'see `rules/modes/new-project.md`.'
    );
  }

  if (
    writingFeatureSource
    && !validStateStack
    && (detectedModeForState === 'new-project' || memoryPresent)
  ) {
    violations.push(
      'State gate: root .traffic-one/.one.json is missing or incomplete. Write the '
      + 'Traffic One state file with mode, stack, backend, realtime, confirmed, '
      + 'onboardingComplete, and confirmedAt before writing feature source. '
      + 'The .traffic-one/ folder is project memory, not the stack-selection '
      + 'state file.'
    );
  }

  // Materialization gate: block feature writes until the SessionStart hook has
  // copied the correct rules and skills to .traffic-one/ for this stack.
  // This ensures the model has full quality/performance context before implementing.
  const hasMaterializedAssets = hasMaterializedProjectAssets(projectRoot, stateForPlan);
  const featureContextMaterialized = isPluginAuthoringRoot(projectRoot)
    || !stateForPlan.onboardingComplete
    || (isMaterialized(stateForPlan) && hasMaterializedAssets);

  if (writingFeatureSource && !featureContextMaterialized) {
    violations.push(
      `Materialization gate: stack context for ${stackFingerprint(stateForPlan)} has not been materialized on disk yet. `
      + 'Run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project` '
      + 'from the project root and verify `.traffic-one/rules/**`, `.traffic-one/skills/**`, '
      + '`.traffic-one/manifest.json`, root `AGENTS.md`, and root `CLAUDE.md` exist before writing feature source.'
    );
  }

  const agentContext = resolveRunAgentContext(projectRoot, stateForPlan, data, { claimPending: true })
    || (!hasRunAgentState(projectRoot, stateForPlan) ? legacyRunAgentContext(stateForPlan) : null);
  const ownershipTargets = featureTargetPaths.length > 0 ? featureTargetPaths : [filePath];
  const useLegacySubagentFallback = !agentContext && !hasRunAgentState(projectRoot, stateForPlan);
  const agentMayWriteFeatureTargets = featureTargetPaths.length > 0
    ? featureTargetPaths.every((targetPath) => (
      agentContext
        ? subagentMayWriteFeatureSource(stateForPlan, targetPath, agentContext)
        : useLegacySubagentFallback && subagentMayWriteFeatureSource(stateForPlan, targetPath, null)
    ))
    : agentContext
      ? subagentMayWriteFeatureSource(stateForPlan, filePath, agentContext)
      : useLegacySubagentFallback && subagentMayWriteFeatureSource(stateForPlan, filePath, null);

  if (
    writingFeatureSource
    && stateForPlan.team
    && stateForPlan.team.mode === 'subagents'
    && (
      !agentMayWriteFeatureTargets
      || writingFeatureSourceViaCommand
    )
  ) {
    const role = (agentContext && agentContext.role) || activeAgentRole(stateForPlan) || 'main agent';
    const inSubagent = Boolean(agentContext) || (!hasRunAgentState(projectRoot, stateForPlan) && isSubagentSession(stateForPlan));
    const ownedBySome = ownershipTargets.every((targetPath) => (
      roleCanWriteFeatureSource('senior-frontend', targetPath)
      || roleCanWriteFeatureSource('senior-backend', targetPath)
    ));
    const ownedByActiveRole = agentContext && ownershipTargets.every((targetPath) => (
      roleCanWriteFeatureSource(agentContext.role, targetPath)
    ));
    let reason;
    if (writingFeatureSourceViaCommand) {
      reason = 'Run-team enforcement gate: feature-source writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python`, `node`, `perl`, `sed -i`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead.';
    } else if (!inSubagent) {
      reason = `Run-team enforcement gate: this project was onboarded with \`team.mode="subagents"\`, so feature-source writes must come from a spawned Traffic One role session with a per-agent run claim, not ${role}. Spawn the appropriate role first; senior-frontend and senior-backend ownership is enforced by \`roleCanWriteFeatureSource\`.`;
    } else if (!ownedBySome) {
      reason = `Run-team enforcement gate: the file \`${filePath}\` is not under any Traffic One role's owned path patterns (senior-frontend: \`apps/*/src|app/\` + \`packages/(ui|i18n|utils)/src/\`; senior-backend: \`packages/(api-client|ws-client|utils)/src/\`, \`services/*/src/\`, \`apps/*/src/(services|store)/\`). If this is a legitimate project layout (e.g. root \`src/\`), the role-pattern definitions in \`roleCanWriteFeatureSource\` need to be extended.`;
    } else if (agentContext && !ownedByActiveRole) {
      reason = `Run-team enforcement gate: the active Traffic One role \`${role}\` does not own \`${ownershipTargets.join(', ')}\`. Use the role that owns the path, or split the patch by role ownership.`;
    } else {
      // Should not reach: subagentMayWriteFeatureSource would have returned true.
      reason = `Run-team enforcement gate: unexpected denial for ${role} writing \`${filePath}\`. This is a gate bug — please report.`;
    }
    reason += ' If subagents are genuinely unavailable or the user changes their mind, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting `.traffic-one/.one.json`; `team.source="unavailable"` does not bypass `team.mode="subagents"`.';
    violations.push(reason);
  }

  if (
    isNewProject
    && planMissing
    && writingFeatureSource
    && !writingPlan
    && !writingDoc
  ) {
    violations.push(
      'Plan gate: .traffic-one/plan.md is missing on a new project. Run the '
      + '`senior-architect` subagent (or the `senior-eng-orchestrator` skill) '
      + 'to produce the plan before writing feature source files. Allowed '
      + 'without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'
    );
  }

  if (/(apps\/[^/]+\/)?src\/pages\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
    violations.push('Service/store/hook/slice files belong in src/services/, src/features/<name>/, or packages/* — not in src/pages/.');
  }

  if (/(apps\/[^/]+\/)?app\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
    violations.push('Expo Router route files must stay thin. Service/store/hook/slice files belong in src/features/, src/services/, or packages/*.');
  }

  if (/(apps\/[^/]+\/)?src\/[A-Z][a-zA-Z]+\.(tsx|ts)$/.test(filePath)) {
    const target = isNative
      ? 'src/components/, src/features/<name>/components/, or packages/ui-native/*'
      : 'src/components/, src/features/<name>/components/, or packages/ui/*';
    violations.push(`Components must live in ${target} — not directly in src/.`);
  }

  const featureMatch = filePath.match(/src\/features\/([^/]+)/);
  if (featureMatch) {
    const current = featureMatch[1];
    const cross = Array.from(content.matchAll(/from ['"]@\/features\/([^/'"]+)/g))
      .map((match) => match[1])
      .filter((feature) => feature !== current);
    if (cross.length > 0) {
      violations.push(`Cross-feature import detected (${current} -> ${cross}). Share via packages/ui, packages/ui-native, packages/utils, or a feature-agnostic store slice.`);
    }
  }

  if (/from ['"]\.\.\/\.\.\/\.\.\/packages\//.test(content)) {
    violations.push('Use the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) instead of a deep relative path across packages.');
  }

  if (
    filePath.endsWith('.tsx') &&
    /(src|packages\/(ui|ui-native))\/(components|features|pages)\//.test(filePath) &&
    /^export default /m.test(content)
  ) {
    violations.push('Use named exports only for reusable components. Expo Router route files under app/ are the default-export exception.');
  }

  if (isNative) {
    if (filePath.endsWith('.tsx') && content.includes('style={{')) {
      violations.push('No inline object styles — use NativeWind `className` for static styles. `StyleSheet.create` is reserved for dynamic/animated values.');
    }
    if (filePath.endsWith('.tsx') && /\b(div|span|button|a|input)\b/.test(content)) {
      violations.push('React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.');
    }
  } else {
    if (filePath.endsWith('.tsx') && content.includes('style={{')) {
      violations.push('No inline styles — use Tailwind utility `className` and shadcn primitives. Inline `style={{}}` is reserved for dynamic/derived values.');
    }
    if (
      (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) &&
      /from ['"]@vanilla-extract\//.test(content)
    ) {
      violations.push('vanilla-extract is no longer in the active stack. Use Tailwind utility classes and shadcn primitives in `packages/ui/src/components/ui/`.');
    }
    if (
      (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) &&
      /from ['"][^'"]+\.css\.ts['"]/.test(content)
    ) {
      violations.push('`.css.ts` (vanilla-extract) imports are no longer permitted. Use Tailwind utility classes; theme via the HSL CSS variables in `globals.css`.');
    }
  }

  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && /:\s*any\b/.test(content)) {
    violations.push('Avoid `any` — use `unknown` and narrow types, or define a discriminated union.');
  }

  const allowedWsPaths = /(packages\/ws-client|src\/services\/ws)/;
  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && content.includes('new WebSocket(') && !allowedWsPaths.test(filePath)) {
    violations.push('Open WebSocket connections only inside packages/ws-client/ or src/services/ws/. Components must subscribe via hooks.');
  }

  if (violations.length === 0) {
    return { stdout: '', exitCode: 0 };
  }

  const reason = `traffic-one — architecture violation(s):\n${violations.map((violation) => `  - ${violation}`).join('\n')}`;
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

// ── PreToolUse: library allowlist (Bash install commands) ────────────────────
const INSTALL_RE = /(npm (install|i|add)|yarn add|pnpm add|bun add)/;

function packageJsonHasNext() {
  const pkg  = loadPackageJson(process.cwd());
  const deps = dependenciesFromPackage(pkg);
  return Boolean(deps.next);
}

function allowsNextjs(state) {
  return state.frontend === 'nextjs' || packageJsonHasNext();
}

function stateFromStackForAllowlist(stackOrState) {
  if (stackOrState && typeof stackOrState === 'object') return stackOrState;
  const stack = typeof stackOrState === 'string' ? stackOrState : null;
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return { stack, frontend: 'none', backend: 'supabase', mobile: { enabled: true, framework: 'react-native-expo' } };
  }
  if (stack === 'react-realtime-monorepo' || stack === 'react-frontend-only' || stack === 'default' || stack === 'custom-backend') {
    return { stack, frontend: 'react-vite', backend: stack === 'react-frontend-only' ? 'none' : 'supabase', mobile: { enabled: false, framework: 'none' } };
  }
  return { stack, frontend: 'none', backend: 'none', mobile: { enabled: false, framework: 'none' } };
}

function forbiddenForStack(stackOrState, allowNextjs) {
  const state = stateFromStackForAllowlist(stackOrState);
  const common = [
    ['mobx', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['recoil', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['jotai', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['swr', 'Use RTK Query for cached server state.'],
    ['(?<!tanstack/)(?<!\\w)react-query(?!-)', 'Use RTK Query for cached server state.'],
  ];
  const web = [
    ['vitest', 'This stack uses Jest for unit/integration tests.'],
    ['@vitest/', 'This stack uses Jest for unit/integration tests.'],
    ['styled-components', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@emotion', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@vanilla-extract/', 'vanilla-extract is no longer in the active stack. Use Tailwind + shadcn (run `npx shadcn@latest add <name>`).'],
    ['nativewind', 'NativeWind is the React Native styling layer; the web stack uses plain Tailwind.'],
    ['@mui/', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['antd', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['material-ui', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['chakra-ui', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['bootstrap', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
  ];

  if (!allowNextjs) {
    web.push([
      '(^|\\s)(next|next-auth)(@[\\w.-]+)?(\\s|$)',
      'Use the React/Vite stack unless the user explicitly chose Next.js; Next.js auth uses NextAuth/Auth.js only in a Next.js project.',
    ]);
  }

  const native = [
    ['vitest', 'This stack uses Jest for unit/integration tests.'],
    ['@vitest/', 'This stack uses Jest for unit/integration tests.'],
    ['styled-components', 'Use NativeWind `className` with React Native Reusables primitives in packages/ui-native.'],
    ['@emotion', 'Use NativeWind `className` with React Native Reusables primitives in packages/ui-native.'],
    ['@vanilla-extract/', 'vanilla-extract is web-only and no longer used. The Expo stack uses NativeWind + React Native Reusables.'],
    ['react-router-dom', 'Use Expo Router for React Native navigation.'],
    ['framer-motion', 'Use react-native-reanimated for React Native animations.'],
    ['@mui/', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['antd', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['material-ui', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['chakra-ui', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['bootstrap', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
  ];

  if (isNativeState(state)) {
    return [...common, ...native];
  }
  if (isWebState(state) || state.stack === null) {
    const webRules = state.frontend === 'nextjs'
      ? web.filter(([pattern]) => pattern !== 'vitest' && pattern !== '@vitest/')
      : web;
    return [...common, ...webRules];
  }
  return common;
}

// Deploy gate: production-publishing commands need a fresh shipper-approval
// stamp in .traffic-one/.one.json (written by the senior-shipper subagent during
// pre-flight). Without the stamp, deny — forces the orchestrator → shipper
// flow rather than ad-hoc deploys.
const DEPLOY_RE = /(^|[\s;&|])(vercel\s+(deploy|--prod)|eas\s+build\s+.*--auto-submit|eas\s+submit|supabase\s+db\s+push\s+--linked|supabase\s+functions\s+deploy\s+\S+\s+--linked|gh\s+release\s+create|fly\s+deploy|wrangler\s+deploy|npm\s+publish|pnpm\s+publish)\b/;
const SHIPPER_APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_CHECK_WINDOW_MS = 10 * 60 * 1000;

function checkSecurityDeployStamp(stateForDeploy, cwd) {
  const status = stateForDeploy.lastSecurityCheckStatus;
  const checkedAt = typeof stateForDeploy.lastSecurityCheckAt === 'string'
    ? Date.parse(stateForDeploy.lastSecurityCheckAt)
    : 0;
  const fresh = checkedAt > 0 && (Date.now() - checkedAt) < SECURITY_CHECK_WINDOW_MS;
  if (status !== 'passed' || !fresh) {
    return {
      ok: false,
      reason: 'Deploy gate: the Traffic One pre-deployment security check has not passed in the last 10 minutes. Run '
        + '`node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/security-check-runner.cjs" --strict --stamp` '
        + 'from the project root, address any findings, then deploy through `senior-shipper`.',
    };
  }

  let current;
  try {
    current = computeProjectFingerprint(cwd).fingerprint;
  } catch (error) {
    return {
      ok: false,
      reason: `Deploy gate: could not compute the current security fingerprint: ${error.message}`,
    };
  }

  if (stateForDeploy.lastSecurityCheckFingerprint !== current) {
    return {
      ok: false,
      reason: 'Deploy gate: the worktree changed after the last passing security check. Rerun '
        + '`node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/security-check-runner.cjs" --strict --stamp` '
        + 'so the security fingerprint matches the code being deployed.',
    };
  }

  return { ok: true };
}

function runCheckLibraryAllowlist(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const authGate = authPreToolGate(data.tool_name || data.toolName || 'Bash', toolInput);
  if (authGate) return authGate;

  const command  = commandFromToolInput(toolInput);

  // Deploy gate runs first — production publishes are gated regardless of
  // whether the command also matches an install regex.
  if (DEPLOY_RE.test(command)) {
    const stateForDeploy = readState(process.cwd());
    const approvedAt = typeof stateForDeploy.lastShipperApprovalAt === 'string'
      ? Date.parse(stateForDeploy.lastShipperApprovalAt)
      : 0;
    const fresh = approvedAt > 0 && (Date.now() - approvedAt) < SHIPPER_APPROVAL_WINDOW_MS;
    if (!fresh) {
      const reason = 'Deploy gate: this command publishes to production. Run '
        + 'the `senior-shipper` subagent first; it stamps `lastShipperApprovalAt` '
        + 'in .traffic-one/.one.json after pre-flight (reviewer APPROVED, tests green, '
        + 'user confirmed). The stamp grants a 10-minute deploy window.';
      return denyPreToolUse(reason);
    }

    const securityCheck = checkSecurityDeployStamp(stateForDeploy, process.cwd());
    if (!securityCheck.ok) {
      return denyPreToolUse(securityCheck.reason);
    }
  }

  if (!INSTALL_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const state = readState(process.cwd());
  const stack = typeof state.stack === 'string' ? state.stack : null;
  const hits = forbiddenForStack(state.stack ? state : stack, allowsNextjs(state)).filter(([pattern]) => new RegExp(pattern).test(command));

  if (hits.length === 0) {
    return { stdout: '', exitCode: 0 };
  }

  const lines  = hits.map(([pattern, tip]) => `  - ${pattern}: ${tip}`).join('\n');
  const reason = `Forbidden library:\n${lines}\n\nSee rules/core.md and the active stack core for the approved stack.`;
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

module.exports = {
  runCheckOnboardingGate,
  runCheckAgentModel,
  runCheckArchitectureWrite,
  runCheckLibraryAllowlist,
  forbiddenForStack,
  // private helpers exported for sibling/test access
  detectHookHost,
  normalizeSubagentRole,
  inferTrafficOneSpawnRole,
  readStack,
  packageJsonHasNext,
  allowsNextjs,
  stateFromStackForAllowlist,
  checkSecurityDeployStamp,
};
