/**
 * The role agent docs, read by a CONFORMANT YAML parser and by the shipped
 * readers, with the two answers compared.
 *
 * WHY THIS FILE EXISTS. `src/modules/<role>/agent.md` opens with YAML frontmatter,
 * and every reader of that frontmatter in this repository is a hand-rolled line
 * scanner: `src/gen/lib/frontmatter.ts` (and its byte-for-byte duplicate in
 * `src/shared/windsurf-rules.ts`) for `description`, and
 * `src/shared/skill-filters/index.ts` for `skills`. Hand-rolled scanners do not
 * fail on input they cannot read; they read something else. Two of the seven
 * docs were live proof: their `description` values contained a colon-space
 * (`planning artifacts:`, `Pre-flight:`), which YAML reads as an implicit key
 * inside a block scalar, so a conformant parser rejected the whole block
 * (`BLOCK_AS_IMPLICIT_KEY`) and resolved `name`, `description`, `tools` AND
 * `skills` to undefined — while the shipped scanners cheerfully returned 8 and
 * 13 skills and a description. Nothing was red. The frontmatter feeds six
 * emitters, so the docs were one host-side YAML consumer away from shipping
 * agent files with no identity at all.
 *
 * The `yaml` package is the oracle: a devDependency (pinned 2.9.0), imported
 * only from `__tests__`, which `tsconfig.build.json` excludes from the hook
 * runtime — so this costs the shipped bundle nothing.
 *
 * THE COMPARISON IS THREE-VALUED, and that is not a hedge. Both shipped readers
 * can decline: `roleDeclaredSkills` returns null and `parseFrontmatter` returns
 * a null description, and callers treat both as "unresolvable" rather than as
 * an answer (`run-bootstrap-policy/materials.ts` calls a null a policy
 * COMPILATION FAILURE). So each spelling lands in one of three columns —
 *
 *   agree     the reader and the oracle resolve the same value;
 *   refuse    the reader declines and the caller is told;
 *   DISAGREE  the reader answers, confidently, something else.
 *
 * — and only the third is a defect. A committed doc must be in the first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDocument, type Document } from 'yaml';

import { parseFrontmatter, splitFrontmatter } from '../../gen/lib/frontmatter';
import { roleDeclaredSkills } from '../../shared/skill-filters';
import { renderWindsurfRuleDocs } from '../../shared/windsurf-rules';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULES = path.join(REPO_ROOT, 'src', 'modules');

/**
 * The fence rule, which is NOT what is under test.
 *
 * Every reader in the repo agrees on it — a file opening with `---` on its own
 * line, frontmatter running to the next such line — and the oracle uses the
 * same rule, because a disagreement about where the YAML STOPS would be a
 * different finding from a disagreement about what the YAML SAYS, and this file
 * is about the second. It returns null for a file with no frontmatter at all,
 * which is itself a finding for these docs.
 */
function frontmatterText(markdown: string): string | null {
  const lines = markdown.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return null;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') return lines.slice(1, index).join('\n');
  }
  return null;
}

interface RoleDoc {
  readonly role: string;
  readonly file: string;
  readonly text: string;
  readonly frontmatter: string;
  readonly document: Document.Parsed;
}

const ROLE_DOCS: readonly RoleDoc[] = fs.readdirSync(MODULES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .flatMap((role) => {
    const file = path.join(MODULES, role, 'agent.md');
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const frontmatter = frontmatterText(text);
    // Reported as a row rather than skipped: a doc that lost its fences would
    // otherwise leave this whole file certifying a smaller set every round.
    assert.ok(frontmatter !== null, `src/modules/${role}/agent.md opens with no YAML frontmatter fence`);
    return [{ role, file, text, frontmatter, document: parseDocument(frontmatter) }];
  });

test('every role agent doc is found, and there are as many as this file thinks', () => {
  // The guard on the guard. Everything below iterates this list, so a discovery
  // bug that finds nothing reports a clean sheet over an empty set — which is
  // the exact failure mode the divergence this file pins went unnoticed inside.
  assert.deepEqual(ROLE_DOCS.map((doc) => doc.role), [
    'quick-fix',
    'senior-architect',
    'senior-backend',
    'senior-frontend',
    'senior-reviewer',
    'senior-shipper',
    'senior-tester',
  ], 'a role agent doc was added or removed — update this list in the same commit');
});

test('every role agent doc parses as YAML with ZERO errors', () => {
  // THE PIN. This is the assertion that would have reddened on the commit that
  // introduced `description: Use ... planning artifacts: ...` unquoted, and it
  // names the parser's own code rather than a guess about the cause.
  const broken = ROLE_DOCS
    .filter((doc) => doc.document.errors.length > 0)
    .map((doc) => `  - src/modules/${doc.role}/agent.md: ${doc.document.errors
      .map((error) => `${error.code} at line ${error.linePos?.[0]?.line ?? '?'} — ${error.message}`)
      .join('; ')}`);
  assert.deepEqual(
    broken,
    [],
    'these role docs have frontmatter a conformant YAML parser rejects, so every key in them resolves to'
    + ' undefined for any consumer that uses one — while the repo\'s hand-rolled scanners read them anyway'
    + ` and nothing goes red:\n${broken.join('\n')}\n\nThe usual cause is a colon-space inside an unquoted`
    + ' value, which YAML reads as an implicit key. Single-quote the value (and double any apostrophe in it).',
  );
});

test('the four keys every emitter reads resolve to values, not to undefined', () => {
  // What the errors above COST, asserted separately so the failure says which
  // consumer loses what. `name`/`description`/`tools` feed the gen emitters and
  // the four host materializers; `skills` feeds the role skill directive and the
  // bootstrap policy.
  for (const doc of ROLE_DOCS) {
    const resolved = doc.document.toJS() as Record<string, unknown> | null;
    assert.ok(resolved && typeof resolved === 'object', `src/modules/${doc.role}/agent.md: frontmatter is not a map`);
    assert.equal(resolved.name, doc.role, `src/modules/${doc.role}/agent.md declares name: ${String(resolved.name)}`);
    assert.equal(typeof resolved.description, 'string', `src/modules/${doc.role}/agent.md has no readable description`);
    assert.ok((resolved.description as string).length > 0, `src/modules/${doc.role}/agent.md has an empty description`);
    assert.equal(typeof resolved.tools, 'string', `src/modules/${doc.role}/agent.md has no readable tools line`);
    assert.ok(Array.isArray(resolved.skills), `src/modules/${doc.role}/agent.md has no readable skills list`);
    const skills = resolved.skills as unknown[];
    assert.ok(skills.length > 0, `src/modules/${doc.role}/agent.md declares an empty skills list`);
    assert.ok(
      skills.every((skill) => typeof skill === 'string' && /^[a-z0-9-]+$/.test(skill)),
      `src/modules/${doc.role}/agent.md declares a skill that is not a plain identifier: ${JSON.stringify(skills)}`,
    );
  }
});

test('the shipped skills reader agrees with the oracle on every committed role doc', () => {
  // The comparison that makes this an oracle rather than a second opinion. A
  // REFUSAL here is a failure too: these are the docs that ship, and a reader
  // that cannot read them falls the caller back to a stack-wide directive (or,
  // in the bootstrap policy, to a hard compilation failure).
  for (const doc of ROLE_DOCS) {
    const oracle = new Set((doc.document.toJS() as { skills?: string[] }).skills ?? []);
    const shipped = roleDeclaredSkills(doc.role);
    assert.ok(shipped, `roleDeclaredSkills REFUSED src/modules/${doc.role}/agent.md, which is a doc that ships`);
    assert.deepEqual(
      [...shipped].sort(),
      [...oracle].sort(),
      `roleDeclaredSkills and YAML disagree about what src/modules/${doc.role}/agent.md declares — the shipped`
      + ' reader is what decides the role\'s skill scope at runtime, so a difference here is a role running with'
      + ' skills it did not declare or without ones it did',
    );
  }
});

test('the shipped description reader agrees with the oracle on every committed role doc', () => {
  // `src/gen/lib/frontmatter.ts` is the build-time half, and its duplicate in
  // `src/shared/windsurf-rules.ts` is the runtime one. Same scanner, so the
  // same divergences; pinning one pins the pair as long as they stay copies,
  // which the row below asserts.
  for (const doc of ROLE_DOCS) {
    const oracle = (doc.document.toJS() as { description?: string }).description;
    const shipped = parseFrontmatter(splitFrontmatter(doc.text).frontmatterLines).description;
    assert.equal(
      shipped,
      oracle,
      `parseFrontmatter and YAML disagree about the description of src/modules/${doc.role}/agent.md`,
    );
  }
});

// ── the reader's own grammar, driven against spellings the docs do not use ───
//
// Everything above is about the seven files as committed. This is about what
// the reader DOES with the eighth spelling somebody writes next, and it is
// where the shipped reader used to fail open and partially: its item pattern
// (`/^\s+-\s+([A-Za-z0-9_-]+)\s*$/`) matched what it understood and SILENTLY
// SKIPPED the rest, so a role listing five skills with one of them quoted got
// four and nobody was told. Measured before the change, all six of these
// spellings are legal YAML the oracle reads correctly:
//
//   spelling                       shipped reader        oracle
//   - 'qa' (quoted item)           {qa, refactor}        {qa, refactor, review}   DISAGREE
//   - qa # keep (trailing comment) {refactor}            {qa, refactor}           DISAGREE
//   - qa.core (dotted name)        {refactor}            {qa.core, refactor}      DISAGREE
//   skills: [qa, refactor]         null                  {qa, refactor}           refuse
//   "skills": (quoted key)         null                  {qa, refactor}           refuse
//   CRLF fences (---\r\n)          null                  {qa, refactor}           refuse
//
// THE DECISION, and it is a decision rather than a completion. The three
// DISAGREE rows are now refusals: a line inside the block that the reader
// cannot read makes the whole answer null. The alternative — teaching the
// pattern about quotes, then comments, then dotted names, then flow sequences —
// is writing a YAML parser one adversarial spelling at a time in dependency-free
// shipped code, which is the widening-guard shape this repo keeps being defeated
// by, and every widening leaves a NEW silent-drop case for the spelling nobody
// thought of. Refusal has a meaning the callers already implement, and it is the
// same meaning for every unreadable spelling: `materials.ts` treats null as a
// policy compilation failure, and `roleSkillsDirective` falls back to the
// stack-wide directive, which is over-broad rather than silently narrow.
//
// The three refuse rows stay refusals and are pinned here rather than fixed.
// CRLF is the one worth a reason: `.gitattributes` sets `* text=auto eol=lf`,
// so a checkout on any OS — including the marketplace clone an install comes
// from — writes LF, and the CRLF path is not reachable through the shipping
// route. A hand-edited CRLF doc inside an installed plugin refuses, which is the
// direction a wrong answer should fall.
const CORPUS_ROLE = 'senior-frontend';

interface Spelling {
  readonly name: string;
  readonly frontmatter: string;
  readonly expect: 'agree' | 'refuse';
  /** Write the WHOLE document with CRLF endings, fences included. */
  readonly crlf?: true;
}

const SPELLINGS: readonly Spelling[] = [
  {
    name: 'the shape every committed doc uses',
    frontmatter: 'name: r\nskills:\n  - qa\n  - refactor\n',
    expect: 'agree',
  },
  {
    name: 'a key after the list, which must end it rather than swallow the rest of the file',
    frontmatter: 'name: r\nskills:\n  - qa\n  - refactor\ntools: Read, Grep\n',
    expect: 'agree',
  },
  {
    name: 'a blank line inside the list',
    frontmatter: 'name: r\nskills:\n  - qa\n\n  - refactor\n',
    expect: 'agree',
  },
  {
    name: 'one item quoted — the drop that started this',
    frontmatter: "name: r\nskills:\n  - qa\n  - 'review'\n  - refactor\n",
    expect: 'refuse',
  },
  {
    name: 'a trailing comment on an item',
    frontmatter: 'name: r\nskills:\n  - qa # keep this one\n  - refactor\n',
    expect: 'refuse',
  },
  {
    name: 'a dotted skill name',
    frontmatter: 'name: r\nskills:\n  - qa.core\n  - refactor\n',
    expect: 'refuse',
  },
  {
    name: 'the list written as a flow sequence',
    frontmatter: 'name: r\nskills: [qa, refactor]\n',
    expect: 'refuse',
  },
  {
    name: 'the key itself quoted',
    frontmatter: 'name: r\n"skills":\n  - qa\n  - refactor\n',
    expect: 'refuse',
  },
  {
    // The whole file, fences included — which is the only way this arrives.
    // A HALF-CRLF file (CRLF inside LF fences) is read correctly, because `\r`
    // is whitespace to every pattern in the scanner and the fence regex still
    // finds its `\n---`; it is the `---\r\n` fence that the outer match refuses.
    // Measured both ways here, which is a correction to the divergence table
    // this corpus came from: the reader is narrower than "CRLF refuses".
    name: 'CRLF line endings, fences included',
    frontmatter: 'name: r\nskills:\n  - qa\n  - refactor\n',
    expect: 'refuse',
    crlf: true,
  },
  {
    name: 'CRLF inside LF fences, which an ordinary editor produces',
    frontmatter: 'name: r\r\nskills:\r\n  - qa\r\n  - refactor\r\n',
    expect: 'agree',
  },
];

/** A plugin root holding one role doc, for the duration of `fn`. */
function withRoleDoc(spelling: Spelling, fn: () => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-agent-frontmatter-oracle-'));
  const dir = path.join(root, 'src', 'modules', CORPUS_ROLE);
  fs.mkdirSync(dir, { recursive: true });
  const document = `---\n${spelling.frontmatter}---\n\nBody.\n`;
  fs.writeFileSync(path.join(dir, 'agent.md'), spelling.crlf ? document.replace(/\n/g, '\r\n') : document, 'utf8');
  const previous = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = root;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('no spelling of a skills list makes the shipped reader answer something the oracle does not', () => {
  const outcomes: string[] = [];
  for (const spelling of SPELLINGS) {
    // The oracle first, so a corpus row whose YAML is itself broken is reported
    // as a broken row rather than as a divergence.
    const document = parseDocument(spelling.frontmatter);
    assert.deepEqual(
      document.errors.map((error) => error.code),
      [],
      `corpus row "${spelling.name}" is not the legal YAML it claims to be`,
    );
    const oracle = new Set((document.toJS() as { skills?: string[] }).skills ?? []);
    assert.ok(oracle.size > 0, `corpus row "${spelling.name}" declares no skills, so it compares nothing`);

    withRoleDoc(spelling, () => {
      const shipped = roleDeclaredSkills(CORPUS_ROLE);
      const verdict = shipped === null
        ? 'refuse'
        : (JSON.stringify([...shipped].sort()) === JSON.stringify([...oracle].sort()) ? 'agree' : 'DISAGREE');
      outcomes.push(`${verdict} · ${spelling.name}${
        verdict === 'DISAGREE' ? ` · read ${JSON.stringify([...shipped!].sort())} for ${JSON.stringify([...oracle].sort())}` : ''
      }`);
      assert.equal(
        verdict,
        spelling.expect,
        `"${spelling.name}": the shipped reader ${verdict === 'DISAGREE'
          ? 'answered something the oracle does not — it read ' + JSON.stringify([...shipped!].sort())
            + ' where the oracle reads ' + JSON.stringify([...oracle].sort())
            + ', which is a role silently running with the wrong skill scope'
          : `is now ${verdict} where this file expects ${spelling.expect}`}`,
      );
    });
  }
  // NON-VACUITY. A corpus that refuses everything proves the reader is broken,
  // not that it is safe, and one that agrees with everything is not adversarial.
  assert.ok(outcomes.filter((row) => row.startsWith('agree')).length >= 4, outcomes.join('\n'));
  assert.ok(outcomes.filter((row) => row.startsWith('refuse')).length >= 5, outcomes.join('\n'));
  assert.equal(outcomes.filter((row) => row.startsWith('DISAGREE')).length, 0, outcomes.join('\n'));
});

test('the RUNTIME copy of the scanner emits the description the oracle reads', () => {
  // `src/shared/windsurf-rules.ts` carries a private, byte-for-byte duplicate of
  // `splitFrontmatter`/`parseFrontmatter`, because the hook runtime may not
  // import from `src/gen/**`. The row above drives the gen copy; this drives the
  // duplicate, through the only entry point that exposes it, so the pin covers
  // both paths instead of one and a copy edited alone is named here.
  //
  // Driven rather than compared as source text. A `duplicate.includes('function
  // parseFrontmatter(')` check is satisfied with the function's BODY deleted,
  // which is the construction this repo denounces elsewhere; this one fails if
  // the duplicate starts reading a different description, whatever it looks
  // like. The emitted frontmatter is read back with the ORACLE, so a doc this
  // repo generates that a YAML consumer cannot parse is also a red.
  for (const doc of ROLE_DOCS) {
    const oracle = (doc.document.toJS() as { description?: string }).description ?? '';
    const rendered = renderWindsurfRuleDocs(`agents/${doc.role}.md`, doc.text);
    assert.ok(rendered.length > 0, `renderWindsurfRuleDocs emitted nothing for ${doc.role}`);
    const emitted = parseDocument(frontmatterText(rendered[0]!.content) ?? '');
    assert.deepEqual(
      emitted.errors.map((error) => error.code),
      [],
      `the Windsurf rule generated from src/modules/${doc.role}/agent.md has frontmatter YAML cannot read`,
    );
    const description = (emitted.toJS() as { description?: string }).description ?? '';
    assert.ok(
      description.endsWith(oracle),
      `the Windsurf rule generated from src/modules/${doc.role}/agent.md carries a description the oracle does`
      + ` not read from the source:\n  emitted: ${JSON.stringify(description.slice(-120))}\n  oracle:  `
      + JSON.stringify(oracle.slice(-120)),
    );
  }
});
