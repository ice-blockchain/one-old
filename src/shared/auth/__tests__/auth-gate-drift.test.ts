import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AUTH_GATE_DRIFT_FILE,
  authGateUnknown401LogLine,
  clearUnknownAuthGate401,
  readUnknownAuthGate401,
  recordUnknownAuthGate401,
} from '../auth-gate-drift';
import { machineSidecarPath } from '../machine-sidecar';

function machine(): { env: NodeJS.ProcessEnv; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-auth-gate-drift-'));
  return {
    env: { ...process.env, TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json') },
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('recordUnknownAuthGate401 writes the sidecar and a log line; clear removes it', () => {
  const m = machine();
  const T0 = Date.parse('2026-09-08T10:00:00Z');
  try {
    assert.equal(readUnknownAuthGate401(m.env), null);
    assert.equal(recordUnknownAuthGate401('some_future_code', m.env, T0), true);
    const stored = readUnknownAuthGate401(m.env);
    assert.deepEqual(stored, {
      code: 'some_future_code',
      seenAt: '2026-09-08T10:00:00Z',
      logLine: authGateUnknown401LogLine('some_future_code'),
    });
    assert.match(stored!.logLine, /AUTH_GATE_401_CODES/);
    assert.match(stored!.logLine, /grace/);
    assert.ok(fs.existsSync(machineSidecarPath(AUTH_GATE_DRIFT_FILE, m.env)));
    assert.equal(clearUnknownAuthGate401(m.env), true);
    assert.equal(readUnknownAuthGate401(m.env), null);
  } finally {
    m.dispose();
  }
});
