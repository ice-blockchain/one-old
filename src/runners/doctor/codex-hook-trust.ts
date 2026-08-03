// src/runners/doctor/codex-hook-trust.ts
// The Codex hook-trust probe over the schema in codex-hook-schema.ts.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_TIMEOUT_MS,
  STDERR_LIMIT_BYTES,
  STDOUT_LIMIT_BYTES,
  childEnvironment,
  codexHome,
  copyCacheWithoutSymlinks,
  indeterminate,
  parseCodexVersion,
  record,
  resolveCodexBinary,
  trafficOneCache,
  verifiedFromResponse,
  type CodexHookTrustProbe,
  type CodexHookTrustProbeOptions,
} from './codex-hook-schema';

type Rec = Record<string, unknown>;

function unsupportedMethod(error: unknown): boolean {
  const value = record(error);
  if (!value) return false;
  if (value.code === -32601) return true;
  return typeof value.message === 'string' && /(?:method not found|unknown method|unsupported)/i.test(value.message);
}

async function queryHooksList(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  binaryPath: string,
  timeoutMs: number,
): Promise<CodexHookTrustProbe> {
  return new Promise((resolve) => {
    let completed = false;
    let shuttingDown = false;
    let pendingResult: CodexHookTrustProbe | null = null;
    let initialized = false;
    let codexVersion: string | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lineBuffer = '';
    let childExited = false;

    const shutdownGraceMs = Math.max(25, Math.min(250, Math.floor(timeoutMs / 4)));
    const protocolTimer = setTimeout(
      () => beginShutdown(indeterminate('timeout')),
      Math.max(1, timeoutMs - shutdownGraceMs),
    );
    const hardKillTimer = setTimeout(() => {
      if (completed) return;
      shuttingDown = true;
      pendingResult = indeterminate('timeout');
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // A descendant can inherit the app-server pipes and delay ChildProcess
      // `close` indefinitely after the direct child has exited. Destroy our
      // pipe ends at the absolute deadline so the doctor remains bounded.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      complete(pendingResult);
    }, Math.max(1, timeoutMs));

    const complete = (result: CodexHookTrustProbe): void => {
      if (completed) return;
      completed = true;
      clearTimeout(protocolTimer);
      clearTimeout(hardKillTimer);
      clearTimeout(forceKillTimer);
      resolve(result);
    };
    const beginShutdown = (result: CodexHookTrustProbe): void => {
      if (completed || shuttingDown) return;
      shuttingDown = true;
      pendingResult = result;
      clearTimeout(protocolTimer);
      if (childExited) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        complete(result);
        return;
      }
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      forceKillTimer = setTimeout(() => {
        if (completed) return;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, Math.max(1, Math.floor(shutdownGraceMs / 2)));
    };
    let forceKillTimer: NodeJS.Timeout | undefined;

    const send = (message: Rec): boolean => {
      try {
        return child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        beginShutdown(indeterminate('spawn-failed', 'Codex app-server stdin closed unexpectedly.'));
        return false;
      }
    };

    const acceptLine = (raw: string): void => {
      if (completed || shuttingDown || !raw.trim()) return;
      let message: Rec | null = null;
      try { message = record(JSON.parse(raw)); } catch { /* invalid below */ }
      if (!message) {
        beginShutdown(indeterminate('invalid-response', 'Codex app-server emitted invalid JSONL.'));
        return;
      }
      if (message.id === 1) {
        if (message.error !== undefined) {
          beginShutdown(indeterminate(unsupportedMethod(message.error) ? 'unsupported-api' : 'invalid-response'));
          return;
        }
        if (!record(message.result) || initialized) {
          beginShutdown(indeterminate('invalid-response', 'Codex initialize response was malformed.'));
          return;
        }
        initialized = true;
        codexVersion = parseCodexVersion(message.result);
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [path.resolve(cwd)] } });
        return;
      }
      if (message.id === 2) {
        if (!initialized) {
          beginShutdown(indeterminate('invalid-response', 'Codex hooks/list arrived before initialize completed.'));
          return;
        }
        if (message.error !== undefined) {
          beginShutdown(indeterminate(unsupportedMethod(message.error) ? 'unsupported-api' : 'invalid-response'));
          return;
        }
        const verified = verifiedFromResponse(message.result, cwd, binaryPath, codexVersion);
        beginShutdown(verified || indeterminate('invalid-response', 'Codex hooks/list response did not match the supported schema.'));
      }
      // Notifications and unrelated server requests are intentionally ignored.
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        beginShutdown(indeterminate('invalid-response', 'Codex app-server stdout exceeded the probe limit.'));
        return;
      }
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf('\n');
      while (newline >= 0 && !completed && !shuttingDown) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newline + 1);
        acceptLine(line);
        newline = lineBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Stderr is diagnostic noise for a JSONL stdio server. Count and discard
      // it so warnings cannot grow the doctor's memory without bound.
      stderrBytes = Math.min(STDERR_LIMIT_BYTES, stderrBytes + chunk.byteLength);
    });
    child.stdin.on('error', () => {
      if (!shuttingDown) beginShutdown(indeterminate('spawn-failed', 'Codex app-server stdin failed.'));
    });
    child.on('error', () => {
      if (!shuttingDown) {
        shuttingDown = true;
        pendingResult = indeterminate('spawn-failed', 'Could not start Codex app-server.');
      }
    });
    child.on('exit', () => {
      if (completed) return;
      childExited = true;
      // `exit` belongs to the direct Codex process; unlike `close`, it is not
      // held open by a descendant that inherited stdio. Do not discard unread
      // stdout if no protocol result has been parsed yet: Node can emit `exit`
      // before the child's pipes have fully drained.
      if (!pendingResult) return;
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      complete(pendingResult);
    });
    child.on('close', () => {
      if (completed) return;
      if (!shuttingDown && lineBuffer.trim()) acceptLine(lineBuffer.replace(/\r$/, ''));
      complete(pendingResult || indeterminate('invalid-response', 'Codex app-server exited before hooks/list completed.'));
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'traffic-one-doctor', version: '1' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function probeCodexHookTrust(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CodexHookTrustProbeOptions = {},
): Promise<CodexHookTrustProbe> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hasBinaryOverride = Object.prototype.hasOwnProperty.call(options, 'binaryPath');
  const binaryPath = hasBinaryOverride ? options.binaryPath || null : resolveCodexBinary(env);
  // An explicit null override is a deterministic binary probe used by callers
  // and tests. During normal auto-detection, report the earlier structural
  // prerequisite first so doctor output is stable on hosts without Codex in PATH.
  if (hasBinaryOverride && !binaryPath) return indeterminate('codex-not-found');
  const realHome = codexHome(env);
  const cache = realHome ? trafficOneCache(realHome) : null;
  if (!cache) return indeterminate('plugin-cache-missing');
  if (!binaryPath) return indeterminate('codex-not-found');

  let shadowHome: string | null = null;
  let result: CodexHookTrustProbe | null = null;
  let cleanupFailure: string | null = null;
  try {
    shadowHome = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-doctor-codex-'));
    fs.chmodSync(shadowHome, 0o700);
    options.onShadowHomePrepared?.(shadowHome);
    const shadowCache = path.join(shadowHome, 'plugins', 'cache', 'traffic-one-local', 'traffic-one');
    fs.mkdirSync(path.dirname(shadowCache), { recursive: true, mode: 0o700 });
    copyCacheWithoutSymlinks(cache, shadowCache);
    const configPath = path.join(shadowHome, 'config.toml');
    const realConfigPath = path.join(realHome as string, 'config.toml');
    if (fs.existsSync(realConfigPath)) {
      fs.copyFileSync(realConfigPath, configPath);
    } else {
      fs.writeFileSync(configPath, '', { encoding: 'utf8', mode: 0o600 });
    }
    fs.chmodSync(configPath, 0o600);

    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      result = indeterminate('timeout');
    } else {
      let child: ChildProcessWithoutNullStreams | null = null;
      try {
        child = spawn(binaryPath, ['app-server', '--listen', 'stdio://'], {
          cwd: fs.existsSync(cwd) ? cwd : os.tmpdir(),
          env: childEnvironment(shadowHome, env),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        result = indeterminate('spawn-failed', 'Could not start Codex app-server.');
      }
      if (child) result = await queryHooksList(child, cwd, binaryPath, remaining);
    }
  } catch (error) {
    result = indeterminate(
      'temp-unavailable',
      `Could not prepare the isolated Codex probe home: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (shadowHome) {
      try {
        fs.rmSync(shadowHome, { recursive: true, force: true });
      } catch (error) {
        cleanupFailure = `Could not remove the isolated Codex probe home: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  if (cleanupFailure) return indeterminate('temp-unavailable', cleanupFailure);
  return result || indeterminate('invalid-response', 'Codex hook trust probe produced no result.');
}
export {
  CODEX_HOOK_EXPECTED_COUNT,
  CODEX_TRAFFIC_ONE_HOOK_KEYS,
  CODEX_TRAFFIC_ONE_PLUGIN_ID,
  resolveCodexBinary,
  type CodexHookTrustProbe,
  type CodexHookTrustProbeOptions,
  type CodexHookTrustStatus,
} from './codex-hook-schema';
