// Per-run Codex profile isolation for the live release harness.
//
// A content-addressed marketplace is not sufficient when another Traffic One
// plugin is already enabled in the maintainer's base config: Codex may load
// duplicate skills/hooks even when a CLI `-c plugins."...".enabled=false`
// override was supplied. This helper writes a narrowly scoped profile-v2 layer
// which disables every pre-existing Traffic One selector and enables only the
// staged selector, then verifies the model-visible prompt without invoking an
// LLM.

import * as fs from 'fs';
import * as path from 'path';

import type { CodexMarketplaceStage } from './current-dist';

const PROFILE_MARKER_PREFIX = '# traffic-one-codex-e2e-profile-v1 ';
const SAFE_SELECTOR = /^traffic-one@[A-Za-z0-9._-]+$/;
const SAFE_PROFILE_NAME = /^traffic-one-e2e-[a-f0-9]{16}-[A-Za-z0-9]+$/;

interface CodexE2EProfileMarker {
  version: 1;
  kind: 'traffic-one-codex-e2e-profile';
  profileName: string;
  marketplaceName: string;
  stagedSelector: string;
  sourceFingerprint: string;
  cacheVersion: string;
  disabledSelectors: string[];
  expectsBootstrapSkills: boolean;
}

export interface CodexE2EProfile {
  codexHome: string;
  name: string;
  path: string;
  stagedSelector: string;
  disabledSelectors: string[];
  expectedSkillsRoot: string;
  expectsBootstrapSkills: boolean;
  marker: CodexE2EProfileMarker;
  expectedBytes: Buffer;
  originalRunArgs?: string[];
  runArgsOwner?: { runArgs: string[] };
}

export interface CodexE2EProfileCheck {
  ok: boolean;
  detail: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function trafficOneSelectorsFromCodexConfig(text: string): string[] {
  const selectors: string[] = [];
  const section = /^\s*\[plugins\.(?:"([^"]+)"|([A-Za-z0-9_.@-]+))\]\s*$/gm;
  for (const match of text.matchAll(section)) {
    const selector = match[1] ?? match[2] ?? '';
    if (SAFE_SELECTOR.test(selector)) selectors.push(selector);
  }
  return uniqueSorted(selectors);
}

function profileMarkerLine(marker: CodexE2EProfileMarker): string {
  return `${PROFILE_MARKER_PREFIX}${Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url')}`;
}

function profileContents(marker: CodexE2EProfileMarker): Buffer {
  const lines = [
    '# Generated temporarily by the Traffic One release harness. Do not reuse.',
    profileMarkerLine(marker),
    '',
  ];
  for (const selector of marker.disabledSelectors) {
    lines.push(`[plugins.${JSON.stringify(selector)}]`, 'enabled = false', '');
  }
  lines.push(`[plugins.${JSON.stringify(marker.stagedSelector)}]`, 'enabled = true', '');
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function assertSafeStage(marketplace: CodexMarketplaceStage): void {
  if (!SAFE_PROFILE_NAME.test(marketplace.name)) {
    throw new Error(`unsafe Codex E2E profile name ${JSON.stringify(marketplace.name)}`);
  }
  if (marketplace.pluginSelector !== `traffic-one@${marketplace.name}` || !SAFE_SELECTOR.test(marketplace.pluginSelector)) {
    throw new Error(`unsafe Codex E2E staged selector ${JSON.stringify(marketplace.pluginSelector)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(marketplace.sourceFingerprint)) {
    throw new Error('Codex E2E staged source fingerprint is invalid');
  }
  if (marketplace.cacheVersion !== `0.0.0-e2e.${marketplace.sourceFingerprint.slice(0, 16)}`) {
    throw new Error(`Codex E2E cache version is not bound to the staged source: ${marketplace.cacheVersion}`);
  }
}

function containsSkillFile(root: string): boolean {
  if (!fs.existsSync(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Codex E2E staged bootstrap skills contain a symbolic link: ${next}`);
      }
      if (entry.isDirectory()) pending.push(next);
      else if (entry.isFile() && entry.name === 'SKILL.md') return true;
    }
  }
  return false;
}

function writeExclusive0600(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(file); } catch { /* best effort */ }
    throw error;
  }
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600);
}

export function createCodexE2EProfile(
  codexHome: string,
  marketplace: CodexMarketplaceStage,
  baseConfigText: string,
): CodexE2EProfile {
  assertSafeStage(marketplace);
  const resolvedHome = path.resolve(codexHome);
  const disabledSelectors = trafficOneSelectorsFromCodexConfig(baseConfigText)
    .filter((selector) => selector !== marketplace.pluginSelector);
  const expectsBootstrapSkills = containsSkillFile(path.join(marketplace.stagedPluginRoot, 'skills'));
  const marker: CodexE2EProfileMarker = {
    version: 1,
    kind: 'traffic-one-codex-e2e-profile',
    profileName: marketplace.name,
    marketplaceName: marketplace.name,
    stagedSelector: marketplace.pluginSelector,
    sourceFingerprint: marketplace.sourceFingerprint,
    cacheVersion: marketplace.cacheVersion,
    disabledSelectors,
    expectsBootstrapSkills,
  };
  const expectedBytes = profileContents(marker);
  const profilePath = path.join(resolvedHome, `${marketplace.name}.config.toml`);
  if (path.dirname(profilePath) !== resolvedHome) {
    throw new Error(`Codex E2E profile escaped CODEX_HOME: ${profilePath}`);
  }
  writeExclusive0600(profilePath, expectedBytes);
  const stat = fs.lstatSync(profilePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Codex E2E profile is not a real 0600 file: ${profilePath}`);
  }
  return {
    codexHome: resolvedHome,
    name: marketplace.name,
    path: profilePath,
    stagedSelector: marketplace.pluginSelector,
    disabledSelectors,
    expectedSkillsRoot: path.join(
      resolvedHome,
      'plugins',
      'cache',
      marketplace.name,
      'traffic-one',
      marketplace.cacheVersion,
      'skills',
    ),
    expectsBootstrapSkills,
    marker,
    expectedBytes,
  };
}

export function codexRunArgsWithE2EProfile(runArgs: string[], profileName: string): string[] {
  if (!SAFE_PROFILE_NAME.test(profileName)) {
    throw new Error(`unsafe Codex E2E profile argument ${JSON.stringify(profileName)}`);
  }
  if (runArgs.includes('--profile-v2')) {
    throw new Error('Codex E2E run args already contain --profile-v2');
  }
  const filtered: string[] = [];
  for (let index = 0; index < runArgs.length; index += 1) {
    const current = runArgs[index]!;
    const next = runArgs[index + 1];
    if (
      (current === '-c' || current === '--config')
      && typeof next === 'string'
      && /^plugins\..*traffic-one.*\.enabled=false$/.test(next)
    ) {
      index += 1;
      continue;
    }
    filtered.push(current);
  }
  const execIndex = filtered.indexOf('exec');
  if (execIndex < 0) throw new Error('Codex E2E run args do not invoke `exec`');
  filtered.splice(execIndex + 1, 0, '--profile-v2', profileName);
  return filtered;
}

function parsePromptInput(output: string): unknown[] | null {
  const start = output.indexOf('[');
  if (start < 0) return null;
  let end = output.lastIndexOf(']');
  while (end > start) {
    try {
      const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      end = output.lastIndexOf(']', end - 1);
    }
  }
  return null;
}

function collectText(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'text' && typeof child === 'string') out.push(child);
    else collectText(child, out);
  }
}

function normalizeRoot(value: string): string {
  return path.resolve(value.trim());
}

export function verifyCodexE2EProfilePromptInput(
  output: string,
  profile: CodexE2EProfile,
): CodexE2EProfileCheck {
  if (/skipping duplicate plugin/i.test(output)) {
    return { ok: false, detail: 'Codex still reported duplicate plugins under the E2E profile' };
  }
  const parsed = parsePromptInput(output);
  if (!parsed) {
    return { ok: false, detail: 'Codex prompt-input preflight did not return a JSON array' };
  }
  const texts: string[] = [];
  collectText(parsed, texts);
  const lines = texts.join('\n').split(/\r?\n/);
  const roots = new Map<string, string>();
  const trafficAliases = new Set<string>();
  let trafficPluginEntries = 0;
  for (const line of lines) {
    const root = line.match(/^\s*-\s+(r\d+)\s*=\s*`([^`]+)`\s*$/);
    if (root?.[1] && root[2]) roots.set(root[1], normalizeRoot(root[2]));
    if (/^\s*-\s+`?Traffic One`?\s*:/i.test(line)) trafficPluginEntries += 1;
    if (/^\s*-\s+traffic-one:/.test(line)) {
      const alias = line.match(/\(file:\s*(r\d+)\//)?.[1];
      if (alias) trafficAliases.add(alias);
    }
  }
  if (trafficPluginEntries !== 1) {
    return {
      ok: false,
      detail: `Codex prompt-input must expose exactly one Traffic One plugin entry; observed ${trafficPluginEntries}`,
    };
  }

  const expected = normalizeRoot(profile.expectedSkillsRoot);
  const staleRoots = uniqueSorted([...roots.values()].filter((root) => (
    root !== expected
    && /(?:^|[/\\])plugins[/\\]cache[/\\][^/\\]+[/\\]traffic-one[/\\][^/\\]+[/\\]skills$/.test(root)
  )));
  if (staleRoots.length > 0) {
    return {
      ok: false,
      detail: `Codex prompt-input retained additional Traffic One roots: [${staleRoots.join(', ')}]`,
    };
  }

  if (!profile.expectsBootstrapSkills) {
    if (trafficAliases.size > 0) {
      const observed = uniqueSorted([...trafficAliases].map((alias) => roots.get(alias) ?? `<missing:${alias}>`));
      return {
        ok: false,
        detail: `Codex prompt-input exposed unexpected Traffic One bootstrap skills: [${observed.join(', ')}]`,
      };
    }
    return {
      ok: true,
      detail: 'Codex prompt-input exposed exactly one Traffic One plugin and no bootstrap skills; catalog skills remain runtime-materialized',
    };
  }

  if (trafficAliases.size === 0) {
    return { ok: false, detail: 'Codex prompt-input exposed no Traffic One skills under the staged profile' };
  }

  const observed = uniqueSorted([...trafficAliases].map((alias) => roots.get(alias) ?? `<missing:${alias}>`));
  if (observed.length !== 1 || observed[0] !== expected) {
    return {
      ok: false,
      detail: `Codex Traffic One skill roots are not exclusive: expected [${expected}], observed [${observed.join(', ')}]`,
    };
  }

  return {
    ok: true,
    detail: `Codex prompt-input exposed only ${expected} for Traffic One skills`,
  };
}

function validateProfileForCleanup(profile: CodexE2EProfile): string | null {
  const home = path.resolve(profile.codexHome);
  const file = path.resolve(profile.path);
  if (
    !SAFE_PROFILE_NAME.test(profile.name)
    || path.basename(file) !== `${profile.name}.config.toml`
    || path.dirname(file) !== home
  ) {
    return `profile path/name mismatch: ${file} (${profile.name})`;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return `profile is unavailable: ${file}: ${String(error)}`;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return `profile is not a real file: ${file}`;
  if ((stat.mode & 0o777) !== 0o600) return `profile mode changed from 0600: ${file}`;
  let current: Buffer;
  try {
    current = fs.readFileSync(file);
  } catch (error) {
    return `profile could not be read: ${file}: ${String(error)}`;
  }
  if (!current.equals(profile.expectedBytes)) return `profile contents changed: ${file}`;
  const markerLine = current.toString('utf8').split(/\r?\n/).find((line) => line.startsWith(PROFILE_MARKER_PREFIX));
  if (markerLine !== profileMarkerLine(profile.marker)) return `profile marker mismatch: ${file}`;
  return null;
}

export function cleanupCodexE2EProfile(profile: CodexE2EProfile): CodexE2EProfileCheck {
  const unsafe = validateProfileForCleanup(profile);
  if (unsafe) return { ok: false, detail: unsafe };
  try {
    fs.unlinkSync(profile.path);
  } catch (error) {
    return { ok: false, detail: `could not remove exact Codex E2E profile ${profile.path}: ${String(error)}` };
  }
  if (profile.runArgsOwner && profile.originalRunArgs) {
    profile.runArgsOwner.runArgs = [...profile.originalRunArgs];
  }
  return { ok: true, detail: `removed exact Codex E2E profile ${profile.path}` };
}
