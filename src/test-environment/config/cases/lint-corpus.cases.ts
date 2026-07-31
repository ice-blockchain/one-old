// lint-corpus.cases.ts
// The false-positive corpus as a test-environment case: known-good idiomatic
// code must produce ZERO blocking findings from every write-time gate, and the
// known-bad fixtures must still trip theirs. Pure-node — the corpus feeds
// fixture text straight into the source analyzers, so no host CLI, no dist,
// no spend. The same corpus also runs inside `npm test`
// (core/lint-corpus/lint-corpus.test.ts); this case makes it part of every
// release run's evidence trail with a persisted per-fixture report.

import type { Case } from '../../core/types';

export const LINT_CORPUS_CASES: Case[] = [
  {
    id: 'lint-corpus-false-positives',
    category: 'lint-corpus',
    layer: 'pure-node',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'main-agent', approved: false },
      openCode: false,
      codeGraphProvider: 'gitnexus',
    },
    assertions: [
      { id: 'lint-corpus-clean' },
    ],
    notes: 'Gates were calibrated manually once ("0 FP on 649 files"); this corpus is the permanent regression. A FAIL here is a real false positive: fix the gate, not the fixture.',
  },
];
