// src/build/changelog.ts, at its decision points.
//
// The generator has one job with three ways to be quietly wrong: mis-file a
// path into the wrong channel, lose a commit to a bookkeeping gap, or parse the
// git plumbing incorrectly and truncate history. Each is silent — the output is
// still a plausible changelog — so each gets a case that fails loudly.
//
// The git-reading functions are exercised against THIS repository rather than a
// fixture repo, because what is under test there is agreement with real `git
// log` and `git cat-file --batch` output, and a two-commit fixture reproduces
// neither the volume nor the shapes (a commit predating package.json, a
// non-linear merge) that the parsing has to survive.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fsMod from 'node:fs';
import * as osMod from 'node:os';
import * as pathMod from 'node:path';
import { test } from 'node:test';

import {
  GROUP_ORDER,
  buildReleases,
  changelogLagAtTip,
  changelogStaleness,
  classifyPath,
  generateChangelog,
  groupsForCommit,
  readCommits,
  readCommittedChangelog,
  readVersionsAtCommits,
  renderChangelog,
  type CommitRecord,
} from '../src/build/changelog';

function commit(sha: string, date: string, subject: string, paths: string[]): CommitRecord {
  return { sha, date, subject, paths };
}

// ── classification ───────────────────────────────────────────────────────────

test('a path is filed by the channel it reaches the user through', () => {
  assert.equal(classifyPath('src/modules/rules/rules/frontend/react/state.md'), 'content');
  assert.equal(classifyPath('src/modules/skills/skills-catalog/e2e-testing/SKILL.md'), 'content');
  assert.equal(classifyPath('src/config/deny-ids.ts'), 'deny');
  assert.equal(classifyPath('src/modules/plan-guard/skill/SKILL.md'), 'deny');
  assert.equal(classifyPath('src/core/pipeline.ts'), 'runtime');
  assert.equal(classifyPath('src/shared/host/capabilities.ts'), 'runtime');
});

// Deny prose is matched BEFORE content, and the two patterns genuinely overlap:
// `src/modules/skills/skill/SKILL.md` is both "a gate's SKILL.md" and "under
// src/modules/skills". No module named `skills` has a `skill/` subdirectory
// today, so the ambiguity is latent — which is exactly when a precedence rule
// gets deleted for looking redundant.
test('deny prose wins the overlap with content, by rule and not by coincidence', () => {
  assert.equal(classifyPath('src/modules/skills/skill/SKILL.md'), 'deny');
  assert.equal(classifyPath('src/modules/rules/skill/SKILL.md'), 'deny');
  // One level deeper is NOT a gate block — the deny pattern is anchored.
  assert.equal(classifyPath('src/modules/plan-guard/skill/nested/SKILL.md'), 'runtime');
});

test('nothing that cannot reach an install is filed at all', () => {
  for (const rel of [
    'tests/golden/generated-manifest.sha256',
    'README.md',
    '.github/workflows/generate-check.yml',
    'package.json',
    'src/core/__tests__/pipeline.test.ts',
    'src/shared/hook/trace.test.ts',
    'src/test-environment/config/cases/new-project.cases.ts',
    'src/test-support/fixtures.ts',
  ]) {
    assert.equal(classifyPath(rel), null, `${rel} must not appear in a user-facing changelog`);
  }
});

// A test fixture that lives under a content directory is still a test. Checking
// content first would report a fixture edit as "your agents were told something
// different", which is the single most alarming line this document can print.
test('a test file under a content directory is a test, not content', () => {
  assert.equal(classifyPath('src/modules/rules/__tests__/rules.test.ts'), null);
  assert.equal(classifyPath('src/modules/skills/__tests__/catalog.test.ts'), null);
});

test('a commit is listed under every channel it touched, in canonical order', () => {
  assert.deepEqual(
    groupsForCommit([
      'src/core/pipeline.ts',
      'src/config/deny-ids.ts',
      'src/modules/rules/rules/core.md',
      'tests/whatever.test.ts',
    ]),
    ['content', 'deny', 'runtime'],
  );
  assert.deepEqual(groupsForCommit(['README.md', 'package.json']), []);
  assert.deepEqual(groupsForCommit([]), []);
});

// ── release grouping ─────────────────────────────────────────────────────────

test('consecutive commits sharing a version become one section, dated by its newest', () => {
  const commits = [
    commit('aaa', '2026-08-08', 'newest', ['src/core/a.ts']),
    commit('bbb', '2026-08-07', 'middle', ['src/core/b.ts']),
    commit('ccc', '2026-08-01', 'older release', ['src/core/c.ts']),
  ];
  const releases = buildReleases(commits, new Map([['aaa', '1.0.52'], ['bbb', '1.0.52'], ['ccc', '1.0.51']]));
  assert.deepEqual(releases.map((release) => [release.version, release.date]), [
    ['1.0.52', '2026-08-08'],
    ['1.0.51', '2026-08-01'],
  ]);
  assert.deepEqual(releases[0]!.groups.runtime.map((record) => record.sha), ['aaa', 'bbb']);
});

// Losing a real change to a bookkeeping gap is the worse failure, so a commit
// with no readable version is labelled rather than dropped.
test('a commit with no readable version is kept under an honest label', () => {
  const releases = buildReleases(
    [commit('aaa', '2026-01-01', 'prehistory', ['src/core/a.ts'])],
    new Map(),
  );
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.version, 'unversioned');
  assert.match(renderChangelog(releases), /^## Unversioned history — 2026-01-01$/m);
});

test('a section whose every commit was excluded does not appear as an empty heading', () => {
  const releases = buildReleases(
    [
      commit('aaa', '2026-08-08', 'real', ['src/core/a.ts']),
      commit('bbb', '2026-08-07', 'docs only', ['README.md']),
    ],
    new Map([['aaa', '1.0.52'], ['bbb', '1.0.51']]),
  );
  assert.deepEqual(releases.map((release) => release.version), ['1.0.52']);
});

// ── rendering ────────────────────────────────────────────────────────────────

test('the rendered document explains its own scope, so an absent commit is documented', () => {
  const text = renderChangelog(buildReleases(
    [commit('abcdef0123456789', '2026-08-08', 'fix: something', ['src/core/a.ts'])],
    new Map([['abcdef0123456789', '1.0.52']]),
  ));
  assert.match(text, /^# Changelog$/m);
  assert.match(text, /GENERATED by `npm run changelog`/);
  // Every claim the preamble makes that a reader would otherwise have to guess.
  assert.match(text, /only changes under `src\/`/);
  assert.match(text, /Test files, CI configuration and repository documentation\s+are deliberately excluded/);
  assert.match(text, /Dates are the newest commit in each section, not a\s+publication date/);
  assert.match(text, /^## 1\.0\.52 — 2026-08-08$/m);
  assert.match(text, /^- fix: something \(`abcdef01`\)$/m);
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'), 'exactly one trailing newline, so --check is not defeated by whitespace');
});

test('each channel renders under a heading that says what it means for the reader', () => {
  const text = renderChangelog(buildReleases(
    [commit('aaaaaaaa', '2026-08-08', 'touched everything', [
      'src/modules/rules/rules/core.md',
      'src/config/deny-ids.ts',
      'src/core/pipeline.ts',
    ])],
    new Map([['aaaaaaaa', '1.0.52']]),
  ));
  const headings = [...text.matchAll(/^### (.+)$/gm)].map((match) => match[1] as string);
  assert.equal(headings.length, GROUP_ORDER.length, 'a commit touching all three must render all three');
  assert.deepEqual(headings, [
    'Agent-visible content — what your agents are told',
    'Deny prose — what a refusal says',
    'Runtime — what the product does',
  ]);
  // The same commit appears once per channel. That is the design, not a bug,
  // and a dedupe "fix" would hide two thirds of its impact.
  assert.equal([...text.matchAll(/touched everything/g)].length, 3);
});

// ── against real git ─────────────────────────────────────────────────────────

test('readCommits parses real history without losing commits or leaking framing', () => {
  const commits = readCommits();
  assert.ok(commits.length > 100, `expected substantial history, got ${commits.length}`);
  const shas = new Set<string>();
  for (const record of commits) {
    assert.match(record.sha, /^[0-9a-f]{40}$/, `bad sha: ${JSON.stringify(record.sha)}`);
    assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/, `bad date on ${record.sha}`);
    // The record/field separators are U+0001 and U+0002. Either one surviving
    // into a field means the split lost its alignment and every subsequent
    // record is suspect.
    assert.doesNotMatch(record.subject, /[\u0001\u0002]/, `framing leaked into a subject: ${record.sha}`);
    for (const rel of record.paths) {
      assert.ok(rel.length > 0 && !/[\u0001\u0002]/.test(rel), `framing leaked into a path: ${record.sha}`);
    }
    assert.equal(shas.has(record.sha), false, `duplicate commit ${record.sha}`);
    shas.add(record.sha);
  }
  // Newest first, which buildReleases' date handling depends on.
  const dates = commits.map((record) => record.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'git log is not in newest-first order');
});

// The batch reader walks a byte stream by offset. An off-by-one on the
// header/payload boundary does not throw — it desynchronizes, and every
// subsequent commit silently gets the wrong version or none. The assertion that
// catches it is agreement with `git show` on a sample.
test('readVersionsAtCommits agrees with git show, commit by commit', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const path = require('node:path') as typeof import('node:path');
  const repoRoot = path.resolve(__dirname, '..');
  const commits = readCommits();
  const versions = readVersionsAtCommits(commits.map((record) => record.sha));
  assert.ok(versions.size > 100, `expected most commits to carry a version, got ${versions.size}`);

  // Spread across the whole stream, so a desync anywhere is sampled.
  const sample = [0, 1, Math.floor(commits.length / 3), Math.floor(commits.length / 2), commits.length - 1]
    .map((index) => commits[index]!)
    .filter(Boolean);
  for (const record of sample) {
    let expected: string | null = null;
    try {
      const raw = execFileSync('git', ['show', `${record.sha}:package.json`], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      const parsed = JSON.parse(raw) as { version?: unknown };
      expected = typeof parsed.version === 'string' ? parsed.version : null;
    } catch {
      expected = null; // package.json absent at that revision
    }
    assert.equal(versions.get(record.sha) ?? null, expected, `version mismatch at ${record.sha}`);
  }
});

test('the generated document is deterministic and non-trivial', () => {
  const first = generateChangelog();
  assert.equal(first, generateChangelog(), 'two runs over the same history must be byte-identical');
  assert.ok(first.length > 2000, 'the generated changelog is suspiciously short');
  assert.ok((first.match(/^## /gm) || []).length > 5, 'expected several version sections');
  assert.ok((first.match(/^- /gm) || []).length > 50, 'expected many entries');
});

// The committed CHANGELOG.md is the only copy anyone reads (it does not ship —
// see tests/release-docs.test.ts for why), so a stale one is the whole failure
// mode a generated changelog exists to prevent. This is the assertion `npm run
// changelog:check` makes, wired into the suite so it cannot be forgotten.
//
// It is deliberately NOT `committed === generateChangelog()`. That equality is
// unsatisfiable by construction: the generator reads history including HEAD, so
// fresh output names HEAD's own hash and the committed file — written before
// that commit existed — cannot. It therefore fails on every commit that ships a
// changelog update, and regenerating does not converge, it re-points the
// goalpost at the new commit. (Measured at 5aea8d77: the whole diff between the
// committed file and fresh output was HEAD's own entry, and the committed file
// contained `5aea8d77` zero times.) changelogStaleness accepts the document as
// of HEAD or as of HEAD's parent, both byte-exact — one commit of lag is
// inherent to a generated file committed alongside what it describes; two is a
// defect, and so is a hand edit.
test('the committed CHANGELOG.md is current', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const target = path.join(path.resolve(__dirname, '..'), 'CHANGELOG.md');
  const stale = changelogStaleness(fs.readFileSync(target, 'utf8'));
  assert.equal(stale, null, `${stale} — run \`npm run changelog\``);
});

// The tolerance above is one commit of LAG, not a licence to be behind. Losing
// an older commit is the failure the document exists to prevent, so it is
// checked by execution rather than argued: strip a commit that is neither HEAD
// nor HEAD's parent out of an otherwise-current file and the check must name it.
test('a changelog missing an OLDER commit is still caught, by name', () => {
  const current = generateChangelog();
  const entry = /^- .+ \(`([0-9a-f]{8})`\)$/gm;
  // The third distinct entry from the top: old enough that neither accepted
  // document contains it, so removing it is genuine staleness and not lag.
  const shas = [...new Set([...current.matchAll(entry)].map((match) => match[1] as string))];
  const victim = shas[2];
  assert.ok(victim, 'fixture guard: the generated changelog has at least three distinct commits');
  const mutilated = current
    .split('\n')
    .filter((line) => !line.includes(`(\`${victim}\`)`))
    .join('\n');
  const stale = changelogStaleness(mutilated);
  assert.ok(stale, 'a changelog missing an older commit must not pass as current');
  assert.match(stale, new RegExp(victim), 'the failure must name the commit that is missing, not just report a mismatch');
});

// ── the pre-push condition ───────────────────────────────────────────────────
//
// These rows use a FIXTURE repo, against this file's own stated preference, and
// for the reason that preference gives. What is under test is not agreement with
// real git output; it is a DISCRIMINATION between two states of one repository —
// a tip that the committed changelog describes and a tip it does not. This
// repository is in exactly one of those states at any moment, and once it is
// current it stays current, so the row that carries the whole point could never
// run against it.

function fixtureGit(cwd: string, args: readonly string[]): string {
  // Identity, signing and hooks all pinned per call. A developer's global config
  // (a gpg key, a core.hooksPath pointing at .githooks) must not decide whether
  // this fixture can commit, or make it run the very hook under test.
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    },
  );
}

const fixtureRoots: string[] = [];

function fixtureRepo(): string {
  const root = fsMod.realpathSync(fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 't1-changelog-lag-')));
  fixtureRoots.push(root);
  fixtureGit(root, ['init', '--initial-branch=main']);
  fixtureWrite(root, 'package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2)}\n`);
  fixtureWrite(root, 'src/core/seed.ts', 'export const seed = 1;\n');
  fixtureCommit(root, 'fixture: seed the runtime');
  return root;
}

function fixtureWrite(root: string, rel: string, text: string): void {
  const target = pathMod.join(root, rel);
  fsMod.mkdirSync(pathMod.dirname(target), { recursive: true });
  fsMod.writeFileSync(target, text, 'utf8');
}

function fixtureCommit(root: string, message: string): string {
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-m', message]);
  return fixtureGit(root, ['rev-parse', 'HEAD']).trim();
}

/** What a maintainer does: regenerate, then commit the result on its own. */
function fixtureRegenerate(root: string): string {
  fixtureWrite(root, 'CHANGELOG.md', generateChangelog(root));
  return fixtureCommit(root, 'changelog: regenerate');
}

function committedChangelog(root: string, rev = 'HEAD'): string {
  return readCommittedChangelog(root, rev);
}

test.after(() => {
  for (const root of fixtureRoots) fsMod.rmSync(root, { recursive: true, force: true });
  fixtureRoots.length = 0;
});

// THE row. Both checks are asked the same question about the same commit and
// must answer differently, because that difference is the entire reason the
// strict one exists: the lenient answer is what let 26549c3d through and made
// aa031085's author read a failure about someone else's commit.
test('a src/ tip with no regeneration passes the CI check and is refused by the push check', () => {
  const root = fixtureRepo();
  fixtureRegenerate(root);

  fixtureWrite(root, 'src/core/later.ts', 'export const later = 2;\n');
  const tip = fixtureCommit(root, 'runtime: a change nobody wrote down');
  const committed = committedChangelog(root);

  assert.equal(changelogStaleness(committed, root), null,
    'the CI check tolerates one commit of lag — this is the state it forgives, and the reason it must');
  const refusal = changelogLagAtTip(committed, root);
  assert.ok(refusal, 'the push check must refuse the same document the CI check accepts');
  assert.match(refusal, new RegExp(tip.slice(0, 8)),
    'the refusal must name the commit that caused it, so its own author can act on it');
  assert.match(refusal, /rejects the next one/,
    'and must say what happens if it is ignored, since the push itself would otherwise look fine');
});

// The push condition has to CONVERGE, or it is not a condition, it is a wall.
// This is the fear the lenient check's header describes — regenerating re-points
// the goalpost at the new commit — shown not to apply to a push, because the
// commit that carries the document changes nothing shipped.
test('regenerating and committing satisfies the push check, in one step', () => {
  const root = fixtureRepo();
  fixtureRegenerate(root);
  fixtureWrite(root, 'src/core/later.ts', 'export const later = 2;\n');
  fixtureCommit(root, 'runtime: a change nobody wrote down');
  assert.ok(changelogLagAtTip(committedChangelog(root), root), 'fixture guard: the push check refuses this state');

  fixtureRegenerate(root);

  assert.equal(changelogLagAtTip(committedChangelog(root), root), null,
    'one regeneration and one commit must clear it — a check that cannot be satisfied gets bypassed instead');
  assert.equal(changelogStaleness(committedChangelog(root), root), null, 'and the CI check still passes');
});

// The push check must not demand a ceremonial commit for a change that reaches
// no install. `groupsForCommit` already answers this for the generator; here it
// is the difference between a hook people keep and a hook people disable.
test('a tip that changed only tests needs no changelog commit', () => {
  const root = fixtureRepo();
  fixtureRegenerate(root);

  fixtureWrite(root, 'src/core/__tests__/seed.test.ts', 'export const t = 1;\n');
  fixtureWrite(root, 'tests/e2e/whatever.test.ts', 'export const e = 1;\n');
  fixtureWrite(root, '.github/workflows/ci.yml', 'name: ci\n');
  fixtureCommit(root, 'tests: nothing an install receives');

  assert.equal(changelogLagAtTip(committedChangelog(root), root), null,
    'a commit the changelog deliberately omits cannot be a reason to refuse a push');
});

// A hook judges what the REMOTE is about to receive. The working copy is not
// that: regenerating without committing leaves the push exactly as stale as it
// was, and a check that read the file on disk would wave it through.
test('the push check reads the commit, not the working copy', () => {
  const root = fixtureRepo();
  fixtureRegenerate(root);
  fixtureWrite(root, 'src/core/later.ts', 'export const later = 2;\n');
  const tip = fixtureCommit(root, 'runtime: a change nobody wrote down');

  // Regenerate on disk and leave it UNCOMMITTED, the honest mistake this guards.
  fixtureWrite(root, 'CHANGELOG.md', generateChangelog(root));

  const onDisk = fsMod.readFileSync(pathMod.join(root, 'CHANGELOG.md'), 'utf8');
  assert.equal(changelogLagAtTip(onDisk, root), null,
    'fixture guard: the regenerated bytes DO satisfy the check, so only the source of the bytes is under test');
  assert.ok(changelogLagAtTip(committedChangelog(root, tip), root, tip),
    'an uncommitted regeneration is not part of the push and must not satisfy it');
});

// `--rev` is not a synonym for HEAD, or the hook cannot judge a branch that is
// pushed without being checked out.
test('the push check can judge a commit that is not the tip of the checkout', () => {
  const root = fixtureRepo();
  const clean = fixtureRegenerate(root);
  fixtureWrite(root, 'src/core/later.ts', 'export const later = 2;\n');
  fixtureCommit(root, 'runtime: a change nobody wrote down');
  const dirty = fixtureRegenerate(root); // HEAD is now current again

  assert.equal(changelogLagAtTip(committedChangelog(root, dirty), root, dirty), null, 'HEAD is current');
  assert.equal(changelogLagAtTip(committedChangelog(root, clean), root, clean), null,
    'and so was the earlier commit, judged on its own history rather than on HEAD\'s');

  const midway = fixtureGit(root, ['rev-parse', `${dirty}^`]).trim();
  assert.ok(changelogLagAtTip(committedChangelog(root, midway), root, midway),
    'the commit BETWEEN them was not, and asking about it must not be answered about HEAD');
});

// ── the hook that runs it ────────────────────────────────────────────────────

// The check above is only enforced by the hook file, and the hook is shell that
// no test would otherwise read. Two spellings of the same command now exist (the
// hook's and package.json's), so both are pinned here: a flag renamed in
// changelog.ts and not in the hook would leave a hook that exits 1 on every
// push, and one renamed in the hook alone would leave a hook that checks nothing.
test('the pre-push hook is installed, executable, and runs the strict check', () => {
  const repoRoot = pathMod.resolve(__dirname, '..');
  const hookPath = pathMod.join(repoRoot, '.githooks', 'pre-push');
  assert.equal(fsMod.existsSync(hookPath), true, '.githooks/pre-push must exist to be installable');
  assert.ok(fsMod.statSync(hookPath).mode & 0o100, 'git ignores a hook that is not executable, silently');

  const hook = fsMod.readFileSync(hookPath, 'utf8');
  assert.match(hook, /^#!\/bin\/sh/, 'the other two hooks are /bin/sh; a hook with no shebang is not run');
  assert.match(hook, /src\/build\/changelog\.ts --check --strict --rev "\$local_sha"/,
    'the hook must judge the PUSHED commit, which is what --rev is for');
  assert.match(hook, /refs\/heads\/\*/, 'a tag cannot be followed by a regeneration, so only branches are judged');
  assert.match(hook, /--no-verify/, 'a hook with no documented escape hatch gets uninstalled instead of bypassed');

  const pkg = JSON.parse(fsMod.readFileSync(pathMod.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts['changelog:check:push'], 'tsx src/build/changelog.ts --check --strict',
    'the by-hand spelling must ask the same question as the hook, or the two drift apart');
});

// The CLI is the only surface the hook touches, and its exit code is the whole
// contract: 0 lets a push through. Driven as a process, because `main()`
// returning normally while setting process.exitCode is exactly how a hook can
// end up green over a refusal.
test('the CLI refuses --strict without --check, and needs a commit after --rev', () => {
  const repoRoot = pathMod.resolve(__dirname, '..');
  const cli = (args: readonly string[]): { code: number | null; stderr: string } => {
    const run = spawnSync(process.execPath, [
      '--import', 'tsx', pathMod.join(repoRoot, 'src', 'build', 'changelog.ts'), ...args,
    ], { cwd: repoRoot, encoding: 'utf8' });
    return { code: run.status, stderr: run.stderr };
  };

  const bare = cli(['--strict']);
  assert.equal(bare.code, 1, '--strict alone must not be read as a request to WRITE the changelog');
  assert.match(bare.stderr, /--strict only qualifies --check/);

  const noRev = cli(['--check', '--strict', '--rev']);
  assert.equal(noRev.code, 1, 'a missing --rev value must fail rather than silently judge HEAD');
  assert.match(noRev.stderr, /--rev needs a commit/);
});
