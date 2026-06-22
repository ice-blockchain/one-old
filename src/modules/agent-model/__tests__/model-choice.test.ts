import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  clearModelChoice,
  markModelAdvisoryShown,
  markModelChoicePrompted,
  modelAdvisoryShown,
  modelChoicePrompted,
  modelChoiceReplyPending,
  parseModelChoice,
  readModelChoice,
  writeModelChoice,
} from '../model-choice';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
}

test('parseModelChoice recognizes only explicit enable/fallback choices; null otherwise', () => {
  assert.equal(parseModelChoice('1'), 'enable-retry');
  assert.equal(parseModelChoice('enable'), 'enable-retry');
  assert.equal(parseModelChoice('Enable and retry'), 'enable-retry');
  assert.equal(parseModelChoice('please retry after enable'), 'enable-retry');
  assert.equal(parseModelChoice('2'), 'use-fallback');
  assert.equal(parseModelChoice('use the fallback'), 'use-fallback');
  assert.equal(parseModelChoice('next eligible please'), 'use-fallback');
  assert.equal(parseModelChoice('continue with fallback'), 'use-fallback');
  assert.equal(parseModelChoice('just use the fallback, don’t retry'), null, 'mixed prose is not explicit consent');
  assert.equal(parseModelChoice("why I wasn't asked about model fallback?"), null, 'questions are never consent');
  assert.equal(parseModelChoice('I saw fallback in the logs'), null, 'mentioning fallback is not consent');
  assert.equal(parseModelChoice('retry'), null, 'ambiguous retry alone is not enough');
  assert.equal(parseModelChoice('do something else'), null);
  assert.equal(parseModelChoice(''), null);
  assert.equal(parseModelChoice('   '), null);
});

test('model-choice store: write/read round-trip, run-scoped, invalid ignored', () => {
  const cwd = tmp();
  try {
    assert.equal(readModelChoice(cwd, 'r1'), null);
    assert.equal(writeModelChoice(cwd, 'r1', 'use-fallback'), true);
    assert.equal(readModelChoice(cwd, 'r1'), 'use-fallback');
    // run-scoped: a different run id has no choice (a new build re-prompts)
    assert.equal(readModelChoice(cwd, 'r2'), null);
    // overwrite
    assert.equal(writeModelChoice(cwd, 'r1', 'enable-retry'), true);
    assert.equal(readModelChoice(cwd, 'r1'), 'enable-retry');
    // empty runId / invalid status rejected (never throws)
    assert.equal(writeModelChoice(cwd, '', 'use-fallback'), false);
    assert.equal(writeModelChoice(cwd, 'r1', 'bogus' as unknown as 'use-fallback'), false);
    assert.equal(readModelChoice(cwd, ''), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('model-choice prompted + advisory once-markers are run-scoped and never throw on empty runId', () => {
  const cwd = tmp();
  try {
    assert.equal(modelChoicePrompted(cwd, 'r1'), false);
    markModelChoicePrompted(cwd, 'r1');
    assert.equal(modelChoicePrompted(cwd, 'r1'), true);
    assert.equal(modelChoicePrompted(cwd, 'r2'), false);

    assert.equal(modelAdvisoryShown(cwd, 'r1'), false);
    markModelAdvisoryShown(cwd, 'r1');
    assert.equal(modelAdvisoryShown(cwd, 'r1'), true);
    assert.equal(modelAdvisoryShown(cwd, 'r2'), false);

    // empty runId is a no-op (never throws, never marks)
    markModelChoicePrompted(cwd, '');
    markModelAdvisoryShown(cwd, '');
    assert.equal(modelChoicePrompted(cwd, ''), false);
    assert.equal(modelAdvisoryShown(cwd, ''), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('clearModelChoice removes a recorded choice for the run', () => {
  const cwd = tmp();
  try {
    writeModelChoice(cwd, 'r1', 'use-fallback');
    clearModelChoice(cwd, 'r1');
    assert.equal(readModelChoice(cwd, 'r1'), null);
    clearModelChoice(cwd, 'r1'); // idempotent
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('modelChoiceReplyPending: true when unavailable picks exist and no choice; false after record', () => {
  const cwd = tmp();
  const env = process.env;
  const pp = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const pl = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-architect': 'balanced' } },
    }), 'utf8');
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'), JSON.stringify({
      models: ['claude-opus-4-8-thinking-high', 'gpt-5.5-medium', 'composer-2.5-fast'],
    }), 'utf8');
    const state = {
      mode: 'new-project', currentRunId: 'run-pending', performance: { level: 'high' },
      team: { mode: 'subagents', approved: true, overrides: { 'senior-architect': 'balanced' } },
    };
    assert.equal(modelChoiceReplyPending(cwd, state), true);
    writeModelChoice(cwd, 'run-pending', 'use-fallback');
    assert.equal(modelChoiceReplyPending(cwd, state), false);
  } finally {
    if (pp === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = pp;
    if (pl === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = pl;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
