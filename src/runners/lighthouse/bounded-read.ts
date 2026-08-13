// src/runners/lighthouse/bounded-read.ts
// Reading a file whose SHAPE somebody else chose, in bounded time — this
// bundle's own copy of the rule `src/shared/bounded-read.ts` states for the rest
// of the engine.
//
// ── WHY THIS BUNDLE CARRIES ITS OWN, so the next reader does not "tidy" it away
// The lighthouse runner is the one ESM entry and compiles SEPARATELY, through
// tsconfig.lighthouse.build.json, whose `rootDir` is `src/runners/lighthouse`.
// An import of the shared leaf does not merely resolve oddly — it fails the
// build outright. DRIVEN, with the import in place and the project the error
// comes from:
//
//   $ npx tsc -p tsconfig.lighthouse.build.json --noEmit
//   error TS6059: File 'src/shared/bounded-read.ts' is not under 'rootDir'
//                 'src/runners/lighthouse'. 'rootDir' is expected to contain all
//                 source files.
//
// Widening that `rootDir` is a change to how the plugin is BUILT — it moves
// every emitted path in the bundle, and the emit layout is what
// `<outDir>/lighthouse-runner.mjs` and `./lib.js` specifiers depend on. Fifteen
// lines importing nothing but `node:fs` is the smaller price, and the census in
// `src/shared/__tests__/bounded-read-census.test.ts` proves this copy bounded
// from its own flags rather than taking the copy's word for it.
//
// ── WHAT IT DEFENDS AGAINST
// `readFileSync(path)` has no bound at all on two shapes: `open(O_RDONLY)` on a
// FIFO waits for a writer forever, and a character device answers a read as long
// as anybody keeps asking. Every path this bundle reads belongs to the project
// being audited — `.traffic-one/.one.json`, the run's verification contract,
// `next.config.js`, `package.json`, `.next/BUILD_ID`, a built `index.html` — and
// git stores a symlink as a mode-120000 blob, so `next.config.js -> /dev/zero`
// arrives through an ordinary pull request and materialises on `git clone` with
// no local process and no attacker on the box.
//
// DRIVEN before this file existed, one child per shape under a parent SIGKILL at
// 8 000 ms (a hang, not a slow read: the figure IS the deadline): every one of
// the six synchronous reads in cli-args.ts and lib.ts sat in `open(2)` at
// 8 006-8 017 ms on a FIFO and 8 031-8 055 ms on a symlink to /dev/zero, against
// controls of 233-1 004 ms that parsed normally.
//
// Each part refuses one thing, and neither is redundant:
//   O_NONBLOCK   a FIFO with no writer OPENS instead of waiting.
//   the fstat    on the DESCRIPTOR, so the object classified is the object
//                opened — with O_NONBLOCK but no kind test a FIFO reads as EMPTY
//                BYTES, which at a JSON reader is not a hang but a licence to
//                treat a planted object as an empty config.
//
// Deciding on the descriptor rather than on the path is also what closes the
// substitution window: `statSync(p).isFile()` followed by an open of `p` again
// classifies one object and reads another, which is how the preview server's
// stream reached a FIFO at all (see index.mts).
//
// Symlinks are FOLLOWED, deliberately and exactly as `readRegularFile` follows
// them: a config file an operator arranged as a link did nothing wrong, and the
// bound does not come from refusing the link — O_NONBLOCK applies to whatever
// the link resolves to, and the fstat still describes the opened object.
//
// THE RESIDUAL IS THE MEDIUM, NOT THE SHAPE: a regular file on an unresponsive
// network mount still blocks in the kernel, and a huge one is still read in
// full. What goes away is every shape whose cost is unbounded by construction.

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

// Two refusals, and the POSIX-only one folds to nothing on Windows, which has
// neither shape to refuse.
const REGULAR_READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK || 0);

// Prose no kernel produces, so a reader can tell OUR refusal from the
// filesystem's — the same convention the shared leaf uses, and the reason a
// caller keying on ENOENT is untouched: those errnos still arrive from the open.
const NOT_REGULAR_ERRNO = 'not-a-regular-file';

function notRegular(filePath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${filePath} cannot be read (${NOT_REGULAR_ERRNO})`);
  error.code = NOT_REGULAR_ERRNO;
  return error;
}

/**
 * The whole file as text, or a THROW for anything that is not a regular file.
 *
 * It throws rather than answering `null` because every call site in this bundle
 * already reads optional project config inside a `try` whose `catch` means "we
 * could not read this" — so a planted FIFO lands exactly where an unparseable
 * JSON file, an EACCES and a missing directory already land, and the conversion
 * changes no fallback. A shape that cannot be read is NOT the same event as a
 * file that is absent, and neither site nor reader has to fold them: ENOENT
 * still arrives from the open with its own code.
 */
export function readRegularText(filePath: string): string {
  const fd = openSync(filePath, REGULAR_READ_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) throw notRegular(filePath);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A DESCRIPTOR on a regular file, for the one reader that never wanted the whole
 * file in memory: the static preview server, which streams what it serves.
 *
 * The caller owns the descriptor and hands it to `createReadStream`, which
 * ignores the path entirely when `options.fd` is present — so the bound moves to
 * the stream's fd and the stream never opens a path of its own. A non-regular
 * shape throws here, synchronously, in front of the stream rather than as an
 * `'error'` event nobody is listening for.
 */
export function openRegularFd(filePath: string): number {
  const fd = openSync(filePath, REGULAR_READ_FLAGS);
  let handedOver = false;
  try {
    if (!fstatSync(fd).isFile()) throw notRegular(filePath);
    handedOver = true;
    return fd;
  } finally {
    if (!handedOver) closeSync(fd);
  }
}
