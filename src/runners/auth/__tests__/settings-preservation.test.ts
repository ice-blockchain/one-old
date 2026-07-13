import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { hostModelSnapshot } from '../../../shared/model-tiers';
import {
  readOneSettings,
  writeOneHostSettings,
  writeOneSection,
} from '../../../shared/one-settings';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';
import { login, logout } from '../commands';

function mcpResponse(value: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  });
}

test('real login, code-graph write, and logout preserve every host snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-auth-settings-preserve-'));
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let tool = '';
      try {
        const parsed = JSON.parse(body) as { params?: { name?: unknown } };
        tool = typeof parsed.params?.name === 'string' ? parsed.params.name : '';
      } catch {
        // Invalid requests receive the same harmless fixture response below.
      }
      const result = tool === 'authenticate'
        ? {
          authenticated: true,
          sessionToken: 'tok_settings_preservation.sig',
          expiresAt: '2099-01-01T00:00:00Z',
          keyId: 'settings-preservation-key',
        }
        : { ok: true };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(mcpResponse(result));
    });
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const env = {
      HOME: path.join(dir, 'home'),
      TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: `http://127.0.0.1:${address.port}/mcp`,
      TRAFFIC_ONE_AUTH_CREDENTIAL_STORE: 'file',
      TRAFFIC_ONE_AUTH_CREDENTIAL_STORE_PATH: path.join(dir, 'credentials.json'),
    } as NodeJS.ProcessEnv;

    const codex = hostModelSnapshot('codex', 'pro');
    const cursor = hostModelSnapshot('cursor', 'max');
    writeOneHostSettings('codex', codex, env);
    writeOneHostSettings('cursor', cursor, env);
    writeOneSection('authChoice', { version: 3, globalChoice: null, choices: {} }, env);
    assert.equal(writeGlobalCodeGraphProvider('graphify', env), 'graphify');

    const loggedIn = await login([], env, { apiKey: 'sk-settings-preservation' });
    assert.equal(loggedIn.ok, true);
    let settings = readOneSettings(env);
    assert.deepEqual(settings.hosts.codex, codex);
    assert.deepEqual(settings.hosts.cursor, cursor);
    assert.equal(settings.codeGraphProvider, 'graphify');
    assert.ok(settings.auth);

    // Logout owns removal of a choice that may have been written by a parallel
    // session after login completed.
    writeOneSection('authChoice', {
      version: 3,
      globalChoice: { status: 'authenticate' },
      choices: {},
    }, env);
    assert.equal(writeGlobalCodeGraphProvider('gitnexus', env), 'gitnexus');
    const loggedOut = await logout([], env);
    assert.equal(loggedOut.ok, true);
    settings = readOneSettings(env);
    assert.deepEqual(settings.hosts.codex, codex);
    assert.deepEqual(settings.hosts.cursor, cursor);
    assert.equal(settings.codeGraphProvider, 'gitnexus');
    assert.equal(settings.auth, null);
    assert.equal(settings.authChoice, null);
    assert.equal(fs.statSync(env.TRAFFIC_ONE_STATE_PATH as string).mode & 0o777, 0o600);
  } finally {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
