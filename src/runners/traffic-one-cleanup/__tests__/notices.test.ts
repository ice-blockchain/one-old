import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { main } from '../index';

// The CLI a user is TOLD to run when a sweep did not reclaim what it should
// (`run-status` prints exactly that advice), and until now the one mode it
// reported a suspension in was `--json`.
//
// A suspended project plans nothing, so the human-readable line read
// "0 candidate(s), 0 removed" — which is what a HEALTHY project prints. The two
// states that most need telling apart printed the same sentence, and the state
// being hidden is unbounded growth whose only bound is the user reading a notice.
function withSuspendedProject(fn: (dir: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-')));
  const t1 = path.join(dir, '.traffic' + '-one');
  try {
    fs.mkdirSync(path.join(t1, 'runs', '9001'), { recursive: true });
    // A project marker, so resolveProjectRoot stops here rather than climbing out
    // of the temp tree.
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), '{ "mode": ', 'utf8');
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captured(argv: readonly string[]): { code: number; stdout: string } {
  const realArgv = process.argv;
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  process.argv = ['node', 'traffic-one-cleanup.cjs', ...argv];
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    stdout += chunk;
    return true;
  };
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = () => true;
  try {
    return { code: main(), stdout };
  } finally {
    process.argv = realArgv;
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    (process.stderr as unknown as { write: typeof realErr }).write = realErr;
  }
}

test('the cleanup CLI reports a suspended sweep in BOTH modes, not only under --json', () => {
  withSuspendedProject((dir) => {
    const plain = captured(['--cwd', dir]);
    assert.equal(plain.code, 0);
    // The misleading line is still there — it is the answer to what was asked —
    // and it is no longer the whole answer.
    assert.match(plain.stdout, /0 candidate\(s\), 0 removed/, 'baseline: the arithmetic still reads as clean');
    assert.match(plain.stdout, /SUSPENDED/, 'and the reason nothing was reclaimed is printed beside it');
    assert.match(plain.stdout, /do NOT remove it/, 'with the remedy that fits the identity file');

    const json = captured(['--cwd', dir, '--json']);
    assert.equal(json.code, 0);
    const report = JSON.parse(json.stdout) as { notices: string[] };
    assert.equal(report.notices.length, 1, 'the machine-readable mode is unchanged');
    assert.ok(plain.stdout.includes(report.notices[0]!.split('\n')[0]!),
      'and both modes carry the same text, so there is one remedy to keep true');
  });
});

test('a healthy project prints no advisory at all', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-ok-')));
  try {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.traffic' + '-one'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.traffic' + '-one', '.one.json'),
      JSON.stringify({ mode: 'existing-codebase' }),
      'utf8',
    );
    const plain = captured(['--cwd', dir]);
    assert.match(plain.stdout, /0 candidate\(s\), 0 removed/);
    assert.ok(!plain.stdout.includes('SUSPENDED'), 'nothing is wrong, so nothing is said');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
