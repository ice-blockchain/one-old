// Every store in this module writes through shared/fsjson.ts, whose write is
// FENCED: it returns `false` for an unanswered "use Traffic One here?" question,
// for a planted symlink at the destination, and for a path that escapes the
// project's state dir. These three stores each USED to drop that `false` and
// then report success anyway — a literal `return true`, an optimistic in-memory
// list, or a user-facing "model choice recorded" — so a refused write was
// indistinguishable from a durable one for every caller and for the user.
//
// The fence exercised here is the SYMLINK half. It is the only one that can
// refuse a single named file while leaving the rest of the run directory
// writable, which is what makes these cases readable: nothing else in the
// fixture changes, so any difference is the refusal reaching the caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { recordPendingModelChoiceReply } from '../choice-reply';
import {
  exhaustedModelsForRole,
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  recordExhaustedModel,
} from '../exhausted-models';
import { readModelChoice, writeModelChoice } from '../model-choice';

const RUN_ID = 'R';

function withRun(fn: (cwd: string, runDir: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-write-refusal-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'prefs.json');
  const runDir = path.join(cwd, '.traffic-one', 'runs', RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.traffic-one', '.one.json'),
    JSON.stringify({ mode: 'new-project', onboardingComplete: true, currentRunId: RUN_ID }),
    'utf8',
  );
  try {
    fn(cwd, runDir);
  } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// A link the fence refuses to write through, dangling so no read can succeed
// either — the shape a hostile repo ships on clone.
function fence(runDir: string, name: string): void {
  fs.symlinkSync(path.join(runDir, `absent-${name}`), path.join(runDir, name));
}

test('a refused model-choice write is reported as refused, not as a recorded choice', () => {
  withRun((cwd, runDir) => {
    // Baseline: the same call on a writable path records and reads back.
    assert.equal(writeModelChoice(cwd, RUN_ID, 'use-fallback'), true);
    assert.equal(readModelChoice(cwd, RUN_ID), 'use-fallback');
    fs.unlinkSync(path.join(runDir, 'model-choice.json'));

    fence(runDir, 'model-choice.json');
    assert.equal(writeModelChoice(cwd, RUN_ID, 'use-fallback'), false,
      'the refusal must reach the caller instead of a literal true');
    assert.equal(readModelChoice(cwd, RUN_ID), null, 'and nothing may be readable back');

    // The reply path must not thank the user for an answer it did not keep. The
    // prompted marker is what arms `modelChoiceReplyPending` for the
    // Composer-floor degradation path.
    fs.writeFileSync(path.join(runDir, 'model-choice-prompted'), '{}', 'utf8');
    const result = recordPendingModelChoiceReply(cwd, 'use fallback');
    assert.ok(result, 'a definite reply on a pending run is still handled');
    assert.equal(result.kind, 'context');
    if (result.kind === 'context') {
      assert.match(result.context, /could NOT be recorded/);
      assert.doesNotMatch(result.systemMessage || '', /^traffic-one: model choice recorded$/);
    }
  });
});

test('a refused exhaustion write never reports the model as condemned', () => {
  withRun((cwd, runDir) => {
    // Baseline: a writable ledger records and reads back.
    assert.deepEqual(recordExhaustedModel(cwd, RUN_ID, 'senior-frontend', 'gpt-5.6-terra-medium'),
      ['gpt-5.6-terra-medium']);
    assert.equal(markModelExhaustionTerminal(cwd, RUN_ID, 'senior-frontend'), true);
    fs.unlinkSync(path.join(runDir, 'exhausted-models.json'));

    fence(runDir, 'exhausted-models.json');
    // The returned list is what the rotation deny renders as "TRIED: …" and what
    // decides the next candidate; the DISK is what the next hook reads. They must
    // agree, so a refused write hands back the disk's answer.
    assert.deepEqual(recordExhaustedModel(cwd, RUN_ID, 'senior-backend', 'claude-sonnet-5-thinking-high'), [],
      'a refused record must not claim the model is now condemned');
    assert.deepEqual(exhaustedModelsForRole(cwd, RUN_ID, 'senior-backend'), []);

    assert.equal(markModelExhaustionTerminal(cwd, RUN_ID, 'senior-backend'), false,
      'a refused terminal marker must not report itself persisted');
    assert.equal(modelExhaustionTerminalForRole(cwd, RUN_ID, 'senior-backend'), false);
  });
});
