// src/test-support/__tests__/git-fixture.ts
// Fixture-repo init shared by tests that `git add` a tree they just wrote.
//
// windows-latest CI sets `core.autocrlf=true` globally. `git add` of a
// 10_001-file vendor/PNG/source tree then emits one "LF will be replaced by
// CRLF" warning per file; node:test reprints each as a TAP `#` line; the
// Actions log spent tens of minutes ingesting them (still on f07911.go at
// 45m). Local `core.autocrlf=false` overrides the runner. `stdio: 'ignore'`
// keeps any leftover chatter off the reporter. A non-zero exit still throws.
//
// Creating those trees is a second cost: Defender on the hosted Windows
// runner turns each write/add/rm into tens of milliseconds. After the CRLF
// mute AND after the 10k architecture/plan-readiness trees were skipped, the
// same job still cancelled at 59m 10s inside `npm test` — source-scan's
// entry-budget fixture still writes 25_500 files and then `rmSync`s them,
// and the rest of the suite is thousands of mkdtemp fixtures the scanner
// opens one by one. Mass trees prove a file-count cap, not a Windows path,
// so they skip on win32 via `SKIP_10K_TREE_ON_WIN32`. The generate-check
// Windows job also turns Defender off, sets `core.autocrlf=false`
// globally, and shards `npm test` 3 ways. Do not raise `timeout-minutes`.

import { execFileSync } from 'child_process';

export const SKIP_10K_TREE_ON_WIN32: boolean | string = process.platform === 'win32'
  ? 'mass fixture trees starve windows-latest under Defender (job cancelled at 59m after 10k skips)'
  : false;

export function commitFixtureRepo(cwd: string, message = 'baseline'): void {
  const quiet = { cwd, stdio: 'ignore' as const };
  execFileSync('git', ['init', '-q'], quiet);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], quiet);
  execFileSync('git', ['config', 'core.safecrlf', 'false'], quiet);
  execFileSync('git', ['config', 'user.email', 'qa@example.test'], quiet);
  execFileSync('git', ['config', 'user.name', 'QA Test'], quiet);
  execFileSync('git', ['add', '.'], quiet);
  execFileSync('git', ['commit', '-qm', message], quiet);
}
