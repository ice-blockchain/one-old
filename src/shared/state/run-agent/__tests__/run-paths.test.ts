import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureCurrentRunId, safePathSegment } from '../run-paths';
import { readState, statePath, writeState } from '../../normalize';

function withProject<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-paths-'));
  const saved = {
    prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: process.env.TRAFFIC_ONE_STATE_PATH,
    host: process.env.TRAFFIC_ONE_HOST,
  };
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_HOST = 'codex';
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of [
      ['TRAFFIC_ONE_PROJECT_PREFS_PATH', saved.prefs],
      ['TRAFFIC_ONE_STATE_PATH', saved.state],
      ['TRAFFIC_ONE_HOST', saved.host],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureCurrentRunId sanitizes a path-unsafe currentRunId and keeps legacy shapes', () => {
  withProject((dir) => {
    writeState(dir, { stack: 'default', mode: 'new-project', currentRunId: '1715091785000' });
    const planted = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Record<string, unknown>;
    planted.currentRunId = 'foo/../bar';
    fs.writeFileSync(statePath(dir), JSON.stringify(planted));
    const state = { ...planted };
    const runId = ensureCurrentRunId(dir, state);
    assert.equal(runId, 'foo_.._bar');
    assert.equal(state.currentRunId, 'foo_.._bar');
    assert.equal(
      JSON.parse(fs.readFileSync(statePath(dir), 'utf8')).currentRunId,
      'foo_.._bar',
    );

    const legacy = { stack: 'default', mode: 'new-project', currentRunId: 'legacy-current' };
    assert.equal(ensureCurrentRunId(dir, legacy), 'legacy-current');
    assert.equal(safePathSegment('2026-06-17T12-09-40Z'), '2026-06-17T12-09-40Z');
  });
});
