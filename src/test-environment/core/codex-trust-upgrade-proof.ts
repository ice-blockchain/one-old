// A real Codex hook-trust upgrade proof for the release harness.
//
// This is deliberately separate from the generic Codex E2E command matrix.
// Both paths avoid a trust bypass: the matrix approves the exact
// content-addressed staged ABI inside a disposable home, while this proof keeps
// the plugin identity fixed and requires v2 to inherit v1 trust unchanged.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { REPO_ROOT_PATH } from '../config/test-config';

export const CODEX_TRUST_PROOF_MARKETPLACE = 'traffic-one-trust-proof';
export const CODEX_TRUST_PROOF_PLUGIN_ID = `traffic-one@${CODEX_TRUST_PROOF_MARKETPLACE}`;
export const CODEX_TRUST_PROOF_EXPECTED_HOOKS = 15;

const DEFAULT_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_CAP_MS = 15_000;
const MARKER_TIMEOUT_CAP_MS = 8_000;
const RPC_STDOUT_LIMIT = 1_048_576;
const RPC_STDERR_LIMIT = 65_536;
const ABI_FIXTURE_PATH = path.join(REPO_ROOT_PATH, 'tests', 'fixtures', 'codex-hook-abi.v1.json');
const V1_VERSION = '0.0.0-trust-proof.1';
const V2_VERSION = '0.0.0-trust-proof.2';

type ProofStage =
  | 'setup'
  | 'install-v1'
  | 'list-v1'
  | 'approve-v1'
  | 'install-v2'
  | 'list-v2'
  | 'session-start'
  | 'user-prompt-submit'
  | 'cleanup';

export interface CodexHookAbiFixtureEntry {
  key: string;
  currentHash: string;
  eventName?: string;
  matcher?: string | null;
  subcommand?: string;
  command?: string;
  timeoutSec?: number;
  async?: boolean;
  statusMessage?: string | null;
  additionalContextLimit?: number | null;
}

export interface CodexHookAbiFixture {
  version: 1;
  entries: CodexHookAbiFixtureEntry[];
}

export interface CodexTrustUpgradeProofOptions {
  distRoot: string;
  codexBin?: string;
  timeoutMs?: number;
  tempRootParent?: string;
  fixturePath?: string;
  abiFixture?: CodexHookAbiFixture;
}

export interface CodexTrustUpgradeProofResult {
  ok: boolean;
  stage: ProofStage;
  detail: string;
  pluginId: string;
  expectedHooks: number;
  beforeTrusted: number;
  afterTrusted: number;
  observedEvents: string[];
  durationMs: number;
  notes: string[];
}

export interface ProofCommandResult {
  ok: boolean;
  out: string;
}

export type ProofCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => ProofCommandResult;

export interface CodexProofAppServer {
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  close(): Promise<void>;
  stderrTail(): string;
}

export interface CodexProofAppServerOptions {
  codexBin: string;
  cwd: string;
  codexHome: string;
  env: NodeJS.ProcessEnv;
  markerPath: string;
  timeoutMs: number;
}

export type CodexProofAppServerFactory = (
  options: CodexProofAppServerOptions,
) => Promise<CodexProofAppServer>;

export interface CodexTrustUpgradeProofDeps {
  commandRunner?: ProofCommandRunner;
  appServerFactory?: CodexProofAppServerFactory;
  materializedV2Probe?: (codexHome: string, hooks: Buffer, runtime: Buffer) => string | null;
  now?: () => number;
}

interface HookMetadata {
  key: string;
  pluginId: string | null;
  enabled: boolean;
  isManaged: boolean;
  handlerType: string;
  source: string;
  currentHash: string;
  trustStatus: string;
}

interface HooksListEntry {
  cwd: string;
  hooks: HookMetadata[];
  warnings: string[];
  errors: Array<{ message?: unknown; path?: unknown }>;
}

interface HooksListResponse {
  data: HooksListEntry[];
}

interface MarkerEntry {
  proofVersion: number;
  subcommand: string;
}

class ProofDeadline {
  private readonly expiresAt: number;

  constructor(
    timeoutMs: number,
    private readonly now: () => number,
  ) {
    this.expiresAt = now() + timeoutMs;
  }

  remaining(stage: ProofStage, cap = Number.POSITIVE_INFINITY): number {
    const remaining = this.expiresAt - this.now();
    if (remaining <= 0) throw new Error(`${stage}: proof timed out`);
    return Math.max(1, Math.min(remaining, cap));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedHash(value: string): string {
  const raw = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error(`invalid hook hash ${JSON.stringify(value)}`);
  return `sha256:${raw}`;
}

function parseAbiFixture(value: unknown): CodexHookAbiFixture {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('Codex hook ABI fixture must be a version 1 object with entries');
  }
  const entries: CodexHookAbiFixtureEntry[] = value.entries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.currentHash !== 'string') {
      throw new Error(`Codex hook ABI fixture entry ${index} is invalid`);
    }
    normalizedHash(entry.currentHash);
    return entry as unknown as CodexHookAbiFixtureEntry;
  });
  if (entries.length !== CODEX_TRUST_PROOF_EXPECTED_HOOKS) {
    throw new Error(`Codex hook ABI fixture has ${entries.length} entries; expected ${CODEX_TRUST_PROOF_EXPECTED_HOOKS}`);
  }
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error('Codex hook ABI fixture contains duplicate keys');
  }
  return { version: 1, entries };
}

function loadAbiFixture(options: CodexTrustUpgradeProofOptions): CodexHookAbiFixture {
  if (options.abiFixture) return parseAbiFixture(options.abiFixture);
  const fixturePath = options.fixturePath ?? ABI_FIXTURE_PATH;
  return parseAbiFixture(JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as unknown);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): ProofCommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 262_144,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-65_536);
  return { ok: result.status === 0, out };
}

class StdioCodexAppServer implements CodexProofAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private terminalError: Error | null = null;
  private closed = false;

  constructor(options: CodexProofAppServerOptions) {
    this.child = spawn(options.codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-RPC_STDERR_LIMIT);
    });
    this.child.on('error', (error) => this.fail(new Error(`could not spawn Codex app-server: ${String(error)}`)));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      if (!this.terminalError && this.pending.size > 0) {
        this.fail(new Error(`Codex app-server exited before replying (code=${String(code)}, signal=${String(signal)}): ${this.stderrTail()}`));
      }
    });
  }

  private fail(error: Error): void {
    if (!this.terminalError) this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try { this.child.kill('SIGKILL'); } catch { /* best effort */ }
  }

  private write(message: unknown): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex app-server stdin is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > RPC_STDOUT_LIMIT) {
      this.fail(new Error(`Codex app-server exceeded its ${RPC_STDOUT_LIMIT}-byte stdout limit`));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.fail(new Error(`invalid JSON from Codex app-server: ${line.slice(0, 300)}`));
        return;
      }
      if (!isRecord(message) || typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        const code = message.error.code;
        const text = message.error.message;
        pending.reject(new Error(`Codex RPC error ${String(code)}: ${String(text)}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex RPC ${method} timed out after ${timeoutMs}ms`);
        reject(error);
        this.fail(error);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  stderrTail(): string {
    return this.stderrBuffer.trim().slice(-2000);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server closed by trust proof'));
    }
    this.pending.clear();
    try { this.child.stdin.end(); } catch { /* best effort */ }
    try { this.child.kill('SIGTERM'); } catch { /* best effort */ }
    await new Promise<void>((resolve) => {
      if (this.closed) { resolve(); return; }
      const force = setTimeout(() => {
        try { this.child.kill('SIGKILL'); } catch { /* best effort */ }
        resolve();
      }, 1_000);
      this.child.once('close', () => {
        clearTimeout(force);
        resolve();
      });
    });
  }
}

export const defaultCodexProofAppServerFactory: CodexProofAppServerFactory = async (options) => {
  const client = new StdioCodexAppServer(options);
  try {
    const initialized = await client.request<unknown>('initialize', {
      clientInfo: { name: 'traffic-one-hook-trust-proof', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, options.timeoutMs);
    const reportedHome = isRecord(initialized) && typeof initialized.codexHome === 'string'
      ? fs.realpathSync(initialized.codexHome)
      : '';
    const expectedHome = fs.realpathSync(options.codexHome);
    if (!isRecord(initialized) || reportedHome !== expectedHome) {
      throw new Error(`Codex app-server did not confirm isolated CODEX_HOME ${options.codexHome}; response=${JSON.stringify(initialized).slice(0, 1000)}`);
    }
    client.notify('initialized');
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
};

function writeJson(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode });
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function patchPluginVersion(pluginRoot: string, version: string): void {
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!isRecord(manifest) || manifest.name !== 'traffic-one') {
    throw new Error(`invalid Codex plugin manifest at ${manifestPath}`);
  }
  writeJson(manifestPath, { ...manifest, version });
}

function installMarketplaceSource(distRoot: string, marketplaceRoot: string, version: string): string {
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'traffic-one');
  fs.rmSync(pluginRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
  fs.cpSync(distRoot, pluginRoot, { recursive: true, dereference: false });
  patchPluginVersion(pluginRoot, version);
  return pluginRoot;
}

function instrumentRuntime(pluginRoot: string, markerPath: string): void {
  const runtimePath = path.join(pluginRoot, 'scripts', 'hook-runtime.cjs');
  const original = fs.readFileSync(runtimePath, 'utf8');
  const prelude = [
    ';(() => {',
    '  try {',
    `    require('fs').appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ proofVersion: 2, subcommand: process.argv[2] || '' }) + '\\n', { encoding: 'utf8', mode: 0o600 });`,
    '  } catch { /* the harness fails closed when the marker is absent */ }',
    '})();',
    '',
  ].join('\n');
  if (original.startsWith('#!')) {
    const newline = original.indexOf('\n');
    fs.writeFileSync(runtimePath, `${original.slice(0, newline + 1)}${prelude}${original.slice(newline + 1)}`, 'utf8');
  } else {
    fs.writeFileSync(runtimePath, `${prelude}${original}`, 'utf8');
  }
}

function materializedV2Root(codexHome: string, hooks: Buffer, runtime: Buffer): string | null {
  const pending = [codexHome];
  let visited = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    if (++visited > 10_000) throw new Error('isolated CODEX_HOME exceeded the bounded v2 cache scan');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === '.codex-plugin') {
        const pluginRoot = path.dirname(child);
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(child, 'plugin.json'), 'utf8')) as unknown;
          if (
            isRecord(manifest)
            && manifest.name === 'traffic-one'
            && manifest.version === V2_VERSION
            && fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json')).equals(hooks)
            && fs.readFileSync(path.join(pluginRoot, 'scripts', 'hook-runtime.cjs')).equals(runtime)
          ) return pluginRoot;
        } catch { /* not the v2 cache entry */ }
      } else {
        pending.push(child);
      }
    }
  }
  return null;
}

export function createIsolatedCodexProofEnv(
  owner: string,
  codexHome: string,
  markerPath: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = path.join(owner, 'home');
  const xdgConfig = path.join(owner, 'xdg-config');
  const xdgState = path.join(owner, 'xdg-state');
  const xdgCache = path.join(owner, 'xdg-cache');
  for (const dir of [home, xdgConfig, xdgState, xdgCache]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'TERM',
  ]) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    TRAFFIC_ONE_CODEX_TRUST_PROOF_MARKER: markerPath,
    TRAFFIC_ONE_CODEX_TRUST_PROOF_NO_AUTH: 'intentionally-non-billable',
  });
  return env;
}

function assertNoBypass(args: string[]): void {
  if (args.some((arg) => arg.includes('dangerously-bypass-hook-trust'))) {
    throw new Error('trust proof refused a hook-trust bypass argument');
  }
}

function canonicalKey(fullKey: string): string {
  const prefix = `${CODEX_TRUST_PROOF_PLUGIN_ID}:hooks/hooks.json:`;
  if (!fullKey.startsWith(prefix)) {
    throw new Error(`unexpected Traffic One hook key ${JSON.stringify(fullKey)}; expected prefix ${prefix}`);
  }
  return fullKey.slice(prefix.length);
}

function parseHooksList(value: unknown, cwd: string): { hooks: HookMetadata[]; warnings: string[] } {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error('hooks/list returned an invalid response');
  const response = value as unknown as HooksListResponse;
  const entry = response.data.find((candidate) => path.resolve(candidate.cwd) === path.resolve(cwd));
  if (!entry || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || !Array.isArray(entry.warnings)) {
    throw new Error(`hooks/list did not return a valid entry for ${cwd}`);
  }
  if (entry.errors.length > 0) {
    throw new Error(`hooks/list reported discovery errors: ${JSON.stringify(entry.errors).slice(0, 1000)}`);
  }
  const hooks = entry.hooks.filter((hook) => hook.pluginId === CODEX_TRUST_PROOF_PLUGIN_ID);
  for (const hook of hooks) {
    if (
      typeof hook.key !== 'string'
      || typeof hook.currentHash !== 'string'
      || typeof hook.trustStatus !== 'string'
      || typeof hook.enabled !== 'boolean'
    ) throw new Error('hooks/list returned malformed Traffic One hook metadata');
  }
  return { hooks, warnings: entry.warnings };
}

function assertFixtureHooks(
  hooks: HookMetadata[],
  fixture: CodexHookAbiFixture,
  expectedStatus: 'untrusted' | 'trusted',
): void {
  if (hooks.length !== fixture.entries.length) {
    throw new Error(`discovered ${hooks.length} Traffic One hooks; expected ${fixture.entries.length}`);
  }
  const actualByKey = new Map<string, string>();
  for (const hook of hooks) {
    const key = canonicalKey(hook.key);
    if (actualByKey.has(key)) throw new Error(`hooks/list returned duplicate ABI key ${key}`);
    actualByKey.set(key, normalizedHash(hook.currentHash));
  }
  const expectedKeys = new Set(fixture.entries.map((entry) => entry.key));
  const unexpected = [...actualByKey.keys()].filter((key) => !expectedKeys.has(key));
  const missing = fixture.entries.filter((entry) => !actualByKey.has(entry.key)).map((entry) => entry.key);
  const changed = fixture.entries.filter((entry) => (
    actualByKey.has(entry.key)
    && actualByKey.get(entry.key) !== normalizedHash(entry.currentHash)
  )).map((entry) => entry.key);
  if (unexpected.length > 0 || missing.length > 0 || changed.length > 0) {
    throw new Error(`hooks/list does not match the Codex ABI v1 fixture: missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}] changed=[${changed.join(', ')}]`);
  }
  const invalid = hooks.filter((hook) => (
    hook.trustStatus !== expectedStatus
    || !hook.enabled
    || hook.isManaged
    || hook.handlerType !== 'command'
    || hook.source !== 'plugin'
  ));
  if (invalid.length > 0) {
    throw new Error(`expected all ${hooks.length} hooks to be enabled ${expectedStatus} plugin commands; invalid=${JSON.stringify(invalid).slice(0, 2000)}`);
  }
}

function readMarker(markerPath: string): MarkerEntry[] {
  let text = '';
  try { text = fs.readFileSync(markerPath, 'utf8'); } catch { return []; }
  const entries: MarkerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { throw new Error(`invalid runtime marker JSON: ${line.slice(0, 300)}`); }
    if (!isRecord(parsed) || parsed.proofVersion !== 2 || typeof parsed.subcommand !== 'string') {
      throw new Error(`invalid runtime marker payload: ${line.slice(0, 300)}`);
    }
    entries.push(parsed as unknown as MarkerEntry);
  }
  return entries;
}

function resetRuntimeMarker(markerPath: string): void {
  fs.writeFileSync(markerPath, '', { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(markerPath, 0o600);
  if (readMarker(markerPath).length !== 0) {
    throw new Error('could not reset the isolated runtime marker before lifecycle verification');
  }
}

async function waitForMarker(markerPath: string, subcommand: string, timeoutMs: number): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    if (readMarker(markerPath).some((entry) => entry.subcommand === subcommand)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`instrumented v2 runtime did not observe ${subcommand}`);
}

function failureResult(
  stage: ProofStage,
  error: unknown,
  startedAt: number,
  now: () => number,
  beforeTrusted: number,
  afterTrusted: number,
  observedEvents: string[],
  notes: string[],
): CodexTrustUpgradeProofResult {
  return {
    ok: false,
    stage,
    detail: error instanceof Error ? error.message : String(error),
    pluginId: CODEX_TRUST_PROOF_PLUGIN_ID,
    expectedHooks: CODEX_TRUST_PROOF_EXPECTED_HOOKS,
    beforeTrusted,
    afterTrusted,
    observedEvents,
    durationMs: Math.max(0, now() - startedAt),
    notes,
  };
}

export async function runCodexTrustUpgradeProof(
  options: CodexTrustUpgradeProofOptions,
  deps: CodexTrustUpgradeProofDeps = {},
): Promise<CodexTrustUpgradeProofResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = new ProofDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, now);
  const commandRunner = deps.commandRunner ?? runCommand;
  const appServerFactory = deps.appServerFactory ?? defaultCodexProofAppServerFactory;
  const v2MaterializationProbe = deps.materializedV2Probe ?? materializedV2Root;
  const codexBin = options.codexBin ?? process.env.TRAFFIC_ONE_CODEX_BIN ?? process.env.CODEX_CLI_PATH ?? 'codex';
  const notes: string[] = [];
  const observedEvents: string[] = [];
  let stage: ProofStage = 'setup';
  let beforeTrusted = 0;
  let afterTrusted = 0;
  let owner = '';
  let result: CodexTrustUpgradeProofResult | null = null;

  try {
    const fixture = loadAbiFixture(options);
    const distRoot = path.resolve(options.distRoot);
    const hooksPath = path.join(distRoot, 'hooks', 'hooks.json');
    const runtimePath = path.join(distRoot, 'scripts', 'hook-runtime.cjs');
    const distHooks = fs.readFileSync(hooksPath);
    fs.accessSync(runtimePath, fs.constants.R_OK);

    const tempParent = path.resolve(options.tempRootParent ?? os.tmpdir());
    fs.mkdirSync(tempParent, { recursive: true });
    owner = fs.mkdtempSync(path.join(tempParent, 'traffic-one-codex-trust-'));
    fs.chmodSync(owner, 0o700);
    const codexHome = path.join(owner, 'codex-home');
    const marketplaceRoot = path.join(owner, 'marketplace');
    const workspace = path.join(owner, 'workspace');
    const markerPath = path.join(owner, 'runtime-events.jsonl');
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(codexHome, 0o700);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, '', { mode: 0o600 });
    fs.chmodSync(markerPath, 0o600);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model = "traffic-one-trust-proof-model"',
      'model_provider = "traffic-one-trust-proof"',
      '',
      '[model_providers.traffic-one-trust-proof]',
      'name = "Traffic One trust proof (local non-billable endpoint)"',
      'base_url = "http://127.0.0.1:9/v1"',
      'env_key = "TRAFFIC_ONE_CODEX_TRUST_PROOF_NO_AUTH"',
      'wire_api = "responses"',
      '',
      '[analytics]',
      'enabled = false',
      '',
      `[projects.${JSON.stringify(workspace)}]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'), { mode: 0o600 });
    fs.chmodSync(path.join(codexHome, 'config.toml'), 0o600);
    const env = createIsolatedCodexProofEnv(owner, codexHome, markerPath);

    const v1Root = installMarketplaceSource(distRoot, marketplaceRoot, V1_VERSION);
    writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: CODEX_TRUST_PROOF_MARKETPLACE,
      interface: { displayName: 'Traffic One hook trust upgrade proof' },
      plugins: [{
        name: 'traffic-one',
        source: { source: 'local', path: './plugins/traffic-one' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      }],
    });
    const v1Hooks = fs.readFileSync(path.join(v1Root, 'hooks', 'hooks.json'));
    const v1Runtime = fs.readFileSync(path.join(v1Root, 'scripts', 'hook-runtime.cjs'));
    if (!v1Hooks.equals(distHooks)) throw new Error('v1 marketplace copy changed hooks/hooks.json bytes');

    stage = 'install-v1';
    for (const args of [
      ['plugin', 'marketplace', 'add', marketplaceRoot],
      ['plugin', 'add', CODEX_TRUST_PROOF_PLUGIN_ID],
    ]) {
      assertNoBypass(args);
      const installed = commandRunner(codexBin, args, {
        cwd: workspace,
        env,
        timeoutMs: deadline.remaining(stage, COMMAND_TIMEOUT_CAP_MS),
      });
      if (!installed.ok) throw new Error(`\`${codexBin} ${args.join(' ')}\` failed: ${installed.out.slice(-2000).trim()}`);
    }

    let firstClient: CodexProofAppServer | null = null;
    try {
      stage = 'list-v1';
      firstClient = await appServerFactory({
        codexBin,
        cwd: workspace,
        codexHome,
        env,
        markerPath,
        timeoutMs: deadline.remaining(stage),
      });
      const beforeResponse = await firstClient.request<unknown>('hooks/list', { cwds: [workspace] }, deadline.remaining(stage));
      const before = parseHooksList(beforeResponse, workspace);
      assertFixtureHooks(before.hooks, fixture, 'untrusted');
      beforeTrusted = before.hooks.filter((hook) => hook.trustStatus === 'trusted').length;
      notes.push(...before.warnings.map((warning) => `v1 hooks/list warning: ${warning}`));

      stage = 'approve-v1';
      const trustState: Record<string, { trusted_hash: string }> = {};
      for (const hook of before.hooks) trustState[hook.key] = { trusted_hash: normalizedHash(hook.currentHash) };
      const writeResponse = await firstClient.request<unknown>('config/batchWrite', {
        edits: [{ keyPath: 'hooks.state', value: trustState, mergeStrategy: 'upsert' }],
        reloadUserConfig: true,
      }, deadline.remaining(stage));
      if (!isRecord(writeResponse)) throw new Error('config/batchWrite returned an invalid response');
      if (
        typeof writeResponse.filePath === 'string'
        && fs.realpathSync(writeResponse.filePath) !== fs.realpathSync(path.join(codexHome, 'config.toml'))
      ) {
        throw new Error(`config/batchWrite escaped isolated CODEX_HOME: ${writeResponse.filePath}`);
      }
    } finally {
      await firstClient?.close();
    }

    const configStat = fs.statSync(path.join(codexHome, 'config.toml'));
    if ((configStat.mode & 0o777) !== 0o600) throw new Error('isolated Codex config.toml is not mode 0600 after approval');

    stage = 'install-v2';
    const v2Root = installMarketplaceSource(distRoot, marketplaceRoot, V2_VERSION);
    instrumentRuntime(v2Root, markerPath);
    const v2Hooks = fs.readFileSync(path.join(v2Root, 'hooks', 'hooks.json'));
    const v2Runtime = fs.readFileSync(path.join(v2Root, 'scripts', 'hook-runtime.cjs'));
    if (!v2Hooks.equals(v1Hooks)) throw new Error('v2 changed hooks/hooks.json bytes relative to trusted v1');
    if (v2Runtime.equals(v1Runtime)) throw new Error('v2 runtime did not change relative to v1');
    const v2InstallArgs = ['plugin', 'add', CODEX_TRUST_PROOF_PLUGIN_ID];
    assertNoBypass(v2InstallArgs);
    const installedV2 = commandRunner(codexBin, v2InstallArgs, {
      cwd: workspace,
      env,
      timeoutMs: deadline.remaining(stage, COMMAND_TIMEOUT_CAP_MS),
    });
    if (!installedV2.ok) throw new Error(`\`${codexBin} ${v2InstallArgs.join(' ')}\` failed: ${installedV2.out.slice(-2000).trim()}`);
    const cachedV2 = v2MaterializationProbe(codexHome, v2Hooks, v2Runtime);
    if (!cachedV2) throw new Error('Codex plugin install did not materialize the instrumented v2 runtime in isolated CODEX_HOME');
    notes.push(`v2 materialized at ${path.relative(codexHome, cachedV2)}`);

    let secondClient: CodexProofAppServer | null = null;
    try {
      stage = 'list-v2';
      secondClient = await appServerFactory({
        codexBin,
        cwd: workspace,
        codexHome,
        env,
        markerPath,
        timeoutMs: deadline.remaining(stage),
      });
      const afterResponse = await secondClient.request<unknown>('hooks/list', { cwds: [workspace] }, deadline.remaining(stage));
      const after = parseHooksList(afterResponse, workspace);
      assertFixtureHooks(after.hooks, fixture, 'trusted');
      afterTrusted = after.hooks.filter((hook) => hook.trustStatus === 'trusted').length;
      notes.push(...after.warnings.map((warning) => `v2 hooks/list warning: ${warning}`));

      stage = 'session-start';
      // Discovery/install activity is not lifecycle evidence. Reset the
      // per-proof marker immediately before the task under test so only rows
      // caused after this boundary can satisfy SessionStart/UserPromptSubmit.
      resetRuntimeMarker(markerPath);
      const threadResponse = await secondClient.request<unknown>('thread/start', {
        cwd: workspace,
        model: 'traffic-one-trust-proof-model',
        modelProvider: 'traffic-one-trust-proof',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
      }, deadline.remaining(stage));
      if (!isRecord(threadResponse) || !isRecord(threadResponse.thread) || typeof threadResponse.thread.id !== 'string') {
        throw new Error('thread/start returned an invalid response');
      }
      const turnRequest = secondClient.request<unknown>('turn/start', {
        threadId: threadResponse.thread.id,
        input: [{ type: 'text', text: 'Hook trust proof sentinel.', text_elements: [] }],
      }, deadline.remaining(stage));
      // App-server creates the thread first, then runs both lifecycle events at
      // the first turn boundary. Their markers are emitted before provider
      // authentication/model work; observe them and close immediately.
      void turnRequest.catch(() => undefined);
      await waitForMarker(markerPath, 'session-start', deadline.remaining(stage, MARKER_TIMEOUT_CAP_MS));
      observedEvents.push('SessionStart');

      stage = 'user-prompt-submit';
      await waitForMarker(markerPath, 'user-prompt-submit', deadline.remaining(stage, MARKER_TIMEOUT_CAP_MS));
      observedEvents.push('UserPromptSubmit');
    } finally {
      await secondClient?.close();
    }

    result = {
      ok: true,
      stage: 'user-prompt-submit',
      detail: 'Codex preserved ABI v1 trust across the v2 runtime/version upgrade and executed both lifecycle hooks',
      pluginId: CODEX_TRUST_PROOF_PLUGIN_ID,
      expectedHooks: fixture.entries.length,
      beforeTrusted,
      afterTrusted,
      observedEvents,
      durationMs: Math.max(0, now() - startedAt),
      notes,
    };
  } catch (error) {
    result = failureResult(stage, error, startedAt, now, beforeTrusted, afterTrusted, observedEvents, notes);
  } finally {
    if (owner) {
      try {
        fs.rmSync(owner, { recursive: true, force: true });
      } catch (error) {
        result = failureResult('cleanup', error, startedAt, now, beforeTrusted, afterTrusted, observedEvents, notes);
      }
    }
  }

  return result ?? failureResult('setup', 'proof produced no result', startedAt, now, beforeTrusted, afterTrusted, observedEvents, notes);
}

export function codexTrustUpgradeProofRequired(e2eHosts: ReadonlySet<string>): boolean {
  return e2eHosts.has('codex');
}

export async function runRequiredCodexTrustUpgradeProof(
  e2eHosts: ReadonlySet<string>,
  options: CodexTrustUpgradeProofOptions,
  deps: CodexTrustUpgradeProofDeps = {},
): Promise<CodexTrustUpgradeProofResult | null> {
  if (!codexTrustUpgradeProofRequired(e2eHosts)) return null;
  return runCodexTrustUpgradeProof(options, deps);
}
