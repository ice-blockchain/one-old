'use strict';

// scripts/hook-runtime/handlers.cjs
// Five handlers, one per hook subcommand. Each is a pure function:
//   input → { stdout, exitCode } (no side effects on stdin/stdout/stderr).
// The thin entry script (`scripts/hook-runtime.cjs`) wires stdin/stdout
// around them.

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  STATE_FILE,
  BUDGET_CHARS,
  RN_STACKS,
  WEB_STACKS,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
  pluginRoot,
} = require('./config.cjs');

const {
  parseJsonText,
  safeReadJson,
  nowIso,
  readState,
  writeState,
  normalizeState,
  initializeToolchainState,
  stackFingerprint,
  getPluginVersion,
  isMaterialized,
  isSubagentSession,
  activeAgentRole,
  isFixCycleSession,
  getSpawnIndex,
} = require('./state.cjs');

const { STACKS, stackSpecForState, roleScopedRules } = require('./stacks.cjs');

const {
  listAllSkills,
  pruneSkillsDirective,
  cleanActiveSkills,
  copyActiveSkills,
} = require('./skill-filters.cjs');

const {
  loadPackageJson,
  dependenciesFromPackage,
  detectMode,
  detectStackFromCodebase,
  classifyPromptForStack,
} = require('./detection.cjs');

const { packBundle, packRuleIndex, packFixCycleHeader } = require('./packing.cjs');
const { materializeProjectAssets } = require('./materialize.cjs');
const {
  computeProjectFingerprint,
} = require('../security-check-runner.cjs');

const {
  onboardingDirectiveNewProject,
  autoDetectedAnnouncement,
  onboardingReminderShort,
  postWriteIncompleteWarning,
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
} = require('./directives.cjs');

const tokenLogger = require('./token-logger.cjs');

// ── Token-economy banner: surface graphify report + recent digests ─────────
// Single-line hints appended to the SessionStart header when these on-disk
// artefacts exist. They tell the agent "you have a cache; consult it before
// grep/glob" without inflating the bundle.
function tokenEconomyBanner(cwd) {
  const lines = [];
  const memoryPaths = [
    '.traffic-one/product.md',
    '.traffic-one/stack.md',
    '.traffic-one/rules/coding.md',
    '.traffic-one/rules/security.md',
    '.traffic-one/known-issues.md',
    '.traffic-one/agent-log.md',
  ];
  if (memoryPaths.some((relPath) => fs.existsSync(path.join(cwd, relPath)))) {
    lines.push('[memory] .traffic-one/ project memory present — read product/stack/rules/known-issues before broad source reads.');
  }
  // Codebase-graph banner. Both providers can show simultaneously if both
  // artefacts exist on disk (e.g. user switched provider mid-project); the
  // active one per `.traffic-one.json` is what subagents will read.
  const graphifyPath = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
  if (fs.existsSync(graphifyPath)) {
    lines.push('[graph: graphify] graphify-out/GRAPH_REPORT.md present — consult before grep/glob for module/structure questions.');
  }
  const gitnexusPath = path.join(cwd, '.gitnexus');
  if (fs.existsSync(gitnexusPath)) {
    lines.push('[graph: gitnexus] .gitnexus/ present — consult before grep/glob for module/structure questions.');
  }
  try {
    const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
    if (fs.existsSync(digestsRoot)) {
      const runs = fs.readdirSync(digestsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      if (runs.length > 0) {
        lines.push(`[digests] Latest orchestrator run: .traffic-one/digests/${runs[0]}/ — read predecessor digests before re-reading the diff.`);
      }
    }
  } catch {
    // best-effort; banner is informational
  }
  // Toolchain drift hints. Walk `.traffic-one.json` → `toolchain.*` and
  // surface a one-line nudge per tool whose installed version sits below
  // the plugin's curated `recommended` (or below `minimum` — louder).
  // The curated spec lives at `scripts/toolchain-versions.json`; bump it
  // there to update what every project sees on its next SessionStart.
  try {
    const stateFile = path.join(cwd, '.traffic-one.json');
    if (fs.existsSync(stateFile)) {
      const state = safeReadJson(stateFile, {});
      const toolchain = (state && state.toolchain) || {};
      if (Object.keys(toolchain).length > 0) {
        const tch = require(path.resolve(__dirname, '..', 'toolchain.cjs'));
        for (const [name, stamp] of Object.entries(toolchain)) {
          const status = tch.toolStatus(name, stamp && stamp.installedVersion);
          if (status.status === 'too-old') {
            const spec = tch.getToolSpec(name) || {};
            lines.push(`[toolchain] ${name} ${status.installed} is below the minimum supported (${status.minimum}). Upgrade: \`${spec.installCommand || `<upgrade ${name}>`}\`.`);
          } else if (status.status === 'outdated') {
            lines.push(`[toolchain] ${name} ${status.installed} installed; recommended is ${status.recommended}.`);
          }
        }
      }
    }
  } catch {
    // best-effort; banner is informational
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function isKnownStack(stack) {
  return STACK_IDS.has(stack) || Object.prototype.hasOwnProperty.call(LEGACY_STACK_ALIASES, stack);
}

function isNativeState(state) {
  return Boolean(
    state
    && (
      (state.mobile && state.mobile.framework === 'react-native-expo')
      || RN_STACKS.has(state.stack)
    ),
  );
}

function isWebState(state) {
  if (!state) return false;
  if (WEB_STACKS.has(state.stack) && (!state.mobile || state.mobile.framework !== 'react-native-expo')) {
    return true;
  }
  return Boolean(state.frontend && state.frontend !== 'none');
}

function stateRequiresNewProjectMonorepo(state) {
  if (!state || state.mode !== 'new-project' || isNativeState(state)) return false;
  if (state.stack === 'default' || state.stack === 'react-realtime-monorepo') return true;
  return state.frontend === 'react-vite' && state.backend !== 'none';
}

function findProjectRootForHookFile(cwd, filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return cwd;

  const absPath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(cwd, normalized);
  const cwdAbs = path.resolve(cwd);
  let current = path.dirname(absPath);

  while (current.startsWith(cwdAbs)) {
    if (fs.existsSync(path.join(current, STATE_FILE))) {
      return current;
    }
    if (current === cwdAbs) break;
    current = path.dirname(current);
  }

  return cwd;
}

function projectRelativeHookPath(cwd, projectRoot, filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return '';
  const absPath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(cwd, normalized);
  const relative = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && relative !== '.') {
    return relative;
  }
  return normalized;
}

function packageJsonDeclaresWorkspace(content) {
  if (!content || !content.trim()) return true;
  try {
    const pkg = JSON.parse(content);
    const workspaces = pkg && pkg.workspaces;
    const hasWorkspaces = Array.isArray(workspaces)
      || Boolean(workspaces && Array.isArray(workspaces.packages));
    const hasPnpmPackageManager = typeof pkg.packageManager === 'string'
      && /^pnpm@\d/.test(pkg.packageManager);
    return pkg.private === true && hasWorkspaces && hasPnpmPackageManager;
  } catch {
    return true;
  }
}

function promptTextFromSubmit(rawInput) {
  const payload = parseJsonText(rawInput, {});
  const candidates = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.message,
    payload.text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return '';
}

function isStateFilePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === STATE_FILE || normalized.endsWith(`/${STATE_FILE}`);
}

function isProjectMemoryWritePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('.traffic-one/')) return false;
  if (normalized.startsWith('.traffic-one/digests/')) return false;
  if (normalized.startsWith('.traffic-one/reports/')) return false;
  if (normalized.startsWith('.traffic-one/backups/')) return false;
  if (normalized.startsWith('.traffic-one/rules/active/')) return false;
  if (normalized.startsWith('.traffic-one/skills/')) return false;
  return normalized !== '.traffic-one/manifest.json'
    && normalized !== '.traffic-one/rules/manifest.json';
}

function materializationFailureResult(error) {
  const detail = error && error.message ? error.message : String(error || 'unknown error');
  return {
    stdout: JSON.stringify({
      systemMessage: 'traffic-one — project-local materialization failed',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `traffic-one could not materialize .traffic-one/rules/active, .traffic-one/skills, and .traffic-one/rules/manifest.json: ${detail}`,
      },
    }),
    exitCode: 0,
  };
}

function materializationSuccessResult(materialized, triggerPath) {
  if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
    return { stdout: '', exitCode: 0 };
  }
  return {
    stdout: JSON.stringify({
      systemMessage: 'traffic-one — project-local rules/skills materialized',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `Project-local rules/skills materialized after ${triggerPath}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/rules/manifest.json.`,
      },
    }),
    exitCode: 0,
  };
}

function materializeFromProjectMemoryWrite(cwd, filePath) {
  const projectRoot = findProjectRootForHookFile(cwd, filePath);
  const relativePath = projectRelativeHookPath(cwd, projectRoot, filePath);
  if (!isProjectMemoryWritePath(relativePath)) return null;

  const statePath = path.join(projectRoot, STATE_FILE);
  const state = safeReadJson(statePath, null);
  if (!state || !state.stack || !STACK_IDS.has(state.stack) || state.onboardingComplete !== true) {
    return null;
  }

  try {
    if (normalizeState(state, detectMode(projectRoot))) {
      writeState(projectRoot, state);
    }
    const materialized = materializeProjectAssets(projectRoot, state);
    return materializationSuccessResult(materialized, relativePath);
  } catch (error) {
    return materializationFailureResult(error);
  }
}

const FRONTEND_IDS = new Set(['none', 'react-vite', 'nextjs', 'vue', 'svelte', 'angular', 'astro', 'solid', 'remix', 'other']);
const BACKEND_IDS = new Set([
  'none',
  'supabase',
  'external-api',
  'node',
  'nestjs',
  'python',
  'django',
  'fastapi',
  'go',
  'rust',
  'java',
  'kotlin',
  'php',
  'laravel',
  'dotnet',
  'firebase',
  'mongo',
  'other',
]);
const MOBILE_FRAMEWORK_IDS = new Set(['ionic-capacitor', 'react-native-expo', 'none']);
const MOBILE_SOURCE_IDS = new Set(['explicit', 'prompted', 'none']);

function hasInitializedToolchain(toolchain) {
  if (!toolchain || typeof toolchain !== 'object') return false;
  const expected = initializeToolchainState({});
  return Object.keys(expected).every((toolName) => {
    const entry = toolchain[toolName];
    return entry
      && typeof entry === 'object'
      && Object.prototype.hasOwnProperty.call(entry, 'installedVersion')
      && Object.prototype.hasOwnProperty.call(entry, 'installedAt');
  });
}

function hasTechnologyArrays(technologies) {
  return technologies
    && typeof technologies === 'object'
    && Array.isArray(technologies.frontend)
    && Array.isArray(technologies.backend)
    && Array.isArray(technologies.mobile);
}

function hasValidMobileState(mobile) {
  if (!mobile || typeof mobile !== 'object') return false;
  return typeof mobile.enabled === 'boolean'
    && MOBILE_FRAMEWORK_IDS.has(mobile.framework)
    && MOBILE_SOURCE_IDS.has(mobile.source);
}

function isNewProjectOnboardingIncomplete(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.mode !== 'new-project') return false;
  const hasValidStack = typeof state.stack === 'string' && isKnownStack(state.stack);
  const hasGraphProvider = state.codeGraphProvider === 'gitnexus' || state.codeGraphProvider === 'graphify';
  const hasFrontend = typeof state.frontend === 'string' && FRONTEND_IDS.has(state.frontend);
  const hasBackend = typeof state.backend === 'string' && BACKEND_IDS.has(state.backend);
  return !hasValidStack
    || !hasFrontend
    || !hasBackend
    || !hasValidMobileState(state.mobile)
    || !hasTechnologyArrays(state.technologies)
    || !hasGraphProvider
    || !hasInitializedToolchain(state.toolchain)
    || state.confirmed !== true
    || state.onboardingComplete !== true
    || typeof state.confirmedAt !== 'string'
    || state.confirmedAt.trim() === '';
}

function onboardingGateFallbackReason() {
  return [
    'Traffic One onboarding gate: mode=new-project and onboarding is not complete.',
    'Switch Codex/Claude to Plan mode before using tools. If Plan mode is not active or the popup tool is unavailable, the fallback chat prompt must be displayed as the next visible assistant message.',
    '',
    'The previous assistant turn tried to use tools before displaying the fallback prompt. Stop tool use now. Your next visible assistant message must be:',
    '',
    codexDefaultModeFallbackMobilePrompt(),
    '',
    'The onboarding state remains incomplete until `.traffic-one.json` contains stack, frontend, backend, mobile, technologies, codeGraphProvider, toolchain, confirmed, onboardingComplete, and confirmedAt.',
    'After sending that prompt, stop. Do not choose defaults, inspect package versions, scaffold, install, edit files, or continue implementation until the typed answer is received and the remaining Code Graph and Team prompts are resolved.',
  ].join('\n');
}

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

// ── SessionStart ─────────────────────────────────────────────────────────────
function runSessionStart() {
  const cwd  = process.cwd();
  const root = pluginRoot();
  const state = readState(cwd);

  // MULTI-PROJECT SAFETY: clean non-bootstrap skills left by the previous
  // project's session. The plugin cache is shared across all traffic-one
  // projects on this machine; this ensures each session starts from a clean
  // 3-skill baseline before copying the correct set for THIS project.
  cleanActiveSkills();

  // Digest retention sweep (cheap, idempotent). Keeps the last 5 orchestrator
  // runs and removes older ones from .traffic-one/digests/.
  sweepOldDigests(cwd, 5);

  // SUBAGENT FAST PATH. The orchestrator skill writes `currentRunId` +
  // `activeAgentRole` to .traffic-one.json before each subagent spawn. When
  // those signals are present (and materialization is fresh), emit a slim
  // bundle instead of re-inlining the full 117KB rule set the parent
  // already loaded.
  if (isSubagentSession(state)) {
    const role = activeAgentRole(state);
    const runId = state.currentRunId;
    const spawnIndex = role ? getSpawnIndex(state, role) : 0;

    // FIX-CYCLE BRANCH. Same role re-spawned in the same run (spawnIndex > 1)
    // = the reviewer found issues and the orchestrator is looping back. The
    // role has its own prior digest + a fix-cycle context file written by the
    // orchestrator with EXACT findings to apply. Emit ~500 bytes of pointers
    // and tell the model not to re-explore. Saves ~25-30K tokens vs the
    // already-slim role-scoped index, ~115KB vs the full bundle.
    if (isFixCycleSession(state)) {
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
      + `.traffic-one/rules/active/. This index lists role-scoped rules; Read them on demand.\n`;
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

  // Flow 1 — already onboarded (or partial state with valid stack) → pack bundle
  if (onboardingComplete && STACK_IDS.has(stackId)) {
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
    try {
      materializeProjectAssets(cwd, state);
    } catch {
      // best-effort; SessionStart rule loading should not fail on local copy issues
    }
    state.materializedStack   = stackFingerprint(state);
    state.materializedAt      = nowIso();
    state.materializedVersion = getPluginVersion();

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
      try {
        materializeProjectAssets(cwd, state);
      } catch {
        // best-effort; auto-detection still succeeds even if local copy fails
      }
      state.materializedStack   = stackFingerprint(state);
      state.materializedAt      = nowIso();
      state.materializedVersion = getPluginVersion();
      writeState(cwd, state);
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

// ── UserPromptSubmit ─────────────────────────────────────────────────────────
function runUserPromptSubmit(rawInput = '') {
  const statePath = path.join(process.cwd(), STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return {
      stdout: JSON.stringify({ systemMessage: 'traffic-one active' }),
      exitCode: 0,
    };
  }

  const state = safeReadJson(statePath, null);
  if (!state) {
    return {
      stdout: JSON.stringify({ systemMessage: 'traffic-one active' }),
      exitCode: 0,
    };
  }

  const stack = state.stack || state.mode || 'unknown';
  const validStack = state.stack && isKnownStack(state.stack);
  const isIncomplete = !validStack || state.onboardingComplete !== true;

  // Re-inject the short onboarding reminder while a new project hasn't yet
  // persisted a valid stack. SessionStart's full directive can scroll out of
  // context across long onboarding turns or compaction; this keeps the model
  // pointed at the schema until `.traffic-one.json` is fully populated.
  if (isIncomplete && state.mode === 'new-project') {
    const reminder = onboardingReminderShort();
    const promptText = promptTextFromSubmit(rawInput);
    const classification = promptText ? classifyPromptForStack(promptText) : null;
    const classificationContext = classification
      ? [
        '[FIRST PROMPT STACK CLASSIFICATION]',
        `stack=${classification.stack}`,
        `frontend=${classification.frontend}`,
        `backend=${classification.backend}`,
        `mobile=${classification.mobile.enabled ? classification.mobile.framework : 'none'}`,
        'mode=new-project: switch Codex and Claude Code to Plan mode before onboarding questions or implementation. If no mode switch is available, stay plan-only, ask fallback chat questions, and stop for typed answers.',
        codexDefaultModeFallbackDirective(),
        'Onboarding choices must be prompt popups: call Codex `request_user_input` when available; do not print numbered option lists in chat. If the popup tool is unavailable, ask the same question in chat with numbered options, tell the user to reply with the option number or label, and stop; never choose a default or continue implementation while the answer is pending.',
        classification.shouldAskMobile
          ? [
            'Popup 1: ask the mobile decision with Codex `request_user_input`:',
            'question="Do you want a mobile app too?"',
            'options: Web only (Recommended); Ionic + Capacitor; React Native / Expo.',
            'Ask this even if the prompt already named web, mobile, Next.js, Ionic, React Native, frontend-only, or no subagents.',
            'Stop and wait for the popup answer, or for a typed option if popup is unavailable.',
          ].join(' ')
          : 'Minimal/static project classification only: mobile popup is not required.',
        [
          'Popup 2: ask the required codebase graph provider with Codex `request_user_input`:',
          'question="Which provider should we use for the codebase graph?"',
          'options: GitNexus; graphify.',
          'Stop and wait for the popup answer, or for a typed option if popup is unavailable; no default and no skip.',
        ].join(' '),
        [
          'Popup 3: for non-trivial multi-layer builds, ask the Traffic One team/subagent choice with Codex `request_user_input`:',
          'question="Traffic One sees this as a multi-layer build. Do you want me to run the Traffic One subagent team: architect → frontend/backend → reviewer/tester?"',
          'options: Run team (Recommended); Main agent only.',
          'Ask this only after the codebase graph choice is answered; stop for a typed option if popup is unavailable.',
        ].join(' '),
      ].join('\n')
      : '';
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [onboarding incomplete]',
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[ACTIVE STACK: ${stack}]\n\n${classificationContext ? `${classificationContext}\n\n` : ''}${reminder}`,
        },
      }),
      exitCode: 0,
    };
  }

  return {
    stdout: JSON.stringify({
      systemMessage: `traffic-one [${stack}]`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[ACTIVE STACK: ${stack}]`,
      },
    }),
    exitCode: 0,
  };
}

// ── PreToolUse: new-project onboarding gate ──────────────────────────────────
function runCheckOnboardingGate(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  const cwd = process.cwd();
  const statePath = path.join(cwd, STATE_FILE);
  const state = safeReadJson(statePath, {});
  const mode = state.mode || detectMode(cwd);
  const effectiveState = {
    ...state,
    mode,
  };

  if (isStateFilePath(filePath)) {
    return { stdout: '', exitCode: 0 };
  }

  if (mode === 'new-project' && isNewProjectOnboardingIncomplete(effectiveState)) {
    return denyPreToolUse(onboardingGateFallbackReason());
  }

  return { stdout: '', exitCode: 0 };
}

// ── PreToolUse: architecture write/edit guard ────────────────────────────────
function readStack() {
  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  return typeof state.stack === 'string' ? state.stack : null;
}

function runCheckArchitectureWrite(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const rawFilePath = (typeof toolInput.file_path === 'string' ? toolInput.file_path : '').replace(/\\/g, '/');
  const cwd = process.cwd();
  const projectRoot = findProjectRootForHookFile(cwd, rawFilePath);
  const filePath = projectRelativeHookPath(cwd, projectRoot, rawFilePath);
  const content =
    typeof toolInput.content === 'string'
      ? toolInput.content
      : typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : '';
  const stateForArchitecture = safeReadJson(path.join(projectRoot, STATE_FILE), {});
  const isNative = isNativeState(stateForArchitecture);
  const violations = [];

  // Plan gate: on a new project, deny feature-source writes until the architect
  // has produced .traffic-one/plan.md. The plan file itself, .traffic-one/
  // project memory, root docs, ADRs, and legacy docs/ are exempt so the
  // architect can write the plan without self-blocking.
  const FEATURE_SOURCE_RE = /^(apps\/[^/]+\/(src|app)\/|packages\/[^/]+\/src\/|src\/|services\/[^/]+\/src\/)/;
  const PLAN_FILE_RE      = /(^|\/)\.traffic-one\/plan\.md$/;
  const ADR_OR_DOC_RE     = /(^|\/)(docs|architecture|README|ADR)/i;

  const statePath         = path.join(projectRoot, STATE_FILE);
  const stateForPlan      = stateForArchitecture;
  const stateMissing      = !fs.existsSync(statePath);
  const validStateStack   = stateForPlan.stack && isKnownStack(stateForPlan.stack);
  const memoryPresent     = fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'))
    || fs.existsSync(path.join(projectRoot, '.traffic-one', 'stack.md'));
  const detectedModeForState = stateForPlan.mode || (stateMissing ? detectMode(projectRoot) : null);
  const isNewProject      = stateForPlan.mode === 'new-project';
  const planAbsPath       = path.join(projectRoot, '.traffic-one', 'plan.md');
  const planMissing       = !fs.existsSync(planAbsPath);
  const writingPlan       = PLAN_FILE_RE.test(filePath);
  const writingDoc        = ADR_OR_DOC_RE.test(filePath);
  const writingFeatureSource = FEATURE_SOURCE_RE.test(filePath);
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
      'State gate: root .traffic-one.json is missing or incomplete. Write the '
      + 'Traffic One state file with mode, stack, backend, realtime, confirmed, '
      + 'onboardingComplete, and confirmedAt before writing feature source. '
      + 'The .traffic-one/ folder is project memory, not the stack-selection '
      + 'state file.'
    );
  }

  // Materialization gate: block feature writes until the SessionStart hook has
  // copied the correct rules and skills to .traffic-one/ for this stack.
  // This ensures the model has full quality/performance context before implementing.
  if (writingFeatureSource && !isMaterialized(stateForPlan)) {
    violations.push(
      `Materialization gate: stack context for ${stackFingerprint(stateForPlan)} has not been materialized yet. `
      + 'Start a new Claude Code session (the SessionStart hook will copy the correct rules and skills) '
      + 'or run `/detect-project` to trigger materialization before writing feature source.'
    );
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
// stamp in .traffic-one.json (written by the senior-shipper subagent during
// pre-flight). Without the stamp, deny — forces the orchestrator → shipper
// flow rather than ad-hoc deploys.
const DEPLOY_RE = /(^|[\s;&|])(vercel\s+(deploy|--prod)|eas\s+build\s+.*--auto-submit|eas\s+submit|supabase\s+db\s+push\s+--linked|supabase\s+functions\s+deploy\s+\S+\s+--linked|gh\s+release\s+create|fly\s+deploy|wrangler\s+deploy|npm\s+publish|pnpm\s+publish)\b/;
const SHIPPER_APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_CHECK_WINDOW_MS = 10 * 60 * 1000;

function denyPreToolUse(reason) {
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
        + '`node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/security-check-runner.cjs" --strict --stamp` '
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
        + '`node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/security-check-runner.cjs" --strict --stamp` '
        + 'so the security fingerprint matches the code being deployed.',
    };
  }

  return { ok: true };
}

function runCheckLibraryAllowlist(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command  = typeof toolInput.command === 'string' ? toolInput.command : '';

  // Deploy gate runs first — production publishes are gated regardless of
  // whether the command also matches an install regex.
  if (DEPLOY_RE.test(command)) {
    const stateForDeploy = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
    const approvedAt = typeof stateForDeploy.lastShipperApprovalAt === 'string'
      ? Date.parse(stateForDeploy.lastShipperApprovalAt)
      : 0;
    const fresh = approvedAt > 0 && (Date.now() - approvedAt) < SHIPPER_APPROVAL_WINDOW_MS;
    if (!fresh) {
      const reason = 'Deploy gate: this command publishes to production. Run '
        + 'the `senior-shipper` subagent first; it stamps `lastShipperApprovalAt` '
        + 'in .traffic-one.json after pre-flight (reviewer APPROVED, tests green, '
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

  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
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

// ── PostToolUse: page-speed gate reminder after production builds ───────────
// Match build commands, including monorepo flag forms:
//   pnpm build · pnpm run build · pnpm -w build · pnpm -F web build
//   pnpm --filter web build · pnpm --filter=web build · pnpm --recursive build
//   turbo build · turbo run build · turbo run build --filter web
//   vite build · vite build --mode production
//   npm/yarn/bun analogues
// The optional `(\s[^;&|]*?)?` group is lazy so a command like
// `pnpm install build-tools` (which lacks a trailing whitespace before `build`)
// stays unmatched. Command separators (;&|) break the run.
const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;

function runPostBuildPageSpeed(rawInput) {
  const data = parseJsonText(rawInput, {});

  // Opt-in per-tool token log (TRAFFIC_ONE_TOKEN_LOG=1). No-op when disabled.
  tokenLogger.logToolUse(process.cwd(), data);

  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!BUILD_COMMAND_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  const isWebStack = isWebState(state);
  if (!isWebStack) {
    return { stdout: '', exitCode: 0 };
  }

  return {
    stdout: JSON.stringify({
      systemMessage: 'traffic-one page-speed gate pending after build',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [
          '[traffic-one] A production build just ran for a web stack.',
          'Before final delivery for generated/changed React or Ionic routes, run the Lighthouse mobile gate:',
          '',
          '  node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/lighthouse-runner.mjs" --route /',
          '',
          'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. If the environment blocks Lighthouse, explicitly report page speed as unverified with concrete risks.',
        ].join('\n'),
      },
    }),
    exitCode: 0,
  };
}

// ── PreToolUse(Glob|Grep): hint that the codebase graph exists ──────────────
// Non-blocking. Tells the agent to read the active provider's codebase graph
// first for codebase-structure questions before falling back to grep/glob.
//
// Provider-aware: `state.codeGraphProvider` (gitnexus | graphify) picks the
// artefact path. If the provider's artefact doesn't exist yet, return silent.
//
// THROTTLING: this hook fires on every Glob/Grep tool use. A subagent doing
// 40 searches would accumulate 40 × ~150 bytes = 6KB of identical reminders.
// Use a module-level marker so the hint emits at most once per hook process.
// Each subagent spawns a fresh process, so each subagent gets one hint.
let graphifyHintSentForCwd = null;

function runPreGraphifyHint(_rawInput) {
  const cwd = process.cwd();
  if (graphifyHintSentForCwd === cwd) {
    return { stdout: '', exitCode: 0 };
  }

  const state = safeReadJson(path.join(cwd, STATE_FILE), {});
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;

  // Dispatch by provider. Both branches are silent when the on-disk artefact
  // doesn't exist yet — the post-build hook will produce it after first build.
  let label;
  let artefactPath;
  let exists = false;
  if (provider === 'gitnexus') {
    artefactPath = path.join(cwd, '.gitnexus');
    exists = fs.existsSync(artefactPath);
    label = '[graph: gitnexus] `.gitnexus/` knowledge graph present';
  } else {
    // Default + 'graphify' branch share the same artefact path.
    artefactPath = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
    exists = fs.existsSync(artefactPath);
    label = '[graph: graphify] `graphify-out/GRAPH_REPORT.md` present';
  }
  if (!exists) {
    return { stdout: '', exitCode: 0 };
  }

  graphifyHintSentForCwd = cwd;
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
  const digestHint = runId
    ? ` Predecessor digests (if any) live under \`.traffic-one/digests/${runId}/\`.`
    : '';
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `${label} — read it FIRST for module / file / `
          + 'call-site questions before grep/glob.' + digestHint,
      },
    }),
    exitCode: 0,
  };
}

// ── PostToolUse(Bash): post-build foreground graphify bootstrap ─────────────
// Fires on the first successful build of a new-project (post-onboarding) when
// no fresh graph exists yet. Synchronously installs graphify (pipx | pip
// --user) if missing, then runs `graphify .` so `graphify-out/GRAPH_REPORT.md`
// actually lands. The 1-day cooldown stamp prevents re-entry on subsequent
// builds; opt out by setting `graphifyAutoRun: false` in `.traffic-one.json`.
const GRAPHIFY_FRESH_MS  = 7 * 24 * 60 * 60 * 1000;
const GRAPHIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function runPostBuildGraphifyHint(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!BUILD_COMMAND_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const cwd = process.cwd();
  const state = safeReadJson(path.join(cwd, STATE_FILE), {});
  if (state.mode !== 'new-project' || state.onboardingComplete !== true) {
    return { stdout: '', exitCode: 0 };
  }

  // Dispatch by codeGraphProvider. Without a provider, the
  // postWriteIncompleteWarning surface already nags; this hook stays silent
  // rather than picking a default.
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  if (provider !== 'gitnexus' && provider !== 'graphify') {
    return { stdout: '', exitCode: 0 };
  }

  // Provider-specific artefact path for freshness check.
  const artefactPath = provider === 'gitnexus'
    ? path.join(cwd, '.gitnexus')
    : path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
  const artefactExists = fs.existsSync(artefactPath);
  const artefactFresh = artefactExists
    ? (Date.now() - fs.statSync(artefactPath).mtimeMs) < GRAPHIFY_FRESH_MS
    : false;
  if (artefactFresh) {
    return { stdout: '', exitCode: 0 };
  }

  const lastHinted = typeof state.graphifyLastHintedAt === 'string'
    ? Date.parse(state.graphifyLastHintedAt)
    : 0;
  if (lastHinted > 0 && (Date.now() - lastHinted) < GRAPHIFY_COOLDOWN_MS) {
    return { stdout: '', exitCode: 0 };
  }

  // Stamp the cooldown immediately so a flurry of builds doesn't re-enter
  // the bootstrap (which can take ~30–60s). The runner itself stamps
  // `<provider>LastRunAt` / `<provider>LastErrorAt` separately.
  try {
    state.graphifyLastHintedAt = nowIso();
    writeState(cwd, state);
  } catch {
    // best-effort; the bootstrap still runs even if the stamp can't persist
  }

  // Run the foreground bootstrap. Never throws; returns a structured result.
  const runnerFile = provider === 'gitnexus' ? 'gitnexus-runner.cjs' : 'graphify-runner.cjs';
  let bootstrapResult;
  try {
    const { bootstrap } = require(path.resolve(__dirname, '..', runnerFile));
    bootstrapResult = bootstrap(cwd);
  } catch (err) {
    bootstrapResult = {
      ok: false,
      action: 'install-skipped',
      report: null,
      error: `${provider} runner crashed: ${(err && err.message) || String(err)}`,
      durationMs: 0,
    };
  }

  // Build the context message based on the result + provider. Always non-blocking.
  const seconds = Math.round((bootstrapResult.durationMs || 0) / 100) / 10;
  let additionalContext;
  if (bootstrapResult.ok) {
    if (provider === 'gitnexus') {
      const restored = Array.isArray(bootstrapResult.restored) && bootstrapResult.restored.length > 0
        ? ` Restored traffic-one's ${bootstrapResult.restored.join(', ')} (GitNexus auto-write conflicted).`
        : '';
      additionalContext = `[gitnexus] Codebase graph built (${seconds}s, ${bootstrapResult.action}). `
        + `Index at \`.gitnexus/\`. License reminder: PolyForm Noncommercial — only legal on non-commercial projects.${restored} `
        + 'Subagents and skills will consult `.gitnexus/` before grep/glob for module/structure questions. '
        + 'Add `.gitnexus/` and `.traffic-one/backups/` to .gitignore if not already.';
    } else {
      const actionLabel = bootstrapResult.action === 'used-existing'
        ? 'used existing `graphify` install'
        : (bootstrapResult.action === 'installed-pipx'
          ? 'installed `graphifyy` via pipx'
          : 'installed `graphifyy` via `pip --user`');
      additionalContext = `[graphify] Codebase graph built (${seconds}s, ${actionLabel}). `
        + `Report at \`graphify-out/GRAPH_REPORT.md\`. Subagents and skills will consult it `
        + `before grep/glob for module/structure questions. To auto-rebuild on each git commit: `
        + '`graphify hook install`. Add `graphify-out/` to .gitignore if not already.';
    }
  } else {
    if (provider === 'gitnexus') {
      // Most actionable branch first: nvm is installed but no v22 yet.
      // Hand the agent a single bash command + tell it to run via Bash
      // tool (user's permission prompt becomes the consent gate).
      if (bootstrapResult.action === 'nvm-install-needed') {
        additionalContext = '[gitnexus] Auto-bootstrap blocked — Node 22 not installed yet.\n'
          + `${bootstrapResult.error}\n`
          + 'AGENT: present the bash command above to the user, then run it via '
          + 'your Bash tool. The Bash permission prompt is the consent gate — '
          + 'do NOT install Node without it. After it succeeds, the runner will '
          + 'pick up the new Node 22 binary automatically (no Claude Code '
          + 'relaunch needed; the runner globs `~/.nvm/versions/node/v22.*` '
          + 'directly).';
      } else if (bootstrapResult.action === 'node-version-mismatch') {
        // Beginner-friendly Node-version-mismatch branch: emit the upgrade
        // command verbatim instead of the generic "install + build" hint
        // (the generic hint asks the user to run `npm install -g gitnexus`
        // which would just fail again with the same EBADENGINE error).
        additionalContext = '[gitnexus] Auto-bootstrap blocked — Node version too old + nvm not present.\n'
          + `${bootstrapResult.error}\n`
          + 'Install nvm first (https://github.com/nvm-sh/nvm), then re-invoke '
          + 'the runner. Or pick `codeGraphProvider: "graphify"` (Python; works '
          + 'on any Node) by editing `.traffic-one.json`.';
      } else {
        additionalContext = `[gitnexus] Auto-bootstrap failed (${seconds}s): ${bootstrapResult.error || 'unknown error'}. `
          + 'Falling back to a manual hint — install + build once when convenient:\n'
          + '  npm install -g gitnexus   # or: npx gitnexus@latest analyze .\n'
          + '  gitnexus analyze\n'
          + 'License: PolyForm Noncommercial. Disable auto-bootstrap with `"codeGraphAutoRun": false` in `.traffic-one.json`.';
      }
    } else {
      additionalContext = `[graphify] Auto-bootstrap failed (${seconds}s): ${bootstrapResult.error || 'unknown error'}. `
        + 'Falling back to a manual hint — install + build once when convenient:\n'
        + '  pipx install graphifyy   # or: python3 -m pip install --user graphifyy\n'
        + '  graphify update .\n'
        + '  graphify hook install    # optional: regenerate on every git commit\n'
        + 'To disable auto-bootstrap entirely, set `"codeGraphAutoRun": false` in `.traffic-one.json`.';
    }
  }

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    }),
    exitCode: 0,
  };
}

// ── PostToolUse: stack-rules auto-load on `.traffic-one.json` write ──────────
function runPostStackSetup(rawInput) {
  const payload = parseJsonText(rawInput, null);
  if (!payload) return { stdout: '', exitCode: 0 };

  // Opt-in per-tool token log (TRAFFIC_ONE_TOKEN_LOG=1). No-op when disabled.
  tokenLogger.logToolUse(process.cwd(), payload);

  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

  // PostToolUse on Write|Edit fires for ALL writes. Dispatch:
  //   1. supabase/functions/<name>/index.ts            → runPostFunctionEdit (auto-deploy)
  //   2. .traffic-one/digests/<run-id>/<role>.md       → digest-size warning
  //   3. .traffic-one.json                             → existing stack-rules auto-load
  //   4. anything else                                 → no-op
  if (filePath.replace(/\\/g, '/').match(FUNCTION_PATH_RE)) {
    const result = runPostFunctionEdit(filePath);
    if (result) {
      return { stdout: JSON.stringify(result), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }

  // Soft digest-size warning. Implementer subagents (frontend / backend) tend
  // to bloat their handoff digests with verbose Touched annotations and
  // exhaustive Public-contract surfaces, defeating the token-savings layer.
  // Cap target is 2 KB; we warn over 3 KB. Never blocks the write.
  const digestMatch = filePath.replace(/\\/g, '/').match(DIGEST_PATH_RE);
  if (digestMatch && fs.existsSync(filePath)) {
    let bytes = 0;
    try { bytes = fs.statSync(filePath).size; } catch { bytes = 0; }
    if (bytes > DIGEST_HARD_BYTES) {
      const role = digestMatch[1];
      const kb = Math.round((bytes / 1024) * 10) / 10;
      const reason = `[digest-size] Your \`${role}.md\` digest is ${kb} KB; the spec target is ≤2 KB (`
        + 'see `rules/common/agent-handoff-digests.md`). Re-write before completing your turn:\n'
        + '  1. Use repo-relative paths, never absolute (drop `/Users/.../` prefixes).\n'
        + '  2. Touched: file paths only, no parenthetical annotations.\n'
        + '  3. Public contracts: delta-only — what changed vs the plan, not the full surface.\n'
        + '  4. Open questions: at most 3 bullets; link to plan §, do not inline rationale.\n'
        + 'Reviewer / tester / shipper read this digest INSTEAD of the diff; bloated digests defeat the token-economy layer.';
      return {
        stdout: JSON.stringify({
          systemMessage: `traffic-one — digest ${role}.md is ${kb} KB; trim to ≤2 KB`,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: reason,
          },
        }),
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  }

  if (!filePath.endsWith(STATE_FILE)) {
    return materializeFromProjectMemoryWrite(process.cwd(), filePath) || { stdout: '', exitCode: 0 };
  }
  if (!fs.existsSync(filePath))      return { stdout: '', exitCode: 0 };

  const state = safeReadJson(filePath, null);
  // Accept any state that has a valid `stack` AND `codeGraphProvider`. The
  // model sometimes writes a partial file (no `onboardingComplete`, no
  // `codeGraphProvider`). Normalize and treat it as complete only when both
  // required fields are present + valid.
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];
  const stateDirEarly = path.dirname(path.resolve(filePath));
  let normalizedBeforeValidation = false;
  if (state && state.stack && isKnownStack(state.stack)) {
    normalizedBeforeValidation = normalizeState(state, detectMode(stateDirEarly));
  }
  const stackOk = state && state.stack && STACK_IDS.has(state.stack);
  const cgProvider = state && typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const cgOk = cgProvider && validCodeGraphProviders.includes(cgProvider);
  const toolchainOk = state && state.toolchain && typeof state.toolchain === 'object';

  if (!state || !stackOk || !cgOk || !toolchainOk) {
    // Don't fail silently: emit a system message + reminder so the model can
    // self-correct in the same turn. The warning covers both missing/invalid
    // stack AND missing/invalid codeGraphProvider.
    if (!state) {
      return { stdout: '', exitCode: 0 };
    }
    const invalidStack = state.stack && !isKnownStack(state.stack)
      ? state.stack
      : null;
    const additionalContext = postWriteIncompleteWarning({
      stack: invalidStack,
      validStackIds,
      codeGraphProvider: cgProvider,
      validCodeGraphProviders,
    });
    let systemMessage;
    if (invalidStack) {
      systemMessage = `traffic-one — \`.traffic-one.json\` has unknown stack id "${invalidStack}"; please re-write with a valid stack`;
    } else if (!state.stack) {
      systemMessage = 'traffic-one — `.traffic-one.json` write incomplete (no `stack` field); please re-write with all 8 fields';
    } else if (cgProvider && !cgOk) {
      systemMessage = `traffic-one — \`.traffic-one.json\` has unknown codeGraphProvider "${cgProvider}"; valid: gitnexus, graphify`;
    } else if (!toolchainOk) {
      systemMessage = 'traffic-one — `.traffic-one.json` missing required `toolchain` field; re-write with initialized toolchain';
    } else {
      systemMessage = 'traffic-one — `.traffic-one.json` missing required `codeGraphProvider` field; ask the user (gitnexus or graphify) and re-write';
    }
    return {
      stdout: JSON.stringify({
        systemMessage,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext,
        },
      }),
      exitCode: 0,
    };
  }

  if (normalizedBeforeValidation || normalizeState(state, detectMode(stateDirEarly))) {
    // Write back the completed state so subsequent hooks see a clean file.
    try {
      writeState(stateDirEarly, state);
    } catch {
      // best-effort; even if write fails, still emit the rule bundle below
    }
  }

  let materialized = null;
  try {
    materialized = materializeProjectAssets(stateDirEarly, state);
  } catch (error) {
    return materializationFailureResult(error);
  }

  // Stamp the materialization fields after a successful copy so the PreToolUse
  // implementation gate (isMaterialized) sees a fresh fingerprint.
  try {
    state.materializedStack   = stackFingerprint(state);
    state.materializedAt      = nowIso();
    state.materializedVersion = getPluginVersion();
    writeState(stateDirEarly, state);
  } catch {
    // best-effort; stamp failure should not block the user
  }

  const stack = state.stack || '(unknown)';
  const stateDir = path.dirname(path.resolve(filePath));

  // Seamless gitnexus setup. Two things happen when the user just wrote
  // `codeGraphProvider: "gitnexus"`:
  //
  //   (a) Write `.nvmrc` with `22` at the project root for new-project mode
  //       (don't clobber if it already exists). This locks the project to
  //       Node 22 so `cd`-into-project triggers `nvm use` to the right
  //       version going forward.
  //
  //   (b) Surface the upgrade banner ONLY when there's no path forward:
  //       no `~/.nvm/versions/node/v22.*` install at all AND current hook
  //       process is on Node <22. When an nvm-v22 install exists (even if
  //       it's not the active Node), the runner will use the absolute v22
  //       binary path — no upgrade or relaunch needed.
  let nodeWarning = '';
  if (state.codeGraphProvider === 'gitnexus') {
    try {
      const {
        currentNodeMajor,
        GITNEXUS_MIN_NODE_MAJOR,
        nodeVersionMismatchMessage,
        findNvmNode22,
      } = require(path.resolve(__dirname, '..', 'gitnexus-runner.cjs'));

      // (a) Write `.nvmrc: 22` for new-project mode when it's missing.
      if (state.mode === 'new-project') {
        const nvmrcPath = path.join(stateDir, '.nvmrc');
        if (!fs.existsSync(nvmrcPath)) {
          try {
            fs.writeFileSync(nvmrcPath, '22\n', 'utf8');
          } catch {
            // best-effort; never block stack-rule loading on .nvmrc write.
          }
        }
      }

      // (b) Conditional Node-22 banner.
      const nvm22 = findNvmNode22();
      const major = currentNodeMajor();
      const tooOldAndNoFallback =
        major !== null
        && major < GITNEXUS_MIN_NODE_MAJOR
        && (!nvm22 || (!nvm22.node && !nvm22.npm));
      if (tooOldAndNoFallback) {
        nodeWarning = '\n\n═══ traffic-one — gitnexus needs Node ≥22 ═══\n'
          + nodeVersionMismatchMessage(major)
          + '\n\nAfter the `nvm` commands, fully quit + relaunch Claude Code '
          + 'so the hook process picks up the new default Node binary.\n';
      }
    } catch {
      // best-effort; never block stack-rule loading on a probe failure.
    }
  }

  const materializedLine = materialized
    ? `Project-local rules/skills materialized: ${materialized.rules} rule files, ${materialized.skills} skills. Read them via @-imports from .traffic-one/rules/active/ on demand.`
    : 'Active rules and skills remain loaded from session start.';
  const context = `[traffic-one] stack rules active for ${stack}. ${materializedLine}${nodeWarning}`;

  return {
    stdout: JSON.stringify({
      systemMessage: `traffic-one rules loaded for stack: ${stack} (no restart needed)`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }),
    exitCode: 0,
  };
}

// ── Supabase Edge Function auto-deploy ───────────────────────────────────────
// Fires from the same PostToolUse Write|Edit dispatch as runPostStackSetup.
// `runPostFunctionEdit` is delegated from `runPostStackSetup` when the written
// file lives under `supabase/functions/<name>/` — kept in a separate function
// for clarity and testability.
//
// Flow:
//   - state.supabaseFunctionsAutoDeploy === "ask"   → emit one-time prompt
//   - state.supabaseFunctionsAutoDeploy === true    → spawn deploy, detached
//   - state.supabaseFunctionsAutoDeploy === false   → silent no-op
const FUNCTION_PATH_RE = /\/supabase\/functions\/([^/]+)\/(index|deno)\.(ts|tsx|mts|js)$/;

// Per-phase handoff digests written by the senior-* subagents — soft size cap.
// Captures the role name in group 1 for the warning message.
const DIGEST_PATH_RE = /(?:^|\/)\.traffic-one\/digests\/[^/]+\/(architect|frontend|backend|reviewer|tester|shipper)\.md$/;
const DIGEST_HARD_BYTES = 3 * 1024;  // warn over 3 KB; target is ≤2 KB

function findProjectRoot(startDir) {
  // Walk up to find the directory that owns `.traffic-one.json` or `package.json`
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, STATE_FILE)) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

function spawnDeployDetached(projectRoot, functionName) {
  // Spawn `npx supabase functions deploy <name>` detached + unref'd so the
  // hook returns immediately. Stdout/stderr go to a sidecar log the next
  // UserPromptSubmit can surface if it wants to.
  const logPath = path.join(projectRoot, '.traffic-one.deploy.log');
  let logFd;
  try {
    logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `\n--- ${nowIso()} deploy ${functionName} ---\n`);
  } catch {
    logFd = 'ignore';
  }

  try {
    const child = spawn('npx', ['supabase', 'functions', 'deploy', functionName], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, logPath };
  } catch (error) {
    return { ok: false, error: error.message, logPath };
  }
}

function runPostFunctionEdit(filePath) {
  const match = filePath.replace(/\\/g, '/').match(FUNCTION_PATH_RE);
  if (!match) {
    return null;
  }
  const functionName = match[1];

  const projectRoot = findProjectRoot(path.dirname(filePath));
  const statePath = path.join(projectRoot, STATE_FILE);
  const state = safeReadJson(statePath, {});
  if (state.backend !== 'supabase' && state.backend !== 'our-fork') {
    return null; // not a Supabase project
  }

  const flag = state.supabaseFunctionsAutoDeploy;

  if (flag === false || flag === 'never') {
    return null;
  }

  if (flag === true) {
    const result = spawnDeployDetached(projectRoot, functionName);
    if (result.ok) {
      return {
        systemMessage: `deploying Supabase function: ${functionName}`,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `[traffic-one] Edge function "${functionName}" auto-deploy started ` +
            `(\`npx supabase functions deploy ${functionName}\`). Output → ` +
            `\`${path.relative(projectRoot, result.logPath)}\` once complete.`,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[traffic-one] Tried to auto-deploy "${functionName}" but spawn failed: ${result.error}. ` +
          `Run \`pnpm functions:deploy ${functionName}\` manually.`,
      },
    };
  }

  // flag === 'ask' (default for new Supabase projects) → one-time consent prompt
  return {
    systemMessage: `Supabase function edited: ${functionName} (auto-deploy off — choose policy)`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        `[traffic-one] First edit to a Supabase Edge Function (\`${functionName}\`).`,
        '',
        'Choose an auto-deploy policy. Reply with one of:',
        '  • "yes, auto-deploy"   → I update `.traffic-one.json` to set',
        '       `supabaseFunctionsAutoDeploy: true` AND deploy this function once now',
        '       (`pnpm functions:deploy ' + functionName + '`). Future edits deploy silently.',
        '  • "ask each time"      → I leave the flag as "ask"; I\'ll prompt before',
        '       every deploy.',
        '  • "never"              → I set `supabaseFunctionsAutoDeploy: false`. No',
        '       auto-deploys; you run `pnpm functions:deploy <name>` yourself.',
        '',
        'You can change this later by editing `supabaseFunctionsAutoDeploy` in',
        '`.traffic-one.json`.',
      ].join('\n'),
    },
  };
}

module.exports = {
  runSessionStart,
  runUserPromptSubmit,
  runCheckOnboardingGate,
  runCheckArchitectureWrite,
  runCheckLibraryAllowlist,
  runPostBuildPageSpeed,
  runPostStackSetup,
  runPostFunctionEdit,      // exported for testing + entrypoint dispatch
  runPreGraphifyHint,        // PreToolUse(Glob|Grep) → graph hint
  runPostBuildGraphifyHint,  // PostToolUse(Bash) → post-build install/build hint
  forbiddenForStack,         // exported for testing
};
