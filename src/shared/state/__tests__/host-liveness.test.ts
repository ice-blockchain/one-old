// Host-identity probes for the reuse stand-down hosts. The fixtures under
// tests/fixtures/host-liveness/ pin the published on-disk / payload layouts;
// they are not live captures, so opencode / kilo / windsurf stay listed in
// HOSTS_WITHOUT_VERIFIABLE_REUSE. SQLite `opencode.db` is an explicit residual.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SUBAGENT_STALE_MS } from '../../../config/state';
import {
  findHostSessionFile,
  kiloDataDir,
  openCodeDataDir,
  subagentContinuationAvailable,
  validateHostLiveRunAgent,
  validateKiloLiveRunAgent,
  validateOpenCodeLiveRunAgent,
  validateWindsurfLiveRunAgent,
  type RunAgentEntry,
} from '../run-agent';

const TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'host-liveness');
const OPENCODE_SESSION = 'ses_recorded_architect';
const OPENCODE_PARENT = 'ses_recorded_parent';
const KILO_SESSION = 'ses_recorded_kilo_frontend';
const KILO_PARENT = 'ses_recorded_kilo_parent';
const WINDSURF_TRAJECTORY = 'cascade-trajectory-recorded';
const FIXTURE_UPDATED_MS = 1_700_000_005_000;

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TEMP_DIRS.push(dir);
  return dir;
}

function isolatedEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = tempDir('t1-host-live-');
  const home = path.join(base, 'home');
  const xdg = path.join(base, 'xdg-data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: xdg,
    OPENCODE_DATA_DIR: '',
    KILO_DATA_DIR: '',
    KILO_HOME: '',
    ...over,
  };
}

function plantSession(dataRoot: string, sessionId: string, source: string, projectId = 'proj-fixture'): string {
  const dest = path.join(dataRoot, 'storage', 'session', projectId, `${sessionId}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  return dest;
}

function entry(over: Partial<RunAgentEntry> & Pick<RunAgentEntry, 'agentId'>): RunAgentEntry {
  return {
    role: 'senior-architect',
    model: null,
    agentType: null,
    parentSessionId: null,
    recordedAt: new Date().toISOString(),
    tasks: 1,
    replaced: false,
    ...over,
  };
}

test('OpenCode probe matches a recorded session fixture and conflicts on parent mismatch', () => {
  const env = isolatedEnv();
  const dataRoot = openCodeDataDir(env);
  plantSession(dataRoot, OPENCODE_SESSION, path.join(FIXTURES, 'opencode-session.json'));
  const nowMs = FIXTURE_UPDATED_MS + 60_000;
  const live = entry({
    agentId: OPENCODE_SESSION,
    parentSessionId: OPENCODE_PARENT,
    recordedAt: new Date(FIXTURE_UPDATED_MS).toISOString(),
  });

  assert.equal(validateOpenCodeLiveRunAgent(live, env, nowMs).status, 'verified-match');
  assert.equal(validateHostLiveRunAgent('opencode', live, {}, env, nowMs)?.status, 'verified-match');

  const missing = validateOpenCodeLiveRunAgent(entry({ agentId: 'ses_absent' }), env, nowMs);
  assert.equal(missing.status, 'unverified');
  if (missing.status === 'unverified') assert.equal(missing.reason, 'host-session-missing');

  const parent = validateOpenCodeLiveRunAgent({ ...live, parentSessionId: 'ses_other_parent' }, env, nowMs);
  assert.equal(parent.status, 'conflict');
  if (parent.status === 'conflict') assert.equal(parent.reason, 'host-session-parent-mismatch');

  const stale = validateOpenCodeLiveRunAgent(live, env, FIXTURE_UPDATED_MS + SUBAGENT_STALE_MS + 1);
  assert.equal(stale.status, 'stale-retired');
});

test('Kilo probe matches a recorded session fixture under KILO_DATA_DIR', () => {
  const dataRoot = path.join(tempDir('t1-kilo-data-'), 'kilo');
  const env = isolatedEnv({ KILO_DATA_DIR: dataRoot });
  assert.equal(kiloDataDir(env), dataRoot);
  plantSession(dataRoot, KILO_SESSION, path.join(FIXTURES, 'kilo-session.json'));
  const nowMs = FIXTURE_UPDATED_MS + 60_000;
  const live = entry({
    agentId: KILO_SESSION,
    role: 'senior-frontend',
    parentSessionId: KILO_PARENT,
    recordedAt: new Date(FIXTURE_UPDATED_MS).toISOString(),
  });

  assert.equal(validateKiloLiveRunAgent(live, env, nowMs).status, 'verified-match');
  assert.equal(findHostSessionFile(dataRoot, KILO_SESSION), path.join(
    dataRoot, 'storage', 'session', 'proj-fixture', `${KILO_SESSION}.json`,
  ));
});

test('Windsurf probe corroborates a host-supplied trajectory_id and rejects the synthetic empty id', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'windsurf-trajectory-payload.json'), 'utf8')) as Record<string, unknown>;
  const live = entry({
    agentId: 'windsurf-child',
    trajectoryId: WINDSURF_TRAJECTORY,
    parentSessionId: WINDSURF_TRAJECTORY,
  });

  assert.equal(validateWindsurfLiveRunAgent(live, fixture).status, 'verified-match');
  assert.equal(validateHostLiveRunAgent('windsurf', live, fixture)?.status, 'verified-match');

  const synthetic = validateWindsurfLiveRunAgent(live, { ...fixture, trajectory_id: '' });
  assert.equal(synthetic.status, 'unverified');
  if (synthetic.status === 'unverified') assert.equal(synthetic.reason, 'windsurf-trajectory-synthetic');

  const missing = validateWindsurfLiveRunAgent(live, { cwd: '/workspace/app' });
  assert.equal(missing.status, 'unverified');
  if (missing.status === 'unverified') assert.equal(missing.reason, 'windsurf-trajectory-missing');

  const mismatch = validateWindsurfLiveRunAgent(live, { ...fixture, trajectory_id: 'cascade-other' });
  assert.equal(mismatch.status, 'conflict');
  if (mismatch.status === 'conflict') assert.equal(mismatch.reason, 'windsurf-trajectory-mismatch');
});

test('published-layout fixtures do not lift the reuse stand-down', () => {
  for (const host of ['opencode', 'kilo', 'windsurf'] as const) {
    assert.equal(subagentContinuationAvailable({} as NodeJS.ProcessEnv, host), false, host);
  }
});
