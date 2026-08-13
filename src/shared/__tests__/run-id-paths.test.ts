import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasRunIdPlaceholder, strayRunIdInText, substituteRunIdPlaceholder } from '../run-id-paths';

const CURRENT = '1781698183648';

test('strayRunIdInText: a date/ISO run-id path diverging from currentRunId is flagged', () => {
  // The incident: assignments written under a `date -u` ISO id.
  assert.equal(
    strayRunIdInText('.traffic-one/runs/2026-06-17T12-09-40Z/assignments.json', CURRENT),
    '2026-06-17T12-09-40Z',
  );
  // digests too, and absolute paths.
  assert.equal(
    strayRunIdInText('/proj/.traffic-one/digests/2026-06-17T12-09-40Z/architect.md', CURRENT),
    '2026-06-17T12-09-40Z',
  );
  // Windows-style backslashes normalize.
  assert.equal(
    strayRunIdInText('.traffic-one\\runs\\2026-06-17T12-09-40Z\\assignments.json', CURRENT),
    '2026-06-17T12-09-40Z',
  );
  // A shell redirect into a stray run dir is caught.
  assert.equal(
    strayRunIdInText('echo x > .traffic-one/runs/2026-06-17T12-09-40Z/assignments.json', CURRENT),
    '2026-06-17T12-09-40Z',
  );
});

test('strayRunIdInText: the correct currentRunId path is allowed', () => {
  assert.equal(strayRunIdInText(`.traffic-one/runs/${CURRENT}/assignments.json`, CURRENT), null);
  assert.equal(strayRunIdInText(`.traffic-one/digests/${CURRENT}/backend.md`, CURRENT), null);
  // Non-run-id paths are ignored entirely.
  assert.equal(strayRunIdInText('apps/web/src/index.ts', CURRENT), null);
  assert.equal(strayRunIdInText('.traffic-one/plan.md', CURRENT), null);
});

test('strayRunIdInText: a shell glob/wildcard run-dir segment is an inspection, not a stray id', () => {
  // The incident: the orchestrator runs a READ-ONLY inspection across every run dir; the `*`
  // glob must NOT be flagged as a fabricated run-id (it would block `cat`/`ls` of run state).
  assert.equal(
    strayRunIdInText('cat .traffic-one/runs/*/agents.json 2>/dev/null; ls -la .traffic-one/runs/', CURRENT),
    null,
  );
  // Other glob forms are likewise inspections, not fabricated ids.
  assert.equal(strayRunIdInText('.traffic-one/runs/*/assignments.json', CURRENT), null);
  assert.equal(strayRunIdInText('.traffic-one/digests/[0-9]*/architect.md', CURRENT), null);
  assert.equal(strayRunIdInText('.traffic-one/runs/{1,2}/x', CURRENT), null);
  // …but a CONCRETE diverging id alongside a glob is still caught (the glob is skipped, the real
  // stray id wins) — the write guard isn't disarmed by adding a wildcard elsewhere.
  assert.equal(
    strayRunIdInText('.traffic-one/runs/*/x\n.traffic-one/runs/2026-06-17T12-09-40Z/y', CURRENT),
    '2026-06-17T12-09-40Z',
  );
});

test('strayRunIdInText: a dot-prefixed segment is a project-level record, not a stray run id', () => {
  // Both of these are real paths in the runs root, and neither is a run: the
  // reset ledger and the once-marker directory sit ABOVE every run id on
  // purpose. This function used to answer `.resets.json` and `.once` here, and
  // the refusal that produced told the writer to write under
  // `.traffic-one/runs/<currentRunId>/` instead — advice neither path can
  // follow.
  assert.equal(strayRunIdInText('.traffic-one/runs/.resets.json', CURRENT), null);
  assert.equal(strayRunIdInText(`rm -f .traffic-one/runs/.resets.json`, CURRENT), null);
  assert.equal(strayRunIdInText('.traffic-one/runs/.once/maintenance-triage-abc', CURRENT), null);
  // The reset record is FENCED, just not from here: `reset-record-owner-gate`
  // refuses it at the plan gate with no reference to `currentRunId`. That is
  // asserted where it can be — against the gate — in
  // modules/plan-guard/__tests__/reset-record-fence.test.ts ('the reset record is
  // refused with no currentRunId at all'). This assertion is the reason that one
  // has to exist: nothing on this line protects the record any more.
  //
  // `.` and `..` are traversal rather than a name and keep their refusal, or
  // `runs/../…` would become a way out of the run tree.
  assert.equal(strayRunIdInText('.traffic-one/runs/../../etc/passwd', CURRENT), '..');
  assert.equal(strayRunIdInText('.traffic-one/runs/./x', CURRENT), '.');
  // A dot INSIDE the segment is untouched — `<id>.bak` is a fabricated sibling
  // dir, which is exactly what this guard is for.
  assert.equal(strayRunIdInText(`.traffic-one/runs/${CURRENT}.bak/run.json`, CURRENT), `${CURRENT}.bak`);
  // And a real stray alongside a dotted record is still caught: skipping the
  // record must not swallow the scan.
  assert.equal(
    strayRunIdInText('.traffic-one/runs/.resets.json\n.traffic-one/runs/2026-06-17T12-09-40Z/y', CURRENT),
    '2026-06-17T12-09-40Z',
  );
});

test('strayRunIdInText: no enforcement when currentRunId is empty (nothing minted yet)', () => {
  assert.equal(strayRunIdInText('.traffic-one/runs/2026-06-17T12-09-40Z/assignments.json', ''), null);
  assert.equal(strayRunIdInText('.traffic-one/runs/anything/x', undefined), null);
});

test('strayRunIdInText: among several targets the first divergent id wins', () => {
  const text = [
    `.traffic-one/runs/${CURRENT}/assignments.json`,    // ok
    '.traffic-one/digests/2026-06-17T12-09-40Z/architect.md', // stray
  ].join('\n');
  assert.equal(strayRunIdInText(text, CURRENT), '2026-06-17T12-09-40Z');
});

test('run-id placeholders: the RAW detector still flags every literal spelling (write-guard behavior)', () => {
  // The plan-gate WRITE guard calls strayRunIdInText directly — a literal
  // placeholder write path must keep denying (it would strand state under a
  // `runs/<run-id>/` dir). Spawn-gate tolerance comes ONLY from the explicit
  // substitute step below, never from the detector itself.
  assert.equal(strayRunIdInText('.traffic-one/runs/<run-id>/assignments.json', CURRENT), '<run-id>');
  assert.equal(strayRunIdInText('.traffic-one/digests/<runId>/architect.md', CURRENT), '<runId>');
  assert.equal(strayRunIdInText('.traffic-one/digests/<currentRunId>/tester.md', CURRENT), '<currentRunId>');
});

test('substituteRunIdPlaceholder: every documented spelling becomes currentRunId and the result passes the spawn check', () => {
  const text = 'Write .traffic-one/runs/<run-id>/assignments.json, digest to '
    + '.traffic-one/digests/<runId>/architect.md for run <currentRunId>';
  assert.ok(hasRunIdPlaceholder(text));
  const substituted = substituteRunIdPlaceholder(text, CURRENT);
  assert.ok(!hasRunIdPlaceholder(substituted));
  assert.ok(substituted.includes(`runs/${CURRENT}/assignments.json`));
  assert.ok(substituted.includes(`digests/${CURRENT}/architect.md`));
  assert.equal(strayRunIdInText(substituted, CURRENT), null);
  // No run id minted yet → nothing to substitute with; text passes through.
  assert.equal(substituteRunIdPlaceholder(text, ''), text);
  // A fabricated id is NOT a placeholder — substitution leaves it for the detector.
  const fabricated = '.traffic-one/runs/2026-06-17T12-09-40Z/x';
  assert.equal(strayRunIdInText(substituteRunIdPlaceholder(fabricated, CURRENT), CURRENT), '2026-06-17T12-09-40Z');
});

test('substituteRunIdPlaceholder: a decorated placeholder segment stays stray after substitution', () => {
  // Tolerance is for the EXACT template placeholder only. A prefixed/suffixed
  // segment substitutes into a value that no longer equals currentRunId, so the
  // spawn gate still denies it — substitution cannot be used to smuggle a
  // near-miss run dir past the detector.
  assert.equal(
    strayRunIdInText(substituteRunIdPlaceholder('.traffic-one/runs/x<run-id>/assignments.json', CURRENT), CURRENT),
    `x${CURRENT}`,
  );
  assert.equal(
    strayRunIdInText(substituteRunIdPlaceholder('.traffic-one/runs/<run-id>-2/assignments.json', CURRENT), CURRENT),
    `${CURRENT}-2`,
  );
  assert.equal(
    strayRunIdInText(substituteRunIdPlaceholder('.traffic-one/digests/<runId>.bak/architect.md', CURRENT), CURRENT),
    `${CURRENT}.bak`,
  );
});
