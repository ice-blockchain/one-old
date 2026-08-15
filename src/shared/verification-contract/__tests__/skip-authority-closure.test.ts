// The diff side of the impact-floor property, stated as a CLOSURE rather than
// as a list of today's hiding routes.
//
// A route list is what the previous rounds wrote and it is why they kept
// missing the next respelling: a test that names `.gitignore` passes unchanged
// the day someone teaches the walk a second ignore file. So the assertion here
// names no route. It fixes two runs that differ only in an edit to something the
// skip authority reads, and demands the implication
//
//     changed-path set shrank  =>  the snapshot is NOT complete
//
// which is false for any hiding route, present or future, that the diff does not
// compensate. The route is discovered by the fixture, not enumerated by the
// assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ignoreRuleDigest,
  scanSkipPredicate,
  type ArchitectureBaselineV1,
} from '../../architecture-contract';
import { changedPathsFromImmutableBaseline, fileHash } from '../git';

const UI = 'export function Panel(){ return <div><b>x</b></div>; }\n';
const CAPTURED_AT = '2026-01-01T00:00:00.000Z';

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

function gitRepo(): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-skip-authority-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'a'], { stdio: 'ignore' });
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  write(dir, 'package.json', '{"name":"x"}\n');
  write(dir, '.gitignore', 'node_modules/\n');
  write(dir, 'apps/web/src/features/Kept.tsx', UI);
  return dir;
}

function manifestBaseline(root: string): ArchitectureBaselineV1 {
  const skipped = scanSkipPredicate(root);
  const files: Array<{ path: string; hash: string }> = [];
  const stack = ['.'];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      if (skipped(child)) continue;
      if (entry.isDirectory()) { stack.push(child); continue; }
      if (!entry.isFile()) continue;
      files.push({ path: child, hash: fileHash(root, child) });
    }
  }
  return {
    kind: 'file-manifest',
    identity: 'manifest:test',
    capturedAt: CAPTURED_AT,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    // What `captureArchitectureBaseline` pins. A fixture that omitted it would
    // silently test the pre-field fallback and report the closure as held.
    ...pinnedIgnoreRules(root),
  } as ArchitectureBaselineV1;
}

function pinnedIgnoreRules(root: string): { ignoreRules?: string } {
  const digest = ignoreRuleDigest(root);
  return digest ? { ignoreRules: digest } : {};
}

function gitBaseline(root: string): ArchitectureBaselineV1 {
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base'], { stdio: 'ignore' });
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return {
    kind: 'git-head',
    identity: `git:${head}`,
    capturedAt: CAPTURED_AT,
    files: [],
    ...pinnedIgnoreRules(root),
  } as ArchitectureBaselineV1;
}

/**
 * Every edit a run can make to something the skip authority reads. Add a row
 * here when a new ignore mechanism is honoured; the assertion does not change.
 */
const AUTHORITY_EDITS: ReadonlyArray<{ what: string; apply: (root: string) => void }> = [
  {
    what: 'root .gitignore names the new source directory',
    apply: (root) => write(root, '.gitignore', 'node_modules/\napps/web/src/panels/\n'),
  },
  {
    what: 'a nested .gitignore names the new source directory',
    apply: (root) => write(root, 'apps/web/.gitignore', 'src/panels/\n'),
  },
  {
    // The respelling that walked through the previous compensation. Keying on
    // an ignore-rule file among the CHANGED PATHS asks the diff about a file the
    // diff has just been told not to look at, so one extra line removed the
    // whole instrument and both baseline kinds reported `complete: true` while
    // two source files went missing.
    what: 'a nested .gitignore names the new source directory AND ignores itself',
    apply: (root) => write(root, 'apps/web/.gitignore', 'src/panels/\n.gitignore\n'),
  },
  {
    // Untracked by construction, so no changed-path inference could ever have
    // reported it. Reading the rules can.
    what: '.git/info/exclude names the new source directory',
    apply: (root) => write(root, '.git/info/exclude', 'apps/web/src/panels/\n'),
  },
  {
    what: 'core.excludesFile points at a rule file naming the new source directory',
    apply: (root) => {
      write(root, '.excludes', 'apps/web/src/panels/\n');
      execFileSync('git', ['-C', root, 'config', 'core.excludesFile', path.join(root, '.excludes')],
        { stdio: 'ignore' });
    },
  },
];

for (const kind of ['file-manifest', 'git-head'] as const) {
  for (const edit of AUTHORITY_EDITS) {
    test(`skip-authority closure (${kind}): ${edit.what} cannot shrink a COMPLETE diff`, () => {
      const control = gitRepo();
      if (!control) return; // no git on this machine; the property is untestable, not false
      const subject = gitRepo();
      assert.ok(subject);
      try {
        const baselines = {
          control: kind === 'git-head' ? gitBaseline(control) : manifestBaseline(control),
          subject: kind === 'git-head' ? gitBaseline(subject) : manifestBaseline(subject),
        };

        // Identical source writes on both sides.
        for (const root of [control, subject]) {
          write(root, 'apps/web/src/panels/Panel.tsx', UI);
          write(root, 'apps/web/src/panels/Panel2.tsx', UI);
        }
        // The ONE difference: the subject also moves the skip authority.
        edit.apply(subject);

        const before = changedPathsFromImmutableBaseline(control, baselines.control);
        const after = changedPathsFromImmutableBaseline(subject, baselines.subject);

        assert.equal(before.complete, true,
          `control diff must be complete, got ${before.reason}`);
        const sourceOf = (paths: readonly string[]): string[] =>
          paths.filter((entry) => entry.endsWith('.tsx'));
        const shrank = sourceOf(after.paths).length < sourceOf(before.paths).length;

        // The closure. Not "`.gitignore` must be detected" — that would pass the
        // day a second ignore file is honoured and this one is not.
        if (shrank) {
          assert.equal(after.complete, false,
            `moving the skip authority hid ${sourceOf(before.paths).length - sourceOf(after.paths).length}`
            + ` source file(s) and the diff still reported complete: ${JSON.stringify(after)}`);
          assert.match(String(after.reason), /ignore rules changed since baseline capture/);
        }
      } finally {
        fs.rmSync(control, { recursive: true, force: true });
        fs.rmSync(subject, { recursive: true, force: true });
      }
    });
  }
}

// The other half of the authority, and the half that needs no act at all. The
// edits above all require the run to WRITE an ignore rule. This one requires
// only that a directory be called `generated`: `isScanSkippedPath` is a
// compile-time name set applied to both sides of every diff, so five new `.tsx`
// under those names produce a changed set of ZERO with `complete: true`.
//
// Stated as the same implication as the closure above and for the same reason —
// the directory names are the fixture's business, not the assertion's.
//
// UN-IGNORED, NOT TRACKED, and the row's name used to say "tracked" while the
// fixture below only `write()`s its files and never runs `git add`. The probe
// (`nameSkippedProjectSource`) lists `--cached --others --exclude-standard`, so
// what it reports is everything git declines to ignore, and these two rows
// depend on the `--others` half exclusively.
//
// Which makes the row's REPAIR the hazard, not its detection. Measured, by
// narrowing the probe to `['--cached']`: both rows go RED
// (`a derived-sounding directory name hid 5 source file(s) and the diff still
// reported complete`), so the narrowing itself cannot land quietly. What lands
// quietly is the plausible wrong fix for that red — adding `git add` to the
// fixture, to make it match a name that said "tracked". The rows would be green,
// the narrowing would survive, and the defence would be gone for every project
// that never commits its build output, which is nearly all of them. The name is
// now what the fixture actually builds.
const DERIVED_SOUNDING_DIRS = ['generated', 'out', 'build', 'dist', 'coverage'];

for (const kind of ['file-manifest', 'git-head'] as const) {
  test(`skip-authority closure (${kind}): a derived-sounding directory name cannot hide un-ignored source`, () => {
    const control = gitRepo();
    if (!control) return;
    const subject = gitRepo();
    assert.ok(subject);
    try {
      const baselines = {
        control: kind === 'git-head' ? gitBaseline(control) : manifestBaseline(control),
        subject: kind === 'git-head' ? gitBaseline(subject) : manifestBaseline(subject),
      };
      DERIVED_SOUNDING_DIRS.forEach((dir, index) => {
        write(control, `apps/web/src/panels/Panel${index}.tsx`, UI);
        write(subject, `apps/web/${dir}/Panel${index}.tsx`, UI);
      });

      const before = changedPathsFromImmutableBaseline(control, baselines.control);
      const after = changedPathsFromImmutableBaseline(subject, baselines.subject);
      const sourceOf = (paths: readonly string[]): string[] =>
        paths.filter((entry) => entry.endsWith('.tsx'));

      assert.equal(before.complete, true, `control diff must be complete, got ${before.reason}`);
      assert.equal(sourceOf(before.paths).length, DERIVED_SOUNDING_DIRS.length);
      if (sourceOf(after.paths).length < sourceOf(before.paths).length) {
        assert.equal(after.complete, false,
          `a derived-sounding directory name hid ${sourceOf(before.paths).length - sourceOf(after.paths).length}`
          + ` source file(s) and the diff still reported complete: ${JSON.stringify(after)}`);
        assert.match(String(after.reason), /hidden from the diff by a skipped directory name/);
      }
    } finally {
      fs.rmSync(control, { recursive: true, force: true });
      fs.rmSync(subject, { recursive: true, force: true });
    }
  });
}

// The narrowing, which is the whole reason the check above is quiet enough to
// ship: the project that ignores its build output — nearly every project — is
// telling the diff that those bytes are derived, and git then makes them
// invisible, so there is nothing for the name test to report. A dependency tree
// is never authored source however it is tracked, and a lockfile is a SKIP_FILE
// that git must track by design.
test('skip-authority: an ignored build output, a tracked lockfile and a tracked dependency cost nothing', () => {
  const root = gitRepo();
  if (!root) return;
  try {
    write(root, '.gitignore', 'node_modules/\ndist/\ncoverage/\n');
    write(root, 'package-lock.json', '{"lockfileVersion":3}\n');
    write(root, 'vendor/acme/src/Thing.js', 'module.exports = 1;\n');
    const baseline = gitBaseline(root);
    write(root, 'dist/Bundle.tsx', UI);
    write(root, 'coverage/lcov-report/prettify.js', 'var x = 1;\n');
    write(root, 'apps/web/src/panels/Panel.tsx', UI);
    const snapshot = changedPathsFromImmutableBaseline(root, baseline);
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot));
    assert.deepEqual(snapshot.paths, ['apps/web/src/panels/Panel.tsx']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skip-authority: a post-capture gitignore that adds already-skipped names stays complete', () => {
  const root = gitRepo();
  if (!root) return;
  try {
    const baseline = gitBaseline(root);
    write(root, '.gitignore', 'node_modules/\ndist/\ncoverage/\n.traffic-one/runs/\n');
    write(root, 'apps/web/src/panels/Panel.tsx', UI);
    const snapshot = changedPathsFromImmutableBaseline(root, baseline);
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot));
    assert.ok(snapshot.paths.includes('.gitignore'), snapshot.paths.join(','));
    assert.ok(snapshot.paths.includes('apps/web/src/panels/Panel.tsx'), snapshot.paths.join(','));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skip-authority closure: an untouched authority still yields a complete diff', () => {
  const root = gitRepo();
  if (!root) return;
  try {
    const baseline = gitBaseline(root);
    write(root, 'apps/web/src/panels/Panel.tsx', UI);
    const snapshot = changedPathsFromImmutableBaseline(root, baseline);
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot));
    assert.deepEqual(snapshot.paths, ['apps/web/src/panels/Panel.tsx']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
