// src/shared/__tests__/lock-ordering-contract.test.ts
// The order this repository takes its locks in, written down, with a violation
// made red.
//
// ── what this is not ────────────────────────────────────────────────────────
// It is NOT a deadlock detector for an unbounded wait. Every lock here carries a
// bounded deadline and either throws or returns falsy at it
// (ONE_SETTINGS_LOCK_TIMEOUT_MS, ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS,
// ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS, the per-wrapper timeoutMs in the run-agent
// family), so a genuine cycle yields a BOUNDED DOUBLE REFUSAL on both sides
// rather than a hang. That correction matters because the opposite premise — "a
// cycle is an unreportable hang" — is what ranked this work above bounding the
// reads in one-settings.ts, and the unbounded hang was in the READS: three
// rounds looked for it in the wrong organ while `withMachineFileLock` sat one
// file over, hanging forever on a planted FIFO with no cycle anywhere.
//
// What a cycle costs here is still worth refusing: two honest operations that
// each hold what the other is waiting for both fail, at the deadline, and the
// caller sees a contention refusal for something no amount of patience fixes.
//
// ── what it does ────────────────────────────────────────────────────────────
// Three of the six pairs the enumeration found were WRITTEN discipline, cited
// and obeyed (rebind-journal.ts:154 states the identity → registry → fallback
// order and registry-refresh.ts:148 cites it; obligations.ts:1005 independently
// declines to hold two registry leases, naming the hazard). Three were LUCK: the
// override lane's own ledger → settings pair is documented only as timeout
// ARITHMETIC (token.ts, a statement about admitting waiters, not about
// acquisition order), and the identity → run-ledger and cursor-spawns → registry
// pairs are stated nowhere at all. Nothing in the tree went red on a violation
// of any of them. This file is that instrument: the pair set is pinned exactly,
// so a new nesting site fails until it has been written down here, and the
// declared order is checked for cycles, so a REVERSED site fails as a cycle.
//
// ── why it cannot pass vacuously ────────────────────────────────────────────
// Two earlier attempts at this analysis were green and empty, and both were
// caught by coverage rather than by the cycle checker: one reported ZERO ordered
// pairs (it descended only into inline arrows, while the ledger lock takes its
// critical section as a PARAMETER, so the nesting lives at the wrapper's
// caller), and one reported a lock as an ABSENT FIXTURE while still printing
// ACYCLIC. This file's own first draft made a third version of the same mistake:
// its call matcher did not allow an explicit type argument, so
// `withRunAgentClaimsLockResult<Rec>(…)` and `withExhaustedModelsLock<…>(…)`
// were not call sites at all — two of the eight pairs vanished and one lock
// reported ZERO critical sections. So the coverage assertion below is the load
// bearing one: every declared lock must have at least one critical section whose
// body was actually examined, and the pair set is compared as a SET rather than
// as a subset.
//
// ── the residual, inherited and stated rather than closed ───────────────────
// The closure resolves calls to inline arrows, to named locals and to imported
// function DECLARATIONS. It does not resolve method calls, dynamic dispatch, or
// a callback held in a variable, so a nesting reached only through one of those
// is invisible here — which is why the pair table carries citations a reader can
// check rather than standing on this analysis alone. The site lists are
// DIAGNOSTICS for the same reason: the enumeration behind this table names three
// sites for the identity → run-ledger pair and this closure reaches one of them.
// The argument region of a wrapper call is scanned WHOLE rather than only its
// body parameter, which over-approximates in the safe direction: a lock taken
// while computing an argument is reported as a pair that must be declared.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The locks, by the wrapper that OPENS a critical section for each.
 *
 * The run-agent "lock" is a FAMILY of per-purpose owned-directory leases that
 * NEST INSIDE EACH OTHER, and collapsing them into one entry is what makes their
 * ordering invisible: `withOwnedDirLock` is the shared PRIMITIVE, parameterized
 * by directory, so it names no lock on its own and is deliberately absent below.
 * A lock is identified by its wrapper's NAME rather than by analysing the
 * primitive's body — computing `acquires(F)` from F's own body is the other way
 * an earlier attempt reported nothing, since the primitives do not call
 * themselves.
 */
const LOCKS: Record<string, readonly string[]> = {
  'project-state': ['withProjectStateLock'],
  'machine-settings': ['withMachineFileLock', 'withSettingsLock'],
  'override-ledger': ['withOverrideLedgerLock'],
  'identity-claims': ['withRunAgentClaimsLock', 'withRunAgentClaimsLockResult'],
  'role-registry': ['withAgentRegistryLock', 'withAgentRegistryLockResult'],
  'fallback-claims': ['withFallbackClaimsLock', 'withFallbackClaimsLockResult'],
  'cursor-spawns': ['withCursorSpawnObservationLock'],
  'run-ledger': ['withRunLedgerLock', 'withRunLedgerLockResult'],
  'project-prefs': ['withProjectPrefsLock'],
  'exhausted-models': ['withExhaustedModelsLock'],
};

/**
 * EVERY ordered pair this tree takes, outer → inner, with why it is allowed.
 *
 * A pair here is a claim that the outer lock may be held across an acquisition
 * of the inner one, and — because the set is compared exactly — that the reverse
 * never happens. Adding a nesting site without adding its pair fails; adding the
 * REVERSE of any of these makes the graph cyclic and fails as a cycle.
 */
const DECLARED_PAIRS: Record<string, string> = {
  'project-state -> machine-settings': 'the reset runner clears machine state from inside the canonical '
    + 'project-state transaction (runners/traffic-one-reset/reset.ts). Nothing takes the project-state lock '
    + 'while holding a settings lock: one-settings.ts is a leaf over fs and knows no project.',
  'project-state -> project-prefs': 'the per-user prefs bucket is read and written while the canonical '
    + '.one.json transaction is open (state/normalize.ts, run-agent/run-paths.ts, the reset runner). '
    + 'prefs-store.ts is likewise a leaf and never reaches for a project-state lock.',
  'override-ledger -> machine-settings': "this lane's own, at override/token.ts's mintOverride: the mint "
    + 'transaction holds the ledger lock across the counter bump, which takes one.json\'s lock inside it. '
    + 'The ledger lock is taken at exactly one site, so the reverse cannot be formed. It was documented '
    + 'only as timeout ARITHMETIC (a statement about admitting waiters, not about acquisition order); the '
    + 'arithmetic is what makes the nesting affordable, and this is what makes it a rule.',
  'identity-claims -> role-registry': 'stated at run-agent/rebind-journal.ts:154 and cited by '
    + 'registry-refresh.ts:148 — identity claim, then role registry, then fallback path claims.',
  'identity-claims -> fallback-claims': 'the third step of the same written order.',
  'role-registry -> fallback-claims': 'the second step of the same written order. obligations.ts:1005 '
    + 'independently declines to hold two registry leases at once, naming the hazard.',
  'identity-claims -> run-ledger': 'claims-store.ts mints the run ledger entry inside the identity-claim '
    + 'hold (also claim-thread-role.ts and context-resolve.ts, which this closure does not reach). '
    + 'Undocumented until now: the ledger lease must always be the INNER one.',
  'cursor-spawns -> role-registry': 'registry-refresh.ts holds the spawn-observation lock while '
    + 'conditionally upgrading agents.json, so the registry lease is taken inside it. Undocumented until '
    + 'now, and it is what puts cursor-spawns first in the run-agent order.',
};

interface Section { readonly file: string; readonly lock: string; readonly inner: readonly string[] }

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Comments are blanked rather than removed, so every offset still lines up.
 *  A docblock naming a wrapper is prose, not a call site. */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

function matchingParen(source: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `name(`, `name<T>(` — the explicit type argument is the spelling whose
 *  absence emptied the first draft of this file. */
function callSites(source: string, name: string): { at: number; region: string }[] {
  const re = new RegExp(`(^|[^\\w.$])${name}\\s*(?:<[^()<>]*>)?\\s*\\(`, 'g');
  const out: { at: number; region: string }[] = [];
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const at = m.index + (m[1] as string).length;
    // A DECLARATION is not a critical section.
    if (/\bfunction\s+$/.test(source.slice(Math.max(0, at - 24), at))) continue;
    const open = source.indexOf('(', m.index + (m[0] as string).length - 1);
    const close = matchingParen(source, open);
    if (close < 0) continue;
    out.push({ at, region: source.slice(open + 1, close) });
  }
  return out;
}

function declarations(source: string, into: Map<string, string[]>): void {
  const sig = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = sig.exec(source); m; m = sig.exec(source)) {
    const close = matchingParen(source, source.indexOf('(', m.index + (m[0] as string).length - 1));
    if (close < 0) continue;
    const open = source.indexOf('{', close);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    const name = m[1] as string;
    if (!into.has(name)) into.set(name, []);
    (into.get(name) as string[]).push(source.slice(open, end + 1));
  }
}

const wrapperToLock = new Map<string, string>();
for (const [lock, wrappers] of Object.entries(LOCKS)) for (const w of wrappers) wrapperToLock.set(w, lock);

const files = sourceFiles(SRC_ROOT);
const sources = new Map(files.map((file) => [file, blankComments(fs.readFileSync(file, 'utf8'))]));
const declared = new Map<string, string[]>();
for (const source of sources.values()) declarations(source, declared);

const acquiresMemo = new Map<string, Set<string>>();

function locksIn(text: string, seen: Set<string>): Set<string> {
  const found = new Set<string>();
  const called = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w.$])(\w+)\s*(?:<[^()<>]*>)?\s*\(/g)) called.add(m[2] as string);
  for (const name of called) for (const lock of acquires(name, seen)) found.add(lock);
  return found;
}

function acquires(name: string, seen: Set<string>): Set<string> {
  const own = wrapperToLock.get(name);
  if (own) return new Set([own]);
  if (seen.has(name)) return new Set();
  const cached = acquiresMemo.get(name);
  if (cached && seen.size === 0) return cached;
  const bodies = declared.get(name);
  if (!bodies) return new Set();
  const next = new Set(seen);
  next.add(name);
  const out = new Set<string>();
  for (const body of bodies) for (const lock of locksIn(body, next)) out.add(lock);
  if (seen.size === 0) acquiresMemo.set(name, out);
  return out;
}

const sections: Section[] = [];
for (const [file, source] of sources) {
  for (const [wrapper, lock] of wrapperToLock) {
    for (const site of callSites(source, wrapper)) {
      const inner = [...locksIn(site.region, new Set([wrapper]))].filter((l) => l !== lock);
      sections.push({ file: path.relative(SRC_ROOT, file), lock, inner });
    }
  }
}

const observed = new Map<string, Set<string>>();
for (const section of sections) {
  for (const inner of section.inner) {
    const key = `${section.lock} -> ${inner}`;
    if (!observed.has(key)) observed.set(key, new Set());
    (observed.get(key) as Set<string>).add(section.file);
  }
}

/** The first cycle in `edges`, or null. Kept separate from the data so the
 *  non-vacuity cell below can hand it a graph that is known to have one. */
function firstCycle(edges: readonly string[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const [from, to] = edge.split(' -> ') as [string, string];
    if (!next.has(from)) next.set(from, []);
    (next.get(from) as string[]).push(to);
  }
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const walk = (node: string): string[] | null => {
    if (state.get(node) === 'open') return [...stack.slice(stack.indexOf(node)), node];
    if (state.get(node) === 'done') return null;
    state.set(node, 'open');
    stack.push(node);
    for (const to of next.get(node) ?? []) {
      const found = walk(to);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of next.keys()) {
    const found = walk(node);
    if (found) return found;
  }
  return null;
}

test('every lock in the inventory has a critical section this analysis actually opened', (t) => {
  // THE ASSERTION THAT CATCHES A VACUOUS RUN. Both earlier attempts at this
  // analysis printed a verdict over a graph built from nothing, and the cycle
  // checker was happy with all of them — an empty graph is acyclic.
  const counted = new Map<string, number>();
  for (const lock of Object.keys(LOCKS)) counted.set(lock, 0);
  for (const section of sections) counted.set(section.lock, (counted.get(section.lock) as number) + 1);

  const empty = [...counted].filter(([, count]) => count === 0).map(([lock]) => lock);
  assert.deepEqual(empty, [],
    `these locks were counted CLEAN without a single critical section being examined: ${empty.join(', ')}. `
    + 'An analysis that cannot find a lock\'s call sites reports the same verdict as one that finds them all '
    + 'obeying the order — the first draft of this file did exactly that for exhausted-models, because its '
    + 'call matcher did not allow an explicit type argument.');
  t.diagnostic(`critical sections: ${[...counted].map(([l, c]) => `${l}=${c}`).join(' ')} `
    + `(total ${sections.length}, ${sections.filter((s) => s.inner.length > 0).length} of them nesting)`);
});

test('the nesting sites in this tree are exactly the ordered pairs written down here', (t) => {
  const found = [...observed.keys()].sort();
  const expected = Object.keys(DECLARED_PAIRS).sort();
  assert.deepEqual(found, expected,
    'a lock nesting changed. Every pair below is a rule — the outer lock may be held across the inner one, '
    + 'and the reverse never happens — so a NEW pair has to be argued and written into DECLARED_PAIRS, and a '
    + 'pair that has disappeared means the discipline it recorded is no longer being kept by the code that '
    + `taught it.\n  found:    ${found.join('\n            ')}\n  declared: ${expected.join('\n            ')}`);
  for (const [pair, files_] of observed) t.diagnostic(`${pair} — ${[...files_].join(', ')}`);
});

test('the declared order is acyclic, so no two of these can wait on each other', () => {
  const cycle = firstCycle(Object.keys(DECLARED_PAIRS));
  assert.equal(cycle, null,
    `these locks can be taken in a cycle: ${(cycle ?? []).join(' -> ')}. Both holders reach their deadline `
    + 'and both refuse, which no amount of retrying fixes.');
});

test('the cycle checker is not answering ACYCLIC to everything', () => {
  // Non-vacuity for the checker itself, by planting the reverse of two real
  // edges — the same way the enumeration behind this table was proven
  // non-vacuous. A checker that cannot see these is not evidence for the cell
  // above.
  for (const planted of ['machine-settings -> override-ledger', 'role-registry -> identity-claims']) {
    const cycle = firstCycle([...Object.keys(DECLARED_PAIRS), planted]);
    assert.notEqual(cycle, null, `the reversed edge ${planted} must be reported as a cycle`);
  }
  assert.equal(firstCycle(['a -> b', 'b -> c']), null, 'and an acyclic graph must not be reported as one');
});
