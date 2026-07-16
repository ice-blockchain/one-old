import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Ctx, HookInput } from '../../../core/types';
import { modelChoiceReplySweep, recordPendingModelChoiceReply } from '../choice-reply';
import { markModelChoicePrompted, readModelChoice } from '../model-choice';

const RUN = '1780000000000';

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-choice-reply-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
      currentRunId: RUN,
    }), 'utf8');
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sweepCtx(cwd: string, prompt: string): Ctx {
  const input: HookInput = {
    event: 'UserPromptSubmit',
    host: 'cursor',
    cwd,
    prompt,
    raw: { prompt, session_id: 's1', workspace_roots: [cwd] },
  };
  return { input, host: 'cursor', cwd, now: () => 'x' } as unknown as Ctx;
}

test('the arming race: reply before the marker is dropped, sweep after arming records it (A1)', () => {
  withProject((cwd) => {
    // priority-0 prompt-submit equivalent: pending is NOT armed yet → no record
    assert.equal(recordPendingModelChoiceReply(cwd, 'fallback'), null);
    assert.equal(readModelChoice(cwd, RUN), null);

    // the priority-35 reconcile classifies the failure and arms the marker …
    markModelChoicePrompted(cwd, RUN);

    // … and the priority-45 sweep re-runs the recorder on the SAME prompt
    const swept = modelChoiceReplySweep(sweepCtx(cwd, 'fallback'));
    assert.equal(swept.kind, 'context');
    if (swept.kind === 'context') {
      assert.equal(swept.systemMessage, 'traffic-one: model choice recorded');
    }
    assert.equal(readModelChoice(cwd, RUN), 'use-fallback');
  });
});

test('sweep is a noop when the choice was already recorded (no duplicate context)', () => {
  withProject((cwd) => {
    markModelChoicePrompted(cwd, RUN);
    assert.ok(recordPendingModelChoiceReply(cwd, 'fallback'));
    assert.equal(readModelChoice(cwd, RUN), 'use-fallback');
    // second pass on the same prompt (the sweep after prompt-submit recorded)
    assert.equal(modelChoiceReplySweep(sweepCtx(cwd, 'fallback')).kind, 'noop');
  });
});

test('sweep stays fail-closed: questions and unrelated prompts never record', () => {
  withProject((cwd) => {
    markModelChoicePrompted(cwd, RUN);
    assert.equal(modelChoiceReplySweep(sweepCtx(cwd, 'why was I not asked about fallback?')).kind, 'noop');
    assert.equal(modelChoiceReplySweep(sweepCtx(cwd, 'continue the build')).kind, 'noop');
    assert.equal(readModelChoice(cwd, RUN), null);
  });
});

test('sweep records enable-retry and is cursor-only', () => {
  withProject((cwd) => {
    markModelChoicePrompted(cwd, RUN);
    const nonCursor = modelChoiceReplySweep({
      ...sweepCtx(cwd, 'enable'),
      host: 'claude',
    } as unknown as Ctx);
    assert.equal(nonCursor.kind, 'noop');
    assert.equal(readModelChoice(cwd, RUN), null);

    const swept = modelChoiceReplySweep(sweepCtx(cwd, 'enable'));
    assert.equal(swept.kind, 'context');
    assert.equal(readModelChoice(cwd, RUN), 'enable-retry');
  });
});
