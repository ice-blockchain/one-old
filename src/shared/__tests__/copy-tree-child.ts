// ONE SHAPE, ONE IMPLEMENTATION, ONE PROCESS — because two of the outcomes under
// test here are not reportable from inside the process that has them. `fs.cpSync`
// over a directory holding an `a -> b -> a` symlink loop aborts with SIGABRT (an
// uncaught C++ std::filesystem_error out of weakly_canonical), which no
// `try/catch` and no `uncaughtException` handler sees; a blocking read never
// returns at all. Both are only visible to a PARENT that recorded the signal, so
// this file exists to be that child.
//
// argv: <root> <shape> <impl>
//   shape: control | dir-fifo | dir-socket | dir-loop | dir-devzero
//   impl:  cpSync | copyTreeStrict | cacheFilter
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { copyTreeStrict } from '../copy-tree';
import { copyCacheWithoutSymlinks } from '../../runners/doctor/codex-hook-schema';

const [, , root = '', shape = '', impl = ''] = process.argv;

const out: Record<string, unknown> = { shape, impl };
// INSTALLED ON PURPOSE: "the abort is not catchable" is then a measurement rather
// than something this child forgot to try.
process.on('uncaughtException', (error) => {
  out.uncaught = `${error.name}: ${error.message}`;
  console.log(JSON.stringify(out));
  process.exit(9);
});

const source = path.join(root, 'source');
const destination = path.join(root, 'destination');
fs.mkdirSync(source, { recursive: true });
fs.writeFileSync(path.join(source, 'ordinary.txt'), 'BYTES\n', 'utf8');

const kinds = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((name) => {
    const stat = fs.lstatSync(path.join(dir, name));
    const kind = stat.isSymbolicLink() ? 'link'
      : stat.isFile() ? 'file'
        : stat.isDirectory() ? 'dir'
          : stat.isFIFO() ? 'fifo'
            : stat.isSocket() ? 'socket' : 'other';
    return `${name}:${kind}`;
  });
};

let unavailable: string | null = null;
switch (shape) {
  case 'control':
    break;
  case 'dir-fifo': {
    const made = spawnSync('mkfifo', [path.join(source, 'pipe')], { timeout: 5_000, killSignal: 'SIGKILL' });
    if (made.status !== 0 || !fs.existsSync(path.join(source, 'pipe'))) unavailable = 'mkfifo unavailable';
    break;
  }
  case 'dir-socket': {
    // A listening unix socket, unref'd so it does not hold the loop open. Created
    // through `net` rather than a shell because no portable command makes one.
    const net = require('net') as typeof import('net');
    const server = net.createServer();
    server.listen(path.join(source, 'sock'));
    server.unref();
    if (!fs.existsSync(path.join(source, 'sock'))) unavailable = 'unix socket unavailable';
    break;
  }
  case 'dir-loop':
    // The shape that ABORTS cpSync: two links pointing at each other, so resolving
    // either never terminates. Git stores each as a mode-120000 blob, so a pull
    // request delivers this pair.
    fs.symlinkSync('b', path.join(source, 'a'));
    fs.symlinkSync('a', path.join(source, 'b'));
    break;
  case 'dir-devzero':
    try {
      fs.symlinkSync('/dev/zero', path.join(source, 'zero'));
      if (!fs.existsSync('/dev/zero')) unavailable = 'no /dev/zero';
    } catch {
      unavailable = 'no /dev/zero';
    }
    break;
  default:
    unavailable = `unknown shape ${shape}`;
}

if (unavailable) {
  out.skipped = unavailable;
  console.log(JSON.stringify(out));
  process.exit(0);
}

out.sourceEntries = kinds(source);
const started = Date.now();
try {
  if (impl === 'cpSync') fs.cpSync(source, destination, { recursive: true, force: true });
  else if (impl === 'copyTreeStrict') copyTreeStrict(source, destination);
  else if (impl === 'cacheFilter') copyCacheWithoutSymlinks(source, destination);
  else throw new Error(`unknown impl ${impl}`);
  out.threw = null;
} catch (error) {
  const failure = error as { name?: string; code?: string; message?: string };
  out.threw = `${failure.name ?? 'Error'}: ${failure.code ?? ''} ${failure.message ?? ''}`.trim();
}
out.elapsedMs = Date.now() - started;
out.destinationEntries = kinds(destination);
console.log(JSON.stringify(out));
