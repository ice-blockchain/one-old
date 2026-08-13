// src/shared/__tests__/skill-fallback-drift.test.ts
// The generated fallback table (shared/skill-fallbacks.generated.ts) is the
// SECOND copy of every deny paragraph that ships. This file is the assertion
// that it is a COPY and not a fork.
//
// Staleness here is invisible at runtime, which is the whole reason this exists:
// shared/skill-block.ts prefers the live T1BLOCK and only reaches the table when
// SKILL.md cannot be read, so a table that has drifted looks perfect on every
// healthy install and renders last month's wording on the one broken install
// that needs it most. Nothing observes that. So the check has to be static, and
// it has to run: it is here, and it is `npm run plugin:check` (which runs
// `tsx src/build/gen-skill-fallbacks.ts --check`, the same comparison from the
// same code).
//
// The other half of "every deny id has exactly one prose source" — that every
// id a CALL SITE renders resolves to prose at all — is asserted in
// skill-block-coverage.test.ts, which owns the parsed census of call sites. It
// is not re-implemented here; a second, weaker scanner is the failure mode that
// file's own header was written about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectFallbacks, main, readCommitted, renderModule, shrinkages,
} from '../../build/gen-skill-fallbacks';
import { extractBlock, listBlockNames } from '../skill-markers';
import { SKILL_FALLBACKS } from '../skill-fallbacks.generated';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GENERATED = path.join(REPO_ROOT, 'src', 'shared', 'skill-fallbacks.generated.ts');
const MODULES = path.join(REPO_ROOT, 'src', 'modules');

// ── the drift check itself ───────────────────────────────────────────────────

test('the committed fallback module is byte-identical to a fresh generation', () => {
  assert.equal(
    fs.readFileSync(GENERATED, 'utf8'),
    renderModule(collectFallbacks(REPO_ROOT)),
    'shared/skill-fallbacks.generated.ts is stale: a T1BLOCK moved and the generated fallback did not, so a torn '
    + 'install renders the OLD wording of that gate. Run `npx tsx src/build/gen-skill-fallbacks.ts`.',
  );
});

test('every T1BLOCK that ships has an entry, and every entry is a block that ships', () => {
  const declared = new Map<string, string>();
  for (const entry of fs.readdirSync(MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = path.join(MODULES, entry.name, 'skill', 'SKILL.md');
    if (!fs.existsSync(skill)) continue;
    const text = fs.readFileSync(skill, 'utf8');
    for (const name of listBlockNames(text)) declared.set(`${entry.name} :: ${name}`, extractBlock(text, name)!);
  }

  // A floor, so a walk that finds nothing cannot pass this file vacuously.
  assert.ok(declared.size >= 140, `expected 140+ shipped T1BLOCKs, walked ${declared.size} — the module walk broke`);

  const missing = [...declared.keys()].filter((key) => !Object.hasOwn(SKILL_FALLBACKS, key)).sort();
  assert.deepEqual(
    missing, [],
    `${missing.length} shipped block(s) have no generated fallback, so they render EMPTY on a torn install:\n  `
    + missing.join('\n  '),
  );

  const orphaned = Object.keys(SKILL_FALLBACKS).filter((key) => !declared.has(key)).sort();
  assert.deepEqual(
    orphaned, [],
    `${orphaned.length} generated entr(ies) name a block that no SKILL.md declares. That is prose with no reviewable `
    + `source — regenerate:\n  ${orphaned.join('\n  ')}`,
  );

  const diverged = [...declared.entries()]
    .filter(([key, body]) => SKILL_FALLBACKS[key] !== body)
    .map(([key]) => key).sort();
  assert.deepEqual(diverged, [], `${diverged.length} entr(ies) differ from their block byte for byte:\n  ${diverged.join('\n  ')}`);
});

// ── fail-closed, proved rather than asserted ─────────────────────────────────
// Every check above is an equality that a green tree satisfies trivially. These
// drive the same functions over inputs that MUST be rejected, because a check
// that cannot fail is decoration.

test('a one-character edit to a block is detected', () => {
  const table = collectFallbacks(REPO_ROOT);
  const key = Object.keys(table).sort()[0]!;
  const mutated = { ...table, [key]: `${table[key]!} ` };
  assert.notEqual(
    renderModule(mutated), renderModule(table),
    'a trailing space in one block must move the generated module, or the comparison is normalising drift away',
  );
});

test('the committed module is PARSED back, so the shrink gate is never comparing against nothing', () => {
  // If readCommitted silently returned {} — a renderer whose line shape the
  // regex stopped matching, say — every shrink would compare against an empty
  // table, find no shared keys, and pass. The gate would be off with no symptom.
  const parsed = readCommitted(REPO_ROOT);
  assert.ok(parsed, 'the committed module did not parse at all');
  assert.deepEqual(
    Object.keys(parsed!).sort(), Object.keys(SKILL_FALLBACKS).sort(),
    'the shrink gate reads the committed table by parsing it; if that parse loses keys it silently stops guarding them',
  );
  for (const [key, value] of Object.entries(parsed!)) {
    assert.equal(value, SKILL_FALLBACKS[key], `${key} parsed back to different bytes than the module exports`);
  }
});

test('a fallback that gets SHORTER is refused, and one that grows is not', () => {
  const table = collectFallbacks(REPO_ROOT);
  const key = Object.keys(table).sort()[0]!;

  const shorter = { ...table, [key]: table[key]!.slice(0, -20) };
  assert.deepEqual(
    shrinkages(table, shorter).map((s) => s.key), [key],
    'losing 20 characters of remedy text must be reported — a parity test cannot see it, because both copies moved',
  );

  const removed = { ...table };
  delete removed[key];
  assert.deepEqual(shrinkages(table, removed).map((s) => s.key), [key], 'a block that disappears is the same loss');

  const longer = { ...table, [key]: `${table[key]!} And another sentence of remedy.` };
  assert.deepEqual(shrinkages(table, longer), [], 'growth is not a loss and must not need a flag');
});

// ── the EXIT CODES plugin:check depends on ───────────────────────────────────
// Everything above tests the functions. `npm run plugin:check` tests the
// PROCESS, and a check that reports drift on stderr while returning 0 is a
// check CI ignores. Driven over a synthetic tree with its own SKILL.md, so the
// failure paths can actually be entered without touching a tracked file.

const withSyntheticRoot = (files: Record<string, string>, run: (root: string) => void): void => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-fallback-cli-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, 'utf8');
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const skill = (name: string, body: string): string =>
  `# fixture\n\n<!-- T1BLOCK:BEGIN ${name} -->\n${body}\n<!-- T1BLOCK:END ${name} -->\n`;

test('the CLI exits non-zero on a stale table, and zero once it is regenerated', () => {
  withSyntheticRoot({
    'src/modules/fx/skill/SKILL.md': skill('a', 'The original remedy, at length.'),
  }, (root) => {
    const silent = { repoRoot: root, out: () => {}, err: () => {} };

    assert.equal(main(['--check'], silent), 1, 'no generated module at all is drift, not a pass');
    assert.equal(main([], silent), 0, 'emitting must succeed');
    assert.equal(main(['--check'], silent), 0, 'and the freshly emitted module must satisfy the check');

    // A block edited without regenerating: exactly the state that renders last
    // month's wording on a torn install and looks perfect everywhere else.
    fs.writeFileSync(
      path.join(root, 'src/modules/fx/skill/SKILL.md'),
      skill('a', 'The original remedy, at length, plus a clarifying clause.'),
      'utf8',
    );
    assert.equal(main(['--check'], silent), 1, 'a T1BLOCK edit with no regeneration MUST fail the check');
    assert.equal(main([], silent), 0, 'growth needs no flag');
    assert.equal(main(['--check'], silent), 0);

    // …and the shrink direction, which the check alone cannot see because
    // regenerating makes both copies agree on the shorter text.
    fs.writeFileSync(path.join(root, 'src/modules/fx/skill/SKILL.md'), skill('a', 'Short.'), 'utf8');
    assert.equal(main([], silent), 1, 'a shrink must be refused rather than written');
    assert.equal(main(['--check'], silent), 1, 'and refusing to write leaves the table stale, which still fails');
    assert.equal(main(['--allow-shrink'], silent), 0, 'the flag is the deliberate, reviewable way through');
    assert.equal(main(['--check'], silent), 0);
  });
});
