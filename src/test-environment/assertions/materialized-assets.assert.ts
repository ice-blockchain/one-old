// materialized-assets: after a host run, .traffic-one project assets exist and
// the manifest agrees with the chosen stack. Host-e2e only — materialization is
// written by the gate on the first mutating tool, so absence is INCONCLUSIVE
// (the model may not have acted), not a hard failure.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';
import { effState, rec, str, result, readJsonFile, hostProducedWork } from './util';

export const assertion: Assertion = {
  id: 'materialized-assets',
  title: 'Project assets materialized',
  appliesTo: (c) => c.layer === 'host-e2e',
  run: (ctx) => {
    if (!hostProducedWork(ctx.hostResult.status)) {
      return result(ctx, 'SKIP', `Host run produced nothing to inspect (${ctx.hostResult.status}).`);
    }
    const t1 = path.join(ctx.cwd, '.traffic-one');
    const manifestPath = path.join(t1, 'manifest.json');
    const manifest = readJsonFile(manifestPath);
    if (!manifest) {
      return result(ctx, 'INCONCLUSIVE', 'No .traffic-one/manifest.json — materialization never triggered.');
    }
    const s = effState(ctx);
    const problems: string[] = [];
    for (const key of ['stack', 'frontend', 'backend'] as const) {
      const want = str(s[key]);
      const got = str(manifest[key]);
      if (want && got && want !== got) problems.push(`manifest.${key}=${got} but state.${key}=${want}`);
    }
    for (const sub of ['rules', 'skills']) {
      if (!fs.existsSync(path.join(t1, sub))) problems.push(`missing .traffic-one/${sub}/`);
    }
    if (!fs.existsSync(path.join(ctx.cwd, 'AGENTS.md')) && !fs.existsSync(path.join(ctx.cwd, 'CLAUDE.md'))) {
      problems.push('missing AGENTS.md/CLAUDE.md');
    }
    const rulesList = Array.isArray(manifest.rules) ? manifest.rules.length : 0;
    if (problems.length === 0) {
      return result(ctx, 'PASS', `Materialized (${rulesList} rules, stack=${str(rec(manifest).stack)}).`);
    }
    return result(ctx, 'FAIL', `Problems:\n - ${problems.join('\n - ')}`);
  },
};
