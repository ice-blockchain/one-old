// `.gitleaks.toml` ↔ the trees it is actually scanned against.
//
// The security-check runner drives gitleaks twice (src/runners/security-check/
// scanners-secrets.ts): `gitleaks git --log-opts=--all` over history, which can
// only ever see COMMITTED files, and `gitleaks dir` over the working tree, which
// also walks gitignored paths and therefore sees the generated plugin root.
//
// The config shipped with an allowlist whose every path entry described the
// GENERATED layout — and described it wrongly for the catalog, as `skills/<id>/
// SKILL.md` rather than the `skills-catalog/<id>/SKILL.md` gen emits. `dist/` is
// gitignored, so that
// half of the scan had an allowlist covering none of the files in the
// repository: the entries could not suppress anything the history scan found,
// and any placeholder credential in a committed source file was a build-breaking
// finding waiting to happen. This test pins the fix — that every generated-tree
// entry has a committed-source counterpart, and that the committed paths named
// exist — so the config cannot drift back to describing only a tree that is
// never committed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SHIMS } from '../src/build/build-runtime';
import { generatedSkillDocs } from '../src/gen/emit/skills';

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(REPO_ROOT, '.gitleaks.toml');

/**
 * The `paths` array of the top-level `[allowlist]`, unescaped from the regex
 * spellings gitleaks takes. Deliberately a small parse of the one array this
 * test is about rather than a TOML dependency: the hook runtime ships without
 * dependencies and this file is read for exactly one key.
 */
function allowlistPaths(): string[] {
  const toml = fs.readFileSync(CONFIG, 'utf8');
  const block = /(?:^|\n)paths\s*=\s*\[([\s\S]*?)\n\]/.exec(toml);
  assert.ok(block, '.gitleaks.toml must declare an [allowlist] paths array');
  const body = (block as RegExpExecArray)[1] as string;
  return [...body.matchAll(/'''([\s\S]*?)'''/g)].map((m) => m[1] as string);
}

/** A path-regex entry reduced to the literal path it describes. */
function literal(entry: string): string {
  return entry.replace(/\\([.\\])/g, '$1');
}

test('the allowlist covers the committed tree, not only the generated one', () => {
  const entries = allowlistPaths().map(literal);
  const committed = entries.filter((e) => e.startsWith('src/'));

  assert.ok(committed.length > 0,
    'at least one entry must name a committed path, or the history scan runs with an allowlist that matches nothing');

  for (const entry of committed) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, entry)),
      `allowlisted committed path does not exist: ${entry} — a stale entry suppresses nothing and hides that the real file is unlisted`);
  }
});

test('every generated-tree entry has a committed-source counterpart', () => {
  const entries = allowlistPaths().map(literal);
  // The generated layout keeps the catalog under its own name:
  // src/modules/skills/skills-catalog/<id>/SKILL.md is emitted as
  // skills-catalog/<id>/SKILL.md, and the security-check runner is bundled as
  // scripts/security-check-runner.cjs.
  const generated = entries.filter((e) => e.startsWith('skills-catalog/') || e.startsWith('scripts/'));
  assert.ok(generated.length > 0, 'fixture guard: the working-tree half still has entries');

  for (const entry of generated) {
    const skill = /^skills-catalog\/([^/]+)\/SKILL\.md$/.exec(entry);
    const expected = skill
      ? `src/modules/skills/skills-catalog/${skill[1]}/SKILL.md`
      : 'src/runners/security-check/';
    assert.ok(entries.includes(expected),
      `${entry} names the generated tree only; its source counterpart ${expected} must be allowlisted too or the history scan cannot suppress it`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, expected)),
      `${expected} must exist — the generated entry ${entry} is emitted from it`);
  }
});

// The check above was satisfied by seven entries spelled `skills/<id>/SKILL.md`
// that the generator has never emitted — it only ever asked whether the SOURCE
// side existed, so a working-tree entry naming a path that is never written was
// invisible. gitleaks matches these unanchored, and `skills/docker-patterns/…`
// is not a substring of `skills-catalog/docker-patterns/…`, so those entries
// suppressed nothing while reading as though they did.
//
// The emitted set is taken from the generators themselves rather than from
// `dist/`: the suite must not require a build, and asking gen what it writes is
// the same question one commit earlier.
test('every generated-tree entry names a path the generator actually emits', () => {
  const emitted = new Set<string>([
    ...generatedSkillDocs(REPO_ROOT).map((doc) => doc.relPath.split(path.sep).join('/')),
    ...Object.keys(SHIMS).map((name) => `scripts/${name}`),
  ]);
  // Guards the source of truth, not the config: an emitted set that lost its
  // skills would make every assertion below vacuously easy to satisfy.
  assert.ok([...emitted].some((rel) => rel.startsWith('skills-catalog/')),
    'fixture guard: the generator still emits a skills catalog');

  const entries = allowlistPaths().map(literal);
  const generated = entries.filter((entry) => !entry.startsWith('src/'));
  assert.ok(generated.length > 0, 'fixture guard: the working-tree half still has entries');

  for (const entry of generated) {
    assert.ok(emitted.has(entry),
      `${entry} is allowlisted for the working-tree scan but nothing emits it — `
      + `an entry gitleaks can never match suppresses nothing and hides that the real path is unlisted`);
  }
});
