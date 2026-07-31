// lint-corpus-clean: run the false-positive corpus and require both verdicts —
// zero blocking findings on known-good idiomatic code, and every known-bad
// fixture still tripping the gate it names. The full per-fixture report is
// persisted into the case folder for the release evidence trail.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';
import { runLintCorpus } from '../core/lint-corpus';

export const assertion: Assertion = {
  id: 'lint-corpus-clean',
  title: 'False-positive corpus: gates accept idiomatic code and still reject known-bad',
  appliesTo: (testCase) => testCase.category === 'lint-corpus',
  run: (ctx) => {
    const report = runLintCorpus();
    try {
      fs.writeFileSync(
        path.join(ctx.caseFolder, 'lint-corpus.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } catch { /* report persistence is best-effort */ }
    const problems = [
      ...report.falsePositives.map((entry) => `FP ${entry}`),
      ...report.missedDetections.map((entry) => `MISS ${entry}`),
    ];
    if (problems.length > 0) {
      return {
        id: 'lint-corpus-clean',
        title: '',
        status: 'FAIL',
        detail: problems.slice(0, 8).join(' | ')
          + (problems.length > 8 ? ` | +${problems.length - 8} more (see lint-corpus.json)` : ''),
        actual: { falsePositives: report.falsePositives.length, missedDetections: report.missedDetections.length },
        expected: { falsePositives: 0, missedDetections: 0 },
      };
    }
    return {
      id: 'lint-corpus-clean',
      title: '',
      status: 'PASS',
      detail: `${report.fixtures.length} fixtures clean: zero blocking findings on known-good, every known-bad gate fired`,
    };
  },
};
