// src/runners/qa-evidence/server.ts
// The owned listener: hash-verified static server, the command-server
// proxy, port allocation, and paired start/stop.

import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { createServer, type Server } from 'http';
import * as path from 'path';
import {
  combineNativeSummaries,
  computeBuildOutputManifest,
  contentHash,
  createQaLighthouseEvidence,
  createQaMachineEvidence,
  createQaNativeEvidence,
  parseAndroidJUnitXml,
  parseXcodeResultSummary,
  readLighthouseArtifact,
  type BuildOutputManifestV1,
  type QaMachineRouteEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  QA_BUILD_IDENTITY_PROBE_PATH,
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import { sha256 } from '../../shared/text';

import {
  MAX_PROXY_BODY_BYTES,
  type OwnedServer,
  type Rec,
  type RunnerArgs,
} from './types';
import {
  loadRun,
  safeProjectRelative,
} from './run-context';

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function listen(server: Server): Promise<{ port: number; startedAt: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectPromise(new Error('listener did not expose a TCP port'));
        return;
      }
      resolvePromise({ port: address.port, startedAt: new Date().toISOString() });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function identityBody(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
  port: number,
  startedAt: string,
): Rec {
  return {
    schemaVersion: 1,
    runId: args.runId,
    sourceHash: loaded.sourceHash,
    buildHash: loaded.manifest.manifestHash,
    pid: process.pid,
    port,
    startedAt,
    url: `http://127.0.0.1:${port}`,
    fingerprint: loaded.fingerprint,
  };
}

export async function startStaticServer(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
): Promise<OwnedServer> {
  const outputRoot = path.resolve(args.projectRoot, loaded.manifest.outputRoot);
  const knownFiles = new Map(loaded.manifest.files.map((file) => [file.path, file.sha256]));
  const servedAssetHashes = new Set<string>();
  let identity: Rec | null = null;
  const server = createServer((request, response) => {
    const requested = request.url || '/';
    if (requested.split('?')[0] === QA_BUILD_IDENTITY_PROBE_PATH) {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(identity));
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(requested, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }
    const rawRel = pathname.replace(/^\/+/, '') || 'index.html';
    const candidates = [rawRel, `${rawRel}.html`, path.posix.join(rawRel, 'index.html'), 'index.html'];
    const rel = candidates.find((candidate) => knownFiles.has(candidate));
    if (!rel) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    const absolute = path.resolve(outputRoot, rel);
    const boundary = path.relative(outputRoot, absolute);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const expectedHash = knownFiles.get(rel)!;
    if (contentHash(absolute) !== expectedHash) {
      response.writeHead(409);
      response.end('Build output changed after manifest capture');
      return;
    }
    servedAssetHashes.add(expectedHash);
    response.writeHead(200, { 'content-type': contentType(absolute), 'cache-control': 'no-store' });
    fs.createReadStream(absolute).pipe(response);
  });
  const listening = await listen(server);
  identity = identityBody(args, loaded, listening.port, listening.startedAt);
  return {
    server,
    mode: 'runtime-static',
    url: String(identity.url),
    port: listening.port,
    startedAt: listening.startedAt,
    servedAssetHashes,
  };
}

function freePort(): Promise<number> {
  const server = createServer();
  return listen(server).then(async ({ port }) => {
    await closeServer(server);
    return port;
  });
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // keep waiting for the child listener
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`server command did not listen within ${timeoutMs}ms`);
}

export function parseBoundedArgv(raw: string | undefined): string[] | null {
  if (!raw || raw.length > 16_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 64
    || !value.every((entry) => typeof entry === 'string'
      && entry.length > 0
      && entry.length <= 4_096
      && !/[\u0000-\u001f\u007f]/.test(entry))) return null;
  return value as string[];
}

function parseServerCommand(raw: string | undefined, port: number): string[] | null {
  const value = parseBoundedArgv(raw);
  return value?.map((entry) => entry.replace(/\{PORT\}/g, String(port))) || null;
}

function readRequestBody(request: import('http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROXY_BODY_BYTES) {
        rejectPromise(new Error('proxy request body exceeded the QA bound'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', rejectPromise);
  });
}

export async function startCommandServer(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
): Promise<OwnedServer> {
  const targetPort = await freePort();
  const command = parseServerCommand(args.serverCommandJson, targetPort);
  if (!command) throw new Error('--server-command-json must be a bounded JSON argv array');
  const cwdRel = args.serverCwd ? safeProjectRelative(args.projectRoot, args.serverCwd) : null;
  if (args.serverCwd && !cwdRel) throw new Error('--server-cwd must stay inside the project');
  const child = spawn(command[0]!, command.slice(1), {
    cwd: cwdRel ? path.join(args.projectRoot, cwdRel) : args.projectRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(targetPort) },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  try {
    await waitForHttp(`http://127.0.0.1:${targetPort}/`, args.timeoutMs);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw error;
  }

  const manifestHashes = new Set(loaded.manifest.files.map((file) => file.sha256));
  const servedAssetHashes = new Set<string>();
  let identity: Rec | null = null;
  let proxyOrigin = '';
  const server = createServer(async (request, response) => {
    if ((request.url || '').split('?')[0] === QA_BUILD_IDENTITY_PROBE_PATH) {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(identity));
      return;
    }
    try {
      const target = new URL(request.url || '/', `http://127.0.0.1:${targetPort}`);
      const body = ['GET', 'HEAD'].includes(request.method || 'GET')
        ? undefined
        : await readRequestBody(request);
      const requestHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') requestHeaders[key] = value;
        else if (Array.isArray(value)) requestHeaders[key] = value.join(', ');
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers: requestHeaders,
        ...(body ? { body } : {}),
        redirect: 'manual',
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_PROXY_BODY_BYTES) throw new Error('proxy response exceeded the QA bound');
      const observedHash = createHash('sha256').update(bytes).digest('hex');
      if (manifestHashes.has(observedHash)) servedAssetHashes.add(observedHash);
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (!['content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) {
          headers[key] = value;
        }
      });
      const location = headers.location;
      if (location) {
        const resolved = new URL(location, target);
        if (resolved.origin === target.origin) {
          headers.location = `${proxyOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
        }
      }
      response.writeHead(upstream.status, headers);
      response.end(bytes);
    } catch (error) {
      response.writeHead(502);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  let listening: { port: number; startedAt: string };
  try {
    listening = await listen(server);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw error;
  }
  proxyOrigin = `http://127.0.0.1:${listening.port}`;
  identity = identityBody(args, loaded, listening.port, listening.startedAt);
  return {
    server,
    child,
    mode: 'runtime-command',
    url: proxyOrigin,
    port: listening.port,
    startedAt: listening.startedAt,
    servedAssetHashes,
  };
}

export async function stopOwnedServer(owned: OwnedServer): Promise<void> {
  await closeServer(owned.server);
  if (owned.child && owned.child.exitCode === null && owned.child.signalCode === null) {
    owned.child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolvePromise) => owned.child!.once('exit', () => resolvePromise())),
      new Promise<void>((resolvePromise) => setTimeout(() => {
        owned.child!.kill('SIGKILL');
        resolvePromise();
      }, 1_000)),
    ]);
  }
}
