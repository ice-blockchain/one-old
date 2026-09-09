import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { DEPLOY_RE, deployGate } from '../deploy-gate';
import { pluginVersion } from '../../../config/plugin-identity';
import { computeProjectFingerprint } from '../../../runners/security-check';
import { stampState, type Report } from '../../../runners/security-check/lib';
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
  for (const cmd of [
    'vercel deploy',
    'vercel --prod',
    'eas submit',
    'eas update',
    'eas build --auto-submit',
    'supabase db push',
    'supabase db push --linked',
    'supabase functions deploy my-fn',
    'supabase functions deploy my-fn --linked',
    'fly deploy',
    'wrangler deploy',
    'netlify deploy --prod',
    'netlify deploy --dir dist --prod',
    'firebase deploy',
    'npm publish',
    'pnpm publish',
    'yarn publish',
    'bun publish',
    'gh release create v1',
    'npm run build && vercel deploy',
    'echo x; supabase db push',
  ]) {
    assert.ok(DEPLOY_RE.test(cmd), `expected gated: ${cmd}`);
  }
  for (const cmd of [
    'npm install',
    'pnpm build',
    'vercel',
    'vercel dev',
    'npx vercel',
    'echo vercel',
    'eas build',
    'netlify deploy',
    'netlify deploy --dir dist',
    'supabase functions deploy',
    'firebase serve',
    'yarn install',
    'bun install',
    'ls -la',
  ]) {
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

// ── Future-stamped approvals ─────────────────────────────────────────────────
// `.one.json` is ordinary project JSON and both windows here are spelled
// `Date.now() - stamp < WINDOW`. A stamp dated ahead of now makes that
// difference negative, so it passes the window by a margin that only GROWS with
// the lie — a permanent deploy authorization from a check that may never have
// run. `futureIso` is well beyond STATE_TIMESTAMP_FUTURE_SKEW_MS, which is the
// allowance real clock jitter is expected to fit inside.
const futureIso = (): string => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

test('deploy gate denies a future-dated shipper approval', () => {
  withProject({ lastShipperApprovalAt: futureIso() }, (cwd) => {
    const r = deployGate(ctxFor(cwd, 'vercel deploy'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.equal(r.denyId, 'deploy-gate-shipper-approval-required');
  });
});

test('deploy gate denies a future-dated security check even with a fresh shipper approval', () => {
  withProject({ lastShipperApprovalAt: nowIso(), lastSecurityCheckStatus: 'passed', lastSecurityCheckAt: futureIso(), lastSecurityCheckStrict: true }, (cwd) => {
    // The fingerprint is stamped MATCHING, so the only thing left to refuse the
    // deploy is the security stamp's own date. Without that, this deploy is
    // allowed — which is the defect.
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.lastSecurityCheckFingerprint = computeProjectFingerprint(cwd).fingerprint;
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    const r = deployGate(ctxFor(cwd, 'npm publish'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.equal(r.denyId, 'deploy-gate-security-check-stale');
  });
});

// Non-vacuity: the two denials above must come from the DATE, not from the
// harness failing to produce a deployable project. The same state with present
// dates is allowed, and the same state one skew-allowance ahead is still
// allowed — so the refusal is the future bound, not a general distrust of any
// stamp that is not exactly `now`.
test('a stamp inside the skew allowance is still an approval', () => {
  const nearFuture = new Date(Date.now() + 60_000).toISOString();
  withProject({ lastShipperApprovalAt: nearFuture, lastSecurityCheckStatus: 'passed', lastSecurityCheckAt: nearFuture, lastSecurityCheckStrict: true }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.lastSecurityCheckFingerprint = computeProjectFingerprint(cwd).fingerprint;
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    assert.equal(deployGate(ctxFor(cwd, 'npm publish')).kind, 'noop', 'ordinary clock jitter must not block a deploy');
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
  withProject({ lastShipperApprovalAt: nowIso(), lastSecurityCheckStatus: 'passed', lastSecurityCheckAt: nowIso(), lastSecurityCheckStrict: true, lastSecurityCheckFingerprint: 'stale-fingerprint' }, (cwd) => {
    const r = deployGate(ctxFor(cwd, 'vercel deploy'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('worktree changed'));
  });
});

test('deploy gate allows a deploy with fresh shipper + passing fingerprint-matched security check', () => {
  withProject({ lastShipperApprovalAt: nowIso(), lastSecurityCheckStatus: 'passed', lastSecurityCheckAt: nowIso(), lastSecurityCheckStrict: true }, (cwd) => {
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

test('deploy gate denies a fresh passing stamp that was not a --strict run', () => {
  withProject({
    lastShipperApprovalAt: nowIso(),
    lastSecurityCheckStatus: 'passed',
    lastSecurityCheckAt: nowIso(),
    lastSecurityCheckStrict: false,
  }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.lastSecurityCheckFingerprint = computeProjectFingerprint(cwd).fingerprint;
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    const r = deployGate(ctxFor(cwd, 'vercel deploy'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.equal(r.denyId, 'deploy-gate-security-check-stale');
      assert.ok(r.reason.includes('--strict'));
    }
  });
});

test('deploy gate denies a legacy stamp that omits lastSecurityCheckStrict', () => {
  withProject({
    lastShipperApprovalAt: nowIso(),
    lastSecurityCheckStatus: 'passed',
    lastSecurityCheckAt: nowIso(),
  }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.lastSecurityCheckFingerprint = computeProjectFingerprint(cwd).fingerprint;
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    const r = deployGate(ctxFor(cwd, 'npm publish'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.equal(r.denyId, 'deploy-gate-security-check-stale');
      assert.ok(r.reason.includes('--strict'));
    }
  });
});

test('a clean --strict stamp is accepted by the deploy gate with a fresh shipper stamp', () => {
  withProject({ lastShipperApprovalAt: nowIso(), version: pluginVersion() }, (cwd) => {
    const fp = computeProjectFingerprint(cwd);
    const report: Report = {
      generatedAt: nowIso(),
      status: 'passed',
      strict: true,
      cwd,
      fingerprint: fp,
      tools: {},
      externalReports: {},
      issues: [],
    };
    assert.equal(stampState(cwd, report, '.traffic-one/reports/security.json'), true);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state.lastSecurityCheckStrict, true);
    assert.equal(state.lastSecurityCheckStatus, 'passed');
    assert.equal(state.lastSecurityCheckFingerprint, fp.fingerprint);
    assert.equal(deployGate(ctxFor(cwd, 'vercel deploy')).kind, 'noop');
  });
});

test('a clean non-strict stamp does not authorize deploy', () => {
  withProject({ lastShipperApprovalAt: nowIso(), version: pluginVersion() }, (cwd) => {
    const fp = computeProjectFingerprint(cwd);
    const report: Report = {
      generatedAt: nowIso(),
      status: 'passed',
      strict: false,
      cwd,
      fingerprint: fp,
      tools: {},
      externalReports: {},
      issues: [],
    };
    assert.equal(stampState(cwd, report, '.traffic-one/reports/security.json'), true);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state.lastSecurityCheckStrict, false);
    const r = deployGate(ctxFor(cwd, 'vercel deploy'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.equal(r.denyId, 'deploy-gate-security-check-stale');
      assert.ok(r.reason.includes('--strict'));
    }
  });
});
