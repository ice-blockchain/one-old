// src/build/golden-update.ts
// Regenerates tests/golden/generated-manifest.sha256 from the current source
// tree (run via `npm run golden:update`): gen to a scratch dir, hash every
// emitted artifact except the deliberate exclusions, write sorted lines.
// Replaces the error-prone manual set-preserving regen — and because the
// manifest now covers the FULL emitted set, newly added content generators are
// covered automatically instead of being silently invisible to the golden test.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runGen } from '../gen';
import { copyModuleDescriptors } from './copy-module-assets';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The T1BLOCK deny-prose blocks in src/modules/*/skill/SKILL.md, and the
// module.json descriptors the registry's readdir discovery needs, reach an
// install via `npm run build` -> copyModuleDescriptors ->
// dist/scripts/modules/<id>/{module.json,skill/*.md}, never via `gen` (gen
// only emits the SEPARATE skills/ + skills-catalog/ shipped-skill trees — see
// gen/emit/skills.ts). Editing a deny message therefore could not drift the
// golden manifest, and the additions-aware reverse sweep could not catch a
// new one either. Extending gen's OWN emission to also write this content
// under dist/ would invent a path no real install has (gen owns content,
// build owns scripts/); mirroring the real build-emitted subtree into the
// same scratch tree instead extends the MANIFEST's authority to cover it,
// without blurring gen/build's separation of concerns.
//
// This calls the BUILD's own copyModuleDescriptors rather than copying the
// source files itself. That distinction is the whole point: a hand-rolled
// copy hashes source bytes laundered through a build-shaped path, so a bug
// that stopped the real build from emitting prose would leave this snapshot
// green while every install shipped makeSkillBlock's generic TS fallback
// instead of the authored deny wording (the fallback exists so a missing
// block never disables enforcement, which is exactly what makes a missing
// block invisible at runtime — so the build is where it has to be caught).
// Running the whole buildRuntime here would additionally tsc the entire
// engine into the snapshot; copyModuleDescriptors is the exact step that owns
// these bytes, and it is the same call build-runtime.ts makes.
export function mirrorBuildEmittedModuleAssets(scratch: string, repoRoot: string = REPO_ROOT): string[] {
  const { copied } = copyModuleDescriptors(
    path.join(repoRoot, 'src', 'modules'),
    path.join(scratch, 'scripts', 'modules'),
  );
  return copied.map((rel) => toPosix(path.join('scripts', 'modules', rel)));
}

// The ONE recipe for "the tree the golden manifest describes", shared by
// `npm run golden:update` (which hashes it) and golden-snapshot.test.ts (which
// diffs it against the committed hashes). They must materialize byte-identical
// trees or `golden:update` writes a manifest the test can never reproduce —
// so neither owns its own copy of these two steps.
export function materializeGoldenTree(scratch: string, repoRoot: string = REPO_ROOT): string[] {
  const run = runGen({ check: false, root: scratch, sourceRoot: repoRoot });
  return [...run.written.map(toPosix), ...mirrorBuildEmittedModuleAssets(scratch, repoRoot)];
}

// Everything the manifest deliberately does NOT hash, with the reason on each
// entry — a bare entry here silently removes a shipped file from the only
// byte-level gate, which is how `package.json` came to be excluded while being
// the single file that decides whether the other 500-odd load at all.
//
// Keep in sync with the reverse sweep in golden-snapshot.test.ts.
//
// NOT excluded, deliberately, though it used to be: `package.json`. Its
// `type: 'commonjs'` is the only reason every emitted .js file (tsc CommonJS
// output) loads, and flipping one field to 'module' bricks the whole install
// with `ReferenceError: exports is not defined` while `smoke`, `build:verify`
// and `gen --check` all stay green — each for a different structural reason
// (smoke compiles its own tree into a scratch root, build:verify only diffs
// dist/scripts, gen --check only proves the emitter agrees with itself). The
// version field churns the snapshot on every bump, which is already true of
// the five host manifests and is accepted policy (AGENTS.md: "a version bump
// churns the host manifests in the snapshot — expected"). A snapshot only
// proves a byte moved, never that the move is fatal, so the two fields that
// ARE fatal are additionally asserted by name in
// __tests__/golden-update.test.ts.
export const GOLDEN_EXCLUDED: ReadonlySet<string> = new Set([
  // AGENTS.md/CLAUDE.md are two copies of one source
  // (src/gen/static/plugin-instructions.md); AGENTS.md IS hashed, so the
  // bytes are covered and hashing the duplicate only doubles the churn.
  'CLAUDE.md',
  // gitSha changes on every commit by design (../gen/lib/build-provenance.ts),
  // so a byte pin would churn the manifest on every commit regardless of
  // whether any generator changed — which defeats the point of a snapshot.
  // Its own correctness (present, well-formed, matching between subtrees) is
  // proven by the doctor plugin-root probe and the compiled smoke.
  'build-provenance.json',
  // Byte copies of the two repo-root source docs (gen/emit/static.ts's
  // STATIC_TEXT_FILES). Hashing a verbatim copy of a tracked file cannot
  // detect anything a `git diff` of that file does not already show: the copy
  // is drift-free by construction, so the "drift" it would report is an
  // intentional docs edit, and the only way to clear it is to accept whatever
  // the new bytes say. That is why the exclusion did NOT cause these two to
  // reference `src/...` paths absent from an install, and why un-excluding
  // them would not have caught it: a hash cannot read a path. Claims about
  // their CONTENT are gated where content can actually be checked —
  // tests/readme-claims.test.ts (README.md ↔ code, mechanically).
  'README.md',
  'ref.md',
  // Runtime surface, not a generated transform: an empty seed directory the
  // per-stack skill filter populates at runtime.
  'skills/.gitkeep',
]);

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function updateGoldenManifest(
  repoRoot: string = REPO_ROOT,
  manifestPath: string = path.join(repoRoot, 'tests', 'golden', 'generated-manifest.sha256'),
): { count: number; manifestPath: string } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-golden-update-'));
  try {
    const rels = materializeGoldenTree(scratch, repoRoot)
      .filter((rel) => !GOLDEN_EXCLUDED.has(rel))
      .sort();
    const lines = rels.map((rel) => `${sha256(path.join(scratch, rel))}  ${rel}`);
    fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`, 'utf8');
    return { count: lines.length, manifestPath };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function main(): void {
  const { count, manifestPath } = updateGoldenManifest();
  process.stdout.write(`golden:update: wrote ${count} entries to ${path.relative(process.cwd(), manifestPath)}\n`);
}

if (require.main === module) main();
