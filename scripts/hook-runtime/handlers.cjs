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
  pluginRoot,
} = require('./config.cjs');

const {
  parseJsonText,
  safeReadJson,
  nowIso,
  readState,
  writeState,
  normalizeState,
} = require('./state.cjs');

const { STACKS } = require('./stacks.cjs');

const {
  listAllSkills,
  pruneSkillsDirective,
  pruneCacheSkills,
  restoreDisabledSkills,
} = require('./skill-filters.cjs');

const {
  loadPackageJson,
  dependenciesFromPackage,
  detectMode,
  detectStackFromCodebase,
} = require('./detection.cjs');

const { packBundle } = require('./packing.cjs');

const {
  onboardingDirectiveNewProject,
  autoDetectedAnnouncement,
  onboardingReminderShort,
  postWriteIncompleteWarning,
} = require('./directives.cjs');

// ── SessionStart ─────────────────────────────────────────────────────────────
function runSessionStart() {
  const cwd  = process.cwd();
  const root = pluginRoot();
  const state = readState(cwd);

  // MULTI-PROJECT SAFETY: always restore the full skill set before re-pruning.
  // The cache is shared across all traffic-one projects on this machine.
  restoreDisabledSkills();

  const mode = state.mode || detectMode(cwd);
  state.mode = mode;

  const stackId = state.stack;

  // Tolerate a partial state file (e.g. {stack, backend, realtime, version}
  // without onboardingComplete) — fill in defaults rather than re-running
  // onboarding. The user already picked a stack; we just complete bookkeeping.
  if (stackId && Object.prototype.hasOwnProperty.call(STACKS, stackId)) {
    normalizeState(state, mode);
  }

  const onboardingComplete = Boolean(state.onboardingComplete);

  // Flow 1 — already onboarded (or partial state with valid stack) → pack bundle
  if (onboardingComplete && Object.prototype.hasOwnProperty.call(STACKS, stackId)) {
    const spec = STACKS[stackId];

    // Splice in the mode-specific rule if it exists (e.g. modes/new-project.md
    // contains the Turborepo scaffold checklist that the model needs to see).
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath))
      ? [...spec.mandatory, modeRulePath]
      : spec.mandatory;

    const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

    const allSkills = listAllSkills();
    const removed = pruneCacheSkills(stackId);
    if (removed > 0) {
      state.skillsPruned = true;
      state.skillsPrunedCount = removed;
    }
    const skillDirective = pruneSkillsDirective(stackId, allSkills);

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} ═══\n`;
    if (dropped.length > 0) {
      header += `[${dropped.length} rule file(s) deferred to path-scoped attach]\n`;
    }
    if (skillDirective) {
      header += skillDirective;
    }
    const context = `${header}\n${body}`;
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
    if (detected.stack) {
      Object.assign(state, {
        mode,
        stack:                detected.stack,
        backend:              detected.backend || 'other',
        realtime:             detected.realtime || 'none',
        confirmed:            true,
        onboardingComplete:   true,
        confirmedAt:          nowIso(),
        autoDetected:         true,
        evidence:             detected.evidence,
      });

      if (detected.frontend) {
        state.frontend = detected.frontend;
      } else {
        delete state.frontend;
      }

      const spec = STACKS[detected.stack];

      // Splice in the mode-specific rule (e.g. modes/existing-codebase.md)
      const modeRulePath = `rules/modes/${mode}.md`;
      const modeMandatory = fs.existsSync(path.join(root, modeRulePath))
        ? [...spec.mandatory, modeRulePath]
        : spec.mandatory;

      const { body, dropped } = packBundle(root, modeMandatory, spec.optional, BUDGET_CHARS);

      const allSkills = listAllSkills();
      const removed = pruneCacheSkills(detected.stack);
      if (removed > 0) {
        state.skillsPruned = true;
        state.skillsPrunedCount = removed;
      }
      writeState(cwd, state);
      const skillDirective = pruneSkillsDirective(detected.stack, allSkills);

      const banner = autoDetectedAnnouncement(detected);
      let header = `═══ traffic-one — stack: ${detected.stack} · mode: ${mode} ═══\n`;
      if (dropped.length > 0) {
        header += `[${dropped.length} rule file(s) deferred]\n`;
      }
      if (skillDirective) {
        header += skillDirective;
      }
      const context = `${banner}\n\n${header}\n${body}`;
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
function runUserPromptSubmit() {
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
  const validStack = state.stack && Object.prototype.hasOwnProperty.call(STACKS, state.stack);
  const isIncomplete = !validStack || state.onboardingComplete !== true;

  // Re-inject the short onboarding reminder while a new project hasn't yet
  // persisted a valid stack. SessionStart's full directive can scroll out of
  // context across long onboarding turns or compaction; this keeps the model
  // pointed at the schema until `.traffic-one.json` is fully populated.
  if (isIncomplete && state.mode === 'new-project') {
    const reminder = onboardingReminderShort();
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [onboarding incomplete]',
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[ACTIVE STACK: ${stack}]\n\n${reminder}`,
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

// ── PreToolUse: architecture write/edit guard ────────────────────────────────
function readStack() {
  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  return typeof state.stack === 'string' ? state.stack : null;
}

function runCheckArchitectureWrite(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const filePath = (typeof toolInput.file_path === 'string' ? toolInput.file_path : '').replace(/\\/g, '/');
  const content =
    typeof toolInput.content === 'string'
      ? toolInput.content
      : typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : '';
  const stack = readStack();
  const isNative = RN_STACKS.has(stack);
  const violations = [];

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

function forbiddenForStack(stack, allowNextjs) {
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

  if (RN_STACKS.has(stack)) {
    return [...common, ...native];
  }
  if (WEB_STACKS.has(stack) || stack === null) {
    return [...common, ...web];
  }
  return common;
}

function runCheckLibraryAllowlist(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command  = typeof toolInput.command === 'string' ? toolInput.command : '';

  if (!INSTALL_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  const stack = typeof state.stack === 'string' ? state.stack : null;
  const hits = forbiddenForStack(stack, allowsNextjs(state)).filter(([pattern]) => new RegExp(pattern).test(command));

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
const BUILD_COMMAND_RE = /(^|[\s;&|])((pnpm|npm|yarn|bun)\s+(run\s+)?build|turbo\s+build|vite\s+build)(\s|$)/;

function runPostBuildPageSpeed(rawInput) {
  const data = parseJsonText(rawInput, {});
  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!BUILD_COMMAND_RE.test(command)) {
    return { stdout: '', exitCode: 0 };
  }

  const state = safeReadJson(path.join(process.cwd(), STATE_FILE), {});
  const stack = typeof state.stack === 'string' ? state.stack : null;
  const frontend = typeof state.frontend === 'string' ? state.frontend : null;
  const isWebStack =
    WEB_STACKS.has(stack) ||
    frontend === 'react' ||
    frontend === 'nextjs' ||
    stack === 'vite';
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

// ── PostToolUse: stack-rules auto-load on `.traffic-one.json` write ──────────
function runPostStackSetup(rawInput) {
  const payload = parseJsonText(rawInput, null);
  if (!payload) return { stdout: '', exitCode: 0 };

  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

  // PostToolUse on Write|Edit fires for ALL writes. Dispatch:
  //   1. supabase/functions/<name>/index.ts  → runPostFunctionEdit (auto-deploy)
  //   2. .traffic-one.json                  → existing stack-rules auto-load
  //   3. anything else                      → no-op
  if (filePath.replace(/\\/g, '/').match(FUNCTION_PATH_RE)) {
    const result = runPostFunctionEdit(filePath);
    if (result) {
      return { stdout: JSON.stringify(result), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }

  if (!filePath.endsWith(STATE_FILE)) return { stdout: '', exitCode: 0 };
  if (!fs.existsSync(filePath))      return { stdout: '', exitCode: 0 };

  const state = safeReadJson(filePath, null);
  // Accept any state that has a valid `stack` — the model sometimes writes a
  // partial file (no `onboardingComplete`). Normalize and treat it as complete.
  if (!state || !state.stack || !Object.prototype.hasOwnProperty.call(STACKS, state.stack)) {
    // Don't fail silently: when the model edits `.traffic-one.json` but leaves
    // `stack` missing or invalid, the rule bundle never loads and the user's
    // choice is never persisted. Emit a system message + reminder so the model
    // can self-correct in the same turn.
    if (!state) {
      return { stdout: '', exitCode: 0 };
    }
    const invalidStack = state.stack && !Object.prototype.hasOwnProperty.call(STACKS, state.stack)
      ? state.stack
      : null;
    const validStackIds = Object.keys(STACKS).filter((id) => id !== 'node-backend');
    const additionalContext = postWriteIncompleteWarning({
      stack: invalidStack,
      validStackIds,
    });
    const systemMessage = invalidStack
      ? `traffic-one — \`.traffic-one.json\` has unknown stack id "${invalidStack}"; please re-write with a valid stack`
      : 'traffic-one — `.traffic-one.json` write incomplete (no `stack` field); please re-write with all 7 fields';
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

  const stateDirEarly = path.dirname(path.resolve(filePath));
  if (normalizeState(state, detectMode(stateDirEarly))) {
    // Write back the completed state so subsequent hooks see a clean file.
    try {
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({ ...state, version: 2 }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // best-effort; even if write fails, still emit the rule bundle below
    }
  }

  const stack = state.stack || '(unknown)';
  const originalCwd = process.cwd();
  const stateDir    = path.dirname(path.resolve(filePath));
  let sessionResult;
  try {
    process.chdir(stateDir);
    sessionResult = runSessionStart();
  } catch {
    return { stdout: '', exitCode: 0 };
  } finally {
    process.chdir(originalCwd);
  }

  const parsed = parseJsonText(sessionResult.stdout || '', null);
  const bundle = parsed?.hookSpecificOutput?.additionalContext;
  if (typeof bundle !== 'string') return { stdout: '', exitCode: 0 };

  const banner = `═══ traffic-one — stack rules now active (${stack}) ═══\nContinue with the user's request applying these rules. No restart needed.\n\n`;
  const lines  = bundle.split(/\r?\n/);
  const firstRuleIndex = lines.findIndex((line) => line.startsWith('# ── rules/'));
  const bundleBody = firstRuleIndex >= 0 ? lines.slice(firstRuleIndex).join('\n') : bundle;
  const context = banner + bundleBody;

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
  runCheckArchitectureWrite,
  runCheckLibraryAllowlist,
  runPostBuildPageSpeed,
  runPostStackSetup,
  runPostFunctionEdit,  // exported for testing + entrypoint dispatch
  forbiddenForStack,    // exported for testing
};
