// tests/replay-corpus/plugin-root.ts
// Builds the corpus's plugin root: a minimal but REAL 'installed' plugin tree,
// materialized into the isolated per-process HOME by env.ts before any src/
// module loads.
//
// Why an installed tree at all — see env.ts's CORPUS_PLUGIN_ROOT comment. The
// short version: materializeProjectAssets REFUSES on every layout except
// 'installed' (materialize.ts), and a refusal makes onboarding-gate's own
// priority-10 convergence deny `repaired-materialization` for every mutating
// PreToolUse, which hides every later gate. A corpus of ~120 refusal cases that
// all land on one generic deny characterizes nothing.
//
// Why BUILT rather than pointed at `dist/`:
//   - `dist/` is gitignored and produced by `npm run gen && npm run build`. A
//     corpus that needs it cannot run on a fresh checkout or in CI without
//     those steps, and would silently characterize whatever half-built tree
//     happened to be on the maintainer's disk — the exact
//     writer/reader-disagreement class of bug this file exists to remove.
//   - The two trees materialization actually reads (`rules/**`,
//     `skills-catalog/**`) are emitted by gen BYTE-IDENTICALLY from tracked
//     source (see src/gen/emit/rules.ts, .../skills.ts), so they can be
//     produced here by calling those SAME emitters. Nothing is reimplemented
//     and nothing is hand-rolled: if gen's composition changes (a re-split of
//     `rules/**` across content modules, a new frontmatter strip), this tree
//     changes with it.
//
// What is deliberately NOT reproduced: the host manifests, agents/, hooks/,
// `.claude-plugin/plugin.json`, and the compiled `scripts/**` runtime. No gate
// reads them to reach a verdict, the plugin manifest would additionally make
// shared/authoring-root.ts classify this tree as a plugin tree, and the
// compiled runtime is a build artifact by definition. `scripts/hook-runtime.cjs`
// exists as the FILE half of paths.ts's 'installed' predicate and as the argv
// the doctor/wait commands are spelled with — nothing in the corpus executes it.

import * as fs from 'fs';
import * as path from 'path';

import { generatedRuleTemplates } from '../../src/gen/emit/rules';
import { generatedSkillDocs } from '../../src/gen/emit/skills';

// tests/replay-corpus/plugin-root.ts -> repo root. Derived from this file's own
// location, never process.cwd(): the corpus may be entered from anywhere.
const SOURCE_REPO_ROOT = path.resolve(__dirname, '..', '..');

const HOOK_RUNTIME_STUB = [
  '// Placeholder written by tests/replay-corpus/plugin-root.ts.',
  '// Present only because shared/paths.ts classifies a plugin root as',
  '// "installed" from the existence of this FILE plus non-empty generated',
  '// content. The replay corpus never spawns or requires it.',
  'module.exports = {};',
  '',
].join('\n');

function writeFile(root: string, relPath: string, content: string): void {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

export function buildCorpusPluginRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  writeFile(root, path.join('scripts', 'hook-runtime.cjs'), HOOK_RUNTIME_STUB);

  // The two trees materialization resolves from, plus gen's `skills/` bootstrap
  // tree (generatedSkillDocs emits both; keeping them together is what makes
  // this "whatever gen emits" rather than a curated subset).
  for (const doc of generatedRuleTemplates(SOURCE_REPO_ROOT)) writeFile(root, doc.relPath, doc.content);
  for (const doc of generatedSkillDocs(SOURCE_REPO_ROOT)) writeFile(root, doc.relPath, doc.content);

  // Gate PROSE (modules/<id>/skill/SKILL.md), role agent docs and the
  // bootstrap-policy material candidates are resolved as `<pluginRoot>/src/...`
  // by shared/skill-block.ts and shared/skill-filters — the first of the two
  // candidate bases it tries, and the one a source-shipping install has. A
  // symlink (not a copy) keeps that resolution byte-current with the checkout
  // and costs no disk, which matters because this tree is rebuilt once per
  // corpus process. The layout classifier is unaffected: it decides 'installed'
  // from scripts/hook-runtime.cjs + non-empty rules/ BEFORE it looks for source
  // markers, and shared/authoring-root.ts needs a package.json named
  // traffic-one (never written here) to call a tree the authoring repo.
  const srcLink = path.join(root, 'src');
  if (!fs.existsSync(srcLink)) fs.symlinkSync(path.join(SOURCE_REPO_ROOT, 'src'), srcLink, 'dir');
}
