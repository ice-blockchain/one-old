// PLATFORMS.md ↔ code and CI, mechanically.
//
// This document opens with a promise about ITSELF: "Every row is read out of the
// code or the CI configuration; nothing here is an intention." It ships verbatim
// to every install (STATIC_TEXT_FILES in src/gen/emit/static.ts), and it is a
// SUPPORT MATRIX — the one surface where a false row costs a reader a day before
// they discover the platform they read as supported is not. An audit of it found
// three claims that sentence could not back: a host-row count that had drifted
// from 19 to 27 (a measurement has a date, not permanence), a mechanism sentence
// asserting every harness host row carries `headlessSubagents: 'unsupported'`
// when the two hosts with no unattended CLI entrypoint carry no such field at
// all, and a managed-runtime matrix transcribed from a STALE COMMENT in
// src/config/managed-runtimes.ts ("Windows ... return null") rather than from the
// asset maps under it, which resolve a Node asset for Windows on both arches and
// a Python asset for Windows x64.
//
// Every expectation below is DERIVED — from HOST_CAPABILITIES, from HOST_COMMANDS,
// from runtimeAsset() called for real, from a scan of src/, from the workflow
// YAML — and then compared against what the document states. Nothing here
// compares the document to a string typed into this file: two copies of one claim
// agreeing proves only that someone typed it twice.
//
// Assertions are scoped to the ROW OR SENTENCE THAT DECLARES a claim, not to the
// document. A whole-document search for a value is satisfied by the same value
// appearing elsewhere for a different subject, which is how a swapped pair of
// table cells passes a pin that only asks whether both strings are present.
//
// NOT here, deliberately, because tests/release-docs.test.ts already owns them
// and one fact must not have two authorities: the per-host tier and certification
// columns, the host COUNT in prose, the stated Node floor and the
// "warns and continues" behaviour, the "No configured host supports headless
// subagents" conclusion, and the presence of UNCERTIFIED_HOST_OPT_OUT_ENV.
// tests/readme-claims.test.ts owns the README's own copy of the Node floor.

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOST_CAPABILITIES, type TrafficOneHost } from '../src/shared/host/capability-schema';
import { hostLabel } from '../src/shared/host/tiers';
import { HOST_COMMANDS } from '../src/test-environment/config/hosts';
import { runtimeAsset } from '../src/config/managed-runtimes';
import { nodeFloorGuardSource } from '../src/shared/node-floor';

const REPO_ROOT = path.resolve(__dirname, '..');
const DOC = fs.readFileSync(path.join(REPO_ROOT, 'PLATFORMS.md'), 'utf8');
/** Whitespace-normalized, so a paragraph reflow never fails a claim. */
const FLAT = DOC.replace(/\s+/g, ' ');

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const HOSTS = Object.keys(HOST_CAPABILITIES) as TrafficOneHost[];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Every file under `rel`, recursively. */
function walk(rel: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const child = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && keep(child)) out.push(child);
    }
  };
  visit(rel);
  return out.sort();
}

/**
 * The ONE markdown table row that declares `host`, so a per-host assertion is
 * scoped to that host's row. Two rows for one host is itself a defect: the
 * reader cannot tell which is current.
 */
function hostRow(host: TrafficOneHost): string {
  const rows = DOC.split('\n').filter(
    (line) => line.startsWith('|') && line.includes(`(\`${host}\`)`),
  );
  assert.equal(
    rows.length,
    1,
    `PLATFORMS.md has ${rows.length} table rows declaring \`${host}\`; exactly one must`,
  );
  return rows[0] as string;
}

function cells(row: string): string[] {
  return row.split('|').map((cell) => cell.trim()).filter(Boolean);
}

/** The sentence (up to a full stop or a blank line) that contains `needle`. */
function sentenceWith(needle: string): string {
  const at = FLAT.indexOf(needle);
  assert.notEqual(at, -1, `PLATFORMS.md no longer contains "${needle}" — update this test with the new wording`);
  const start = FLAT.lastIndexOf('. ', at) + 1;
  const end = FLAT.indexOf('. ', at + needle.length);
  return FLAT.slice(start, end === -1 ? undefined : end + 1);
}

// ── the host table ───────────────────────────────────────────────────────────

// The tier and certification columns are pinned in release-docs.test.ts; the
// blocking-point column is not, and it is the column a reader uses to answer
// "what does Traffic One actually hook on my host". Scoped per row on purpose:
// the whole-document version of this assertion passes when two rows have had
// their blocking points SWAPPED, because both strings are still present.
test('every host row names the primary blocking point its capability record declares', () => {
  assert.ok(HOSTS.length >= 7, `HOST_CAPABILITIES has ${HOSTS.length} hosts — the table cannot be smaller than the product`);
  for (const host of HOSTS) {
    const stated = cells(hostRow(host)).at(-1);
    assert.equal(
      stated,
      `\`${HOST_CAPABILITIES[host].primaryBlockingPoint}\``,
      `PLATFORMS.md gives ${host} the blocking point ${stated}; HOST_CAPABILITIES says \`${HOST_CAPABILITIES[host].primaryBlockingPoint}\``,
    );
  }
});

// The two tier sections restate the table in prose, and prose is where a retier
// goes unnoticed. Both directions are asserted: a demoted host that stays in the
// certified sentence is the same defect as one missing from the uncertified one.
test('the Certified and Uncertified prose sections enumerate exactly their tiers', () => {
  const lead = (heading: string): string => {
    const match = new RegExp(`### ${heading} \\*\\*([^*]+)\\*\\*`).exec(FLAT);
    assert.ok(match, `PLATFORMS.md has no bolded host list under "### ${heading}"`);
    return match![1] as string;
  };
  const certified = lead('Certified');
  const uncertified = lead('Uncertified');
  assert.ok(HOSTS.length >= 7, `HOST_CAPABILITIES has ${HOSTS.length} hosts`);
  for (const host of HOSTS) {
    const label = hostLabel(host);
    const isCertified = HOST_CAPABILITIES[host].tier === 'certified';
    assert.equal(
      certified.includes(label),
      isCertified,
      `PLATFORMS.md "### Certified" ${certified.includes(label) ? 'names' : 'omits'} ${label}, which is tier '${HOST_CAPABILITIES[host].tier}'`,
    );
    assert.equal(
      uncertified.includes(label),
      !isCertified,
      `PLATFORMS.md "### Uncertified" ${uncertified.includes(label) ? 'names' : 'omits'} ${label}, which is tier '${HOST_CAPABILITIES[host].tier}'`,
    );
  }
});

// "seven hosts (eight products …)" — the host count is pinned in
// release-docs.test.ts; the PRODUCT count is the one that has no source unless
// it is derived, and it is derived: Copilot is one host id with two wire
// surfaces (CLI and VS Code), so products = hosts + surfaces - 1.
test('the product count is the host count plus Copilot\'s second wire surface', () => {
  const adapter = read(path.join('src', 'adapters', 'copilot.ts'));
  const union = /type CopilotWireSurface =([^;]+);/.exec(adapter);
  assert.ok(union, 'src/adapters/copilot.ts no longer declares CopilotWireSurface');
  const surfaces = [...(union![1] as string).matchAll(/'([\w-]+)'/g)].map((match) => match[1] as string);
  assert.ok(surfaces.length >= 2, `CopilotWireSurface has ${surfaces.length} surface(s); the "eight products" claim rests on there being two`);
  const stated = /\((\w+) products/.exec(FLAT)?.[1];
  assert.equal(
    NUMBER_WORDS[String(stated)] ?? Number(stated),
    HOSTS.length + surfaces.length - 1,
    `PLATFORMS.md says "${stated} products" for ${HOSTS.length} hosts and ${surfaces.length} Copilot wire surfaces`,
  );
});

// ── cited paths ──────────────────────────────────────────────────────────────

// The decay class this closes has hit this repository four times in one effort:
// a citation right about the FILE and wrong about the DIRECTORY. The obvious
// looser pin — "a file with that basename exists somewhere in the tree" — passes
// every one of those, because the file does exist, just not where the document
// sends the reader.
test('every source path the document cites exists at the path it cites', () => {
  const cited = [...new Set(
    [...DOC.matchAll(/`((?:src|tests|\.github)\/[^`]+)`/g)]
      .map((match) => (match[1] as string).replace(/\/\*\*$/, '')),
  )];
  assert.ok(
    cited.length >= 6,
    `PLATFORMS.md cites ${cited.length} source paths; it names at least six (host capabilities, harness hosts, node floor, harness cases, managed runtimes, the workflow)`,
  );
  for (const rel of cited) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, rel)),
      `PLATFORMS.md cites ${rel}, which does not exist${
        fs.existsSync(path.join(REPO_ROOT, 'src', path.basename(rel))) ? ' (a file of that name exists elsewhere — wrong directory)' : ''
      }`,
    );
  }
});

// ── the uncertified-install refusal, and its one exception ───────────────────

// The document says installing for an uncertified host refuses, and that Copilot
// is THE exception because it installs through its own native command. That is
// not visible in uncertifiedHostInstallRefusal() — which refuses for any
// uncertified host — but in its CALL SITES: only the three wrapper installers
// invoke it. Discovered by scanning, so a fourth installer (or a deleted one)
// moves this test rather than leaving the document's "exception" stale.
test('the hosts that refuse an uncertified install are the uncertified hosts the installers cover', () => {
  const sources = walk('src', (file) => file.endsWith('.ts') && !file.includes('__tests__') && !file.endsWith('.test.ts'));
  assert.ok(sources.length >= 100, `scanned ${sources.length} source files — the walk is not reaching src/`);
  const refusing = new Set<string>();
  for (const rel of sources) {
    for (const match of read(rel).matchAll(/uncertifiedHostInstallRefusal\('([a-z]+)'/g)) {
      refusing.add(match[1] as string);
    }
  }
  assert.ok(refusing.size >= 3, `found ${refusing.size} literal uncertifiedHostInstallRefusal call sites; the claim rests on there being one per wrapper installer`);
  const uncertified = HOSTS.filter((host) => HOST_CAPABILITIES[host].tier === 'uncertified');
  const exempt = uncertified.filter((host) => !refusing.has(host));
  assert.deepEqual(
    exempt,
    ['copilot'],
    `PLATFORMS.md names Copilot as the sole exception to the install refusal; the code exempts ${JSON.stringify(exempt)}`,
  );
  const claim = sentenceWith('exception to the refusal');
  for (const host of exempt) {
    assert.ok(
      claim.includes(hostLabel(host)),
      `PLATFORMS.md's refusal-exception sentence does not name ${hostLabel(host)}: "${claim}"`,
    );
  }
});

// ── headless subagents: the MECHANISM, not the conclusion ────────────────────

// release-docs.test.ts pins the conclusion ("no configured host supports headless
// subagents") by asserting every headlessSubagents VALUE is 'unsupported'. That
// assertion cannot see this document's mechanism claim, and did not: the document
// said every host row carries the field while two rows carry no such field at
// all, and the pin stayed green because it only looks at the values that exist.
// What is pinned here is the PARTITION — which rows carry it and which are
// exempt, and why.
test('the harness rows without a headlessSubagents field are exactly the ones with no headless entrypoint', () => {
  const rows = Object.entries(HOST_COMMANDS);
  assert.ok(rows.length >= 7, `HOST_COMMANDS has ${rows.length} rows`);
  const missing = rows.filter(([, config]) => config.headlessSubagents === undefined).map(([id]) => id).sort();
  const noE2E = rows.filter(([, config]) => config.e2eSupported === false).map(([id]) => id).sort();
  for (const [id, config] of rows) {
    if (config.headlessSubagents === undefined) continue;
    assert.equal(config.headlessSubagents, 'unsupported', `harness host ${id} now claims headlessSubagents: '${config.headlessSubagents}'`);
  }
  assert.deepEqual(
    missing,
    noE2E,
    `PLATFORMS.md explains the missing headlessSubagents rows as the e2eSupported:false ones; the config's missing rows are ${JSON.stringify(missing)} and its e2eSupported:false rows are ${JSON.stringify(noE2E)}`,
  );
  const claim = sentenceWith('carry no such field');
  for (const id of missing) {
    assert.ok(
      claim.includes(hostLabel(id)),
      `PLATFORMS.md's headless-subagent exemption sentence does not name ${hostLabel(id)}: "${claim}"`,
    );
  }
});

// ── the OS matrix ────────────────────────────────────────────────────────────

const WORKFLOW_DIR = path.join('.github', 'workflows');
const WORKFLOWS = fs.readdirSync(path.join(REPO_ROOT, WORKFLOW_DIR))
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .sort();
const GENERATE_CHECK = path.posix.join('.github', 'workflows', 'generate-check.yml');

test('the OS table names the runners the generate-check matrix actually runs on', () => {
  assert.ok(WORKFLOWS.length >= 1, 'no workflows found — the OS table has no source');
  const yml = read(GENERATE_CHECK);
  const matrix = /os:\s*\[([^\]]+)\]/.exec(yml);
  assert.ok(matrix, `${GENERATE_CHECK} no longer declares an os matrix`);
  const runners = (matrix![1] as string).split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.ok(runners.length >= 2, `the matrix declares ${runners.length} runner(s); the table describes it as a matrix`);
  // Each OS row must cite the runner that exercises it, in ITS row.
  const rowFor = (os: string): string => {
    const row = DOC.split('\n').find((line) => line.startsWith(`| ${os} `));
    assert.ok(row, `PLATFORMS.md has no OS table row for ${os}`);
    return row as string;
  };
  for (const [os, runner] of [['macOS', 'macos-latest'], ['Linux', 'ubuntu-latest'], ['Windows', 'windows-latest']] as const) {
    assert.ok(runners.includes(runner), `${GENERATE_CHECK}'s matrix no longer includes ${runner}, which PLATFORMS.md's ${os} row cites`);
    assert.ok(
      rowFor(os).includes(`\`${runner}\``),
      `PLATFORMS.md's ${os} row does not cite ${runner}: ${rowFor(os)}`,
    );
  }
});

// "the two jobs that run nowhere else" is a COUNT of workflow legs, and a
// narrowed or deleted leg is exactly the CI-decay class this document has to
// survive. Derived from the jobs whose runs-on is a literal runner rather than
// the matrix expression.
test('the Linux row states as many Linux-only jobs as the workflow declares', () => {
  const yml = read(GENERATE_CHECK);
  const literal = [...yml.matchAll(/^ {4}runs-on: ([a-z][\w-]*)$/gm)].map((match) => match[1] as string);
  assert.ok(literal.length >= 1, `${GENERATE_CHECK} declares no jobs with a literal runs-on`);
  for (const runner of literal) {
    assert.match(runner, /^ubuntu-/, `a job outside the matrix runs on ${runner}; PLATFORMS.md says the extra jobs are Linux's alone`);
  }
  const stated = /plus\*\* the (\w+) jobs that run nowhere else/.exec(FLAT)?.[1];
  assert.equal(
    NUMBER_WORDS[String(stated)] ?? Number(stated),
    literal.length,
    `PLATFORMS.md's Linux row says "${stated} jobs that run nowhere else"; ${GENERATE_CHECK} declares ${literal.length} job(s) outside the matrix`,
  );
});

// Windows is on the generate-check matrix for typecheck + npm test only.
// test:env and the other POSIX-only jobs must stay off windows-latest, and the
// row must not claim Job Object teardown is covered.
test('generate-check includes windows-latest; test:env stays POSIX', () => {
  const yml = read(GENERATE_CHECK);
  const matrix = /os:\s*\[([^\]]+)\]/.exec(yml);
  assert.ok(matrix, `${GENERATE_CHECK} no longer declares an os matrix`);
  const runners = (matrix![1] as string).split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.ok(runners.includes('windows-latest'), `${GENERATE_CHECK}'s matrix does not include windows-latest`);
  const row = DOC.split('\n').find((line) => line.startsWith('| Windows '));
  assert.ok(row, 'PLATFORMS.md has no Windows OS-table row');
  assert.ok(
    (row as string).includes('`windows-latest`'),
    `PLATFORMS.md's Windows row does not cite windows-latest: ${row}`,
  );
  assert.match(
    row as string,
    /Job Object teardown is not claimed fixed/,
    'PLATFORMS.md Windows row must keep the Job Object residual, not claim it fixed',
  );
  assert.ok(
    /test:env/.test(row as string) && /POSIX/.test(row as string),
    'PLATFORMS.md Windows row must keep test:env on POSIX',
  );

  const testEnvJob = yml.split(/^  [A-Za-z0-9_-]+:/m).find((block) => block.includes('test:env --strict'));
  assert.ok(testEnvJob, `${GENERATE_CHECK} has no test:env --strict job`);
  assert.doesNotMatch(
    testEnvJob,
    /windows/i,
    `${GENERATE_CHECK} test:env job must stay POSIX`,
  );
});

// A count taken by hand has a date, not permanence: this one read 27 while the
// tree held 19, having been measured with a looser pattern than the sentence
// described. Both the pattern and the scope are stated in the row so a reader can
// reproduce them, and derived here so the row cannot drift again.
const WIN32_BRANCH = /(?:===|!==) 'win32'/;

test('the Windows row states the number of source files that branch on win32', () => {
  const sources = walk('src', (file) => file.endsWith('.ts') && !file.includes('__tests__') && !file.endsWith('.test.ts'));
  assert.ok(sources.length >= 100, `scanned ${sources.length} non-test source files — the walk is not reaching src/`);
  const branching = sources.filter((rel) => WIN32_BRANCH.test(read(rel)));
  assert.ok(branching.length >= 1, 'no source file branches on win32 — the Windows row describes code that is gone');
  const row = DOC.split('\n').find((line) => line.startsWith('| Windows '));
  assert.ok(row, 'PLATFORMS.md has no Windows OS-table row');
  const stated = /(\d+) non-test source files/.exec(row as string)?.[1];
  assert.equal(
    Number(stated),
    branching.length,
    `PLATFORMS.md's Windows row says ${stated} non-test source files branch on 'win32'; ${branching.length} do`,
  );
});

// ── the managed-runtime matrix ───────────────────────────────────────────────

// The strongest pin in this file, because it does not read the asset maps — it
// CALLS them. The claim it replaces was transcribed from a comment above those
// maps ("Windows ... return null") that the maps below it contradict, and a pin
// that read the comment would have agreed with the document and with nothing
// else.
const OS_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['macOS', 'darwin'],
  ['Linux', 'linux'],
  ['Windows', 'win32'],
];
const ARCHES = ['x64', 'arm64'] as const;

test('the managed-runtime matrix is the one runtimeAsset() resolves, per runtime kind', () => {
  const claimed = (kind: 'Node' | 'Python'): string => {
    const match = new RegExp(`\\*\\*${kind}\\*\\* asset (?:resolves )?for \\*\\*([^*]+)\\*\\*`).exec(FLAT);
    assert.ok(match, `PLATFORMS.md no longer states which platforms a managed ${kind} asset resolves for`);
    return match![1] as string;
  };
  for (const kind of ['node', 'python'] as const) {
    const label = kind === 'node' ? 'Node' : 'Python';
    const sentence = claimed(label);
    const resolved = OS_LABELS.filter(
      ([, platform]) => ARCHES.some((arch) => runtimeAsset(kind, platform, arch) !== null),
    ).map(([name]) => name);
    assert.ok(resolved.length >= 1, `runtimeAsset('${kind}', …) resolves nowhere — the managed-runtime paragraph has no subject`);
    const named = OS_LABELS.filter(([name]) => sentence.includes(name)).map(([name]) => name);
    assert.deepEqual(
      named,
      resolved,
      `PLATFORMS.md says a managed ${label} asset resolves for ${JSON.stringify(named)}; runtimeAsset() resolves one for ${JSON.stringify(resolved)}`,
    );
  }
  // The one deliberate hole, asserted from BOTH sides: the platform/arch pair
  // that has a Node asset and no Python one is the pair the document explains.
  const nodeOnly = OS_LABELS.flatMap(([name, platform]) => ARCHES
    .filter((arch) => runtimeAsset('node', platform, arch) !== null && runtimeAsset('python', platform, arch) === null)
    .map((arch) => `${name}/${arch}`));
  assert.deepEqual(
    nodeOnly,
    ['Windows/arm64'],
    `the asset maps give a managed Node and no managed Python to ${JSON.stringify(nodeOnly)}; PLATFORMS.md explains exactly Windows-on-ARM`,
  );
  assert.ok(
    FLAT.includes('Windows-on-ARM has a managed Node and no managed Python'),
    'PLATFORMS.md no longer explains the Windows-on-ARM hole it is the only asymmetry in the matrix',
  );
});

// ── project stacks ───────────────────────────────────────────────────────────

test('the surfaces the document lists are the ProjectSurface union, in order', () => {
  const types = read(path.join('src', 'shared', 'capabilities', 'types.ts'));
  const union = /export type ProjectSurface =([^;]+);/.exec(types);
  assert.ok(union, 'src/shared/capabilities/types.ts no longer declares ProjectSurface');
  const surfaces = [...(union![1] as string).matchAll(/'([\w-]+)'/g)].map((match) => match[1] as string);
  assert.ok(surfaces.length >= 3, `ProjectSurface has ${surfaces.length} member(s) — too few to be the surface list`);
  const stated = /surfaces \(([^)]+)\)/.exec(FLAT)?.[1];
  assert.ok(stated, 'PLATFORMS.md no longer lists the project surfaces it derives');
  assert.deepEqual(
    (stated as string).split(',').map((entry) => entry.trim()),
    surfaces,
    `PLATFORMS.md lists surfaces (${stated}); ProjectSurface is ${surfaces.join(', ')}`,
  );
});

// A PRESENCE claim. An unanchored /rust|cargo/i matches the English word
// "trust", which a release check has already been failed by. Over-matching
// would count an innocent case as "driving Rust" and let the document's
// exercised claim rest on a false positive, so the boundaries below stay
// load-bearing.
const RUST_TOKEN = /\brust\b|\bcargo\b/i;

test('a release-harness case drives Rust, which is what the stacks section says', () => {
  assert.equal(RUST_TOKEN.test('the codex hook trust store is verified'), false, 'the Rust pattern matches the word "trust" — anchor it');
  assert.equal(RUST_TOKEN.test('a trusted marketplace'), false, 'the Rust pattern matches "trusted" — anchor it');
  assert.equal(RUST_TOKEN.test('cargo build'), true, 'the Rust pattern no longer matches an actual Rust invocation');
  const cases = walk(path.posix.join('src', 'test-environment', 'config', 'cases'), (file) => file.endsWith('.ts'));
  assert.ok(cases.length >= 5, `found ${cases.length} harness case file(s) — a claim about all of them certifies nothing`);
  const driving = cases.filter((rel) => RUST_TOKEN.test(read(rel)));
  assert.ok(
    driving.length >= 1,
    'PLATFORMS.md says a case drives a Rust project; no harness case file mentions Rust — either the claim or the case list is stale',
  );
  assert.ok(
    driving.some((rel) => /backend:\s*'rust'/.test(read(rel))),
    `a case file mentions Rust but none declare backend: 'rust': ${JSON.stringify(driving)}`,
  );
  const stacks = /## Project stacks[\s\S]*?(?=\n## )/.exec(DOC)?.[0] ?? '';
  assert.ok(stacks.includes('## Project stacks'), 'PLATFORMS.md no longer has a Project stacks section');
  const stacksFlat = stacks.replace(/\s+/g, ' ');
  assert.ok(
    /Rust is exercised by the release harness/i.test(stacksFlat),
    'PLATFORMS.md no longer states that Rust IS exercised by the release harness',
  );
  assert.equal(
    /Rust is not exercised/i.test(stacksFlat),
    false,
    'PLATFORMS.md still claims Rust is not exercised',
  );
  assert.equal(
    /Treat Rust support as untested/i.test(stacksFlat),
    false,
    'PLATFORMS.md still tells the reader to treat Rust as untested',
  );
  const rustClaim = sentenceWith('Rust is exercised');
  for (const token of ['cargo', 'clippy', 'rustfmt', 'INCONCLUSIVE'] as const) {
    assert.ok(
      rustClaim.includes(token),
      `the Rust-exercised sentence no longer names ${token}: "${rustClaim}"`,
    );
  }
  assert.match(
    rustClaim,
    /INCONCLUSIVE.{0,80}(never a pass|rather than passing|not a pass)/i,
    `the Rust-exercised sentence no longer says a missing cargo/clippy/rustfmt is INCONCLUSIVE rather than a pass: "${rustClaim}"`,
  );
});

// ── the diagnostic the Node section hands the reader ─────────────────────────

test('the doctor command and finding code are the ones the runtime emits', () => {
  const hint = /Diagnose with: (node [^\s']+\.cjs)/.exec(nodeFloorGuardSource())?.[1];
  assert.ok(hint, 'the generated node-floor guard no longer prints a doctor hint');
  assert.ok(
    DOC.includes(`\`${hint}\``),
    `PLATFORMS.md does not print the diagnostic the launcher guard names: ${hint}`,
  );
  const findings = read(path.join('src', 'runners', 'doctor', 'findings.ts'));
  const code = 'HOOK_RUNTIME_NODE_BELOW_FLOOR';
  assert.ok(findings.includes(code), `src/runners/doctor/findings.ts no longer defines ${code}`);
  assert.ok(
    sentenceWith(code).includes(hint as string),
    `PLATFORMS.md names ${code} away from the command that produces it`,
  );
});
