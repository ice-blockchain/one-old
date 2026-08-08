// src/build/changelog.ts
// Generates the root CHANGELOG.md from git history (`npm run changelog`;
// `--check` fails instead of writing when the file is stale).
//
// ── Why this is generated and not written by hand ────────────────────────────
// A hand-written changelog in this repository would rot on the first wave that
// forgot it, and a changelog that is only sometimes true is worse than none:
// the reader cannot tell which entries were maintained. Everything below is
// derived from `git log`, so the only way for it to be wrong is for the commit
// messages to be wrong — which is a problem the reader can see and reason about.
//
// ── The three groups, and why THESE three ────────────────────────────────────
// A Traffic One user is affected by a change through exactly one of three
// channels, and the channels are not interchangeable:
//
//   CONTENT — `src/modules/rules/**`, `src/modules/skills/**`. What the user's
//     agents are TOLD. A change here re-materializes into their project and
//     changes the advice their agents follow, silently, on the next session.
//
//   DENY PROSE — `src/modules/*/skill/SKILL.md` (the T1BLOCK gate blocks) and
//     `src/config/deny-ids.ts`. What a REFUSAL SAYS. A change here does not
//     change whether something is blocked; it changes the wording and the deny
//     id the user sees, greps for, and pastes into an issue.
//
//   RUNTIME — everything else under `src/`. What the product DOES. Gate
//     behaviour, hooks, state, materialization, host adapters, generators.
//
// A single commit routinely touches more than one, so a commit is listed under
// every group it touched rather than being forced into one.
//
// ── What is deliberately NOT in the changelog ────────────────────────────────
// Paths outside `src/`, and test files anywhere. `tests/**`, `__tests__/**`,
// `*.test.ts`, `src/test-environment/**` and `src/test-support/**` do not change
// what an install does, and a changelog that lists them buries the entries that
// do. A commit that touched only those is omitted entirely — stated here, and in
// the generated file's own preamble, so an absent commit is a documented
// exclusion rather than a suspected bug.
//
// ── Versions instead of tags ─────────────────────────────────────────────────
// This repository has no git tags (measured: `git tag` is empty), so releases
// are derived from `package.json`'s `version` field AS IT STOOD at each commit,
// read with one `git cat-file --batch` pass. Consecutive commits carrying the
// same version form one section. The date shown for a section is the date of
// its newest commit — an authorship date, NOT a publication date, and the
// preamble says so.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

export type ChangeGroup = 'content' | 'deny' | 'runtime';

export const GROUP_ORDER: readonly ChangeGroup[] = ['content', 'deny', 'runtime'] as const;

export const GROUP_HEADINGS: Readonly<Record<ChangeGroup, string>> = {
  content: 'Agent-visible content — what your agents are told',
  deny: 'Deny prose — what a refusal says',
  runtime: 'Runtime — what the product does',
};

export interface CommitRecord {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
  readonly paths: readonly string[];
}

export interface ReleaseSection {
  readonly version: string;
  readonly date: string;
  readonly groups: Readonly<Record<ChangeGroup, CommitRecord[]>>;
}

// Test files never reach an install and never change behaviour there. Checked
// FIRST, so a test fixture that happens to live under `src/modules/rules/**`
// cannot be reported as a content change.
function isTestPath(rel: string): boolean {
  return rel.includes('/__tests__/')
    || /\.test\.[cm]?tsx?$/.test(rel)
    || rel.startsWith('src/test-environment/')
    || rel.startsWith('src/test-support/');
}

/**
 * The group a changed path belongs to, or null when the path does not affect an
 * install at all.
 *
 * Order is load-bearing. Deny prose is matched BEFORE content: both
 * `src/modules/<id>/skill/SKILL.md` and `src/modules/skills/**` are "a SKILL.md
 * under src/modules", and only the path shape distinguishes a gate's refusal
 * wording from a shipped skill. Today no module named `skills` has a `skill/`
 * subdirectory, so the two sets do not actually intersect — but that is a fact
 * about the current tree, not a property of the rule, and relying on it would
 * make a new module silently mis-filed.
 */
export function classifyPath(rel: string): ChangeGroup | null {
  const posix = rel.split(path.sep).join('/');
  if (!posix.startsWith('src/')) return null;
  if (isTestPath(posix)) return null;
  if (posix === 'src/config/deny-ids.ts') return 'deny';
  if (/^src\/modules\/[^/]+\/skill\/SKILL\.md$/.test(posix)) return 'deny';
  if (posix.startsWith('src/modules/rules/')) return 'content';
  if (posix.startsWith('src/modules/skills/')) return 'content';
  return 'runtime';
}

/** Every group a commit touched. Empty when the commit changed nothing shipped. */
export function groupsForCommit(paths: readonly string[]): ChangeGroup[] {
  const hit = new Set<ChangeGroup>();
  for (const rel of paths) {
    const group = classifyPath(rel);
    if (group) hit.add(group);
  }
  return GROUP_ORDER.filter((group) => hit.has(group));
}

function git(args: string[], repoRoot: string, input?: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Every commit, newest first, with its changed paths.
 *
 * `--no-merges` because a merge commit's own diff is empty under `--name-only`
 * (git diffs a merge against nothing by default), so merges would contribute a
 * subject line with no paths and be filtered out one step later anyway —
 * dropping them here says so instead of relying on that coincidence.
 */
export function readCommits(repoRoot: string = REPO_ROOT): CommitRecord[] {
  const RECORD = '\u0001';
  const FIELD = '\u0002';
  const raw = git(
    // `%cd`, the COMMIT date, not `%ad`. git log's default order is reverse
    // chronological by commit date, and buildReleases dates each section from
    // the first commit it sees — so the two have to be the same clock or the
    // date on a heading is not the newest one under it. Author dates are NOT
    // monotonic in this history (measured: four inversions, e.g. an
    // author-dated 2026-08-01 commit landing after an author-dated 2026-08-02
    // one), which is exactly the drift that would produce a section headed
    // with a date earlier than an entry inside it.
    ['log', '--no-merges', `--format=${RECORD}%H${FIELD}%cd${FIELD}%s`, '--date=short', '--name-only'],
    repoRoot,
  );
  const commits: CommitRecord[] = [];
  for (const chunk of raw.split(RECORD)) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf('\n');
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const body = newline === -1 ? '' : chunk.slice(newline + 1);
    const [sha, date, ...subjectParts] = header.split(FIELD);
    if (!sha || !date) continue;
    commits.push({
      sha,
      date,
      subject: subjectParts.join(FIELD).trim(),
      paths: body.split('\n').map((line) => line.trim()).filter(Boolean),
    });
  }
  return commits;
}

/**
 * The `package.json` version at each of the given commits, in one batch.
 *
 * `git cat-file --batch` reads `<rev>:<path>` requests off stdin and answers
 * `<oid> <type> <size>\n<contents>\n` per request — or `<request> missing\n`
 * for a commit that predates the file. One process for the whole history
 * instead of one `git show` per commit.
 */
export function readVersionsAtCommits(
  shas: readonly string[],
  repoRoot: string = REPO_ROOT,
): Map<string, string> {
  const out = new Map<string, string>();
  if (shas.length === 0) return out;
  const raw = git(['cat-file', '--batch'], repoRoot, `${shas.map((sha) => `${sha}:package.json`).join('\n')}\n`);
  const buffer = Buffer.from(raw, 'utf8');
  let offset = 0;
  for (const sha of shas) {
    const newline = buffer.indexOf('\n', offset);
    if (newline === -1) break;
    const header = buffer.toString('utf8', offset, newline);
    offset = newline + 1;
    const size = /\b([0-9a-f]{40}) blob (\d+)$/.exec(header)?.[2];
    if (size === undefined) continue; // "missing" / "ambiguous" — no version at this commit
    const bytes = Number(size);
    const body = buffer.toString('utf8', offset, offset + bytes);
    offset += bytes + 1; // trailing newline git appends after the payload
    try {
      const version = (JSON.parse(body) as { version?: unknown }).version;
      if (typeof version === 'string' && version) out.set(sha, version);
    } catch {
      // an unparseable package.json at that commit contributes no version
    }
  }
  return out;
}

/**
 * Bucket commits into version sections, newest first.
 *
 * A commit with no readable version (history older than the `version` field, or
 * an unparseable manifest at that revision) is filed under `unversioned` rather
 * than dropped: losing a real change to a bookkeeping gap would be the worse
 * failure, and the label says plainly that the section's boundary is unknown.
 */
export function buildReleases(
  commits: readonly CommitRecord[],
  versions: ReadonlyMap<string, string>,
): ReleaseSection[] {
  const releases: ReleaseSection[] = [];
  let current: { version: string; date: string; groups: Record<ChangeGroup, CommitRecord[]> } | null = null;
  for (const commit of commits) {
    const groups = groupsForCommit(commit.paths);
    const version = versions.get(commit.sha) ?? 'unversioned';
    if (!current || current.version !== version) {
      if (current) releases.push(current);
      current = { version, date: commit.date, groups: { content: [], deny: [], runtime: [] } };
    }
    // Dated by the section's NEWEST commit, which — walking newest-first — is
    // the first one that opened the section, so the date is set once and not
    // overwritten by the older commits that follow.
    for (const group of groups) current.groups[group].push(commit);
  }
  if (current) releases.push(current);
  return releases.filter((release) => GROUP_ORDER.some((group) => release.groups[group].length > 0));
}

const PREAMBLE = [
  '# Changelog',
  '',
  '<!-- GENERATED by `npm run changelog` (src/build/changelog.ts). Do not edit by hand. -->',
  '',
  'Generated from this repository\'s git history. Every entry is a real commit;',
  'nothing here is written by hand, so nothing here can quietly stop being true.',
  '',
  'Changes are grouped by how they reach you, because the three channels affect',
  'you completely differently:',
  '',
  `- **${GROUP_HEADINGS.content}.** Rules and skills that`,
  '  are materialized into your project. A change here changes the advice your',
  '  agents follow on the next session, without you doing anything.',
  `- **${GROUP_HEADINGS.deny}.** Gate wording and deny ids.`,
  '  A change here does not change what is blocked — it changes what the refusal',
  '  says and which id you can grep for.',
  `- **${GROUP_HEADINGS.runtime}.** Gate behaviour, hooks,`,
  '  state, materialization, host adapters and the generators.',
  '',
  'A commit that touched more than one channel is listed under each.',
  '',
  'Scope: only changes under `src/`, the source of truth for everything an',
  'install receives. Test files, CI configuration and repository documentation',
  'are deliberately excluded — they do not change what an install does — so a',
  'commit you remember may legitimately be absent.',
  '',
  'Versions come from `package.json` as it stood at each commit; this repository',
  'publishes no git tags. **Dates are the newest commit in each section, not a',
  'publication date.**',
  '',
].join('\n');

export function renderChangelog(releases: readonly ReleaseSection[]): string {
  const lines: string[] = [PREAMBLE];
  for (const release of releases) {
    const label = release.version === 'unversioned'
      ? 'Unversioned history'
      : release.version;
    lines.push(`## ${label} — ${release.date}`, '');
    for (const group of GROUP_ORDER) {
      const commits = release.groups[group];
      if (commits.length === 0) continue;
      lines.push(`### ${GROUP_HEADINGS[group]}`, '');
      for (const commit of commits) {
        lines.push(`- ${commit.subject} (\`${commit.sha.slice(0, 8)}\`)`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function generateChangelog(repoRoot: string = REPO_ROOT): string {
  const commits = readCommits(repoRoot);
  const versions = readVersionsAtCommits(commits.map((commit) => commit.sha), repoRoot);
  return renderChangelog(buildReleases(commits, versions));
}

/**
 * The document as it reads with HEAD included, and as it read one commit ago.
 *
 * Both are needed because a committed generated file cannot describe the commit
 * that ships it: the generator derives entries from history INCLUDING HEAD, so
 * fresh output names HEAD's own hash while the file — written before that
 * commit existed — cannot. Measured at 5aea8d77: the sole difference between
 * the committed CHANGELOG.md and fresh output was HEAD's own entry.
 *
 * `atParent` is what the generator produced when the previous commit was HEAD.
 * It is the full history minus the first record, and only when that record IS
 * HEAD — `readCommits` passes `--no-merges`, so when HEAD is a merge it is
 * absent from the list, contributes nothing to the document, and there is
 * nothing to drop.
 */
export function generateChangelogVariants(repoRoot: string = REPO_ROOT): { atHead: string; atParent: string } {
  const commits = readCommits(repoRoot);
  const versions = readVersionsAtCommits(commits.map((commit) => commit.sha), repoRoot);
  const head = git(['rev-parse', 'HEAD'], repoRoot).trim();
  const withoutHead = commits[0]?.sha === head ? commits.slice(1) : commits;
  return {
    atHead: renderChangelog(buildReleases(commits, versions)),
    atParent: renderChangelog(buildReleases(withoutHead, versions)),
  };
}

/**
 * Why a committed CHANGELOG.md is stale, or null when it is current.
 *
 * Current means byte-identical to the document generated from history
 * INCLUDING HEAD (just regenerated, not yet committed) or EXCLUDING it (the
 * steady state: committed one commit ago). Demanding equality with the former
 * alone is an invariant no commit can satisfy — it fails on the very commit
 * that updates the changelog, and regenerating moves the goalpost to the new
 * commit instead of converging. Accepting either keeps both sides EXACT, so a
 * hand edit, a format drift, and any lag of two commits or more all still fail;
 * the one commit of tolerance is the lag inherent to the file, not slack.
 */
export function changelogStaleness(existing: string, repoRoot: string = REPO_ROOT): string | null {
  const { atHead, atParent } = generateChangelogVariants(repoRoot);
  if (existing === atHead || existing === atParent) return null;
  // Name the oldest commit the file is missing rather than reporting inequality:
  // "stale by five commits" and "someone hand-edited the preamble" need
  // different fixes, and only the first one is what a lag looks like.
  const head = git(['rev-parse', 'HEAD'], repoRoot).trim();
  const missing = readCommits(repoRoot)
    // HEAD's own absence is the tolerated lag, never the complaint: counting it
    // would report "missing 2 commits" for a file that is behind by one.
    .filter((commit) => commit.sha !== head && groupsForCommit(commit.paths).length > 0)
    .filter((commit) => !existing.includes(commit.sha.slice(0, 8)));
  const oldest = missing[missing.length - 1];
  return oldest
    ? `CHANGELOG.md is missing ${missing.length} commit(s), oldest ${oldest.sha.slice(0, 8)} "${oldest.subject}"`
    : 'CHANGELOG.md lists every commit but does not match generated output (hand edit or format drift)';
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const check = argv.includes('--check');
  const target = path.join(REPO_ROOT, 'CHANGELOG.md');
  const generated = generateChangelog();
  if (check) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const stale = changelogStaleness(existing);
    if (!stale) {
      process.stdout.write('changelog:check: CHANGELOG.md is current\n');
      return;
    }
    process.stderr.write(`changelog:check: ${stale} — run \`npm run changelog\`\n`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(target, generated, 'utf8');
  const sections = (generated.match(/^## /gm) || []).length;
  const entries = (generated.match(/^- /gm) || []).length;
  process.stdout.write(`changelog: wrote ${sections} version sections, ${entries} entries to CHANGELOG.md\n`);
}

if (require.main === module) main();
