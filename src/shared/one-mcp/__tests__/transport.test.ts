import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';

import {
  OneMcpTransportError,
  oneMcpEndpointUrl,
  postOneMcpJsonRpc,
  type OneMcpJsonRpcRequest,
} from '../transport';

async function withServer(
  handler: http.RequestListener,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}/public-mcp`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

function request(id: string | number = 1): OneMcpJsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'get_config', arguments: { config_name: 'test', version: 0, note: '😀' } },
  };
}

function errorCode(error: unknown): string | null {
  return error instanceof OneMcpTransportError ? error.code : null;
}

test('endpoint validation permits HTTPS and loopback HTTP only', () => {
  assert.equal(oneMcpEndpointUrl('https://example.com/mcp').protocol, 'https:');
  assert.equal(oneMcpEndpointUrl('http://127.0.0.1:3000/mcp').protocol, 'http:');
  assert.equal(oneMcpEndpointUrl('http://localhost:3000/mcp').hostname, 'localhost');
  assert.throws(() => oneMcpEndpointUrl('http://example.com/mcp'), { code: 'invalid-endpoint' });
  assert.throws(() => oneMcpEndpointUrl('file:///tmp/mcp'), { code: 'invalid-endpoint' });
  assert.throws(() => oneMcpEndpointUrl('https://user:pass@example.com/mcp'), { code: 'invalid-endpoint' });
  assert.throws(() => oneMcpEndpointUrl('https://example.com/mcp#fragment'), { code: 'invalid-endpoint' });
});

test('transport rejects a non-serializable request as invalid input', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => postOneMcpJsonRpc('https://example.com/mcp', { ...request(), params: cyclic }),
    (error) => errorCode(error) === 'invalid-request',
  );
});

test('transport response cap may be lowered but never raised above 64 KiB', () => {
  assert.throws(
    () => postOneMcpJsonRpc('https://example.com/mcp', request(), { maxResponseBytes: 64 * 1024 + 1 }),
    (error) => errorCode(error) === 'invalid-request',
  );
});

test('JSON transport sends an anonymous length-delimited POST and accepts a chunked response', async () => {
  let observedBody = '';
  let observedHeaders: http.IncomingHttpHeaders = {};
  await withServer((req, res) => {
    observedHeaders = req.headers;
    req.setEncoding('utf8');
    req.on('data', (chunk) => { observedBody += chunk; });
    req.on('end', () => {
      const response = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.write(response.slice(0, 11));
      res.end(response.slice(11));
    });
  }, async (url) => {
    const result = await postOneMcpJsonRpc(url, request(7));
    assert.deepEqual(result, { jsonrpc: '2.0', id: 7, result: { ok: true } });
  });

  assert.equal(observedHeaders.accept, 'application/json, text/event-stream');
  assert.equal(observedHeaders['content-type'], 'application/json');
  assert.equal(observedHeaders['content-length'], String(Buffer.byteLength(observedBody)));
  assert.equal(observedHeaders.authorization, undefined);
  assert.equal(observedHeaders.cookie, undefined);
  assert.equal(observedHeaders['x-api-key'], undefined);
  assert.deepEqual(JSON.parse(observedBody), request(7));
});

test('SSE transport incrementally handles comments, CRLF, unrelated messages, and split UTF-8', async () => {
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const unrelated = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
      const matching = JSON.stringify({ jsonrpc: '2.0', id: 'cfg-1', result: { note: '😀', ok: true } });
      const wire = Buffer.from(`: keepalive\r\n\r\ndata: ${unrelated}\r\n\r\ndata: ${matching}\r\n\r\n`, 'utf8');
      const emoji = wire.indexOf(Buffer.from('😀'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(wire.subarray(0, emoji + 1));
      res.write(wire.subarray(emoji + 1, emoji + 3));
      res.end(wire.subarray(emoji + 3));
    });
  }, async (url) => {
    const result = await postOneMcpJsonRpc(url, request('cfg-1'));
    assert.deepEqual(result, { jsonrpc: '2.0', id: 'cfg-1', result: { note: '😀', ok: true } });
  });
});

test('JSON-RPC batches select exactly one matching response id', async () => {
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { jsonrpc: '2.0', id: 2, result: { wrong: true } },
        { jsonrpc: '2.0', id: 1, result: { right: true } },
      ]));
    });
  }, async (url) => {
    assert.deepEqual(await postOneMcpJsonRpc(url, request(1)), {
      jsonrpc: '2.0', id: 1, result: { right: true },
    });
  });
});

test('response byte cap rejects declared and streamed overflows for JSON and SSE', async (t) => {
  await t.test('declared JSON length', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1024' });
        res.end('{}');
      });
    }, async (url) => {
      await assert.rejects(
        postOneMcpJsonRpc(url, request(), { maxResponseBytes: 32 }),
        (error) => errorCode(error) === 'response-too-large',
      );
    });
  });

  await t.test('chunked JSON length', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"padding":"');
        res.end(`${'x'.repeat(128)}"}`);
      });
    }, async (url) => {
      await assert.rejects(
        postOneMcpJsonRpc(url, request(), { maxResponseBytes: 32 }),
        (error) => errorCode(error) === 'response-too-large',
      );
    });
  });

  await t.test('chunked SSE length', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`: ${'x'.repeat(128)}\n\n`);
      });
    }, async (url) => {
      await assert.rejects(
        postOneMcpJsonRpc(url, request(), { maxResponseBytes: 32 }),
        (error) => errorCode(error) === 'response-too-large',
      );
    });
  });
});

test('transport rejects unsupported response media and encoding', async (t) => {
  await t.test('content type', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('{}');
      });
    }, async (url) => {
      await assert.rejects(postOneMcpJsonRpc(url, request()), (error) => errorCode(error) === 'unsupported-content-type');
    });
  });

  await t.test('content encoding', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end('{}');
      });
    }, async (url) => {
      await assert.rejects(postOneMcpJsonRpc(url, request()), (error) => errorCode(error) === 'unsupported-content-encoding');
    });
  });
});

test('transport classifies HTTP, malformed-body, missing-id, and timeout failures', async (t) => {
  await t.test('HTTP status', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{}');
      });
    }, async (url) => {
      await assert.rejects(postOneMcpJsonRpc(url, request()), (error) => {
        return error instanceof OneMcpTransportError && error.code === 'http-status' && error.statusCode === 503;
      });
    });
  });

  await t.test('malformed JSON', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{');
      });
    }, async (url) => {
      await assert.rejects(postOneMcpJsonRpc(url, request()), (error) => errorCode(error) === 'invalid-response');
    });
  });

  await t.test('missing matching id', async () => {
    await withServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }));
      });
    }, async (url) => {
      await assert.rejects(postOneMcpJsonRpc(url, request()), (error) => errorCode(error) === 'invalid-response');
    });
  });

  await t.test('overall timeout', async () => {
    await withServer((req, _res) => {
      req.resume();
    }, async (url) => {
      await assert.rejects(
        postOneMcpJsonRpc(url, request(), { timeoutMs: 25 }),
        (error) => errorCode(error) === 'timeout',
      );
    });
  });
});
