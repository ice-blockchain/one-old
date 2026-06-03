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

import { clearServerRecord, writeServerRecord, type ServerRecord } from '../../shared/onboarding-server/registry';
import { stateTimestamp } from '../../shared/state/io';
import { dispatch, type RouteContext } from './routes';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Auto-open the wizard in the OS default browser by DEFAULT so it "just opens"
// rather than only printing a link (the agent additionally opens it inline where it
// has a preview/browser tool). Opt out with TRAFFIC_ONE_OPEN_BROWSER=0|false|no|off
// for headless/CI. Fire-and-forget; never throws — the clickable URL is the final
// fallback regardless.
export function shouldOpenBrowser(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.TRAFFIC_ONE_OPEN_BROWSER || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'no' || flag === 'off');
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
  host?: string;
  port?: number;
  token?: string;
  idleMs?: number;
  standalone?: boolean;
}

export interface RunningServer {
  server: http.Server;
  host: string;
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
  const host = options.host || '127.0.0.1';
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const standalone = options.standalone ?? true;
  const cwd = options.cwd;

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
      if (standalone) clearServerRecord(cwd, env);
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
        const reqUrl = new URL(req.url || '/', `http://${host}:${port}`);
        // Browsers auto-request /favicon.ico (no token) — answer 204 so it doesn't
        // surface a noisy 403 in the console.
        if (reqUrl.pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }
        const provided = headerValue(req.headers['x-t1-token']) || reqUrl.searchParams.get('t') || '';
        if (provided !== token) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        const ctx: RouteContext = { cwd, env, token, port, requestShutdown: standalone ? finish : cleanup };
        await dispatch(req, res, reqUrl, ctx);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message || 'server error' }));
      }
    }

    server.on('error', (err) => {
      if (!port) reject(err);
    });

    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      url = `http://${host}:${port}/?t=${token}`;
      // Idle reaper: close (and, when standalone, exit) after inactivity. The
      // timer is refreshed on every request (see the request handler above).
      idleTimer = setTimeout(standalone ? finish : () => { void close(); }, idleMs);
      if (!standalone) idleTimer.unref();
      if (standalone) {
        const record: ServerRecord = { pid: process.pid, port, token, url, startedAt: stateTimestamp() };
        try {
          writeServerRecord(cwd, record, env);
        } catch {
          // best-effort; the agent can still be handed the URL from this process
        }
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
          process.on(signal, finish);
        }
        maybeOpenBrowser(url, env);
      }
      resolve({ server, host, port, token, url, close });
    });
  });
}
