// Scaffold content seeding (1.0.37, 8co): .prettierignore ships its canonical
// skip list and .env.example ships the VITE_SITE_URL contract — content is
// runtime knowledge, seeded only when the file is missing or blank. Compliant
// module skeletons ride the same call on greenfield runs: models edit, they
// don't author (the 13co deny classes all began with de-novo authoring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  compileArchitecture,
  ensureProjectGitignore,
  ensureScaffoldContent,
  projectOwnedGitignore,
  scaffoldFileContent,
  type ArchitectureInputV1,
} from '../architecture-contract';
import { greenfieldEvidence } from '../greenfield-evidence';
import {
  projectDeclaresSlot,
  slotAcceptsScaffold,
} from '../architecture-contract/convention-evidence';
import {
  GITIGNORE_BLOCK_END,
  GITIGNORE_BLOCK_START,
  siteUrlEnvVarForFramework,
  TRAFFIC_ONE_BLOCK_BODY,
} from '../architecture-contract/scaffold-content';
import { detectMode } from '../detection/artifacts';

function withTempDir<T>(body: (cwd: string) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-scaffold-content-'));
  try {
    return body(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// A temp dir with a NESTED project root, so a fixture can own a real repository
// one level ABOVE the project — the shape where a project root is a tracked
// subdirectory (`bigrepo/web`) and has no `.git` of its own.
function withNestedTempDir<T>(body: (project: string, parent: string) => T): T {
  return withTempDir((parent) => {
    const project = path.join(parent, 'proj');
    fs.mkdirSync(project, { recursive: true });
    return body(project, parent);
  });
}

function writeFileAt(root: string, rel: string, body: string): void {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body, 'utf8');
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [
    '-c', 'user.email=scaffold-content@test', '-c', 'user.name=test',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, stdio: 'ignore' });
}

/** A REAL repository with at least one commit — the whole point of the fixture. */
function initAndCommit(cwd: string): void {
  git(cwd, ['init', '-q']);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'initial']);
}

test('canonical bodies exist for .prettierignore and .env.example only', () => {
  assert.match(String(scaffoldFileContent('.prettierignore')), /\.traffic-one\//);
  assert.match(String(scaffoldFileContent('.prettierignore')), /pnpm-lock\.yaml/);
  assert.match(String(scaffoldFileContent('.prettierignore')), /\.turbo\//);
  assert.equal(scaffoldFileContent('package.json'), null);
  assert.equal(scaffoldFileContent('apps/web/src/App.tsx'), null);
});

// `.env.example` is owned by senior-backend on EVERY profile that has one, so an
// unconditional Vite body seeded `VITE_SITE_URL=` into API-only projects (15cl:
// the Go backend replaced it by hand). A caller with no profile cannot be assumed
// to be building a web surface.
test('.env.example is web-shaped only where a web surface exists', () => {
  withTempDir((cwd) => {
    const service = compileArchitecture(cwd, 'R', {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'store', name: 'Store', kind: 'store' }],
    } as ArchitectureInputV1);
    const goBody = String(scaffoldFileContent('.env.example', service.profile));
    assert.doesNotMatch(goBody, /VITE_/, 'a Go API must not be handed Vite crawl-origin variables');
    assert.match(goBody, /^PORT=$/m);
    assert.doesNotMatch(String(scaffoldFileContent('.env.example')), /VITE_/, 'no profile must not imply a web surface');
  });
});

// One authority, two encodings: `lint:css` globs `**/*.css` across the repo, so a
// stylelint config without ignoreFiles lints the build output it just produced
// (249 errors in 14co, 182 in 15co). Iterating the prettier list is what keeps
// the two from drifting apart again.
test('the stylelint ignore list covers everything .prettierignore skips', () => {
  const stylelint = JSON.parse(String(scaffoldFileContent('.stylelintrc.json'))) as { ignoreFiles?: string[] };
  const ignoreFiles = stylelint.ignoreFiles || [];
  assert.ok(ignoreFiles.length > 0, 'a repo-wide lint:css glob needs an ignore list');
  const skipped = String(scaffoldFileContent('.prettierignore'))
    .split('\n')
    .filter((line) => line.endsWith('/') && !line.startsWith('#'))
    .map((line) => line.slice(0, -1));
  for (const dir of skipped) {
    assert.ok(
      ignoreFiles.includes(`**/${dir}/**`),
      `stylelint must skip ${dir}/ — the formatter already does`,
    );
  }
});

test('seeds missing and blank files; never overwrites agent content', () => {
  withTempDir((cwd) => {
    const outputs = [
      { path: '.prettierignore' },
      { path: '.env.example' },
      { path: 'apps/web/package.json' },
    ];
    // Blank .prettierignore (the exact 8co shape) + no .env.example.
    fs.writeFileSync(path.join(cwd, '.prettierignore'), '\n');
    const written = ensureScaffoldContent(cwd, outputs);
    assert.deepEqual(written.sort(), ['.env.example', '.prettierignore']);
    assert.match(fs.readFileSync(path.join(cwd, '.prettierignore'), 'utf8'), /\.traffic-one\//);
    // No profile passed here, so the framework-neutral service body is correct;
    // the web/service split has its own test above.
    assert.match(fs.readFileSync(path.join(cwd, '.env.example'), 'utf8'), /^PORT=$/m);

    // A second pass changes nothing, and agent-authored content is preserved.
    fs.writeFileSync(path.join(cwd, '.prettierignore'), 'custom-entry\n');
    const second = ensureScaffoldContent(cwd, outputs);
    assert.deepEqual(second, []);
    assert.equal(fs.readFileSync(path.join(cwd, '.prettierignore'), 'utf8'), 'custom-entry\n');
  });
});

// --- module skeletons (Part 6): models edit, they don't author --------------

const SKELETON_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home', name: 'Home', kind: 'page' },
    { id: 'nav-bar', name: 'Nav Bar', kind: 'component' },
    { id: 'sync-service', name: 'Sync Service', kind: 'service' },
  ],
  // Two locales on purpose: catalog seeds must appear in EVERY declared locale,
  // the source locale with the declared copy and the others clearly marked TODO.
  i18n: { sourceLocale: 'en', locales: ['en', 'ro'] },
};

const REACT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

function moduleOutput(compiled: { modules: Array<{ id: string; output: string }> }, id: string): string {
  const module = compiled.modules.find((candidate) => candidate.id === id);
  assert.ok(module, `compiled contract must hold module ${id}`);
  return module!.output;
}

test('greenfield materialization emits compliant module skeletons with catalog seeds in all locales', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });

    // The page skeleton at its DEFAULT compiled path: named component, correct
    // framework form, i18n wired through <Trans ns i18nKey> with the declared
    // source copy as visible fallback.
    const page = moduleOutput(compiled, 'home');
    assert.ok(written.includes(page));
    const pageBody = fs.readFileSync(path.join(cwd, page), 'utf8');
    assert.match(pageBody, /export default function Home\(\)/);
    assert.match(pageBody, /<Trans ns="home-route" i18nKey="title">Home<\/Trans>/);

    // The app shell wires every compiled route to its compiled page module
    // and imports every compiled feature/component (STRUCT_ORPHAN_MODULE).
    const shellBody = fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'app-shell')), 'utf8');
    assert.match(shellBody, /import Home from '\.\/pages\/Home';/);
    assert.match(shellBody, /<Route path="\/" element=\{<Home \/>\} \/>/);
    assert.match(shellBody, /import \* as NavBarModule from '/);
    assert.match(shellBody, /void \[NavBarModule\];/);

    // Components export the compiled Pascal name; services get a typed empty
    // export under it, so planned consumers keep resolving.
    assert.match(
      fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'nav-bar')), 'utf8'),
      /export function NavBar\(/,
    );
    assert.match(
      fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'sync-service')), 'utf8'),
      /export const SyncService: SyncServiceContract = \{\};/,
    );

    // Catalog seeds in EVERY declared locale: source copy in `en`, a marked
    // TODO in `ro` — the exact i18n-seed contract.
    const catalogFor = (locale: string): string => {
      const catalog = (compiled.i18n?.catalogs || []).find((candidate) => (
        candidate.locales.includes(locale) && candidate.namespaces.includes('home-route')
      ));
      assert.ok(catalog, `compiled i18n must declare a ${locale}/home-route catalog`);
      return catalog!.path;
    };
    const en = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('en')), 'utf8')) as Record<string, string>;
    assert.equal(en.title, 'Home');
    const ro = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('ro')), 'utf8')) as Record<string, string>;
    assert.equal(ro.title, 'TODO(en copy): Home');
  });
});

test('a non-empty existing module file is never overwritten, and existing-codebase runs emit no skeletons', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const page = moduleOutput(compiled, 'home');
    fs.mkdirSync(path.dirname(path.join(cwd, page)), { recursive: true });
    fs.writeFileSync(path.join(cwd, page), 'export default function Custom() {}\n');
    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
    assert.ok(!written.includes(page), 'agent content must never be reseeded');
    assert.equal(
      fs.readFileSync(path.join(cwd, page), 'utf8'),
      'export default function Custom() {}\n',
    );
  });

  withTempDir((cwd) => {
    // Same guard the scaffold table uses: skeletons are greenfield-only.
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: false,
    });
    for (const module of compiled.modules) {
      assert.ok(!written.includes(module.output));
      assert.ok(!fs.existsSync(path.join(cwd, module.output)), `${module.output} must not exist`);
    }
  });
});

test('vue greenfield materialization emits SFC skeletons and nests catalog seeds by namespace', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'vue',
      backend: 'none',
      mobile: { framework: 'none' },
    }, SKELETON_INPUT);
    assert.equal(compiled.profile.profileId, 'vue');
    ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });

    // A Vue page is an SFC whose visible text is an interpolation — the form
    // the markup scanner accepts — never a `.ts`-shaped module in a .vue path.
    const page = moduleOutput(compiled, 'home');
    assert.match(page, /\.vue$/);
    const pageBody = fs.readFileSync(path.join(cwd, page), 'utf8');
    assert.match(pageBody, /<script setup lang="ts">/);
    assert.match(pageBody, /\{\{ t\("title"\) \}\}/);
    const shellBody = fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'app-shell')), 'utf8');
    assert.match(shellBody, /<router-view \/>/);

    // Per-locale multi-namespace catalogs nest the seeded key by namespace.
    const catalogFor = (locale: string): string => {
      const catalog = (compiled.i18n?.catalogs || []).find((candidate) => (
        candidate.locales.includes(locale)
      ));
      assert.ok(catalog, `compiled i18n must declare a ${locale} catalog`);
      return catalog!.path;
    };
    const en = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('en')), 'utf8')) as Record<string, Record<string, string>>;
    assert.equal(en['home-route']?.title, 'Home');
    const ro = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('ro')), 'utf8')) as Record<string, Record<string, string>>;
    assert.equal(ro['home-route']?.title, 'TODO(en copy): Home');
  });
});

// The seeded variable must be the one the framework's bundler actually reads,
// and the SAME one the compiled integration requirement names. Two independent
// tables would drift silently: both values are empty, so nothing fails loudly —
// the role is simply pointed at a contract it cannot find.
test('.env.example seeds the site-url variable the framework actually reads', () => {
  const cases: Array<[string, string]> = [
    ['react-vite', 'VITE_SITE_URL='],
    ['nextjs', 'NEXT_PUBLIC_SITE_URL='],
    ['nuxt', 'NUXT_PUBLIC_SITE_URL='],
    ['sveltekit', 'PUBLIC_SITE_URL='],
    ['laravel', 'APP_URL='],
    ['angular', 'SITE_URL='],
  ];
  for (const [framework, expected] of cases) {
    assert.equal(siteUrlEnvVarForFramework(framework), expected.replace('=', ''));
  }
  // Negative row: an unknown framework falls back to the Vite name rather than
  // emitting an empty or invented variable.
  assert.equal(siteUrlEnvVarForFramework('something-new'), 'VITE_SITE_URL');
  assert.equal(siteUrlEnvVarForFramework(undefined), 'VITE_SITE_URL');
});

// --- ensureProjectGitignore: idempotent delimited-block convergence --------
// The greenfield seedIfBlank path above only ever fires under the compiler's
// `isNewProject` branch, so an existing repo's `.gitignore` never converged.
// ensureProjectGitignore is the fix's writer, wired into materializeProjectAssets
// (shared/materialize/materialize.ts) so it runs for every mode.
//
// Authority is split: only a genuinely greenfield project may carry the full
// SKIP_DIRS-derived opinions (`GITIGNORE_BODY`); every other mode gets ONLY
// Traffic One's own paths — deciding vendor/, dist/, target/, etc. for a repo we
// did not create is not ours to make (Go commonly commits `vendor/`, published
// libraries commonly commit `dist/`/`build/`, and git ignore rules never untrack
// what is already committed, so getting this wrong fails silently on the next
// new file under one of those directories).
//
// WHICH side a project is on is recorded in the block itself (`scope=full` /
// `scope=traffic-one` on the start marker) and read back from the FILE on every
// later call. The flag is not a trustworthy statement about history:
// materializeProjectAssets derives it from `state.mode`, and
// `onboarding/repair.ts` re-derives a lost mode through `detectMode(cwd)`, which
// counts source files — so a greenfield project that has since been populated
// comes back `existing-codebase` and its next call arrives with
// `newProject: false`. The tests below pin that this can no longer narrow an
// established block.
//
// The flag is not trustworthy in the OTHER direction either, which is the
// second half of the contract these tests pin. `detectMode` counts only files
// whose extension is in `SOURCE_EXTS`, so it answers `new-project` for any
// repository with five or fewer of them: a Terraform stack, a dbt project, a
// docs site, an Elixir app, a shell-tooling repo, a 3-file Go module with a
// COMMITTED `vendor/`, a 4-file published library with a COMMITTED `dist/`.
// Creating a `full` block for those imposed `node_modules/ dist/ build/
// vendor/ target/ .env` on a repo Traffic One did not create — permanently,
// since the recorded scope is authoritative afterwards. So a `full` block now
// needs the flag AND positive EVIDENCE on disk (`greenfieldEvidence`: no
// `.gitignore` content and no commit in the repository that owns the project
// root). The evidence is a veto only: it never widens a block the caller did
// not ask to widen.

// The on-disk block format, spelled out here independently of the writer so a
// change to it is a deliberate edit in two places rather than something an
// exact-bytes assertion silently ratifies.
function blockFor(scope: 'full' | 'traffic-one', body: string): string {
  return `${GITIGNORE_BLOCK_START} scope=${scope}\n${body.trimEnd()}\n${GITIGNORE_BLOCK_END}\n`;
}

/** The pre-scope format: every block written by a release before this one. */
function untaggedBlockFor(body: string): string {
  return `${GITIGNORE_BLOCK_START}\n${body.trimEnd()}\n${GITIGNORE_BLOCK_END}\n`;
}

function fullBlock(): string {
  return blockFor('full', String(scaffoldFileContent('.gitignore')));
}

function narrowBlock(): string {
  return blockFor('traffic-one', TRAFFIC_ONE_BLOCK_BODY);
}

// Opinions that must never be removed from a project that already carried them.
// `.env` is the one that turns a silent regression into committed secrets.
const SKIP_DIR_OPINIONS = [
  'node_modules/', 'dist/', 'build/', 'vendor/', 'target/', 'generated/', '.env',
] as const;

function gitignoreOf(cwd: string): string {
  return fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
}

function contentLines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\r$/, ''));
}

function ruleCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of contentLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  return counts;
}

/**
 * Drives three consecutive convergences over whatever fixture is on disk and
 * enforces the WHOLE contract at once, which is what every adversarial shape
 * below is measured against:
 *
 *  - byte-identity across the three calls (and `false` from calls 2 and 3),
 *  - every named owner line still present verbatim,
 *  - no rule line more duplicated than the fixture already had it,
 *  - no ignore rule the file already carried removed,
 *  - and, where given, the exact resulting bytes.
 *
 * `untouched` additionally demands that call 1 wrote nothing at all — the
 * contract for a malformed marker pair.
 */
function assertShapeConverges(cwd: string, opts: {
  newProject?: boolean;
  owner?: readonly string[];
  expected?: string;
  untouched?: boolean;
} = {}): string {
  const file = path.join(cwd, '.gitignore');
  const before = fs.existsSync(file) && fs.lstatSync(file).isFile() ? gitignoreOf(cwd) : '';
  const call = (): boolean => ensureProjectGitignore(cwd, { newProject: opts.newProject });

  const changed = call();
  const first = gitignoreOf(cwd);
  if (opts.untouched) {
    assert.equal(changed, false, 'a malformed marker pair must be refused, not repaired');
    assert.equal(first, before, 'a refused file must not lose or gain a single byte');
  }
  assert.equal(call(), false, 'second call must report no change');
  assert.equal(gitignoreOf(cwd), first, 'second call must be byte-identical');
  assert.equal(call(), false, 'third call must report no change');
  assert.equal(gitignoreOf(cwd), first, 'third call must be byte-identical');

  const lines = contentLines(first);
  for (const line of opts.owner || []) {
    assert.ok(lines.includes(line), `owner line must survive verbatim: ${JSON.stringify(line)}`);
  }
  const had = ruleCounts(before);
  for (const [line, count] of ruleCounts(first)) {
    assert.ok(
      count <= Math.max(1, had.get(line) || 0),
      `convergence duplicated a rule: ${line} appears ${count}x`,
    );
  }
  for (const opinion of SKIP_DIR_OPINIONS) {
    if (before.includes(opinion)) {
      assert.ok(first.includes(opinion), `${opinion} was already ignored and must never be removed`);
    }
  }
  if (opts.expected !== undefined) assert.equal(first, opts.expected, 'exact resulting bytes');
  return first;
}

test('ensureProjectGitignore: default (existing project) writes ONLY Traffic One\'s own paths, never the SKIP_DIRS opinions', () => {
  withTempDir((cwd) => {
    assert.equal(ensureProjectGitignore(cwd), true);
    const first = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(first.startsWith(GITIGNORE_BLOCK_START));
    assert.ok(first.trimEnd().endsWith(GITIGNORE_BLOCK_END));
    assert.match(first, /\.traffic-one\/debug\//);
    assert.match(first, /\.traffic-one\/runs\//);
    for (const opinion of ['node_modules/', 'dist/', 'build/', 'vendor/', 'target/', 'generated/', '.env']) {
      assert.ok(!first.includes(opinion), `${opinion} is the scaffold's opinion, not ours to impose on an existing repo`);
    }

    // A no-op re-run must be byte-identical, not merely logically equivalent.
    const before = fs.readFileSync(path.join(cwd, '.gitignore'));
    assert.equal(ensureProjectGitignore(cwd), false);
    assert.ok(before.equals(fs.readFileSync(path.join(cwd, '.gitignore'))));
  });

  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), '  \n\n\t\n', 'utf8');
    assert.equal(ensureProjectGitignore(cwd), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(body.startsWith(GITIGNORE_BLOCK_START));
    assert.ok(!body.includes('node_modules/'));
  });
});

// Re-anchored (peer review): the scenario is unchanged — a greenfield project
// gets the full seed wrapped in the block — but the AUTHORITY for it is no
// longer the caller's flag. It is the project's own disk state: an empty
// directory with no `.gitignore` and no committed history. Both authorities that
// can put the full body on disk are exercised here, so removing either one
// fails this test rather than silently costing a real greenfield project its
// `node_modules/`/`dist/` rules.
test('ensureProjectGitignore: a PROVABLY greenfield project gets the full seed, wrapped in the block', () => {
  withTempDir((cwd) => {
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(body.startsWith(GITIGNORE_BLOCK_START));
    assert.match(body, /node_modules\//, 'a genuinely greenfield project still gets the full informed opinion');
    assert.match(body, /\.traffic-one\/debug\//);
    assert.match(body, /!\.env\.example/);

    // No-op re-run, and no drift toward the narrow body on a later call.
    const before = fs.readFileSync(path.join(cwd, '.gitignore'));
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), false);
    assert.ok(before.equals(fs.readFileSync(path.join(cwd, '.gitignore'))));
  });

  // The other authority, same scenario: the scaffold seed. `.gitignore` is in
  // REPOSITORY_SCAFFOLD_OUTPUTS, so a greenfield run writes the full body from
  // here too, and convergence wraps it WHOLE.
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
    assert.match(gitignoreOf(cwd), /node_modules\//, 'the greenfield scaffold seeds the full body');
    assertShapeConverges(cwd, { newProject: true, expected: fullBlock() });
  });

  // The negative half, and the defect this replaces: the SAME `newProject: true`
  // against a repository with history must NOT produce the full body. Nothing
  // about the flag changed — only that it is no longer sufficient on its own.
  withTempDir((cwd) => {
    writeFileAt(cwd, 'main.tf', 'resource "null_resource" "a" {}\n');
    initAndCommit(cwd);
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    assert.equal(gitignoreOf(cwd), narrowBlock(), 'a guess alone may not create a full block');
  });
});

test('ensureProjectGitignore appends below an existing file, preserving the owner\'s lines byte-for-byte', () => {
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'my-custom-ignore/\nsecrets.txt\n', 'utf8');
    assert.equal(ensureProjectGitignore(cwd), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(
      body.startsWith(`my-custom-ignore/\nsecrets.txt\n\n${GITIGNORE_BLOCK_START}`),
      'the owner\'s two lines are untouched, exactly one blank line above the block',
    );
    assert.ok(!body.includes('node_modules/'), 'an existing project never gets the scaffold opinions appended either');

    // Idempotent: nothing churns on a second pass over the same content.
    assert.equal(ensureProjectGitignore(cwd), false);
  });
});

test('ensureProjectGitignore leaves a file already carrying an identical block byte-identical', () => {
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'keep-me/\n', 'utf8');
    ensureProjectGitignore(cwd);
    const before = fs.readFileSync(path.join(cwd, '.gitignore'));
    assert.equal(ensureProjectGitignore(cwd), false, 'an unchanged block is a true no-op');
    const after = fs.readFileSync(path.join(cwd, '.gitignore'));
    assert.ok(before.equals(after), 'byte-identical, not just logically equivalent');
  });
});

test('ensureProjectGitignore replaces a stale block in place without touching the owner\'s lines', () => {
  withTempDir((cwd) => {
    const stale = [
      'keep-me/',
      '',
      GITIGNORE_BLOCK_START,
      '# generated by traffic-one — an older body',
      '.traffic-one/runs/',
      GITIGNORE_BLOCK_END,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(cwd, '.gitignore'), stale, 'utf8');
    assert.equal(ensureProjectGitignore(cwd), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(body.startsWith(`keep-me/\n\n${GITIGNORE_BLOCK_START}`), 'the preamble above the block is untouched');
    assert.ok(!body.includes('an older body'), 'the stale block content is gone, not left duplicated alongside the fresh one');
    assert.match(body, /\.traffic-one\/debug\//, 'the block was refreshed to the current body');
    assert.equal(body.split(GITIGNORE_BLOCK_START).length - 1, 1, 'exactly one start marker — never duplicated');
    assert.equal(body.split(GITIGNORE_BLOCK_END).length - 1, 1, 'exactly one end marker — never duplicated');

    // Idempotent once refreshed.
    assert.equal(ensureProjectGitignore(cwd), false);
  });
});

// The migration case the reviewer flagged by name: a greenfield project whose
// `.gitignore` was seeded RAW by the compiler's scaffold path
// (ensureScaffoldContent → seedIfBlank) before this block existed at all. That
// content is byte-equal to GITIGNORE_BODY, unmarked. The first convergence
// must wrap it WHOLE (never narrow it down to just the Traffic One paths —
// that would silently delete ignore rules the scaffold legitimately wrote),
// and — the part that is easy to get wrong — every SUBSEQUENT call must keep
// refreshing the FULL body even when the caller now says `newProject: false`.
//
// The predecessor of this test passed `newProject: true` on all three calls,
// which is the one combination that cannot narrow: it asserted the defense's
// happy path and would have passed with or without the defense. Every later
// call below deliberately passes `false`.
test('ensureProjectGitignore wraps a pre-existing unmarked scaffold body whole, and never narrows it on later calls', () => {
  withTempDir((cwd) => {
    // The exact shape ensureScaffoldContent's seedIfBlank writes on a greenfield
    // run — before this block existed and before it ever ran for this project.
    fs.writeFileSync(path.join(cwd, '.gitignore'), String(scaffoldFileContent('.gitignore')), 'utf8');
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const wrapped = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.equal(wrapped.split('node_modules/').length - 1, 1, 'the same rules are wrapped in place, never duplicated');
    assert.equal(wrapped.split(GITIGNORE_BLOCK_START).length - 1, 1);
    assert.match(wrapped, /\.traffic-one\/debug\//);
    assert.equal(wrapped, fullBlock(), 'wrapped whole, and the region records its own scope');

    // The call a project whose mode was re-derived actually makes. `false` here
    // is the entire point: the scope comes off the FILE, so the full body is
    // reproduced byte-identically instead of being narrowed away.
    const before = fs.readFileSync(path.join(cwd, '.gitignore'));
    assert.equal(ensureProjectGitignore(cwd, { newProject: false }), false, 'second call: no-op even though the caller now says existing-codebase');
    assert.ok(before.equals(fs.readFileSync(path.join(cwd, '.gitignore'))));
    assert.equal(ensureProjectGitignore(cwd, { newProject: false }), false, 'third call: still stable');
    assert.ok(before.equals(fs.readFileSync(path.join(cwd, '.gitignore'))));
    const final = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.match(final, /node_modules\//, 'opinions still present after repeated calls');
    assert.match(final, /^\.env$/m, 'the rule whose loss commits the user\'s secrets');
  });
});

// Peer-review follow-up: whole-file `===` equality (the check the migration
// test above exercised in isolation) misses the instant a real owner has
// ALSO touched the file — a trailing/leading line, or a CRLF conversion — and
// then silently doubles the entire rule set below the unmarked original,
// stably, on every call forever. These cover exactly those shapes, each
// checked for byte-level idempotency across three calls.
function assertStableAcrossThreeCalls(cwd: string, opts: { newProject?: boolean } = {}): void {
  const first = fs.readFileSync(path.join(cwd, '.gitignore'));
  assert.equal(ensureProjectGitignore(cwd, opts), false, 'second call: no-op');
  assert.ok(first.equals(fs.readFileSync(path.join(cwd, '.gitignore'))), 'second call: byte-identical');
  assert.equal(ensureProjectGitignore(cwd, opts), false, 'third call: no-op');
  assert.ok(first.equals(fs.readFileSync(path.join(cwd, '.gitignore'))), 'third call: byte-identical');
}

test('ensureProjectGitignore wraps a legacy seed with ONE trailing owner line, keeping it outside the markers', () => {
  withTempDir((cwd) => {
    const seed = String(scaffoldFileContent('.gitignore'));
    fs.writeFileSync(path.join(cwd, '.gitignore'), `${seed}my-trailing-rule/\n`, 'utf8');
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(
      body.endsWith(`${GITIGNORE_BLOCK_END}\nmy-trailing-rule/\n`),
      'the trailing owner line survives, outside and below the block',
    );
    assert.equal(body.split('node_modules/').length - 1, 1, 'the seed is wrapped in place, never duplicated');
    assert.equal(body.split(GITIGNORE_BLOCK_START).length - 1, 1);
    assertStableAcrossThreeCalls(cwd, { newProject: true });
  });
});

test('ensureProjectGitignore wraps a legacy seed with ONE leading owner line, keeping it outside the markers', () => {
  withTempDir((cwd) => {
    const seed = String(scaffoldFileContent('.gitignore'));
    fs.writeFileSync(path.join(cwd, '.gitignore'), `my-leading-rule/\n${seed}`, 'utf8');
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(
      body.startsWith(`my-leading-rule/\n\n${GITIGNORE_BLOCK_START}`),
      'the leading owner line survives, outside and above the block, separated by exactly one blank line',
    );
    assert.equal(body.split('node_modules/').length - 1, 1, 'the seed is wrapped in place, never duplicated');
    assertStableAcrossThreeCalls(cwd, { newProject: true });
  });
});

test('ensureProjectGitignore wraps a legacy seed with BOTH a leading and a trailing owner line', () => {
  withTempDir((cwd) => {
    const seed = String(scaffoldFileContent('.gitignore'));
    fs.writeFileSync(path.join(cwd, '.gitignore'), `leading/\n${seed}trailing/\n`, 'utf8');
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(body.startsWith(`leading/\n\n${GITIGNORE_BLOCK_START}`), 'leading owner line preserved');
    assert.ok(body.endsWith(`${GITIGNORE_BLOCK_END}\ntrailing/\n`), 'trailing owner line preserved');
    assert.equal(body.split('node_modules/').length - 1, 1, 'the seed is wrapped in place, never duplicated');
    assertStableAcrossThreeCalls(cwd, { newProject: true });
  });
});

test('ensureProjectGitignore recognizes the legacy seed through CRLF line endings', () => {
  withTempDir((cwd) => {
    const seed = String(scaffoldFileContent('.gitignore')).replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(cwd, '.gitignore'), seed, 'utf8');
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(body.startsWith(GITIGNORE_BLOCK_START), 'CRLF did not defeat landmark detection');
    assert.equal(body.split('node_modules/').length - 1, 1, 'the seed is wrapped in place, never duplicated');
    assert.doesNotMatch(body, /\r/, 'the fresh wrapped block itself is plain LF');
    assertStableAcrossThreeCalls(cwd, { newProject: true });
  });
});

test('ensureProjectGitignore falls back to plain append when the legacy landmark is absent', () => {
  withTempDir((cwd) => {
    // Resembles part of the seed but is not a line-for-line match anywhere —
    // no landmark exists, so today's append-below behavior is correct.
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(body.startsWith(`node_modules/\ndist/\n\n${GITIGNORE_BLOCK_START}`));
    // Nothing was wrapped: the owner's two lines stay ABOVE the marker pair,
    // which is the property the partial resemblance is here to attack — a
    // landmark match that fuzzed would swallow them into our region.
    const start = contentLines(body).indexOf(contentLines(body).find((line) => line.startsWith(GITIGNORE_BLOCK_START))!);
    assert.deepEqual(contentLines(body).slice(0, start), ['node_modules/', 'dist/', '']);
    // Re-anchored (peer review): a file that already carries the owner's own
    // ignore rules is a project that has ALREADY stated its version-control
    // opinions, so `newProject: true` no longer imposes ours over the top of
    // them — the appended block is the narrow one, and the owner's
    // `node_modules/` stays the only one in the file.
    assert.ok(body.endsWith(narrowBlock()), 'an existing .gitignore is evidence, and it vetoes the full body');
    assert.equal(body.split('node_modules/').length - 1, 1, 'the owner already said this; we do not say it again');
    assertStableAcrossThreeCalls(cwd, { newProject: true });
  });

  // The duplication half of the original coverage, on a line the NARROW body
  // owns: no landmark matched, so the owner's copy and the block's copy both
  // stand, and convergence never dedupes across the marker boundary.
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.traffic-one/runs/\n', 'utf8');
    assert.equal(ensureProjectGitignore(cwd), true);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.equal(body, `.traffic-one/runs/\n\n${narrowBlock()}`);
    assert.equal(body.split('.traffic-one/runs/').length - 1, 2, 'the owner line and ours both survive');
    assertStableAcrossThreeCalls(cwd);
  });
});

// ── the narrowing, end to end ───────────────────────────────────────────────
// The reachability the previous engineer's "mode is stable" reasoning missed.
// `.gitignore` is in REPOSITORY_SCAFFOLD_OUTPUTS (architecture-contract/
// scaffold.ts), so every greenfield project carries the unmarked full seed. Then
// `onboarding/repair.ts` repairs a state whose `mode` went missing with
// `normalizeState(repaired, repaired.mode || detectMode(cwd))`, and `detectMode`
// (shared/detection/artifacts.ts) classifies by SOURCE FILE COUNT — six or more
// and a populated greenfield project reads back as `existing-codebase`.
// materializeProjectAssets then passes `newProject: state.mode === 'new-project'`
// — i.e. `false` — for a project that owns the full body.
//
// This test drives the real `detectMode` rather than asserting the flip in
// prose, so the premise cannot rot silently.
test('a scaffolded greenfield project keeps .env ignored after its mode is re-derived as existing-codebase', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
    const seeded = gitignoreOf(cwd);
    assert.match(seeded, /^\.env$/m, 'the greenfield scaffold seeds .env unmarked');
    assert.ok(!seeded.includes(GITIGNORE_BLOCK_START), 'seeded RAW — this is the shape on disk today');

    // The implementation the roles wrote after onboarding. Six source files is
    // all it takes for detectMode to stop calling this project greenfield.
    fs.mkdirSync(path.join(cwd, 'src/impl'), { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      fs.writeFileSync(path.join(cwd, `src/impl/module-${i}.ts`), 'export const x = 1;\n', 'utf8');
    }
    assert.equal(
      detectMode(cwd),
      'existing-codebase',
      'repair.ts re-derives THIS for a populated greenfield project — the flag flips',
    );

    // Exactly what materializeProjectAssets computes from the repaired state.
    const converged = assertShapeConverges(cwd, {
      newProject: detectMode(cwd) === 'new-project',
      expected: fullBlock(),
    });
    assert.match(converged, /^\.env$/m, 'the user\'s secrets are still ignored');
    assert.match(converged, /^!\.env\.example$/m);
    for (const opinion of ['node_modules/', 'dist/', 'build/', 'vendor/', 'target/']) {
      assert.ok(converged.includes(opinion), `${opinion} must survive the mode re-derivation`);
    }
  });
});

test('ensureProjectGitignore never narrows an already-marked full block, whatever the caller says', () => {
  withTempDir((cwd) => {
    // A block written by the CURRENT release: marked, but with no scope recorded.
    // Classified from the region's own content, then rewritten WITH the scope.
    const legacy = untaggedBlockFor(String(scaffoldFileContent('.gitignore')));
    fs.writeFileSync(path.join(cwd, '.gitignore'), `owner-above/\n\n${legacy}`, 'utf8');
    const converged = assertShapeConverges(cwd, {
      newProject: false,
      owner: ['owner-above/'],
      expected: `owner-above/\n\n${fullBlock()}`,
    });
    assert.match(converged, /^\.env$/m);
    assert.equal(converged.split('node_modules/').length - 1, 1, 'refreshed in place, never duplicated');
  });
});

// The mirror direction. Widening is not destructive the way narrowing is, but
// the file is still the authority: a project recorded as existing does not
// acquire build-output opinions because a later caller guessed greenfield.
test('ensureProjectGitignore never widens an established narrow block either', () => {
  withTempDir((cwd) => {
    assert.equal(ensureProjectGitignore(cwd, { newProject: false }), true);
    assert.equal(gitignoreOf(cwd), narrowBlock());
    assertShapeConverges(cwd, { newProject: true, expected: narrowBlock() });
    for (const opinion of SKIP_DIR_OPINIONS) {
      assert.ok(!gitignoreOf(cwd).includes(opinion), `${opinion} must not appear on an existing repo`);
    }
  });
});

// ── a repository with history never receives the full body ──────────────────
// The defect the reviewer measured: `detectMode` counts only `SOURCE_EXTS`
// extensions and stops at five, so every shape below reported `new-project`,
// materializeProjectAssets passed `newProject: true`, and a repo Traffic One did
// not create was given `node_modules/ dist/ build/ vendor/ target/ .env` —
// permanently, because the recorded `scope=full` is authoritative afterwards.
// Nothing fails on the day it happens (git never untracks what is committed);
// it fails on the next new file under one of those directories, which `git add`
// then silently skips.
//
// Every fixture carries a REAL `.git` with at least one commit, and every one
// drives the REAL `detectMode` — the row's `newProject` is exactly what
// materializeProjectAssets computes — so the premise cannot rot into prose.
const HISTORY_SHAPES: Array<{ name: string; build: (root: string) => void }> = [
  {
    name: 'terraform stack — .tf is in no source-extension list',
    build: (root) => {
      writeFileAt(root, 'main.tf', 'resource "null_resource" "a" {}\n');
      writeFileAt(root, 'variables.tf', 'variable "x" {}\n');
      writeFileAt(root, 'outputs.tf', 'output "y" { value = 1 }\n');
    },
  },
  {
    name: 'dbt/SQL project — .sql and .yml are not counted',
    build: (root) => {
      writeFileAt(root, 'dbt_project.yml', 'name: shop\n');
      writeFileAt(root, 'models/orders.sql', 'select 1\n');
      writeFileAt(root, 'models/users.sql', 'select 2\n');
    },
  },
  {
    name: 'docs-only site — .md is not counted',
    build: (root) => {
      writeFileAt(root, 'mkdocs.yml', 'site_name: docs\n');
      for (const page of ['index', 'guide', 'api', 'faq']) {
        writeFileAt(root, `docs/${page}.md`, `# ${page}\n`);
      }
    },
  },
  {
    name: 'elixir app — .ex/.exs are not counted',
    build: (root) => {
      writeFileAt(root, 'mix.exs', 'defmodule App.MixProject do\nend\n');
      writeFileAt(root, 'lib/app.ex', 'defmodule App do\nend\n');
      writeFileAt(root, 'lib/app/worker.ex', 'defmodule App.Worker do\nend\n');
    },
  },
  {
    name: 'shell-tooling repo — .sh and Makefile are not counted',
    build: (root) => {
      writeFileAt(root, 'Makefile', 'all:\n\techo hi\n');
      writeFileAt(root, 'bin/deploy.sh', '#!/bin/sh\necho deploy\n');
      writeFileAt(root, 'bin/build.sh', '#!/bin/sh\necho build\n');
    },
  },
  {
    // COUNTED extensions, under the threshold: `go mod vendor` output is
    // committed on purpose and an ignored `vendor/` drops its next new file.
    name: '3-file go module with a COMMITTED vendor/',
    build: (root) => {
      writeFileAt(root, 'go.mod', 'module example.com/m\n\ngo 1.22\n');
      writeFileAt(root, 'main.go', 'package main\n\nfunc main() {}\n');
      writeFileAt(root, 'util.go', 'package main\n');
      writeFileAt(root, 'vendor/modules.txt', '# explicit\n');
      writeFileAt(root, 'vendor/example.com/dep/dep.go', 'package dep\n');
    },
  },
  {
    name: '4-file published TS library with a COMMITTED dist/',
    build: (root) => {
      writeFileAt(root, 'package.json', '{"name":"lib","version":"1.0.0","main":"dist/index.js"}\n');
      for (const module of ['index', 'a', 'b', 'c']) {
        writeFileAt(root, `src/${module}.ts`, `export const ${module} = 1;\n`);
      }
      writeFileAt(root, 'dist/index.js', 'exports.a = 1;\n');
    },
  },
];

test('ensureProjectGitignore never imposes the build-output opinions on a repository with history, whatever detectMode says', () => {
  for (const shape of HISTORY_SHAPES) {
    withTempDir((cwd) => {
      shape.build(cwd);
      initAndCommit(cwd);
      // The flag materializeProjectAssets would actually pass, from the real
      // classifier. Every shape here reads `new-project` today (each counts
      // five or fewer SOURCE_EXTS files), which is what makes the row a
      // regression test for the CAUSE and not just the symptom — and the row
      // passes either way, because the verdict no longer depends on the answer.
      const newProject = detectMode(cwd) === 'new-project';
      const converged = assertShapeConverges(cwd, { newProject, expected: narrowBlock() });
      for (const opinion of SKIP_DIR_OPINIONS) {
        assert.ok(
          !converged.includes(opinion),
          `${shape.name} (detectMode=${detectMode(cwd)}): ${opinion} is not ours to impose on a repo with history`,
        );
      }
    });
  }
});

// git's own verdict on the same fixture, which is the only one that matters:
// the file the ignore rule would have shadowed must stay visible to `git add`.
test('a committed dist/ in a 4-file library keeps accepting new files after convergence', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, 'package.json', '{"name":"lib","version":"1.0.0","main":"dist/index.js"}\n');
    for (const module of ['index', 'a', 'b', 'c']) {
      writeFileAt(cwd, `src/${module}.ts`, `export const ${module} = 1;\n`);
    }
    writeFileAt(cwd, 'dist/index.js', 'exports.a = 1;\n');
    initAndCommit(cwd);
    assert.equal(detectMode(cwd), 'new-project', 'the misclassification is the premise');

    ensureProjectGitignore(cwd, { newProject: true });
    writeFileAt(cwd, 'dist/added-later.js', 'exports.b = 2;\n');
    git(cwd, ['add', '-A']);
    const staged = execFileSync('git', ['-C', cwd, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
    assert.ok(
      staged.split('\n').includes('dist/added-later.js'),
      'the new build output must still reach the index — this is the silent skip the defect caused',
    );
  });
});

// A project root is often a tracked SUBDIRECTORY of a repository: it has no
// `.git` of its own, so a root-only history check reads the most dangerous
// shape in the set — a published package whose `dist/` is committed one level
// up, and whose only `.gitignore` lives at the repo root — as greenfield.
test('ensureProjectGitignore treats a tracked subdirectory of a repository as an existing repo', () => {
  withNestedTempDir((project, parent) => {
    writeFileAt(parent, 'README.md', '# monorepo\n');
    writeFileAt(project, 'package.json', '{"name":"web"}\n');
    writeFileAt(project, 'src/index.ts', 'export const a = 1;\n');
    writeFileAt(project, 'dist/index.js', 'exports.a = 1;\n');
    initAndCommit(parent);
    assert.equal(fs.existsSync(path.join(project, '.git')), false, 'the project itself is not a repo root');
    assert.equal(detectMode(project), 'new-project', 'and the classifier still calls it greenfield');
    assertShapeConverges(project, { newProject: true, expected: narrowBlock() });
  });
});

// A `.git` FILE is a worktree/submodule pointer. Following it is what keeps a
// linked worktree — which cannot exist without commits — from reading as
// greenfield; a pointer we cannot resolve is a repository all the same, so the
// unreadable case must fail toward "has history" rather than toward imposing.
test('ensureProjectGitignore resolves a .git POINTER file, and refuses to guess when it cannot', () => {
  withNestedTempDir((project, parent) => {
    const real = path.join(parent, 'real-repo');
    fs.mkdirSync(real, { recursive: true });
    writeFileAt(real, 'README.md', '# real\n');
    initAndCommit(real);
    fs.writeFileSync(path.join(project, '.git'), `gitdir: ${path.join(real, '.git')}\n`, 'utf8');
    assertShapeConverges(project, { newProject: true, expected: narrowBlock() });
  });

  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.git'), 'this is not a gitdir pointer\n', 'utf8');
    assertShapeConverges(cwd, { newProject: true, expected: narrowBlock() });
  });
});

// The other side of the arm: "no commits", not "no `.git`". A freshly
// `git init`-ed directory is genuinely greenfield and must still get the full
// body — including with `-b`, where HEAD names a branch that has no ref yet.
test('ensureProjectGitignore still treats a committed-nothing git repo as greenfield', () => {
  withTempDir((cwd) => {
    git(cwd, ['init', '-q']);
    assertShapeConverges(cwd, { newProject: true, expected: fullBlock() });
  });

  withTempDir((cwd) => {
    git(cwd, ['init', '-q', '-b', 'trunk']);
    assert.match(fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8'), /^ref: refs\/heads\/trunk/);
    assertShapeConverges(cwd, { newProject: true, expected: fullBlock() });
  });

  // …and a repo whose CHECKED-OUT branch is unborn on top of real history is
  // not greenfield: the ref is missing, but other refs prove commits exist.
  withTempDir((cwd) => {
    writeFileAt(cwd, 'main.tf', 'resource "null_resource" "a" {}\n');
    initAndCommit(cwd);
    git(cwd, ['checkout', '-q', '--orphan', 'fresh-start']);
    assertShapeConverges(cwd, { newProject: true, expected: narrowBlock() });
  });
});

// ── both production orders, end to end ──────────────────────────────────────
// Two writers can put `.gitignore` on disk: `ensureProjectGitignore` (from
// materializeProjectAssets, every session start) and the compiler's scaffold
// seed (from ensureScaffoldContent at PLAN_READY). In production the
// materialization always runs FIRST — it fires on every SessionStart the moment
// consent is settled, while PLAN_READY needs an onboarded project, a run, and
// an architect — so `seedIfBlank` finds a non-blank file and never fires at all.
// That is exactly why the greenfield body cannot be left to the scaffold seed:
// if materialization created a `traffic-one`-scoped file first, a real
// greenfield project would silently lose `node_modules/`, `dist/` and `.env`
// with no second chance. Both orders are pinned here so neither can regress.
// (The materializeProjectAssets call site itself is covered in
// shared/materialize/__tests__/materialize-writer.test.ts.)
test('a greenfield project ends up with the full body in BOTH writer orders', () => {
  const seedScaffold = (cwd: string): void => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    assert.ok(
      (compiled.scaffoldOutputs || []).some((output) => output.path === '.gitignore'),
      'premise: a greenfield run compiles .gitignore as a scaffold output',
    );
    ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
  };

  // Production order: materialization creates the block, the later scaffold
  // pass is a no-op on a non-blank file.
  withTempDir((cwd) => {
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), true);
    const created = gitignoreOf(cwd);
    seedScaffold(cwd);
    assert.equal(gitignoreOf(cwd), created, 'the scaffold seed cannot fire over a non-blank file');
    const converged = assertShapeConverges(cwd, { newProject: true, expected: fullBlock() });
    for (const opinion of SKIP_DIR_OPINIONS) {
      assert.ok(converged.includes(opinion), `${opinion} must survive the production order`);
    }
  });

  // Reverse order: the raw seed lands first and convergence wraps it whole.
  withTempDir((cwd) => {
    seedScaffold(cwd);
    assert.ok(!gitignoreOf(cwd).includes(GITIGNORE_BLOCK_START), 'the scaffold seeds RAW');
    const converged = assertShapeConverges(cwd, { newProject: true, expected: fullBlock() });
    for (const opinion of SKIP_DIR_OPINIONS) {
      assert.ok(converged.includes(opinion), `${opinion} must survive the reverse order`);
    }
  });
});

// The scaffold seed is the same opinion by another route, reached through the
// same `state.mode` guess (these paths enter scaffoldOutputs only under
// compile.ts's isNewProject). Materialization normally creates `.gitignore`
// first, but it stands down whenever the plugin root is not an installed
// distribution or consent is unsettled — so this path is independently reachable
// on a misclassified repo and needs the same evidence gate.
//
// RENAMED (was 'ensureScaffoldContent seeds no repository convention into a repo
// with history'). That title claimed the whole convention family, and the family
// no longer answers to one predicate: `hasCommittedHistory` was a proxy, and
// `capabilities/profile.ts:98-104` had already rejected it at this exact point in
// the lifecycle — "a greenfield project routinely HAS a commit at this point (a
// user who ran `git init && git commit` first, and every run-sim case)". Held
// against the toolchain-quality configs it withheld them from every run there
// has ever been: no simulated Python run received a `ruff.toml`, and `stack-lint`
// (qa-evidence/stack.ts:214 gates on the FILE, not the binary) reported "the
// project declares no lint command" forever. Those four now answer to intrinsic
// evidence instead — see the tests below.
//
// What this test still pins, and why it is not the same question: this fixture is
// a `main.tf` plus a commit, the shape greenfield-evidence.ts exists for, and the
// node cluster's own hazard is repo-WIDE — `packageJsonBody` adds `format:
// prettier --write .`, and prettier rewrites `.md`, `.yml` and `.json` in a
// repository holding no JavaScript at all. No language-scoped arm can see that,
// so the cluster and `.gitignore` keep the history arm. Every assertion below is
// the original one; only `conventions` narrowed, and the premise is now exact
// rather than `>= 4` so the day a toolchain-quality config appears in this list
// the test says so instead of quietly widening.
test('ensureScaffoldContent withholds the node tooling cluster and .gitignore from a repo with history', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, 'main.tf', 'resource "null_resource" "a" {}\n');
    initAndCommit(cwd);
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const outputs = compiled.scaffoldOutputs || [];
    const conventions = [
      '.gitignore', 'eslint.config.js', '.prettierrc', '.prettierignore',
      '.stylelintrc.json',
    ];
    // Premise: a greenfield compile really does declare these, so the assertions
    // below cannot pass just because nothing was up for seeding.
    const declared = outputs
      .map((output) => output.path)
      .filter((rel) => conventions.includes(rel.split('/').pop() || ''));
    assert.deepEqual(
      [...declared].sort(),
      ['.gitignore', '.prettierignore', '.prettierrc', '.stylelintrc.json', 'eslint.config.js'],
      'premise: a greenfield react compile declares exactly this cluster',
    );

    const written = ensureScaffoldContent(cwd, outputs, compiled.profile, {
      compiled,
      newProject: true,
    });
    for (const rel of declared) {
      assert.ok(!written.includes(rel), `a repo with history is not scaffolded ${rel}`);
      assert.equal(fs.existsSync(path.join(cwd, rel)), false, `${rel} must not reach disk`);
    }
    // The tooling manifest carries the devDependencies and `lint`/`format`
    // scripts for the withheld eslint config — seeding it alone would install a
    // toolchain for a config that is not there.
    assert.ok(!written.includes('package.json'), 'the eslint tooling manifest rides the same veto');
    // Not a blanket stand-down: a body about the toolchain THIS run compiles,
    // rather than about someone else's repository, must still be seeded.
    assert.ok(written.includes('.env.example'), 'toolchain bodies are not gated');
  });
});

// --- toolchain-quality configs answer to intrinsic evidence -----------------

const PYTHON_STATE = {
  mode: 'new-project',
  stack: 'custom-backend',
  frontend: 'none',
  backend: 'python',
  mobile: { framework: 'none' },
};

const API_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [],
  modules: [{ id: 'store', name: 'Store', kind: 'store' }],
};

/** The greenfield Python compile these four tests all start from. */
function pythonScaffold(cwd: string): {
  outputs: Array<{ path: string }>;
  written: string[];
} {
  const compiled = compileArchitecture(cwd, 'R', PYTHON_STATE, API_INPUT);
  const outputs = compiled.scaffoldOutputs || [];
  assert.ok(
    outputs.some((output) => output.path === 'ruff.toml'),
    'premise: a greenfield python compile declares ruff.toml',
  );
  return { outputs, written: ensureScaffoldContent(cwd, outputs, compiled.profile, { compiled, newProject: true }) };
}

// THE DEFECT THAT CLOSED. A commit is not evidence that a project has opinions
// about ruff: run-sim's `initRepo` commits before the run id is minted and a user
// who ran `git init && git commit` first is still greenfield, so the history proxy
// withheld `ruff.toml` from every Python run that has ever executed — and
// `stack-lint` gates on the FILE (qa-evidence/stack.ts:214), so the check that
// shape pins as `passed` could only ever report not-applicable.
test('ensureScaffoldContent seeds ruff.toml into an otherwise empty repo that has a commit', () => {
  withTempDir((cwd) => {
    initAndCommit(cwd);
    const { written } = pythonScaffold(cwd);
    assert.ok(written.includes('ruff.toml'), 'a bare commit is not a python opinion');
    assert.match(fs.readFileSync(path.join(cwd, 'ruff.toml'), 'utf8'), /^\[lint\]$/m);
  });
});

// Arm A, and the only marginal protection the veto ever had over `seedIfBlank`:
// our path is ABSENT while an equivalent lives under a name a missing-or-blank
// test cannot see. `ruff.toml` OUTRANKS a `pyproject.toml [tool.ruff]` section, so
// seeding it here would silently demote the config the project chose.
test('ensureScaffoldContent withholds ruff.toml when pyproject.toml already configures ruff', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, 'pyproject.toml', '[project]\nname = "api"\n\n[tool.ruff]\nline-length = 88\n');
    const { written } = pythonScaffold(cwd);
    assert.ok(!written.includes('ruff.toml'), 'a [tool.ruff] section is the project speaking');
    assert.equal(fs.existsSync(path.join(cwd, 'ruff.toml')), false, 'ruff.toml must not reach disk');
    // Not a blanket stand-down, and no history in this fixture at all: the arm is
    // the DECLARATION, not the repository.
    assert.ok(written.includes('.env.example'), 'toolchain bodies are not gated');
  });
});

// Same arm, a competing linter rather than a different spelling of the same one:
// rules/common/quality-tooling.md tells agents "do not add a second linter beside
// the one it uses", and a seeded `ruff.toml` is exactly that second linter.
test('ensureScaffoldContent withholds ruff.toml from a project that already lints with flake8', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, '.flake8', '[flake8]\nmax-line-length = 88\n');
    const { written } = pythonScaffold(cwd);
    assert.ok(!written.includes('ruff.toml'), 'flake8 owns this slot already');
  });
});

// Arm B, generalising `webAppHoldsSource` in capabilities/profile.ts: `detectMode`
// calls anything with five or fewer SOURCE_EXTS files `new-project`, so a small
// REAL Python project arrives here on the same guess. It never asked for our bar,
// and handing it one makes our own `stack-lint` enforce that bar against code no
// agent in the run wrote — which can fail QA on legacy source and block
// settlement. Zero is the threshold for profile.ts's reason: a tree that thin
// already reads new-project, so a higher one would only withhold from projects
// with nothing to lose.
test('ensureScaffoldContent withholds ruff.toml from a project that already holds python source', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, 'app/legacy.py', 'import os\nx=1\n');
    const { written } = pythonScaffold(cwd);
    assert.ok(!written.includes('ruff.toml'), 'existing python source is not ours to grade');
    assert.equal(fs.existsSync(path.join(cwd, 'ruff.toml')), false, 'ruff.toml must not reach disk');
    assert.ok(written.includes('.env.example'), 'toolchain bodies are not gated');
  });
});

// Our OWN scaffold must not become the evidence that vetoes the next run's seed,
// which is what makes the arm above safe to apply at every PLAN_READY rather than
// only the first. `.traffic-one` holds module skeletons and run artefacts.
test('ensureScaffoldContent does not read its own .traffic-one skeletons as project source', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, '.traffic-one/runs/1/skeleton.py', 'x = 1\n');
    const { written } = pythonScaffold(cwd);
    assert.ok(written.includes('ruff.toml'), 'our own state is not the project holding source');
  });
});

// The coupling, in the direction the old comment stated: the tooling manifest is
// nothing but devDependencies and `lint`/`format` scripts for the configs beside
// it, so it must not land when they do not.
test('ensureScaffoldContent withholds the tooling manifest whenever its cluster is withheld', () => {
  withTempDir((cwd) => {
    // No history, so only the slot arms can veto: an .eslintrc.json is the flat
    // config's predecessor and ESLint 9 would REPLACE it with ours.
    writeFileAt(cwd, '.eslintrc.json', '{ "rules": {} }\n');
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const outputs = compiled.scaffoldOutputs || [];
    assert.ok(
      outputs.some((output) => output.path === 'eslint.config.js')
      && outputs.some((output) => output.path === 'package.json'),
      'premise: this compile declares both halves of the coupling',
    );
    const written = ensureScaffoldContent(cwd, outputs, compiled.profile, { compiled, newProject: true });
    assert.ok(!written.includes('eslint.config.js'), 'an .eslintrc.json is the project speaking');
    assert.ok(!written.includes('package.json'), 'no toolchain for a config that is not there');
    assert.ok(!written.includes('.prettierrc'), 'the cluster is one unit');
  });
});

// And in the direction the old predicate left open: with no commits the veto was
// silent, so a project that had run `npm init` received an `eslint.config.js`
// importing @eslint/js and typescript-eslint while its own non-blank
// `package.json` — the only place those devDependencies could have gone — was
// refused by `seedIfBlank`. A flat config whose plugins nobody installed is not a
// quality bar, it is a crash on the first `eslint .`.
test('ensureScaffoldContent withholds the cluster when the tooling manifest cannot be filled', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, 'package.json', `${JSON.stringify({ name: 'mine', version: '1.0.0' })}\n`);
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const outputs = compiled.scaffoldOutputs || [];
    const written = ensureScaffoldContent(cwd, outputs, compiled.profile, { compiled, newProject: true });
    for (const rel of ['eslint.config.js', '.prettierrc', '.prettierignore', '.stylelintrc.json']) {
      assert.ok(!written.includes(rel), `${rel} needs the devDependencies it cannot get`);
      assert.equal(fs.existsSync(path.join(cwd, rel)), false, `${rel} must not reach disk`);
    }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).name,
      'mine',
      'the project manifest is untouched either way',
    );
  });
});

// --- the pre-pass: verdicts are resolved before the first write -------------

// VACUOUS-COVERAGE GUARD, and the one that is red under the mutation. Moving the
// slot lookup back to its point of use is the obvious simplification — the loop
// already knows the slot and the directory — and nothing in this file objected to
// it.
//
// What it breaks is the CLUSTER GATE, not any single config. `nodeSlotsAccept`
// folds over every node slot's verdict to decide the tooling manifest, and that
// manifest is scaffold output 0 while the configs it folds are outputs 50, 51, 53
// and 54. Lazily, the fold runs over an empty map and `every` is vacuously true,
// so the manifest lands and the loop then withholds the configs it installs tools
// for, one at a time. This fixture is the shape that shows it: `legacy/old.js`
// makes js-lint and js-format REJECT, so the correct answer is that nothing in
// the cluster lands — and lazily a `package.json` naming eslint and prettier
// appears anyway, with a `.stylelintrc.json` beside it (9 files written, 11).
//
// Not the slot-mate route, which reads like the hazard and is not one: the verdict
// memo is keyed by (slot, directory), so `.prettierignore` reuses `.prettierrc`'s
// answer under either ordering.
test('ensureScaffoldContent resolves every node slot before writing the manifest at output 0', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, 'legacy/old.js', 'var a = 1\n');
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const outputs = (compiled.scaffoldOutputs || []).map((output) => output.path);
    // The ordering the guard exists for, as exact indices: the manifest is
    // decided FIRST and every verdict that decides it is compiled much later, so
    // a compiler reshuffle that removes the hazard says so here rather than
    // leaving a guard nobody can justify.
    assert.equal(outputs.indexOf('package.json'), 0, 'the tooling manifest is written first');
    for (const rel of ['.prettierrc', '.prettierignore', 'eslint.config.js', '.stylelintrc.json']) {
      assert.ok(outputs.indexOf(rel) > 40, `premise: ${rel} is compiled long after the manifest (got ${outputs.indexOf(rel)})`);
    }
    // Premise: this tree really does split the cluster's slots, so the manifest's
    // gate cannot be answered without a verdict resolved 50-odd outputs later.
    assert.equal(slotAcceptsScaffold(cwd, cwd, 'js-lint'), false, 'premise: existing .js source rejects js-lint');
    assert.equal(slotAcceptsScaffold(cwd, cwd, 'css-lint'), true, 'premise: css-lint would accept on its own');

    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
    assert.ok(!written.includes('package.json'), 'no toolchain for configs the slots reject');
    assert.equal(fs.existsSync(path.join(cwd, 'package.json')), false, 'package.json must not reach disk');
    // The accepting slot is the tell. `.stylelintrc.json` passes its own arms and
    // is withheld only because the cluster it belongs to is out — a decision the
    // manifest's gate already made, before output 0.
    assert.ok(!written.includes('.stylelintrc.json'), 'an accepting slot still rides the cluster');
    assert.equal(fs.existsSync(path.join(cwd, '.stylelintrc.json')), false, '.stylelintrc.json must not reach disk');
    assert.ok(written.includes('.env.example'), 'toolchain bodies are not gated');
  });
});

// The other route, and the reason the guard does not lean on arm A's pattern
// staying correct: `packageJsonBody` seeds prettier, stylelint and eslint as
// devDependencies at output 0, so a manifest pattern loose enough to match a
// NESTED key would read our own seed back as the project declaring three slots.
// `topLevelManifestKey` anchors on the indent, so today this route is closed at
// both ends. Against the pattern that preceded it, lazy resolution dropped
// `.prettierrc`, `.prettierignore` and `.stylelintrc.json` from a clean greenfield
// compile (14 written, 11) — this test is red under that combination and green
// under either protection alone, which is exactly why both are kept.
test('ensureScaffoldContent seeds both js-format configs, though its own earlier writes would veto them', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const outputs = (compiled.scaffoldOutputs || []).map((output) => output.path);
    // Premise: the manifest whose seeded devDependencies name prettier is written
    // LONG before either config's turn.
    assert.equal(outputs.indexOf('package.json'), 0, 'the tooling manifest is written first');
    assert.ok(
      outputs.indexOf('package.json') < outputs.indexOf('.prettierrc')
      && outputs.indexOf('.prettierrc') < outputs.indexOf('.prettierignore'),
      `premise: manifest then .prettierrc then .prettierignore (got ${outputs.indexOf('package.json')}, ${outputs.indexOf('.prettierrc')}, ${outputs.indexOf('.prettierignore')})`,
    );

    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
    for (const rel of ['.prettierrc', '.prettierignore']) {
      assert.ok(written.includes(rel), `${rel} was resolved after a write that vetoes it`);
      assert.ok(
        fs.readFileSync(path.join(cwd, rel), 'utf8').trim().length > 0,
        `${rel} must reach disk with its canonical body`,
      );
    }
    // By the time the call returns the project genuinely DOES declare js-format,
    // which is what makes the assertions above a statement about when the
    // question was asked rather than a second greenfield smoke test.
    assert.ok(
      projectDeclaresSlot(cwd, cwd, 'js-format'),
      'after the call the project really does declare js-format — the pre-pass asked before that was true',
    );
  });
});

// The same guard from the other side, and the premise the node-slot cost skip in
// `ensureScaffoldContent` rests on: with history the cluster is withheld no
// matter what the slots would have said. This fixture is the case that makes it
// non-trivial — a completely clean tree, so every node slot would ACCEPT, and
// only the history arm withholds. If this ever goes green for the cluster, the
// skip is resolving fewer verdicts than the answer depends on.
test('ensureScaffoldContent withholds the node cluster from a repo with history even when every slot would accept', () => {
  withTempDir((cwd) => {
    initAndCommit(cwd);
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const outputs = compiled.scaffoldOutputs || [];
    for (const slot of ['js-lint', 'js-format', 'css-lint'] as const) {
      assert.ok(
        slotAcceptsScaffold(cwd, cwd, slot),
        `premise: ${slot} would accept on this tree, so only history can withhold`,
      );
    }
    const written = ensureScaffoldContent(cwd, outputs, compiled.profile, { compiled, newProject: true });
    for (const rel of ['package.json', 'eslint.config.js', '.prettierrc', '.prettierignore', '.stylelintrc.json']) {
      assert.ok(!written.includes(rel), `${rel} rides the cluster's history arm`);
      assert.equal(fs.existsSync(path.join(cwd, rel)), false, `${rel} must not reach disk`);
    }
    // Not a blanket stand-down: the toolchain bodies and the language-scoped
    // slots are unaffected by the cluster's arm.
    assert.ok(written.includes('.env.example'), 'toolchain bodies are not gated');
  });
});

// --- arm A reads TOP-LEVEL manifest keys only -------------------------------

// A `package.json` key is a declaration only where it sits at the top level. One
// level down, inside `devDependencies`, the same name is the project INSTALLING
// the tool — and the manifest this module's own caller seeds carries prettier,
// stylelint and eslint exactly there, so a pattern that ignored indentation read
// our own scaffold back as three declarations by the project.
//
// The trap in the obvious fix: prettier's key may legitimately be a STRING path
// as well as an object, so the widening cannot be closed by constraining the
// value. Only the indent separates the two, and both spellings below must keep
// their current answers.
test('projectDeclaresSlot reads a manifest key as a declaration only at the top level', () => {
  const cases: Array<{ slot: 'js-lint' | 'js-format' | 'css-lint'; label: string; body: string; declares: boolean }> = [
    { slot: 'js-format', label: 'top-level object', declares: true, body: '{\n  "prettier": {\n    "semi": false\n  }\n}\n' },
    // The trap: a real spelling that a value-based narrowing would have lost.
    { slot: 'js-format', label: 'top-level string path', declares: true, body: '{\n  "prettier": "./cfg.json"\n}\n' },
    { slot: 'js-format', label: 'top-level, tab indented', declares: true, body: '{\n\t"prettier": "./cfg.json"\n}\n' },
    { slot: 'js-format', label: 'nested devDependency', declares: false, body: '{\n  "devDependencies": {\n    "prettier": "^3.6.0"\n  }\n}\n' },
    { slot: 'js-format', label: 'nested devDependency, tab indented', declares: false, body: '{\n\t"devDependencies": {\n\t\t"prettier": "^3.6.0"\n\t}\n}\n' },
    { slot: 'css-lint', label: 'top-level object', declares: true, body: '{\n  "stylelint": {\n    "rules": {}\n  }\n}\n' },
    { slot: 'css-lint', label: 'nested devDependency', declares: false, body: '{\n  "devDependencies": {\n    "stylelint": "^16.21.0"\n  }\n}\n' },
    { slot: 'js-lint', label: 'top-level object', declares: true, body: '{\n  "eslintConfig": {\n    "root": true\n  }\n}\n' },
    // js-lint escaped the widening only by luck of key naming — nobody depends on
    // a package called `eslintConfig`. Pinned so the luck is not the guarantee.
    { slot: 'js-lint', label: 'nested dependency of that exact name', declares: false, body: '{\n  "devDependencies": {\n    "eslintConfig": "^1.0.0"\n  }\n}\n' },
  ];
  for (const scenario of cases) {
    withTempDir((cwd) => {
      writeFileAt(cwd, 'package.json', scenario.body);
      assert.equal(
        projectDeclaresSlot(cwd, cwd, scenario.slot),
        scenario.declares,
        `${scenario.slot}: ${scenario.label}`,
      );
    });
  }
});

// The regression this closes, stated as the caller sees it: the manifest
// `ensureScaffoldContent` seeds is not a declaration by the project about any of
// the three slots it installs tools for. This is the first of the two routes in
// the pre-pass comment above, and the only one a pattern can close.
test('the seeded tooling manifest is not itself a declaration in any node slot', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
    const manifest = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    assert.match(manifest, /"prettier": "\^/, 'premise: the seed really does name prettier');
    assert.match(manifest, /"stylelint": "\^/, 'premise: the seed really does name stylelint');

    withTempDir((bare) => {
      writeFileAt(bare, 'package.json', manifest);
      for (const slot of ['js-lint', 'js-format', 'css-lint'] as const) {
        assert.equal(
          projectDeclaresSlot(bare, bare, slot),
          false,
          `our own seeded manifest must not read as a ${slot} declaration`,
        );
      }
    });
  });
});

// THE OUTPUT THE NARROWING CHANGES, named rather than buried. Everywhere else the
// widening was masked: arm A reads `package.json`, and where the tooling manifest
// IS that file, `blankOrMissing` has already established it is empty, so there is
// no nested key to mis-read. The exception is a NESTED tooling root (`web/`,
// `apps/*` — scaffold.ts's `webPackageRoot`), because arm A also searches the
// project root, every one of these tools searching upward too. There the manifest
// it reads is the MONOREPO ROOT's, which nothing cleared.
//
// A root that installs prettier and stylelint as devDependencies is the shape
// every pnpm/turbo repo has, and under the old pattern it withheld the ENTIRE
// cluster from the nested package — 0 of 5 files, silently. Installing a tool is
// not configuring it, and the nested package has no config of its own.
test('a monorepo root that only installs prettier does not withhold the nested package cluster', () => {
  withTempDir((cwd) => {
    writeFileAt(cwd, 'package.json', '{\n  "name": "monorepo-root",\n  "private": true,\n  "devDependencies": {\n    "prettier": "^3.6.0",\n    "stylelint": "^16.21.0"\n  }\n}\n');
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    // Asked before the call, while the root manifest is the only one on disk.
    for (const slot of ['js-format', 'css-lint'] as const) {
      assert.equal(
        projectDeclaresSlot(cwd, path.join(cwd, 'web'), slot),
        false,
        `a root that INSTALLS the ${slot} tool has not configured it`,
      );
    }

    const cluster = [
      'web/package.json', 'web/eslint.config.js',
      'web/.prettierrc', 'web/.prettierignore', 'web/.stylelintrc.json',
    ];
    const written = ensureScaffoldContent(cwd, cluster.map((rel) => ({ path: rel })), compiled.profile, {
      newProject: true,
    });
    assert.deepEqual([...written].sort(), [...cluster].sort(), 'the nested cluster lands whole');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).name,
      'monorepo-root',
      'the root manifest is never the one we fill',
    );
  });
});

// `greenfieldEvidence`'s first arm asks whether the PROJECT ever stated anything
// about git, and Traffic One's own block is not the project stating anything —
// materialization has written it before any consumer downstream of onboarding
// runs, so a consumer reading the raw file would find every project, greenfield
// included, "not greenfield". This is what makes the predicate reusable at all.
test('projectOwnedGitignore returns the owner bytes and none of Traffic One\'s', () => {
  const block = `${GITIGNORE_BLOCK_START} scope=traffic-one\n${TRAFFIC_ONE_BLOCK_BODY}\n${GITIGNORE_BLOCK_END}\n`;
  withTempDir((cwd) => {
    assert.equal(projectOwnedGitignore(cwd), '', 'no file: the project has stated nothing');

    writeFileAt(cwd, '.gitignore', block);
    assert.equal(projectOwnedGitignore(cwd), '', 'our own managed region is not the project speaking');

    writeFileAt(cwd, '.gitignore', `.terraform/\n\n${block}*.tfstate\n`);
    assert.equal(projectOwnedGitignore(cwd), '.terraform/\n\n*.tfstate\n', 'owner lines on both sides survive');

    // The unmarked greenfield seed predates the markers and is equally ours.
    writeFileAt(cwd, '.gitignore', String(scaffoldFileContent('.gitignore')));
    assert.equal(projectOwnedGitignore(cwd), '', 'the legacy unmarked seed is ours too');

    // A hand-mangled pair: the writer refuses to touch such a file, and every
    // byte counts as the project's here for the same reason — nobody can say
    // which of them we wrote.
    writeFileAt(cwd, '.gitignore', `${GITIGNORE_BLOCK_START}\nnode_modules/\n`);
    assert.match(projectOwnedGitignore(cwd) ?? '', /node_modules\//, 'a malformed pair is all theirs');
  });
});

// ── the `.gitignore` read is BOUNDED, and `null` is not `''` ─────────────────
//
// DRIVEN before the fix, one shape per child under a 12 000 ms SIGKILL alarm:
// a committed `.gitignore -> /dev/zero` SIGKILLed `projectOwnedGitignore` at
// 12 070 ms (round-1 peer) and at 12 090 ms re-driven against a byte-verified
// copy carrying the bare read; after, `null` in 161 ms. `ensureProjectGitignore`
// seventy lines below this function was ALREADY safe — it opens O_RDWR and
// fstat-guards before reading — so one file both knew the rule and broke it.
//
// THE FOLD THIS SUITE EXISTS TO FORBID is the obvious repair rather than the
// hang: `greenfieldEvidence` answers TRUE on empty bytes, so returning `''` for
// a shape we cannot read says "the project stated nothing about git", and the
// one production consumer spends that on `ensureInitialCommit({ initIfNeeded:
// true })` — an unasked `git init`, `add -A` and a commit authored as Traffic
// One over a tree whose `.gitignore` was never read. The `absent` arm keeps `''`
// because no `.gitignore` really is a project that stated nothing.
//
// The blocking shapes are read in a CHILD under `timeout:` for the reason
// fsjson-bounded-read.test.ts states: node's test timeout is a timer on the
// event loop a blocked synchronous read is holding, so an in-process row would
// WEDGE this suite instead of failing it.

const ARCHITECTURE_CONTRACT_MODULE = path.join(__dirname, '..', 'architecture-contract', 'index.ts');

function ownedGitignoreInChild(cwd: string, label: string): string | null {
  const driver = path.join(cwd, 'drive-owned.cjs');
  fs.writeFileSync(driver, [
    'const m = require(process.argv[2]);',
    'process.stdout.write(JSON.stringify({ v: m.projectOwnedGitignore(process.argv[3]) }));',
  ].join('\n'), 'utf8');
  const run = spawnSync(process.execPath, ['--import', 'tsx', driver, ARCHITECTURE_CONTRACT_MODULE, cwd], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(run.signal, null,
    `${label}: projectOwnedGitignore must RETURN rather than block in open(2). stderr: ${run.stderr || ''}`);
  assert.equal(run.status, 0, `${label}: ${run.stderr || ''}`);
  return (JSON.parse(run.stdout) as { v: string | null }).v;
}

test('a FIFO .gitignore is BOUNDED and answers null, never the greenfield-licensing empty string', () => {
  withTempDir((cwd) => {
    try {
      execFileSync('mkfifo', [path.join(cwd, '.gitignore')], { stdio: 'ignore' });
    } catch {
      return; // no mkfifo: the shape is unreachable rather than unpinned
    }
    assert.equal(fs.lstatSync(path.join(cwd, '.gitignore')).isFIFO(), true, 'FIXTURE the entry really is a FIFO');
    assert.equal(ownedGitignoreInChild(cwd, 'FIFO'), null,
      'something IS there and we cannot see it, so the project may well have spoken');
  });
});

test('a .gitignore symlinked to /dev/zero is BOUNDED and answers null — driven at 12 070 ms before', () => {
  if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) return;
  withTempDir((cwd) => {
    fs.symlinkSync('/dev/zero', path.join(cwd, '.gitignore'));
    assert.equal(fs.statSync(path.join(cwd, '.gitignore')).isCharacterDevice(), true,
      'FIXTURE the link really resolves to a character device');
    assert.equal(ownedGitignoreInChild(cwd, '/dev/zero link'), null);
  });
});

test('an unreadable .gitignore vetoes the unasked git init that an empty answer would license', () => {
  // A DIRECTORY, so this row costs no child — `open(O_RDONLY)` on one returns
  // EISDIR immediately. It pins the CONSEQUENCE rather than the return value:
  // this is `runners/opencode/index.ts`'s guard inlined, and it must veto.
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.gitignore'));
    const owned = projectOwnedGitignore(cwd);
    assert.equal(owned, null, 'a directory at .gitignore is presence we cannot read, not absence');
    assert.equal(
      owned !== null && greenfieldEvidence(cwd, owned), false,
      'the delegation runner must not `git init` + `add -A` + commit as Traffic One over a tree whose '
      + '.gitignore it could not read. greenfieldEvidence answers TRUE on empty bytes, so folding this '
      + 'shape into `\'\'` licenses exactly that — and its own docblock has always claimed both arms '
      + 'fail toward NOT greenfield when they cannot be read.',
    );
    // And the genuinely absent case still reads as greenfield, which is the
    // whole point of keeping the two apart.
    fs.rmdirSync(path.join(cwd, '.gitignore'));
    assert.equal(projectOwnedGitignore(cwd), '', 'no .gitignore is still a project that stated nothing');
  });
});

// ── malformed marker pairs: refuse, never repair ────────────────────────────
// Every one of these is a file a human hand-edited inside our own region, and
// every possible repair has to guess which bytes are ours and which are theirs.
// Guessing is what deleted owner lines and grew files without bound before, so
// the answer is to write nothing: provably non-destructive, provably non-growing,
// trivially idempotent. A human repairs the pair and convergence resumes.
test('ensureProjectGitignore refuses every malformed marker pair, byte-for-byte', () => {
  const body = TRAFFIC_ONE_BLOCK_BODY.trimEnd();
  const shapes: Array<{ name: string; content: string; owner: readonly string[] }> = [
    {
      name: 'start marker only (end hand-deleted)',
      content: `owner-above/\n\n${GITIGNORE_BLOCK_START}\n${body}\nowner-below/\n`,
      owner: ['owner-above/', 'owner-below/'],
    },
    {
      name: 'end marker only (start hand-deleted)',
      content: `owner-above/\n\n${body}\n${GITIGNORE_BLOCK_END}\nowner-below/\n`,
      owner: ['owner-above/', 'owner-below/'],
    },
    {
      name: 'reversed markers',
      content: `owner-above/\n\n${GITIGNORE_BLOCK_END}\n${body}\n${GITIGNORE_BLOCK_START}\nowner-below/\n`,
      owner: ['owner-above/', 'owner-below/'],
    },
    {
      name: 'nested markers with an owner line inside',
      content: [
        'owner-above/', '',
        GITIGNORE_BLOCK_START, body, 'owner-inside/',
        GITIGNORE_BLOCK_START, body, GITIGNORE_BLOCK_END, GITIGNORE_BLOCK_END,
        'owner-below/', '',
      ].join('\n'),
      owner: ['owner-above/', 'owner-inside/', 'owner-below/'],
    },
    {
      name: 'two complete blocks',
      content: `owner-above/\n\n${untaggedBlockFor(body)}\n${untaggedBlockFor(body)}owner-below/\n`,
      owner: ['owner-above/', 'owner-below/'],
    },
    {
      name: 'duplicated start marker, one end',
      content: `${GITIGNORE_BLOCK_START}\n${GITIGNORE_BLOCK_START}\n${body}\n${GITIGNORE_BLOCK_END}\nowner-below/\n`,
      owner: ['owner-below/'],
    },
  ];
  for (const shape of shapes) {
    for (const newProject of [false, true]) {
      withTempDir((cwd) => {
        fs.writeFileSync(path.join(cwd, '.gitignore'), shape.content, 'utf8');
        const settled = assertShapeConverges(cwd, {
          newProject,
          owner: shape.owner,
          untouched: true,
          expected: shape.content,
        });
        assert.equal(settled, shape.content, `${shape.name} (newProject: ${newProject}) must be left alone`);
      });
    }
  }
});

// ── markers are whole lines, never substrings ───────────────────────────────
// `indexOf` treated an owner's own PROSE about the markers as the marker. The
// start-marker case ate that line's tail plus every owner line below it; the
// end-marker case put `end` above `start` and grew the file by a full rule set
// on every call, without bound.
test('ensureProjectGitignore treats owner prose that merely CONTAINS a marker as owner content', () => {
  const cases = [
    `owner-above/\n# note: ${GITIGNORE_BLOCK_START} is how the block opens\nowner-below/\n`,
    `owner-above/\n# note: ${GITIGNORE_BLOCK_END} closes it\nowner-below/\n`,
    `owner-above/\n# see ${GITIGNORE_BLOCK_START} and ${GITIGNORE_BLOCK_END}\nowner-below/\n`,
  ];
  for (const content of cases) {
    withTempDir((cwd) => {
      fs.writeFileSync(path.join(cwd, '.gitignore'), content, 'utf8');
      assertShapeConverges(cwd, {
        owner: contentLines(content).filter((line) => line !== ''),
        expected: `${content.trimEnd()}\n\n${narrowBlock()}`,
      });
    });
  }
});

// An indented marker is a quoted example in someone's notes, not our delimiter:
// leading whitespace is deliberately NOT normalized away.
test('ensureProjectGitignore does not treat INDENTED markers as its own', () => {
  withTempDir((cwd) => {
    const content = `owner-above/\n  ${GITIGNORE_BLOCK_START}\n  ${GITIGNORE_BLOCK_END}\nowner-below/\n`;
    fs.writeFileSync(path.join(cwd, '.gitignore'), content, 'utf8');
    assertShapeConverges(cwd, {
      owner: ['owner-above/', `  ${GITIGNORE_BLOCK_START}`, `  ${GITIGNORE_BLOCK_END}`, 'owner-below/'],
      expected: `${content.trimEnd()}\n\n${narrowBlock()}`,
    });
  });
});

// Trailing whitespace IS normalized: an editor's trailing-space autofix or a
// CRLF conversion must never orphan a managed region (which, before validation
// existed, is how a file ended up with one marker and started growing).
test('ensureProjectGitignore matches markers through trailing whitespace and CRLF', () => {
  withTempDir((cwd) => {
    const stale = `owner-above/\n\n${GITIGNORE_BLOCK_START}   \n.traffic-one/runs/\n${GITIGNORE_BLOCK_END}\t\n`;
    fs.writeFileSync(path.join(cwd, '.gitignore'), stale, 'utf8');
    assertShapeConverges(cwd, {
      owner: ['owner-above/'],
      expected: `owner-above/\n\n${narrowBlock()}`,
    });
  });

  withTempDir((cwd) => {
    const crlf = `owner-above/\n\n${untaggedBlockFor('.traffic-one/runs/')}`.replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(cwd, '.gitignore'), crlf, 'utf8');
    const converged = assertShapeConverges(cwd, {
      owner: ['owner-above/'],
      expected: `owner-above/\n\n${narrowBlock()}`,
    });
    assert.doesNotMatch(converged, /\r/, 'the region we rewrite is plain LF');
  });
});

// The CRLF twin of the narrowing row: an editor converted the unmarked seed's
// line endings, and the caller now says existing-codebase.
test('ensureProjectGitignore keeps the full body when the unmarked seed arrived as CRLF and the caller says existing', () => {
  withTempDir((cwd) => {
    const seed = String(scaffoldFileContent('.gitignore')).replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(cwd, '.gitignore'), seed, 'utf8');
    const converged = assertShapeConverges(cwd, { newProject: false, expected: fullBlock() });
    assert.match(converged, /^\.env$/m);
    assert.equal(converged.split('node_modules/').length - 1, 1);
  });
});

// ── the exact bytes of every well-formed shape ──────────────────────────────
test('ensureProjectGitignore writes exact, stable bytes for the well-formed shapes', () => {
  // Absent.
  withTempDir((cwd) => {
    assertShapeConverges(cwd, { expected: narrowBlock() });
  });
  // Absent, greenfield.
  withTempDir((cwd) => {
    assertShapeConverges(cwd, { newProject: true, expected: fullBlock() });
  });
  // Whitespace-only.
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), '  \n\n\t\n', 'utf8');
    assertShapeConverges(cwd, { expected: narrowBlock() });
  });
  // No trailing newline.
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'owner-a/', 'utf8');
    assertShapeConverges(cwd, { owner: ['owner-a/'], expected: `owner-a/\n\n${narrowBlock()}` });
  });
  // CRLF owner file with no markers: the owner's interior line endings are their
  // own business; only the separator line above our block is normalized.
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'owner-a/\r\nowner-b/\r\n', 'utf8');
    assertShapeConverges(cwd, {
      owner: ['owner-a/', 'owner-b/'],
      expected: `owner-a/\r\nowner-b/\n\n${narrowBlock()}`,
    });
  });
  // Owner content above AND below an existing untagged block.
  withTempDir((cwd) => {
    fs.writeFileSync(
      path.join(cwd, '.gitignore'),
      `above/\n\n${untaggedBlockFor('.traffic-one/runs/')}\nbelow/\n`,
      'utf8',
    );
    assertShapeConverges(cwd, {
      owner: ['above/', 'below/'],
      expected: `above/\n\n${narrowBlock()}below/\n`,
    });
  });
});

// Peer review: the tail splice used `/^\s+/`, which also ate the INDENTATION of
// the first owner line below the end marker. Leading whitespace is significant
// in a gitignore pattern (only TRAILING spaces are ignored, and only unquoted),
// so `  build/` names a directory literally called `  build` and matches
// nothing; stripping the two spaces turns that inert line into a live rule that
// hides the project's real `build/`. Blank lines are still collapsed — that is
// what keeps a converged file from growing a blank line per call — but not one
// byte of indentation.
test('ensureProjectGitignore preserves the indentation of the owner line below the end marker', () => {
  const indented = [
    ['two spaces', '  indented-owner-line/'],
    ['a tab', '\tindented-owner-line/'],
    ['a would-be build rule', '  build/'],
  ] as const;
  for (const [label, ownerLine] of indented) {
    withTempDir((cwd) => {
      const content = `${narrowBlock()}${ownerLine}\nplain-owner-line/\n`;
      fs.writeFileSync(path.join(cwd, '.gitignore'), content, 'utf8');
      const converged = assertShapeConverges(cwd, {
        owner: [ownerLine, 'plain-owner-line/'],
        expected: content,
      });
      assert.ok(
        converged.endsWith(`${GITIGNORE_BLOCK_END}\n${ownerLine}\nplain-owner-line/\n`),
        `${label}: the owner's leading whitespace is theirs, not ours to normalize`,
      );
    });
  }

  // A stale block forces a real rewrite of the region, so the tail is spliced
  // rather than left in place — and the blank-line collapse still happens.
  withTempDir((cwd) => {
    const stale = `${untaggedBlockFor('.traffic-one/runs/')}\n\n  indented-owner-line/\nplain/\n`;
    fs.writeFileSync(path.join(cwd, '.gitignore'), stale, 'utf8');
    const converged = assertShapeConverges(cwd, {
      owner: ['  indented-owner-line/', 'plain/'],
      expected: `${narrowBlock()}  indented-owner-line/\nplain/\n`,
    });
    assert.ok(converged.includes(`${GITIGNORE_BLOCK_END}\n  indented-owner-line/`));
  });
});

// Migration: the marker gains its scope on the first convergence and never
// churns again. One single-line diff per project, then byte-stable forever.
test('ensureProjectGitignore records the scope on an untagged block exactly once', () => {
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), untaggedBlockFor('.traffic-one/runs/'), 'utf8');
    assert.equal(ensureProjectGitignore(cwd), true, 'the untagged marker is migrated');
    assert.equal(gitignoreOf(cwd), narrowBlock());
    assertShapeConverges(cwd, { expected: narrowBlock() });
  });
});

// Defect: fs.readFileSync/writeFileSync both follow symlinks, so a `.gitignore`
// that is a symlink pointing outside projectRoot would get written THROUGH the
// link into whatever it targets. Same best-effort contract as every other
// failure mode here: never throws, never blocks the caller, returns false.
test('ensureProjectGitignore never writes through a symlinked .gitignore', () => {
  withTempDir((cwd) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-scaffold-content-outside-'));
    try {
      const target = path.join(outsideDir, 'real-file-outside-project.txt');
      fs.writeFileSync(target, 'do-not-touch\n', 'utf8');
      fs.symlinkSync(target, path.join(cwd, '.gitignore'));
      assert.equal(ensureProjectGitignore(cwd), false, 'a symlinked .gitignore is a no-op');
      assert.equal(fs.readFileSync(target, 'utf8'), 'do-not-touch\n', 'the symlink target is never written through');
      assert.ok(
        fs.lstatSync(path.join(cwd, '.gitignore')).isSymbolicLink(),
        'the symlink itself is left exactly as it was',
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // It is the LINK-ness that is refused, not the destination: a link pointing
  // inside the project is refused too, so the rule needs no path reasoning.
  withTempDir((cwd) => {
    const target = path.join(cwd, 'inside.txt');
    fs.writeFileSync(target, 'inside\n', 'utf8');
    fs.symlinkSync(target, path.join(cwd, '.gitignore'));
    assert.equal(ensureProjectGitignore(cwd), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'inside\n');
  });

  // A DANGLING link must not be "created" through either: O_NOFOLLOW refuses the
  // update open, and the create path uses O_CREAT|O_EXCL, so neither can land on
  // the link's target.
  withTempDir((cwd) => {
    fs.symlinkSync(path.join(cwd, 'nothing-here.txt'), path.join(cwd, '.gitignore'));
    assert.equal(ensureProjectGitignore(cwd), false);
    assert.ok(!fs.existsSync(path.join(cwd, 'nothing-here.txt')), 'the link target was not created');
    assert.ok(fs.lstatSync(path.join(cwd, '.gitignore')).isSymbolicLink());
  });
});

// A directory at `.gitignore` is refused by the open itself (EISDIR), and the
// best-effort contract holds: no throw, no write, `false`.
test('ensureProjectGitignore refuses a .gitignore that is a directory', () => {
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.gitignore'));
    fs.writeFileSync(path.join(cwd, '.gitignore', 'inside.txt'), 'keep\n', 'utf8');
    assert.equal(ensureProjectGitignore(cwd), false);
    assert.equal(ensureProjectGitignore(cwd, { newProject: true }), false);
    assert.ok(fs.lstatSync(path.join(cwd, '.gitignore')).isDirectory(), 'left as a directory');
    assert.equal(fs.readFileSync(path.join(cwd, '.gitignore', 'inside.txt'), 'utf8'), 'keep\n');
  });
});
