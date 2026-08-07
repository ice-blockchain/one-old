// src/shared/architecture-contract/convention-evidence.ts
// "May we seed OUR opinion of this tool's config into this project?" answered
// from the FILESYSTEM, per toolchain slot.
//
// The scaffold bodies in scaffold-content.ts that configure a linter or a
// formatter are opinions about someone else's repository: every one is a file
// its tool DISCOVERS automatically, so its mere presence changes how the
// project's own `lint`/`format` commands behave. They are compiled only under
// compile.ts's `isNewProject` — `state.mode === 'new-project'`, which is a GUESS
// (`detectMode` answers new-project for anything with five or fewer files in
// SOURCE_EXTS), so the guess needs a veto with facts in it.
//
// The veto this replaces asked `hasCommittedHistory`. That question is unfit at
// this point in the lifecycle, and shared/capabilities/profile.ts:98-104 already
// said so in as many words for its own veto: "a greenfield project routinely HAS
// a commit at this point (a user who ran `git init && git commit` first, and
// every run-sim case — `initRepo` commits before the run id is minted), so the
// history arm would narrow genuine greenfield runs." It narrowed them to
// nothing: every run-sim case commits before PLAN_READY, so no simulated run has
// ever received a `ruff.toml`, and `stack-lint` — which qa-evidence/stack.ts:214
// gates on the FILE, not the binary — resolved to "the project declares no lint
// command" for every Python shape.
//
// So ask the two questions the history proxy was standing in for, both of them
// intrinsic to the thing worth protecting:
//
//   A. Does the project already DECLARE this tool, under any spelling the tool
//      itself discovers (or a competing tool in the same slot)? This is the
//      whole marginal protection the veto ever had over `seedIfBlank`, which
//      already refuses to overwrite a non-empty file: the danger case is our
//      path being ABSENT while an equivalent lives under a different name —
//      an `.eslintrc.json`, a `[tool.ruff]` section in `pyproject.toml`, a
//      `biome.json`. `ruff.toml` OUTRANKS `pyproject.toml [tool.ruff]` and
//      `eslint.config.js` REPLACES `.eslintrc*` outright under ESLint 9, so
//      seeding either one silently rewires a toolchain the project chose.
//      Competing linters count because rules/common/quality-tooling.md tells
//      agents "do not add a second linter beside the one it uses".
//   B. Does the project already hold SOURCE in that toolchain's language? This
//      generalises `webAppHoldsSource` in profile.ts: a project with code but no
//      config for that tool has not asked for our bar either, and handing it one
//      makes our own `stack-lint` enforce that bar against code no agent in the
//      run wrote — which can block settlement on legacy source. Zero is the
//      threshold, for profile.ts's reason: a tree that thin already reads
//      `new-project` to `detectMode`, so a higher threshold would only withhold
//      from projects that have nothing to lose.
//
// Neither arm can be produced by a misclassification, and both fail toward
// "withhold" when they cannot be read. `.gitignore` is deliberately NOT here: it
// has its own authority in shared/greenfield-evidence.ts, whose two arms
// (no project-owned content, no commits) are about what git must ignore rather
// than about a toolchain.
//
// Filesystem-only, no subprocess: this runs inside the PLAN_READY transaction.

import * as fs from 'fs';
import * as path from 'path';

/**
 * One linter/formatter slot. A slot, not a tool: what matters is whether the
 * project has already spoken about THIS KIND of automation, by any means.
 */
export type ConventionSlot =
  | 'js-lint'
  | 'js-format'
  | 'css-lint'
  | 'python-quality'
  | 'go-quality'
  | 'php-quality'
  | 'rust-quality';

/** Which slot each scaffolded convention body belongs to. */
export const CONVENTION_SLOT_BY_BASENAME: Readonly<Record<string, ConventionSlot>> = {
  'eslint.config.js': 'js-lint',
  '.prettierrc': 'js-format',
  '.prettierignore': 'js-format',
  '.stylelintrc.json': 'css-lint',
  'ruff.toml': 'python-quality',
  '.golangci.yml': 'go-quality',
  'pint.json': 'php-quality',
  'rustfmt.toml': 'rust-quality',
};

// Every spelling the slot's tool discovers on its own, plus the same-slot
// competitors named in scaffold-content.ts's own rationale. Deliberately NOT
// exhaustive of every linter ever written: each entry is a file whose presence
// means "this project has already configured this kind of check", and a name
// nobody can point at a tool for would only withhold seeds for no reason.
const SLOT_CONFIG_FILES: Readonly<Record<ConventionSlot, readonly string[]>> = {
  'js-lint': [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
    'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.mjs',
    '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    'biome.json', 'biome.jsonc',
  ],
  'js-format': [
    '.prettierrc', '.prettierrc.json', '.prettierrc.json5',
    '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.toml',
    '.prettierrc.js', '.prettierrc.mjs', '.prettierrc.cjs', '.prettierrc.ts',
    'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs',
    'prettier.config.ts',
    // An ignore file with no rc is still prettier in use, and it is the ONLY
    // spelling prettier accepts for it — this slot is the whole marginal
    // protection `.prettierignore` can have.
    '.prettierignore',
    'biome.json', 'biome.jsonc',
  ],
  'css-lint': [
    '.stylelintrc', '.stylelintrc.js', '.stylelintrc.cjs', '.stylelintrc.mjs',
    '.stylelintrc.json', '.stylelintrc.yml', '.stylelintrc.yaml',
    'stylelint.config.js', 'stylelint.config.cjs', 'stylelint.config.mjs',
    'stylelint.config.ts',
  ],
  'python-quality': [
    'ruff.toml', '.ruff.toml',
    // Competing linters in the same slot.
    '.flake8', '.pylintrc', 'pylintrc',
  ],
  'go-quality': [
    '.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json',
  ],
  'php-quality': [
    'pint.json',
    '.php-cs-fixer.php', '.php-cs-fixer.dist.php', 'ecs.php',
    'phpcs.xml', 'phpcs.xml.dist', '.phpcs.xml', '.phpcs.xml.dist',
  ],
  'rust-quality': ['rustfmt.toml', '.rustfmt.toml'],
};

/**
 * A TOP-LEVEL key of a formatted `package.json`, and only a top-level one.
 *
 * The indentation is the whole assertion, because in JSON nesting IS indentation
 * and the key names we look for are also ordinary dependency names. `"prettier"`
 * one level down, inside `devDependencies`, is the project INSTALLING prettier;
 * `"prettier"` at the top level is the project CONFIGURING it, and only the
 * second is a declaration that should withhold our seed. A pattern that accepts
 * any indentation cannot tell them apart — and the manifest we seed ourselves in
 * scaffold-content.ts carries `"prettier"`, `"stylelint"` and `"eslint"` as
 * devDependencies, so it would read as three declarations the moment anything
 * asked this question after that manifest reached disk.
 *
 * Deliberately NOT `^\s*`: under the `m` flag `\s` matches newlines too, so a
 * leading `\s*` lets `^` anchor on some earlier blank line and walk down to a
 * key at ANY depth. `[ \t]` keeps the match inside one line.
 *
 * One indent level is two spaces or one tab — every package manager that has
 * ever rewritten a manifest (npm, yarn, pnpm) normalises to two spaces, and
 * prettier's own JSON default is the same. Two residuals are accepted, one on
 * each side: a hand-kept FOUR-space manifest's top-level key is missed, which
 * fails toward seeding and is reformatted back into range by the first `npm
 * install`; a manifest that opens `{ "devDependencies": {` on one line puts its
 * nested keys at two spaces and is read as top-level, which fails toward
 * withholding. Neither is a shape a formatter produces.
 *
 * Where the difference is OBSERVABLE, rather than merely correct: a nested
 * tooling root. Where the tooling manifest is the project root's own
 * `package.json`, `ensureScaffoldContent` has already established it is blank
 * before any of this is asked, so there is no nested key to mis-read. On a
 * `web/` or `apps/*` root the search below also reaches the monorepo root's
 * manifest, which nothing cleared — and a root that lists `prettier` in
 * `devDependencies` withheld that package's entire tooling cluster under a
 * pattern that ignored the indent.
 *
 * The VALUE is left unconstrained on purpose. Prettier's `package.json` key may
 * legitimately be a string path (`"prettier": "./cfg.json"`) as well as an
 * object, so a value class that tried to distinguish "a config" from "a version
 * string" would either lose that spelling or re-admit the nested case the indent
 * already excludes. Once the key is known to be top-level there is nothing left
 * to disambiguate.
 */
function topLevelManifestKey(key: string): RegExp {
  return new RegExp(`^(?: {2}|\\t)"${key}"[ \\t]*:`, 'm');
}

/**
 * Declarations that live INSIDE a manifest the tool also discovers. A section in
 * `pyproject.toml` is exactly the case the old comment named and the case
 * `seedIfBlank` is blind to, because it is not a file at our path.
 *
 * Matched with a line-anchored regex rather than a TOML/JSON parse: the runtime
 * is dependency-free, and a false NEGATIVE here would widen a write, so the
 * pattern is the one both `[tool.ruff]` and `[tool.ruff.lint]` produce.
 *
 * The TOML and INI entries keep `^\s*`, and that is not the same widening the
 * JSON entries had: neither format nests by indentation, so a `[tool.ruff]`
 * header is top-level wherever its line happens to start.
 */
const SLOT_MANIFEST_SECTIONS: Readonly<Record<ConventionSlot, readonly {
  file: string;
  pattern: RegExp;
}[]>> = {
  'js-lint': [{ file: 'package.json', pattern: topLevelManifestKey('eslintConfig') }],
  'js-format': [{ file: 'package.json', pattern: topLevelManifestKey('prettier') }],
  'css-lint': [{ file: 'package.json', pattern: topLevelManifestKey('stylelint') }],
  'python-quality': [
    { file: 'pyproject.toml', pattern: /^\s*\[tool\.(?:ruff|pylint)[.\]]/m },
    { file: 'setup.cfg', pattern: /^\s*\[flake8\]/m },
    { file: 'tox.ini', pattern: /^\s*\[flake8\]/m },
  ],
  'go-quality': [],
  'php-quality': [],
  'rust-quality': [],
};

// The extensions whose presence means "this toolchain has code here". Narrower
// than SOURCE_EXTS on purpose: this is a per-slot question, and a Go file is no
// evidence that an eslint config would land on anything.
const SLOT_SOURCE_EXTS: Readonly<Record<ConventionSlot, readonly string[]>> = {
  'js-lint': ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'],
  'js-format': ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'],
  'css-lint': ['.css', '.scss', '.sass', '.less'],
  'python-quality': ['.py', '.pyi'],
  'go-quality': ['.go'],
  'php-quality': ['.php'],
  'rust-quality': ['.rs'],
};

// Our own state and the caches no toolchain owns. `.git` and `node_modules` for
// countSourceFiles's reasons; `.traffic-one` because module skeletons and run
// artefacts under it are OURS, and reading our own scaffold back as the
// project's source is how a one-shot veto becomes permanent.
const SOURCE_SCAN_SKIPPED_DIRS = new Set<string>([
  '.git', 'node_modules', '.traffic-one', 'vendor', 'venv', '.venv',
  '__pycache__', 'target', 'dist', 'build', '.next', '.nuxt',
]);

/** Non-blank content at `rel`, or null. Blank is "nothing stated", never a declaration. */
function statedContent(dir: string, rel: string): string | null {
  try {
    const body = fs.readFileSync(path.join(dir, rel), 'utf8');
    return body.trim().length > 0 ? body : null;
  } catch {
    return null; // absent, or unreadable from here — states nothing
  }
}

/**
 * Arm A. True when `dir` (or `projectRoot`, which every one of these tools also
 * searches on its way up) already declares this slot's automation.
 *
 * A file that exists but is BLANK does not count: seeding canonical content into
 * a blank config is this module's whole purpose, and a blank file may well be
 * one we compiled ourselves on an earlier run.
 */
export function projectDeclaresSlot(
  projectRoot: string,
  dir: string,
  slot: ConventionSlot,
): boolean {
  const searched = dir === projectRoot ? [dir] : [dir, projectRoot];
  for (const base of searched) {
    for (const rel of SLOT_CONFIG_FILES[slot]) {
      if (statedContent(base, rel) !== null) return true;
    }
    for (const section of SLOT_MANIFEST_SECTIONS[slot]) {
      const body = statedContent(base, section.file);
      if (body !== null && section.pattern.test(body)) return true;
    }
  }
  return false;
}

/**
 * Arm B. True when `dir`'s subtree already holds source in this slot's language.
 *
 * Bounded depth because this runs in a hook and the answer is decided by the
 * first hit: a project deep enough to hide all of its code below 12 levels is
 * not one we should be seeding opinions into anyway.
 */
export function projectHoldsSlotSource(dir: string, slot: ConventionSlot): boolean {
  const exts = new Set(SLOT_SOURCE_EXTS[slot]);
  const walk = (current: string, depth: number): boolean => {
    if (depth > 12) return true; // unreadable depth: fail toward withholding
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // A directory we cannot read may hold anything; only positive evidence of
      // emptiness may widen a write, so this is not evidence of emptiness.
      return true;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SOURCE_SCAN_SKIPPED_DIRS.has(entry.name)) continue;
        if (walk(path.join(current, entry.name), depth + 1)) return true;
        continue;
      }
      if (entry.isFile() && exts.has(path.extname(entry.name))) return true;
    }
    return false;
  };
  try {
    if (!fs.statSync(dir).isDirectory()) return true;
  } catch {
    return false; // the output's own directory does not exist yet: nothing there
  }
  return walk(dir, 0);
}

/**
 * THE RULE — may we seed this slot's canonical config into `dir`?
 *
 * Both arms are facts on disk, and both fail toward `false`.
 */
export function slotAcceptsScaffold(
  projectRoot: string,
  dir: string,
  slot: ConventionSlot,
): boolean {
  return !projectDeclaresSlot(projectRoot, dir, slot)
    && !projectHoldsSlotSource(dir, slot);
}
