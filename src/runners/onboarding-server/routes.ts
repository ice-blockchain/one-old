// src/runners/onboarding-server/routes.ts
// HTTP route dispatch for the onboarding wizard. Token + loopback checks happen in
// server.ts before this runs. The state/answer/task routes are thin glue over the
// shared flow brain (computeOnboarding / applyAnswer) + the async task runner; the
// completion route writes the sentinel and asks the server to shut down.

import type { IncomingMessage, ServerResponse } from 'http';

import { applyAnswer, computeOnboarding } from '../../shared/onboarding-server/flow';
import { writeCompletionSentinel } from '../../shared/onboarding-server/registry';
import { obj } from '../../shared/obj';
import { validateApiKey } from '../auth/validate-key';
import { probeOnboardingToolchain } from '../toolchain/onboarding';
import { dashboardUrlFromEnv } from '../../config/dashboard';
import { redirectHtml, wizardHtml } from './html';
import { getTask, startInstallTask } from './tasks';

export interface RouteContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  token: string;
  port: number;
  requestShutdown: () => void;
}

const MAX_BODY_BYTES = 256 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): Promise<void> {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // `/` forwards to the traffic.io dashboard (the onboarding UI now lives there);
  // `/local` still serves the full self-contained wizard as an offline / blocked-
  // browser fallback. Both are token-free public paths (see server.ts publicPath).
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendHtml(res, 200, redirectHtml(ctx.token, ctx.port, dashboardUrlFromEnv(ctx.env)));
    return;
  }

  if (method === 'GET' && pathname === '/local') {
    sendHtml(res, 200, wizardHtml(ctx.token));
    return;
  }

  if (method === 'GET' && pathname === '/state') {
    sendJson(res, 200, computeOnboarding(ctx.cwd));
    return;
  }

  if (method === 'POST' && pathname === '/answer') {
    const body = obj(await readJsonBody(req)) || {};
    const step = typeof body.step === 'string' ? body.step : '';
    if (!step) {
      sendJson(res, 400, { ok: false, error: 'missing step' });
      return;
    }
    // The API key is VALIDATED against the auth endpoint before it is stored — a
    // rejected or unverifiable key never lets onboarding proceed (fail-closed).
    if (step === 'api-key') {
      const key = String((obj(body.value)?.apiKey ?? body.value ?? '')).trim();
      if (!key) {
        sendJson(res, 400, { ok: false, error: 'Enter your API key to continue.' });
        return;
      }
      const check = await validateApiKey(key, ctx.env);
      if (!check.ok) {
        const error = check.reason === 'invalid-api-key'
          ? 'That API key was rejected. Double-check it and try again.'
          : 'Could not reach Traffic One to verify the key. Check your connection and try again.';
        sendJson(res, 400, { ok: false, error });
        return;
      }
    }
    const outcome = applyAnswer(ctx.cwd, step, body.value);
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: outcome.error || 'invalid answer' });
      return;
    }
    const view = computeOnboarding(ctx.cwd);
    if (outcome.task) {
      const taskId = startInstallTask(ctx.cwd, ctx.env);
      sendJson(res, 200, { ok: true, taskId, view });
      return;
    }
    sendJson(res, 200, { ok: true, view });
    return;
  }

  if (method === 'GET' && pathname === '/verify-toolchain') {
    // Probe-only (no install) gate for the done path: a reopened/already-complete
    // wizard jumps straight to "complete" without kicking an install task, so the
    // frontend calls this first and re-installs when a REQUIRED tool is absent.
    const probe = probeOnboardingToolchain(ctx.cwd);
    sendJson(res, 200, { ok: !probe.graphMissing, ...probe });
    return;
  }

  if (method === 'GET' && pathname.startsWith('/task/')) {
    const id = decodeURIComponent(pathname.slice('/task/'.length));
    const task = getTask(id);
    if (!task) {
      sendJson(res, 404, { error: 'unknown task' });
      return;
    }
    sendJson(res, 200, task);
    return;
  }

  if (method === 'POST' && pathname === '/complete') {
    try {
      writeCompletionSentinel(ctx.cwd, ctx.env);
    } catch {
      // best-effort — the gate's predicates remain the source of truth
    }
    sendJson(res, 200, { ok: true });
    ctx.requestShutdown();
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
