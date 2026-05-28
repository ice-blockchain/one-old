// src/build/compiled-smoke.ts
// Cutover-readiness smoke (run via `npm run smoke`). Compiles src/ to a scratch
// dir with the SAME config the cutover uses (tsconfig.build.json), copies the
// module descriptors, then runs the COMPILED host entries under bare `node` and
// asserts the engine dispatches correctly: an unauthed tool use is denied by
// the priority-0 auth gate, serialized into each host's wire shape. This proves
// — without touching scripts/ — that the TypeScript engine compiles to a
// working runtime, the single biggest cutover risk. Non-destructive: the scratch
// dir is removed at the end. Exits non-zero on any failure.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { copyModuleDescriptors } from './copy-module-assets';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function fail(msg: string): never {
  process.stderr.write(`compiled-smoke: FAIL — ${msg}\n`);
  process.exit(1);
}

function runEntry(scratch: string, entry: string, subcommand: string, stdin: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, [path.join(scratch, 'hooks', entry), subcommand], {
    input: stdin, encoding: 'utf8', env, timeout: 20000,
  });
  if (result.status !== 0) fail(`${entry} ${subcommand} exited ${result.status}: ${result.stderr || ''}`);
  return result.stdout || '';
}

function main(): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-'));
  const authTmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-compiled-smoke-auth-'));
  try {
    // 1. Compile src/ → scratch with the cutover build config.
    const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', scratch], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000,
    });
    if (tsc.status !== 0) fail(`tsc failed:\n${tsc.stdout || ''}${tsc.stderr || ''}`);
    if (!fs.existsSync(path.join(scratch, 'hooks', 'claude-entry.js'))) fail('compiled claude-entry.js missing');

    // 2. Copy module.json descriptors into the compiled tree (the cutover step).
    const { copied } = copyModuleDescriptors(path.join(REPO_ROOT, 'src', 'modules'), path.join(scratch, 'modules'));
    if (copied.length < 6) fail(`expected module descriptors copied, got ${copied.length}`);

    // 3. Run the compiled entries under bare node. UNAUTHENTICATED tool use must
    //    be denied. pluginRoot=REPO so skillBlock reads the shipped src skills.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: 'http://127.0.0.1:8787/mcp',
      TRAFFIC_ONE_AUTH_STATE_PATH: path.join(authTmp, 'auth.json'),
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(authTmp, 'prefs.json'),
      TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: path.join(authTmp, 'choice.json'),
      TRAFFIC_ONE_PLUGIN_ROOT: REPO_ROOT,
    };

    const claudeStdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(authTmp, 'x.ts'), content: 'export const x = 1;' }, cwd: authTmp });
    const claudeOut = JSON.parse(runEntry(scratch, 'claude-entry.js', 'check-architecture-write', claudeStdin, env) || '{}');
    if (claudeOut.hookSpecificOutput?.permissionDecision !== 'deny') fail('compiled claude entry did not deny an unauthed write');

    const cursorOut = JSON.parse(runEntry(scratch, 'cursor-entry.js', 'before-shell-execution', JSON.stringify({ cwd: authTmp, command: 'npm run build' }), env) || '{}');
    if (cursorOut.permission !== 'deny') fail('compiled cursor entry did not deny an unauthed shell');
    if (!cursorOut.user_message) fail('compiled cursor deny had no user_message (skillBlock did not resolve from src)');

    process.stdout.write(`compiled-smoke: PASS — compiled ${copied.length} modules; both host entries deny unauthed tool use under bare node.\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(authTmp, { recursive: true, force: true });
  }
}

main();
