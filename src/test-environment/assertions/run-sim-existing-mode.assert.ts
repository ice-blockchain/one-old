// run-sim-existing-mode: an existing codebase is not restructured.
//
// The owner's constraint, stated plainly: a new project may be structured
// freely, but a repository Traffic One did not create must not be broken. Two
// mechanisms enforce that, and this asserts BOTH on a real run rather than
// trusting the unit tests that cover each in isolation:
//
//   1. Every config scaffold is inside `if (isNewProject)` (compile.ts), so an
//      existing repo receives no eslint/prettier/ruff/golangci config it did
//      not already have. A project that DID have one keeps its own — the
//      scaffold writer only fills missing or blank files.
//   2. contractFindings takes a `greenfield` flag wired from
//      `state.mode === 'new-project'`. On an existing codebase the three
//      integration findings (orphan module, unused API client, inert Tailwind)
//      are advisory, so a maintenance run cannot dead-end on conventions the
//      plugin never authored.

import * as fs from 'fs';
import * as path from 'path';

import { readCompiledArchitecture } from '../../shared/architecture-contract';
import type { Assertion } from '../core/types';
import { effState, latestRunId, readRunSimTranscript, result, str } from './util';

// Configs the compiler scaffolds for a NEW project. None may appear in a repo
// that arrived without them.
const SCAFFOLDED_CONFIGS = [
  'eslint.config.js',
  '.prettierrc',
  '.prettierignore',
  'ruff.toml',
  '.golangci.yml',
  'pint.json',
  'rustfmt.toml',
];

export const assertion: Assertion = {
  id: 'run-sim-existing-mode',
  title: 'An existing codebase is not restructured',
  appliesTo: (c) => c.layer === 'run-sim' && c.preSeed.mode === 'existing-codebase',
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');
    if (transcript.ok !== true) {
      return result(ctx, 'FAIL', `The simulated run did not complete: ${str(transcript.failure) || 'unknown failure'}`);
    }

    const runId = str(transcript.runId) || latestRunId(ctx.cwd, effState(ctx));
    if (!runId) return result(ctx, 'FAIL', 'The simulated run recorded no run id.');

    // 1 — no scaffolded config appeared.
    const intruders = SCAFFOLDED_CONFIGS.filter((rel) => fs.existsSync(path.join(ctx.cwd, rel)));
    if (intruders.length > 0) {
      return result(ctx, 'FAIL', `Traffic One wrote config into a repository it did not create: ${intruders.join(', ')}. Config scaffolding must stay inside the new-project branch.`, {
        expected: [],
        actual: intruders,
      });
    }

    // The compiled contract must AGREE that this is not greenfield: scaffold
    // outputs are what the writer would have seeded, so an existing-mode run
    // declaring them would mean the mode guard sits in the wrong place.
    const architecture = readCompiledArchitecture(ctx.cwd, runId);
    if (!architecture) return result(ctx, 'FAIL', 'No compiled architecture to inspect.');
    const declaredConfigs = (architecture.scaffoldOutputs || [])
      .map((output) => output.path)
      .filter((rel) => SCAFFOLDED_CONFIGS.includes(rel));
    if (declaredConfigs.length > 0) {
      return result(ctx, 'FAIL', `The compiled contract declares config scaffold outputs on an existing codebase: ${declaredConfigs.join(', ')}.`, {
        expected: [],
        actual: declaredConfigs,
      });
    }

    return result(ctx, 'PASS', `No scaffolded config was written into the existing repository (checked ${SCAFFOLDED_CONFIGS.length} paths), and the compiled contract declares none. Run ${runId} settled without restructuring the project.`);
  },
};
