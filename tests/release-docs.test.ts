// The release apparatus ↔ code, mechanically.
//
// Same premise as readme-claims.test.ts, applied to the documents that shipped
// alongside it: LICENSE, THIRD-PARTY-NOTICES.md, PRIVACY.md, PLATFORMS.md,
// KNOWN-ISSUES.md, SUPPORT.md and CHANGELOG.md all make claims a reader is
// expected to ACT on — a licence identifier, a host tier list, a Node floor, an
// env var to unset something, a path to look in, a command to run when stuck.
//
// Prose cannot be pinned and is not pinned here. What is pinned is every claim
// with a single source of truth in the tree, so a rename, a retier or a deleted
// env var takes a test with it rather than leaving a document quietly lying.
//
// Two claims are deliberately NOT here, and their absence is the honest kind:
// the licences of third-party tools (upstream facts this repository can only
// transcribe from toolchain-versions.json, which IS pinned below), and anything
// about what traffic.io's servers do with a request after it arrives.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shimSource } from '../src/shared/runner-shims';

import { HOST_CAPABILITIES, type TrafficOneHost } from '../src/shared/host/capability-schema';
import { UNCERTIFIED_HOST_OPT_OUT_ENV } from '../src/shared/host/tiers';
import { NODE_FLOOR_MAJOR } from '../src/shared/node-floor';
import { isTrafficOneDoctorCommand, isTrafficOneResetCommand } from '../src/shared/tool-classify';
import { AUTH_OFFLINE_GRACE_MS, AUTH_REVALIDATION_CADENCE_MS } from '../src/config/auth';
import { GOLDEN_EXCLUDED } from '../src/build/golden-update';
import { runtimeAsset } from '../src/config/managed-runtimes';
import { HOST_COMMANDS } from '../src/test-environment/config/hosts';

const REPO_ROOT = path.resolve(__dirname, '..');

/** Documents that travel inside an installed bundle. */
const DOCS = [
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'PRIVACY.md',
  'PLATFORMS.md',
  'KNOWN-ISSUES.md',
  'SUPPORT.md',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Whitespace-normalized, so a paragraph reflow never fails a claim. */
function flat(rel: string): string {
  return read(rel).replace(/\s+/g, ' ');
}

/**
 * One numbered KNOWN-ISSUES entry, whitespace-normalized.
 *
 * Scoping is not tidiness. The document names most of the seven hosts SOMEWHERE
 * — item 2 alone names all of them — so an unscoped `includes` lets one entry
 * borrow another's correctness, which is exactly how a half-corrected licence
 * passed the notice check that the third-party test at the bottom of this file
 * was rewritten to close. It also fails loudly on a renumber, which matters:
 * the messages below name entries by number.
 */
function issue(n: number): string {
  const text = read('KNOWN-ISSUES.md');
  const start = text.indexOf(`\n## ${n}. `);
  assert.notEqual(start, -1, `KNOWN-ISSUES.md has no item ${n} — the entries were renumbered or one was removed`);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
}

// ── the bundle actually carries them ─────────────────────────────────────────

// The failure this exists for is silent by construction: a document can be
// perfect in the repository and absent from every install, and the only place
// that decides which is a list in one file. `npm run gen` would throw on a
// listed-but-missing file; nothing but this catches missing-but-needed.
test('every release document exists and is copied into the installed bundle', () => {
  const emitter = read(path.join('src', 'gen', 'emit', 'static.ts'));
  const listed = new Set(
    [...emitter.matchAll(/^\s{2}'([^']+)',$/gm)].map((match) => match[1] as string),
  );
  assert.ok(listed.has('README.md'), 'could not parse STATIC_TEXT_FILES out of gen/emit/static.ts');
  for (const doc of DOCS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, doc)), `${doc} does not exist at the repository root`);
    assert.ok(listed.has(doc), `${doc} is not in STATIC_TEXT_FILES, so no install ever receives it`);
    // This test IS the disappearance check for these documents. They are
    // deliberately out of the golden snapshot (verbatim copies of tracked
    // files, and CHANGELOG.md changes on every commit), so if the exclusion
    // ever went away the snapshot would start churning — and if THIS went away
    // with it, nothing would notice a document that stopped shipping.
    assert.ok(
      GOLDEN_EXCLUDED.has(doc),
      `${doc} is in the golden snapshot as well as here — one of the two instruments is now redundant churn`,
    );
  }
});

// The inverse, pinned because it looks like an omission and is a ruling.
//
// A changelog is a record of the PAST, and a past is quoted in the vocabulary
// it was written in: this repository's own history contains a commit subject
// naming `fork_context`, a host API that no longer exists. src/gen/__tests__/
// gen.test.ts scans every emitted `.md` for exactly such identifiers, on the
// sound principle that agent-readable prose in the plugin root must not name a
// dead API — so shipping the changelog puts a permanent, unfixable failure in
// the generator's own test, one that grows a new instance every time history
// mentions something that later gets removed.
test('CHANGELOG.md is generated and committed, and deliberately does not ship', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'CHANGELOG.md')), 'CHANGELOG.md was not generated');
  const emitter = read(path.join('src', 'gen', 'emit', 'static.ts'));
  const listed = new Set([...emitter.matchAll(/^\s{2}'([^']+)',$/gm)].map((match) => match[1] as string));
  assert.equal(listed.has('CHANGELOG.md'), false, 'CHANGELOG.md must not be in STATIC_TEXT_FILES');
  assert.match(emitter, /CHANGELOG\.md is deliberately ABSENT/, 'the ruling lost its explanation');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  for (const script of ['changelog', 'changelog:check']) {
    assert.ok(pkg.scripts[script], `package.json no longer defines the ${script} script`);
  }
});

// ── licence identity ─────────────────────────────────────────────────────────

test('the licence is MIT in the file, in package.json, and in the bundle package.json', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License$/m, 'LICENSE is no longer the MIT text');
  assert.match(license, /^Copyright \(c\) \d{4} .+$/m, 'LICENSE has no copyright line');
  // The MIT grant's two operative paragraphs, so a truncated or reworded file
  // cannot pass as "starts with MIT License".
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);

  const pkg = JSON.parse(read('package.json')) as { license?: string; private?: boolean };
  assert.equal(pkg.license, 'MIT');
  // Not an oversight, and the emitter says why at length. Pinned so a later
  // reader who finds it inconsistent has to argue with a test.
  assert.equal(pkg.private, true, 'distribution is via host plugin marketplaces; nothing runs npm publish');

  const emitter = read(path.join('src', 'gen', 'emit', 'static.ts'));
  assert.match(emitter, /license: 'MIT'/, 'the generated bundle package.json no longer declares MIT');
  assert.match(emitter, /private: true/, 'the generated bundle package.json no longer declares private');
});

// ── platform statement ───────────────────────────────────────────────────────

test('PLATFORMS.md tiers every host exactly as HOST_CAPABILITIES does', () => {
  const text = read('PLATFORMS.md');
  // One markdown row per host: | Label (`id`) | tier | certification | … |
  const rows = new Map<string, { tier: string; certification: string }>();
  for (const match of text.matchAll(/^\|[^|]*\(`([a-z]+)`\)\s*\|\s*([\w-]+)\s*\|\s*`([^`]+)`\s*\|/gm)) {
    rows.set(match[1] as string, { tier: match[2] as string, certification: match[3] as string });
  }
  const hosts = Object.keys(HOST_CAPABILITIES) as TrafficOneHost[];
  assert.deepEqual([...rows.keys()].sort(), [...hosts].sort(), 'PLATFORMS.md host table is not the host table');
  for (const host of hosts) {
    const row = rows.get(host)!;
    assert.equal(row.tier, HOST_CAPABILITIES[host].tier, `PLATFORMS.md tiers ${host} wrong`);
    assert.equal(row.certification, HOST_CAPABILITIES[host].certification, `PLATFORMS.md certifies ${host} wrong`);
  }
  // The host COUNT in prose, which drifts independently of the table.
  const stated = /supports \*\*(\w+) hosts\*\*/.exec(text)?.[1];
  const words: Record<string, number> = { six: 6, seven: 7, eight: 8, nine: 9 };
  assert.equal(words[String(stated)], hosts.length, `PLATFORMS.md says "${stated} hosts"`);
});

test('PLATFORMS.md states the declared Node floor, not a remembered one', () => {
  const text = flat('PLATFORMS.md');
  assert.ok(text.includes(`**Node ${NODE_FLOOR_MAJOR} or newer.**`), 'the stated floor is not NODE_FLOOR_MAJOR');
  const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
  assert.equal(engines.match(/(\d+)/)?.[1], String(NODE_FLOOR_MAJOR), 'engines and NODE_FLOOR_MAJOR disagree');
  // The behaviour, not just the number: warning rather than refusing is the
  // whole reason the floor is safe to state as a hard number.
  assert.ok(text.includes('warns and continues'), 'PLATFORMS.md no longer states the below-floor behaviour');
});

test('the headless-subagent claim is true of every configured host', () => {
  const hosts = read(path.join('src', 'test-environment', 'config', 'hosts.ts'));
  const values = [...hosts.matchAll(/headlessSubagents:\s*'([\w-]+)'/g)].map((match) => match[1] as string);
  assert.ok(values.length > 0, 'no headlessSubagents rows found — did the harness config move?');
  const claimed = new Set(values);
  assert.deepEqual(
    [...claimed],
    ['unsupported'],
    'a host now supports headless subagents — PLATFORMS.md and KNOWN-ISSUES.md both say none does',
  );
  // The half a value scan cannot see, and the half item 3 used to get wrong by
  // saying "EVERY host row carries `headlessSubagents: 'unsupported'`": the
  // field is OPTIONAL, and two rows omit it entirely. Silence is only honest
  // while those rows are also undrivable — a row that gains a runnable harness
  // config while staying silent about subagents would leave the entry claiming
  // a proof nobody took.
  for (const [host, config] of Object.entries(HOST_COMMANDS)) {
    assert.ok(
      config.headlessSubagents === 'unsupported' || config.e2eSupported === false,
      `harness host ${host} declares no headlessSubagents support and is not e2eSupported:false — `
      + 'KNOWN-ISSUES.md item 3 says every drivable row is `unsupported` and the rest are undrivable',
    );
  }
  assert.ok(flat('PLATFORMS.md').includes('No configured host supports headless subagents'));
  assert.ok(issue(3).includes('Subagent round-trips are not certified on any host'));
  for (const [host, config] of Object.entries(HOST_COMMANDS)) {
    if (config.headlessSubagents !== undefined) continue;
    assert.ok(
      issue(3).includes(`\`${host}\``),
      `item 3 names the silent harness rows explicitly; \`${host}\` is now one of them and is not named`,
    );
  }
});

// Item 4's first half is a comparison across the capability table, and a
// comparison is the shape most likely to rot: it was written when Kilo really
// was alone, and by the time this pin was added `codex`, `copilot` and
// `windsurf` had joined it while the sentence still said "the only host".
// Derived as the full partition, so neither side can drift unnoticed.
test('the typed-subagent split KNOWN-ISSUES.md draws is the split the capability table declares', () => {
  const hosts = Object.keys(HOST_CAPABILITIES) as TrafficOneHost[];
  const without = hosts.filter((host) => !HOST_CAPABILITIES[host].typedSubagents).sort();
  const with_ = hosts.filter((host) => HOST_CAPABILITIES[host].typedSubagents).sort();
  assert.ok(without.length > 0 && with_.length > 0, 'the typed-subagent column is uniform — item 4 draws a split that no longer exists');
  const text = issue(4);
  // Both lists are READ OUT of the entry and compared as sets, rather than each
  // host merely being findable somewhere in the paragraph: the two lists sit in
  // one sentence, so a membership-only check would pass for an entry that put
  // every host on both sides.
  const names = (list: string | undefined): string[] =>
    [...(list ?? '').matchAll(/`([a-z]+)`/g)].map((match) => match[1] as string).sort();
  const statedFalse = names(/((?:`[a-z]+`[,\s]*(?:and\s+)?)+)all have it false/.exec(text)?.[1]);
  const statedTrue = names(/only ((?:`[a-z]+`[,\s]*(?:and\s+)?)+)have it true/.exec(text)?.[1]);
  assert.ok(
    statedFalse.length > 0 && statedTrue.length > 0,
    'item 4 no longer states the typed-subagent split as "<hosts> all have it false … only <hosts> have it true", '
    + 'which is the shape this pin reads it in',
  );
  assert.deepEqual(statedFalse, without, 'item 4 names the wrong hosts as lacking typed subagents');
  assert.deepEqual(statedTrue, with_, 'item 4 names the wrong hosts as having typed subagents');
});

// ── known issues ─────────────────────────────────────────────────────────────

// Item 1 quotes a code and a message a reader will paste into a search box, and
// quotes them as a fenced block — the format that says "this is what you will
// see". Both are single-sourced in the profile assembler.
test('the hybrid-UI refusal KNOWN-ISSUES.md quotes is the one the profiler emits', () => {
  const profile = read(path.join('src', 'shared', 'capabilities', 'profile.ts'));
  const emitted = /code: '(CAPABILITY_[A-Z_]+)' as const,\s*\n\s*message: '([^']+)',/.exec(profile);
  assert.ok(emitted, 'the hybrid blocking issue is gone or reshaped in capabilities/profile.ts');
  const text = issue(1);
  assert.ok(text.includes(emitted![1] as string), `item 1 quotes a blocking-issue code the profiler no longer emits (it emits ${emitted![1]})`);
  assert.ok(
    text.includes(emitted![2] as string),
    `item 1 quotes a message the profiler no longer emits.\n  emitted: ${emitted![2]}`,
  );
});

test('the hosts KNOWN-ISSUES.md names as lacking spawn reuse are the hosts the code names', () => {
  const registry = read(path.join('src', 'shared', 'state', 'run-agent', 'registry.ts'));
  const listed = /HOSTS_WITHOUT_VERIFIABLE_REUSE[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(registry)?.[1];
  assert.ok(listed, 'HOSTS_WITHOUT_VERIFIABLE_REUSE is gone or reshaped');
  const hosts = [...listed!.matchAll(/'([a-z]+)'/g)].map((match) => match[1] as string).sort();
  assert.deepEqual(hosts, ['kilo', 'opencode', 'windsurf'], 'the reuse-registry stand-down set changed');
  const text = flat('KNOWN-ISSUES.md');
  assert.ok(
    text.includes('`[\'opencode\', \'kilo\', \'windsurf\']`') || text.includes("['opencode', 'kilo', 'windsurf']"),
    'KNOWN-ISSUES.md no longer quotes the set it claims to be quoting',
  );
});

// Item 10 names five filenames as the whole matched set and tells the reader
// that anything else, or the same name below the root, is untouched. Both
// halves are one constant away from being false, and the failure is silent in
// the direction that matters: a sixth name added here adopts a file the
// document promised to leave alone.
test('the root documents KNOWN-ISSUES.md says are adopted are the ones the code adopts', () => {
  const cleanup = read(path.join('src', 'shared', 'materialize', 'cleanup.ts'));
  const listed = /LEGACY_ROOT_DOCUMENTATION_FILES[^=]*=\s*\[([^\]]*)\]/.exec(cleanup)?.[1];
  assert.ok(listed, 'LEGACY_ROOT_DOCUMENTATION_FILES is gone or reshaped');
  const names = [...listed!.matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
  assert.deepEqual(
    names,
    ['api.md', 'database.md', 'deployment.md', 'environment-setup.md', 'security.md'],
    'the legacy root-document set changed — KNOWN-ISSUES.md item 10 names it exhaustively',
  );
  const text = issue(10);
  for (const name of names) {
    assert.ok(text.includes(`\`${name}\``), `KNOWN-ISSUES.md item 10 does not name \`${name}\``);
  }
  // The other half of the promise: a COPY. If this ever moves the file again,
  // "not moved, renamed or deleted" becomes the most damaging sentence in the
  // document — it is the reason a reader leaves their own api.md at the root.
  const adopt = /function adoptLegacyRootDocumentationFile\b[\s\S]*?\n\}/.exec(cleanup)?.[0];
  assert.ok(adopt, 'adoptLegacyRootDocumentationFile is gone or reshaped');
  for (const destructive of ['movePath', 'removePath', 'rmSync', 'renameSync', 'unlinkSync']) {
    assert.ok(
      !adopt!.includes(destructive),
      `root-document adoption calls ${destructive} — KNOWN-ISSUES.md item 10 promises the root file is left in place`,
    );
  }
  assert.ok(adopt!.includes('writeTextFile'), 'the adoption no longer writes the copy item 10 promises');
  // The entry's SECOND mechanism, and the one that can actually remove the root
  // file: the skill telling the agent to consolidate it. The entry tells the
  // reader to expect that in the transcript and that they may decline it, so
  // the instruction leaving would make the warning describe nothing.
  const skill = read(path.join(
    'src', 'modules', 'skills', 'skills-catalog', 'auto-documentation-generator', 'SKILL.md',
  )).replace(/\s+/g, ' ');
  const legacyClause = /Treat root ((?:`[^`]+`[,\s]*(?:and\s+)?)+)as legacy\. Move their content into `\.traffic-one\/`/.exec(skill);
  assert.ok(
    legacyClause,
    'the auto-documentation-generator skill no longer instructs the agent to treat the root documents as legacy — '
    + 'KNOWN-ISSUES.md item 10 describes that instruction as the second, agent-visible way the root file can move',
  );
  assert.deepEqual(
    [...(legacyClause![1] as string).matchAll(/`([^`]+)`/g)].map((match) => match[1] as string).sort(),
    names,
    'the skill and the adoption routine name different legacy documents — item 10 presents them as one set of five',
  );
});

// Item 11 tells the reader that an incomplete installation preserves everything
// and that the refusal they see names the real cause. The first half is the
// refusal; the second is the branch that renders it. Either one leaving turns
// the entry from a warning into a false reassurance.
test('the incomplete-installation claim tracks the refusal and the branch that reports it', () => {
  const materialize = read(path.join('src', 'shared', 'materialize', 'materialize.ts'));
  assert.match(materialize, /function tornRootRefusal/, 'the completeness refusal is gone');
  assert.match(
    materialize,
    /skipped: 'plugin-root-content-incomplete'/,
    'the completeness refusal no longer reports itself, so nothing preserves the project',
  );
  // The property the entry now rests on, and the one that was WRONG until this
  // change: a non-converged outcome must not be refused with the repair
  // paragraph. That paragraph asserts the project is current and tells the
  // agent to rerun — false and unachievable for every status here, and it is
  // what item 11 used to have to warn the reader about. Asserted on the
  // STRUCTURE of the branch rather than on the deny text, because the deny text
  // is resolved from SKILL.md and interpolates the diagnosis, so it is never a
  // stable key.
  const handler = read(path.join('src', 'modules', 'onboarding-gate', 'handler.ts'));
  // The branch is status-then-mutating, not a single `if (isMutatingPreToolUse)`.
  // Converged (`materialized` / `current`) falls through; anything else denies a
  // file-changing tool with the diagnosis and allows reads/spawns via context().
  assert.ok(
    /const converged = materialized\.status === 'materialized' \|\| materialized\.status === 'current';/.test(handler),
    'the mutating arm of the convergence branch is gone or reshaped — item 12 describes what a file-changing call sees',
  );
  assert.match(
    handler,
    /materialized\.status === 'materialized' \|\| materialized\.status === 'current'/,
    'the mutating arm stopped discriminating on STATUS. Every non-null outcome would render the repair paragraph again — '
    + '"state was repaired, rerun the same tool now" — for five statuses where nothing was repaired and rerunning cannot '
    + 'work, which is the defect KNOWN-ISSUES.md item 11 was rewritten to stop describing.',
  );
  assert.match(
    handler,
    /block\('materialization-not-converged'[\s\S]*?\{ DIAGNOSIS: materialized\.context \}/,
    'the non-converged arm no longer carries `materialized.context`, so the refusal has lost the diagnosis item 11 '
    + 'promises the reader — the missing entries, the counts, and the doctor command',
  );
  // File-changing tools still deny when convergence did not finish. Reads and
  // spawns take context(); converged statuses fall through with no deny.
  const nonConverged = /if \(!converged\) \{([\s\S]*?)\n {4}\}/.exec(handler)?.[1] ?? '';
  assert.equal(
    (nonConverged.match(/\bdeny\(/g) ?? []).length, 1,
    'the non-converged mutating arm no longer denies a file-changing tool. Proceeding is what deletes content the '
    + 'plugin root cannot resupply, so the fix was to the REASON, never to the verdict.',
  );
  assert.ok(issue(11).includes('An incomplete plugin installation refuses every file change'));
});

test('Rust is exercised by run-sim and is no longer a known-issue', () => {
  const casesDir = path.join(REPO_ROOT, 'src', 'test-environment', 'config', 'cases');
  const corpus = fs.readdirSync(casesDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(casesDir, name), 'utf8'))
    .join('\n');
  for (const declaration of ["backend: 'go'", "backend: 'python'", "backend: 'rust'"]) {
    assert.ok(corpus.includes(declaration), `no harness case declares ${declaration}`);
  }
  const known = read('KNOWN-ISSUES.md');
  assert.equal(
    known.includes('\n## 5. '),
    false,
    'KNOWN-ISSUES.md item 5 must stay deleted — Rust is driven by sim-new-rust-api',
  );
  assert.equal(
    /Rust projects are not exercised/i.test(known),
    false,
    'KNOWN-ISSUES.md still claims Rust is unexercised',
  );
});

// Item 6 carries the two claim shapes this document decays through fastest: a
// COUNT (a measurement with a date, restated as a fact) and a platform matrix
// transcribed from a comment rather than from the table the comment describes.
// It arrived here stating 27 files — the number of files that MENTION win32,
// not the number that branch on it — and stating that the runtime downloader
// publishes nothing for Windows, which the asset tables have not been true of
// for some time.
test('the Windows claims are the measurement, the CI matrix and the asset table', () => {
  const branching: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      // Non-test .ts only, and the same `(?:===|!==) 'win32'` pattern
      // tests/platforms-claims.test.ts uses for PLATFORMS.md's Windows row.
      // The population is matched DELIBERATELY rather than incidentally: this
      // entry points the reader at that document, so a reader who follows the
      // pointer must not meet a second number for what reads as one fact. Both
      // pins derive from the tree rather than from each other, so they cannot
      // drift apart silently — a change to the code fails both, and a change to
      // one predicate fails that document's own pin.
      if (!entry.name.endsWith('.ts')) continue;
      if (full.includes('__tests__') || entry.name.endsWith('.test.ts')) continue;
      if (/(?:===|!==) 'win32'/.test(fs.readFileSync(full, 'utf8'))) branching.push(full);
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  const text = issue(6);
  assert.ok(branching.length > 0, 'nothing under src/ branches on win32 any more — item 6 describes code that is gone');
  const stated = /(\d+) non-test source files under `src\/` branch on `'win32'`/.exec(text)?.[1];
  assert.ok(stated, 'item 6 no longer states a win32 file count');
  assert.equal(
    Number(stated),
    branching.length,
    `KNOWN-ISSUES.md item 6 says ${stated} non-test source files branch on 'win32'; ${branching.length} do`,
  );

  // Item 6 is the residual (Job Object / composition) AND the statement that
  // CI has no Windows runner. The matrix is ubuntu + macos only.
  const workflow = read(path.join('.github', 'workflows', 'generate-check.yml'));
  const matrix = /os:\s*\[([^\]]*)\]/.exec(workflow)?.[1];
  assert.ok(matrix, 'the generate-check OS matrix is gone or reshaped');
  const runners = matrix!.split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.ok(!runners.includes('windows-latest'), 'generate-check matrix still lists windows-latest');
  assert.ok(
    /does not run on/.test(text) && text.includes('`windows-latest`'),
    'item 6 must say Windows does not run on windows-latest',
  );
  for (const runner of runners) {
    assert.ok(text.includes(`\`${runner}\``), `item 6 does not name the CI runner \`${runner}\``);
  }
  assert.ok(
    workflow.includes('test:env -- --strict'),
    'test:env --strict is gone from generate-check.yml — item 6\'s POSIX residual has no subject',
  );
  assert.doesNotMatch(
    workflow.split('test-env-strict:')[1]?.split(/^  [A-Za-z0-9_-]+:/m)[0] ?? '',
    /windows/i,
    'test:env must stay off windows-latest',
  );

  // The asset matrix, both directions. The comment at the top of
  // config/managed-runtimes.ts still says tranche 1 is darwin+linux and that
  // Windows returns null; the tables underneath it say otherwise, and the
  // document must follow the tables.
  const resolves = (kind: 'node' | 'python', platform: string, arch: string): boolean =>
    runtimeAsset(kind, platform, arch) !== null;
  assert.equal(
    resolves('node', 'win32', 'x64') && resolves('node', 'win32', 'arm64') && resolves('python', 'win32', 'x64'),
    text.includes('it resolves a pinned Node for Windows on x64 **and** arm64, and a pinned Python for Windows on x64'),
    'item 6 and the managed-runtime asset tables disagree about which Windows runtimes resolve. Today: '
    + `node/win32/x64=${resolves('node', 'win32', 'x64')}, node/win32/arm64=${resolves('node', 'win32', 'arm64')}, `
    + `python/win32/x64=${resolves('python', 'win32', 'x64')}`,
  );
  assert.equal(
    resolves('python', 'win32', 'arm64'),
    false,
    'a Python asset exists for Windows-ARM now — item 6 names it as the gap, and PLATFORMS.md repeats the claim',
  );
  assert.ok(
    text.includes('Python on Windows-ARM'),
    'item 6 no longer names the one Windows pair with no published asset',
  );
});

// Item 7 is the already-tracked residual after the recursive template shipped.
// The pin fails if the template stops being `**/.traffic-one/${entry}` or if
// the entry stops describing git's refusal to untrack what is already indexed.
test('the nested gitignore residual is already-tracked, and the template is recursive', () => {
  const scaffold = read(path.join('src', 'shared', 'architecture-contract', 'scaffold-content.ts'));
  const listed = /TRAFFIC_ONE_RUN_STATE_ENTRIES[^=]*=\s*\[([^\]]*)\]/.exec(scaffold)?.[1];
  assert.ok(listed, 'TRAFFIC_ONE_RUN_STATE_ENTRIES is gone or reshaped');
  const entries = [...listed!.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
  const text = issue(7);
  assert.ok(entries.includes('runs/'), `the entry item 7 quotes is gone; the set is now ${entries.join(', ')}`);
  assert.ok(text.includes('already tracked'), 'item 7 no longer describes the already-tracked residual');
  assert.ok(text.includes('`**/.traffic-one/<entry>`') || text.includes('`**/.traffic-one/runs/`'),
    'item 7 no longer quotes the recursive template that shipped');
  const templates = [...scaffold.matchAll(/\.map\(\(entry\) => `([^`]*)\$\{entry\}`\)/g)].map((match) => match[1] as string);
  assert.ok(templates.length > 0, 'the gitignore template that consumes the entries is gone or reshaped');
  assert.deepEqual(
    [...new Set(templates)],
    ['**/.traffic-one/'],
    'the run-state gitignore template is no longer recursive — item 7\'s already-tracked residual assumes it is',
  );
});

// Item 8 is the entry that says a test suite CANNOT catch something, which is
// the one claim a test suite can still be held to: the table it describes, the
// single code that means revocation, and the grace the other three fall back
// to are all in this repository even though the server's vocabulary is not.
test('the revocation-code entry counts the codes the auth table declares', () => {
  const { AUTH_GATE_401_CODES } = require('../src/runners/auth/validate-key') as {
    AUTH_GATE_401_CODES: Record<string, string>;
  };
  const codes = Object.keys(AUTH_GATE_401_CODES).sort();
  const rejecting = codes.filter((code) => AUTH_GATE_401_CODES[code] === 'rejects-the-key');
  const words: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
  const text = issue(8);
  assert.ok(words[codes.length], `AUTH_GATE_401_CODES now has ${codes.length} entries, which item 8 has no word for`);
  assert.ok(
    text.includes(`The ${words[codes.length]} codes are pinned verbatim`),
    `item 8 states the wrong number of 401 codes — the table declares ${codes.length}: ${codes.join(', ')}`,
  );
  assert.deepEqual(
    rejecting,
    ['invalid_token'],
    'more than one 401 code now rejects the key — item 8 says matching `invalid_token` is the whole mechanism',
  );
  assert.ok(text.includes('`invalid_token`'), 'item 8 no longer names the code the client matches');
  // The grace the entry quantifies, which is the reason it can call the failure
  // direction safe.
  const graceDays = AUTH_OFFLINE_GRACE_MS / 86_400_000;
  assert.ok(
    text.includes(`gives you ${graceDays} more days`),
    `item 8 states a grace window that is not AUTH_OFFLINE_GRACE_MS (${graceDays} days)`,
  );
  // …and the test the entry sends the reader to, which is the only thing
  // standing between a deliberate rename and a silent one.
  const pinned = read(path.join('src', 'runners', 'auth', '__tests__', 'validate-key.test.ts'));
  for (const code of codes) {
    assert.ok(pinned.includes(`'${code}'`), `validate-key.test.ts no longer pins '${code}' verbatim, as item 8 says it does`);
  }
});

test('the Node-floor entry states the declared floor, in its heading', () => {
  assert.ok(
    issue(9).startsWith(`## 9. Below Node ${NODE_FLOOR_MAJOR}, Traffic One warns rather than refusing`),
    `KNOWN-ISSUES.md item 9 does not head on the declared floor of Node ${NODE_FLOOR_MAJOR}`,
  );
  // The verdict, not just the number: the guard is emitted as source text into
  // every launcher, and "warns rather than refusing" is a property of THAT
  // text. A throw or an early exit there turns the entry into a lie in the
  // direction that costs a user every gate.
  const guard = read(path.join('src', 'shared', 'node-floor.ts'));
  const source = /export function nodeFloorGuardSource\(\): string \{[\s\S]*?\n\}/.exec(guard)?.[0];
  assert.ok(source, 'nodeFloorGuardSource is gone or reshaped');
  assert.ok(source!.includes('process.stderr.write'), 'the below-floor guard no longer writes the line item 9 promises');
  assert.ok(
    !source!.includes('throw '),
    'the below-floor guard now throws — item 9 tells the reader Traffic One does not refuse',
  );
  assert.ok(
    source!.includes('process.exit'),
    'the below-floor guard must re-exec via process.exit when a managed Node is present',
  );
  assert.ok(
    source!.includes('Continuing anyway'),
    'the below-floor guard must still warn and continue when no managed Node is available',
  );
});

// ── privacy ──────────────────────────────────────────────────────────────────

test('PRIVACY.md describes the endpoint and payload the auth probe actually sends', () => {
  const text = flat('PRIVACY.md');
  const { DEFAULT_ENDPOINT } = require('../src/config/one-mcp') as { DEFAULT_ENDPOINT: string };
  assert.ok(text.includes(DEFAULT_ENDPOINT), 'PRIVACY.md names an endpoint that is not DEFAULT_ENDPOINT');
  // The probe moved from `tools/list` to `tools/call` on `updates` once
  // revalidation and the announcements feed became one request. A document
  // still describing the old probe would understate what is sent.
  const probe = read(path.join('src', 'runners', 'auth', 'validate-key.ts'));
  assert.match(probe, /method: 'tools\/call'/, 'the auth probe method changed');
  assert.match(probe, /name: 'updates'/, 'the auth probe tool changed');
  assert.ok(text.includes('"method":"tools/call"'), 'PRIVACY.md quotes a stale request body');
  assert.ok(text.includes('"name":"updates"'), 'PRIVACY.md quotes a stale request body');
  // And the README, which reaches far more readers than PRIVACY.md does.
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(!readme.includes('`tools/list`'), 'README still describes key validation as a tools/list probe');
});

test('PRIVACY.md states the revalidation cadence and grace window the config sets', () => {
  const text = flat('PRIVACY.md');
  const cadenceHours = AUTH_REVALIDATION_CADENCE_MS / 3_600_000;
  const graceDays = AUTH_OFFLINE_GRACE_MS / 86_400_000;
  assert.ok(text.includes(`once every ${cadenceHours} hours per machine`), 'the stated cadence is not the configured one');
  assert.ok(text.includes(`bounded ${graceDays}-day grace window`), 'the stated grace window is not the configured one');
});

test('the committed-vs-ignored split PRIVACY.md describes is the split the generator writes', () => {
  const scaffold = read(path.join('src', 'shared', 'architecture-contract', 'scaffold-content.ts'));
  const listed = /TRAFFIC_ONE_RUN_STATE_ENTRIES[^=]*=\s*\[([^\]]*)\]/.exec(scaffold)?.[1];
  assert.ok(listed, 'TRAFFIC_ONE_RUN_STATE_ENTRIES is gone or reshaped');
  const ignored = [...listed!.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
  const text = flat('PRIVACY.md');
  for (const entry of ignored) {
    assert.ok(text.includes(`\`${entry}\``), `PRIVACY.md does not list \`${entry}\` among the ignored paths`);
  }
  // `digests/` staying OUT of that set is the claim with a consequence: it is
  // committed, it contains agents' prose about the project, and PRIVACY.md
  // tells the reader to review it.
  assert.ok(!ignored.includes('digests/'), 'digests/ became ignored — PRIVACY.md says it is committed');
  assert.ok(text.includes('`.traffic-one/digests/` holds handoff records'));
});

// The claim with the shortest distance between "false" and "a user's client name
// in a public mirror". Both halves of the split are pinned, because either one
// alone re-opens the leak: the value has to be ROUTED out of committed state,
// and the wizard has to stop WRITING it there.
test('the originalPrompt disclosure matches where the prompt is actually stored', () => {
  const seed = read(path.join('src', 'shared', 'onboarding', 'seed-prompt.ts'));
  // Written to the per-user preference store, not through writeState.
  assert.match(seed, /const text = \(prompt \|\| ''\)\.trim\(\);/);
  assert.match(seed, /mergeProjectPrefs\(cwd, \{\s*originalPrompt: text,/);

  // …and it stays there, because the key is routed.
  const schema = read(path.join('src', 'shared', 'state', 'local-prefs', 'pref-schema.ts'));
  const projectPrefKeys = /PROJECT_PREF_KEYS = new Set\(\[([^\]]*)\]\)/.exec(schema)?.[1];
  assert.ok(projectPrefKeys, 'PROJECT_PREF_KEYS is gone or reshaped');
  assert.ok(
    projectPrefKeys!.includes("'originalPrompt'"),
    'originalPrompt left PROJECT_PREF_KEYS — it is committed again, and PRIVACY.md says it is not',
  );

  // The nested spelling the wizard used to commit alongside it. Both the write
  // and the schema requirement are gone; the migration that removes an existing
  // one is what PRIVACY.md promises to anyone who has one.
  const flow = read(path.join('src', 'shared', 'onboarding-server', 'flow.ts'));
  const contextWrite = /projectContext: \{ source: 'prompted',([^}]*)\}/.exec(flow)?.[1];
  assert.ok(contextWrite, 'the project-context state write is gone or reshaped');
  assert.ok(
    !contextWrite!.includes('originalPrompt'),
    'the wizard commits projectContext.originalPrompt again — PRIVACY.md says the prompt is not committed',
  );
  const validate = read(path.join('src', 'shared', 'state', 'validate.ts'));
  assert.ok(
    !/typeof c\.originalPrompt === 'string'/.test(validate),
    'the committed schema requires projectContext.originalPrompt again',
  );
  assert.match(
    read(path.join('src', 'shared', 'state', 'normalize.ts')),
    /function hoistCommittedOriginalPrompt/,
    'the migration PRIVACY.md promises ("a project set up by an older version has its copy moved out automatically") is gone',
  );

  const privacy = flat('PRIVACY.md');
  assert.ok(privacy.includes('your first prompt is not in it'),
    'PRIVACY.md no longer states where the prompt is not');
  assert.ok(privacy.includes('~/.traffic-one/projects/<hash>/preferences.json`, under `originalPrompt`'),
    'PRIVACY.md no longer names the file the prompt IS in');
  // The residual, and the one document that still claims it. KNOWN-ISSUES.md
  // used to carry it too, as "a prompt already pushed by an older version stays
  // in your git history" — removed, because there is no older version: no tag
  // on the remote, no published bundle, `private: true`, and every documented
  // install path a local one, so the population it addressed is empty. The
  // migration below stays, and stays pinned, because the CODE is right to keep
  // it; what could not stay was a known ISSUE nobody can hit. If PRIVACY.md's
  // "older version" paragraphs go the same way, the pin above this comment is
  // what tells you the migration is then unclaimed by any shipped document.
  assert.ok(
    privacy.includes('A project set up by an older version has its copy moved out automatically'),
    'PRIVACY.md no longer promises the repair — nothing shipped now claims it, and the pin on '
    + 'hoistCommittedOriginalPrompt above is guarding an undocumented behaviour',
  );
});

// PRIVACY.md tells the reader a bundle is safe to paste with respect to prompts.
// It was not: the top-level field and its copy in the preference store are
// matched only by the bundle's key matchers, and `prompt` is in neither
// credential set (deliberately — it is not a credential word).
test('the bundle redacts prompt-named keys, as PRIVACY.md says it does', () => {
  const {
    isPromptBundleKey,
    isSensitiveBundleKey,
    redactProjectProbe,
  } = require('../src/runners/doctor/bundle') as typeof import('../src/runners/doctor/bundle');
  // The premise: the credential matchers do not and should not catch it.
  assert.equal(isSensitiveBundleKey('originalPrompt'), false);
  for (const key of ['originalPrompt', 'userPrompt', 'initial_prompt', 'prompt']) {
    assert.equal(isPromptBundleKey(key), true, `${key} is not treated as prompt-bearing`);
  }
  // …and it does not over-reach into an identifier that merely contains the
  // letters, which would blank a diagnostic field.
  for (const key of ['promptness', 'stack', 'uiLibrary', 'installedVersion']) {
    assert.equal(isPromptBundleKey(key), false, `${key} is redacted as a prompt`);
  }

  const SENTENCE = 'build me a learning platform for ACME';
  const redacted = redactProjectProbe({
    state: { originalPrompt: SENTENCE, stack: 'default' },
    normalizedState: { originalPrompt: SENTENCE },
    localPreferences: { originalPrompt: SENTENCE, codeGraphAutoRun: true },
  } as unknown as Parameters<typeof redactProjectProbe>[0]);
  assert.ok(!JSON.stringify(redacted).includes(SENTENCE), 'the prompt survives redaction');
  assert.equal((redacted.state as Record<string, unknown>).stack, 'default', 'redaction ate a diagnostic field');
  assert.equal(redacted.localPreferences.codeGraphAutoRun, true);
  assert.ok(flat('PRIVACY.md').includes('every field whose name contains the word `prompt`'));
});

test('the hook-trace claim tracks what the tracer records today', () => {
  const trace = read(path.join('src', 'shared', 'hook', 'trace.ts'));
  assert.match(trace, /stdinShape: payloadShape\(stdin\)/, 'the tracer no longer records a shape');
  assert.doesNotMatch(trace, /stdin: stdin\.slice/, 'the tracer records raw stdin again — PRIVACY.md says it does not');
  assert.ok(flat('PRIVACY.md').includes('records the SHAPE of a hook payload, never its'));
});

// ── env vars: an off-switch that does not exist is worse than none ───────────

test('every environment variable the release documents name is one the code reads', () => {
  const referenced = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|mjs|cjs|json)$/.test(entry.name)) continue;
      for (const match of fs.readFileSync(full, 'utf8').matchAll(/\b(TRAFFIC_ONE|T1)_[A-Z0-9_]+/g)) {
        referenced.add(match[0]);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  let documented = 0;
  for (const doc of DOCS) {
    for (const match of read(doc).matchAll(/\b(?:TRAFFIC_ONE|T1)_[A-Z0-9_]+/g)) {
      documented += 1;
      assert.ok(referenced.has(match[0]), `${doc} documents ${match[0]}, which no source file reads`);
    }
  }
  assert.ok(documented > 0, 'the release documents name no environment variable — did the off-switch tables move?');
  // The two whose whole purpose is to be typed by a reader.
  assert.ok(read('PLATFORMS.md').includes(UNCERTIFIED_HOST_OPT_OUT_ENV));
  assert.ok(read('PRIVACY.md').includes('T1_DECISION_LOG=off'));
});

// ── support runbook ──────────────────────────────────────────────────────────

// The exact defect readme-claims.test.ts was written for, in the document that
// exists to be read BY someone whose session is already refusing things: a
// recovery command the recovery gate denies.
// Every OPERATOR command doctor ships — the ones that write. Both are outside
// the exemption grammar, and the list is here rather than a `--unblock`
// substring test because there are now two of them and a third would otherwise
// be admitted silently by being unlisted.
const DOCTOR_OPERATOR_FLAGS = ['--unblock', '--reconcile-overrides'] as const;

test('every doctor command SUPPORT.md prints is one the gate admits — except the operator writes, which must stay denied', () => {
  const commands = [...read('SUPPORT.md').matchAll(/node [^\n`]*?doctor\.cjs[^\n`]*/g)].map((match) => match[0]);
  assert.ok(commands.length >= 3, `SUPPORT.md no longer prints doctor commands (found ${commands.length})`);
  const resolve = (documented: string): string => documented
    .replace('<runId>', '1785169657252')
    .replace('<gateId>', 'architecture-contract-gate')
    .replace(' [--ttl 30m]', ' --ttl 30m');

  let diagnostics = 0;
  const writes = new Set<string>();
  // The fixture HOME for the reason the reset test below states in full: every
  // spelling in this runbook is `~/.traffic-one/bin/doctor.cjs`, and read
  // against a real HOME this loop answered from whatever shim that machine
  // happened to hold — red on a stale one, vacuously green on a CI box with
  // none. The operator-write assertions are unaffected either way (they are
  // refused on the ARGV, before any anchor is consulted), which is precisely
  // why the diagnostic half could look healthy while testing nothing.
  withShimHome(() => {
    for (const documented of commands) {
      const command = resolve(documented);
      const operatorFlag = DOCTOR_OPERATOR_FLAGS.find((flag) => documented.includes(flag));
      if (operatorFlag) {
        // The exemption grammar in shared/tool-classify.ts deliberately does not
        // admit either of these, because the exemption exists so a STUCK SESSION
        // can diagnose itself — and neither minting an override nor reconciling
        // its audit record is diagnosis. An agent must not inherit "no gate has
        // an opinion" for a command that writes. This asserts the security
        // property, not a defect: the day it flips, SUPPORT.md's "run this
        // command yourself" stops being true and this test says so.
        writes.add(operatorFlag);
        assert.equal(
          isTrafficOneDoctorCommand('Bash', { command }),
          false,
          `an override write became gate-exempt: ${documented}`,
        );
        continue;
      }
      diagnostics += 1;
      assert.equal(
        isTrafficOneDoctorCommand('Bash', { command }),
        true,
        `SUPPORT.md prints a doctor command the gate denies: ${documented}\n  (resolved to: ${command})`,
      );
    }
  });
  assert.ok(diagnostics >= 3, `expected several diagnostic commands, found ${diagnostics}`);
  assert.deepEqual([...writes].sort(), [...DOCTOR_OPERATOR_FLAGS].sort(),
    'SUPPORT.md should print each operator write exactly once');
  assert.ok(
    flat('SUPPORT.md').includes('is not gate-exempt'),
    'SUPPORT.md must tell the reader why the mint cannot be run from inside a session',
  );
});

/**
 * Run `body` with HOME pointed at a throwaway directory holding the genuine
 * shims.
 *
 * `documentedBinDir()` and the gate's own tilde expansion both read
 * `process.env.HOME`, so moving it moves the anchor, the documented path and
 * the file all together — which is what makes the comparison real rather than
 * incidental. The bytes come from `shimSource()`, the generator the gate
 * compares against, so this fixture asserts the SPELLING is admissible and
 * never that some particular machine happens to be up to date.
 */
function withShimHome(body: () => void): void {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-release-docs-home-')));
  const previous = process.env.HOME;
  try {
    process.env.HOME = home;
    const bin = path.join(home, '.traffic-one', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'traffic-one-reset.cjs'), shimSource('scripts/traffic-one-reset.cjs'), 'utf8');
    fs.writeFileSync(path.join(bin, 'doctor.cjs'), shimSource('scripts/doctor.cjs'), 'utf8');
    body();
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// The same property for the runner that is NOT doctor, and the scan above
// structurally cannot see it: `traffic-one-reset` has its own bounded exact-argv
// grammar in shared/tool-classify.ts. It matters more here than for any doctor
// invocation, because it is the escape from a run that has no other escape — a
// spelling this runbook prints and the gate denies would leave a wedged project
// with nothing at all, in the document its owner reads while stuck.
test('every reset command SUPPORT.md prints is one the gate admits', () => {
  const commands = [...read('SUPPORT.md').matchAll(/node [^\n`]*?traffic-one-reset\.cjs[^\n`]*/g)]
    .map((match) => match[0]);
  assert.ok(commands.length >= 1, 'SUPPORT.md no longer prints the wedged-run recovery command');
  // AGAINST A FIXTURE HOME HOLDING THE REFERENCE BYTES, because the documented
  // spelling is `~/.traffic-one/bin/...` and the gate resolves both the tilde
  // and its own exemption anchor from HOME. Read against the developer's real
  // HOME this assertion answered from whatever shim happened to be on that
  // machine, which made it two different tests and neither of them this one: it
  // went RED on any machine whose installed shim predates a template edit — for
  // the whole duration of the commit that touches the template — and on CI,
  // where no shim exists, it passed through isGeneratedShim's absence clause
  // without ever comparing anything. Writing the reference in makes the claim
  // ("the runbook prints a command the gate admits") the thing under test,
  // everywhere, including CI.
  withShimHome(() => {
    for (const documented of commands) {
      // `<id>` stands for a run id, bounded by DOCTOR_ID_PATTERN — substituted
      // the way a reader with a real wedge would.
      const resolved = documented.replace('<id>', '1785169657252');
      assert.equal(
        isTrafficOneResetCommand('Bash', { command: resolved }),
        true,
        `SUPPORT.md prints a reset command the gate denies: ${documented}\n  (resolved to: ${resolved})`,
      );
    }
  });
  // Two symptoms in this document look alike from the outside — a run that
  // cannot progress, and a project that cannot certify — and exactly one of
  // them is what reset repairs. Without this sentence a reader with a damaged
  // override record runs it, watches it succeed, and is no closer to a verified
  // run, having spent their one obvious remedy.
  assert.ok(
    flat('SUPPORT.md').includes('It does not clear an override-evidence refusal.'),
    'SUPPORT.md no longer says what reset does NOT fix, next to the command that does not fix it',
  );
});

// The repair for a wedged override record must never become the erasure it
// exists to make expensive. Two claims, both load-bearing in the runbook: the
// command deletes nothing, and it costs the runs that already exist.
test('SUPPORT.md documents the override repair as append-only, not a delete', () => {
  const text = flat('SUPPORT.md');
  assert.ok(text.includes('--reconcile-overrides'), 'SUPPORT.md no longer names the override repair');
  assert.ok(text.includes('This deletes nothing.'),
    'SUPPORT.md must say the repair deletes nothing — that property is the whole design');
  const unblock = read(path.join('src', 'runners', 'doctor', 'unblock.ts'));
  for (const refusal of ['nothing-to-reconcile', 'too-many-runs']) {
    assert.ok(unblock.includes(`'${refusal}'`), `unblock.ts no longer has the ${refusal} refusal`);
  }
});

test('SUPPORT.md points at the paths the code actually writes', () => {
  const text = flat('SUPPORT.md');
  const { decisionLogRelPath } = require('../src/shared/state/decision-log') as {
    decisionLogRelPath?: (runId: string) => string;
  };
  // Fall back to the literal when the module exposes no path helper: the claim
  // is about the shipped string either way, and a helper that vanishes should
  // not silently disable the check.
  const rel = decisionLogRelPath
    ? decisionLogRelPath('<runId>')
    : '.traffic-one/runs/<runId>/debug/decisions.jsonl';
  assert.ok(text.includes(rel), `SUPPORT.md does not name the decision log at ${rel}`);
  assert.ok(text.includes('~/.traffic-one/overrides/'), 'SUPPORT.md no longer names the override ledger location');
});

test('the override refusals SUPPORT.md promises are the refusals unblock.ts implements', () => {
  const unblock = read(path.join('src', 'runners', 'doctor', 'unblock.ts'));
  for (const refusal of ['not-interactive', 'gate-never-denied', 'gate-not-overridable', 'no-run', 'bad-ttl']) {
    assert.ok(unblock.includes(`'${refusal}'`), `unblock.ts no longer has the ${refusal} refusal`);
  }
  // The TTY requirement is a cost, not a defence: a pty satisfies it, so an
  // agent that wants the override can have one (see unblock.ts). Pinning it
  // keeps the cost from being removed quietly; the two assertions below pin
  // the parts that do hold — no scriptable bypass flag, and the permanent
  // ineligibility SUPPORT.md promises.
  assert.match(unblock, /Boolean\(stdin\.isTTY\) && Boolean\(stdout\.isTTY\)/);
  const text = flat('SUPPORT.md');
  assert.ok(text.includes('There is no `--yes`, no environment variable, and no test-only bypass'));
  assert.ok(text.includes('can never settle as verified or shipped'));
});

// ── third-party notices ──────────────────────────────────────────────────────

// Scoped to each tool's DECLARATION LINE rather than to the document, and the
// difference is the whole value of the test. Asking `text.includes(licence)`
// only ever asked "does this licence string appear anywhere in the file", which
// a five-tool notice satisfies by accident: when every tool was MIT the check
// passed on any one of them, and a half-corrected graphify (manifest moved to
// Apache-2.0, its own section left at MIT) would ALSO have passed, because
// Apache-2.0 already appears six times for other dependencies. That is exactly
// how a false licence survived in a shipped notice.
//
// A declaration line is structural — a `### <tool>` heading or a `| <tool> |`
// table row — so prose that merely discusses a tool cannot satisfy it. That
// exclusion is load-bearing: the notice quotes the onboarding question, one
// line naming both gitnexus and graphify with both licences, which would let
// either tool borrow the other's correctness.
//
// THE LIMIT, which no scoping fixes: this compares two IN-REPO copies, so it
// can catch them disagreeing and can never catch both being wrong together.
// Only an upstream check could, and tests must not reach the network — so the
// durable mitigation is the provenance note recorded in the manifest itself.
test('THIRD-PARTY-NOTICES.md declares every installable toolchain with the licence its manifest declares', () => {
  const manifest = (JSON.parse(
    read(path.join('src', 'runners', 'toolchain', 'toolchain-versions.json')),
  ) as { tools?: Record<string, { license?: string }> }).tools ?? {};
  const text = read('THIRD-PARTY-NOTICES.md');
  const lines = text.split('\n');
  let checked = 0;
  for (const [tool, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry !== 'object' || !entry.license) continue;
    checked += 1;
    assert.ok(
      text.toLowerCase().includes(tool.toLowerCase()),
      `THIRD-PARTY-NOTICES.md never mentions the toolchain "${tool}"`,
    );
    const declarations = lines.filter((line) => {
      const named = line.toLowerCase().includes(tool.toLowerCase());
      return named && (line.startsWith('### ') || line.startsWith('| '));
    });
    assert.ok(
      declarations.length > 0,
      `THIRD-PARTY-NOTICES.md discusses "${tool}" but never declares it: no "### ${tool}" heading and no table row naming it. `
        + 'A tool mentioned only in prose has no licence of record.',
    );
    assert.ok(
      declarations.some((line) => line.includes(entry.license!)),
      `${tool}'s declaration in THIRD-PARTY-NOTICES.md does not state its manifest licence "${entry.license}".\n`
        + `  declared as: ${declarations.map((line) => line.trim()).join('\n               ')}\n`
        + '  (the licence appearing elsewhere in the document does not count — that is the defect this test exists for)',
    );
  }
  assert.ok(checked > 0, 'toolchain-versions.json declares no licences — did the manifest move?');
  // The one with commercial consequences. Named explicitly so a reorganisation
  // cannot bury it: this is the reason the notice ships at all.
  assert.match(text, /PolyForm Noncommercial/);
  assert.match(text, /NOT open source/);
});

test('the dependency-free claim is a fact about package.json, not a slogan', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
  assert.equal(
    pkg.dependencies,
    undefined,
    'the plugin grew a runtime dependency — THIRD-PARTY-NOTICES.md section 1 says there are none',
  );
  assert.ok(flat('THIRD-PARTY-NOTICES.md').includes('no `dependencies` block at all'));
});
