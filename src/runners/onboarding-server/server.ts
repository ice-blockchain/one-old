// src/runners/onboarding-server/server.ts
// The local onboarding wizard HTTP server. Binds loopback-only on an ephemeral
// port, guards every request with a 32-byte session token + Host/Origin checks
// (loopback hardening against DNS-rebind), and self-shuts-down on idle or on the
// completion route. In `standalone` mode (the detached production process) it
// publishes its {pid,port,token,url} to the registry after listen() and exits the
// process on shutdown; tests run with standalone:false and drive close() directly.

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';

import { detectHost } from '../../shared/host';
import { canonicalHost } from '../../shared/model-tiers';
import { clearServerRecord, writeServerRecord, type ServerRecord } from '../../shared/onboarding-server/registry';
import { stateTimestamp } from '../../shared/state/io';
import { removeLaunchConfig, writeLaunchConfig } from './launch-config';
import { dispatch, type RouteContext } from './routes';
import { seedGlobalCodeGraphProviderIfInstalled } from './seed-provider';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Off by DEFAULT — Traffic One targets the editor's in-app surface: Claude Code's
// preview pane, and on Cursor the built-in Simple Browser opened by clicking the
// agent-surfaced wizard link (Cursor has no API to auto-open it, and auto-popping
// the EXTERNAL OS browser is both off-target and prone to double-open under the
// gate's spawn race — so we do NOT do it for Cursor). Opt in to pop the OS default
// browser only with TRAFFIC_ONE_OPEN_BROWSER=1. Fire-and-forget.
export function shouldOpenBrowser(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.TRAFFIC_ONE_OPEN_BROWSER || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function maybeOpenBrowser(url: string, env: NodeJS.ProcessEnv): void {
  if (!shouldOpenBrowser(env)) return;
  const opener = process.platform === 'darwin'
    ? { cmd: 'open', args: [url] }
    : process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
      : { cmd: 'xdg-open', args: [url] };
  try {
    spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // best-effort; the clickable URL is the real surface
  }
}

export interface StartOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  // Network bind address. Kept separate from the Traffic One product host so a
  // Cursor server can never accidentally register itself as `127.0.0.1`.
  bindHost?: string;
  trafficHost?: string;
  port?: number;
  token?: string;
  idleMs?: number;
  standalone?: boolean;
}

export interface RunningServer {
  server: http.Server;
  // Network bind address (backward-compatible field name).
  host: string;
  trafficHost: string;
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase().replace(/:\d+$/, '');
  return trimmed.replace(/^\[|\]$/g, '');
}

function requestHostOk(req: http.IncomingMessage): boolean {
  const host = headerValue(req.headers.host);
  return host ? LOOPBACK_HOSTS.has(hostnameOf(host)) : false;
}

function requestOriginOk(req: http.IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function startOnboardingServer(options: StartOptions): Promise<RunningServer> {
  const env = options.env || process.env;
  const bindHost = options.bindHost || '127.0.0.1';
  const trafficHost = canonicalHost(options.trafficHost ?? detectHost(env));
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const standalone = options.standalone ?? true;
  const cwd = options.cwd;

  // Seed the machine-wide code-graph provider from an already-installed binary so
  // the wizard can skip the code-graph prompt. Real launches only (never the
  // in-process test server), so `which` can't non-deterministically seed tests.
  if (standalone) {
    try {
      seedGlobalCodeGraphProviderIfInstalled(cwd, env);
    } catch {
      // best-effort — detection failure must never block the wizard
    }
  }

  let port = 0;
  let url = '';
  let idleTimer: NodeJS.Timeout | null = null;
  let cleaned = false;

  return new Promise<RunningServer>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (idleTimer) idleTimer.refresh();
      void route(req, res);
    });

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (standalone) {
        clearServerRecord(cwd, env, trafficHost);
        // `.claude/launch.json` belongs exclusively to Claude's preview pane.
        // Other host servers may run in parallel and must not remove it.
        if (trafficHost === 'claude') removeLaunchConfig(cwd);
      }
    };

    const finish = (): void => {
      cleanup();
      server.close();
      // Let the in-flight response flush before the detached process exits.
      setTimeout(() => process.exit(0), 120).unref();
    };

    const close = (): Promise<void> => new Promise<void>((res) => {
      cleanup();
      server.close(() => res());
    });

    async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      try {
        if (!requestHostOk(req) || !requestOriginOk(req)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        const reqUrl = new URL(req.url || '/', `http://${bindHost}:${port}`);
        if (reqUrl.pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }
        // The page shell + health are loopback-only and need NO token, so the editor's
        // preview pane (which loads the bare URL via preview_start) can open it. The
        // served page carries the token for its own API calls; the state/answer/task
        // routes stay token-protected.
        const publicPath = reqUrl.pathname === '/' || reqUrl.pathname === '/index.html' || reqUrl.pathname === '/healthz';
        const provided = headerValue(req.headers['x-t1-token']) || reqUrl.searchParams.get('t') || '';
        if (!publicPath && provided !== token) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        const ctx: RouteContext = { cwd, env, token, port, trafficHost, requestShutdown: standalone ? finish : cleanup };
        await dispatch(req, res, reqUrl, ctx);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message || 'server error' }));
      }
    }

    server.on('error', (err) => {
      if (!port) reject(err);
    });

    server.listen(options.port ?? 0, bindHost, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      url = `http://${bindHost}:${port}/?t=${token}`;
      // Idle reaper: close (and, when standalone, exit) after inactivity. The
      // timer is refreshed on every request (see the request handler above).
      idleTimer = setTimeout(standalone ? finish : () => { void close(); }, idleMs);
      if (!standalone) idleTimer.unref();
      if (standalone) {
        const record: ServerRecord = { pid: process.pid, port, token, url, startedAt: stateTimestamp(), host: trafficHost };
        try {
          writeServerRecord(cwd, record, env, trafficHost);
        } catch {
          // best-effort; the agent can still be handed the URL from this process
        }
        // Register with Claude Code's preview (.claude/launch.json) so the agent can
        // show the wizard in the in-app preview pane via preview_start.
        if (trafficHost === 'claude') writeLaunchConfig(cwd, port);
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
          process.on(signal, finish);
        }
        maybeOpenBrowser(url, env);
      }
      resolve({ server, host: bindHost, trafficHost, port, token, url, close });
    });
  });
}
