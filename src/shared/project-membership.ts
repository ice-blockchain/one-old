// src/shared/project-membership.ts
// "Which project does this directory belong to?" — the ownership primitive shared by
// hook root resolution (shared/hook/paths) and the state-write veto
// (shared/state/normalize). Deliberately a LOW layer: it depends only on node
// builtins + authoring-root, so the state writer can consult it without the
// state → hook/paths → state cycle.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { hasPluginAuthoringMarkers, isMachineConfigRoot } from './authoring-root';

// A directory OWNS a project when it carries version control or a language manifest
// of its own — the top of a repo or module. Deliberately EXCLUDES `.traffic-one` /
// `.one.json` (unlike shared/paths.ts PROJECT_MARKERS, which is a STATE lookup):
// including them would make membership self-confirming, so a directory that once
// accrued stray state would own a project forever and never heal, and a stray
// `~/.traffic-one` would turn the home dir into a project.
export const VCS_MARKERS = ['.git', '.hg', '.svn'] as const;

/**
 * Files that DECLARE a project: "the thing built here is a module of its own".
 *
 * The ecosystems this list used to omit, and the omission was not cosmetic:
 * `dirOwnsProject` is the state-write veto's own test (see state/normalize.ts
 * writeState and state/local-prefs/prefs-store.ts updateProjectPrefs, which
 * refuse to CREATE state in a directory that belongs to an enclosing project).
 * A Maven, Gradle, pip-only, .NET or Elixir directory therefore answered
 * "belongs to the repo above me" and could never hold state OR preferences of
 * its own — measured end to end: writeState false, `.one.json` absent, the
 * per-project prefs bucket never created, so not even the use-plugin consent
 * answer could be recorded. Under a Traffic One workspace that is terminal
 * rather than inconvenient: a member with no state is never `done`, and
 * onboarding-server/flow.ts keeps the whole container at `members-pending`
 * forever waiting for it.
 *
 * WHAT IS DELIBERATELY ABSENT, because it is the rule this list is FOR:
 * `settings.gradle(.kts)` is not here, and adding it was the exact inversion of
 * the list's meaning. A settings file is Gradle's way of saying "THESE ARE MY
 * MEMBERS" — it is a workspace DECLARATION, the Gradle spelling of npm's
 * `workspaces` glob — so registering it as "I am a project" made a Gradle
 * submodule resolve to ITSELF while the identically shaped npm sub-package
 * resolved to its workspace root. MEASURED on two identical layouts before the
 * removal: `resolveProjectRoot(cwd=member)` answered the workspace root for npm
 * and `modules/api` for Gradle, and `isUnclaimedWorkspaceSubPackage` answered
 * true for npm and false for Gradle. The semantics live in hook/paths.ts
 * `dirDeclaresWorkspace`, which now knows both spellings, and the Gradle
 * submodule still owns a project through `build.gradle(.kts)` — which every
 * submodule carries and which stays here.
 */
export const MANIFEST_MARKERS = [
  'go.mod', 'go.work', 'package.json', 'composer.json', 'pyproject.toml',
  'Cargo.toml', 'Gemfile', 'pubspec.yaml', 'deno.json', 'deno.jsonc',
  'pom.xml', 'mix.exs',
  // setuptools predates `pyproject.toml` and is still what a great many Python
  // distributions ship. Both are DECLARATIONS of a distribution (name, version,
  // packages), unlike `requirements.txt` below, so they belong in the strong
  // list — measured on the wedge table: with them absent a `setup.py`-only
  // member was refused state and held its container at `members-pending`
  // exactly like the pip member the plan named.
  'setup.py', 'setup.cfg',
  // BOTH Gradle build spellings, because the defect is the ecosystem and not
  // the filename: a Kotlin-DSL module ships only `build.gradle.kts` and was
  // wedged exactly like the Groovy one.
  'build.gradle', 'build.gradle.kts',
] as const;

/**
 * A marker that names DEPENDENCIES rather than a project — and therefore only
 * declares a project when nothing above it already has.
 *
 * `requirements.txt` is a pip input file. It does not declare a distribution
 * any more than `settings.gradle` declares a module, and treating it as a
 * manifest split real repositories: MEASURED on a `.git` + `pyproject.toml`
 * Python repo with a conventional Sphinx `docs/requirements.txt`,
 * `dirOwnsProject(docs)` answered true, `resolveProjectRoot` answered `docs`,
 * and `writeState(docs)` persisted a `.one.json` there. `tests/requirements.txt`
 * is equally routine and behaved identically. That split happens during the
 * pre-onboarding window in which onboarding itself runs, which is when it is
 * most expensive.
 *
 * It cannot simply be dropped the way `settings.gradle` was, because the wedged
 * pip shape is precisely a member carrying NOTHING else. So the distinction is
 * STRENGTH, not membership: a weak marker declares a project only when no
 * ancestor directory holds a STRONG one.
 *
 * MANIFEST-BASED, NEVER `.git`-BASED, and that is the whole of why this works.
 * Keying the ancestor test on version control would re-wedge the pip monorepo:
 * the holder of a pip member has `.git` too, so every member would be absorbed
 * back into it and the container would return to waiting forever. Measured both
 * tables after the change — `docs/` and `tests/` resolve to the repository, and
 * the pip member under a manifest-less holder still owns a project.
 */
export const WEAK_MANIFEST_MARKERS = ['requirements.txt'] as const;

// The markers that are a PATTERN, not a name: an MSBuild project file is
// `<AnyName>.csproj` / `.fsproj` / `.vbproj` / `.vcxproj`, so there is nothing
// to `existsSync`. Kept in their OWN list rather than smuggled into the
// literals above, where a `'*.csproj'` entry would sit among names that are
// checked by existence and match a file nobody will ever create.
//
// ALL FOUR MSBuild spellings, for the same reason the list carries both Gradle
// build files: the defect is the ecosystem, not the filename. `.fsproj`,
// `.vbproj` and `.vcxproj` are the same MSBuild project file as `.csproj`
// differing only in language, the parent plan named ".NET" rather than "C#",
// and each was measured wedged identically — writeState refused, no prefs
// bucket, container held at `members-pending`.
//
// Suffix matching, not globbing: the pattern's only variable part is the stem,
// and a directory listing already answers "is there a file ending in .csproj"
// exactly. A bare `.csproj` is excluded (`length > suffix.length`) — that is a
// dotfile, not a project.
export const MANIFEST_SUFFIX_MARKERS = ['.csproj', '.fsproj', '.vbproj', '.vcxproj'] as const;

// Bound the upward walk so a hook can never spend unbounded fs reads climbing to /.
const MAX_MEMBERSHIP_WALK = 40;

// Segment-aware containment (/repo is not within /repo2). Local so this module keeps
// no dependency on shared/hook/paths.
function withinCeiling(dir: string, ceiling: string): boolean {
  return dir === ceiling || dir.startsWith(ceiling + path.sep);
}

// existsSync, never isDirectory: `.git` is a FILE in a worktree or submodule.
function dirHasVcs(dir: string): boolean {
  const resolved = path.resolve(dir);
  return VCS_MARKERS.some((marker) => fs.existsSync(path.join(resolved, marker)));
}

// The listing is the FALLBACK, never the first question: every named marker is
// tried by existence first, so a directory that carries one costs the same
// syscalls it always did.
//
// A MARKER-LESS DIRECTORY DOES PAY THE READDIR, and the previous wording of
// this note — that the ordering keeps the suffix marker "off the resolution hot
// path" — was wrong in the one direction that matters. The ordering bounds the
// cost for directories that DO carry a named marker; it buys a directory
// carrying none of them nothing, and a marker-less directory is exactly what
// the resolution walk meets most often. What genuinely bounds the total is that
// `projectMembershipRoot` asks `dirOwnsProject` of the START dir alone —
// ancestors are judged by version control, which is three `existsSync` calls
// and no listing.
function dirHasSuffixManifest(resolved: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(resolved);
  } catch {
    return false; // unreadable dir → no marker we can vouch for
  }
  return entries.some((entry) => MANIFEST_SUFFIX_MARKERS.some(
    (suffix) => entry.length > suffix.length && entry.endsWith(suffix),
  ));
}

function dirHasStrongManifest(resolved: string): boolean {
  return MANIFEST_MARKERS.some((marker) => fs.existsSync(path.join(resolved, marker)));
}

/**
 * Does any ANCESTOR of `dir` declare a project with a strong manifest?
 *
 * Named markers only, deliberately: including the suffix markers would put a
 * `readdirSync` on every level of an upward walk, and the ecosystems that ship
 * a weak marker (pip) sit under a Python distribution root — `pyproject.toml`,
 * `setup.py`, `setup.cfg` — which is a named one. Omitting them can only make
 * this answer `false`, i.e. let a weak marker declare a project, which is the
 * incumbent behaviour and not a new risk.
 *
 * Starts at the PARENT and stops where every other walk in this module stops.
 *
 * READ THIS BEFORE DEBUGGING A SURPRISING `dirOwnsProject` ANSWER. A weak
 * marker's verdict is NOT A PROPERTY OF THE DIRECTORY ALONE — it depends on the
 * tree ABOVE it, and this predicate is the only reason why. Every other signal
 * in this module is answered by looking in one directory, so the same folder
 * copied to two depths always answered the same. A `requirements.txt` folder
 * does not: directly under `$HOME` with nothing above it, it owns a project;
 * two levels under a `pyproject.toml` root, it does not. Both answers are
 * correct and the difference is the whole point of the weak/strong split
 * (`docs/requirements.txt` is Sphinx's convention, not a second project), but a
 * reader comparing two checkouts and finding them disagree will look at the
 * directory first and find nothing there to explain it.
 *
 * The walk is bounded and cannot run away: it stops at `$HOME`, at a machine
 * config root, at the filesystem root, and at `MAX_MEMBERSHIP_WALK` levels
 * whichever comes first.
 */
function ancestorDeclaresProject(dir: string): boolean {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX-capped */ }
  let current = path.dirname(dir);
  for (let i = 0; i < MAX_MEMBERSHIP_WALK; i += 1) {
    if (home && current === home) return false;
    if (isMachineConfigRoot(current)) return false;
    if (dirHasStrongManifest(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

// The upward walk is paid ONLY by a directory whose sole project signal is a
// weak marker: version control, every strong manifest and the suffix listing
// are all answered first, and a directory with no `requirements.txt` at all
// stops at one extra `existsSync`.
function dirHasWeakManifest(resolved: string): boolean {
  if (!WEAK_MANIFEST_MARKERS.some((marker) => fs.existsSync(path.join(resolved, marker)))) return false;
  return !ancestorDeclaresProject(resolved);
}

function dirHasManifest(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (dirHasStrongManifest(resolved)) return true;
  if (dirHasSuffixManifest(resolved)) return true;
  return dirHasWeakManifest(resolved);
}

/**
 * TWO CONSEQUENCES OF WIDENING THIS ANSWER, both measured, neither of them a
 * bug and both of them behaviour changes that nothing else in the tree names.
 *
 * 1. STRAY STATE INSIDE A NEWLY RECOGNISED MODULE NO LONGER SELF-HEALS.
 *    hook/paths.ts `nearestOnboardedRoot` treats a mode-bearing `.one.json` as
 *    a LEAK only when the directory owns no project, so retention's
 *    `isLeakedNestedRoot` used to report a stray `.traffic-one` inside a Gradle
 *    or Maven submodule and the SessionStart sweep healed it. Measured on a
 *    `.git` + build-file repo with a full `new-project` state seeded into
 *    `modules/api`: leaked `true` with the marker unlisted, `false` with it
 *    listed. This is the SAFE direction — the module is a project now, so its
 *    state is its own — but the previously automatic cleanup is gone and the
 *    stray must be removed by hand.
 *
 * 2. IT ENLARGES THE KEEP → DELETE POPULATION, in one narrow shape. The leak
 *    test reads `projectMembershipRoot(dirname(current))`, so a HOLDER that
 *    starts owning a project can make the walk climb PAST a real root. Measured
 *    on a holder carrying a marker and a committed `.one.json`, with NO version
 *    control anywhere in the tree, and a marker-less onboarded `sub/` inside it:
 *    `resolveProjectRoot(sub)` moved from `sub` to the holder and
 *    `isLeakedNestedRoot(sub)` moved from `false` to `true` — a directory the
 *    sweep used to keep is now a deletion candidate. Version control anywhere
 *    above removes it (the membership answer is already non-null), which is why
 *    the population is narrow rather than absent.
 */
export function dirOwnsProject(dir: string): boolean {
  return dirHasVcs(dir) || dirHasManifest(dir);
}

// The project a directory BELONGS to: itself when it owns a project, otherwise the
// nearest ANCESTOR that is a repository. A dir owning a marker belongs to ITSELF, so a
// git submodule or nested module is never absorbed into its parent. Answers from the
// filesystem alone, so it works BEFORE anything is onboarded — exactly when root
// resolution used to guess wrong and mint a project for whatever subdirectory a tool
// happened to touch.
//
// Asymmetry by design: for the START dir a manifest is enough (a module root IS a
// project), but only VERSION CONTROL lets an ANCESTOR absorb a child. A manifest marks
// "this dir is a module"; it is not authority over everything beneath it, and a stray
// one high in the tree would otherwise hijack every marker-less dir below — observed
// live: a leftover `go.mod` in `~/Documents` and `~/Documents/projects` made an
// unrelated multi-repo workspace resolve to `~/Documents/projects`. `.git` is the
// intentional, unambiguous repository boundary.
//
// The break-guards mirror nearestWorkspaceRoot: they are what stops the walk at an
// UNRELATED ancestor (machine config space, the home dir, above the host's workspace
// root, the plugin's own repo).
export function projectMembershipRoot(startDir: string, ceiling?: string): string | null {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX-capped */ }
  const ceil = ceiling ? path.resolve(ceiling) : '';
  const start = path.resolve(startDir);
  let current = start;
  for (let i = 0; i < MAX_MEMBERSHIP_WALK; i += 1) {
    if (home && current === home) break;
    if (isMachineConfigRoot(current)) break;
    if (ceil && !withinCeiling(current, ceil)) break;
    const owns = current === start ? dirOwnsProject(current) : dirHasVcs(current);
    if (owns && !hasPluginAuthoringMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
