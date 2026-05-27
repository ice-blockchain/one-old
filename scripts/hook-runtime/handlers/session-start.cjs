'use strict';

// scripts/hook-runtime/handlers/session-start.cjs
// SessionStart handler + its private helpers (digest retention sweep, graph
// preview reader, session materialization). Function bodies are moved verbatim
// from the original single-file handlers.cjs.

const {
  fs,
  path,
  pluginRoot,
  readState,
  writeState,
  normalizeState,
  detectMode,
  detectStackFromCodebase,
  STACK_IDS,
  STACKS,
  BUDGET_CHARS,
  stackSpecForState,
  roleScopedRules,
  packBundle,
  packRuleIndex,
  packFixCycleHeader,
  copyActiveSkills,
  cleanActiveSkills,
  listAllSkills,
  pruneSkillsDirective,
  materializeProjectAssets,
  hasMaterializedProjectAssets,
  isPluginAuthoringRoot,
  stackFingerprint,
  getPluginVersion,
  isMaterialized,
  nowIso,
  initializeToolchainState,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
  activeAgentRole,
  isKnownStack,
  isNewProjectOnboardingIncomplete,
  onboardingDirectiveNewProject,
  autoDetectedAnnouncement,
  tokenEconomyBanner,
  startOneMcpReportBestEffort,
} = require('./_helpers.cjs');

const {
  authGateForHook,
  authChoiceAllowsContinue,
  authRequiredHookResult,
  tryWriteAuthChoice,
} = require('./auth.cjs');

// Digest retention: keep only the N most recent .traffic-one/digests/<runId>/
// directories. Without this, every orchestrator run accumulates ~12KB of
// digests forever — and subagents that read predecessor digests pay for the
// cruft. Runs once at SessionStart for both parent and subagent paths.
function sweepOldDigests(cwd, keepCount = 5) {
  const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
  if (!fs.existsSync(digestsRoot)) return 0;
  let entries;
  try {
    entries = fs.readdirSync(digestsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()      // ISO-timestamp dir names sort chronologically
      .reverse();  // newest first
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries.slice(keepCount)) {
    try {
      fs.rmSync(path.join(digestsRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort; never block SessionStart on retention sweep
    }
  }
  return removed;
}

// Read the compact graph preview (~500 tokens) written by gitnexus/graphify
// runners. Subagents see top-level module names without doing a full Read of
// the graph artefact, so they can scope their work immediately.
function readGraphPreview(cwd) {
  const previewPath = path.join(cwd, '.traffic-one', 'graph-preview.md');
  if (!fs.existsSync(previewPath)) return '';
  try {
    return `\n${fs.readFileSync(previewPath, 'utf8').trimEnd()}\n`;
  } catch {
    return '';
  }
}

function ensureSessionMaterialization(cwd, state) {
  if (isPluginAuthoringRoot(cwd)) return false;
  if (!state || typeof state !== 'object') return false;
  if (state.onboardingComplete !== true) return false;
  if (!state.stack || !STACK_IDS.has(state.stack)) return false;

  const hasFreshStamp = isMaterialized(state);
  const hasAssets = hasMaterializedProjectAssets(cwd, state);
  if (hasFreshStamp && hasAssets) {
    startOneMcpReportBestEffort(cwd, state, 'session materialization already current');
    return false;
  }

  normalizeState(state, state.mode || detectMode(cwd));
  const materialized = materializeProjectAssets(cwd, state);
  if (materialized.skipped) {
    startOneMcpReportBestEffort(cwd, state, 'session materialization skipped');
    return false;
  }
  state.materializedStack = stackFingerprint(state);
  state.materializedAt = nowIso();
  state.materializedVersion = getPluginVersion();
  writeState(cwd, state);
  startOneMcpReportBestEffort(cwd, state, 'session materialization');
  return true;
}

// ── SessionStart ─────────────────────────────────────────────────────────────
function runSessionStart(rawInput = '') {
  const cwd  = process.cwd();
  const root = pluginRoot();

  if (isPluginAuthoringRoot(cwd)) {
    return { stdout: '', exitCode: 0 };
  }

  const authGate = authGateForHook({ forceRemote: true });
  if (!authGate.authenticated) {
    if (authChoiceAllowsContinue(cwd)) return { stdout: '', exitCode: 0 };
    const writeResult = tryWriteAuthChoice('pending-choice', cwd);
    return authRequiredHookResult('SessionStart', { authChoiceWrite: writeResult });
  }

  const state = readState(cwd);

  // MULTI-PROJECT SAFETY: clean non-bootstrap skills left by the previous
  // project's session. The plugin cache is shared across all traffic-one
  // projects on this machine; this ensures each session starts from a clean
  // 3-skill baseline before copying the correct set for THIS project.
  cleanActiveSkills();

  // Digest retention sweep (cheap, idempotent). Keeps the last 5 orchestrator
  // runs and removes older ones from .traffic-one/digests/.
  sweepOldDigests(cwd, 5);

  try {
    ensureSessionMaterialization(cwd, state);
  } catch {
    // Best-effort: if local materialization fails, the normal/full SessionStart
    // branch below still provides rule context instead of trusting a stale stamp.
  }

  // SUBAGENT FAST PATH. Prefer a per-agent run claim resolved from the actual
  // hook session id. Legacy .traffic-one.json activeAgentRole remains a fallback
  // only when no per-run agent state exists yet.
  const agentContext = resolveRunAgentContext(cwd, state, rawInput, { claimPending: true })
    || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
  if (agentContext && hasMaterializedProjectAssets(cwd, state)) {
    const role = agentContext.role;
    const runId = agentContext.runId;
    const spawnIndex = agentContext.spawnIndex || 0;

    // FIX-CYCLE BRANCH. Same role re-spawned in the same run (spawnIndex > 1)
    // = the reviewer found issues and the orchestrator is looping back. The
    // role has its own prior digest + a fix-cycle context file written by the
    // orchestrator with EXACT findings to apply. Emit ~500 bytes of pointers
    // and tell the model not to re-explore. Saves ~25-30K tokens vs the
    // already-slim role-scoped index, ~115KB vs the full bundle.
    if (role && spawnIndex > 1) {
      const { body } = packFixCycleHeader(cwd, role, runId, spawnIndex);
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: body,
          },
        }),
        exitCode: 0,
      };
    }

    // Standard subagent path: role-scoped rule index (~2-5KB).
    const ruleSet = role ? roleScopedRules(role, state) : null;
    const rules = ruleSet || stackSpecForState(state).mandatory;

    copyActiveSkills(state);
    const allSkills = listAllSkills();
    const skillDirective = pruneSkillsDirective(state, allSkills);
    const { body } = packRuleIndex(root, rules);
    const graphPreview = readGraphPreview(cwd);
    const roleLabel = role || 'subagent';

    const header = `═══ traffic-one — ${roleLabel} (run ${runId}) ═══\n`
      + `[subagent] Full rules already loaded by parent session and materialized to `
      + `.traffic-one/rules/. This index lists role-scoped rules; Read them on demand.\n`;
    const context = `${header}${skillDirective}${graphPreview}\n${body}`;
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }),
      exitCode: 0,
    };
  }

  const mode = state.mode || detectMode(cwd);
  state.mode = mode;

  let stackId = state.stack;

  // Tolerate a partial state file (e.g. {stack, backend, realtime, version}
  // without onboardingComplete) — fill in defaults rather than re-running
  // onboarding. The user already picked a stack; we just complete bookkeeping.
  if (stackId && isKnownStack(stackId)) {
    normalizeState(state, mode);
    stackId = state.stack;
  }

  const onboardingComplete = Boolean(state.onboardingComplete);
  const onboardingReady = onboardingComplete
    && STACK_IDS.has(stackId)
    && (mode !== 'new-project' || !isNewProjectOnboardingIncomplete(state));

  // Flow 1 — already onboarded (or partial state with valid stack) → pack bundle
  if (onboardingReady) {
    const spec = stackSpecForState(state);

    // Splice in the mode-specific rule if it exists (e.g. modes/new-project.md
    // contains the Turborepo scaffold checklist that the model needs to see).
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath))
      ? [...spec.mandatory, modeRulePath]
      : spec.mandatory;

    const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

    const copied = copyActiveSkills(state);
    const allSkills = listAllSkills();
    const skillDirective = pruneSkillsDirective(state, allSkills);
    let sessionMaterialized = false;
    try {
      const materialized = materializeProjectAssets(cwd, state);
      sessionMaterialized = !materialized.skipped;
    } catch {
      // Best-effort: SessionStart can still provide the in-memory rule bundle,
      // but it must not stamp .traffic-one.json as materialized unless the
      // project-local rules, skills, manifest, and root context files exist.
    }
    if (sessionMaterialized) {
      state.materializedStack   = stackFingerprint(state);
      state.materializedAt      = nowIso();
      state.materializedVersion = getPluginVersion();
    }

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    if (copied > 0) {
      header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    }
    if (dropped.length > 0) {
      header += `[${dropped.length} rule file(s) deferred to path-scoped attach]\n`;
    }
    header += tokenEconomyBanner(cwd);
    if (skillDirective) {
      header += skillDirective;
    }
    const graphPreview = readGraphPreview(cwd);
    const context = `${header}${graphPreview}\n${body}`;
    writeState(cwd, state);
    startOneMcpReportBestEffort(cwd, state, 'session-start');
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }),
      exitCode: 0,
    };
  }

  // Flow 2 — existing project with detectable stack → auto-write + prune
  if (mode === 'existing-codebase' || mode === 'existing-with-supabase') {
    const detected = detectStackFromCodebase(cwd);
    if (!detected.stack) {
      detected.stack = 'minimal';
      detected.backend = detected.backend || 'other';
      detected.realtime = detected.realtime || 'none';
      detected.evidence.push('existing codebase detected → apply minimal stack baseline');
    }

    if (detected.stack) {
      Object.assign(state, {
        mode,
        stack:                detected.stack,
        backend:              detected.backend || 'other',
        frontend:             detected.frontend || 'none',
        ...(detected.mobile ? { mobile: detected.mobile } : {}),
        realtime:             detected.realtime || 'none',
        confirmed:            true,
        onboardingComplete:   true,
        confirmedAt:          nowIso(),
        autoDetected:         true,
        evidence:             detected.evidence,
      });

      normalizeState(state, mode);

      const spec = stackSpecForState(state);

      // Splice in the mode-specific rule (e.g. modes/existing-codebase.md)
      const modeRulePath = `rules/modes/${mode}.md`;
      const modeMandatory = fs.existsSync(path.join(root, modeRulePath))
        ? [...spec.mandatory, modeRulePath]
        : spec.mandatory;

      const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

      const copied2 = copyActiveSkills(state);
      const allSkills = listAllSkills();
      let autoMaterialized = false;
      try {
        const materialized = materializeProjectAssets(cwd, state);
        autoMaterialized = !materialized.skipped;
      } catch {
        // Best-effort: auto-detection still succeeds, but do not claim the
        // project-local materialization is present when the copy failed.
      }
      if (autoMaterialized) {
        state.materializedStack   = stackFingerprint(state);
        state.materializedAt      = nowIso();
        state.materializedVersion = getPluginVersion();
      }
      writeState(cwd, state);
      startOneMcpReportBestEffort(cwd, state, 'session-start auto-detect');
      const skillDirective = pruneSkillsDirective(state, allSkills);

      const banner = autoDetectedAnnouncement(detected);
      let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
      if (copied2 > 0) {
        header += `[skills] ${copied2} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
      }
      if (dropped.length > 0) {
        header += `[${dropped.length} rule file(s) deferred]\n`;
      }
      header += tokenEconomyBanner(cwd);
      if (skillDirective) {
        header += skillDirective;
      }
      const graphPreview = readGraphPreview(cwd);
      const context = `${banner}\n\n${header}${graphPreview}\n${body}`;
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: context,
          },
        }),
        exitCode: 0,
      };
    }
  }

  // Flow 3 — new project (or undetectable existing) → onboarding directive
  const directive = onboardingDirectiveNewProject();
  const spec = STACKS.minimal;
  const { body } = packBundle(root, spec.mandatory, spec.optional, Math.floor(BUDGET_CHARS / 2));
  const context = `${directive}\n\n═══ Baseline rules (in effect until onboarding completes) ═══\n${body}`;
  if (!state.toolchain || typeof state.toolchain !== 'object') {
    state.toolchain = initializeToolchainState();
  }
  writeState(cwd, state);
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }),
    exitCode: 0,
  };
}

module.exports = {
  runSessionStart,
  sweepOldDigests,
  readGraphPreview,
  ensureSessionMaterialization,
};
