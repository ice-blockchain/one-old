import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { DEPLOY_RE, deployGate } from '../deploy-gate';
import { computeProjectFingerprint } from '../../../runners/security-check';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function withProject(stamps: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-deploy-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'some code', 'utf8');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase', ...stamps }), 'utf8');
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: {}, tool: { class: 'shell' as ToolClass, rawName: 'Bash', command } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

const nowIso = (): string => new Date().toISOString();

test('DEPLOY_RE matches the gated publish commands, not benign ones', () => {
  for (const cmd of ['vercel deploy', 'vercel --prod', 'eas submit', 'fly deploy', 'wrangler deploy', 'npm publish', 'pnpm publish', 'gh release create v1']) {
    assert.ok(DEPLOY_RE.test(cmd), `expected gated: ${cmd}`);
  }
  for (const cmd of ['npm install', 'pnpm build', 'vercel dev', 'ls -la']) {
    assert.ok(!DEPLOY_RE.test(cmd), `expected benign: ${cmd}`);
  }
});

test('deploy gate ignores non-deploy commands', () => {
  withProject({}, (cwd) => {
    assert.equal(deployGate(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('deploy gate denies a deploy with no shipper approval', () => {
  withProject({}, (cwd) => {
    const r = deployGate(ctxFor(cwd, 'pnpm publish'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('senior-shipper'));
  });
});

test('deploy gate denies when shipper is fresh but the security check is missing', () => {
  withProject({ lastShipperApprovalAt: nowIso() }, (cwd) => {
    const r = deployGate(ctxFor(cwd, 'vercel deploy'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('security check'));
  });
});

test('deploy gate denies when the worktree fingerprint changed after the security check', () => {
  withProject({ lastShipperApprovalAt: nowIso(), lastSecurityCheckStatus: 'passed', lastSecurityCheckAt: nowIso(), lastSecurityCheckFingerprint: 'stale-fingerprint' }, (cwd) => {
    const r = deployGate(ctxFor(cwd, 'vercel deploy'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('worktree changed'));
  });
});

test('deploy gate allows a deploy with fresh shipper + passing fingerprint-matched security check', () => {
  withProject({ lastShipperApprovalAt: nowIso(), lastSecurityCheckStatus: 'passed', lastSecurityCheckAt: nowIso() }, (cwd) => {
    // The fingerprint excludes the traffic-one stamp fields, so it is stable as
    // we write it back. Stamp the matching fingerprint, then the gate allows.
    const fp = computeProjectFingerprint(cwd).fingerprint;
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.lastSecurityCheckFingerprint = fp;
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    assert.equal(deployGate(ctxFor(cwd, 'vercel deploy')).kind, 'noop');
  });
});
