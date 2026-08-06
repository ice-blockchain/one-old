// src/gen/emit/provenance.ts
// Content-subtree half of the build-identity stamp (see
// ../lib/build-provenance.ts for why it exists and what it deliberately does
// NOT compare). Written at the plugin root, alongside plugin.json/AGENTS.md —
// never swept (it is not inside a MANAGED_OUTPUT_DIR) and deliberately
// excluded from the golden snapshot (see GOLDEN_EXCLUDED in
// src/build/golden-update.ts: a git SHA changes every commit, which would
// churn a byte-snapshot forever for a file whose bytes are supposed to
// change).
//
// EXPECTED, and the one confusing thing about this file: committing (or
// staging, or any source edit) between `npm run gen` and `npm run
// plugin:check` makes gen --check report exactly one drifted artifact,
// `build-provenance.json`, with no explanation. That is this stamp working —
// gitSha moved to the new commit, or sourceHash to the new working tree — not
// a generator bug. Re-run `npm run gen`. The drift printer in
// src/gen/index.ts cannot say so today because GenRun.file() records only the
// relative path.

import { buildProvenance } from '../lib/build-provenance';
import type { GenRun } from '../lib/run';

export function emitBuildProvenance(run: GenRun): void {
  run.json('build-provenance.json', buildProvenance(run.sourceRoot));
}
