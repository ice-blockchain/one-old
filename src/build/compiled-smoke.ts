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

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildRuntime } from './build-runtime';

// The repo root — where src/modules/<id>/skill lives for skillBlock to read.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

function main(): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-'));
  const authTmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-auth-'));
  try {
    // 1. Full cutover build: compile + descriptors + legacy-named shims.
    const built = buildRuntime(scratch);
    if (built.modulesCopied < 6) fail(`expected module descriptors copied, got ${built.modulesCopied}`);
    for (const shim of ['hook-runtime.cjs', 'cursor-hook-runtime.cjs', 'windsurf-hook-runtime.cjs']) {
      if (!fs.existsSync(path.join(scratch, shim))) fail(`missing shim ${shim}`);
    }

    // 2. Invoke through the legacy-path shims under bare node. UNAUTHENTICATED
    //    tool use must be denied. pluginRoot=REPO so skillBlock reads src skills.
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
      TRAFFIC_ONE_AUTH_STATE_PATH: path.join(authTmp, 'one.json'),
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(authTmp, 'prefs.json'),
      TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: path.join(authTmp, 'choice.json'),
      TRAFFIC_ONE_PLUGIN_ROOT: REPO_ROOT,
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
    const claudeOut = JSON.parse(runShim(scratch, 'hook-runtime.cjs', 'check-plan-write', claudeStdin, env) || '{}');
    if (claudeOut.hookSpecificOutput?.permissionDecision !== 'deny') fail('hook-runtime.cjs shim did not deny an unauthed write');

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

    for (const d of [claudeCwd, cursorCwd, windsurfCwd]) fs.rmSync(d, { recursive: true, force: true });

    process.stdout.write(`compiled-smoke: PASS — built ${built.modulesCopied} modules + ${built.shimsWritten.length} shims; legacy-path shims (hook-runtime.cjs, cursor-hook-runtime.cjs, windsurf-hook-runtime.cjs) deny unauthed tool use under bare node.\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(authTmp, { recursive: true, force: true });
  }
}

main();
