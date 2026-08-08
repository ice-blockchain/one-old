// Static plugin-root files that are part of the installable plugin but are not
// gathered from src/modules descriptors.

import * as fs from 'fs';
import * as path from 'path';

import { NAME, pluginNodeEngine, pluginVersion } from '../../config/plugin-identity';
import type { GenRun } from '../lib/run';

// Root docs copied verbatim. The repo-root AGENTS.md/CLAUDE.md are the
// MAINTAINER guide and deliberately NOT shipped. The installable bundle keeps
// end-user AGENTS.md/CLAUDE.md for cross-host compatibility (the Copilot
// manifest's `instructions` field points at AGENTS.md); the project context in
// end-user projects is rendered programmatically by
// shared/materialize/render-agents, never copied from these files. Current
// Codex discovers plugin hooks but does not inject a plugin-root AGENTS.md.
// Keeping the files distinct also means a session inside the source repo never
// reads end-user project conventions.
//
// The release documents below join README.md/ref.md for one reason each, and
// all of them fail the same way if they are left out: a statement the product
// makes about itself that the person running the product never receives.
//   - LICENSE: the grant. A licence the user never gets is not a licence.
//   - THIRD-PARTY-NOTICES.md: the only place that says which third-party tools
//     the product will install on the reader's machine, and under what terms —
//     one of them (GitNexus) is PolyForm Noncommercial, so the notice has real
//     consequences for a commercial reader and has to travel with the bundle.
//   - PRIVACY.md / PLATFORMS.md / KNOWN-ISSUES.md / SUPPORT.md: what leaves the
//     machine, what is supported, what is broken, and what to do about it.
//     Every one of them answers a question asked from inside an install, where
//     this repository is not present.
//
// CHANGELOG.md is deliberately ABSENT, and the reason is structural rather than
// an oversight. It is generated from git history (`npm run changelog`), so its
// entries are commit subjects written for maintainers — and a history quotes
// the vocabulary of its own past forever. __tests__/gen.test.ts scans every
// emitted `.md` for obsolete host-API identifiers, on the sound principle that
// agent-readable prose in the plugin root must not name an API that no longer
// exists; a 2026-05 commit subject saying `fork_context` trips it, correctly,
// and would keep tripping it for every future release. A record of the past and
// a statement of current behaviour cannot be the same file, so the changelog
// stays a repository artifact and the bundle ships only documents that describe
// the build the reader has.
//
// Each entry MUST exist at the source root: readSourceText below throws on a
// missing file, so `npm run gen` fails loudly rather than shipping a bundle
// with a hole in it.
const STATIC_TEXT_FILES = [
  'README.md',
  'ref.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'PRIVACY.md',
  'PLATFORMS.md',
  'KNOWN-ISSUES.md',
  'SUPPORT.md',
] as const;

const PLUGIN_INSTRUCTIONS_SOURCE = path.join('src', 'gen', 'static', 'plugin-instructions.md');

// The auth gate ships as the generated .cursor/rules/auth-required.mdc kernel
// rule (from rules/common/auth-gate.md); no separate static seed — two
// always-on copies of the same guidance double the per-request cost on Cursor.

function sourceCandidates(run: GenRun): string[] {
  return [
    run.sourceRoot,
    process.cwd(),
    path.resolve(__dirname, '..', '..', '..'),
  ];
}

function sourceRootWith(run: GenRun, relPath: string): string {
  for (const root of sourceCandidates(run)) {
    if (fs.existsSync(path.join(root, relPath))) return root;
  }
  return run.sourceRoot;
}

function readSourceText(run: GenRun, relPath: string): string {
  const candidates = sourceCandidates(run);
  for (const root of candidates) {
    try {
      return fs.readFileSync(path.join(root, relPath), 'utf8');
    } catch {
      // try next source root candidate
    }
  }
  return fs.readFileSync(path.join(run.sourceRoot, relPath), 'utf8');
}

export function emitStaticPluginFiles(run: GenRun): void {
  for (const rel of STATIC_TEXT_FILES) {
    run.file(rel, readSourceText(run, rel));
  }
  const pluginInstructions = readSourceText(run, PLUGIN_INSTRUCTIONS_SOURCE);
  run.file('AGENTS.md', pluginInstructions);
  run.file('CLAUDE.md', pluginInstructions);
  run.file(path.join('skills', '.gitkeep'), '');
  const sourceRoot = sourceRootWith(run, 'package.json');
  // `private: true` is NOT an oversight and must not be "fixed" for looking
  // inconsistent beside a licence: this bundle is distributed through host
  // plugin marketplaces (`claude`/`codex plugin marketplace add`, Cursor's
  // `/add-plugin`, `copilot plugin install`) and by the wrapper installers,
  // never by `npm publish` — nothing in this repository or its CI runs it. The
  // flag is what stops an accidental publish of a tree that was never shaped
  // to be an npm package. `license` states the terms of the code the user did
  // receive, which is a separate question from the channel it arrived on.
  run.json('package.json', {
    name: NAME,
    version: pluginVersion(sourceRoot),
    private: true,
    license: 'MIT',
    type: 'commonjs',
    description: 'Generated Traffic One plugin runtime.',
    engines: { node: pluginNodeEngine(sourceRoot) },
  });
}
