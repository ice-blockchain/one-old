'use strict';

// scripts/hook-runtime/handlers/post.cjs
// PostToolUse handlers + the manual materialize-project entrypoint: page-speed
// gate reminder, graphify pre/post-build hints, stack-rules auto-load on
// `.traffic-one/.one.json` write, Supabase edge-function auto-deploy, and the
// project-root hint convergence helpers. Function bodies are moved verbatim
// from the original single-file handlers.cjs.

const {
  fs,
  path,
  spawn,
  STATE_FILE,
  LEGACY_STATE_FILE,
  STACKS,
  STACK_IDS,
  parseJsonText,
  safeReadJson,
  readState,
  readEffectiveState,
  splitLocalPreferences,
  effectiveState,
  writeState,
  normalizeState,
  detectMode,
  nowIso,
  isKnownStack,
  isStateFilePath,
  isWebState,
  isMaterialized,
  isPluginAuthoringRoot,
  isAuthenticatedLocal,
  stackFingerprint,
  getPluginVersion,
  postWriteIncompleteWarning,
  trafficOneStateValidationIssues,
  materializeProjectAssets,
  materializeProjectFromState,
  materializeProjectIfNeeded,
  materializationFailureResult,
  materializationSuccessResult,
  findProjectRootForHookFile,
  projectRelativeHookPath,
  projectRootForPathHint,
  startOneMcpReportBestEffort,
  commandFromToolInput,
  tokenLogger,
} = require('./_helpers.cjs');

const {
  authGateForHook,
  authChoiceAllowsContinue,
  authRequiredHookResult,
  tryWriteAuthChoice,
} = require('./auth.cjs');

const PROJECT_ROOT_HINT_FIELDS = [
  'file_path',
  'path',
  'cwd',
  'workdir',
];
const PROJECT_COMMAND_HINT_FIELDS = [
  'command',
  'cmd',
  'shell_command',
];
const PROJECT_PATH_TOKEN_RE = /(?:^|[\s"'`=])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+(?:[A-Za-z0-9_.@-]+)?)(?=$|[\s"'`,;|&])/g;

function projectRootsFromToolInputHints(cwd, toolInput) {
  const roots = new Set();
  const addHint = (hint) => {
    const root = projectRootForPathHint(cwd, hint);
    if (root) roots.add(root);
  };

  for (const field of PROJECT_ROOT_HINT_FIELDS) {
    if (typeof toolInput[field] === 'string') {
      addHint(toolInput[field]);
    }
  }

  for (const field of PROJECT_COMMAND_HINT_FIELDS) {
    const command = typeof toolInput[field] === 'string' ? toolInput[field] : '';
    if (!command) continue;
    for (const match of command.matchAll(PROJECT_PATH_TOKEN_RE)) {
      addHint(match[1]);
    }
  }

  return [...roots];
}

function materializeFromToolInputHints(cwd, toolInput, trigger = 'generic post-tool convergence') {
  for (const projectRoot of projectRootsFromToolInputHints(cwd, toolInput)) {
    const relativeRoot = path.relative(cwd, projectRoot).replace(/\\/g, '/') || '.';
    const result = materializeProjectIfNeeded(projectRoot, `${trigger}: ${relativeRoot}`);
    if (result) {
      const state = readEffectiveState(projectRoot);
      startOneMcpReportBestEffort(projectRoot, state, `${trigger}: ${relativeRoot}`);
      return result;
    }
    const state = readEffectiveState(projectRoot);
    startOneMcpReportBestEffort(projectRoot, state, `${trigger}: ${relativeRoot}`);
  }
  return null;
}

function materializeFromProjectMemoryWrite(cwd, filePath) {
  const projectRoot = findProjectRootForHookFile(cwd, filePath);
  if (isPluginAuthoringRoot(projectRoot)) return null;

  const relativePath = projectRelativeHookPath(cwd, projectRoot, filePath);
  if (!isProjectMemoryWritePath(relativePath)) return null;

  const state = readEffectiveState(projectRoot);
  if (!state || !state.stack || !STACK_IDS.has(state.stack) || state.onboardingComplete !== true) {
    return null;
  }

  try {
    if (normalizeState(state, detectMode(projectRoot))) {
      writeState(projectRoot, state);
    }
    const materialized = materializeProjectAssets(projectRoot, state);
    if (!materialized.skipped) {
      state.materializedStack = stackFingerprint(state);
      state.materializedAt = nowIso();
      state.materializedVersion = getPluginVersion();
      writeState(projectRoot, state);
    }
    startOneMcpReportBestEffort(projectRoot, state, `project-memory write: ${relativePath}`);
    return materializationSuccessResult(materialized, relativePath);
  } catch (error) {
    return materializationFailureResult(error);
  }
}

function projectRootFromStateFilePath(filePath) {
  const absolute = path.resolve(filePath);
  const parent = path.dirname(absolute);
  if (path.basename(absolute) === '.one.json' && path.basename(parent) === '.traffic-one') {
    return path.dirname(parent);
  }
  return parent;
}

function isProjectMemoryWritePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('.traffic-one/')) return false;
  if (normalized.startsWith('.traffic-one/digests/')) return false;
  if (normalized.startsWith('.traffic-one/reports/')) return false;
  if (normalized.startsWith('.traffic-one/backups/')) return false;
  if (normalized.startsWith('.traffic-one/rules/')) return false;
  if (normalized.startsWith('.traffic-one/skills/')) return false;
  return normalized !== '.traffic-one/manifest.json';
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
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const data = parseJsonText(rawInput, {});

  // Opt-in per-tool token log (TRAFFIC_ONE_TOKEN_LOG=1). No-op when disabled.
  tokenLogger.logToolUse(process.cwd(), data);

  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command = commandFromToolInput(toolInput);
  if (!BUILD_COMMAND_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const state = readEffectiveState(process.cwd());
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
          '  node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/lighthouse-runner.mjs" --route /',
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
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const cwd = process.cwd();
  if (graphifyHintSentForCwd === cwd) {
    return { stdout: '', exitCode: 0 };
  }

  const state = readEffectiveState(cwd);
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
// builds; opt out by setting `graphifyAutoRun: false` in local preferences.
const GRAPHIFY_FRESH_MS  = 7 * 24 * 60 * 60 * 1000;
const GRAPHIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function runPostBuildGraphifyHint(rawInput) {
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command = commandFromToolInput(toolInput);
  if (!BUILD_COMMAND_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const cwd = process.cwd();
  const state = readEffectiveState(cwd);
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
    const { bootstrap } = require(path.resolve(__dirname, '..', '..', runnerFile));
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
          + 'on any Node) by updating local Traffic One preferences.';
      } else {
        additionalContext = `[gitnexus] Auto-bootstrap failed (${seconds}s): ${bootstrapResult.error || 'unknown error'}. `
          + 'Falling back to a manual hint — install + build once when convenient:\n'
          + '  npm install -g gitnexus   # or: npx gitnexus@latest analyze .\n'
          + '  gitnexus analyze\n'
          + 'License: PolyForm Noncommercial. Disable auto-bootstrap with `"codeGraphAutoRun": false` in local Traffic One preferences.';
      }
    } else {
      additionalContext = `[graphify] Auto-bootstrap failed (${seconds}s): ${bootstrapResult.error || 'unknown error'}. `
        + 'Falling back to a manual hint — install + build once when convenient:\n'
        + '  pipx install graphifyy   # or: python3 -m pip install --user graphifyy\n'
        + '  graphify update .\n'
        + '  graphify hook install    # optional: regenerate on every git commit\n'
        + 'To disable auto-bootstrap entirely, set `"codeGraphAutoRun": false` in local Traffic One preferences.';
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

// ── PostToolUse: stack-rules auto-load on `.traffic-one/.one.json` write ──────────
function runPostStackSetup(rawInput) {
  if (!isAuthenticatedLocal()) {
    return { stdout: '', exitCode: 0 };
  }

  const payload = parseJsonText(rawInput, null);
  if (!payload) return { stdout: '', exitCode: 0 };

  // Opt-in per-tool token log (TRAFFIC_ONE_TOKEN_LOG=1). No-op when disabled.
  tokenLogger.logToolUse(process.cwd(), payload);

  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  const cwd = process.cwd();
  const targetPath = filePath
    ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath))
    : '';
  const targetInsideCwd = targetPath && (targetPath === path.resolve(cwd) || targetPath.startsWith(`${path.resolve(cwd)}${path.sep}`));
  if (isPluginAuthoringRoot(cwd) && (!targetPath || targetInsideCwd)) {
    return { stdout: '', exitCode: 0 };
  }

  // PostToolUse may be configured broadly by different host runtimes. Dispatch:
  //   1. supabase/functions/<name>/index.ts            → runPostFunctionEdit (auto-deploy)
  //   2. .traffic-one/digests/<run-id>/<role>.md       → digest-size warning
  //   3. .traffic-one/.one.json                        → existing stack-rules auto-load
  //   4. project-memory writes                         → local materialization
  //   5. anything else                                 → converge from complete state if needed
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

  if (!isStateFilePath(filePath)) {
    const memoryResult = materializeFromProjectMemoryWrite(cwd, filePath);
    if (memoryResult) return memoryResult;
    const hintedResult = materializeFromToolInputHints(cwd, toolInput);
    if (hintedResult) return hintedResult;
    const materializedResult = materializeProjectIfNeeded(cwd, 'generic post-tool convergence');
    if (materializedResult) {
      const currentState = readEffectiveState(cwd);
      startOneMcpReportBestEffort(cwd, currentState, 'generic post-tool convergence');
      return materializedResult;
    }
    const currentState = readEffectiveState(cwd);
    startOneMcpReportBestEffort(cwd, currentState, 'generic post-tool convergence');
    return { stdout: '', exitCode: 0 };
  }
  if (!fs.existsSync(filePath))      return { stdout: '', exitCode: 0 };

  let state = safeReadJson(filePath, null);
  // Accept any state that has a valid project stack plus resolved local
  // preferences. Older model writes may still include local fields in
  // `.traffic-one/.one.json`; split those into the per-user preferences file
  // before validating the effective state.
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];
  const stateDirEarly = projectRootFromStateFilePath(filePath);
  let normalizedBeforeValidation = state && typeof state === 'object'
    ? normalizeState(state, detectMode(stateDirEarly))
    : false;
  let localSplit = { state, prefs: {}, changed: false };
  if (state && typeof state === 'object') {
    localSplit = splitLocalPreferences(stateDirEarly, state);
    state = localSplit.state;
  }
  const effectiveForValidation = state && typeof state === 'object'
    ? effectiveState(state, localSplit.prefs)
    : state;
  if (effectiveForValidation && typeof effectiveForValidation === 'object') {
    normalizedBeforeValidation = normalizeState(effectiveForValidation, detectMode(stateDirEarly))
      || normalizedBeforeValidation
      || localSplit.changed;
  }
  const cgProvider = effectiveForValidation && typeof effectiveForValidation.codeGraphProvider === 'string' ? effectiveForValidation.codeGraphProvider : null;
  const cgOk = cgProvider && validCodeGraphProviders.includes(cgProvider);
  const toolchainOk = effectiveForValidation && effectiveForValidation.toolchain && typeof effectiveForValidation.toolchain === 'object';
  const validationIssues = effectiveForValidation ? trafficOneStateValidationIssues(effectiveForValidation, validCodeGraphProviders) : [];

  if (!state || validationIssues.length > 0) {
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
      stack: state.stack || null,
      validStackIds,
      codeGraphProvider: cgProvider,
      validCodeGraphProviders,
      validationIssues,
    });
    let systemMessage;
    if (invalidStack) {
      systemMessage = `traffic-one — \`.traffic-one/.one.json\` has unknown stack id "${invalidStack}"; please re-write with a valid stack`;
    } else if (!state.stack) {
      systemMessage = 'traffic-one — `.traffic-one/.one.json` write incomplete (no `stack` field); please re-write with all 8 fields';
    } else if (cgProvider && !cgOk) {
      systemMessage = `traffic-one — local Traffic One preferences have unknown codeGraphProvider "${cgProvider}"; valid: gitnexus, graphify`;
    } else if (!toolchainOk) {
      systemMessage = 'traffic-one — local Traffic One preferences are missing required `toolchain` stamps; re-write with initialized toolchain';
    } else if (!cgProvider) {
      systemMessage = 'traffic-one — local Traffic One preferences are missing required `codeGraphProvider`; ask the user (gitnexus or graphify) and re-write';
    } else {
      systemMessage = 'traffic-one — `.traffic-one/.one.json` has invalid required fields; see validation issues and re-write';
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

  state = effectiveForValidation;

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
    if (materialized && materialized.skipped) {
      startOneMcpReportBestEffort(stateDirEarly, state, 'post-stack-setup skipped materialization');
      return { stdout: '', exitCode: 0 };
    }
    state.materializedStack   = stackFingerprint(state);
    state.materializedAt      = nowIso();
    state.materializedVersion = getPluginVersion();
    writeState(stateDirEarly, state);
  } catch {
    // best-effort; stamp failure should not block the user
  }

  startOneMcpReportBestEffort(stateDirEarly, state, 'post-stack-setup');

  const stack = state.stack || '(unknown)';
  // GitNexus is a local preference. Do not mutate project files such as
  // `.nvmrc` based on it; only surface the upgrade banner when needed:
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
      } = require(path.resolve(__dirname, '..', '..', 'gitnexus-runner.cjs'));

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
    ? `Project-local rules/skills materialized: ${materialized.rules} rule files, ${materialized.skills} skills. Root AGENTS.md contains the compact active rule kernel/index by default; root CLAUDE.md symlinks to AGENTS.md when safe.`
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

function runMaterializeProject(_rawInput = '') {
  if (isPluginAuthoringRoot(process.cwd())) {
    return { stdout: '', exitCode: 0 };
  }
  const authGate = authGateForHook();
  if (!authGate.authenticated) {
    if (authChoiceAllowsContinue()) return { stdout: '', exitCode: 0 };
    const writeResult = tryWriteAuthChoice('pending-choice', process.cwd());
    return authRequiredHookResult('PostToolUse', { authChoiceWrite: writeResult });
  }
  return materializeProjectFromState(process.cwd(), 'manual materialize-project');
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
  // Walk up to find the directory that owns Traffic One state or `package.json`
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, STATE_FILE)) ||
      fs.existsSync(path.join(dir, LEGACY_STATE_FILE)) ||
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
  const state = readEffectiveState(projectRoot);
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
        '  • "yes, auto-deploy"   → I update `.traffic-one/.one.json` to set',
        '       `supabaseFunctionsAutoDeploy: true` AND deploy this function once now',
        '       (`pnpm functions:deploy ' + functionName + '`). Future edits deploy silently.',
        '  • "ask each time"      → I leave the flag as "ask"; I\'ll prompt before',
        '       every deploy.',
        '  • "never"              → I set `supabaseFunctionsAutoDeploy: false`. No',
        '       auto-deploys; you run `pnpm functions:deploy <name>` yourself.',
        '',
        'You can change this later by editing `supabaseFunctionsAutoDeploy` in',
        '`.traffic-one/.one.json`.',
      ].join('\n'),
    },
  };
}

module.exports = {
  runPostBuildPageSpeed,
  runPostStackSetup,
  runMaterializeProject,
  runPostFunctionEdit,
  runPreGraphifyHint,
  runPostBuildGraphifyHint,
};
