// Official Codex hook-trust probe for the doctor. The real Codex home remains
// read-only: a bounded app-server process receives a private shadow home with a
// copied config and only the installed Traffic One cache. No auth databases,
// sessions, goals, or other Codex-home state are copied.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { samePlatformPath } from './path-identity';

type Rec = Record<string, unknown>;

export const CODEX_TRAFFIC_ONE_PLUGIN_ID = 'traffic-one@traffic-one-local';
export const CODEX_HOOK_EXPECTED_COUNT = 15 as const;

const EXPECTED_SUFFIXES = [
  'pre_tool_use:0:0',
  'pre_tool_use:1:0',
  'pre_tool_use:2:0',
  'pre_tool_use:2:1',
  'pre_tool_use:3:0',
  'pre_tool_use:4:0',
  'pre_tool_use:5:0',
  'pre_tool_use:6:0',
  'post_tool_use:0:0',
  'post_tool_use:0:1',
  'post_tool_use:1:0',
  'post_tool_use:2:0',
  'session_start:0:0',
  'user_prompt_submit:0:0',
  'subagent_start:0:0',
] as const;

export const CODEX_TRAFFIC_ONE_HOOK_KEYS: readonly string[] = EXPECTED_SUFFIXES.map(
  (suffix) => `${CODEX_TRAFFIC_ONE_PLUGIN_ID}:hooks/hooks.json:${suffix}`,
);

export type CodexHookTrustStatus = 'managed' | 'trusted' | 'modified' | 'untrusted';

export type CodexHookTrustProbe = {
  evaluation: 'verified';
  source: 'codex-hooks-list';
  expectedCount: 15;
  counts: {
    discovered: number;
    trusted: number;
    managed: number;
    modified: number;
    untrusted: number;
    disabled: number;
    runnable: number;
  };
  missingKeys: string[];
  unexpectedKeys: string[];
  hooks: Array<{
    key: string;
    eventName: string;
    enabled: boolean;
    trustStatus: CodexHookTrustStatus;
    currentHash: string;
  }>;
  binaryPath: string;
  codexVersion: string | null;
  warnings: string[];
  errors: string[];
} | {
  evaluation: 'indeterminate';
  source: 'structural-config';
  reason: 'codex-not-found' | 'plugin-cache-missing' | 'temp-unavailable' | 'spawn-failed' | 'timeout' | 'unsupported-api' | 'invalid-response';
  detail: string | null;
};

export interface CodexHookTrustProbeOptions {
  /** Production is always eight seconds; tests may use a shorter bounded wait. */
  timeoutMs?: number;
  /** Explicit test/integration injection; omitted in the shipped doctor path. */
  binaryPath?: string | null;
  /** Test-only observation hook for proving cleanup without relying on child startup. */
  onShadowHomePrepared?: (shadowHome: string) => void;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const STDOUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;

function indeterminate(
  reason: Extract<CodexHookTrustProbe, { evaluation: 'indeterminate' }>['reason'],
  detail: string | null = null,
): CodexHookTrustProbe {
  return { evaluation: 'indeterminate', source: 'structural-config', reason, detail };
}

function codexHome(env: NodeJS.ProcessEnv): string | null {
  if (env.CODEX_HOME) return path.resolve(env.CODEX_HOME);
  if (env.HOME) return path.join(path.resolve(env.HOME), '.codex');
  if (env.USERPROFILE) return path.join(path.resolve(env.USERPROFILE), '.codex');
  return null;
}

function executableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    // The doctor must launch Codex directly with `shell:false`. Windows batch
    // wrappers require cmd.exe, so accepting them here would select a binary
    // shape the probe is deliberately forbidden to spawn.
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate)) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidate(value: string | undefined, env: NodeJS.ProcessEnv): string | null {
  if (!value || !value.trim()) return null;
  const requested = value.trim();
  if (path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) {
    const resolved = path.resolve(requested);
    return executableFile(resolved) ? resolved : null;
  }
  const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const resolved = path.join(dir, `${requested}${extension}`);
      if (executableFile(resolved)) return resolved;
    }
  }
  return null;
}

function desktopBundleCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Codex.app/Contents/Resources/codex');
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex');
    if (env.HOME) {
      candidates.push(path.join(env.HOME, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
      candidates.push(path.join(env.HOME, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'));
    }
  } else if (process.platform === 'win32' && env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'ChatGPT', 'resources', 'codex.exe'));
  }
  return candidates;
}

export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = codexHome(env);
  const hostOwned = home
    ? path.join(home, 'plugins', '.plugin-appserver', process.platform === 'win32' ? 'codex.exe' : 'codex')
    : null;
  const bundles = desktopBundleCandidates(env);
  const desktopOriginator = /desktop/i.test(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || '');
  const candidates = [
    pathCandidate(env.TRAFFIC_ONE_CODEX_BIN, env),
    pathCandidate(env.CODEX_CLI_PATH, env),
    ...(desktopOriginator ? [hostOwned, ...bundles] : []),
    pathCandidate('codex', env),
    ...(!desktopOriginator ? [hostOwned, ...bundles] : []),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && executableFile(candidate))) || null;
}

function trafficOneCache(home: string): string | null {
  const cache = path.join(home, 'plugins', 'cache', 'traffic-one-local', 'traffic-one');
  try {
    if (!fs.statSync(cache).isDirectory()) return null;
    const versions = fs.readdirSync(cache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    return versions.length > 0 ? cache : null;
  } catch {
    return null;
  }
}

function copyCacheWithoutSymlinks(source: string, destination: string): void {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter(candidate) {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error('Traffic One plugin cache contains a symlink; refusing to copy it into the isolated Codex home.');
      }
      return true;
    },
  });
}

function childEnvironment(shadowHome: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  const pass = [
    'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR',
  ];
  for (const key of pass) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  childEnv.HOME = shadowHome;
  childEnv.USERPROFILE = shadowHome;
  childEnv.CODEX_HOME = shadowHome;
  return childEnv;
}

function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
}

function parseCodexVersion(result: unknown): string | null {
  const userAgent = record(result)?.userAgent;
  if (typeof userAgent !== 'string') return null;
  const match = userAgent.match(/^[^/\s]+\/([^\s]+)/);
  return match?.[1] || null;
}

function errorText(value: unknown): string | null {
  const item = record(value);
  if (!item || typeof item.message !== 'string') return null;
  return typeof item.path === 'string' && item.path
    ? `${item.path}: ${item.message}`
    : item.message;
}

function verifiedFromResponse(
  response: unknown,
  cwd: string,
  binaryPath: string,
  codexVersion: string | null,
): CodexHookTrustProbe | null {
  const result = record(response);
  if (!result || !Array.isArray(result.data)) return null;
  const entry = result.data.map(record).find((candidate) => {
    if (!candidate || typeof candidate.cwd !== 'string') return false;
    return samePlatformPath(candidate.cwd, cwd);
  });
  if (!entry || !Array.isArray(entry.hooks) || !Array.isArray(entry.warnings) || !Array.isArray(entry.errors)) return null;
  if (!entry.warnings.every((warning) => typeof warning === 'string')) return null;
  const errors = entry.errors.map(errorText);
  if (errors.some((error) => error === null)) return null;
  if (errors.length > 0) return null;

  const hooks: Extract<CodexHookTrustProbe, { evaluation: 'verified' }>['hooks'] = [];
  for (const value of entry.hooks) {
    const hook = record(value);
    if (!hook || hook.pluginId !== CODEX_TRAFFIC_ONE_PLUGIN_ID) continue;
    if (
      typeof hook.key !== 'string'
      || typeof hook.eventName !== 'string'
      || typeof hook.enabled !== 'boolean'
      || typeof hook.currentHash !== 'string'
      || (hook.trustStatus !== 'managed' && hook.trustStatus !== 'trusted' && hook.trustStatus !== 'modified' && hook.trustStatus !== 'untrusted')
    ) return null;
    hooks.push({
      key: hook.key,
      eventName: hook.eventName,
      enabled: hook.enabled,
      trustStatus: hook.trustStatus,
      currentHash: hook.currentHash,
    });
  }
  hooks.sort((left, right) => left.key.localeCompare(right.key));

  const discovered = new Set(hooks.map((hook) => hook.key));
  const expected = new Set(CODEX_TRAFFIC_ONE_HOOK_KEYS);
  const missingKeys = CODEX_TRAFFIC_ONE_HOOK_KEYS.filter((key) => !discovered.has(key));
  const unexpectedKeys = [...discovered].filter((key) => !expected.has(key)).sort();
  const trusted = hooks.filter((hook) => hook.trustStatus === 'trusted').length;
  const managed = hooks.filter((hook) => hook.trustStatus === 'managed').length;
  const modified = hooks.filter((hook) => hook.trustStatus === 'modified').length;
  const untrusted = hooks.filter((hook) => hook.trustStatus === 'untrusted').length;
  const disabled = hooks.filter((hook) => !hook.enabled).length;
  const runnable = hooks.filter((hook) => hook.enabled && (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed')).length;
  return {
    evaluation: 'verified',
    source: 'codex-hooks-list',
    expectedCount: CODEX_HOOK_EXPECTED_COUNT,
    counts: { discovered: hooks.length, trusted, managed, modified, untrusted, disabled, runnable },
    missingKeys,
    unexpectedKeys,
    hooks,
    binaryPath,
    codexVersion,
    warnings: entry.warnings as string[],
    errors: errors as string[],
  };
}

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
