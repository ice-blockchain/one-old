// src/shared/state/run-agent/__tests__/fallback-claims-backup-bytes.test.ts
// The backup a released claim hands to the rebind journal is THE BYTES THE
// DECISION WAS MADE ON — not a second read of the same path, and not a
// re-serialization of what was parsed out of the first.
//
// WHY THIS ROW EXISTS, AND WHAT IT IS NOT. The census asked whether a hostile
// shape could be planted at a claim file between the `lstat` that classified it
// and the read that consumed it. It cannot, and that decline is UPHELD: the
// enumeration is `readdirSync({ withFileTypes: true })` and the filter is
// `entry.isFile()`, which answers FALSE for a FIFO, false for a hard link to a
// FIFO, and false for EVERY symlink — `Dirent.isFile()` reports the entry's own
// type, so a link is a link and is skipped before any path is opened. There is
// no shape that survives the filter and blocks the read. The only route left is
// a TOCTOU substitution in the window after the filter, which needs a writer
// racing inside the directory and is therefore not a deterministic row.
//
// But an honest deterministic row does exist, and it is about the SAME window
// from the other side. The code that used to sit here read the file twice: a
// bounded `readJson` to decide, then a bare `fs.readFileSync` three lines later
// to produce the backup. Both halves were wrong — the second read was the
// unbounded one AND it could return different bytes than the ones the decision
// was made on, so the durable rebind journal could replay a file that was never
// the file that got removed. One read fixes both, and this suite pins the half
// that can be observed without a race.
//
// THE DISCRIMINATOR IS FORMATTING, which is what makes the row deterministic. A
// second read of an unchanged file returns identical bytes, so nothing about a
// re-read is visible in a quiet directory. A RE-SERIALIZATION is visible
// immediately: `JSON.stringify(parsed)` normalizes whitespace, key order and
// number spelling. So the fixture writes a claim whose bytes no serializer would
// emit — odd indentation, a trailing newline, keys out of order, an exponent —
// and asserts the backup is byte-identical to what was on disk. That fails
// against a round-trip, and it fails against any future refactor that decides to
// "clean up" the backup on its way to the journal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { releaseFallbackClaimsForHolderUnlocked } from '../fallback-claims';
import { fallbackClaimsDir } from '../run-paths';

const RUN_ID = 'r1';
const HOLDER = 'senior-backend';

/** os.tmpdir(), never a path in this repo: a fixture project under the plugin
 *  SOURCE root is stood down by the authoring-root fence, and a suite that drops
 *  out reports a clean LOWER number rather than a failure. */
function withProject(fn: (cwd: string, claimsDir: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-fallback-backup-'));
  try {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    // From the product's own path builder rather than spelled out here: a
    // fixture that writes to a directory the code does not read finds NOTHING
    // and passes every "was not released" assertion in this file.
    const claimsDir = fallbackClaimsDir(cwd, RUN_ID);
    fs.mkdirSync(claimsDir, { recursive: true });
    fn(cwd, claimsDir);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Bytes no `JSON.stringify` would ever produce, carrying a claim this holder
 * owns. Every deviation is deliberate: four-space indent, keys in an order no
 * serializer preserves from the type, an exponent that round-trips to a
 * different spelling, and a trailing blank line.
 */
function awkwardClaim(): string {
  return `{\n    "holder": "${HOLDER}",\n    "runId": "${RUN_ID}",\n    "createdAt": 1.7e12,\n`
    + '    "path": "src/app/page.tsx"\n}\n\n';
}

test('fallback claims: the backup is the exact bytes that were read, not a re-serialization', () => {
  withProject((cwd, claimsDir) => {
    const file = path.join(claimsDir, 'claim-a.json');
    const bytes = awkwardClaim();
    fs.writeFileSync(file, bytes, 'utf8');

    // FIXTURE READBACK: the fixture is only a discriminator if a round-trip
    // would actually change it. If some future serializer happened to emit
    // exactly these bytes, the assertion below would pass vacuously.
    assert.notEqual(JSON.stringify(JSON.parse(bytes)), bytes,
      'FIXTURE the claim bytes must be bytes no serializer would emit, or this row proves nothing');

    const result = releaseFallbackClaimsForHolderUnlocked(cwd, RUN_ID, HOLDER);
    assert.equal(result.ok, true, 'the release must succeed');
    assert.equal(result.removed.length, 1, 'FIXTURE exactly the one claim this holder owns was released');

    assert.equal(result.removed[0]!.raw, bytes,
      'the backup handed to the durable rebind journal must be the bytes the decision was made on, byte for '
      + 'byte. A re-serialization normalizes them, and the journal would then replay a file that is not the '
      + 'file that was removed');
    assert.equal(result.removed[0]!.filePath, file, 'and it must name the path it was taken from');
    assert.equal(fs.existsSync(file), false, 'the claim really was released');
  });
});

test('fallback claims: a claim belonging to ANOTHER holder is neither read nor released', () => {
  // THE ANTI-VACUITY ARM for the row above. A release that returned every file
  // it found, or none, would satisfy a single-file fixture just as well.
  withProject((cwd, claimsDir) => {
    const mine = path.join(claimsDir, 'mine.json');
    const theirs = path.join(claimsDir, 'theirs.json');
    fs.writeFileSync(mine, awkwardClaim(), 'utf8');
    fs.writeFileSync(theirs, JSON.stringify({ holder: 'senior-frontend', runId: RUN_ID, path: 'x' }), 'utf8');

    const result = releaseFallbackClaimsForHolderUnlocked(cwd, RUN_ID, HOLDER);
    assert.equal(result.ok, true);
    assert.deepEqual(result.removed.map((row) => row.filePath), [mine],
      'exactly the claims this holder owns, and no others');
    assert.equal(fs.existsSync(theirs), true, 'another holder\'s lease is untouched');
  });
});

test('fallback claims: a NON-REGULAR entry is skipped by the Dirent filter, before any path is opened', () => {
  // THE UPHELD DECLINE, written down as a row rather than as an argument — which
  // is the whole method change this round is about. The claim is that no hostile
  // shape survives `entry.isFile()`, and the cheapest way to stop the next round
  // re-deriving it is to plant the shapes and watch them be skipped.
  //
  // `Dirent.isFile()` reports the DIRECTORY ENTRY's own type, which is why a
  // symlink to a perfectly good claim file is skipped too: that is not an
  // oversight, it is the same reasoning as O_NOFOLLOW at a lock sentinel. A
  // claim file is written by this protocol, and this protocol does not write
  // links.
  if (process.platform === 'win32') return;
  withProject((cwd, claimsDir) => {
    const real = path.join(claimsDir, 'real.json');
    fs.writeFileSync(real, awkwardClaim(), 'utf8');

    const linked = path.join(claimsDir, 'linked.json');
    const dangling = path.join(claimsDir, 'dangling.json');
    try {
      fs.symlinkSync(real, linked);
      fs.symlinkSync(path.join(claimsDir, 'nowhere'), dangling);
    } catch {
      return; // no symlink privilege: the shape is unreachable, not unpinned
    }
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'FIXTURE the link is a link');

    const result = releaseFallbackClaimsForHolderUnlocked(cwd, RUN_ID, HOLDER);
    assert.equal(result.ok, true, 'a link in the directory does not fail the release');
    assert.deepEqual(result.removed.map((row) => row.filePath), [real],
      'only the regular entry is considered — Dirent.isFile() is false for every symlink, so no link is ever '
      + 'opened and there is no lstat-then-read window here to race');
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'and the links are left exactly as they were');
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
  });
});
