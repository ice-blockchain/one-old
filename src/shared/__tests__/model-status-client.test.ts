import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  modelStatusUrl,
  requestModelStatus,
  type ModelStatusTransport,
} from '../model-status-client';

function fakeTransport(
  body: string,
  options: { statusCode?: number; timeout?: boolean; contentLength?: number } = {},
): ModelStatusTransport {
  return (url, _timeoutMs, onResponse) => {
    assert.equal(url.pathname, '/model-status');
    assert.equal(url.search, '?host=cursor&plan=pro');
    const req = new EventEmitter() as EventEmitter & {
      end(): void;
      destroy(error?: Error): void;
    };
    req.destroy = (error?: Error) => queueMicrotask(() => req.emit('error', error));
    req.end = () => {
      if (options.timeout) {
        queueMicrotask(() => req.emit('timeout'));
        return;
      }
      const response = Readable.from([Buffer.from(body)]) as IncomingMessage;
      Object.assign(response, {
        statusCode: options.statusCode ?? 200,
        headers: {
          'content-type': 'application/json',
          ...(options.contentLength === undefined ? {} : { 'content-length': String(options.contentLength) }),
        },
      });
      onResponse(response);
    };
    return req;
  };
}

test('modelStatusUrl accepts HTTPS and loopback HTTP, and encodes host/plan', () => {
  assert.equal(
    modelStatusUrl('https://models.example.com/model-status', 'cursor', 'pro').toString(),
    'https://models.example.com/model-status?host=cursor&plan=pro',
  );
  assert.throws(
    () => modelStatusUrl('http://models.example.com/model-status', 'cursor', 'pro'),
    /HTTPS/,
  );
});

test('requestModelStatus performs a public GET and parses a bounded JSON response', async () => {
  assert.deepEqual(await requestModelStatus(
    'http://127.0.0.1:8787/model-status',
    'cursor',
    'pro',
    { transport: fakeTransport(JSON.stringify({ ok: true })) },
  ), { ok: true });
});

test('requestModelStatus rejects responses larger than 64 KiB', async () => {
  await assert.rejects(
    requestModelStatus(
      'http://127.0.0.1:8787/model-status',
      'cursor',
      'pro',
      { transport: fakeTransport(JSON.stringify({ payload: 'x'.repeat(70 * 1024) })) },
    ),
    /64 KiB/,
  );
});

test('requestModelStatus enforces its deadline', async () => {
  await assert.rejects(
    requestModelStatus(
      'http://127.0.0.1:8787/model-status',
      'cursor',
      'pro',
      { timeoutMs: 20, transport: fakeTransport('{}', { timeout: true }) },
    ),
    /timeout/,
  );
});
