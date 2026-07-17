import * as http from 'http';
import * as https from 'https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'http';

import {
  ONE_MCP_MAX_RESPONSE_BYTES,
  ONE_MCP_TIMEOUT_MS,
} from '../../config/one-mcp';

type JsonRpcId = string | number;
type Rec = Record<string, unknown>;

export interface OneMcpJsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export type OneMcpRequestFactory = (
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface OneMcpTransportOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly requestFactory?: OneMcpRequestFactory;
}

export type OneMcpTransportErrorCode =
  | 'invalid-endpoint'
  | 'invalid-request'
  | 'request-too-large'
  | 'timeout'
  | 'network-error'
  | 'http-status'
  | 'unsupported-content-type'
  | 'unsupported-content-encoding'
  | 'response-too-large'
  | 'invalid-response';

export class OneMcpTransportError extends Error {
  readonly code: OneMcpTransportErrorCode;
  readonly statusCode?: number;

  constructor(code: OneMcpTransportErrorCode, message: string, options: { cause?: unknown; statusCode?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OneMcpTransportError';
    this.code = code;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
  }
}

function transportError(
  code: OneMcpTransportErrorCode,
  message: string,
  options: { cause?: unknown; statusCode?: number } = {},
): OneMcpTransportError {
  return new OneMcpTransportError(code, message, options);
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function oneMcpEndpointUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw transportError('invalid-endpoint', 'one-mcp endpoint is not a valid URL', { cause: error });
  }
  if (url.username || url.password) {
    throw transportError('invalid-endpoint', 'one-mcp endpoint must not contain URL credentials');
  }
  if (url.hash) {
    throw transportError('invalid-endpoint', 'one-mcp endpoint must not contain a URL fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw transportError(
      'invalid-endpoint',
      'one-mcp endpoint must use HTTPS (loopback HTTP is allowed for local tests)',
    );
  }
  return url;
}

function validRequestId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128)
    || (typeof value === 'number' && Number.isSafeInteger(value));
}

function responseForId(value: unknown, expectedId: JsonRpcId): Rec | null {
  const messages = Array.isArray(value) ? value : [value];
  if (messages.length === 0 || messages.some((message) => !isRecord(message))) {
    throw transportError('invalid-response', 'one-mcp response is not a JSON-RPC object');
  }
  const matches = (messages as Rec[]).filter((message) => message.id === expectedId);
  if (matches.length > 1) {
    throw transportError('invalid-response', 'one-mcp response contains duplicate JSON-RPC ids');
  }
  return matches[0] ?? null;
}

function decodeJson(buffer: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw transportError('invalid-response', 'one-mcp response is not valid UTF-8', { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw transportError('invalid-response', 'one-mcp response is not valid JSON', { cause: error });
  }
}

class SseJsonRpcDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly expectedId: JsonRpcId;
  private line = '';
  private pendingCr = false;
  private atStart = true;
  private dataLines: string[] = [];
  private match: Rec | null = null;

  constructor(expectedId: JsonRpcId) {
    this.expectedId = expectedId;
  }

  push(buffer: Buffer): Rec | null {
    let text: string;
    try {
      text = this.decoder.decode(buffer, { stream: true });
    } catch (error) {
      throw transportError('invalid-response', 'one-mcp SSE response is not valid UTF-8', { cause: error });
    }
    this.consume(text);
    return this.match;
  }

  finish(): Rec | null {
    let tail: string;
    try {
      tail = this.decoder.decode();
    } catch (error) {
      throw transportError('invalid-response', 'one-mcp SSE response is not valid UTF-8', { cause: error });
    }
    this.consume(tail);
    if (this.match) return this.match;
    if (this.pendingCr) {
      this.pendingCr = false;
      this.processLine();
    } else if (this.line.length > 0) {
      this.processLine();
    }
    if (!this.match && this.dataLines.length > 0) this.dispatchEvent();
    return this.match;
  }

  private consume(text: string): void {
    if (!text || this.match) return;
    if (this.atStart) {
      this.atStart = false;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    }
    for (const char of text) {
      if (this.pendingCr) {
        this.pendingCr = false;
        this.processLine();
        if (this.match) return;
        if (char === '\n') continue;
      }
      if (char === '\r') {
        this.pendingCr = true;
      } else if (char === '\n') {
        this.processLine();
        if (this.match) return;
      } else {
        this.line += char;
      }
    }
  }

  private processLine(): void {
    const line = this.line;
    this.line = '';
    if (line === '') {
      this.dispatchEvent();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
  }

  private dispatchEvent(): void {
    if (this.dataLines.length === 0) return;
    const raw = this.dataLines.join('\n');
    this.dataLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw transportError('invalid-response', 'one-mcp SSE event is not valid JSON', { cause: error });
    }
    this.match = responseForId(parsed, this.expectedId);
  }
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : String(value || '');
}

function contentKind(response: IncomingMessage): 'json' | 'sse' {
  const contentType = headerValue(response.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === 'application/json') return 'json';
  if (contentType === 'text/event-stream') return 'sse';
  throw transportError('unsupported-content-type', 'one-mcp response has an unsupported Content-Type');
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw transportError('invalid-request', `${label} must be a positive integer`);
  }
  return resolved;
}

export function postOneMcpJsonRpc(
  endpoint: string,
  request: OneMcpJsonRpcRequest,
  options: OneMcpTransportOptions = {},
): Promise<Rec> {
  const url = oneMcpEndpointUrl(endpoint);
  if (request.jsonrpc !== '2.0' || !validRequestId(request.id) || typeof request.method !== 'string' || !request.method) {
    throw transportError('invalid-request', 'one-mcp request is not a valid JSON-RPC request');
  }
  const timeoutMs = positiveBound(options.timeoutMs, ONE_MCP_TIMEOUT_MS, 'one-mcp timeout');
  const maxBytes = positiveBound(options.maxResponseBytes, ONE_MCP_MAX_RESPONSE_BYTES, 'one-mcp response cap');
  if (maxBytes > ONE_MCP_MAX_RESPONSE_BYTES) {
    throw transportError('invalid-request', 'one-mcp response cap cannot exceed the 64 KiB protocol limit');
  }
  let body: string;
  try {
    body = JSON.stringify(request);
  } catch (error) {
    throw transportError('invalid-request', 'one-mcp request is not JSON-serializable', { cause: error });
  }
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > ONE_MCP_MAX_RESPONSE_BYTES) {
    throw transportError('request-too-large', 'one-mcp request exceeds the configured body cap');
  }

  return new Promise<Rec>((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | null = null;
    const finish = (result: { value: Rec } | { error: OneMcpTransportError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('value' in result) resolve(result.value);
      else reject(result.error);
    };
    const timer = setTimeout(() => {
      const error = transportError('timeout', `one-mcp request timed out after ${timeoutMs}ms`);
      finish({ error });
      req?.destroy();
    }, timeoutMs);
    timer.unref?.();

    const requestOptions: RequestOptions = {
      method: 'POST',
      protocol: url.protocol,
      // URL.hostname retains brackets for IPv6 literals, while the low-level
      // request options expect the raw address.
      hostname: url.hostname.startsWith('[') && url.hostname.endsWith(']')
        ? url.hostname.slice(1, -1)
        : url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': bodyBytes,
      },
    };
    const requestFactory = options.requestFactory
      || ((rawOptions: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
        const client = url.protocol === 'http:' ? http : https;
        return client.request(rawOptions, onResponse);
      });

    try {
      req = requestFactory(requestOptions, (response) => {
        const statusCode = response.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          finish({
            error: transportError('http-status', `one-mcp HTTP ${statusCode || 'unknown'}`, { statusCode }),
          });
          // Do not drain an untrusted error body without the protocol byte cap.
          response.destroy();
          return;
        }

        const encoding = headerValue(response.headers['content-encoding']).trim().toLowerCase();
        if (encoding && encoding !== 'identity') {
          finish({
            error: transportError('unsupported-content-encoding', 'one-mcp response must not be content-encoded'),
          });
          response.destroy();
          return;
        }

        let kind: 'json' | 'sse';
        try {
          kind = contentKind(response);
        } catch (error) {
          finish({ error: error as OneMcpTransportError });
          response.destroy();
          return;
        }

        // Content-Length is mandatory on our outgoing POST because the public
        // mount requires it. It is OPTIONAL on responses: Streamable HTTP may
        // return chunked SSE (or chunked JSON). Use a declared JSON length only
        // as an early rejection; the streamed byte counter below is authoritative.
        if (kind === 'json') {
          const declaredText = headerValue(response.headers['content-length']).trim();
          if (/^\d+$/.test(declaredText) && Number(declaredText) > maxBytes) {
            finish({ error: transportError('response-too-large', 'one-mcp response exceeds the configured byte cap') });
            response.destroy();
            return;
          }
        }

        const chunks: Buffer[] = [];
        const sse = kind === 'sse' ? new SseJsonRpcDecoder(request.id) : null;
        let received = 0;

        response.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.length;
          if (received > maxBytes) {
            finish({ error: transportError('response-too-large', 'one-mcp response exceeds the configured byte cap') });
            response.destroy();
            return;
          }
          try {
            if (sse) {
              const match = sse.push(buffer);
              if (match) {
                finish({ value: match });
                response.destroy();
              }
            } else {
              chunks.push(buffer);
            }
          } catch (error) {
            finish({
              error: error instanceof OneMcpTransportError
                ? error
                : transportError('invalid-response', 'one-mcp response parsing failed', { cause: error }),
            });
            response.destroy();
          }
        });
        response.once('end', () => {
          if (settled) return;
          try {
            const match = sse
              ? sse.finish()
              : responseForId(decodeJson(Buffer.concat(chunks)), request.id);
            if (!match) {
              finish({ error: transportError('invalid-response', 'one-mcp response has no matching JSON-RPC id') });
              return;
            }
            finish({ value: match });
          } catch (error) {
            finish({
              error: error instanceof OneMcpTransportError
                ? error
                : transportError('invalid-response', 'one-mcp response parsing failed', { cause: error }),
            });
          }
        });
        response.once('aborted', () => {
          finish({ error: transportError('network-error', 'one-mcp response was aborted') });
        });
        response.once('error', (error) => {
          finish({ error: transportError('network-error', 'one-mcp response failed', { cause: error }) });
        });
      });
    } catch (error) {
      finish({ error: transportError('network-error', 'one-mcp request could not start', { cause: error }) });
      return;
    }

    req.once('error', (error) => {
      finish({ error: transportError('network-error', 'one-mcp request failed', { cause: error }) });
    });
    req.end(body);
  });
}
