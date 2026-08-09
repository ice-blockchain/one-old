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
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOST_CAPABILITIES, type TrafficOneHost } from '../src/shared/host/capability-schema';
import { UNCERTIFIED_HOST_OPT_OUT_ENV } from '../src/shared/host/tiers';
import { NODE_FLOOR_MAJOR } from '../src/shared/node-floor';
import { isTrafficOneDoctorCommand } from '../src/shared/tool-classify';
import { AUTH_OFFLINE_GRACE_MS, AUTH_REVALIDATION_CADENCE_MS } from '../src/config/auth';
import { GOLDEN_EXCLUDED } from '../src/build/golden-update';

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
  assert.ok(flat('PLATFORMS.md').includes('No configured host supports headless subagents'));
  assert.ok(flat('KNOWN-ISSUES.md').includes('Subagent round-trips are not certified on any host'));
});

// ── known issues ─────────────────────────────────────────────────────────────

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

// Item 11 names five filenames as the whole matched set and tells the reader
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
    'the legacy root-document set changed — KNOWN-ISSUES.md item 11 names it exhaustively',
  );
  const text = flat('KNOWN-ISSUES.md');
  for (const name of names) {
    assert.ok(text.includes(`\`${name}\``), `KNOWN-ISSUES.md item 11 does not name \`${name}\``);
  }
  // The other half of the promise: a COPY. If this ever moves the file again,
  // "not moved, renamed or deleted" becomes the most damaging sentence in the
  // document — it is the reason a reader leaves their own api.md at the root.
  const adopt = /function adoptLegacyRootDocumentationFile\b[\s\S]*?\n\}/.exec(cleanup)?.[0];
  assert.ok(adopt, 'adoptLegacyRootDocumentationFile is gone or reshaped');
  for (const destructive of ['movePath', 'removePath', 'rmSync', 'renameSync', 'unlinkSync']) {
    assert.ok(
      !adopt!.includes(destructive),
      `root-document adoption calls ${destructive} — KNOWN-ISSUES.md item 11 promises the root file is left in place`,
    );
  }
  assert.ok(adopt!.includes('writeTextFile'), 'the adoption no longer writes the copy item 11 promises');
});

// Item 12 tells the reader that an incomplete installation preserves everything
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
  // what item 12 used to have to warn the reader about. Asserted on the
  // STRUCTURE of the branch rather than on the deny text, because the deny text
  // is resolved from SKILL.md and interpolates the diagnosis, so it is never a
  // stable key.
  const handler = read(path.join('src', 'modules', 'onboarding-gate', 'handler.ts'));
  const arm = /if \(isMutatingPreToolUse\(toolName, toolInput\)\) \{\n([\s\S]*?)\n {4}\}\n {4}return context\(materialized\.context/
    .exec(handler)?.[1];
  assert.ok(
    arm,
    'the mutating arm of the convergence branch is gone or reshaped — item 12 describes what a file-changing call sees',
  );
  assert.match(
    arm!,
    /materialized\.status === 'materialized' \|\| materialized\.status === 'current'/,
    'the mutating arm stopped discriminating on STATUS. Every non-null outcome would render the repair paragraph again — '
    + '"state was repaired, rerun the same tool now" — for five statuses where nothing was repaired and rerunning cannot '
    + 'work, which is the defect KNOWN-ISSUES.md item 12 was rewritten to stop describing.',
  );
  assert.match(
    arm!,
    /block\('materialization-not-converged'.*\{ DIAGNOSIS: materialized\.context \}/s,
    'the non-converged arm no longer carries `materialized.context`, so the refusal has lost the diagnosis item 12 '
    + 'promises the reader — the missing entries, the counts, and the doctor command',
  );
  // …and the verdict must not have been softened along the way. Both arms deny.
  assert.equal(
    (arm!.match(/\bdeny\(/g) ?? []).length, 2,
    'the mutating arm no longer has exactly two deny() outcomes. Proceeding is what deletes content the plugin root '
    + 'cannot resupply, so the fix was to the REASON, never to the verdict.',
  );
  const text = flat('KNOWN-ISSUES.md');
  assert.ok(text.includes('An incomplete plugin installation refuses every file change'));
});

test('the Rust-is-unexercised claim is measured, not remembered', () => {
  const casesDir = path.join(REPO_ROOT, 'src', 'test-environment', 'config', 'cases');
  const offenders: string[] = [];
  for (const name of fs.readdirSync(casesDir)) {
    if (!name.endsWith('.ts')) continue;
    // Leading \b only: it keeps `trust`/`untrusted`/`crust` out while still claiming
    // `rustfmt`, `rustc` and `rust-lang`, which do mention Rust. A trailing \b would
    // drop those three; no boundary at all fails a case for writing ordinary English.
    if (/\brust|\bcargo/i.test(fs.readFileSync(path.join(casesDir, name), 'utf8'))) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    'a harness case now mentions Rust — KNOWN-ISSUES.md item 5 claims none does, and must be rewritten or removed',
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
  // one is what KNOWN-ISSUES.md item 7 promises.
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
    'the migration KNOWN-ISSUES.md item 7 promises is gone',
  );

  const privacy = flat('PRIVACY.md');
  assert.ok(privacy.includes('your first prompt is not in it'),
    'PRIVACY.md no longer states where the prompt is not');
  assert.ok(privacy.includes('~/.traffic-one/projects/<hash>/preferences.json`, under `originalPrompt`'),
    'PRIVACY.md no longer names the file the prompt IS in');
  // The residual, which is the part a reader has to act on themselves.
  const known = flat('KNOWN-ISSUES.md');
  assert.ok(known.includes('A prompt already pushed by an older version stays in your git history'));
  assert.ok(known.includes('use Traffic One here?'),
    'KNOWN-ISSUES.md no longer states that a project pending consent keeps its copy');
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
test('every doctor command SUPPORT.md prints is one the gate admits — except the mint, which must stay denied', () => {
  const commands = [...read('SUPPORT.md').matchAll(/node [^\n`]*?doctor\.cjs[^\n`]*/g)].map((match) => match[0]);
  assert.ok(commands.length >= 3, `SUPPORT.md no longer prints doctor commands (found ${commands.length})`);
  const resolve = (documented: string): string => documented
    .replace('<runId>', '1785169657252')
    .replace('<gateId>', 'architecture-contract-gate')
    .replace(' [--ttl 30m]', ' --ttl 30m');

  let diagnostics = 0;
  let mints = 0;
  for (const documented of commands) {
    const command = resolve(documented);
    if (documented.includes('--unblock')) {
      // The exemption grammar in shared/tool-classify.ts deliberately does not
      // admit `--unblock`, because the exemption exists so a STUCK SESSION can
      // diagnose itself — and minting an override is not diagnosis. An agent
      // must not inherit "no gate has an opinion" for the one command that
      // relaxes a gate. This asserts the security property, not a defect: the
      // day it flips, SUPPORT.md's "run this command yourself" stops being
      // true and this test says so.
      mints += 1;
      assert.equal(
        isTrafficOneDoctorCommand('Bash', { command }),
        false,
        `the override mint became gate-exempt: ${documented}`,
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
  assert.ok(diagnostics >= 3, `expected several diagnostic commands, found ${diagnostics}`);
  assert.equal(mints, 1, 'SUPPORT.md should print the override mint exactly once');
  assert.ok(
    flat('SUPPORT.md').includes('is not gate-exempt'),
    'SUPPORT.md must tell the reader why the mint cannot be run from inside a session',
  );
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
  // The TTY requirement is the one defence that holds against an agent, so a
  // `--yes` or an env bypass appearing would falsify the document's strongest
  // sentence.
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
