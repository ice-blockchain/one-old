// WHAT MATERIALIZATION ACTUALLY WRITES INTO A STATE ROOT, and the two claims in
// shared/retention.ts that rest on it.
//
// `MATERIALIZED_ENTRIES` names the entries the leaked-root heal may delete
// BECAUSE materialization wrote them. It is a claim about another module, and it
// was unpinned in both directions: nothing in the suite imported it, and nothing
// related it to materialization's output. Both directions are defects, in
// opposite ways —
//
//   a name materialization STOPS writing keeps its deletion authority here,
//   silently, and the heal then removes an entry nobody produces (the unsafe
//   one: the entry can only be a human's);
//   a name materialization STARTS writing is not recognised, so a leaked root
//   holding it is reduced rather than healed and reports a leftover forever
//   (the safe one, but still wrong, and nothing would say so).
//
// The pin is the real writer against a real 'installed' plugin root, not a
// re-derivation: the suite-wide root pinned by src/build/test-preload.mjs is this
// SOURCE checkout, which materializeProjectAssets refuses outright, so the
// fixture below symlinks `rules/` and `skills-catalog/` out of `src/modules/`
// exactly as torn-plugin-root.test.ts and consent-write-fence.test.ts do. No
// `dist/` is required and nothing is mocked.
//
// The second test pins the TABLE, one row per path with its admission argument;
// the third pins its DERIVATION, which is the part that failed last round (every
// row was a path a rule schedules, and a fold over them manufactured a name no
// rule schedules); the fourth pins that every recognised path has a PRODUCER in
// the source tree, which is the half of the `logs`/`retention.json` arguments a
// test can hold; and the fifth pins the shipped sentence that threw
// `retention.json` out of the table — the admission test is a question about
// what this product tells users, so the fact it turns on lives in the shipped
// corpus, not in a decision recorded here.
//
// It also pins the measurement that DELETED recognition's content arm. The arm
// was an unanchored scan for the GENERATED marker, sold as recognising "any file
// the runtime stamped" — but recognition only ever inspects TOP-LEVEL entries,
// and not one top-level entry of a materialized state root carries the marker.
// Its true-positive population was zero while its false positives were ordinary
// documents that quote a marker this repo documents publicly. Both halves are
// asserted below, the second one non-vacuously: marker-carrying files really do
// exist in the tree, one level down, where recognition never looks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MATERIALIZED_ENTRIES, RUNTIME_ENTRY_PATHS, sweepTrafficOneRetention } from '../retention';
import { GENERATED_MARKER } from '../materialize/generated';
import { materializeProjectAssets } from '../materialize/materialize';
import { pluginRootInfo } from '../paths';
import { resetPluginUseCache } from '../state/plugin-use';

const STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
  realtime: 'none',
  confirmed: true,
  onboardingComplete: true,
  mode: 'new-project',
} as const;

const MODULES = path.resolve(__dirname, '..', '..', 'modules');

function withInstalledRoot(host: 'codex' | 'claude', fn: (project: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-materialized-entries-')));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  fs.symlinkSync(path.join(MODULES, 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
  fs.symlinkSync(path.join(MODULES, 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');

  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });

  const env = process.env;
  const saved = {
    root: env.TRAFFIC_ONE_PLUGIN_ROOT,
    host: env.TRAFFIC_ONE_HOST,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    home: env.HOME,
    xdg: env.XDG_STATE_HOME,
  };
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_HOST = host;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  resetPluginUseCache();
  try {
    fn(project);
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_PLUGIN_ROOT: saved.root,
      TRAFFIC_ONE_HOST: saved.host,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function markerCarryingFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      let text: string;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (text.includes(GENERATED_MARKER)) out.push(path.relative(root, abs));
    }
  };
  walk(root);
  return out.sort();
}

// The two entries materialization writes that the heal deliberately does NOT
// recognise, both for the same reason: the directory is MIXED, so naming it
// would authorise deleting a hand-authored file in order to reclaim a generated
// one.
//
//   skills  — the shipped project-memory rule tells users to put local skills
//             such as `security-check` in `.traffic-one/skills/<name>/`.
//   agents  — `.traffic-one/agents/<role>.md`, written on CODEX only
//             (materialize.ts gates it on `detectHost() === 'codex'`), and
//             codex-agents.ts overwrites only files bearing its own marker
//             because "user-authored agents win". A directory whose writer
//             promises to preserve a user's file is a directory the heal may not
//             empty.
//
// The cost is named where it lands: on a Codex project, a leaked nested root is
// reduced rather than healed and reports `agents` as a leftover. That is the
// direction the ruling asks for — a leftover, never a loss — and this pin is how
// it stopped being invisible.
const MIXED_EXCLUSIONS = ['agents', 'skills'] as const;

/**
 * Every scheduled path that would let the heal delete something at or under
 * `entry`. Asked as a PREFIX question rather than as set membership because
 * recognition is path-aware: `reports` is in no row of the table and the heal
 * still reaches `reports/qa` through it, so "is this name in the set" is no
 * longer the question that decides whether an entry is safe.
 */
function authorityOver(entry: string): string[] {
  return RUNTIME_ENTRY_PATHS.filter((rel) => rel === entry || rel.startsWith(`${entry}${path.sep}`));
}

const REPO = path.resolve(__dirname, '..', '..', '..');

function walkFiles(root: string, keep: (abs: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(abs); continue; }
      if (entry.isFile() && keep(abs)) out.push(abs);
    }
  };
  visit(root);
  return out.sort();
}

test('MATERIALIZED_ENTRIES is exactly what materialization writes at the top of a state root', () => {
  withInstalledRoot('codex', (project) => {
    // FIXTURE: a root the writer will actually write to. Against the source
    // checkout it refuses, and every assertion below would then be about an
    // empty directory.
    assert.equal(pluginRootInfo().layout, 'installed', 'FIXTURE the fixture root must classify installed');

    const result = materializeProjectAssets(project, { ...STATE });
    assert.equal(result.skipped, undefined, `FIXTURE materialization must not be refused, got ${result.skipped}`);
    assert.ok(result.rules > 20, `FIXTURE the real rule spine must resolve, got ${result.rules}`);
    assert.ok(result.skills > 20, `FIXTURE the real skill set must resolve, got ${result.skills}`);

    const t1 = path.join(project, '.traffic-one');
    const top = fs.readdirSync(t1).sort();

    // The observed top level, verbatim, and BOTH directions in one assertion:
    // an entry missing from `top` is a name that kept deletion authority after
    // materialization stopped writing it (the unsafe direction), and an extra
    // one is a name materialization started writing that nothing recognises (a
    // leftover forever). A separate per-name loop for each direction was here
    // and is gone: with `top` pinned to exactly this set, and RUNTIME_ENTRY_PATHS
    // built by spreading MATERIALIZED_ENTRIES, neither loop had a reachable
    // failure — both mutants died on this line, never reaching them. Three
    // comments implying three independent checks where there was one.
    assert.deepEqual(top, [...MATERIALIZED_ENTRIES, ...MIXED_EXCLUSIONS].sort(),
      'the writer produced a top level this pin does not describe — a MISSING name still carries deletion '
      + 'authority in retention.ts with no producer, an EXTRA one is recognised by nothing and turns a leaked '
      + 'root holding it into a permanent leftover. Decide it against the MIXED test above, then update BOTH '
      + 'this test and MATERIALIZED_ENTRIES');

    // This one is NOT subsumed, and it is the direction that deletes: it fails
    // if a mixed name joins the table, which the assertion above cannot see.
    // Asked as a PREFIX question, because a row spelled `agents/<something>`
    // would grant authority inside a mixed directory just as surely as the bare
    // name would — that is the shape `reports/qa` has, and the shape a reviewer
    // reading only for exact names would miss.
    for (const name of MIXED_EXCLUSIONS) {
      assert.deepEqual(authorityOver(name), [],
        `${name} stays OUT of the table, at every depth: its directory holds hand-authored files too`);
    }
  });
});

// The whole deletion authority of the leaked-root heal, spelled out. The probe
// above pins the two names that come from ANOTHER module; this pins the table a
// reviewer has to agree with, so a path joining it is a diff in a file that
// states the argument for admission rather than a silent widening inside a
// derived expression.
//
// The admission test is the one recogniseEntries states: does anything shipped
// tell a user to author something under this path? Every row below answers no —
// which is why `skills`, `agents` and `retention.json`, where the answer is yes,
// are absent, and why `reports` is NOT A ROW while the two paths under it are.
//
// FOUR rows appear in shipped text beside an authoring verb, not three: `runs`,
// `digests`, `fix-cycles` and `debug` (SUPPORT.md:451 — "create
// `~/.traffic-one/debug/hook-trace.on`", the HOME state root, which
// listNestedTrafficOneDirs never leaves the project to reach). The count was
// wrong here because the audit behind it read four directories and the shipped
// bundle is a longer list; see the corpus test below.
//
// `retention.json` USED TO BE A ROW, with the comment "this file's own policy",
// which is the one entry here that never answered the question at all: it
// restated what the file is for. Asked properly the answer is YES — the shipped
// senior-eng-orchestrator skill tells the user "Projects may override retention
// counts with `.traffic-one/retention.json`" — and nothing in `src/` writes it,
// so an entry under that name in a leaked root can only be the user's. Measured
// destroying one with zero notices; see POLICY_FILE in retention.ts. A row whose
// comment does not answer the admission question is the shape to look for here.
test('recognition is exactly fourteen paths, and every one of them is argued for', () => {
  assert.deepEqual([...RUNTIME_ENTRY_PATHS].sort(), [
    '.codegraph-build-lock', // ephemeral lock, runtime-only, no shipped mention
    '.once',                 // one-shot markers, runtime-only, no shipped mention
    '.one.json',             // config/paths STATE_FILE
    '.opencode-heal-lock',   // ephemeral lock, runtime-only, no shipped mention
    'backups',               // project-memory/SKILL.md:98 — local/ephemeral, and
                             // pruned by `backupKeep` on every bootstrap
    'debug',                 // runtime diagnostics; the one authoring line
                             // (SUPPORT.md:451) is for the HOME state root
    'digests',               // RUN_SCOPED_DIRS: pruned by policy on EVERY
                             // project, and sweepOldDigests keeps 5 everywhere
    'fix-cycles',            // RUN_SCOPED_DIRS: same, and quality-findings.ts:148
                             // is the writer
    'manifest.json',         // materialization (MATERIALIZED_ENTRIES)
    'reports/lighthouse',    // TTL_ARTEFACT_DIRS, per-route cap. TWO SEGMENTS:
                             // `reports` itself is mixed and is NOT a row
    'reports/qa',            // RUN_SCOPED_DIRS, run-scoped. Two segments, same
                             // reason — see RUNTIME_ENTRY_PATHS in retention.ts
    'rules',                 // project-memory/SKILL.md:65,:105 — generated only
    'runs',                  // RUN_SCOPED_DIRS: pruned by policy on EVERY
                             // project; runIdNow() is the sole producer
    'runs/.once',            // subsumed by `runs` above, which is whole; it is a
                             // row because ONCE_DIRS schedules it by that name
  ], 'a path entered or left the heal\'s deletion authority — the comment beside each row is the admission '
    + 'argument, and a new row needs one of its own');
});

// ── the DERIVATION, which is what actually failed ────────────────────────────
// Every row above was a path a rule schedules, and the heal still held authority
// over a directory no rule schedules: the table was built by folding each path
// to its first segment, which turned `reports/qa` and `reports/lighthouse` into
// a bare `reports`. A per-row comment cannot catch that — there was no row to
// comment on — so the property is pinned instead: what recognition holds is
// exactly what the rules spell, verbatim, with nothing added by transformation.
//
// This is the structural half, and WHAT IT SEES IS ONE LINE OF SOURCE TEXT —
// stated here because the record around it used to claim this pin and its sibling
// were "still red on any widening", which is false and was measured false:
//
//   `recognitionTrie([...RUNTIME_ENTRY_PATHS, ...HEAL_ONLY])`   killed here, and
//     ONLY here: 99 of 100 tests passed.
//   the build line left VERBATIM and the trie mutated one statement below it
//     (`RECOGNITION.children.set(name, { whole: true, children: new Map() })`)
//     100/100 GREEN. `call` is `source.slice(build, source.indexOf('\n', build))`,
//     so a later line is not in the window at all.
//   a HEAL_ONLY Set consulted inside `recogniseEntries`, trie untouched
//     100/100 GREEN, and invisible to any assertion about the trie's contents —
//     including the obvious remedy of exporting RECOGNITION and deep-equalling
//     it, which was implemented on top of this mutant and passed 101/101.
//
// All three planned `AGENTS.local.md`, `graphify-out` and `token-log.jsonl` for
// deletion on a leaked member root. So this pin is kept for what it does buy — it
// is what made the fabricated-`reports` blocker checkable, and it is the cheapest
// place to notice a fold — and it is NOT the backstop.
//
// The backstop is BEHAVIOURAL and lives in retention.test.ts, in two directions:
// "every recognised path is one a rule in this file SCHEDULES" (the forward one,
// which a fabricated `reports` fails) and "the heal admits NOTHING the rule table
// does not spell, however the widening is written" (the converse, which is
// downstream of the trie, of recogniseEntries' arms and of anything post-hoc, and
// which kills all three mutants above).
test('the recognition table is a spread of the rule constants, not a fold over them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'retention.ts'), 'utf8');
  const start = source.indexOf('export const RUNTIME_ENTRY_PATHS');
  assert.ok(start > 0, 'FIXTURE the table is still exported under this name');
  const literalEnd = source.indexOf('\n];', start);
  assert.ok(literalEnd > start, 'FIXTURE the table is still an array literal');
  const literal = source.slice(start, literalEnd);

  // TWO disjoint windows, not the span between them. The trie builder that sits
  // between splits each path into its SEGMENTS, which is the correct reading of
  // a two-segment path rather than a fold over the table — a window that
  // swallowed it would red on the fix itself. The second window is the one line
  // that feeds the table to the builder, because a fold moved one statement down
  // does exactly what a fold inside the literal does.
  const build = source.indexOf('const RECOGNITION = ', start);
  assert.ok(build > start, 'FIXTURE the trie is still built from the table, below it');
  const call = source.slice(build, source.indexOf('\n', build));

  assert.match(literal, /\.\.\.RUN_SCOPED_DIRS/, 'FIXTURE it is still built from the rule constants');
  assert.match(call, /recognitionTrie\(RUNTIME_ENTRY_PATHS\)/,
    'the table reaches the trie whole. Anything between the two is a transformation, and a transformation here '
    + 'does not narrow recognition, it INVENTS entries. NOTE what this can and cannot see: it is a match on ONE '
    + 'LINE of source text, so a widening written below it, or inside recogniseEntries, passes here — measured, '
    + 'twice, both survivors. The behavioural converse in retention.test.ts is the pin that catches those');
  for (const fold of ['.map(', '.split(', '.slice(', '.replace(', 'basename(RUN', 'dirname(']) {
    for (const [where, text] of [['literal', literal], ['trie call', call]] as const) {
      assert.ok(!text.includes(fold),
        `the ${where} applies \`${fold}\` to the paths the rules spell. A transformation here does not narrow `
        + 'the table, it INVENTS entries: `.split(path.sep)[0]` manufactured a bare `reports` — a name no rule '
        + 'schedules — and handed the heal the whole directory, which destroyed a user\'s archived report. If a '
        + 'new fold is genuinely needed, the behavioural pin in retention.test.ts is the one that has to pass');
    }
  }
});

// ── the half of the `logs` and `retention.json` arguments a test can hold ────
// Both names left the table for the same reason stated twice: NOTHING WRITES
// THEM. That is a fact about the source tree, so it is checkable — and it is the
// only checkable thing about this table's rows that the deepEqual above does
// not already imply.
//
// ── WHAT THIS CHECK USED TO BE, AND WHY IT WAS NOT ONE ───────────────────────
// It admitted a file that contained `.traffic-one/<posix path>` OR the bare
// quoted last segment — `'<name>'` — anywhere in it. The second disjunct is a
// match on an ENGLISH WORD over the whole non-test source corpus, and it did all
// the work: three of the fourteen live rows passed on it alone, and so did six of
// fifteen plausible names that nothing writes at all. MEASURED, and the numbers
// are the argument: `evidence` occurs as a quoted token in 17 files and `cache` in
// 12, so adding either to the rule constants and to the literal above passed this
// whole fence with nothing anywhere writing `.traffic-one/evidence`. That is round
// 6's survivor in a new costume: a census satisfied by a word. (No source-file
// count is quoted here on purpose: it drifts with every lane that adds a module,
// and a stale figure in a sentence about rigour is the defect it describes.)
//
// ── WHAT IT IS NOW ───────────────────────────────────────────────────────────
// SPELLED UNDER A STATE ROOT, in one of exactly two shapes:
//
//   the literal `.traffic-one/<path>` in a string, bounded so `logs` is not
//     matched by `.traffic-one/logsomething`;
//   a `path.join`/`path.resolve` whose ARGUMENTS resolve to `.traffic-one`
//     followed by this path's segments, consecutively. Arguments resolve
//     through string literals, `'a' + 'b'` concatenations, and identifiers
//     bound corpus-wide to exactly one literal — which is what reaches
//     `path.join(cwd, '.traffic-one', CODE_GRAPH_BUILD_LOCK)` and
//     `path.join(cwd, memoryDir, 'reports', 'qa', …)`, the shapes the three
//     join-only rows are written in.
//
// WHAT IT STILL CANNOT SEE, stated here rather than discovered next round,
// because the sentence this replaced ("a name whose producer writes somewhere
// else would still pass") described a stronger check than the one that ran:
//
//   A WRITE IS NOT DISTINGUISHED FROM A READ OR A DELETE. A path only ever read
//     under a state root passes this. `retention.json` is the live example and
//     is exempt only because its one reader lives in retention.ts, which is
//     excluded from the corpus; a second module reading it would green this row
//     while nothing wrote the file. The question a writer-only check would ask
//     needs the call site's verb, which is a type-checker's job, not a regex's.
//   A NAME ASSEMBLED FROM A TABLE IS INVISIBLE. `path.join(root, STATE_DIR, rel)`
//     over a list of relative paths resolves to nothing here. That is not
//     hypothetical: it is the ONLY shape `.once` is written in, which is why
//     `.once` is the single carve-out below rather than a widening of the rule.
//   IT SAYS NOTHING ABOUT REACHABILITY. A producer that can only ever write into
//     the HOME state root still counts, because the string is the same one.
//
// The check is NECESSARY, never sufficient; the admission census below is the
// other half, and the per-row comments in the table above are the third.
const NO_PRODUCER_BY_DESIGN = ['logs', 'retention.json'] as const;

// The residue named above, as one row with its own argument rather than as a
// loosened predicate.
//
// `.once` is the LEGACY spelling of the once-marker directory. The live one is
// `runs/.once` (shared/once.ts, and it passes this check on its own), and the
// only writes that still reach the top-level name in `src/` come through a
// TABLE: test-environment/core/decline-sim.ts plants
// `path.join('.once', 'setup-link-nudge')` as pre-decline residue through
// `path.join(projectRoot, STATE_DIR, rel)`, and state/plugin-use.ts's
// DECLINE_ALWAYS_REMOVED names it the same way for removal. Both are invisible
// to a static argument match and neither is a bug.
//
// It is admitted on the corroboration a test CAN hold, asserted below rather
// than described: an independent module names it as a path a DECLINE sweep
// removes from a state root. That is another part of the runtime saying the
// runtime owns the name — weaker than a producer, which is why it is one row
// and not a rule, and why a second entry here needs its own diff and its own
// paragraph.
const PRODUCER_NOT_STATICALLY_VISIBLE = ['.once'] as const;

// Six names that nothing writes under a state root, each of which the OLD
// predicate admitted. They are the non-vacuity proof for the new one: the test
// below asserts BOTH that the bare token really does occur in the tree (so the
// old check really would have passed them) and that the new check refuses them.
// Without the first half a tightened predicate that refused everything would
// look identical to a correct one.
const NEVER_WRITTEN_CONTROL = ['cache', 'evidence', 'state', 'sessions', 'context', 'output'] as const;

let sourceTexts: readonly (readonly [string, string])[] | null = null;

function corpusSources(): readonly (readonly [string, string])[] {
  sourceTexts ??= walkFiles(path.join(REPO, 'src'), (abs) => abs.endsWith('.ts')
    && !abs.includes(`${path.sep}__tests__${path.sep}`)
    && !abs.endsWith(`${path.sep}retention.ts`))
    .map((abs) => [path.relative(REPO, abs), fs.readFileSync(abs, 'utf8')] as const);
  return sourceTexts;
}

/** `const NAME = '<literal>'`, corpus-wide, dropped when a name is ambiguous. */
let bindings: Map<string, string> | null = null;
function stringBindings(): Map<string, string> {
  if (bindings) return bindings;
  const seen = new Map<string, Set<string>>();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*((?:'[^'\n]*'|"[^"\n]*")(?:\s*\+\s*(?:'[^'\n]*'|"[^"\n]*"))*)\s*;/g;
  for (const [, text] of corpusSources()) {
    for (const match of text.matchAll(re)) {
      const value = [...match[2]!.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((part) => part[1] ?? part[2] ?? '').join('');
      const set = seen.get(match[1]!) ?? new Set<string>();
      set.add(value);
      seen.set(match[1]!, set);
    }
  }
  bindings = new Map([...seen].filter(([, set]) => set.size === 1).map(([name, set]) => [name, [...set][0]!]));
  return bindings;
}

function resolveArgument(raw: string): string | null {
  const token = raw.trim();
  const quoted = /^(?:'([^'\n]*)'|"([^"\n]*)")$/.exec(token);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  if (/^(?:'[^'\n]*'|"[^"\n]*")(?:\s*\+\s*(?:'[^'\n]*'|"[^"\n]*"))+$/.test(token)) {
    return [...token.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((part) => part[1] ?? part[2] ?? '').join('');
  }
  if (/^[A-Za-z_$][\w$]*$/.test(token)) return stringBindings().get(token) ?? null;
  return null;
}

/** Top-level comma split of one argument list, quote- and nesting-aware. */
function splitArguments(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (ch === '\\') { current += inner[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if ('([{'.includes(ch)) { depth += 1; current += ch; continue; }
    if (')]}'.includes(ch)) { depth -= 1; current += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

const pathCallCache = new Map<string, (string | null)[][]>();
function pathCallArguments(file: string, text: string): (string | null)[][] {
  const cached = pathCallCache.get(file);
  if (cached) return cached;
  const out: (string | null)[][] = [];
  for (const match of text.matchAll(/\bpath\.(?:join|resolve)\(/g)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let quote: string | null = null;
    let i = start;
    for (; i < text.length && depth > 0; i += 1) {
      const ch = text[i]!;
      if (quote) { if (ch === '\\') { i += 1; continue; } if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth !== 0) continue; // an unbalanced slice is not an argument list
    out.push(splitArguments(text.slice(start, i - 1)).map(resolveArgument));
  }
  pathCallCache.set(file, out);
  return out;
}

const STATE_DIR_NAME = '.traffic-one';

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function producers(rel: string): string[] {
  const segments = rel.split(path.sep);
  const spelled = new RegExp(`(^|[^\\w./-])${escapeRe(`${STATE_DIR_NAME}/${segments.join('/')}`)}(?![\\w.-])`);
  return corpusSources().filter(([file, text]) => {
    if (spelled.test(text)) return true;
    return pathCallArguments(file, text).some((tokens) => tokens.some((token, at) => token === STATE_DIR_NAME
      && segments.every((segment, offset) => tokens[at + 1 + offset] === segment)));
  }).map(([file]) => file);
}

// ── the derived count shared/retention.ts's header prices its residue against ──
// That header's argument is arithmetic: the runtime spells MANY more top-level
// names under a state root than recognition holds, so the leaked-root heal leaves
// a residue, and the residue has to be disclosed rather than assumed away. The
// count behind it was derived by hand in a scratch driver nobody else holds, and
// two rounds running it drifted — a stale "704 source files" sat in the comment
// beside it. So it is RECOMPUTED here, by the same two shapes the census uses,
// which is the move that stopped this class for the deny-id figures.
//
// THE FLOOR HAS NO MARGIN, and reading it as load-bearing is the mistake to avoid.
// MEASURED with the instrument's second shape switched off in a snapshot copy: the
// derivation answers 55 names, exactly 10 of which reach it ONLY through the
// `path.join` arm, so with that arm dead it answers exactly 45 — this number,
// re-derived at load 9.59 in a literal-only replica and still exactly 45. A whole
// arm of the instrument can therefore die without moving this assertion.
//
// TWO ASSERTIONS CATCH IT, and the version of this paragraph that named only the
// second is the single-instrument claim this lane keeps having to correct. In test
// ORDER:
//   THE PRODUCER CENSUS, one test earlier — `.codegraph-build-lock` and
//     `.opencode-heal-lock` reach `producers()` ONLY through the join arm (measured
//     in the same replica: with a literal-only instrument BOTH have zero producers,
//     alongside the documented `.once` carve-out), so with that arm dead the
//     spelled-under-a-state-root test reds by name first, with a message about a
//     deletion authority whose producer cannot be found. That is the better failure
//     of the two: it names a RECOGNISED path rather than a residue count.
//   THE HEADER_RESIDUE LOOP below, which names individual entries: SEVEN of those
//     ten (`machine.json`, `onboarding`, `onboarding-complete.json`,
//     `onboarding-server.json`, `onboarding-server.lock`, `one-mcp-report.json`,
//     `preferences.json`) are enumerated there and would red one by one.
// The floor's remaining job is the OTHER direction — the runtime genuinely
// shrinking — and its residual vacuity is exact: 23 of the 55 names are anchored by
// name (HEADER_RESIDUE plus the six non-vacuity probes), so up to 10 unanchored
// names can disappear before anything here says a word.
const RESIDUE_FLOOR = 45;

/**
 * Every top-level name the corpus spells under a state root, both shapes.
 *
 * Its left boundary is deliberately LOOSER than `producers`': a preceding `/` is
 * allowed, so `rm ~/.traffic-one/overrides/<hash>` counts. That direction is safe
 * HERE and would not be there — a false positive makes the residue look bigger,
 * which tightens the floor below, while in `producers` it would hand a name a
 * deletion authority on the strength of a path in a comment. Same two shapes,
 * opposite tolerance, because the two instruments answer opposite questions.
 */
function topLevelNamesUnderStateRoot(): string[] {
  const names = new Set<string>();
  const literal = new RegExp(`(?<![\\w.-])${escapeRe(`${STATE_DIR_NAME}/`)}([A-Za-z0-9._-]+)`, 'g');
  for (const [file, text] of corpusSources()) {
    for (const match of text.matchAll(literal)) names.add(match[1]!);
    for (const tokens of pathCallArguments(file, text)) {
      for (const [at, token] of tokens.entries()) {
        if (token !== STATE_DIR_NAME) continue;
        const next = tokens[at + 1];
        if (next && /^[A-Za-z0-9._-]+$/.test(next)) names.add(next);
      }
    }
  }
  // A capture stopping at a character outside the class leaves a trailing `.`
  // (`manifest.json.` out of `manifest.json.tmp`), and `.`/`..` are not names.
  // Dropping them is not cosmetic: they are the artefacts that made a hand-run
  // derivation's count differ from this one's, which is how the number in the
  // header came to be quoted as instrument-dependent rather than as a total.
  return [...names].filter((name) => !name.endsWith('.')).sort();
}

// The TWENTY the header enumerates as written-but-unrecognised. Held here so
// the enumeration is a claim a run can refuse: one of them was missing from that
// list for two rounds while the count above it said eighteen, and then a
// nineteenth (`.one.json.report-id.lock`) was missing while it said eighteen.
// The figure in that sentence, and in every other sentence that states it, is
// pinned by POPULATION_PROSE below — see it for why a count in prose is worse than
// no count until something checks it.
//
// WHAT EACH NAME'S PLACE HERE RESTS ON, measured per name against THIS loop's own
// instrument (`topLevelNamesUnderStateRoot`, not `producers` — the two have
// deliberately opposite tolerances and give different answers, which is itself a
// thing to know before quoting either):
//
//   `overrides` is the ONE name whose every piece of evidence is a COMMENT: five
//     of them, all prose about deleting an override ledger
//     (`rm ~/.traffic-one/overrides/<hash>` in override/mint-counter.ts,
//     override/integrity.ts, override/reconcile.ts, run-settlement/io.ts). The
//     derivation's deliberately looser left boundary is what admits them, and
//     `producers()` — the strict instrument — finds nothing at all for this name.
//     So editing a comment in an unrelated module reds a retention test, and that
//     is the cries-wolf direction being live rather than hypothetical.
//   `AGENTS.local.md` has exactly one non-comment line, and it is not a writer
//     either: `TAKEOVER_NOTICE` in materialize/render-agents.ts, a sentence of
//     PROSE inside a string. Its real producer is `localContextName`, an
//     expression the instrument cannot see — the same blind spot that hid its twin.
//   NINE names rest on a SINGLE line each, seven of them the one table in
//     state/traffic-one-paths.ts plus config/reporting.ts, config/token-logger.ts
//     and qa-report-v2/schema.ts. A refactor of that table reds this loop.
//   `.onboarding-main-sessions.json` is corroborated three times, TWO of them in
//     `*.test.ts` files that escape this corpus's filter (it excludes `__tests__/`
//     DIRECTORIES, not files named `*.test.ts` elsewhere). The third is a real
//     module (onboarding-server/onboarding-session.ts), so the name does not
//     depend on the tests — but the corpus's shape does, and it is recorded here
//     rather than discovered.
//   `.one.json.report-id.lock` rests on NOTHING this instrument can see, and it is
//     the second name to reach this list that way. state/project-state-lock.ts:750
//     returns `${path.join(path.resolve(cwd), STATE_FILE)}.report-id.lock`, so the
//     derivation finds `.one.json` and never the lock beside it, while the
//     directory is a genuine top-level entry of a PROJECT state root — with a
//     sibling family (`<lock>.<token>.pending`, `.released`) whose names cannot be
//     enumerated at all. It is in the list as a DISCLOSURE with an assertion that
//     the instrument is blind to it; what actually covers it is the derived
//     partition pin below, and only because it is planted there by hand.
//   `.one.json.corrupt` is the THIRD name to reach this list past the instrument,
//     and the first one holding bytes that exist only because nobody could read
//     them. state/normalize.ts:329 writes `${filePath}${CORRUPT_STATE_SUFFIX}` next
//     to the state file it is replacing, so the derivation sees `.one.json` and
//     never this, exactly as with the lock. It is the same template class the
//     traffic-one-reset obligations census calls the last one BOTH its instruments
//     missed (`${<path>}${SUFFIX}` quarantine copies), which is the reason to stop
//     treating a short enumeration here as bad luck.
// This is a disclosure, not a defect list: every one of these reds SAFELY (a
// retention test complaining that the header is out of date). The cost is a
// misleading failure MESSAGE in a file the editor was not working on.
const HEADER_RESIDUE = ['.agentignore', '.gitnexus', '.one.json.corrupt', '.one.json.report-id.lock',
  '.onboarding-main-sessions.json', 'AGENTS.local.md',
  'CLAUDE.local.md', 'deployments.jsonl', 'graph-preview.md', 'graphify-out', 'machine.json',
  'onboarding', 'onboarding-complete.json', 'onboarding-server.json', 'onboarding-server.lock',
  'one-mcp-report.json', 'overrides', 'preferences.json', 'qa-build-identity.json', 'token-log.jsonl'] as const;

// And the ones the instrument CANNOT see, which is exactly why that list keeps
// coming up short: render-agents' `localContextName` returns `CLAUDE.local.md` or
// its twin out of a conditional and its only other spelling reads a table, and the
// report-id lock is a template literal over STATE_FILE. A derivation over string
// literals and `path.join` arguments finds `AGENTS.local.md` and `.one.json` and
// never either of these. Asserted as ABSENCES below, so each blind spot is a claim
// a run can refuse rather than a story about how a number went wrong — and if a
// producer ever spells one plainly, the absence reds and the header is due an edit.
//
// THE HONEST READING OF A LIST WITH THREE OF THESE IN IT: an enumeration of names
// is the wrong instrument for anything assembled by an expression, and three is
// not the total either — it is however many somebody has thought of. The derived
// partition pin below is what does not depend on the enumeration being complete —
// for the names it plants.
const HEADER_RESIDUE_NOT_STATICALLY_VISIBLE = [
  'CLAUDE.local.md', '.one.json.report-id.lock', '.one.json.corrupt'] as const;

/**
 * The backticked names between `<MARKER>:` and `:<MARKER>-END`, sorted, as a LIST.
 *
 * Three things are asserted rather than assumed, and each one is a shape that
 * defeated a predecessor of the caller below:
 *
 *   THE MARKERS ARE UNIQUE. `indexOf` answers the FIRST occurrence, so a later
 *     cross-reference quoting the opening anchor moves an enumeration's left edge
 *     silently. A duplicate is a FIXTURE failure naming itself instead.
 *   THE REGION HOLDS NOTHING BUT NAMES. Strip the backticked tokens, the comment
 *     punctuation and the separators, and what remains must be empty — otherwise a
 *     sentence written between the markers is read as an enumeration entry, or
 *     (worse, and this is the one that happened) a name deleted from the list is
 *     still "present" because prose beside it says its name.
 *   NAMES ARE NOT REPEATED, because a set comparison cannot tell a duplicated entry
 *     from a missing one and this is meant to red on both.
 */
function markedEnumeration(source: string, marker: string): string[] {
  const open = `${marker}:`;
  const close = `:${marker}-END`;
  const occurrences = (needle: string): number => source.split(needle).length - 1;
  assert.equal(occurrences(open), 1,
    `FIXTURE \`${open}\` must occur EXACTLY once in retention.ts — found ${occurrences(open)}. A second `
    + 'occurrence (a cross-reference, a second copy of the list) makes the region this reads start or stop '
    + 'somewhere nobody chose, which is the exact way the prose-anchored version of this pin stopped failing');
  assert.equal(occurrences(close), 1,
    `FIXTURE \`${close}\` must occur EXACTLY once in retention.ts — found ${occurrences(close)}`);
  const start = source.indexOf(open) + open.length;
  const end = source.indexOf(close);
  assert.ok(end > start, `FIXTURE \`${close}\` must come after \`${open}\``);
  const region = source.slice(start, end);
  const names = [...region.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  assert.equal(new Set(names).size, names.length,
    `FIXTURE ${marker} enumerates a name twice, and a set comparison would read the duplicate as a match for `
    + `something else: ${names.join(', ')}`);
  const residual = region
    .replace(/`[^`\n]+`/g, '')
    .replace(/^[ \t]*(\/\/|\*)/gm, '')
    .replace(/[\s,]/g, '');
  assert.equal(residual, '',
    `FIXTURE the ${marker} region must be an enumeration and nothing else — anything backticked in it is read as `
    + `a NAME and any prose in it makes this pin satisfiable by a mention. Found outside the names: ${residual}`);
  return names.sort();
}

/** The predicate this replaced, kept ONLY to prove the control set is real. */
function bareQuotedToken(rel: string): string[] {
  const literal = `'${rel.split(path.sep).slice(-1)[0]!}'`;
  return corpusSources().filter(([, text]) => text.includes(literal)).map(([file]) => file);
}

test('every recognised path is spelled under a state root, and the two excluded names are not', () => {
  for (const rel of RUNTIME_ENTRY_PATHS) {
    if ((PRODUCER_NOT_STATICALLY_VISIBLE as readonly string[]).includes(rel)) continue;
    assert.ok(producers(rel).length > 0,
      `${rel} is recognised — the heal may delete an entry under it — and nothing outside retention.ts spells it `
      + 'under a state root, as a `.traffic-one/<path>` literal or as path.join arguments. That is the `logs` '
      + 'shape exactly: a deletion authority over a name only a human could have created, held for a producer '
      + 'that does not exist. If the producer is real and merely assembles the name from a table, it belongs in '
      + 'PRODUCER_NOT_STATICALLY_VISIBLE with a paragraph of its own — not in a loosened predicate');
  }

  // The carve-out, and the corroboration it rests on. Asserted from the other
  // module's own source so "another part of the runtime owns this name" is a
  // fact rather than a claim in a comment.
  assert.deepEqual([...PRODUCER_NOT_STATICALLY_VISIBLE], ['.once'],
    'one row, and a second one needs its own argument rather than a place in this list');
  const declineSweep = fs.readFileSync(path.join(REPO, 'src', 'shared', 'state', 'plugin-use.ts'), 'utf8');
  assert.match(declineSweep, /const DECLINE_ALWAYS_REMOVED = \[[^\]]*'\.once'[^\]]*\] as const;/,
    '`.once` is admitted on this corroboration and nothing else: an independent module names it among the paths '
    + 'a DECLINE sweep removes from a state root, which is the runtime saying the runtime owns the name. If that '
    + 'list stops naming it, the carve-out has no support left and the row has to go or be re-argued');
  assert.ok(producers(path.join('runs', '.once')).length > 0,
    'while the LIVE spelling of the same idea is visible in the ordinary way — shared/once.ts writes it');

  for (const rel of NO_PRODUCER_BY_DESIGN) {
    assert.deepEqual(producers(rel), [],
      `${rel} is excluded from the table on the grounds that nothing in src/ writes it. Something now spells it `
      + 'under a state root, so the exclusion has to be re-argued on its other half (does anything shipped tell '
      + 'a USER to author it?) rather than left standing on a premise that changed. Note this check cannot tell '
      + 'a write from a read: a new READER of the path reds this too, and that is the direction to fail in');
    assert.deepEqual(authorityOver(rel), [], `${rel} is not in the table while that is true`);
  }
});

// The instrument, shown to be sharp. Six names the old check admitted with
// nothing writing them: this asserts the old check really would have (the bare
// token is in the tree) and that the new one refuses them. A predicate that
// refused everything would pass the loop above's negative half and fail here.
//
// AND THE WARNING THIS COMMENT USED TO CARRY WAS TOO PESSIMISTIC, which is worth
// correcting because a fence believed to be weaker than it is invites a rewrite.
// It said the exploit leaves "every other pin in this fence green". MEASURED this
// round on a byte-identical copy, adding `workspace` — the realistic exploit
// name — to EPHEMERAL_LOCKS: four reds, not one, and they are independent
// instruments. "recognition is exactly fourteen paths, and every one of them is
// argued for", "every recognised path is spelled under a state root", "the
// admission census is pinned file by file" and "every recognised path is one a
// rule in this file SCHEDULES" all fail. Then the careless relaxation — restoring
// the bare-quoted-token disjunct to `producers()` to green the census — STILL
// leaves four: the loop below fires on the relaxation itself, and the other three
// fire on the widening, which is what "independent" has to mean to be worth
// anything.
test('the producer census refuses a name that is merely a word in the source tree', () => {
  for (const rel of NEVER_WRITTEN_CONTROL) {
    const token = bareQuotedToken(rel);
    assert.ok(token.length > 2,
      `FIXTURE '${rel}' must still occur as a quoted token in src/, or this control proves nothing about the `
      + `predicate that admitted it — found ${token.length} file(s)`);
    assert.deepEqual(producers(rel), [],
      `${rel} is not written under a state root by anything, and the census must not admit it. The exploit is `
      + 'exactly this: add such a name to the rule constants and to the table literal, and claim the rule as its '
      + 'own justification');
    assert.deepEqual(authorityOver(rel), [], `FIXTURE ${rel} is not in the table either`);
  }
});

test('the residue the retention header prices is recomputed here, not recited there', () => {
  const spelled = topLevelNamesUnderStateRoot();

  // NON-VACUITY first: an instrument that saw nothing would satisfy every
  // inequality below by making the residue look small.
  for (const known of ['runs', 'digests', 'rules', 'skills', 'manifest.json', 'reports']) {
    assert.ok(spelled.includes(known), `FIXTURE the derivation must see \`${known}\`, got ${spelled.length} names`);
  }
  assert.ok(spelled.length >= RESIDUE_FLOOR,
    `the retention header's residue argument rests on the runtime spelling far more top-level names than `
    + `recognition holds. The derivation now answers ${spelled.length}, below the floor of ${RESIDUE_FLOOR} that `
    + 'argument was written against: either the instrument regressed or the runtime shrank, and the header is due '
    + `a re-derivation either way — ${spelled.join(', ')}`);

  const recognisedTop = new Set(RUNTIME_ENTRY_PATHS.map((rel) => rel.split(path.sep)[0]!));
  const unrecognised = spelled.filter((name) => !recognisedTop.has(name));
  assert.ok(unrecognised.length > spelled.length / 2,
    `recognition is a MINORITY of what the runtime spells, and that is the whole reason the leaked-root heal `
    + `discloses a residue instead of claiming a full reclaim. Got ${unrecognised.length} unrecognised of `
    + `${spelled.length}: if recognition has genuinely grown to a majority, the header's arithmetic and its `
    + 'REDUCED notice are both due a rewrite');

  // The enumeration itself, as a claim a run can refuse rather than a list in a
  // comment — every name the header calls written-but-unrecognised is one the
  // corpus really spells, and none of them has quietly acquired a rule.
  for (const name of HEADER_RESIDUE) {
    const blind = (HEADER_RESIDUE_NOT_STATICALLY_VISIBLE as readonly string[]).includes(name);
    assert.equal(spelled.includes(name), !blind,
      `${name} is enumerated in shared/retention.ts's header as a name the runtime writes and recognition does `
      + `not hold. The derivation ${blind ? 'is not supposed to see it, and did' : 'cannot see it'}, so either the `
      + 'producer moved or the header is enumerating a name nothing writes — the second is the `logs` defect one '
      + 'level up, in prose');
    assert.ok(!recognisedTop.has(name),
      `${name} is now RECOGNISED, so the heal may delete it, while the header still prices it as residue the heal `
      + 'leaves behind. The admission question for it has to be answered in that header before this greens');
  }
  // ── THE COUNT IS RETIRED, AND WHAT REPLACES IT ─────────────────────────────
  // This assertion used to be `HEADER_RESIDUE.length === 19`, against a heading in
  // retention.ts that spelled the same figure in words. The pair caught nothing
  // three times running, and it could not: each time the list was short by a name
  // assembled from an expression, and BOTH sides were edited to agree on the wrong
  // number. A count cannot notice a name nobody wrote down. The figures went
  // seventeen-under-eighteen, then eighteen with `.one.json.report-id.lock`
  // missing, then nineteen with `.one.json.corrupt` missing — the last one holding
  // the user's only copy of unparseable state bytes.
  //
  // WHAT THIS LIST HONESTLY IS: an enumeration wearing a derivation's clothes. The
  // three blind names above are in it because somebody read a writer, not because
  // anything here found them, and `topLevelNamesUnderStateRoot` is asserted to be
  // UNABLE to see them. So the only claim worth making is CORRESPONDENCE — the list
  // and the prose that quotes it say the same thing — which is checkable, does not
  // go stale on the next `${}`, and reds on the one edit that used to be free
  // (adding a name here and not to the header, or the reverse).
  //
  // WHAT WOULD ACTUALLY BOUND THE CLASS, so the limit is a shape rather than a
  // shrug: every miss so far is `${<something>}<literal suffix>` where the prefix is
  // a path the derivation already sees. Bounding it needs the call site's
  // EXPRESSION evaluated — which template literals a writer applies to STATE_FILE
  // or to a state-rooted `path.join`, transitively — and that is a type-checker's
  // job, the same conclusion the producer census reached about telling a write from
  // a read. Until something does that, this list is a sample of an open set, and
  // the pin that does not depend on it being complete is the derived partition
  // below (for the names planted there).
  //
  // ── THE REVERSE DIRECTION, AND TWO PREDECESSORS THAT COULD NOT FAIL ─────────
  // The claim above ("or the reverse") was FALSE twice, one scope apart, and both
  // versions failed the same way: they asked whether a name was MENTIONED in a
  // region rather than whether it was IN A LIST.
  //
  //   OVER THE WHOLE FILE — `retentionSource.includes(\`${name}\`)`. A backticked
  //     token occurs all over a file that argues about these names one paragraph at
  //     a time. MEASURED on a copy with `.one.json.corrupt` removed from both
  //     enumerations (load 5.73 of 10 CPUs): 14/14 green. The name still appeared at
  //     four other places, one of them the sentence explaining how the retired COUNT
  //     went stale — so the pin was satisfied in perpetuity by prose about its own
  //     predecessor's failure.
  //   OVER A WINDOW BETWEEN TWO PROSE ANCHORS — `indexOf('//   RUNTIME ARTEFACTS
  //     WITH NO RETENTION RULE')` to `indexOf('//     NO COUNT IS QUOTED HERE ANY
  //     MORE')`, guarded by `length < 2000`. Smaller haystack, same vacuity, and the
  //     peer built both shapes: (a) the window CONTAINS the paragraph that names
  //     three of these entries while recounting how each went missing, so a name
  //     deleted from the enumeration is still "in the window" — survived 118/118;
  //     (b) `indexOf` takes the FIRST occurrence, so an earlier cross-reference
  //     quoting the opening sentence moves the left edge and swallows everything up
  //     to the real bullet, and the length guard does not notice because the guard
  //     bounds a size, not a location.
  //
  // So both enumerations now carry MARKERS, and this reads what is between them:
  //   * the marker pair must occur EXACTLY ONCE each — the (b) shape becomes a
  //     FIXTURE red naming the duplicate instead of a silent widening, and it does
  //     not depend on a prose sentence staying worded the way it is today;
  //   * the marked region must be an enumeration and NOTHING ELSE, asserted by
  //     stripping the names and requiring the remainder to be empty, so the (a)
  //     shape cannot come back by someone writing a sentence inside the markers;
  //   * and the comparison is SET EQUALITY, not a per-name `includes` — which also
  //     buys the direction neither predecessor had: a name added to the header and
  //     not to this list reds too.
  //
  // MEASURED, five arms on a copy of the tree (both suites of this fence per arm,
  // load 8.46-15.10 of 10 CPUs). Reachability is the first column because a
  // survivor on a fixture that never ran is an absent fixture, not an equivalence —
  // every arm ran all 129 rows, and the baseline with no edit is green:
  //   129 rows  `.one.json.corrupt` deleted from BOTH enumerations, prose left
  //             standing            KILLED (set equality). This is the arm that
  //             survived 118/118 against the windowed predecessor.
  //   129 rows  a paragraph above the bullet spelling the opening marker
  //                                 KILLED (marker uniqueness, naming the duplicate)
  //   129 rows  a backticked phrase written between the markers
  //                                 KILLED (the region holds names and nothing else)
  //   129 rows  `retention.json` added to the header list only
  //                                 KILLED (the reverse direction, which neither
  //                                 predecessor had at all)
  //   129 rows  `overrides` enumerated twice
  //                                 KILLED (a set comparison reads a duplicate as a
  //                                 match for the name that is missing)
  // The uniqueness guard also fired on its own first use, which is the cheapest
  // possible evidence that it is live: the sentence introducing the markers in
  // retention.ts spelled the closing one, and this test red until it stopped.
  //
  // BOTH enumerations are read, where the previous version declined the second one.
  // recogniseEntries' list wrote "the four `onboarding*` entries" as shorthand,
  // which a token match cannot expand; the brief's instruction was to change what
  // the enumeration looks like rather than keep a pin that cannot fail, so the four
  // names are spelled there now and the list is asserted name by name.
  const retentionSource = fs.readFileSync(path.join(__dirname, '..', 'retention.ts'), 'utf8');
  const expected = [...HEADER_RESIDUE].sort();
  for (const [marker, what] of [
    ['RESIDUE-LIST', 'the header bullet that prices the residue'],
    ['NO-RULE-LIST', "recogniseEntries' list of the names with no rule at all"],
  ] as const) {
    assert.deepEqual(markedEnumeration(retentionSource, marker), expected,
      `${what} and this list are one claim in two places — the header prices a residue it names, this literal is `
      + 'that naming as something a run can refuse — so a name in one and not the other leaves retention.ts '
      + 'describing a tree it is not describing. Read as an ENUMERATION between markers, because both '
      + 'predecessors of this assertion (the whole file, then a window between two prose anchors) were satisfied '
      + 'by a MENTION and were measured surviving a deleted name');
  }
});

/**
 * ── WHERE THE RETIRED COUNT WENT, AND WHY IT WENT STALE THERE TOO ────────────
 * `HEADER_RESIDUE.length === 19` was retired for a sound reason (a count cannot
 * notice a name nobody wrote down, and both sides were edited to agree on the wrong
 * number three times). What nobody noticed is that the figure did not leave — it
 * MOVED INTO PROSE, in five sentences across two files, where it was both unpinned
 * and wrong: four still said nineteen and one said eighteen against a population of
 * twenty. An unpinned figure in a paragraph is worse than no figure, because a
 * reader takes a spelled-out number as something somebody checked.
 *
 * So the figure is pinned WHERE IT IS STATED rather than reintroduced as a bare
 * count over the list. Each row names a sentence and the offset it states the
 * population at — 0 for "the twenty residue names", -1 for "unlike the other
 * nineteen", which excludes the entry that sentence is about. This cannot replace
 * the correspondence assertion above and does not try to: a count still cannot see
 * a missing name. What it does is make every restatement of the size fail together
 * with the list, so the next name to join the enumeration cannot leave five
 * paragraphs quietly describing the population before it.
 */
const NUMBER_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
  'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five'] as const;

const POPULATION_PROSE: readonly {
  readonly file: string;
  readonly re: RegExp;
  readonly offset: number;
  readonly what: string;
}[] = [
  {
    file: 'retention.ts',
    re: /the ([a-z-]+) residue names the[\s*]+header enumerates/g,
    offset: 0,
    what: "the REDUCED notice's disclosure, listing what the heal leaves behind",
  },
  {
    file: 'retention.ts',
    re: /is unlike the other ([a-z-]+) in three ways/g,
    offset: -1,
    what: "the lock's admission argument, which counts the population WITHOUT it",
  },
  {
    file: 'retention.ts',
    re: /the[\s*]+enumeration is ([a-z-]+) now/g,
    offset: 0,
    what: 'the re-measured cost of a HEAL_ONLY list, qualifying its own older figures',
  },
  {
    file: 'materialized-entries.test.ts',
    re: /The ([A-Z-]+) the header enumerates as written-but-unrecognised/g,
    offset: 0,
    what: 'the heading of this file\'s own copy of the enumeration',
  },
  {
    file: 'materialized-entries.test.ts',
    re: /literal is the ([a-z-]+) runtime residue names/g,
    offset: 0,
    what: 'the incremental value the by-hand fixture names are there to buy',
  },
];

test('every sentence that states the SIZE of the residue population states the right size', () => {
  const sources = new Map([
    ['retention.ts', fs.readFileSync(path.join(__dirname, '..', 'retention.ts'), 'utf8')],
    ['materialized-entries.test.ts', fs.readFileSync(path.join(__dirname, 'materialized-entries.test.ts'), 'utf8')],
  ]);
  for (const row of POPULATION_PROSE) {
    const text = sources.get(row.file)!;
    const hits = [...text.matchAll(row.re)];
    // Exactly once, so that a sentence copied or reworded is a red naming the site
    // rather than a pin that silently stopped reading anything.
    assert.equal(hits.length, 1,
      `${row.file}: ${row.what} — this pin found ${hits.length} sentences matching ${row.re}, and it is written to `
      + 'find exactly one. A reworded sentence is not a failure of the count, but it is a failure of the pin, and '
      + 'the pin says so instead of greening on a figure it can no longer see');
    const stated = hits[0]![1]!.toLowerCase();
    const expected = NUMBER_WORD[HEADER_RESIDUE.length + row.offset]!;
    assert.equal(stated, expected,
      `${row.file}: ${row.what} says "${stated}" where the enumeration holds ${HEADER_RESIDUE.length} names`
      + `${row.offset === 0 ? '' : ` (${expected} excluding the one it is about)`}. This is the figure that was `
      + 'retired as an assertion and kept as prose in five places; it is pinned here so the two cannot part again');
  }
});

// ── THE CONVERSE, DERIVED FROM THE FIXTURE'S OWN LISTING ─────────────────────
// retention.test.ts holds a behavioural converse pin — "the heal admits NOTHING
// the rule table does not spell, however the widening is written" — and it kills
// the three widenings that round's mutation table names. What it protects,
// though, is the SPELLINGS IN ITS OWN LITERAL, and that enumeration is provably
// incomplete TODAY. MEASURED: M3's exact shape (a `HEAL_ONLY` set consulted in
// `recogniseEntries`' `if (!child)` arm) naming `.traffic-one/.one.json.report-id.lock`
// and `cursor-models.json` survives the whole fence 107/107 green with the arm
// CONSULTED 124 times and admitting ZERO — an ABSENT FIXTURE, not an
// equivalence. Driven through the real APPLY sweep the same mutant plans and
// deletes both (`removed` 2 → 4) while the REDUCED notice drops from three
// leftovers to one and names neither.
//
// So the partition is asserted over the FIXTURE'S OWN LISTING instead of over a
// list of names: for every entry `readdirSync` reports in the leaked root,
// something at or under it is planned IF AND ONLY IF `RUNTIME_ENTRY_PATHS`
// spells it — the prefix question `authorityOver` already asks, and the same
// question the heal itself is supposed to be answering. No name in this test is
// load-bearing; what is load-bearing is that the fixture is built from the
// DERIVATION above (`topLevelNamesUnderStateRoot`), so a name the runtime starts
// spelling under a state root joins the fixture with no edit here.
//
// WHAT THIS BUYS, MEASURED RATHER THAN CLAIMED: it WOULD have caught
// `cursor-models.json` (the derivation sees it — one string spells both the home
// and the project root) and it would NOT have caught
// `.one.json.report-id.lock`, which is assembled from a template literal over
// STATE_FILE. That is the same blind spot HEADER_RESIDUE_NOT_STATICALLY_VISIBLE
// already documents for `CLAUDE.local.md`, and it is why the lock family is
// planted BY HAND below and disclosed as a residue rather than counted as closed.
// The honest statement of the limit: the fixture is (what the derivation can see)
// ∪ (what someone thought to add), and the second half is not a checkable claim.
//
// The counterweight, which the name list also earns and this must not lose: every
// USER-CONTENT shape either pin can reach is covered, and mostly NOT here —
// `product.md`, `plan.md`, `decisions`, `stack.md`, `known-issues.md`,
// `architecture.md`, `agent-log.md` and `schema.sql` all die on the older
// SPELLINGS pin and the marker-content rows in retention.test.ts. The incremental
// value of a 21-name literal is the twenty runtime residue names, which is
// exactly where a derived form has to pay.
const LEAK_FIXTURE_DIRS = new Set([...MIXED_EXCLUSIONS, 'reports', 'runs']);

/**
 * The names the derivation CANNOT see, planted by hand.
 *
 * `.one.json.report-id.lock` is a real top-level entry of a project state root
 * (state/project-state-lock.ts:750, a template literal over STATE_FILE) and its
 * `<token>` siblings are a family whose spellings cannot be enumerated at all —
 * pid+time+random. They are here because a leaked member root's lock is never
 * reaped (the reaper only runs inside an acquisition on that same `cwd`, and a
 * hook in a leaked member resolves to the workspace root), so it is a PERMANENT
 * leftover and the entry that proved the REDUCED notice's "that is a bug worth
 * reporting" sentence false. See recogniseEntries for why the name is declined
 * rather than admitted.
 *
 * EVERYTHING BELOW THE LOCK IS THE SAME TEMPLATE CLASS AS THE LOCK, and each row
 * is here because a HEAL_ONLY set naming it would otherwise survive this fence
 * with the arm consulted and admitting nothing — an ABSENT FIXTURE, which is what
 * the lock's own three rows were added for. The names are `${<state file>}<suffix>`
 * and nothing in a list of names can bound the class:
 *
 *   `.one.json.corrupt` — state/normalize.ts:329, the state file's bytes as they
 *     were when they stopped parsing, written precisely BECAUSE nothing could read
 *     them. It is the one row in this fence whose bytes are the user's ONLY copy of
 *     their mode, stack, onboarding stamps, `currentRunId` and durable report id.
 *     Declined in recogniseEntries, and on the strongest ground any row here has.
 *   the fsjson TEMP siblings — `.one.json.<pid>.tmp` (writeJson),
 *     `.one.json.<pid>.<ms>.<rand>.tmp` (writeJsonDurable) and
 *     `.one.json.<pid>.<index>.set.tmp` (the set writer). Each is a sibling of its
 *     destination, so when the destination is a top-level entry the temp is one
 *     too; each is cleaned in a `finally`, which a SIGKILL does not run. Three
 *     spellings and an unbounded `<pid>`/`<rand>` inside each, so this is the
 *     lock's family again with a different suffix — one representative of each is
 *     planted, and that is a sample rather than a cover.
 */
const EXPRESSION_ASSEMBLED_RESIDUE = [
  '.one.json.report-id.lock',
  '.one.json.report-id.lock.1a2b3c.pending',
  '.one.json.report-id.lock.1a2b3c.released',
  '.one.json.corrupt',
  '.one.json.4242.tmp',
  '.one.json.4242.1786500000000.9f3c1d.tmp',
  '.one.json.4242.0.set.tmp',
] as const;

test('the heal\'s partition is derived from the fixture\'s own listing, not from a list of names', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-derived-partition-')));
  try {
    fs.mkdirSync(path.join(base, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(base, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf8');
    const nested = path.join(base, 'apps', 'web', '.traffic-one');
    fs.mkdirSync(nested, { recursive: true });

    const derived = topLevelNamesUnderStateRoot();
    // FIXTURE, both halves: the instrument really is answering (a derivation that
    // saw nothing would make this pin vacuous in the most convincing way), and it
    // still sees the names the residue argument is about.
    assert.ok(derived.length >= RESIDUE_FLOOR,
      `FIXTURE the derivation must still answer above the floor, got ${derived.length}`);
    for (const name of ['runs', 'AGENTS.local.md', 'graphify-out', 'token-log.jsonl', 'cursor-models.json']) {
      assert.ok(derived.includes(name), `FIXTURE the derivation must see \`${name}\``);
    }

    // `plan.md` is project evidence (retention.ts nestedRootHasProjectEvidence):
    // planting it here would make this leftover a PROJECT and the heal would
    // stand down. Covered by retention.test.ts; the partition is about residue
    // inside a leak, not about the leak verdict.
    const planted = [...new Set([...derived, ...MIXED_EXCLUSIONS, ...EXPRESSION_ASSEMBLED_RESIDUE, 'notes.md'])]
      .filter((name) => name !== 'plan.md');
    for (const name of planted) {
      const target = path.join(nested, name);
      if (name === path.basename('.one.json')) continue; // written as a real record below
      if (LEAK_FIXTURE_DIRS.has(name) || name.includes('report-id.lock')) {
        fs.mkdirSync(target, { recursive: true });
        // `reports` is filled explicitly below: it is the one BRANCH node, so what
        // is inside it decides both halves of its row, and a stray `inside.md`
        // there is a second deep leftover the count at the end would have to know
        // about.
        if (name !== 'reports') fs.writeFileSync(path.join(target, 'inside.md'), 'MEMORY', 'utf8');
      } else {
        fs.writeFileSync(target, 'MEMORY', 'utf8');
      }
    }
    // `reports` is the only BRANCH node, so it needs both halves to say anything:
    // a recognised path under it (which is what makes "something at or under
    // `reports` is planned" true) and an unrecognised one (the archived report the
    // shipped product tells users to keep there).
    fs.mkdirSync(path.join(nested, 'reports', 'qa', '9001'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'reports', 'qa', '9001', 'evidence.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(nested, 'reports', 'tokens-2026-08-12.md'), 'MEMORY', 'utf8');
    fs.mkdirSync(path.join(nested, 'runs', '9001'), { recursive: true });
    fs.writeFileSync(path.join(nested, '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');

    const before = fs.readdirSync(nested).sort();
    assert.ok(before.length > 50, `FIXTURE the root must really hold the derived set, got ${before.length}`);

    const applied = sweepTrafficOneRetention(base, { dryRun: false });

    // BASELINE: the heal fired, ENTRY BY ENTRY. A `<WHOLE ROOT>` action would
    // satisfy half the loop below by taking everything, and a fixture that
    // stopped being a leak candidate would satisfy the other half by taking
    // nothing.
    assert.ok(applied.removed > 0, 'baseline — the heal reclaims what it recognises');
    assert.ok(!applied.actions.some((action) => action.path === nested),
      'baseline — the root is REDUCED rather than taken whole');

    const plannedAtOrUnder = (name: string): boolean => {
      const target = path.join(nested, name);
      return applied.actions.some((action) => action.path === target
        || action.path.startsWith(`${target}${path.sep}`));
    };

    for (const name of before) {
      const authority = authorityOver(name);
      assert.equal(plannedAtOrUnder(name), authority.length > 0,
        `${name}: the heal plans something at or under an entry IF AND ONLY IF the rule table spells it. `
        + `authorityOver('${name}') is [${authority.join(', ')}]. A TRUE here with an empty authority is a `
        + 'widening — a name added to the trie, set on it afterwards, or admitted inside recogniseEntries all '
        + 'land on this line, and none of them has to be a name any literal in this fence lists. A FALSE with a '
        + 'non-empty authority is the other direction: recognition stopped reaching a path its own rules '
        + 'schedule, which leaves a permanent leftover');
    }

    // The bytes, for everything the table does not spell — the plan is not the
    // loss, and an apply sweep is where the two stop being the same claim.
    for (const name of before) {
      if (authorityOver(name).length > 0) continue;
      const target = path.join(nested, name);
      const body = fs.statSync(target).isDirectory() ? path.join(target, 'inside.md') : target;
      assert.equal(fs.readFileSync(body, 'utf8'), 'MEMORY', `${name}: still on disk after an APPLY sweep`);
    }

    // The DISCLOSURE, derived the same way: the notice's own count must account
    // for every unrecognised top-level entry plus the one leftover under
    // `reports/`. A name silently admitted leaves the actions list AND drops this
    // count, which is what made the measured loss invisible.
    assert.equal(applied.notices.length, 1, 'one reduction notice');
    const counted = /and (\d+) of its entries are not/.exec(applied.notices[0]!);
    assert.ok(counted, 'FIXTURE the notice still states how many entries it skipped');
    // + 1 for `reports/tokens-2026-08-12.md`, the one leftover a level down: it is
    // reported by its relative path rather than by its parent, because `reports`
    // itself carries no authority and is descended through.
    const expected = before.filter((name) => authorityOver(name).length === 0).length + 1;
    assert.equal(Number(counted[1]), expected,
      'the notice must account for every entry the heal left behind, counted from the same listing the '
      + 'partition above is derived from');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── the CORPUS the admission audit reads ─────────────────────────────────────
// The audit is "does anything SHIPPED tell a user to author something under this
// path", and it was run over four directories: skills-catalog, rules, every
// agent.md, gen/static. The bundle is longer than that — gen/emit/static.ts
// copies README.md, ref.md, LICENSE, THIRD-PARTY-NOTICES.md, PRIVACY.md,
// PLATFORMS.md, KNOWN-ISSUES.md and SUPPORT.md into the plugin root — and the
// `reports` blocker lived in the part the audit could not see: README.md:571
// documents `.traffic-one/reports/security/` as a writer.
//
// ── WHAT THIS CORPUS IS, EXACTLY, AND WHAT IS OUTSIDE IT ─────────────────────
// It is EVERY SHIPPED MARKDOWN DOCUMENT: the root documents the emitter names,
// plus `src/modules/**/*.md` and `src/gen/static/**/*.md`. This test used to be
// called "reads the whole shipped file list", which is a stronger claim than the
// corpus supports and is the same shape as the four-directory sentence it
// replaced — a name admitted because nobody searched the corpus where the
// instruction lives is how `retention.json` survived five rounds.
//
// WHAT IS OUTSIDE IT IS PROSE THE PRODUCT PRINTS: hook denials, directives, and
// `shared/skill-fallbacks.generated.ts`, which is verbatim SKILL.md blocks compiled
// into the hook runtime. A user reads those too.
//
// MEASURED rather than assumed, with this file's own instrument (the same mention
// regex, AUTHORING_VERB and 60-character window) run over the string literals of all
// 685 non-test `.ts` files under `src/`, joined with `'\n'` — the joiner the product
// itself prints them with: THIRTY-FOUR rows, on FIVE paths — `.one.json`, `digests`,
// `manifest.json`, `reports/qa` and `runs` (load 3.56 of 10 CPUs). NOT ONE is a
// live admission failure: every one of those five paths already carries a census
// row from a shipped document, so no path moves from no-row to row, and the FIVE
// paths asserted to have no row at all (`.codegraph-build-lock`, `.once`,
// `.opencode-heal-lock`, `backups`, `runs/.once`) pick up nothing here either —
// which is the half that would have mattered.
//
// THIS PARAGRAPH SAID "27 rows, on FOUR paths … (a peer instrument answered 32 …)"
// for three rounds, and both numbers and the path count were wrong. The four-path
// list was short by `manifest.json` under every reading that windows a whole file,
// and the counts were three different joiners and two different treatments of `${…}`
// source being reported as one disagreement about a corpus that never changed.
// retention.ts's recogniseEntries docblock carries the settled figure with all four
// readings, the joiner each one used, and the mechanism for every delta; that is the
// one place it is argued, because a number copied into two files is a number that
// stops agreeing with itself.
//
// SO IT IS NOT WIDENED, and the price is the reason rather than the effort:
//   `skill-fallbacks.generated.ts` IS GENERATED, from the same SKILL.md blocks this
//     corpus already reads. Its rows are duplicates by construction, and putting a
//     generated file into a census pinned by a literal means a regeneration in
//     somebody else's lane reds a retention test.
//   THE OTHER FILES ARE ORDINARY RUNTIME MODULES — `session/prompt-submit.ts`,
//     `plan-guard/plan-readiness/index.ts`, `agent-model/handler-prose.ts` — edited
//     constantly by lanes that have nothing to do with retention. A census row
//     keyed on them reds on a reworded denial message.
//   THIS TREE HAS ALREADY LOST TWO CHECKS to exactly that, and one live example is
//     documented above: `overrides` rests on five COMMENTS, so editing a comment in
//     an unrelated module reds a retention test today.
// What would make a widening safe is a corpus with a stable membership rule — the
// documents an INSTALL contains, which is what the emitter defines — and printed
// prose has no such rule while it lives in hand-edited modules. The honest state is
// this paragraph: a named corpus, a measured hole, and the hole's contents shown to
// be empty of admissions today.
//
// So the corpus is pinned against the emitter rather than described, and the
// sentences this round's decisions actually turn on are asserted from the
// shipped text. They are the facts, not the conclusions: if one of them is
// reworded, the admission it supports is due for a re-argument.
let corpusFiles: readonly string[] | null = null;

/** Every document an install puts in front of a user, as absolute paths. */
function shippedCorpus(): readonly string[] {
  if (corpusFiles) return corpusFiles;
  const emitter = fs.readFileSync(path.join(REPO, 'src', 'gen', 'emit', 'static.ts'), 'utf8');
  const block = /const STATIC_TEXT_FILES = \[([^\]]+)\]/.exec(emitter);
  assert.ok(block, 'FIXTURE gen/emit/static.ts still declares the root documents it ships');
  const shippedRootDocs = [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  assert.ok(shippedRootDocs.includes('README.md') && shippedRootDocs.includes('SUPPORT.md'),
    'FIXTURE the list really is the root documents');
  corpusFiles = [
    ...shippedRootDocs.map((name) => path.join(REPO, name)),
    ...walkFiles(MODULES, (abs) => abs.endsWith('.md') && !abs.includes(`${path.sep}__tests__${path.sep}`)),
    ...walkFiles(path.join(REPO, 'src', 'gen', 'static'), (abs) => abs.endsWith('.md')),
  ];
  return corpusFiles;
}

test('the admission audit reads every shipped MARKDOWN document, and the sentences it turns on are there', () => {
  // Every one of them is a file a user can read from inside an install, so every
  // one of them is in the corpus. This is the assertion that fails if gen starts
  // shipping a document the audit has never been run over.
  const corpus = shippedCorpus();
  for (const file of corpus) {
    assert.ok(fs.existsSync(file), `FIXTURE a shipped document is missing from the source tree: ${file}`);
  }
  assert.ok(corpus.length > 150, `FIXTURE the corpus is the whole bundle, got ${corpus.length} files`);

  const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');
  const skills = path.join('src', 'modules', 'skills', 'skills-catalog');

  // `reports` is MIXED in the shipped product — three documents, two of them
  // outside the old corpus or outside the quoted half of the sentence.
  assert.match(read(path.join(skills, 'project-memory', 'SKILL.md')),
    /Keep `\.traffic-one\/digests\/`[\s\S]{0,200}unless the user explicitly\n?\s*asks to preserve a report/,
    'the sentence that was quoted to admit `reports` contemplates preserving a report in its second half');
  assert.match(read(path.join(skills, 'token-usage-report', 'SKILL.md')),
    /--out \.traffic-one\/reports\/tokens-<date>\.md/,
    'a skill in SKILL_FILTERS._common has the assistant offer the USER an archive under reports/');
  assert.match(read(path.join(skills, 'predeploy-security-check', 'SKILL.md')),
    /`\.traffic-one\/reports\/security\/`/, 'and a second writer lives under it');
  assert.match(read('README.md'), /Reports are written to `\.traffic-one\/reports\/security\/`/,
    'documented in the root README too — the file the four-directory audit could not see');
  assert.deepEqual([...authorityOver('reports')].sort(), [path.join('reports', 'lighthouse'), path.join('reports', 'qa')],
    'so the heal reaches exactly the two paths the rules schedule, and nothing else under reports/');

  // `debug`, whose row used to read "NOT MENTIONED ANYWHERE".
  assert.match(read('SUPPORT.md'), /create `~\/\.traffic-one\/debug\/hook-trace\.on`/,
    'the debug row has an authoring instruction after all — for the HOME state root, which the heal never reaches');

  // `backups`, where a shipped role instruction and this sweep's policy differ.
  // The prohibition is a ROLE instruction and the cap is a runtime policy, which
  // is a legitimate difference — but the line said "never delete
  // `.traffic-one/backups/`" unqualified, and a user reading it would not expect
  // the directory to shrink on its own every bootstrap. The qualification is
  // what this asserts; the prohibition itself is unchanged.
  const doctor = read(path.join(skills, 'traffic-one-doctor', 'SKILL.md'));
  assert.match(doctor, /Never delete `\.traffic-one\/\.gitnexus\/`, `\.traffic-one\/backups\/`/,
    'the role prohibition still ships');
  assert.match(doctor, /capped by the retention policy's `backupKeep`/,
    'and it says so about the policy that prunes the same directory, rather than reading as a promise');
});

// ── THE ADMISSION CENSUS, WHICH USED TO BE A CLAIM AND IS NOW A CHECK ────────
// recogniseEntries said this suite "pins the census itself, file by file, so the
// next sentence a shipped document writes about one of these paths fails a test
// instead of waiting for a reviewer". It did not. The test above builds `corpus`
// and never reads it: its only assertions are existsSync per file, a length
// floor, and six hand-written regexes over six named documents. MEASURED: a new
// skill telling users to author `.traffic-one/digests/release-checklist.md` and
// `.traffic-one/runs/NOTES.md` — the exact instruction shape that disqualified
// `retention.json` — shipped with all nine tests green.
//
// WHAT THE CENSUS IS. For every recognised path, every shipped document that
// mentions it with an AUTHORING VERB in the sixty characters before the mention.
// Recorded as (path :: file) PAIRS, and the granularity is the whole design:
//
//   REWORDING an existing instruction changes nothing here, which is the m1
//     lesson from the pin below applied before it was made twice. "Projects may
//     override" → "Projects can override in" moves no pair.
//   A NEW DOCUMENT, or an existing document that starts telling users to author
//     under one of these paths for the first time, ADDS a pair and reds. That is
//     the peer's exploit, and it is driven rather than asserted: see the
//     synthetic-document test below, which plants that exact skill and requires
//     this pin to fail.
//   A DOCUMENT THAT STOPS saying it removes a pair and reds too. That direction
//     is informative rather than alarming — an admission argument lost its
//     premise — and the message says so.
//
// WHAT IT DOES NOT CATCH, because a pin whose limits are unstated is the last
// version of this claim again: a SECOND authoring sentence added to a file
// already listed for that path is invisible. File granularity is bought
// deliberately, and what it buys is that ordinary prose edits inside a shipped
// document cannot red a retention test. A per-sentence census would catch the
// second sentence and would red on every rewrite; this lane has been burned by
// both halves of that trade, and this is the side that fails toward review
// rather than toward a false red nobody can green honestly.
//
// FIVE PATHS HAVE NO ROW AT ALL — `backups`, `.once`, `runs/.once` and the two
// locks. That is not an omission: nothing shipped mentions them beside an
// authoring verb, and the empty half is asserted as explicitly as the full one.
// The verb list is not a style choice: it has to contain the verb of the one
// instruction this whole design turns on. `retention.json` left the table
// because senior-eng-orchestrator/SKILL.md says "Projects may OVERRIDE retention
// counts with `.traffic-one/retention.json`", and a list without `overrid*` in
// it would have missed the census's own founding case. Driven, not asserted —
// the last test in this file asks this census about `retention.json` and
// requires that row.
//
// ── THE VERB LIST IS THE INSTRUMENT, AND IT WAS WRONG IN BOTH DIRECTIONS ─────
// UNDER-MATCHING FIRST, because that is the fail-open half. Using this census's own
// window over the shipped corpus, 40 mentions of a recognised path sit beside an
// authoring-shaped verb the old list could not see: `update`/`updating` ("update
// your digest under `.traffic-one/digests/<runId>/`"), `Bump` ("Bump
// `spawnIndex[role]` in `.traffic-one/.one.json`"), `keep`, `archive`, `generate`,
// `emit`, `dump`, `land`, `open` and `point at`. NOT ONE of them moved a path from
// no-row to row — every recognised path with a plausible instruction already has a
// row on some other verb — but that is luck of vocabulary, and it is the same luck
// that made `overrid*` catch the census's founding case (`retention.json`). The next
// name admitted to the table can be admitted on a check that structurally cannot see
// "Bump X in `.traffic-one/Y`". So the verbs are curated — and CURATED means each
// candidate was added ALONE and its rows read, not that ten words were pasted in:
//
//   +updat(e|es|ing)    1 new row  digests :: agent-model/skill/SKILL.md, "…end with
//                                  its terminal token and update its digest under
//                                  `.traffic-one/digests/…`". A real instruction to
//                                  write under a recognised path. ADDED, and it is
//                                  the row this whole finding was about.
//   +bump +archiv +land 0 new rows each. ADDED anyway: they cost nothing today and
//   +point at           they are the vocabulary the next admission arrives in.
//   +emit(s|ting)       0 new rows on the corpus, and DECLINED anyway — driven, the
//                       fence's own NEGATIVE CONTROL is the sentence it matches:
//                       "The orchestrator emits `.traffic-one/digests/` and
//                       `.traffic-one/runs/` for you", the row asserting that a bare
//                       product-side mention is not an admission. Greening that by
//                       rewording the control is the move this file warns about two
//                       paragraphs down at the split. `emit` is what the PRODUCT
//                       does, like `keep`.
//   +keep|keeps|keeping 5 new rows, ALL of them retention prose, and one of them is
//                       load-bearing in the wrong direction: "Keep
//                       `.traffic-one/digests/`, `.traffic-one/reports/`,
//                       `.traffic-one/backups/` ephemeral" is the sentence `backups`
//                       is RECOGNISED ON. Adding `keep` would convert that argument
//                       into a row against itself and empty the census's empty half
//                       for no instruction anywhere. DECLINED as a category error:
//                       `keep` is what our own docs say ABOUT retention, never an
//                       instruction to a user to author something.
//   +dump\w*            1 new row, "never dump table data.\n- Keep `.traffic-one/…`"
//                       — a negation about an unrelated object, reached only because
//                       the window crosses a sentence and a newline. DECLINED.
//   +open|opens|opening 1 new row, PRIVACY.md "…check your own project:** open
//                       `.traffic-one/.one.json`" — a READ instruction, the opposite
//                       of authoring. DECLINED.
//   +generat\w*         1 new row on the NOUN "auto-documentation-generator", i.e.
//                       the `provid\w*` artefact again. Added as
//                       `generat(e|es|ing)`, which contributes 0 rows.
//
// Net: 43 rows → 44, one row, argued. The five paths with no row are unchanged, so
// the empty half below is asserted against the WIDER instrument, which is the only
// version of that assertion worth having.
//
// OVER-MATCHING SECOND, and it is the same list being wrong at the other end:
// `provid\w*` matched the NOUN "provider", which is everywhere in this corpus. Two
// of the six rows the residue names produced were exactly that — "provider
// versions, and important version pins" (rules/common/project-memory.md:92, for
// `.agentignore`) and "provider's location (per …)"
// (senior-eng-orchestrator/resources/prompt-templates.md:127, for `.gitnexus`) —
// with the word on a different LINE from the mention in both. It is now
// `provid(e|es|ing)`: the verb spellings, not the agent noun, and MEASURED to lose
// no row of the 43 (its artefacts were both on residue names, which this literal
// never listed). That direction was SAFE (a spurious row keeps a name OUT of the
// table, and a name out of the table is a file that survives), which is why it is
// tightened rather than urgent — and it still had to be tightened, because a census
// whose rows are half artefacts is a census whose rows nobody reads. The same
// discipline now applies to every verb with a live agent noun in this corpus:
// `provid(e|es|ing)`, `generat(e|es|ing)` and `updat(e|es|ing)` are spelled out;
// `\w*` is left only where no such noun exists. Third-person PRODUCT prose ("the
// runner writes X") is indistinguishable from an instruction inside a 60-character
// window and always was — `writ\w*` has that problem today. The direction is safe
// (a spurious row keeps a name OUT of the table), and `emit` is the one word where
// a pinned assertion put a number on the cost, so it is the one that was declined.
//
// WHAT IS STILL NOT MEASURED, stated rather than implied by a longer list: this is a
// curated vocabulary, not a parser. An instruction phrased entirely outside it
// ("your notes belong under `.traffic-one/runs/`") is invisible, and `sameLine`
// remains the cheap discriminator nobody has needed yet — note that two of the three
// DECLINED verbs above were artefacts of the window crossing a sentence boundary,
// so `sameLine` would have bought them, and neither was worth the row. The five
// paths with NO row carry the limit as an explicit argument rather than as an
// absence — see the empty half of the census pin below.
const AUTHORING_VERB = /\b(creat\w*|author\w*|writ\w*|add|adds|adding|put|puts|putting|sav\w*|record\w*|stor\w*|plac\w*|hand-\w+|maintain\w*|append\w*|drop|overrid\w*|configur\w*|edit\w*|provid(?:e|es|ing)|suppl\w*|declar\w*|fill\w*|past\w*|updat(?:e|es|ing)|bump(?:s|ing)?|archiv(?:e|es|ing)|generat(?:e|es|ing)|land(?:s|ing)?|point(?:s|ing)? at)\b/i;
const AUTHORING_WINDOW = 60;

/**
 * The 60 characters in front of a mention, EXTENDED to the nearest word boundary.
 *
 * A fixed offset lands wherever it lands, and where it lands mid-word the leading
 * `\b` of every verb in the vocabulary refuses the fragment it created: "pointing
 * at" arrives as "g at", `fill` as "ill", `Edit` never arrives at all because the
 * window opened after the E. The boundary is then the SLICE's rather than the
 * TEXT's, and the verb is invisible to a census whose whole job is to see it.
 *
 * SNAPPED OUTWARD RATHER THAN LEFT ALONE, which reverses the previous round's
 * ruling, and the direction is the reason. That round found the same manufactured
 * boundary, checked the live census for it and declined — but it checked for
 * manufactured POSITIVES, which is the half where a mistake is harmless: a
 * spurious row keeps a name OUT of the recognised table, and a name out of the
 * table is a file that survives. The same missing boundary manufactures
 * NEGATIVES, and a missed row is how a name gets admitted on a census that could
 * not see the instruction. Recorded verbatim, because the sentence stated the
 * emptiness of the hole as the whole finding:
 *
 *   "recomputing the LIVE census with each verb's word boundary checked against
 *    the full document instead of against the slice answers 44 rows either way,
 *    with ZERO manufactured matches to discard. The hole is real and today it is
 *    empty, which is why AUTHORING_WINDOW is left alone rather than snapped to a
 *    word boundary: the change would move a pinned literal for no row."
 *
 * MEASURED over the 224 shipped documents, both directions this time: 44 rows as
 * shipped, 46 snapped, 0 rows only the shipped window finds, and 2 it MISSES —
 * `.one.json :: PRIVACY.md` on "pointing at", and
 * `fix-cycles :: …/prompt-templates.md` on "paste". The second is on a
 * RECOGNISED path whose row set is pinned as a literal below, so the pin was two
 * rows short of what its own instrument reports honestly. Four mentions carry a
 * verb the shipped window cuts in half; two of them are the rows above and two
 * already have a row from another verb in the same slice.
 *
 * The empty half survives the change: all five paths asserted to have no row at
 * all still have none under the snapped window, so nothing becomes admissible.
 */
function authoringContext(text: string, at: number): string {
  let start = Math.max(0, at - AUTHORING_WINDOW);
  while (start > 0 && /[\w-]/.test(text[start - 1]!)) start -= 1;
  return text.slice(start, at);
}

/**
 * Every (path :: shipped document) pair where the document names the path with
 * an authoring verb close in front of it.
 *
 * `extra` lets a test drive a document that is not in the tree — the only
 * honest way to show this census is not vacuous is to author the sentence the
 * product would have shipped and watch the pin move. `paths` defaults to the
 * recognised table and is a parameter so the same instrument can be asked about
 * a name that was EXCLUDED by it.
 */
function admissionCensus(
  extra: readonly (readonly [string, string])[] = [],
  paths: readonly string[] = RUNTIME_ENTRY_PATHS,
): string[] {
  const documents: (readonly [string, string])[] = [
    ...shippedCorpus().map((abs) => [path.relative(REPO, abs), fs.readFileSync(abs, 'utf8')] as const),
    ...extra,
  ];
  const pairs = new Set<string>();
  for (const rel of paths) {
    const mention = new RegExp(`\\.traffic-one/${escapeRe(rel.split(path.sep).join('/'))}(?![\\w.-])`, 'g');
    for (const [file, text] of documents) {
      for (const hit of text.matchAll(mention)) {
        if (AUTHORING_VERB.test(authoringContext(text, hit.index!))) {
          pairs.add(`${rel.split(path.sep).join('/')} :: ${file}`);
        }
      }
    }
  }
  return [...pairs].sort();
}

// Each row is a sentence a reviewer has already agreed to. The ARGUMENT for the
// rows is not repeated per line — it lives in recogniseEntries, one paragraph
// per path — because forty-six copies of it would be forty-six things to keep
// true. What this literal is for is that the SET cannot change quietly.
const ADMISSION_CENSUS: readonly string[] = [
  // The two rows the fixed left edge could not see. Both are ordinary instructions
  // whose verb the 60-character offset happened to open inside — see
  // authoringContext, which is what changed and why the count moved by exactly two.
  '.one.json :: PRIVACY.md',
  '.one.json :: src/gen/static/plugin-instructions.md',
  '.one.json :: src/modules/onboarding-gate/skill/SKILL.md',
  '.one.json :: src/modules/plan-guard/skill/SKILL.md',
  '.one.json :: src/modules/rules/rules/common/onboarding.md',
  '.one.json :: src/modules/rules/rules/common/project-memory.md',
  '.one.json :: src/modules/rules/rules/common/senior-engineer-team.md',
  '.one.json :: src/modules/rules/rules/common/setup-gate.md',
  '.one.json :: src/modules/rules/rules/core.md',
  '.one.json :: src/modules/rules/rules/modes/new-project-setup.md',
  '.one.json :: src/modules/senior-backend/agent.md',
  '.one.json :: src/modules/skills/skills-catalog/project-memory/SKILL.md',
  '.one.json :: src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md',
  'debug :: PRIVACY.md',
  'debug :: SUPPORT.md',
  'digests :: src/modules/agent-model/skill/SKILL.md',
  'digests :: src/modules/onboarding-gate/skill/SKILL.md',
  'digests :: src/modules/plan-guard/skill/SKILL.md',
  'digests :: src/modules/rules/rules/common/agent-handoff-digests.md',
  'digests :: src/modules/rules/rules/common/project-memory.md',
  'digests :: src/modules/rules/rules/modes/new-project-setup.md',
  'digests :: src/modules/senior-architect/agent.md',
  'digests :: src/modules/senior-backend/agent.md',
  'digests :: src/modules/senior-frontend/agent.md',
  'digests :: src/modules/senior-reviewer/agent.md',
  'digests :: src/modules/senior-shipper/agent.md',
  'digests :: src/modules/senior-tester/agent.md',
  'digests :: src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md',
  'digests :: src/modules/skills/skills-catalog/senior-eng-orchestrator/resources/prompt-templates.md',
  'fix-cycles :: src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md',
  'fix-cycles :: src/modules/skills/skills-catalog/senior-eng-orchestrator/resources/prompt-templates.md',
  'manifest.json :: src/modules/rules/rules/modes/new-project-setup.md',
  'manifest.json :: src/modules/skills/skills-catalog/project-memory/SKILL.md',
  'reports/qa :: src/modules/skills/skills-catalog/browser-qa/SKILL.md',
  'rules :: src/modules/rules/rules/modes/new-project-setup.md',
  'rules :: src/modules/skills/skills-catalog/project-memory/SKILL.md',
  'runs :: KNOWN-ISSUES.md',
  'runs :: PRIVACY.md',
  'runs :: README.md',
  'runs :: SUPPORT.md',
  'runs :: src/modules/plan-guard/skill/SKILL.md',
  'runs :: src/modules/rules/rules/common/senior-engineer-team.md',
  'runs :: src/modules/senior-architect/agent.md',
  'runs :: src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md',
  'runs :: src/modules/skills/skills-catalog/senior-eng-orchestrator/resources/prompt-templates.md',
  'runs :: src/modules/skills/skills-catalog/task-triage/SKILL.md',
  'runs/.once :: KNOWN-ISSUES.md',
];

test('the admission census is pinned file by file, so a new shipped instruction reds', () => {
  assert.deepEqual(admissionCensus(), [...ADMISSION_CENSUS],
    'the set of shipped documents that tell someone to author under a path the leaked-root heal may DELETE has '
    + 'changed. An ADDED row is the one to stop at: a document now instructs a human to put content of their own '
    + 'under a recognised path, which is the test that threw `retention.json` out of the table — decide the row '
    + 'against recogniseEntries\' per-path argument, and if the instruction is right then the PATH is what has to '
    + 'leave the table, not this line. A REMOVED row means an admission lost the premise recorded for it; that is '
    + 'safe, and updating this literal is the whole fix');

  // The empty half, asserted rather than left implied by absence.
  const covered = new Set(ADMISSION_CENSUS.map((row) => row.split(' :: ')[0]!));
  assert.deepEqual(RUNTIME_ENTRY_PATHS.map((rel) => rel.split(path.sep).join('/')).filter((rel) => !covered.has(rel)).sort(),
    ['.codegraph-build-lock', '.once', '.opencode-heal-lock', 'backups', 'reports/lighthouse'],
    'these five are recognised on the strength of nothing shipped mentioning them beside an authoring verb, and '
    + 'that is an assertion, not a gap in the table above');
});

// NON-VACUOUS, driven with the peer's own commit rather than argued. The
// document below is the shape that disqualified `retention.json`: a shipped
// skill telling a user to author a file of their own under a path the heal may
// delete whole. It is passed to the census as an EXTRA document instead of being
// written into `src/`, so nothing in the tree changes and no other lane's suite
// can trip over it — and the census has to move for it, twice.
test('the census really would catch it: the exact new-skill instruction reds', () => {
  const planted = [[
    'src/modules/skills/skills-catalog/release-checklist/SKILL.md',
    '# Release checklist\n\nBefore a release, create `.traffic-one/digests/release-checklist.md` with the items\n'
    + 'below, and write your running notes to `.traffic-one/runs/NOTES.md` as you go.\n',
  ]] as const;

  const moved = admissionCensus(planted);
  assert.notDeepEqual(moved, [...ADMISSION_CENSUS],
    'a shipped document that tells a user to author under `digests/` and `runs/` must move the census — if this '
    + 'passes, the pin above is decoration and the claim in recogniseEntries is false again');
  // SCOPED TO THE PLANTED FILE, which the unfiltered version was not: any NEW
  // shipped document that adds a census row of its own reds here too, with a
  // message about a release-checklist skill that has nothing to do with it.
  // MEASURED with an ordinary new `senior-observability/agent.md`: test 7 (the
  // census pin) reds correctly and discloses exactly that, and this row red
  // beside it for an unrelated reason. The pin here is about THIS document.
  const plantedFile = planted[0][0];
  assert.deepEqual(moved.filter((row) => row.endsWith(` :: ${plantedFile}`)), [
    `digests :: ${plantedFile}`,
    `runs :: ${plantedFile}`,
  ], 'and it must move for BOTH paths the document names, at the file that names them');

  // And the other direction: the same document with no authoring verb near the
  // paths is not a census entry. Without this the pin could be a bare mention
  // counter, which would red on the 306 ordinary mentions this corpus already
  // carries and be unmaintainable inside a week.
  assert.deepEqual(admissionCensus([[
    'src/modules/skills/skills-catalog/release-checklist/SKILL.md',
    '# Release checklist\n\nThe orchestrator emits `.traffic-one/digests/` and `.traffic-one/runs/` for you.\n',
  ]]), [...ADMISSION_CENSUS], 'a document that merely NAMES the paths is not an authoring instruction');
});

// The blocker that took `retention.json` out of the table above, pinned from the
// SHIPPED TEXT rather than from the decision: the admission test is a question
// about what this product tells users, so the fact that has to hold is a fact
// about the skill corpus. If the sentence is ever removed the name may be
// re-argued; while it ships, the name may not be recognised.
//
// SPLIT FROM THE PROTECTION DELIBERATELY. These two assertions used to share a
// body, and they fail for opposite reasons: rewording the shipped sentence reds
// this test while the protection is completely intact, and the cheapest way to
// green a false red is to delete the assertion beside it — which here would have
// been the protection itself.
//
// THE SECOND HALF OF THAT CLAIM WAS FALSE and is now true. It read "the match is
// also on the PATH TOKEN rather than on the sentence, so ordinary prose edits
// around it do not red anything at all", and the regex was
// `/override retention counts with \`\.traffic-one\/retention\.json\`/` — five
// words of prose. MEASURED: rewording the shipped line to "Projects can override
// the retention counts by writing `…`" red this test while the protection stayed
// green, which is precisely the false red the split was built to prevent.
//
// It is now the SAME INSTRUMENT the census uses, asked about an EXCLUDED name:
// the path token, plus an authoring verb somewhere in the sixty characters in
// front of it. Both rewordings above keep their verb ("override", "writing"), so
// both are free; what reds is the instruction disappearing, which is exactly the
// fact this test exists to hold. It also keeps the verb list honest in the one
// place it matters — a list that could not see this sentence could not see the
// case the census was built for.
test('the shipped instruction that fails retention.json is really there', () => {
  assert.deepEqual(admissionCensus([], ['retention.json']),
    ['retention.json :: src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md'],
    'the authoring instruction is materialized into every project by this skill, and it is what keeps the name '
    + 'out of the recognition table. If it has genuinely gone, the name may be re-argued — on its other half '
    + 'too, since nothing in src/ writes it either');
});

test('so retention.json is not recognised, and nothing writes it', () => {
  assert.deepEqual(authorityOver('retention.json'), [],
    'the heal may not delete an entry under that name: the only thing that writes it is a human');
});

// `agents` is HOST-CONDITIONAL, which is why it went unmeasured: a probe run
// under any other host sees a three-entry top level and concludes the table is
// complete. Asserted directly so the conditionality is a fact of record rather
// than a footnote.
test('the Codex-only entry really is Codex-only', () => {
  withInstalledRoot('claude', (project) => {
    assert.equal(materializeProjectAssets(project, { ...STATE }).skipped, undefined, 'FIXTURE materialization ran');
    assert.deepEqual(fs.readdirSync(path.join(project, '.traffic-one')).sort(), ['manifest.json', 'rules', 'skills'],
      'off Codex the role contracts are not written, so a probe on one host cannot pin this table');
  });
});

test('no top-level entry of a materialized state root carries the GENERATED marker', () => {
  withInstalledRoot('codex', (project) => {
    assert.equal(materializeProjectAssets(project, { ...STATE }).skipped, undefined, 'FIXTURE materialization ran');
    const t1 = path.join(project, '.traffic-one');

    const marked = markerCarryingFiles(t1);
    // NON-VACUOUS, and this is the half that matters: the marker really is all
    // over this tree. It is just never at the top, which is the only level
    // recognition inspects.
    assert.ok(marked.length > 40, `FIXTURE the marker must be present in the tree at all, found ${marked.length}`);
    assert.ok(marked.every((rel) => rel.includes(path.sep)),
      `every marker-carrying file must be nested, found top-level: ${marked.filter((rel) => !rel.includes(path.sep)).join(', ')}`);

    for (const name of fs.readdirSync(t1)) {
      const abs = path.join(t1, name);
      if (!fs.statSync(abs).isFile()) continue;
      assert.ok(!fs.readFileSync(abs, 'utf8').includes(GENERATED_MARKER),
        `${name} is a top-level file carrying the marker — recognition's deleted content arm had a true positive `
        + 'after all, and the argument in recogniseEntries needs re-deciding');
    }
  });
});
