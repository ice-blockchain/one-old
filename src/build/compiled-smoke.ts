// src/build/compiled-smoke.ts
// Cutover-readiness smoke (run via `npm run smoke`). Runs the FULL cutover build
// (buildRuntime: tsc → scratch with tsconfig.build.json + copy module
// descriptors + write the legacy-named .cjs shims), then invokes the runtime
// THROUGH the legacy-path shims (scratch/hook-runtime.cjs,
// scratch/cursor-hook-runtime.cjs) under bare `node` and asserts an unauthed
// tool use is denied by the priority-0 auth gate in each host's wire shape.
// This proves — without touching scripts/ — that the TypeScript engine compiles
// to a working runtime AND the legacy-path entry naming dispatches correctly
// (the two biggest cutover risks). Non-destructive: the scratch dir is removed.
// Exits non-zero on any failure.

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildRuntime } from './build-runtime';
import { listModuleIdsWithDescriptor, listModuleSkillDocs } from './copy-module-assets';
import { exerciseEnv, exerciseRuntime, runShimAllowingBlock, type RuntimeExercisePins } from './exercise-runtime';

/** Raised by fail(); carries the already-formatted line the runner prints. */
export class SmokeFailure extends Error {}

// THROWS rather than exits. `process.exit()` unwinds nothing: every `finally`
// in this file — the one that removes the four scratch trees, and the one that
// puts `scratch/modules` back after the missing-modules section renames it
// away — was skipped on every failing run, so a smoke that failed left its
// temp trees behind and contradicted this file's own header ("Non-destructive:
// the scratch dir is removed"). Failure is still fail-fast and still exits
// non-zero; it just runs the cleanup it already had.
export function fail(msg: string): never {
  throw new SmokeFailure(`compiled-smoke: FAIL — ${msg}`);
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

// Run `body` with process.env overridden (an `undefined` value DELETES the var),
// restoring the exact prior state — absent vars included — afterwards.
// Needed because the compiled state API is also called IN-PROCESS here, and the
// consent write fence it consults (shared/state/plugin-use.ts's
// projectStateWriteAllowed) reads process.env directly: it takes no env
// argument, since in production the hook process's env IS the answer. So a
// fixture that hands an env object to the writer but leaves process.env alone
// would resolve the consent record from the DEVELOPER's machine.
function withProcessEnv<T>(overrides: Readonly<Record<string, string | undefined>>, body: () => T): T {
  const saved = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  const apply = (entries: readonly (readonly [string, string | undefined])[]): void => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(overrides));
  try {
    return body();
  } finally {
    apply(saved);
  }
}

// The bare-node shim invocation lives in exercise-runtime.ts, which
// plugin:sync's verify() calls too. Every remaining call site here is one whose
// host wire shape signals a deny THROUGH the exit status, so all of them want
// the non-throwing form.

interface AsyncShimResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Start a real bare-node shim process without awaiting it, so two lifecycle
// invocations can contend on the compiled on-disk CAS exactly as Cursor hooks do.
function runShimAsync(
  scratch: string,
  shim: string,
  subcommand: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<AsyncShimResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scratch, shim), subcommand], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      stderr += '\ncompiled-smoke: shim timed out after 20000ms';
      child.kill('SIGKILL');
    }, 20000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(null);
    });
    child.on('close', (status) => finish(status));
    child.stdin.end(stdin);
  });
}

// Temp trees created part-way through the run, collected so the single finally
// below removes them however the run ends. The four per-host project cwds used
// to be removed on the last line of the success path only, which is the one
// path that did not need it.
const strayScratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  strayScratch.push(dir);
  return dir;
}

async function main(): Promise<void> {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-'));
  // Mirror an installed plugin layout: <plugin>/scripts/*.cjs. This matters for
  // generated recovery commands, which must point at a real shipped runner.
  const pluginRoot = path.join(scratchRoot, 'plugin');
  const scratch = path.join(pluginRoot, 'scripts');
  fs.mkdirSync(scratch, { recursive: true });
  const authTmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-auth-'));
  const onboardingTmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-onboarding-'));
  const cursorConcurrencyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-cursor-concurrency-'));
  try {
    // 1. Full cutover build: compile + descriptors + legacy-named shims.
    const built = buildRuntime(scratch);
    // src/dist module-set EQUALITY, not a floor: `modulesCopied` used to count
    // files (module.json + each skill/*.md landed in the same `copied` array),
    // so a module shipping 2 prose files was silently counted as 2 modules —
    // this would have passed even with a broken copy that dropped a whole
    // module, as long as some other module shipped enough extra skill files to
    // clear the floor. Compare the actual module-id sets instead: every module
    // in src/modules/ that ships a descriptor must be present in the built
    // tree, and nothing extra may be.
    //
    // Both sides use the same predicate but must read DIFFERENT trees. The
    // built side is read back OFF DISK, not taken from `built.moduleIds`:
    // that set is populated inside copyModuleDescriptors' own loop over
    // src/modules, so comparing it against a src/modules listing compared
    // source with source — deleting the copyFileSync that writes the
    // descriptor left this check green.
    const srcModulesDir = path.join(__dirname, '..', 'modules');
    const builtModulesDir = path.join(scratch, 'modules');
    const srcModuleIds = listModuleIdsWithDescriptor(srcModulesDir);
    const builtModuleIds = listModuleIdsWithDescriptor(builtModulesDir);
    const missingModules = [...srcModuleIds].filter((id) => !builtModuleIds.has(id)).sort();
    const extraModules = [...builtModuleIds].filter((id) => !srcModuleIds.has(id)).sort();
    if (missingModules.length > 0 || extraModules.length > 0) {
      fail(`built module set does not match src/modules/: missing [${missingModules.join(', ')}], extra [${extraModules.join(', ')}]`);
    }

    // Gate prose is copied by a SECOND loop inside copyModuleDescriptors that
    // nothing compared, and no runtime assertion can cover it: every gate's TS
    // fallback is byte-identical to its T1BLOCK block on purpose (a missing
    // block must never change the deny wording), so a deny rendered from the
    // fallback and one rendered from the shipped SKILL.md are indistinguishable
    // downstream. The only place the difference is observable is here, on
    // disk — so assert the files arrived, byte for byte.
    const srcDocs = new Map(listModuleSkillDocs(srcModulesDir).map((doc) => [toPosix(doc.relPath), doc.absPath]));
    const builtDocs = new Map(listModuleSkillDocs(builtModulesDir).map((doc) => [toPosix(doc.relPath), doc.absPath]));
    const missingProse = [...srcDocs.keys()].filter((rel) => !builtDocs.has(rel)).sort();
    const extraProse = [...builtDocs.keys()].filter((rel) => !srcDocs.has(rel)).sort();
    if (missingProse.length > 0 || extraProse.length > 0) {
      fail(`built gate prose does not match src/modules/: missing [${missingProse.join(', ')}], extra [${extraProse.join(', ')}] — every install would ship the TS fallback wording instead`);
    }
    const driftedProse = [...srcDocs.entries()]
      .filter(([rel, abs]) => !fs.readFileSync(abs).equals(fs.readFileSync(builtDocs.get(rel)!)))
      .map(([rel]) => rel)
      .sort();
    if (driftedProse.length > 0) fail(`built gate prose differs byte-wise from src/modules/: ${driftedProse.join(', ')}`);
    // A descriptor with no prose is normal (only the gate modules author
    // any); prose with no descriptor is not — the registry's readdir
    // discovery keys off module.json, so that skill/ dir would ship dead.
    const orphanProse = [...new Set([...builtDocs.keys()].map((rel) => rel.split('/')[0]!))]
      .filter((id) => !builtModuleIds.has(id))
      .sort();
    if (orphanProse.length > 0) fail(`built tree ships gate prose for modules with no descriptor: ${orphanProse.join(', ')}`);

    // 2. Invoke through the legacy-path shims under bare node. UNAUTHENTICATED
    //    tool use must be denied, in each host's own wire shape.
    //
    //    The assertions themselves live in exercise-runtime.ts, because
    //    plugin:sync's per-host verify() runs the SAME exercise against the
    //    bundle each host actually serves — an installed runtime that loads and
    //    reaches a named gate is a far stronger reading of "install-verifiable"
    //    than the package.json version that command used to stat. What stays
    //    here is the fixture: the scratch install, the pinned paths, and the
    //    consent answer.
    //
    //    The fixture must ANSWER the use-plugin question for any of this to be
    //    about auth. On an unanswered project the ask-first branch denies every
    //    one of these calls before auth is ever consulted, so each host check
    //    went green off a deny that has nothing to do with authentication: they
    //    passed identically with auth switched off, and would keep passing if
    //    the priority-0 auth gate were deleted outright. Consent moves the deny
    //    back onto the gate the assertions name — confirmed by the auth-off
    //    control inside the exercise, which stops being denied precisely
    //    because auth was the only thing objecting.
    const authHome = path.join(authTmp, 'home');
    fs.mkdirSync(authHome, { recursive: true });
    const pins: RuntimeExercisePins = {
      base: process.env,
      home: authHome,
      pluginRoot,
      statePath: path.join(authTmp, 'one.json'),
      projectPrefsPath: path.join(authTmp, 'prefs.json'),
      consent: 'recorded-consent',
    };
    const env = exerciseEnv(pins);

    const claudeCwd = scratchDir('t1-smoke-claude-');
    const cursorCwd = scratchDir('t1-smoke-cursor-');
    const windsurfCwd = scratchDir('t1-smoke-windsurf-');
    const devinCwd = scratchDir('t1-smoke-devin-');

    // One record covers all four: TRAFFIC_ONE_PROJECT_PREFS_PATH pins a single
    // prefs FILE, and projectPrefsPath returns it without consulting cwd, so the
    // four hosts share the one answer they all read. Recorded through the same
    // compiled entry point production's `--use` answer calls.
    const compiledAuthPluginUse = require(path.join(scratch, 'shared', 'state', 'plugin-use.js')) as {
      recordPluginUseChoice(cwd: string, enabled: boolean, source: string, env?: NodeJS.ProcessEnv): void;
    };
    withProcessEnv(
      { HOME: authHome, XDG_STATE_HOME: undefined, TRAFFIC_ONE_ASK_USE_PLUGIN: undefined, TRAFFIC_ONE_PROJECT_PREFS_PATH: env.TRAFFIC_ONE_PROJECT_PREFS_PATH },
      () => compiledAuthPluginUse.recordPluginUseChoice(claudeCwd, true, 'compiled-smoke', process.env),
    );

    const exercise = exerciseRuntime({
      scripts: scratch,
      pins,
      projects: { claude: claudeCwd, cursor: cursorCwd, windsurf: windsurfCwd, devin: devinCwd },
    });
    if (exercise.problem) fail(exercise.problem);
    // "No leg objected" and "no leg ran" are the same null otherwise, and a
    // shim-discovery change would silently turn this whole section into a
    // no-op that still prints PASS.
    if (exercise.exercised.length === 0) fail('the runtime exercise reached no host');

    // 3. Regression: Codex hooks run inside a workspace-only sandbox, while
    //    private onboarding state is intentionally user-local. Inject a real
    //    EPERM for writes beneath canonical ~/.traffic-one, omit the test-only
    //    NO_SPAWN escape hatch, and invoke the BUILT host shim. The hook must
    //    fail closed with the exact approved bootstrap recovery path; it must
    //    never return an empty success or write private state locally.
    const onboardingHome = path.join(onboardingTmp, 'home');
    const onboardingProject = path.join(onboardingTmp, 'project');
    fs.mkdirSync(onboardingHome, { recursive: true });
    fs.mkdirSync(path.join(onboardingProject, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      path.join(onboardingProject, '.traffic-one', '.one.json'),
      JSON.stringify({ version: 1, mode: 'new-project', onboardingComplete: false }),
      'utf8',
    );
    const blockedUserState = path.join(onboardingHome, '.traffic-one');
    const epermPreload = path.join(onboardingTmp, 'deny-user-state.cjs');
    fs.writeFileSync(epermPreload, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const blocked = path.resolve(process.env.TRAFFIC_ONE_SMOKE_BLOCKED_PATH);",
      "function filePath(value) { return typeof value === 'string' ? value : (Buffer.isBuffer(value) ? value.toString() : ''); }",
      "function isBlocked(value) { const raw = filePath(value); if (!raw) return false; const resolved = path.resolve(raw); return resolved === blocked || resolved.startsWith(blocked + path.sep); }",
      "function deny(syscall, value) { const target = filePath(value); const error = new Error(`EPERM: operation not permitted, ${syscall} '${target}'`); error.code = 'EPERM'; error.errno = -1; error.syscall = syscall; error.path = target; throw error; }",
      "function wrap(name, blockedArg = 0) { const original = fs[name]; fs[name] = function (...args) { if (isBlocked(args[blockedArg])) deny(name, args[blockedArg]); return original.apply(this, args); }; }",
      "for (const name of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'chmodSync']) wrap(name);",
      "const originalRename = fs.renameSync; fs.renameSync = function (from, to) { if (isBlocked(from)) deny('renameSync', from); if (isBlocked(to)) deny('renameSync', to); return originalRename.apply(this, arguments); };",
      "const originalOpen = fs.openSync; fs.openSync = function (target, flags) { const writes = typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wax+]/.test(String(flags)); if (writes && isBlocked(target)) deny('openSync', target); return originalOpen.apply(this, arguments); };",
      '',
    ].join('\n'), 'utf8');

    const onboardingEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: onboardingHome,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${epermPreload}`].filter(Boolean).join(' '),
      TRAFFIC_ONE_AUTH: 'off',
      TRAFFIC_ONE_ASK_USE_PLUGIN: 'off',
      TRAFFIC_ONE_HOST: 'codex',
      TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot,
      TRAFFIC_ONE_SMOKE_BLOCKED_PATH: blockedUserState,
    };
    for (const key of [
      'XDG_STATE_HOME',
      'TRAFFIC_ONE_PROJECT_PREFS_PATH',
      'TRAFFIC_ONE_STATE_PATH',
      'TRAFFIC_ONE_ONBOARDING_NO_SPAWN',
      'TRAFFIC_ONE_ONBOARDING_SERVER_ENTRY',
    ]) delete onboardingEnv[key];
    if ('TRAFFIC_ONE_ONBOARDING_NO_SPAWN' in onboardingEnv) fail('onboarding regression accidentally retained NO_SPAWN');

    const codexBlocked = runShimAllowingBlock(
      scratch,
      'hook-runtime.cjs',
      'check-onboarding-gate',
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'exec_command',
        tool_input: { cmd: 'pwd', workdir: onboardingProject },
        cwd: onboardingProject,
        session_id: 'compiled-smoke-codex-main',
      }),
      onboardingEnv,
    );
    if (codexBlocked.status !== 0) fail(`Codex onboarding gate exited ${codexBlocked.status}: ${codexBlocked.stderr}`);
    let codexOnboardingOut: Record<string, any>;
    try {
      codexOnboardingOut = JSON.parse(codexBlocked.stdout || '{}') as Record<string, any>;
    } catch {
      fail(`Codex onboarding gate emitted invalid JSON: ${codexBlocked.stdout}`);
    }
    const decision = codexOnboardingOut.hookSpecificOutput?.permissionDecision;
    const reason = String(codexOnboardingOut.hookSpecificOutput?.permissionDecisionReason || '');
    const codexEvidence = String(codexOnboardingOut.hookSpecificOutput?.additionalContext || '');
    if (decision !== 'deny') fail('built Codex hook did not fail closed when ~/.traffic-one was unavailable');
    if (!codexEvidence.startsWith('<!-- traffic-one-hook-context:v1 event=PreToolUse -->')) {
      fail('built Codex hook context did not carry the versioned provenance marker');
    }
    if (!reason.includes('(EPERM)')) fail('built Codex deny did not preserve the canonical user-state EPERM');
    if (!reason.includes('TRAFFIC_ONE_SETUP_READY') || !reason.includes('Setup link:')) {
      fail('built Codex deny did not explain how the approved bootstrap returns the live setup link');
    }
    if (!reason.includes('sandbox_permissions: "require_escalated"') || !reason.includes('~/.traffic-one/projects')) {
      fail('built Codex deny did not request narrowly approved access to canonical user-local state');
    }
    const builtWaiter = path.join(pluginRoot, 'scripts', 'onboarding-wait.cjs');
    if (!fs.existsSync(builtWaiter)) fail('compiled onboarding waiter is missing from the scratch plugin install');
    if (!reason.includes(`node '${builtWaiter}' '--bootstrap-only'`)) {
      fail('built Codex deny did not point at its shipped --bootstrap-only waiter command');
    }
    for (const privateFile of ['preferences.json', 'machine.json']) {
      if (fs.existsSync(path.join(onboardingProject, '.traffic-one', privateFile))) {
        fail(`built Codex hook leaked ${privateFile} into the project`);
      }
    }

    // Execute the command emitted by the BUILT quoting implementation through a
    // real POSIX shell. A preload records process.argv before the waiter runs, so
    // this proves spaces and shell metacharacters remain one inert cwd argument
    // rather than merely proving that our classifier accepts its own output.
    const quotedProject = path.join(onboardingTmp, "project ($draft); owner's app");
    const quotedHome = path.join(onboardingTmp, 'quoted-home');
    const argvCapture = path.join(onboardingTmp, 'quoted-bootstrap-argv.json');
    const argvPreload = path.join(onboardingTmp, 'capture-bootstrap-argv.cjs');
    fs.mkdirSync(quotedProject, { recursive: true });
    fs.mkdirSync(quotedHome, { recursive: true });
    fs.writeFileSync(argvPreload, [
      "'use strict';",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.TRAFFIC_ONE_SMOKE_ARGV_CAPTURE, JSON.stringify(process.argv.slice(1)), 'utf8');",
      '',
    ].join('\n'), 'utf8');

    const previousPluginRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = pluginRoot;
    try {
      const builtWaitCommands = require(path.join(scratch, 'shared', 'onboarding-server', 'wait-command.js')) as {
        onboardingBootstrapCommand(cwd: string, host: string): string;
        onboardingUseBootstrapCommand(cwd: string, host: string, seedPrompt?: string): string;
        onboardingWaitCommand(cwd: string, host: string): string;
        onboardingSetTechCommand(cwd: string, host: string, tech: Record<string, string>): string;
      };
      const builtClassifier = require(path.join(scratch, 'shared', 'tool-classify.js')) as {
        isOnboardingBootstrapCommand(toolName: unknown, toolInput: unknown): boolean;
        isOnboardingWaitCommand(toolName: unknown, toolInput: unknown): boolean;
        isOnboardingSetTechCommand(toolName: unknown, toolInput: unknown): boolean;
      };
      const quotedBootstrap = builtWaitCommands.onboardingBootstrapCommand(quotedProject, 'codex');
      if (!builtClassifier.isOnboardingWaitCommand('exec_command', { command: quotedBootstrap })) {
        fail('built classifier rejected its metacharacter-safe bootstrap command');
      }
      if (!builtClassifier.isOnboardingBootstrapCommand('exec_command', { command: quotedBootstrap })) {
        fail('built classifier did not identify its metacharacter-safe bootstrap command');
      }
      // The ask-first yes recipe's link-first command (--use --bootstrap-only) must
      // stay classifier-approved in the COMPILED bundle, and as a bootstrap (exit-fast).
      const quotedUseBootstrap = builtWaitCommands.onboardingUseBootstrapCommand(quotedProject, 'codex');
      if (!builtClassifier.isOnboardingWaitCommand('exec_command', { command: quotedUseBootstrap })) {
        fail('built classifier rejected its --use --bootstrap-only command');
      }
      if (!builtClassifier.isOnboardingBootstrapCommand('exec_command', { command: quotedUseBootstrap })) {
        fail('built classifier did not treat --use --bootstrap-only as a bootstrap invocation');
      }
      // The seeded yes command (--seed-prompt carries the user's request, quotes
      // included) must survive quoting AND classify in the COMPILED bundle — this
      // is how the ask-first flow defers all state writes to the recorded yes.
      const quotedSeeded = builtWaitCommands.onboardingUseBootstrapCommand(
        quotedProject, 'codex', "build the user's learning platform (v2); responsive",
      );
      if (!quotedSeeded.includes('--seed-prompt=')) {
        fail('built wait-command dropped the --seed-prompt argument');
      }
      if (!builtClassifier.isOnboardingWaitCommand('exec_command', { command: quotedSeeded })) {
        fail('built classifier rejected the seeded --use --bootstrap-only command');
      }
      if (!builtClassifier.isOnboardingBootstrapCommand('exec_command', { command: quotedSeeded })) {
        fail('built classifier did not treat the seeded yes command as a bootstrap invocation');
      }
      // The agent tech-classification command (metachar-heavy evidence included)
      // must survive quoting AND classify in the COMPILED bundle — this is how an
      // undetectable existing repo gets its identity from the session agent.
      const quotedSetTech = builtWaitCommands.onboardingSetTechCommand(quotedProject, 'codex', {
        frontend: 'none',
        backend: 'node',
        evidence: "express + mongoose in package.json; it's an API",
      });
      if (!builtClassifier.isOnboardingSetTechCommand('exec_command', { command: quotedSetTech })) {
        fail('built classifier rejected its metacharacter-safe --set-tech command');
      }
      if (builtClassifier.isOnboardingBootstrapCommand('exec_command', { command: quotedSetTech })) {
        fail('built classifier mis-treated --set-tech as a bootstrap invocation');
      }

      const quotedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: quotedHome,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${argvPreload}`].filter(Boolean).join(' '),
        TRAFFIC_ONE_AUTH: 'off',
        TRAFFIC_ONE_HOST: 'codex',
        TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1',
        TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot,
        TRAFFIC_ONE_SMOKE_ARGV_CAPTURE: argvCapture,
      };
      for (const key of [
        'XDG_STATE_HOME',
        'TRAFFIC_ONE_PROJECT_PREFS_PATH',
        'TRAFFIC_ONE_STATE_PATH',
      ]) delete quotedEnv[key];
      const quotedRun = spawnSync('/bin/sh', ['-c', quotedBootstrap], {
        cwd: onboardingTmp,
        encoding: 'utf8',
        env: quotedEnv,
        timeout: 20000,
      });
      if (quotedRun.status === null) fail(`quoted bootstrap command did not exit: ${quotedRun.error?.message || quotedRun.stderr}`);
      let capturedArgv: unknown;
      try {
        capturedArgv = JSON.parse(fs.readFileSync(argvCapture, 'utf8')) as unknown;
      } catch {
        fail(`quoted bootstrap command never reached its built waiter: ${quotedRun.stderr || quotedRun.stdout}`);
      }
      const expectedArgv = [
        path.join(scratch, 'onboarding-wait.cjs'),
        '--bootstrap-only',
        quotedProject,
        '--host=codex',
      ];
      if (JSON.stringify(capturedArgv) !== JSON.stringify(expectedArgv)) {
        fail(`shell changed quoted bootstrap argv: expected ${JSON.stringify(expectedArgv)}, got ${JSON.stringify(capturedArgv)}`);
      }

      // 3b. Claude background-wait deny in the COMPILED bundle: a backgrounded
      //     waiter buries the printed setup link in a task file, so the built
      //     gate must deny it EVERY time and prescribe the identical command in
      //     the foreground. Control: the same call without the flag must never
      //     be blamed for backgrounding.
      const bgProject = path.join(onboardingTmp, 'claude-bg-project');
      fs.mkdirSync(path.join(bgProject, '.traffic-one'), { recursive: true });
      fs.writeFileSync(
        path.join(bgProject, '.traffic-one', '.one.json'),
        JSON.stringify({ version: 1, mode: 'new-project', onboardingComplete: false }),
        'utf8',
      );
      const bgWait = builtWaitCommands.onboardingWaitCommand(bgProject, 'claude');
      // HOME is pinned even though the deletions below already redirect the two
      // pinned paths: the per-user prefs default to ~/.traffic-one/projects/<hash>,
      // so an unpinned HOME leaves these calls reading — and, on any future code
      // path that records rather than reads, WRITING — the developer's own
      // machine state. The smoke must be inert on the machine that runs it.
      const bgHome = path.join(onboardingTmp, 'claude-bg-home');
      fs.mkdirSync(bgHome, { recursive: true });
      const bgEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: bgHome,
        TRAFFIC_ONE_AUTH: 'off',
        TRAFFIC_ONE_ASK_USE_PLUGIN: 'off',
        TRAFFIC_ONE_HOST: 'claude',
        TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1',
        TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot,
      };
      for (const key of [
        'XDG_STATE_HOME',
        'TRAFFIC_ONE_PROJECT_PREFS_PATH',
        'TRAFFIC_ONE_STATE_PATH',
      ]) delete bgEnv[key];
      const invokeClaudeGate = (toolInput: Record<string, unknown>): Record<string, any> => {
        const run = runShimAllowingBlock(scratch, 'hook-runtime.cjs', 'check-onboarding-gate', JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: toolInput,
          cwd: bgProject,
          session_id: 'compiled-smoke-claude-bg',
        }), bgEnv);
        if (run.status !== 0) fail(`Claude wait gate exited ${run.status}: ${run.stderr}`);
        try {
          return JSON.parse(run.stdout || '{}') as Record<string, any>;
        } catch {
          fail(`Claude wait gate emitted invalid JSON: ${run.stdout}`);
        }
      };
      const bgOut = invokeClaudeGate({ command: bgWait, run_in_background: true });
      if (bgOut.hookSpecificOutput?.permissionDecision !== 'deny') fail('built Claude gate did not deny a backgrounded waiter');
      const bgReason = String(bgOut.hookSpecificOutput?.permissionDecisionReason || '');
      if (!bgReason.includes('run_in_background: false')) fail('built Claude background deny did not prescribe the foreground re-run');
      if (!bgReason.includes(bgWait)) fail('built Claude background deny did not carry the identical command to re-run');
      const fgOut = invokeClaudeGate({ command: bgWait });
      if (String(fgOut.hookSpecificOutput?.permissionDecisionReason || '').includes('requested with run_in_background: true')) {
        fail('built Claude gate blamed a foreground waiter for backgrounding');
      }

      // 3c. The Stop backstop in the COMPILED bundle: a turn ending with setup
      //     pending and a live wizard blocks with the link; stop_hook_active
      //     passes (one forced continuation per turn, never a livelock).
      const stopPrefs = path.join(onboardingTmp, 'stop-prefs.json');
      const stopEnv: NodeJS.ProcessEnv = { ...bgEnv, TRAFFIC_ONE_PROJECT_PREFS_PATH: stopPrefs };
      const builtRegistry = require(path.join(scratch, 'shared', 'onboarding-server', 'registry.js')) as {
        writeServerRecord(cwd: string, record: Record<string, unknown>, env: NodeJS.ProcessEnv, host: string): void;
      };
      builtRegistry.writeServerRecord(
        bgProject,
        { pid: process.pid, port: 55223, token: 'smoke-stop', url: 'http://127.0.0.1:55223/?t=smoke-stop', startedAt: 'x' },
        stopEnv,
        'claude',
      );
      const invokeStop = (rawExtra: Record<string, unknown>): { status: number | null; stdout: string; stderr: string } =>
        runShimAllowingBlock(scratch, 'hook-runtime.cjs', 'onboarding-stop', JSON.stringify({
          hook_event_name: 'Stop',
          cwd: bgProject,
          session_id: 'compiled-smoke-claude-stop',
          ...rawExtra,
        }), stopEnv);
      const stopRun = invokeStop({});
      if (stopRun.status !== 0) fail(`Claude Stop backstop exited ${stopRun.status}: ${stopRun.stderr}`);
      let stopOut: Record<string, any>;
      try {
        stopOut = JSON.parse(stopRun.stdout || '{}') as Record<string, any>;
      } catch {
        fail(`Claude Stop backstop emitted invalid JSON: ${stopRun.stdout}`);
      }
      if (stopOut.decision !== 'block') fail('built Claude Stop backstop did not block a pending-setup turn end');
      if (!String(stopOut.reason || '').includes('onboarding/agent#p=55223&t=smoke-stop')) {
        fail('built Claude Stop block did not carry the live setup link');
      }
      const stopActive = invokeStop({ stop_hook_active: true });
      if (stopActive.status !== 0 || (stopActive.stdout || '').trim() !== '') {
        fail('stop_hook_active must pass silently — one forced continuation per turn');
      }
    } finally {
      if (previousPluginRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
      else process.env.TRAFFIC_ONE_PLUGIN_ROOT = previousPluginRoot;
    }

    // 4. Compiled Cursor lifecycle concurrency: finalize two role failures under
    //    one parent with the compiled state API, then start Stop and SubagentStop
    //    as separate bare-node processes. One process must atomically own the
    //    complete parent batch; the loser must emit exactly {}. A replay proves
    //    that the at-most-once markers survived process exit on disk.
    const cursorProject = path.join(cursorConcurrencyTmp, 'project');
    const cursorHome = path.join(cursorConcurrencyTmp, 'home');
    const cursorProjects = path.join(cursorConcurrencyTmp, 'cursor-projects');
    const cursorRunId = 'compiled-smoke-cursor-concurrency';
    const cursorParentId = 'compiled-smoke-cursor-parent';
    fs.mkdirSync(path.join(cursorProject, '.traffic-one'), { recursive: true });
    fs.mkdirSync(cursorHome, { recursive: true });
    fs.mkdirSync(cursorProjects, { recursive: true });
    fs.writeFileSync(path.join(cursorProject, '.traffic-one', '.one.json'), `${JSON.stringify({
      version: 1,
      mode: 'existing-codebase',
      stack: 'default',
      onboardingComplete: true,
      currentRunId: cursorRunId,
    })}\n`, 'utf8');

    // ONE env for both sides of this section. The lifecycle hooks below are real
    // bare-node processes that get this object; the fixture calls run in THIS
    // process and get the same values pinned onto process.env. They must agree,
    // because both resolve the same per-project consent record — a fixture that
    // consented somewhere the hooks don't read would leave the hooks writing
    // nothing, silently, which is the exact failure mode being characterized.
    //
    // HOME + TRAFFIC_ONE_PROJECT_PREFS_PATH are what keep that record inside the
    // scratch dir: the "use Traffic One here?" answer lives in the PER-USER
    // prefs (~/.traffic-one/projects/<hash>/preferences.json), never in the
    // project, so an unpinned run would write a consent row into the developer's
    // real machine state. TRAFFIC_ONE_ASK_USE_PLUGIN is DELETED rather than set:
    // this section is the only place the compiled fence is exercised, and it has
    // to be exercised on the shipped default, not on whatever a developer shell
    // happens to export.
    const cursorLifecycleEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: cursorHome,
      TRAFFIC_ONE_AUTH: 'off',
      TRAFFIC_ONE_HOST: 'cursor',
      TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot,
      CURSOR_PLUGIN_ROOT: pluginRoot,
      TRAFFIC_ONE_CURSOR_PROJECTS_DIR: cursorProjects,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cursorConcurrencyTmp, 'preferences.json'),
      TRAFFIC_ONE_STATE_PATH: path.join(cursorConcurrencyTmp, 'machine.json'),
    };
    delete cursorLifecycleEnv.NODE_OPTIONS;
    delete cursorLifecycleEnv.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
    delete cursorLifecycleEnv.XDG_STATE_HOME;
    delete cursorLifecycleEnv.TRAFFIC_ONE_ASK_USE_PLUGIN;
    // Read back OUT of the child env, so the two can never drift apart.
    const cursorFixtureEnv = Object.fromEntries([
      'HOME',
      'XDG_STATE_HOME',
      'TRAFFIC_ONE_ASK_USE_PLUGIN',
      'TRAFFIC_ONE_PROJECT_PREFS_PATH',
      'TRAFFIC_ONE_STATE_PATH',
    ].map((key) => [key, cursorLifecycleEnv[key]]));

    const compiledCursorState = require(path.join(scratch, 'shared', 'state', 'index.js')) as {
      recordCursorSpawnObservation(cwd: string, runId: string, input: Record<string, unknown>): Record<string, any> | null;
      claimCursorSpawnObservation(cwd: string, runId: string, toolCallId: string, childTranscriptId: string, nowMs?: number): Record<string, any> | null;
      updateCursorSpawnObservation(cwd: string, runId: string, childTranscriptId: string, patch: Record<string, unknown>, nowMs?: number): Record<string, any> | null;
      consumeCursorSpawnObservation(cwd: string, runId: string, childTranscriptId: string, nowMs?: number): Record<string, any> | null;
      listCursorSpawnObservations(cwd: string, runId: string): Array<Record<string, any>>;
    };
    // Not re-exported by shared/state/index.js — required by its own path, which
    // is also what makes it the SAME module instance shared/fsjson.js lazily
    // requires for the fence, so a consent recorded here is the consent the
    // fence reads.
    const compiledPluginUse = require(path.join(scratch, 'shared', 'state', 'plugin-use.js')) as {
      recordPluginUseChoice(cwd: string, enabled: boolean, source: string, env?: NodeJS.ProcessEnv): void;
    };
    const finalizedRoles = [
      { role: 'senior-backend', toolCallId: 'tool_compiled_backend', childId: 'child-compiled-backend', model: 'compiled-backend-model' },
      { role: 'senior-frontend', toolCallId: 'tool_compiled_frontend', childId: 'child-compiled-frontend', model: 'compiled-frontend-model' },
    ];
    const fixtureStartedAt = Date.now() - 5_000;
    const cursorSpawnsFile = path.join(cursorProject, '.traffic-one', 'runs', cursorRunId, 'cursor-spawns.json');
    const spawnObservationInput = (item: typeof finalizedRoles[number], index: number): Record<string, unknown> => ({
      parentSessionId: cursorParentId,
      toolCallId: item.toolCallId,
      role: item.role,
      requestedModel: item.model,
      tier: 'balanced',
      expectedModel: item.model,
      startedAtMs: fixtureStartedAt + index,
    });

    withProcessEnv(cursorFixtureEnv, () => {
      // The fence FIRST, on the compiled runtime, before consent exists. This is
      // the only place it is exercised compiled, and it is what stops the two
      // halves below from being mutually compensating: without it, deleting the
      // fence would leave this section green, and the consent recording would
      // read as ceremony.
      compiledCursorState.recordCursorSpawnObservation(
        cursorProject, cursorRunId, spawnObservationInput(finalizedRoles[0]!, 0),
      );
      if (fs.existsSync(cursorSpawnsFile)) {
        fail('the compiled consent fence let a reuse-registry write land on a project whose use-plugin question is unanswered');
      }

      // Now consent, through the SAME call production's `--use` answer makes
      // (runners/onboarding-wait/wizard-output.ts's applyUseChoice). A project
      // in which agents are spawning has necessarily already answered yes — the
      // onboarding gate denies every mutating tool before that point — so a
      // fixture that skips this is not a realistic project, it is a project the
      // product would never have let get this far.
      compiledPluginUse.recordPluginUseChoice(cursorProject, true, 'compiled-smoke', process.env);
      const recordedConsent = path.join(cursorConcurrencyTmp, 'preferences.json');
      if (!fs.existsSync(recordedConsent)) fail('compiled consent recording wrote no per-user prefs file');

      for (const [index, item] of finalizedRoles.entries()) {
        const recorded = compiledCursorState.recordCursorSpawnObservation(
          cursorProject, cursorRunId, spawnObservationInput(item, index),
        );
        if (!recorded) fail(`compiled cursor fixture did not record ${item.role}`);
        const claimed = compiledCursorState.claimCursorSpawnObservation(
          cursorProject, cursorRunId, item.toolCallId, item.childId, fixtureStartedAt + 100 + index,
        );
        if (!claimed) fail(`compiled cursor fixture did not claim ${item.role}'s child transcript`);
        const updated = compiledCursorState.updateCursorSpawnObservation(cursorProject, cursorRunId, item.childId, {
          outcome: 'generic',
          error: `compiled generic failure for ${item.role}`,
          directive: `compiled pending directive for ${item.role}`,
          prescribedModel: null,
        }, fixtureStartedAt + 200 + index);
        if (!updated) fail(`compiled cursor fixture did not persist ${item.role}'s failure`);
        const consumed = compiledCursorState.consumeCursorSpawnObservation(
          cursorProject, cursorRunId, item.childId, fixtureStartedAt + 300 + index,
        );
        if (!consumed?.consumedAtMs) fail(`compiled cursor fixture did not finalize ${item.role}'s failure`);
      }
      // Read back off DISK, not from the calls above. Those four now answer null
      // on a refused store publish (cursor-observations.ts), so the `if (!…) fail`
      // guards above are a refusal check as well — but they are a check made by
      // the caller's own return value, and this asks the only question that
      // cannot be answered from one: is the ledger the compiled runtime built
      // actually on the filesystem?
      if (!fs.existsSync(cursorSpawnsFile)) fail('compiled cursor fixture persisted no cursor-spawns.json');
      const beforeLifecycle = compiledCursorState.listCursorSpawnObservations(cursorProject, cursorRunId);
      if (beforeLifecycle.length !== 2
        || beforeLifecycle.some((item) => !item.consumedAtMs || item.followupEmitted || item.retryHandled)) {
        fail('compiled cursor fixture was not two finalized, unclaimed role failures');
      }
    });

    const stopInput = JSON.stringify({
      cwd: cursorProject,
      workspace_roots: [cursorProject],
      conversation_id: cursorParentId,
      session_id: cursorParentId,
      status: 'completed',
      loop_count: 0,
    });
    const subagentStopInput = JSON.stringify({
      cwd: cursorProject,
      workspace_roots: [cursorProject],
      conversation_id: cursorParentId,
      parent_conversation_id: cursorParentId,
      session_id: cursorParentId,
      subagent_id: finalizedRoles[0]!.toolCallId,
      status: 'error',
      error_message: 'compiled non-abort subagent failure',
      loop_count: 0,
    });
    const concurrentLifecycle = await Promise.all([
      runShimAsync(scratch, 'cursor-hook-runtime.cjs', 'cursor-stop', stopInput, cursorLifecycleEnv, cursorProject),
      runShimAsync(scratch, 'cursor-hook-runtime.cjs', 'cursor-subagent-stop', subagentStopInput, cursorLifecycleEnv, cursorProject),
    ]);
    for (const [index, result] of concurrentLifecycle.entries()) {
      if (result.status !== 0) {
        fail(`compiled Cursor lifecycle contender ${index + 1} exited ${result.status}: ${result.stderr}`);
      }
    }
    let lifecycleJson: Array<Record<string, unknown>>;
    try {
      lifecycleJson = concurrentLifecycle.map((result) => JSON.parse(result.stdout || '{}') as Record<string, unknown>);
    } catch {
      fail(`compiled Cursor lifecycle emitted invalid JSON: ${concurrentLifecycle.map((item) => item.stdout).join(' | ')}`);
    }
    const followups = lifecycleJson.filter((item) => typeof item.followup_message === 'string');
    const noops = lifecycleJson.filter((item) => Object.keys(item).length === 0);
    if (followups.length !== 1 || noops.length !== 1 || Object.keys(followups[0]!).length !== 1) {
      fail(`compiled Cursor lifecycle did not emit one combined followup and one {}: ${JSON.stringify(lifecycleJson)}`);
    }
    const combinedFollowup = String(followups[0]!.followup_message);
    for (const { role } of finalizedRoles) {
      const occurrences = combinedFollowup.split(role).length - 1;
      if (occurrences !== 1) {
        fail(`compiled Cursor combined followup mentioned ${role} ${occurrences} times instead of once`);
      }
    }

    const afterLifecycle = compiledCursorState.listCursorSpawnObservations(cursorProject, cursorRunId);
    if (afterLifecycle.length !== 2
      || afterLifecycle.some((item) => item.followupEmitted !== true || !item.consumedAtMs || item.retryHandled)) {
      fail('compiled Cursor lifecycle did not persist one complete at-most-once parent claim');
    }
    const persistedCursorState = JSON.parse(
      fs.readFileSync(cursorSpawnsFile, 'utf8'),
    ) as { observations?: Array<Record<string, unknown>> };
    if (persistedCursorState.observations?.length !== 2
      || persistedCursorState.observations.some((item) => item.followupEmitted !== true)) {
      fail('compiled Cursor at-most-once markers were not durable in cursor-spawns.json');
    }

    const replayLifecycle = await Promise.all([
      runShimAsync(scratch, 'cursor-hook-runtime.cjs', 'cursor-stop', stopInput, cursorLifecycleEnv, cursorProject),
      runShimAsync(scratch, 'cursor-hook-runtime.cjs', 'cursor-subagent-stop', subagentStopInput, cursorLifecycleEnv, cursorProject),
    ]);
    for (const [index, result] of replayLifecycle.entries()) {
      if (result.status !== 0) fail(`compiled Cursor lifecycle replay ${index + 1} exited ${result.status}: ${result.stderr}`);
      let replay: Record<string, unknown>;
      try { replay = JSON.parse(result.stdout || '{}') as Record<string, unknown>; } catch {
        fail(`compiled Cursor lifecycle replay emitted invalid JSON: ${result.stdout}`);
      }
      if (Object.keys(replay).length !== 0) {
        fail(`compiled Cursor lifecycle replay escaped persisted at-most-once state: ${result.stdout}`);
      }
    }

    // 5. The pipeline catches handler failures, but module discovery happens
    //    outside it. Remove the compiled modules after the ordinary runtime
    //    checks and prove every supported host's OUTER wrapper independently
    //    turns that wider failure into its native deny/block wire shape.
    const modulesDir = path.join(scratch, 'modules');
    const hiddenModulesDir = path.join(scratch, 'modules-smoke-hidden');
    fs.renameSync(modulesDir, hiddenModulesDir);
    try {
      // Same HOME/prefs pinning as the sections above. The fail-closed wrappers
      // consult the per-project consent record before standing down, so without
      // this the outcome of these seven checks would depend on the developer's
      // own ~/.traffic-one rather than on the fixture.
      const wrapperHome = path.join(authTmp, 'wrapper-home');
      fs.mkdirSync(wrapperHome, { recursive: true });
      const wrapperEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: wrapperHome,
        TRAFFIC_ONE_AUTH: 'off',
        TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot,
        TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(authTmp, 'wrapper-prefs.json'),
      };
      delete wrapperEnv.NODE_OPTIONS;
      delete wrapperEnv.XDG_STATE_HOME;
      delete wrapperEnv.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;

      const invokeJson = (host: string, shim: string, subcommand: string, stdin: string, extraEnv: NodeJS.ProcessEnv = {}): Record<string, any> => {
        const output = runShimAllowingBlock(scratch, shim, subcommand, stdin, { ...wrapperEnv, ...extraEnv });
        if (output.status !== 0) fail(`${host} missing-modules fallback exited ${output.status}: ${output.stderr}`);
        try {
          return JSON.parse(output.stdout || '{}') as Record<string, any>;
        } catch {
          fail(`${host} missing-modules fallback emitted invalid JSON: ${output.stdout}`);
        }
      };
      const assertReason = (host: string, value: unknown): void => {
        const text = String(value || '');
        if (!text.includes('blocked fail-closed')) fail(`${host} missing-modules fallback had no fail-closed reason`);
      };

      const claudeFallback = invokeJson('Claude', 'hook-runtime.cjs', 'check-onboarding-gate', JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' }, cwd: authTmp,
      }), { TRAFFIC_ONE_HOST: 'claude' });
      if (claudeFallback.hookSpecificOutput?.permissionDecision !== 'deny') fail('Claude missing-modules fallback was not a deny');
      assertReason('Claude', claudeFallback.hookSpecificOutput?.permissionDecisionReason);

      const codexFallback = invokeJson('Codex', 'hook-runtime.cjs', 'check-onboarding-gate', JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'pwd' }, cwd: authTmp,
      }), { TRAFFIC_ONE_HOST: 'codex' });
      if (codexFallback.hookSpecificOutput?.permissionDecision !== 'deny') fail('Codex missing-modules fallback was not a deny');
      assertReason('Codex', codexFallback.hookSpecificOutput?.permissionDecisionReason);
      if (codexFallback.hookSpecificOutput?.additionalContext !== '<!-- traffic-one-hook-context:v1 event=PreToolUse -->') {
        fail('Codex missing-modules fallback had no versioned provenance marker');
      }

      const cursorFallback = invokeJson('Cursor', 'cursor-hook-runtime.cjs', 'before-shell-execution', JSON.stringify({
        cwd: authTmp, command: 'pwd',
      }));
      if (cursorFallback.permission !== 'deny') fail('Cursor missing-modules fallback was not a deny');
      assertReason('Cursor', cursorFallback.user_message);

      const copilotFallback = invokeJson('Copilot', 'copilot-hook-runtime.cjs', 'before-tool-use', JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command: 'pwd' }, cwd: authTmp,
      }), { TRAFFIC_ONE_COPILOT_WIRE: 'cli' });
      if (copilotFallback.permissionDecision !== 'deny') fail('Copilot missing-modules fallback was not a deny');
      assertReason('Copilot', copilotFallback.permissionDecisionReason);

      const openCodeFallback = invokeJson('OpenCode', 'opencode-hook-runtime.cjs', 'before-tool-use', JSON.stringify({
        event: 'tool.execute.before', tool_name: 'bash', tool_input: { command: 'pwd' }, cwd: authTmp,
      }));
      if (openCodeFallback.kind !== 'deny') fail('OpenCode missing-modules fallback was not a deny');
      assertReason('OpenCode', openCodeFallback.reason);

      const kiloFallback = invokeJson('Kilo', 'kilo-hook-runtime.cjs', 'before-tool-use', JSON.stringify({
        event: 'tool.execute.before', tool_name: 'bash', tool_input: { command: 'pwd' }, cwd: authTmp,
      }));
      if (kiloFallback.kind !== 'deny') fail('Kilo missing-modules fallback was not a deny');
      assertReason('Kilo', kiloFallback.reason);

      const windsurfFallback = runShimAllowingBlock(
        scratch,
        'windsurf-hook-runtime.cjs',
        'pre_run_command',
        JSON.stringify({ agent_action_name: 'pre_run_command', tool_info: { cwd: authTmp, command_line: 'pwd' } }),
        wrapperEnv,
      );
      if (windsurfFallback.status !== 2) fail(`Windsurf missing-modules fallback did not block (status ${windsurfFallback.status})`);
      assertReason('Windsurf', windsurfFallback.stderr);
    } finally {
      fs.renameSync(hiddenModulesDir, modulesDir);
    }

    process.stdout.write(`compiled-smoke: PASS — built ${builtModuleIds.size} modules (${builtDocs.size} gate-prose files) + ${built.shimsWritten.length} shims; authenticated gates work, Codex reports approved EPERM bootstrap recovery, Cursor lifecycle followups are parent-batch at-most-once under process contention, and all 7 host wrappers fail closed when compiled modules are unavailable.\n`);
  } finally {
    for (const dir of [scratchRoot, authTmp, onboardingTmp, cursorConcurrencyTmp, ...strayScratch]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// Guarded so the module can be imported (by a test of fail()'s contract)
// without launching a full cutover build. `npm run smoke` runs this file as the
// tsx entry, where require.main === module holds.
if (require.main === module) {
  main().catch((error: unknown) => {
    const line = error instanceof SmokeFailure
      ? error.message
      : `compiled-smoke: FAIL — ${error instanceof Error ? (error.stack || error.message) : String(error)}`;
    process.stderr.write(`${line}\n`);
    // Not process.exit(): stderr to a pipe drains asynchronously, and the
    // transcript this line belongs to is the only thing a failing run leaves.
    process.exitCode = 1;
  });
}
