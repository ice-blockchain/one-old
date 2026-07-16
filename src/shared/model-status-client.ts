// Dependency-free HTTP client for the public model-status endpoint. Validation
// of the response contract lives with the model-tier catalog; this layer owns
// transport safety (HTTPS, loopback-only HTTP, timeout, and response bound).

import * as http from 'http';
import * as https from 'https';
import type { IncomingMessage } from 'http';

import {
  MODEL_STATUS_MAX_RESPONSE_BYTES,
  MODEL_STATUS_TIMEOUT_MS,
} from '../config/model-status';

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function modelStatusUrl(endpoint: string, host: string, plan: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('model-status endpoint must use HTTPS (loopback HTTP is allowed for local tests)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('model-status endpoint must use HTTPS');
  }
  url.searchParams.set('host', host);
  url.searchParams.set('plan', plan);
  return url;
}

export interface ModelStatusRequestOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  transport?: ModelStatusTransport;
}

export interface ModelStatusRequestHandle {
  on(event: 'timeout' | 'error', listener: (error?: Error) => void): this;
  destroy(error?: Error): void;
  end(): void;
}

export type ModelStatusTransport = (
  url: URL,
  timeoutMs: number,
  onResponse: (response: IncomingMessage) => void,
) => ModelStatusRequestHandle;

const nodeTransport: ModelStatusTransport = (url, timeoutMs, onResponse) => {
  const client = url.protocol === 'http:' ? http : https;
  return client.request({
    method: 'GET',
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    headers: { accept: 'application/json' },
    timeout: timeoutMs,
  }, onResponse);
};

export function requestModelStatus(
  endpoint: string,
  host: string,
  plan: string,
  options: ModelStatusRequestOptions = {},
): Promise<unknown> {
  const url = modelStatusUrl(endpoint, host, plan);
  const timeoutMs = options.timeoutMs ?? MODEL_STATUS_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? MODEL_STATUS_MAX_RESPONSE_BYTES;

  return new Promise((resolve, reject) => {
    const req = (options.transport || nodeTransport)(url, timeoutMs, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`model-status HTTP ${res.statusCode || 'unknown'}`));
        return;
      }

      const declared = Number.parseInt(String(res.headers['content-length'] || ''), 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        reject(new Error('model-status response exceeds 64 KiB'));
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          settled = true;
          res.destroy();
          reject(new Error('model-status response exceeds 64 KiB'));
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new Error('model-status response is not valid JSON'));
        }
      });
      res.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    req.on('timeout', () => req.destroy(new Error('model-status request timeout')));
    req.on('error', (error) => reject(error || new Error('model-status request failed')));
    req.end();
  });
}
