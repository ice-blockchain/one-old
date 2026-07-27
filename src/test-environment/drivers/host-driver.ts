// src/test-environment/drivers/host-driver.ts
// Data-driven host driver. All three hosts share this template expander + spawn
// logic; per-host files (claude/codex/cursor) only bind an id so future
// host-specific quirks have a home. To change a flag, edit config/hosts.ts.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { HostCommandConfig, HostDriver, HostId, HostRunContext, HostRunResult } from '../core/types';
import { hostIsAvailable } from '../core/preflight';
import { RUNTIME_PROOF_ENTRY_ENV, RUNTIME_PROOF_TOKEN_ENV } from '../core/current-dist';

function expand(arg: string, ctx: HostRunContext, cfg: HostCommandConfig, promptFilePath: string): string {
  return arg
    .replace('{PROMPT}', ctx.prompt)
    .replace('{PROMPT_FILE}', promptFilePath)
    .replace('{CWD}', ctx.cwd)
    .replace('{MODEL}', ctx.model ?? cfg.defaultModelByTier?.highest ?? '')
    .replace('{OUTPUT_FORMAT}', cfg.outputFormat ?? 'text')
    .replace('{DIST}', ctx.distRoot);
}

interface Invocation {
  argv: string[];
  stdin?: string;
}

// Host CLIs must select the installed/plugin-dir runtime themselves. In
// particular, exporting TRAFFIC_ONE_PLUGIN_ROOT to Codex would make an old
// installed hook execute the checkout's current scripts and counterfeit the
// release proof. Expected token/entry values also stay harness-side; the
// injected runtime receives only the output file path and carries its token in
// its own bytes.
export function hostSubprocessEnv(
  caseEnv: NodeJS.ProcessEnv,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...ambient, ...caseEnv };
  for (const key of [
    'TRAFFIC_ONE_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_ROOT',
    'CODEX_PLUGIN_ROOT',
    'CURSOR_PLUGIN_ROOT',
    RUNTIME_PROOF_TOKEN_ENV,
    RUNTIME_PROOF_ENTRY_ENV,
  ]) delete env[key];
  return env;
}

// On a non-zero exit, pull the real reason out of the captured output so the
// report shows e.g. "host error: 401 Failed to authenticate" instead of a bare
// "ERROR exit 1". Handles the --output-format json envelope and falls back to
// stderr.
function extractHostError(stdoutPath: string, stderrPath: string): string | undefined {
  try {
    const out = fs.readFileSync(stdoutPath, 'utf8').trim();
    for (const line of out.split('\n').reverse()) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        if (o.is_error || o.api_error_status || o.subtype === 'error') {
          const status = o.api_error_status ? `${o.api_error_status} ` : '';
          const msg = typeof o.result === 'string' ? o.result : JSON.stringify(o).slice(0, 160);
          return `host error: ${status}${msg}`.slice(0, 220);
        }
      } catch { /* not a JSON line */ }
    }
  } catch { /* no stdout */ }
  try {
    const errTail = fs.readFileSync(stderrPath, 'utf8').trim().split('\n').slice(-3).join(' ').trim();
    if (errTail) return `host error: ${errTail.slice(0, 220)}`;
  } catch { /* no stderr */ }
  return undefined;
}

function buildInvocation(cfg: HostCommandConfig, ctx: HostRunContext): Invocation {
  let promptFilePath = '';
  if (cfg.promptVia === 'file') {
    promptFilePath = path.join(ctx.runFolder, 'prompt.txt');
    fs.writeFileSync(promptFilePath, ctx.prompt, 'utf8');
  }
  // For stdin delivery, strip the {PROMPT} placeholder argument entirely.
  const raw = cfg.promptVia === 'stdin' ? cfg.runArgs.filter((a) => a !== '{PROMPT}') : cfg.runArgs;
  const argv = raw.map((a) => expand(a, ctx, cfg, promptFilePath));
  return { argv, stdin: cfg.promptVia === 'stdin' ? ctx.prompt : undefined };
}

function runCommand(cfg: HostCommandConfig, ctx: HostRunContext): Promise<HostRunResult> {
  const started = Date.now();
  const { argv, stdin } = buildInvocation(cfg, ctx);
  const stdoutPath = path.join(ctx.runFolder, 'stdout.log');
  const stderrPath = path.join(ctx.runFolder, 'stderr.log');
  const command = `${cfg.bin} ${argv.join(' ')}`;

  fs.mkdirSync(ctx.runFolder, { recursive: true });
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');

  return new Promise<HostRunResult>((resolve) => {
    let settled = false;
    const finish = (r: HostRunResult) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(outFd); } catch { /* noop */ }
      try { fs.closeSync(errFd); } catch { /* noop */ }
      resolve(r);
    };

    let child;
    try {
      child = spawn(cfg.bin, argv, {
        cwd: ctx.cwd,
        env: hostSubprocessEnv({ ...ctx.env, ...(cfg.e2eEnv ?? {}) }),
        stdio: ['pipe', outFd, errFd],
      });
    } catch (e) {
      finish({ status: 'ERROR', exitCode: null, durationMs: Date.now() - started, stdoutPath, stderrPath, command, skippedReason: String(e) });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      finish({ status: 'TIMEOUT', exitCode: null, durationMs: Date.now() - started, stdoutPath, stderrPath, command });
    }, ctx.timeoutMs);

    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ status: 'ERROR', exitCode: null, durationMs: Date.now() - started, stdoutPath, stderrPath, command, skippedReason: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const base = { exitCode: code, durationMs: Date.now() - started, stdoutPath, stderrPath, command };
      if (code === 0) { finish({ status: 'COMPLETED', ...base }); return; }
      finish({ status: 'ERROR', ...base, skippedReason: extractHostError(stdoutPath, stderrPath) });
    });
  });
}

export function createDriver(id: HostId): HostDriver {
  return {
    id,
    isAvailable: (cfg, env) => hostIsAvailable(cfg, env),
    run: (cfg, ctx) => runCommand(cfg, ctx),
  };
}
