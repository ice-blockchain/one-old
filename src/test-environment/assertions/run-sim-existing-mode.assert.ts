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
import { effState, latestRunId, readRunSimTranscript, rec, result, str } from './util';

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

// Deny prose of the prescribed-stack gates that stand down in existing mode:
// the plan-write static checks (plan-static.ts) and the forbidden-library
// install gate (handler.ts). A deny quoting ANY of these on an existing
// codebase means the stand-down regressed — including an EXPECTED deny, since
// no negative row may pin a retired reason either.
const ARCHITECTURAL_DENY_RE =
  /vanilla-extract|no longer in the active stack|Components must live in|named exports only|Avoid the any type|Forbidden library/;

export const assertion: Assertion = {
  id: 'run-sim-existing-mode',
  title: 'An existing codebase is not restructured',
  // The whole existing-* family, not the literal id — `existing-with-supabase`
  // gets the identical stand-down contract (that parity is what the
  // sim-existing-supabase-web case exists to prove, and an appliesTo keyed on
  // one literal silently SKIPped it there).
  appliesTo: (c) => c.layer === 'run-sim' && c.preSeed.mode.startsWith('existing'),
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

    // 2 — no write was refused for a prescribed-stack reason. The transcript
    // records the verbatim deny a role would have read (WriteOutcome.reason),
    // so a regression of the stand-down is directly quotable here.
    const writes = (Array.isArray(transcript.writes) ? transcript.writes : [])
      .map((row) => rec(row));
    const denies = writes.filter((row) => row.denied === true);
    const architectural = denies.filter((row) => ARCHITECTURAL_DENY_RE.test(str(row.reason) ?? ''));
    if (architectural.length > 0) {
      const quoted = architectural
        .map((row) => `${String(row.path)}: ${str(row.reason) ?? ''}`)
        .join('\n');
      return result(ctx, 'FAIL', `${architectural.length} write(s) on this existing codebase were denied by a prescribed-stack gate that must stand down in existing mode:\n${quoted}`, {
        expected: [],
        actual: architectural.map((row) => String(row.path)),
      });
    }

    // 3 — every declared repo-convention row actually went through the gate
    // and landed. Without this, dropping extraWrites from the case (or the
    // driver skipping them) would keep the scan above vacuously green.
    const declaredExtras = ctx.testCase.runSim?.extraWrites ?? [];
    for (const extra of declaredExtras) {
      const row = writes.find((candidate) => candidate.path === extra.path);
      if (!row) {
        return result(ctx, 'FAIL', `Declared extra write ${extra.path} never reached the gate — the transcript has no row for it.`);
      }
      if (row.denied === true) {
        return result(ctx, 'FAIL', `Declared extra write ${extra.path} was denied: ${str(row.reason) ?? '(no reason recorded)'}`);
      }
    }

    const extrasNote = declaredExtras.length > 0
      ? ` All ${declaredExtras.length} repo-convention extra write(s) were allowed.`
      : '';
    return result(ctx, 'PASS', `No scaffolded config was written into the existing repository (checked ${SCAFFOLDED_CONFIGS.length} paths), and the compiled contract declares none. Scanned ${writes.length} transcript write row(s) (${denies.length} denied) for prescribed-stack deny reasons — none matched.${extrasNote} Run ${runId} settled without restructuring the project.`);
  },
};
