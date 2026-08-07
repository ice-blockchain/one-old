// fsjson.readJsonResult — the tri-state (four-state) reader, and the proof that
// putting readJson on top of it changed nothing for its 102 non-test call sites.
//
// THE DEFECT: `readJson(file, fallback)` answers an ABSENT file and an
// UNPARSEABLE one with the same value the caller supplied, so "I could not read
// it" is delivered as a confident "here is the answer". Harmless where the
// fallback is genuinely the right default; destructive in a read-modify-write,
// where a torn file reads as `{}`, one field is merged into `{}`, and the result
// is written back over a file that was merely unparseable.
//
// Two halves here, and the second is the one that makes the first safe to land:
//   * the reader tells the four outcomes apart, INCLUDING `unreadable` (a file
//     that is there and cannot be read) which `readText`'s catch-all folded into
//     "absent" — the single case where overwriting is least defensible;
//   * a DIFFERENTIAL test pins readJson against a byte-for-byte copy of its
//     previous implementation over every input shape. The hard constraint on
//     this lane was that readJson's behaviour must not move, and an assertion
//     about the new implementation alone cannot see that it did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseJson, readJson, readJsonResult, readText } from '../fsjson';

function withDir<T>(label: string, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1lane-readjson-${label}-`));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── the distinction itself ───────────────────────────────────────────────────

test('readJsonResult separates ok / absent / corrupt, which readJson cannot', () => {
  withDir('kinds', (dir) => {
    const ok = path.join(dir, 'ok.json');
    fs.writeFileSync(ok, '{"stack":"default"}\n', 'utf8');
    assert.deepEqual(readJsonResult(ok), { kind: 'ok', value: { stack: 'default' } });

    const absent = path.join(dir, 'nope.json');
    assert.deepEqual(readJsonResult(absent), { kind: 'absent' });

    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{"stack":"defa', 'utf8');
    assert.deepEqual(readJsonResult(corrupt), { kind: 'corrupt', text: '{"stack":"defa' });

    // The whole point: the two failures are indistinguishable through readJson.
    assert.deepEqual(readJson(absent, {}), readJson(corrupt, {}),
      'readJson gives an absent and a corrupt file the same answer — that is the defect, not a bug in this test');
  });
});

test('an EMPTY file is corrupt, not ok — it is the signature of a truncating write that never landed', () => {
  withDir('empty', (dir) => {
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '', 'utf8');
    assert.deepEqual(readJsonResult(empty), { kind: 'corrupt', text: '' });

    const blank = path.join(dir, 'blank.json');
    fs.writeFileSync(blank, '  \n\t ', 'utf8');
    assert.equal(readJsonResult(blank).kind, 'corrupt');

    // A file holding literal `null` lands in the same bucket, for the same
    // reason parseJson already refuses it: there is no state object in it.
    const nul = path.join(dir, 'null.json');
    fs.writeFileSync(nul, 'null\n', 'utf8');
    assert.equal(readJsonResult(nul).kind, 'corrupt');
  });
});

test('corrupt carries the BYTES, so a caller can preserve them before it replaces the file', () => {
  withDir('bytes', (dir) => {
    const file = path.join(dir, 'torn.json');
    const bytes = '{"stack":"default","currentRunId":"17150917850';
    fs.writeFileSync(file, bytes, 'utf8');
    const read = readJsonResult(file);
    assert.equal(read.kind, 'corrupt');
    assert.equal(read.kind === 'corrupt' ? read.text : null, bytes,
      'without the bytes a caller can only choose between destroying the file and refusing forever');
  });
});

// `unreadable` is the fourth kind, beyond the three the item asked for. It is
// not a nicety: `readText` catches EVERY error and answers null, so EACCES on a
// state file — something IS there, we cannot see it — was reported exactly like
// "nothing is there", and "nothing is there" is the one verdict that makes
// overwriting safe.
test('a file that exists and cannot be read is `unreadable`, never `absent`', () => {
  withDir('unreadable', (dir) => {
    // A DIRECTORY at the path is the portable version of this: readFileSync
    // gives EISDIR on every platform, where a chmod 000 file is honoured
    // differently under a root-ish CI user.
    const asDir = path.join(dir, 'state.json');
    fs.mkdirSync(asDir);
    const read = readJsonResult(asDir);
    assert.equal(read.kind, 'unreadable');
    assert.equal(read.kind === 'unreadable' ? read.errno : null, 'EISDIR');
    assert.notEqual(read.kind, 'absent', 'something is there; calling it absent is what licenses an overwrite');
  });
});

// ── the differential: readJson did not move ──────────────────────────────────

/** Verbatim the implementation readJson had before this lane, over the same
 *  readText/parseJson it used. Kept here so the equivalence is CHECKED on every
 *  input rather than asserted in a comment. */
function readJsonAsItWas<T>(filePath: string, fallback: T): T {
  const text = readText(filePath);
  return text == null ? fallback : parseJson<T>(text, fallback);
}

test('readJson is byte-for-byte the function it was, over every input shape', () => {
  withDir('differential', (dir) => {
    const cases: [string, string | null][] = [
      ['absent', null],
      ['object', '{"a":1,"b":{"c":[1,2]}}'],
      ['array', '[1,2,3]'],
      ['string', '"hello"'],
      ['number', '42'],
      ['zero', '0'],
      ['false', 'false'],
      ['true', 'true'],
      ['null', 'null'],
      ['empty', ''],
      ['whitespace', '  \n '],
      ['truncated', '{"a":1'],
      ['garbage', 'not json at all'],
      ['bom-ish', '\uFEFF{"a":1}'],
      ['trailing-newline', '{"a":1}\n'],
      ['nested-null', '{"a":null}'],
      ['leading-space', '   {"a":1}   '],
    ];
    const fallbacks: unknown[] = [{}, null, [], 'FB', 0, false, { seeded: true }];

    for (const [label, content] of cases) {
      const file = path.join(dir, `${label}.json`);
      if (content !== null) fs.writeFileSync(file, content, 'utf8');
      for (const fallback of fallbacks) {
        assert.deepEqual(
          readJson(file, fallback),
          readJsonAsItWas(file, fallback),
          `readJson diverged from its previous implementation on ${label} with fallback ${JSON.stringify(fallback)}`,
        );
      }
    }

    // …and the same for the two non-file shapes readText also swallowed.
    const asDir = path.join(dir, 'a-directory');
    fs.mkdirSync(asDir);
    assert.deepEqual(readJson(asDir, { fb: 1 }), readJsonAsItWas(asDir, { fb: 1 }));
  });
});

test('reads are still never fenced and still resolve symlinks', () => {
  withDir('symlink', (dir) => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, '{"resolved":true}\n', 'utf8');
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(real, link);
    // The materialize fixtures resolve the plugin's rules/ and skills-catalog/
    // through links; a containment or no-follow rule on the READ side would
    // break all of them.
    assert.deepEqual(readJsonResult(link), { kind: 'ok', value: { resolved: true } });

    const dangling = path.join(dir, 'dangling.json');
    fs.symlinkSync(path.join(dir, 'never-created.json'), dangling);
    assert.deepEqual(readJsonResult(dangling), { kind: 'absent' },
      'a dangling link reports ENOENT, which is genuinely "nothing to read here"');
  });
});
