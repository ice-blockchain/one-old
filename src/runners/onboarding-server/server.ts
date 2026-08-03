// src/runners/onboarding-server/server.ts
// The local onboarding wizard HTTP server. Binds loopback-only on an ephemeral
// port, guards every request with a 32-byte session token + Host/Origin checks
// (loopback hardening against DNS-rebind), and self-shuts-down on idle or on the
// completion route. In `standalone` mode (the detached production process) it
// publishes its {pid,port,token,url} to the registry after listen() and exits the
// process on shutdown; tests run with standalone:false and drive close() directly.

import * as crypto from 'crypto';
import * as http from 'http';

import { detectHost } from '../../shared/host';
import { canonicalHost } from '../../shared/model-tiers';
import { isWizardArrivalPath, noteBrowserArrival } from '../../shared/onboarding-server/browser-arrival';
import { probeDashboardHealth, writeDashboardHealth } from '../../shared/onboarding-server/dashboard-health';
import { clearServerRecord, writeServerRecord, type ServerRecord } from '../../shared/onboarding-server/registry';
import { stateTimestamp } from '../../shared/state/io';
import { dispatch, type RouteContext } from './routes';
import { seedGlobalCodeGraphProviderIfInstalled } from './seed-provider';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Traffic One never opens a browser for the user. The agent posts the link as
// plain clickable text and the user clicks it themselves. Auto-opening is what
// made agents believe the link "was already shared" while the conversation held
// no link at all (observed 2cu: browser_navigate, then "links were shared
// above", then the user asking for the link) — so there is deliberately no
// opener here, and no env flag to re-enable one.

export interface StartOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  // Explicit test seam. Production omits this and validates against the fixed
  // authenticated MCP endpoint compiled into the plugin.
  authEndpoint?: string;
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

// Constant-time token comparison. With CORS wide open the token is the sole auth
// boundary, so avoid leaking length/prefix via early-exit string compare.
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requestHostOk(req: http.IncomingMessage): boolean {
  const host = headerValue(req.headers.host);
  return host ? LOOPBACK_HOSTS.has(hostnameOf(host)) : false;
}

// CORS is intentionally wide open (`*`): the onboarding UI now lives on the
// traffic.io dashboard and calls this loopback server cross-origin. The 32-byte
// session token (x-t1-token header / ?t= query) is the SOLE auth boundary for the
// state/answer/task routes — the origin is NOT trusted, so we neither restrict nor
// reflect it. Applied to EVERY response (incl. 403/500) so the dashboard can read
// error bodies instead of seeing an opaque network failure. No credentials header:
// `*` forbids it and the token rides in a custom header, not a cookie.
function applyCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'content-type');
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
      if (standalone) clearServerRecord(cwd, env, trafficHost);
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
        // Origin is deliberately NOT checked — the dashboard calls cross-origin and
        // the token is the real gate. Host must still be loopback (DNS-rebind guard).
        applyCors(res);
        if (!requestHostOk(req)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        // Answer CORS preflights BEFORE the token gate — they carry no x-t1-token.
        // Chrome's Private Network Access asks permission to reach a loopback host
        // from a public (https) page; we grant it only when the browser requests it.
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'content-type, x-t1-token');
          res.setHeader('Access-Control-Max-Age', '600');
          if (headerValue(req.headers['access-control-request-private-network']) === 'true') {
            res.setHeader('Access-Control-Allow-Private-Network', 'true');
          }
          res.writeHead(204);
          res.end();
          return;
        }
        const reqUrl = new URL(req.url || '/', `http://${bindHost}:${port}`);
        if (reqUrl.pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }
        // The redirect shell (`/`), the local fallback wizard (`/local`) and health
        // are loopback-reachable and need NO token: the redirect page bootstraps the
        // dashboard, and `/local` re-injects the token into its own served HTML for
        // its API calls. The state/answer/task routes stay token-protected.
        const publicPath = reqUrl.pathname === '/' || reqUrl.pathname === '/index.html'
          || reqUrl.pathname === '/local' || reqUrl.pathname === '/healthz';
        const provided = headerValue(req.headers['x-t1-token']) || reqUrl.searchParams.get('t') || '';
        if (!publicPath && !tokenMatches(provided, token)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        // A request that reached here is authenticated (or on a public wizard
        // path) and came from a real browser, so it is the only trustworthy
        // evidence that the user actually received the setup link. Recorded
        // AFTER the token gate and only for the two wizard-UI paths — see
        // shared/onboarding-server/browser-arrival.ts for why `/`, `/healthz`,
        // `/favicon.ico` and preflights are deliberately excluded.
        if (isWizardArrivalPath(req.method || 'GET', reqUrl.pathname)) {
          noteBrowserArrival(cwd, token, env, trafficHost);
        }
        const ctx: RouteContext = {
          cwd,
          env,
          authEndpoint: options.authEndpoint,
          token,
          port,
          trafficHost,
          requestShutdown: standalone ? finish : cleanup,
        };
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
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
          process.on(signal, finish);
        }
        // Probe the hosted dashboard AFTER the record and the signal handlers are
        // in place, never before: this call can take seconds on a slow or offline
        // network, and ensureOnboardingServer gives the whole launch only ~4s
        // before it throws — a throw there means the user gets NO link at all.
        // Surfaces that render before the verdict lands simply show both URLs.
        void probeDashboardHealth(env)
          .then((health) => writeDashboardHealth(cwd, health, env, trafficHost))
          .catch(() => { /* absent verdict → both links, the safe default */ });
      }
      resolve({ server, host: bindHost, trafficHost, port, token, url, close });
    });
  });
}
