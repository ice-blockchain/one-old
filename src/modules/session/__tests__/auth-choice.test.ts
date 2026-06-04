import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { AUTH_CHOICE_CONTINUE_TTL_MS } from '../../../config/onboarding';
import {
  authChoiceAllowsContinue,
  authChoiceStatus,
  readAuthChoice,
  tryWriteAuthChoice,
} from '../auth-choice';

function withChoice<T>(fn: (dir: string, env: NodeJS.ProcessEnv) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-choice-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH;
  env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(dir, 'choice.json');
  try {
    return fn(dir, env);
  } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH;
    else env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('continue-without is remembered with a TTL and allows continue until it expires', () => {
  withChoice((dir, env) => {
    const cwd = path.join(dir, 'proj');
    assert.equal(tryWriteAuthChoice('continue-without-traffic-one', cwd, env).ok, true);
    assert.equal(authChoiceStatus(cwd, env), 'continue-without-traffic-one');
    assert.equal(authChoiceAllowsContinue(cwd, env), true);
    assert.equal(authChoiceAllowsContinue(cwd, env, Date.now() + AUTH_CHOICE_CONTINUE_TTL_MS + 1000), false);
  });
});

test('authenticate is a global choice and never allows continue-without', () => {
  withChoice((dir, env) => {
    const cwd = path.join(dir, 'proj');
    tryWriteAuthChoice('authenticate', cwd, env);
    const rec = readAuthChoice(cwd, env);
    assert.equal(rec?.status, 'authenticate');
    assert.equal(rec?.scope, 'global');
    assert.equal(authChoiceAllowsContinue(cwd, env), false);
  });
});
