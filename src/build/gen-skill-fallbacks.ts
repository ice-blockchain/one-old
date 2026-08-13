// src/build/gen-skill-fallbacks.ts
// Emits src/shared/skill-fallbacks.generated.ts: one TS module holding the body
// of every `T1BLOCK` in every src/modules/<id>/skill/SKILL.md, keyed
// `<moduleId> :: <blockName>`.
//
//   npx tsx src/build/gen-skill-fallbacks.ts            # regenerate
//   npx tsx src/build/gen-skill-fallbacks.ts --check    # fail if stale (plugin:check)
//
// ── why the output is TRACKED SOURCE and not a dist/ artifact ────────────────
// The table is what a gate renders when its SKILL.md cannot be read. Everything
// under dist/ is reached back through `pluginRoot()` (shared/paths.ts), which is
// supplied by TRAFFIC_ONE_PLUGIN_ROOT / CODEX_PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT /
// CURSOR_PLUGIN_ROOT and — documented there — never throws and never refuses an
// `unverified` root. A fallback resolved through that variable fails in exactly
// the case it exists for. A `.ts` file under src/shared/ is instead resolved by
// Node RELATIVE TO THE REQUIRING FILE, both under tsx (src/shared/) and in an
// install (dist/scripts/shared/), which is the only prose path in this codebase
// that does not pass through an environment variable.
//
// ── why the fallbacks are generated and never deleted ───────────────────────
// Deleting them would convert a drift bug into a silent-deny bug on the
// first-contact path, and no build-time assertion can prevent that, because the
// runtime resolves prose from a root it is handed. So the prose stays reachable
// at runtime with no filesystem read at all; what goes away is the SECOND
// hand-maintained copy at each call site.
//
// ── the shrink gate ─────────────────────────────────────────────────────────
// A regeneration that makes an entry SHORTER is the dangerous direction: it
// deletes remedy text from the torn-install path, and a parity test comparing
// the two copies goes GREEN on the loss because both sides moved together. So a
// shrink (or a dropped key) is refused unless `--allow-shrink` is passed, which
// makes the loss a deliberate, reviewable act rather than a side effect of
// running a build step.

import * as fs from 'fs';
import * as path from 'path';

import { fallbackKey, listBlockNames, extractBlock } from '../shared/skill-markers';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_REL = path.join('src', 'shared', 'skill-fallbacks.generated.ts');
const GEN_CMD = 'npx tsx src/build/gen-skill-fallbacks.ts';

export interface FallbackTable { readonly [key: string]: string }

/** Read every module SKILL.md under `<root>/src/modules` and collect its blocks. */
export function collectFallbacks(repoRoot: string = REPO_ROOT): FallbackTable {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  const out: Record<string, string> = {};
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(modulesDir, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skill = path.join(modulesDir, entry.name, 'skill', 'SKILL.md');
    let text: string;
    try { text = fs.readFileSync(skill, 'utf8'); } catch { continue; }
    for (const name of listBlockNames(text)) {
      const body = extractBlock(text, name);
      if (body !== null) out[fallbackKey(entry.name, name)] = body;
    }
  }
  return out;
}

const HEADER = `// src/shared/skill-fallbacks.generated.ts
// GENERATED FILE — do not edit. Regenerate with:
//   ${GEN_CMD}
// \`npm run plugin:check\` fails when this file and the SKILL.md bodies disagree.
//
// The body of every \`T1BLOCK\` that ships, keyed \`<moduleId> :: <blockName>\`.
// shared/skill-block.ts consults it when a module's SKILL.md cannot be read, so
// a gate whose prose file is missing from the install still refuses IN WORDS.
//
// DO NOT "simplify" this away by deleting the table and trusting the SKILL.md
// read. That read is rooted at \`pluginRoot()\`, an environment-supplied path
// that never refuses an unverified root; this module is resolved by Node
// relative to the file that imports it, so it is reachable on precisely the
// torn install the fallback exists for. Deleting it turns a drift bug into a
// silent-deny bug, and no build-time check can catch that, because the failure
// is in the environment and not in the tree.
`;

export function renderModule(table: FallbackTable): string {
  const keys = Object.keys(table).sort();
  const lines = keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(table[key])},`);
  return `${HEADER}
export const SKILL_FALLBACKS: Readonly<Record<string, string>> = {
${lines.join('\n')}
};
`;
}

/** Keys whose body got shorter, plus keys that disappeared entirely. */
export function shrinkages(
  previous: FallbackTable,
  next: FallbackTable,
): Array<{ key: string; from: number; to: number }> {
  const out: Array<{ key: string; from: number; to: number }> = [];
  for (const [key, before] of Object.entries(previous)) {
    const after = next[key];
    if (after === undefined) { out.push({ key, from: before.length, to: 0 }); continue; }
    if (after.length < before.length) out.push({ key, from: before.length, to: after.length });
  }
  return out;
}

/**
 * The table as it stands on disk, parsed out of the emitted module WITHOUT
 * importing it — importing would pull in whatever the file currently says
 * through the module cache, and would fail outright when the file is absent
 * (which is exactly when this command must still run).
 */
export function readCommitted(repoRoot: string = REPO_ROOT): FallbackTable | null {
  let text: string;
  try { text = fs.readFileSync(path.join(repoRoot, OUT_REL), 'utf8'); } catch { return null; }
  const open = text.indexOf('{\n');
  const close = text.lastIndexOf('};');
  if (open === -1 || close === -1) return null;
  const out: Record<string, string> = {};
  for (const line of text.slice(open + 1, close).split('\n')) {
    const match = /^ {2}("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),$/.exec(line);
    if (!match) continue;
    out[JSON.parse(match[1]!) as string] = JSON.parse(match[2]!) as string;
  }
  return out;
}

export interface MainOptions {
  /** Overridden by the CLI's own tests, which drive it over a synthetic tree —
   *  the exit codes below are the contract `plugin:check` depends on, and the
   *  only honest way to prove they fire is to make them fire. */
  readonly repoRoot?: string;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
}

export function main(argv: readonly string[] = process.argv.slice(2), options: MainOptions = {}): number {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  const check = argv.includes('--check');
  const allowShrink = argv.includes('--allow-shrink');
  const table = collectFallbacks(repoRoot);
  const rendered = renderModule(table);
  const outPath = path.join(repoRoot, OUT_REL);
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;

  if (check) {
    if (current === rendered) {
      out(`fallbacks:check: ${Object.keys(table).length} blocks, up to date\n`);
      return 0;
    }
    err(
      `fallbacks:check: ${OUT_REL} is STALE — a T1BLOCK changed and the generated fallback did not.\n`
      + 'A torn install would render the OLD wording of that gate while the shipped SKILL.md renders the new one.\n'
      + `Run: ${GEN_CMD}\n`,
    );
    return 1;
  }

  const previous = readCommitted(repoRoot);
  if (previous && !allowShrink) {
    const lost = shrinkages(previous, table);
    if (lost.length > 0) {
      err(
        `fallbacks:gen: REFUSING to shrink ${lost.length} fallback(s).\n`
        + 'A shorter fallback silently deletes remedy text from the path that renders on a torn install, and a\n'
        + 'parity test comparing the two copies cannot see it, because both copies moved together. Read the block,\n'
        + `decide the text is genuinely better shorter, then re-run with --allow-shrink:\n${
          lost.map((s) => `  ${s.key}: ${s.from} -> ${s.to}${s.to === 0 ? ' chars (block REMOVED)' : ' chars'}`).join('\n')}\n`,
      );
      return 1;
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rendered, 'utf8');
  const verb = current === rendered ? 'unchanged' : 'wrote';
  out(`fallbacks:gen: ${verb} ${OUT_REL} (${Object.keys(table).length} blocks)\n`);
  return 0;
}

if (require.main === module) process.exit(main());
