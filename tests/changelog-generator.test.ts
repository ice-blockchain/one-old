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
import { test } from 'node:test';

import {
  GROUP_ORDER,
  buildReleases,
  classifyPath,
  generateChangelog,
  groupsForCommit,
  readCommits,
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
test('the committed CHANGELOG.md is current', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const target = path.join(path.resolve(__dirname, '..'), 'CHANGELOG.md');
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    generateChangelog(),
    'CHANGELOG.md is stale — run `npm run changelog`',
  );
});
