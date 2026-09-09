import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isExistingProjectMode, isMaintenancePhase, isNewProjectMode, maintenanceLifecycle, markMaintenance, projectPhase } from '../lifecycle';
import { readState, statePath } from '../normalize';

test('isExistingProjectMode keys on the raw mode only, never on lifecycle', () => {
  assert.equal(isExistingProjectMode({ mode: 'existing-codebase' }), true);
  assert.equal(isExistingProjectMode({ mode: 'existing-with-supabase' }), true);
  assert.equal(isExistingProjectMode({ mode: ' Existing-Codebase ' }), true);
  assert.equal(isExistingProjectMode({ mode: 'new-project' }), false);
  assert.equal(isExistingProjectMode({}), false);
  assert.equal(isExistingProjectMode(null), false);
  assert.equal(isExistingProjectMode({ mode: 42 }), false);
  // A completed new-project build is maintenance PHASE but not an existing
  // codebase — its architecture gates keep applying.
  assert.equal(
    isExistingProjectMode({ mode: 'new-project', lifecycle: { phase: 'maintenance' } }),
    false,
  );
});

// The two mode tests are not complements, and the gap between them is where an
// UNDECLARED mode lives: armed for an architecture gate, stood down for one that
// would otherwise judge the project against a guessed stack.
test('isNewProjectMode is the positive test, not the negation of isExistingProjectMode', () => {
  assert.equal(isNewProjectMode({ mode: 'new-project' }), true);
  assert.equal(isNewProjectMode({ mode: ' New-Project ' }), true,
    'same normalization as its sibling, or hand-edited casing switches gates off');
  assert.equal(isNewProjectMode({ mode: 'existing-codebase' }), false);
  for (const undeclared of [{}, null, { mode: 42 }, { mode: 'workspace' }]) {
    assert.equal(isNewProjectMode(undeclared), false);
    assert.equal(isExistingProjectMode(undeclared), false,
      'neither answers true, which is the point: undeclared is its own state');
  }
});

// The predicate is only worth having where it is USED. Sharing `normalizedMode`
// between the two functions in this file made them agree with each other and
// with nothing else: the raw `state.mode === 'new-project'` was still spelled at
// ~50 sites, so ` New-Project ` armed the install gate — which reads the
// predicate — while standing down the nine toolchain gates, the implementer
// battery and the scaffold gate, which did not. A disagreeing site is a fence
// with a gap in it, and the gap is invisible at the site itself.
// The old scan matched exactly `/mode\s*(?:!==|===)\s*'new-project'/` in
// src/modules and src/hooks, and both of those narrownesses hid live offenders.
//
// The SIDE: `mode === 'existing-codebase' || mode === 'existing-with-supabase'`
// passed it, in session-start.ts and session-start-lib.ts, and the existing side
// does not normalize either — so ` Existing-Codebase ` read as existing to every
// gate (`isExistingProjectMode` trims and lower-cases) and as neither to those
// two, which decide whether a project gets Flow 2's detection stamp and whether
// its code graph is ever built.
//
// The SPELLING: a raw comparison is equally raw written with double quotes, a
// template literal, `==`, a `switch`, `.startsWith('existing')`, an array
// `.includes(mode)`, a named constant holding the mode string, or a line break
// before the operator. Each of those is one keystroke from the spelling the old
// regex caught, and none of them was.
const MODE_LITERALS = ['new-project', 'existing-codebase', 'existing-with-supabase', 'existing'];
const QUOTED_MODE = `(?:'|"|\`)(?:${MODE_LITERALS.join('|')})(?:'|"|\`)`;
// A mode-ish operand: bare `mode`, `state.mode`, `s?.mode`, `raw.mode`,
// `rawMode`, `state['mode']`. Anything whose last identifier ENDS in mode/Mode,
// with whatever member access leads up to it.
const MODE_OPERAND = String.raw`[\w$.?!\[\]'"]*\b\w*[Mm]ode\b`;

interface Spelling { readonly id: string; readonly re: RegExp }

function rawModeSpellings(constants: readonly string[]): Spelling[] {
  const named = constants.length > 0 ? `|${constants.join('|')}` : '';
  return [
    // mode === 'new-project' (any quote style, `==`, newline before the operator)
    { id: 'compare', re: new RegExp(String.raw`(?:${MODE_OPERAND})\s*(?:={2,3}|!={1,2})\s*(?:${QUOTED_MODE}${named})`, 'g') },
    // 'existing-codebase' === mode — the same comparison, mirrored
    { id: 'compare-mirrored', re: new RegExp(String.raw`(?:${QUOTED_MODE})\s*(?:={2,3}|!={1,2})\s*(?:${MODE_OPERAND})`, 'g') },
    // mode.startsWith('existing') — case-sensitive prefix test
    { id: 'startsWith', re: new RegExp(String.raw`(?:${MODE_OPERAND})\s*(?:\?\.)?\s*\.?startsWith\(\s*(?:'|"|\`)(?:new-project|existing)`, 'g') },
    // ['existing-codebase', …].includes(mode) / SET.has(mode) over mode literals
    { id: 'membership', re: new RegExp(String.raw`${QUOTED_MODE}[^\n]*\]\s*\.\s*(?:includes|indexOf)\(\s*(?:${MODE_OPERAND})`, 'g') },
    // switch (state.mode) { case 'new-project':
    { id: 'switch-case', re: new RegExp(String.raw`case\s+${QUOTED_MODE}\s*:`, 'g') },
  ];
}

// Block comments, and lines that are entirely comment. Prose about the predicate
// is not a use of it — but the scan runs over the whole file text so that a
// comparison split across two lines is still one match, which means the comment
// text has to come out first.
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') found.push(...tsFilesUnder(absolute));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(absolute);
  }
  return found;
}

function rawModeOffenders(roots: readonly string[], exempt: (rel: string) => boolean): string[] {
  const repoSrc = path.join(__dirname, '..', '..', '..');
  const offenders: string[] = [];
  for (const root of roots) {
    for (const absolute of tsFilesUnder(path.join(repoSrc, root))) {
      const rel = path.relative(repoSrc, absolute).split(path.sep).join('/');
      if (exempt(rel)) continue;
      const source = withoutComments(fs.readFileSync(absolute, 'utf8'));
      // A constant holding a mode string makes `mode === MODE_NEW` raw too.
      const constants = [...source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*${QUOTED_MODE}`, 'g'))]
        .map((match) => match[1]!);
      for (const spelling of rawModeSpellings(constants)) {
        for (const match of source.matchAll(spelling.re)) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${rel}:${line} [${spelling.id}] ${match[0].replace(/\s+/g, ' ').trim()}`);
        }
      }
    }
  }
  return offenders.sort();
}

// `lifecycle.ts` IS the predicate — its own comparison is the one that has to be
// spelled out. `config/**` declares the mode ids. Everything else in these trees
// is a consumer and must read the mode through `isNewProjectMode` /
// `isExistingProjectMode` (or `canonicalProjectMode` when it carries the value
// rather than testing it).
const PREDICATE_HOME = new Set(['shared/state/lifecycle.ts']);

test('no gate reads the mode by raw comparison', () => {
  const offenders = rawModeOffenders(
    ['modules', 'hooks'],
    (rel) => PREDICATE_HOME.has(rel),
  );
  assert.deepEqual(offenders, [],
    'read the mode through isNewProjectMode/isExistingProjectMode — every spelling below is one '
    + `keystroke from the one this test used to catch:\n${offenders.join('\n')}`);
});

// The same contract over the trees the gates are BUILT from. Split from the test
// above only because the debt below is owned by other lanes right now, not
// because the contract is weaker here: `shared/**` holds the architecture
// compiler, the capability profile and the onboarding predicates, and a compiler
// that disagrees with the gates about what mode this project is in produces a
// contract the gates then enforce against the wrong project (measured: a
// hand-edited ` New-Project ` compiled 4 scaffold outputs where `new-project`
// compiled 43, with every deny still armed).
//
// A registry that may only SHRINK, never grow. Each entry is a live raw
// comparison with an owner outside this change; adding one is how the class comes
// back, so a new offender fails this test even though the old ones do not.
const RAW_MODE_DEBT: readonly string[] = [
  'shared/capabilities/detect-frontend.ts',
  'shared/materialize/cleanup.ts',
  'shared/materialize/converge.ts',
  // What is left of widening the scan to `runners/**`. `doctor/findings.ts` is
  // gone from this list: its `.nvmrc` finding reads the predicate, and so does
  // `doctor/lib.ts`'s decision about WHETHER the onboarding-completeness checks
  // apply at all.
  //
  // `doctor/lib.ts` stays for ONE comparison that is deliberately raw and will
  // not shrink: `onboardingStateIssues` pushes the issue named `mode` when the
  // persisted `mode` is not canonically `new-project`. That is an assertion about
  // the SPELLING rather than a question about the project, and routing it through
  // the tolerant predicate would declare a hand-edited ` New-Project ` canonical
  // and silence the one report that names the drift — `normalizeState` only fills
  // a BLANK mode, so nothing else would. Read the two comparisons there together:
  // the predicate decides that the checks apply, the raw one reports that the
  // spelling is wrong.
  'runners/doctor/lib.ts',
];

const COMPILED_CONTRACT_TREES = [
  'shared/architecture-contract',
  'shared/capabilities',
  'shared/materialize',
  'shared/skill-filters',
  'shared/state',
  'runners',
];

test('the compiler and the profile read the mode the way the gates do', () => {
  const offenders = rawModeOffenders(
    COMPILED_CONTRACT_TREES,
    (rel) => PREDICATE_HOME.has(rel) || RAW_MODE_DEBT.includes(rel),
  );
  assert.deepEqual(offenders, [],
    'a raw mode comparison in shared/** or runners/** disagrees with every gate about hand-edited '
    + `casing/whitespace. Route it through isNewProjectMode/isExistingProjectMode:\n${offenders.join('\n')}`);
});

test('the raw-comparison debt registry names only real, still-open offenders', () => {
  const stale = RAW_MODE_DEBT.filter((rel) => (
    rawModeOffenders([path.dirname(rel)], (candidate) => candidate !== rel).length === 0
  ));
  assert.deepEqual(stale, [],
    'these files no longer compare the mode raw — delete their rows from RAW_MODE_DEBT so the '
    + `registry keeps shrinking:\n${stale.join('\n')}`);
});

test('projectPhase infers maintenance for any existing-* mode and building for new-project', () => {
  assert.equal(projectPhase({ mode: 'existing-codebase' }), 'maintenance');
  assert.equal(projectPhase({ mode: 'existing-with-supabase' }), 'maintenance');
  // Hand-edited casing/whitespace tolerance — and the SAME normalization the
  // architecture-gate stand-down (isExistingProjectMode) uses, so one state
  // can never read as existing to the gates and building to phase inference.
  assert.equal(projectPhase({ mode: ' Existing-Codebase ' }), 'maintenance');
  assert.equal(projectPhase({ mode: 'new-project' }), 'building');
  assert.equal(projectPhase({}), 'building');
  // explicit mode argument takes precedence over state.mode for inference
  assert.equal(projectPhase({}, 'existing-codebase'), 'maintenance');
  assert.equal(projectPhase({ mode: 'existing-codebase' }, 'new-project'), 'building');
});

test('explicit lifecycle.phase overrides mode inference', () => {
  assert.equal(projectPhase({ mode: 'new-project', lifecycle: { phase: 'maintenance' } }), 'maintenance');
  assert.equal(projectPhase({ mode: 'existing-codebase', lifecycle: { phase: 'building' } }), 'building');
});

test('projectPhase is tolerant of hand-edited casing/whitespace, falls back on garbage', () => {
  assert.equal(projectPhase({ mode: 'new-project', lifecycle: { phase: '  Maintenance ' } }), 'maintenance');
  // invalid phase value → fall back to mode inference, not a crash
  assert.equal(projectPhase({ mode: 'new-project', lifecycle: { phase: 'bogus' } }), 'building');
  assert.equal(projectPhase({ mode: 'existing-codebase', lifecycle: 'nope' }), 'maintenance');
});

test('isMaintenancePhase mirrors projectPhase', () => {
  assert.equal(isMaintenancePhase({ mode: 'existing-codebase' }), true);
  assert.equal(isMaintenancePhase({ mode: 'new-project' }), false);
  assert.equal(isMaintenancePhase({ mode: 'new-project', lifecycle: { phase: 'maintenance' } }), true);
});

test('maintenanceLifecycle builds a canonical stamped object', () => {
  const lc = maintenanceLifecycle('orchestrator');
  assert.equal(lc.phase, 'maintenance');
  assert.equal(lc.source, 'orchestrator');
  assert.equal(typeof lc.completedAt, 'string');
  assert.ok((lc.completedAt as string).length > 0);
});

test('markMaintenance persists the flag and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-lifecycle-'));
  const prefs = path.join(dir, 'prefs.json');
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({
      mode: 'new-project', stack: 'minimal', frontend: 'react-vite', backend: 'none',
      currentRunId: 'run-flip', note: 'keep-me',
    }));
    const claimFile = path.join(dir, '.traffic-one', 'runs', 'run-flip', 'child1.json');
    fs.mkdirSync(path.dirname(claimFile), { recursive: true });
    fs.writeFileSync(claimFile, JSON.stringify({
      version: 1, runId: 'run-flip', claimId: 'senior-frontend-1-a', role: 'senior-frontend',
      status: 'claimed', createdAt: new Date().toISOString(), sessionId: 'child1',
    }), 'utf8');

    assert.equal(projectPhase(readState(dir), 'new-project'), 'building');

    assert.equal(markMaintenance(dir, 'heuristic'), true);
    // The flip sweeps the settled run's claims: claimed → released.
    const releasedClaim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    assert.equal(releasedClaim.status, 'released');
    assert.equal(releasedClaim.releasedReason, 'maintenance-flip');
    const after = readState(dir);
    assert.equal(after.note, 'keep-me', 'patchState must not drop fields it does not own');
    assert.equal(projectPhase(after, after.mode), 'maintenance');
    const lifecycle = after.lifecycle as Record<string, unknown>;
    assert.equal(lifecycle.phase, 'maintenance');
    assert.equal(lifecycle.source, 'heuristic');

    // a second heuristic call is a no-op…
    assert.equal(markMaintenance(dir, 'heuristic'), false);
    // …but the orchestrator source refreshes the completion watermark, so a
    // finished maintenance run does not suppress triage behind stale claims
    assert.equal(markMaintenance(dir, 'orchestrator'), true);
    const refreshed = readState(dir).lifecycle as Record<string, unknown>;
    assert.equal(refreshed.source, 'orchestrator');
    assert.equal(markMaintenance(dir, 'heuristic'), false);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
