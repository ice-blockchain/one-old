import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { refreshModelStatusForSession } from '../model-status-refresh';

test('SessionStart model refresh invokes only the active host runner with a bounded wait', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-model-status-session-'));
  const runner = path.join(dir, 'model-status.cjs');
  fs.writeFileSync(runner, '// fixture', 'utf8');
  const observed: Array<{ command: string; args: readonly string[]; timeout: number | undefined }> = [];
  const spawn = ((command: string, args: readonly string[], options: { timeout?: number }) => {
    observed.push({ command, args, timeout: options.timeout });
    return { status: 0, stdout: '{}', stderr: '' };
  }) as never;
  try {
    refreshModelStatusForSession(dir, 'cursor', {}, spawn, runner);
    assert.equal(observed[0]?.command, process.execPath);
    assert.deepEqual(observed[0]?.args, [runner, 'cursor']);
    assert.ok((observed[0]?.timeout ?? 0) > 2_000 && (observed[0]?.timeout ?? 0) < 3_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart model refresh can be disabled for hermetic/offline hosts', () => {
  let called = false;
  const spawn = (() => {
    called = true;
    return { status: 0, stdout: '', stderr: '' };
  }) as never;
  const result = refreshModelStatusForSession(
    process.cwd(),
    'codex',
    { TRAFFIC_ONE_MODEL_STATUS_OFF: '1' },
    spawn,
    '/does/not/matter.cjs',
  );
  assert.equal(result, null);
  assert.equal(called, false);
});
