// Proves that the exact compiled runtime selected for this E2E invocation ran.
// build-and-install temporarily injects a unique hard-coded token writer into
// each selected dist entrypoint; stale same-version caches cannot emit it.

import * as fs from 'fs';

import type { Assertion } from '../core/types';
import {
  RUNTIME_PROOF_ENTRY_ENV,
  RUNTIME_PROOF_FILE_ENV,
  RUNTIME_PROOF_TOKEN_ENV,
} from '../core/current-dist';
import { hostProducedWork, readJsonFile, result, str } from './util';

export const assertion: Assertion = {
  id: 'plugin-runtime-fingerprint',
  title: 'Selected compiled plugin runtime emitted the unique release token',
  appliesTo: (testCase) => testCase.layer === 'host-e2e',
  run: (ctx) => {
    if (!hostProducedWork(ctx.hostResult.status)) {
      return result(ctx, 'SKIP', `Host run produced nothing to fingerprint (${ctx.hostResult.status}).`);
    }

    const proofFile = ctx.env[RUNTIME_PROOF_FILE_ENV];
    const expectedToken = ctx.env[RUNTIME_PROOF_TOKEN_ENV];
    const expectedEntry = ctx.env[RUNTIME_PROOF_ENTRY_ENV];
    if (!proofFile || !expectedToken || !expectedEntry) {
      return result(ctx, 'FAIL', 'Selected dist was not armed with a unique compiled-runtime proof; refusing to infer freshness from package version or rule bytes.');
    }
    if (!fs.existsSync(proofFile)) {
      const detail = `Plugin runtime did not emit ${proofFile}; the host may not have loaded Traffic One hooks.`;
      return ctx.hostResult.status === 'TIMEOUT'
        ? result(ctx, 'INCONCLUSIVE', `${detail} The host run timed out.`)
        : result(ctx, 'FAIL', detail);
    }

    const proof = readJsonFile(proofFile);
    const actualToken = str(proof?.token);
    const actualEntry = str(proof?.entry);
    if (actualToken !== expectedToken || actualEntry !== expectedEntry) {
      return result(ctx, 'FAIL', `Compiled-runtime proof mismatch: expected ${expectedEntry}@${expectedToken}, got ${String(actualEntry)}@${String(actualToken)}.`, {
        expected: { token: expectedToken, entry: expectedEntry },
        actual: { token: actualToken, entry: actualEntry },
      });
    }

    return result(ctx, 'PASS', `Selected runtime ${actualEntry} emitted unique token ${actualToken}.`);
  },
};
