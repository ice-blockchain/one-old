import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_PROOF_ENTRY_ENV,
  RUNTIME_PROOF_FILE_ENV,
  RUNTIME_PROOF_TOKEN_ENV,
} from '../core/current-dist';
import { hostSubprocessEnv } from './host-driver';

test('Codex child environment cannot bypass the installed runtime with a checkout root', () => {
  const child = hostSubprocessEnv({
    TRAFFIC_ONE_PLUGIN_ROOT: '/current/checkout/dist',
    [RUNTIME_PROOF_FILE_ENV]: '/case/runtime-proof.json',
    [RUNTIME_PROOF_TOKEN_ENV]: 'expected-token-stays-in-harness',
    [RUNTIME_PROOF_ENTRY_ENV]: 'scripts/hook-runtime.cjs',
  }, {
    CODEX_PLUGIN_ROOT: '/ambient/stale/plugin',
    TRAFFIC_ONE_PLUGIN_ROOT: '/ambient/checkout/dist',
  });

  assert.equal(child.TRAFFIC_ONE_PLUGIN_ROOT, undefined);
  assert.equal(child.CODEX_PLUGIN_ROOT, undefined);
  assert.equal(child[RUNTIME_PROOF_TOKEN_ENV], undefined);
  assert.equal(child[RUNTIME_PROOF_ENTRY_ENV], undefined);
  assert.equal(child[RUNTIME_PROOF_FILE_ENV], '/case/runtime-proof.json');
});
