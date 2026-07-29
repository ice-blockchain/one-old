// src/runners/doctor/codex-hook-schema.ts
// Codex hook trust schema: expected keys, statuses, and probe shapes.

import { spawn } from 'child_process';
import * as fs from 'fs';
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

export const DEFAULT_TIMEOUT_MS = 8_000;
export const STDOUT_LIMIT_BYTES = 1024 * 1024;
export const STDERR_LIMIT_BYTES = 64 * 1024;

export function indeterminate(
  reason: Extract<CodexHookTrustProbe, { evaluation: 'indeterminate' }>['reason'],
  detail: string | null = null,
): CodexHookTrustProbe {
  return { evaluation: 'indeterminate', source: 'structural-config', reason, detail };
}

export function codexHome(env: NodeJS.ProcessEnv): string | null {
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

export function trafficOneCache(home: string): string | null {
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

export function copyCacheWithoutSymlinks(source: string, destination: string): void {
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

export function childEnvironment(shadowHome: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

export function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
}

export function parseCodexVersion(result: unknown): string | null {
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

export function verifiedFromResponse(
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

