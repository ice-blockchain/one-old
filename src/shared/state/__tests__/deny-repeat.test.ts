// Repeated identical denies were invisible to the runtime: a gate is a pure
// function of on-disk state, so an unchanged retry drew the same message forever
// with nothing counting. Measured in 17cl — 25 denies, 15 of them repeats of four
// (file, reason) pairs, one refused seven times over 25 minutes before a replan
// resolved a one-line fix the deny text had already named.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DENY_REPEAT_ESCALATE_AT,
  denyRepeatEscalation,
  denySignature,
  recordDenyRepeat,
} from '../deny-repeat';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-deny-repeat-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test('an identical refusal counts up and escalates; a different one does not', () => {
  withProject((cwd) => {
    const target = 'apps/web/src/pages/Home.tsx';
    const same = denySignature(target, ['Frontend completion gate: STRUCT_ORPHAN_MODULE (packages/ui/src/components/Marquee.tsx): imported nowhere']);
    // A different REASON is a different refusal and starts its own count.
    const movedOn = denySignature(target, ['Frontend completion gate: STRUCT_COLLAPSED_LINE (Home.tsx:41): Line 41 packs …']);
    assert.notEqual(same, movedOn, 'a genuinely different refusal must start its own count');

    // Same reason, same file, MOVED line: two different refusals. Observed 16co
    // — `LessonPage.tsx:57` then `LessonPage.tsx:76`, one agent clearing collapse
    // a line at a time. That is progress on a real defect, and a signature that
    // merged them would have counted it as a loop and told the agent to report
    // BLOCKED while it was converging.
    assert.notEqual(
      denySignature(target, ['Structural gate: STRUCT_COLLAPSED_LINE (LessonPage.tsx:57): Line 57 packs an entire function/component onto one line.']),
      denySignature(target, ['Structural gate: STRUCT_COLLAPSED_LINE (LessonPage.tsx:76): Line 76 packs an entire function/component onto one line.']),
      'clearing collapse line by line is progress, not a loop',
    );
    // Same reason, DIFFERENT subject: different loops. This is the row an 80-char
    // prefix could not express — `filePath` is the digest being written, the same
    // string on every attempt, and the collapse prose does not reach the subject
    // file until char 77, so both files signed identically and an agent clearing
    // them one at a time was told to give up mid-progress.
    const digest = '.traffic-one/digests/R/frontend.md';
    const collapse = (file: string): string => `Frontend completion gate: do not write \`IMPLEMENTED\` with collapsed source. \`${file}\` packs an entire component/route onto a single line`;
    assert.notEqual(
      denySignature(digest, [collapse('apps/web/src/pages/Home.tsx:12')]),
      denySignature(digest, [collapse('apps/web/src/pages/Settings.tsx:12')]),
      'two different collapsed files are two different refusals',
    );

    for (let attempt = 1; attempt < DENY_REPEAT_ESCALATE_AT; attempt += 1) {
      const count = recordDenyRepeat(cwd, 'R', same);
      assert.equal(count, attempt);
      assert.equal(denyRepeatEscalation(count, target), '', 'early attempts must read exactly as before');
    }
    const escalated = recordDenyRepeat(cwd, 'R', same);
    assert.equal(escalated, DENY_REPEAT_ESCALATE_AT);
    const text = denyRepeatEscalation(escalated, target);
    assert.match(text, /STOP RETRYING/);
    assert.match(text, /BLOCKED/, 'the escalation must name the honest exit');
    assert.ok(text.includes(target), 'the escalation must name what is looping');

    // Negative row: a genuinely different refusal on the same file starts over.
    const other = denySignature(target, ['Structural gate: STRUCT_I18N_CATALOG (Home.tsx): catalog is invalid …']);
    assert.notEqual(other, same);
    assert.equal(recordDenyRepeat(cwd, 'R', other), 1);
    assert.equal(denyRepeatEscalation(1, target), '');

    // And another RUN starts over too — a loop is a property of one run.
    assert.equal(recordDenyRepeat(cwd, 'R2', same), 1);
  });
});

test('the counter never throws and never blocks, whatever the project state', () => {
  withProject((cwd) => {
    const sig = denySignature('', ['Run-team enforcement gate: implementation writes via shell …']);
    // No run id: nothing to key on, so nothing is recorded — and no throw.
    assert.equal(recordDenyRepeat(cwd, null, sig), 1);
    assert.equal(recordDenyRepeat(cwd, '', sig), 1);
    // A shell deny carries no file path; it must still be trackable and readable.
    assert.equal(recordDenyRepeat(cwd, 'R', sig), 1);
    assert.match(denyRepeatEscalation(DENY_REPEAT_ESCALATE_AT, ''), /this target/);
    // An unreadable counter file degrades to "first time", never to an exception.
    const file = path.join(cwd, '.traffic-one', 'runs', 'R', 'debug', 'deny-repeats.json');
    fs.writeFileSync(file, 'not json at all', 'utf8');
    assert.equal(recordDenyRepeat(cwd, 'R', sig), 1);
  });
});
