import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { hookTraceMarkerPath, maybeTraceHook } from '../hook/trace';
import type { HookInput } from '../../core/types';

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-trace-'));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  return dir;
}

// An isolated per-user Traffic One home, so arming the marker in a test cannot
// touch the developer's real ~/.traffic-one (and cannot be armed BY it either).
function tmpHome(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-trace-home-'));
  return { env: { HOME: dir } as NodeJS.ProcessEnv, dir };
}

function armMarker(env: NodeJS.ProcessEnv): string {
  const marker = hookTraceMarkerPath(env);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, '', 'utf8');
  return marker;
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
  const home = tmpHome();
  try {
    maybeTraceHook(preToolInput(cwd), '{"session_id":"s-child"}', home.env);
    assert.equal(fs.existsSync(traceFile(cwd)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

test('the per-user hook-trace marker enables a trace line (no env needed)', () => {
  const cwd = tmpProject();
  const home = tmpHome();
  try {
    const marker = armMarker(home.env);
    assert.ok(!marker.startsWith(cwd), 'the marker must live outside the project');
    maybeTraceHook(preToolInput(cwd), '{"session_id":"s-child"}', home.env);
    const rec = JSON.parse(fs.readFileSync(traceFile(cwd), 'utf8').trim());
    assert.equal(rec.event, 'PreToolUse');
    assert.equal(rec.tool.rawName, 'apply_patch');
    assert.equal(rec.identity.sessionId, 's-child');
    assert.ok(Object.prototype.hasOwnProperty.call(rec, 'env'), 'captures a filtered env slice');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

// This case previously asserted the OPPOSITE — that an IN-PROJECT
// `.traffic-one/debug/trace.on` arms the tracer — which ratified the defect. That
// path sits in an agent's ordinary write surface (measured against the real gate
// registry: `check-plan-write` allows both a Write and a `touch` of it while
// denying an ordinary source write), so any agent could silently arm a recorder of
// every tool call in the user's project. The switch now lives outside the project.
test('an in-project .traffic-one/debug/trace.on marker does NOT arm the tracer', () => {
  const cwd = tmpProject();
  const home = tmpHome();
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'debug'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'debug', 'trace.on'), '', 'utf8');
    maybeTraceHook(preToolInput(cwd), '{"session_id":"s-child"}', home.env);
    assert.equal(fs.existsSync(traceFile(cwd)), false, 'an agent-writable in-project file must not arm the tracer');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

test('TRAFFIC_ONE_HOOK_TRACE env also enables the trace and never captures secret-named env', () => {
  const cwd = tmpProject();
  const home = tmpHome();
  try {
    maybeTraceHook(preToolInput(cwd), '{}', {
      ...home.env, TRAFFIC_ONE_HOOK_TRACE: '1', CODEX_THREAD_ID: 'abc', CODEX_API_KEY: 'shh',
    } as unknown as NodeJS.ProcessEnv);
    const rec = JSON.parse(fs.readFileSync(traceFile(cwd), 'utf8').trim());
    assert.equal(rec.env.CODEX_THREAD_ID, 'abc');
    assert.equal(rec.env.CODEX_API_KEY, undefined); // KEY → denied by the secret filter
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

// The defect this guards, reproduced before the fix through the real dispatch
// path: up to 8KB of the RAW host payload was appended verbatim, so a `Write` of a
// `.env` put `sk_live_…` and a database password into a plain file in the user's
// project, and a `Bash` call put its inline bearer token there. Payload VALUES are
// now structurally uncapturable — the record holds a key/type shape instead.
test('the trace records the payload SHAPE and never a payload value', () => {
  const cwd = tmpProject();
  const home = tmpHome();
  try {
    armMarker(home.env);
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's-child',
      tool_name: 'Write',
      tool_input: { file_path: '/p/.env', content: 'STRIPE_SECRET_KEY=sk_live_DEADBEEF\nPGPASSWORD=hunter2\n' },
    });
    maybeTraceHook(preToolInput(cwd), stdin, home.env);
    const raw = fs.readFileSync(traceFile(cwd), 'utf8');
    // Asserted against the WHOLE line, not one field: the requirement is that the
    // secret is nowhere on disk, not that one particular key stopped carrying it.
    assert.ok(!raw.includes('sk_live_DEADBEEF'), 'a written secret must never reach the trace file');
    assert.ok(!raw.includes('hunter2'), 'a written password must never reach the trace file');
    assert.ok(!raw.includes('STRIPE_SECRET_KEY'), 'not even the secret NAME is payload we may keep');

    const rec = JSON.parse(raw.trim());
    assert.equal(Object.prototype.hasOwnProperty.call(rec, 'stdin'), false, 'the raw stdin field is gone');
    assert.equal(rec.stdinShape.bytes, Buffer.byteLength(stdin, 'utf8'));
    assert.equal(rec.stdinShape.parsed, true);
    // The diagnostic's actual question — WHICH keys did this host deliver — is
    // still answered, one level into the envelope.
    assert.deepEqual(rec.stdinShape.keys.tool_input, {
      file_path: 'string(7)',
      content: `string(${'STRIPE_SECRET_KEY=sk_live_DEADBEEF\nPGPASSWORD=hunter2\n'.length})`,
    });
    assert.equal(rec.stdinShape.keys.hook_event_name, 'string(10)');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

// A Bash command line is the other verbatim-capture channel, and it has no
// containing object to hide behind — the value sits one level down under
// `tool_input.command`.
test('a Bash command line is reduced to its shape, inline credentials included', () => {
  const cwd = tmpProject();
  const home = tmpHome();
  try {
    armMarker(home.env);
    const command = 'curl -H "Authorization: Bearer ghp_DEADBEEFCAFE" https://api.example.test/deploy';
    maybeTraceHook(preToolInput(cwd), JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), home.env);
    const raw = fs.readFileSync(traceFile(cwd), 'utf8');
    assert.ok(!raw.includes('ghp_DEADBEEFCAFE'), 'an inline credential must never reach the trace file');
    assert.ok(!raw.includes('curl -H'), 'the command line itself must never reach the trace file');
    const rec = JSON.parse(raw.trim());
    assert.deepEqual(rec.stdinShape.keys.tool_input, { command: `string(${command.length})` });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

// The old capture truncated at 8KB, which bounded the volume but not the exposure:
// the first 8KB of a written file is still the written file. Size must be reported
// without any of the bytes it measures.
test('an oversized payload contributes a byte count and no bytes', () => {
  const cwd = tmpProject();
  const home = tmpHome();
  try {
    armMarker(home.env);
    const content = `LEADING=sk_live_HEAD\n${'x'.repeat(20_000)}\nTRAILING=sk_live_TAIL\n`;
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { content } });
    maybeTraceHook(preToolInput(cwd), stdin, home.env);
    const raw = fs.readFileSync(traceFile(cwd), 'utf8');
    assert.ok(!raw.includes('sk_live_HEAD'), 'the head of a large payload is still payload');
    assert.ok(!raw.includes('sk_live_TAIL'));
    assert.ok(!raw.includes('xxxxxxxxxx'));
    assert.ok(raw.length < 4096, `the whole line stays small (was ${raw.length}B for a ${stdin.length}B payload)`);
    assert.equal(JSON.parse(raw.trim()).stdinShape.bytes, Buffer.byteLength(stdin, 'utf8'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

test('a non-JSON payload yields a byte count only, never the text', () => {
  const cwd = tmpProject();
  const home = tmpHome();
  try {
    armMarker(home.env);
    maybeTraceHook(preToolInput(cwd), 'not json: password=hunter2', home.env);
    const raw = fs.readFileSync(traceFile(cwd), 'utf8');
    assert.ok(!raw.includes('hunter2'));
    const shape = JSON.parse(raw.trim()).stdinShape;
    assert.equal(shape.parsed, false);
    assert.equal(shape.bytes, 'not json: password=hunter2'.length);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});

// Contract 1 + 2 from the file header: a diagnostic that can throw would take the
// hook down with it, and the hook contract is always-exit-0.
test('maybeTraceHook never throws, whatever the input or the destination', () => {
  const home = tmpHome();
  try {
    armMarker(home.env);
    const cwd = tmpProject();
    // an unwritable destination: a FILE where the debug directory must be
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'debug'), 'not a directory', 'utf8');
    assert.doesNotThrow(() => maybeTraceHook(preToolInput(cwd), '{}', home.env));
    // a payload with a self-referential object cannot even be produced from JSON,
    // but a deeply nested one can — the shape walk must be bounded, not recursive.
    let nested = '{"a":1}';
    for (let i = 0; i < 200; i += 1) nested = `{"k":${nested}}`;
    const cwd2 = tmpProject();
    assert.doesNotThrow(() => maybeTraceHook(preToolInput(cwd2), nested, home.env));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(cwd2, { recursive: true, force: true });
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true });
  }
});
