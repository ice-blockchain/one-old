// src/shared/onboarding-server/dashboard-health.ts
// Is the hosted onboarding page usable? The answer decides whether a setup
// message carries ONE url (the traffic.io deep link) or two (plus the loopback
// wizard as a recovery link).
//
// The PROBE runs in the detached wizard server — never in a hook. onboardingGate
// is a synchronous function and the hook runtime makes no outbound calls; the
// server is already an async process that every URL surface waits on anyway. It
// probes AFTER publishing its record, so a slow or hanging network can never eat
// into ensureOnboardingServer's readiness budget and leave the user with no link
// at all (a strictly worse failure than the one this file exists to fix).
//
// The VERDICT lives next to server.json in the per-project/per-host runtime dir,
// so it honours TRAFFIC_ONE_PROJECT_PREFS_PATH like every other onboarding
// runtime file. It must NOT live in ~/.traffic-one: that path resolves from HOME
// and the unit-test harness does not override it, so a global cache would make
// the suite read the developer's real machine state.

import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';

import { classifyDashboardStatus, dashboardProbeUrl, dashboardUrlFromEnv, type DashboardHealth } from '../../config/dashboard';
import { readJson } from '../fsjson';
import { obj } from '../obj';
import { serverRecordPath } from './registry';

// Nothing blocks on this probe — the server has already published its record and
// installed its signal handlers — so it can afford to be patient. Measured: a cold
// first connection (DNS + TLS, no cache) took >2s on a healthy traffic.io that
// answers in ~100ms warm, so a tight timeout reported a perfectly good dashboard as
// unhealthy and printed a second URL nobody needed.
const DASHBOARD_PROBE_TIMEOUT_MS = 8000;

// How long a NON-hook surface (the bootstrap runner) may wait for the detached
// server's verdict before falling back to showing both links. Bounded hard: the
// setup link matters far more than which URLs accompany it.
const DASHBOARD_VERDICT_WAIT_MS = 2500;
const VERDICT_POLL_MS = 50;

interface DashboardVerdictFile {
  /** Which dashboard origin this verdict describes — an override must not reuse it. */
  base: string;
  health: DashboardHealth;
  checkedAt: string;
}

function verdictPath(cwd: string, env: NodeJS.ProcessEnv, host?: unknown): string {
  return path.join(path.dirname(serverRecordPath(cwd, env, host)), 'dashboard-health.json');
}

// `null` = not probed yet (or probed against a different origin). Callers treat
// null as "show both links" — the safe default that never strands the user.
export function readDashboardHealth(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
): DashboardHealth | null {
  try {
    const raw = obj(readJson(verdictPath(cwd, env, host), null));
    if (!raw) return null;
    if (raw.base !== dashboardUrlFromEnv(env)) return null;
    return raw.health === 'healthy' || raw.health === 'unhealthy' ? raw.health : null;
  } catch {
    return null;
  }
}

export function writeDashboardHealth(
  cwd: string,
  health: DashboardHealth,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
): void {
  const file = verdictPath(cwd, env, host);
  const value: DashboardVerdictFile = {
    base: dashboardUrlFromEnv(env),
    health,
    checkedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // best-effort — an unwritable verdict just means "show both links"
  }
}

// Bounded synchronous wait for the detached server's verdict, for the ONE surface
// that can afford it: the bootstrap runner, which prints the first link the user
// ever sees and is a normal approved shell process (not a hook). Without this the
// first message would always carry both URLs, since the probe is necessarily still
// in flight when the server has only just started. Sleeps the same way the wait
// runner does, so no async plumbing leaks into a synchronous caller.
export function awaitDashboardHealth(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
  maxWaitMs: number = DASHBOARD_VERDICT_WAIT_MS,
): DashboardHealth | null {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const health = readDashboardHealth(cwd, env, host);
    if (health) return health;
    if (Date.now() >= deadline) return null;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, VERDICT_POLL_MS);
    } catch {
      return null;
    }
  }
}

type ProbeRequest = typeof https.request;

// Resolves 'unhealthy' for every transport failure (DNS, TLS, timeout, offline):
// a page the user's machine cannot reach is exactly as unusable as a 404, and
// the loopback wizard still works with no network at all. Never rejects.
export function probeDashboardHealth(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DASHBOARD_PROBE_TIMEOUT_MS,
  requestFactory?: ProbeRequest,
): Promise<DashboardHealth> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (health: DashboardHealth): void => {
      if (settled) return;
      settled = true;
      resolve(health);
    };
    // Independent of the request's own timeout: a stubbed factory that never
    // settles must not hang the server's post-listen work forever.
    const guard = setTimeout(() => done('unhealthy'), timeoutMs + 500);
    if (typeof guard.unref === 'function') guard.unref();
    try {
      const url = new URL(dashboardProbeUrl(env));
      const request = requestFactory
        ?? (url.protocol === 'http:' ? (http.request as unknown as ProbeRequest) : https.request);
      const req = request({
        method: 'HEAD',
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        timeout: timeoutMs,
      }, (res) => {
        res.resume();
        done(classifyDashboardStatus(res.statusCode || 0));
      });
      req.on('timeout', () => {
        req.destroy();
        done('unhealthy');
      });
      req.on('error', () => done('unhealthy'));
      req.end();
    } catch {
      // Malformed TRAFFIC_ONE_DASHBOARD_URL override — dashboardUrlFromEnv is
      // documented never to throw, but `new URL` on its result still can.
      done('unhealthy');
    }
  });
}
