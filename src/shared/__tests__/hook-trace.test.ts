import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { maybeTraceHook } from '../hook-trace';
import type { HookInput } from '../../core/types';

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-trace-'));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  return dir;
}

function preToolInput(cwd: string): HookInput {
  return {
    event: 'PreToolUse', host: 'codex', cwd,
    raw: { session_id: 's-child', tool_name: 'apply_patch' },
    tool: { class: 'file-write', rawName: 'apply_patch' },
  };
}

const traceFile = (cwd: string): string => path.join(cwd, '.traffic-one', 'debug', 'hook-trace.jsonl');

test('maybeTraceHook is a no-op when neither env nor marker is set', () => {
  const cwd = tmpProject();
  try {
    maybeTraceHook(preToolInput(cwd), '{"session_id":"s-child"}', {} as NodeJS.ProcessEnv);
    assert.equal(fs.existsSync(traceFile(cwd)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the .traffic-one/debug/trace.on marker enables a trace line (no env needed)', () => {
  const cwd = tmpProject();
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'debug'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'debug', 'trace.on'), '', 'utf8');
    maybeTraceHook(preToolInput(cwd), '{"session_id":"s-child"}', {} as NodeJS.ProcessEnv);
    const rec = JSON.parse(fs.readFileSync(traceFile(cwd), 'utf8').trim());
    assert.equal(rec.event, 'PreToolUse');
    assert.equal(rec.tool.rawName, 'apply_patch');
    assert.equal(rec.identity.sessionId, 's-child');
    assert.ok(Object.prototype.hasOwnProperty.call(rec, 'env'), 'captures a filtered env slice');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('TRAFFIC_ONE_HOOK_TRACE env also enables the trace and never captures secret-named env', () => {
  const cwd = tmpProject();
  try {
    maybeTraceHook(preToolInput(cwd), '{}', {
      TRAFFIC_ONE_HOOK_TRACE: '1', CODEX_THREAD_ID: 'abc', CODEX_API_KEY: 'shh',
    } as unknown as NodeJS.ProcessEnv);
    const rec = JSON.parse(fs.readFileSync(traceFile(cwd), 'utf8').trim());
    assert.equal(rec.env.CODEX_THREAD_ID, 'abc');
    assert.equal(rec.env.CODEX_API_KEY, undefined); // KEY → denied by the secret filter
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
