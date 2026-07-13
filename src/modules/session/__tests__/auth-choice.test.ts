import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { AUTH_CHOICE_CONTINUE_TTL_MS } from '../../../config/onboarding';
import {
  authChoiceAllowsContinue,
  authChoiceStatus,
  deleteAuthChoiceState,
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

test('deleteAuthChoiceState reports a live one.json lock failure and succeeds on retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-choice-lock-'));
  const file = path.join(dir, 'one.json');
  const env = { ...process.env, TRAFFIC_ONE_STATE_PATH: file } as NodeJS.ProcessEnv;
  try {
    assert.equal(tryWriteAuthChoice('authenticate', path.join(dir, 'project'), env).ok, true);
    const lockDir = `${file}.lock`;
    const token = 'abc123';
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, `owner-${token}.json`),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      { encoding: 'utf8', mode: 0o600 },
    );

    assert.equal(deleteAuthChoiceState(env), false, 'the failed consolidated-store deletion is observable');
    assert.equal('authChoice' in JSON.parse(fs.readFileSync(file, 'utf8')), true, 'failed deletion preserves the choice');

    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.equal(deleteAuthChoiceState(env), true, 'a later retry succeeds after the lock is released');
    assert.equal('authChoice' in JSON.parse(fs.readFileSync(file, 'utf8')), false, 'retry removes only the choice section');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
