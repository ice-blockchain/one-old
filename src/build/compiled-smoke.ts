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

function fail(msg: string): never {
  process.stderr.write(`compiled-smoke: FAIL — ${msg}\n`);
  process.exit(1);
}

// Invoke a legacy-path shim (e.g. hook-runtime.cjs) at the scratch root.
function runShim(scratch: string, shim: string, subcommand: string, stdin: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, [path.join(scratch, shim), subcommand], {
    input: stdin, encoding: 'utf8', env, timeout: 20000,
  });
  if (result.status !== 0 && result.status !== null) fail(`${shim} ${subcommand} exited ${result.status}: ${result.stderr || ''}`);
  return result.stdout || '';
}

function runShimAllowingBlock(scratch: string, shim: string, subcommand: string, stdin: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(scratch, shim), subcommand], {
    input: stdin, encoding: 'utf8', env, timeout: 20000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

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
    if (built.modulesCopied < 6) fail(`expected module descriptors copied, got ${built.modulesCopied}`);
    for (const shim of ['hook-runtime.cjs', 'cursor-hook-runtime.cjs', 'windsurf-hook-runtime.cjs', 'devin-hook-runtime.cjs']) {
      if (!fs.existsSync(path.join(scratch, shim))) fail(`missing shim ${shim}`);
    }

    // 2. Invoke through the legacy-path shims under bare node. UNAUTHENTICATED
    //    tool use must be denied. pluginRoot points at the realistic scratch
    //    install, so skillBlock reads the compiled skill prose from scripts/.
    //    Auth is enforced explicitly (TRAFFIC_ONE_AUTH=on). The priority-0 auth
    //    gate, while unauthenticated, delegates to the onboarding gate (which opens
    //    the wizard's api-key page and denies mutating tools); NO_SPAWN keeps that
    //    delegation from launching a real wizard server in the smoke — the deny
    //    still fires with the placeholder URL, which is what this proves.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRAFFIC_ONE_AUTH: 'on',
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1',
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: 'http://127.0.0.1:8787/mcp',
      TRAFFIC_ONE_STATE_PATH: path.join(authTmp, 'one.json'),
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(authTmp, 'prefs.json'),
      TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot,
    };

    // Each host gets its OWN project cwd. The unauthenticated gate delegates to the
    // onboarding gate, which writes per-project session markers (once-per-session
    // deny walkthrough); sharing one cwd across hosts would let the first call's
    // marker steer the next host's branch. A real session is one host per project,
    // so per-host cwds match reality and keep the three checks independent.
    const claudeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-smoke-claude-'));
    const cursorCwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-smoke-cursor-'));
    const windsurfCwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-smoke-windsurf-'));

    const claudeStdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(claudeCwd, 'x.ts'), content: 'export const x = 1;' }, cwd: claudeCwd });
    const claudeOut = JSON.parse(runShim(
      scratch,
      'hook-runtime.cjs',
      'check-plan-write',
      claudeStdin,
      { ...env, TRAFFIC_ONE_HOST: 'claude' },
    ) || '{}');
    if (claudeOut.hookSpecificOutput?.permissionDecision !== 'deny') fail('hook-runtime.cjs shim did not deny an unauthed write');
    if (String(claudeOut.hookSpecificOutput?.additionalContext || '').includes('traffic-one-hook-context:v1')) {
      fail('Claude hook context incorrectly carried the Codex-only provenance marker');
    }

    const cursorOut = JSON.parse(runShim(scratch, 'cursor-hook-runtime.cjs', 'before-shell-execution', JSON.stringify({ cwd: cursorCwd, command: 'npm run build' }), env) || '{}');
    if (cursorOut.permission !== 'deny') fail('cursor-hook-runtime.cjs shim did not deny an unauthed shell');
    if (!cursorOut.user_message) fail('cursor deny had no user_message (skillBlock did not resolve from src)');

    const windsurfOut = runShimAllowingBlock(
      scratch,
      'windsurf-hook-runtime.cjs',
      'pre_run_command',
      JSON.stringify({ agent_action_name: 'pre_run_command', tool_info: { cwd: windsurfCwd, command_line: 'npm run build' } }),
      env,
    );
    if (windsurfOut.status !== 2) fail(`windsurf-hook-runtime.cjs shim did not exit 2 on an unauthed shell (status ${windsurfOut.status})`);
    if (!windsurfOut.stderr) fail('windsurf deny had no stderr message');

    const devinOut = JSON.parse(runShim(
      scratch,
      'devin-hook-runtime.cjs',
      'check-onboarding-gate',
      JSON.stringify({ hook_event_name: 'PreToolUse', cwd: authTmp, tool_name: 'exec', tool_input: { command: 'npm run build' } }),
      env,
    ) || '{}');
    if (devinOut.decision !== 'block') fail('devin-hook-runtime.cjs shim did not block an unauthed exec');

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
      };
      const builtClassifier = require(path.join(scratch, 'shared', 'tool-classify.js')) as {
        isOnboardingBootstrapCommand(toolName: unknown, toolInput: unknown): boolean;
        isOnboardingWaitCommand(toolName: unknown, toolInput: unknown): boolean;
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

    const compiledCursorState = require(path.join(scratch, 'shared', 'state', 'index.js')) as {
      recordCursorSpawnObservation(cwd: string, runId: string, input: Record<string, unknown>): Record<string, any> | null;
      claimCursorSpawnObservation(cwd: string, runId: string, toolCallId: string, childTranscriptId: string, nowMs?: number): Record<string, any> | null;
      updateCursorSpawnObservation(cwd: string, runId: string, childTranscriptId: string, patch: Record<string, unknown>, nowMs?: number): Record<string, any> | null;
      consumeCursorSpawnObservation(cwd: string, runId: string, childTranscriptId: string, nowMs?: number): Record<string, any> | null;
      listCursorSpawnObservations(cwd: string, runId: string): Array<Record<string, any>>;
    };
    const finalizedRoles = [
      { role: 'senior-backend', toolCallId: 'tool_compiled_backend', childId: 'child-compiled-backend', model: 'compiled-backend-model' },
      { role: 'senior-frontend', toolCallId: 'tool_compiled_frontend', childId: 'child-compiled-frontend', model: 'compiled-frontend-model' },
    ];
    const fixtureStartedAt = Date.now() - 5_000;
    for (const [index, item] of finalizedRoles.entries()) {
      const recorded = compiledCursorState.recordCursorSpawnObservation(cursorProject, cursorRunId, {
        parentSessionId: cursorParentId,
        toolCallId: item.toolCallId,
        role: item.role,
        requestedModel: item.model,
        tier: 'balanced',
        expectedModel: item.model,
        startedAtMs: fixtureStartedAt + index,
      });
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
    const beforeLifecycle = compiledCursorState.listCursorSpawnObservations(cursorProject, cursorRunId);
    if (beforeLifecycle.length !== 2
      || beforeLifecycle.some((item) => !item.consumedAtMs || item.followupEmitted || item.retryHandled)) {
      fail('compiled cursor fixture was not two finalized, unclaimed role failures');
    }

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
    const persistedCursorState = JSON.parse(fs.readFileSync(
      path.join(cursorProject, '.traffic-one', 'runs', cursorRunId, 'cursor-spawns.json'),
      'utf8',
    )) as { observations?: Array<Record<string, unknown>> };
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
      const wrapperEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TRAFFIC_ONE_AUTH: 'off',
        TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot,
      };
      delete wrapperEnv.NODE_OPTIONS;
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

    for (const d of [claudeCwd, cursorCwd, windsurfCwd]) fs.rmSync(d, { recursive: true, force: true });
    process.stdout.write(`compiled-smoke: PASS — built ${built.modulesCopied} modules + ${built.shimsWritten.length} shims; authenticated gates work, Codex reports approved EPERM bootstrap recovery, Cursor lifecycle followups are parent-batch at-most-once under process contention, and all 7 host wrappers fail closed when compiled modules are unavailable.\n`);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    fs.rmSync(authTmp, { recursive: true, force: true });
    fs.rmSync(onboardingTmp, { recursive: true, force: true });
    fs.rmSync(cursorConcurrencyTmp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack || error.message) : String(error));
});
