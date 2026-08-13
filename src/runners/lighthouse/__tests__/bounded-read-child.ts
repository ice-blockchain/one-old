// src/runners/lighthouse/__tests__/bounded-read-child.ts
// ONE SITE, ONE SHAPE, ONE PROCESS — the child of bounded-read.test.ts.
//
// It runs in its own process because an unbounded read is invisible from inside:
// `open(2)` on a FIFO with no writer never returns, so no in-process timer can
// fire and no assertion can run. The parent enforces the deadline with SIGKILL
// and reads the outcome off this file's last stdout line.
import { execFileSync } from 'child_process';
import { createReadStream, mkdirSync, readFileSync, symlinkSync, writeFileSync, writeSync } from 'fs';
import * as path from 'path';

import { openRegularFd } from '../bounded-read';
import {
  buildFingerprintTag,
  contractThresholds,
  currentRunId,
  detectPackageManager,
  readJson,
} from '../cli-args';
import { nextConfigOutputExport } from '../lib';

const [root, site, shape] = process.argv.slice(2);

/** The one path each site reads, where the hostile object goes. */
const TARGET: Record<string, string> = {
  contract: path.join(root!, '.traffic-one', 'runs', 'run-abc', 'verification-v2.json'),
  runid: path.join(root!, '.traffic-one', '.one.json'),
  html: path.join(root!, 'dist', 'index.html'),
  buildid: path.join(root!, '.next', 'BUILD_ID'),
  readjson: path.join(root!, 'package.json'),
  nextconfig: path.join(root!, 'next.config.js'),
  stream: path.join(root!, 'out', 'page.html'),
  bare: path.join(root!, '.traffic-one', '.one.json'),
};

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// A COMPLETE, VALID project first, so a hostile arm differs from the control in
// exactly one object: the answer `null` has to mean "this shape was refused"
// rather than "the fixture was never built".
write(path.join(root!, 'package.json'), JSON.stringify({ name: 'fx', packageManager: 'pnpm@9.0.0' }));
write(path.join(root!, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'run-abc' }));
write(
  path.join(root!, '.traffic-one', 'runs', 'run-abc', 'verification-v2.json'),
  JSON.stringify({ performance: { thresholds: { performanceMin: 77, fcpMaxMs: 1234 } } }),
);
// `buildFingerprintTag` walks LAYOUTS — the built entry asset first, the Next
// BUILD_ID after it — so the two sites get one layout each. Writing both would
// let the second answer for the first, and a refusal at `dist/index.html` would
// read as a healthy `bid-12345` instead of as the fallback it is.
if (site === 'html') write(path.join(root!, 'dist', 'index.html'), '<html><script src="/assets/app-deadbeef.js"></script></html>');
if (site === 'buildid') write(path.join(root!, '.next', 'BUILD_ID'), 'bid-12345\n');
write(path.join(root!, 'next.config.js'), "module.exports = { output: 'export' };\n");
write(path.join(root!, 'out', 'page.html'), 'REAL PAGE');

const target = TARGET[site!]!;
if (shape !== 'control') {
  execFileSync('rm', ['-f', target]);
  if (shape === 'fifo') execFileSync('mkfifo', [target]);
  // A symlink, because that is the shape a `git clone` delivers (mode 120000).
  else if (shape === 'devzero') symlinkSync('/dev/zero', target);
  else if (shape === 'dangling') symlinkSync(path.join(root!, 'nowhere'), target);
  else if (shape === 'directory') mkdirSync(target, { recursive: true });
  else throw new Error(`unknown shape ${shape}`);
}

function readStreamText(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    createReadStream(target, { fd })
      .on('data', (chunk) => { text += String(chunk); })
      .on('end', () => resolve(text))
      .on('error', reject);
  });
}

async function drive(): Promise<unknown> {
  switch (site) {
    case 'contract': return contractThresholds(root!);
    case 'runid': return currentRunId(root!);
    case 'html':
    case 'buildid': return buildFingerprintTag(root!, root!);
    case 'readjson': return { json: readJson(target), packageManager: detectPackageManager(root!) };
    case 'nextconfig': return nextConfigOutputExport(root!);
    case 'stream': return readStreamText(openRegularFd(target));
    // THE NEGATIVE CONTROL, and the reason every green arm above means anything:
    // the same object, read the way this bundle read it before, must HANG.
    case 'bare': return JSON.parse(readFileSync(target, 'utf8')) as unknown;
    default: throw new Error(`unknown site ${site}`);
  }
}

// JSON HAS NO INFINITY, and `contractThresholds` answers with one on purpose: an
// undeclared metric becomes an unreachable bound rather than a CLI default. A
// plain stringify would hand the parent `null` for it, i.e. the same value a
// REFUSED read produces, so the sentinel travels as a string.
const report = (arm: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(arm, (_key, value: unknown) => (value === Infinity ? 'Infinity' : value))}\n`);
};

// THE PARENT'S DEADLINE STARTS HERE, not at spawn. Everything above — node
// booting, tsx compiling this bundle, the fixture — costs 3.6-7.7 s on a loaded
// box, and a deadline that had to cover that variance would be so wide it could
// no longer tell a bounded read from a slow one. `writeSync` rather than
// `process.stdout.write` because stdout on a pipe is ASYNC: a synchronous
// `open(2)` immediately after would hold the loop and the line would never
// leave, which is precisely the arm the parent must be able to time.
writeSync(1, '{"ready":true}\n');

const started = Date.now();
drive().then(
  (value) => report({ site, shape, ms: Date.now() - started, value, threw: null }),
  (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    report({
      site, shape, ms: Date.now() - started, value: null, threw: typeof code === 'string' ? code : String(error),
    });
  },
);
