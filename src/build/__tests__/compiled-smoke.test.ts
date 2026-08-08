import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importing this module must not run the smoke. That is load-bearing for the
// test below AND the reason main() is guarded: an unguarded main() here would
// start a full cutover build (a whole `tsc`) inside `npm test`.
import { SmokeFailure, fail } from '../compiled-smoke';

// `fail()` used to be `process.stderr.write(...)` + `process.exit(1)`, and
// process.exit unwinds NOTHING. Every `finally` in compiled-smoke.ts was
// therefore dead on the failing path: the four scratch trees under os.tmpdir()
// survived every failed run, and a failure inside the missing-modules section
// left `scratch/modules` renamed to `modules-smoke-hidden`. The file's own
// header promises the opposite ("Non-destructive: the scratch dir is removed").
//
// If this regresses, the mutation does not merely fail this assertion — it
// terminates the test process mid-file, because that is precisely what the
// defect was.
test('a smoke failure unwinds its cleanup instead of terminating the process', () => {
  let cleanedUp = false;

  assert.throws(
    () => {
      try {
        fail('a representative smoke assertion');
      } finally {
        cleanedUp = true;
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof SmokeFailure, 'the runner distinguishes its own failures from crashes');
      assert.equal(err.message, 'compiled-smoke: FAIL — a representative smoke assertion');
      return true;
    },
  );

  assert.equal(cleanedUp, true, 'the enclosing finally must run — that is the whole fix');
  // Reaching this line at all is the other half of the claim: the process is
  // still alive after a failure, so the caller decides the exit code.
  assert.equal(typeof fail, 'function');
});
