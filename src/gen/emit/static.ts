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
const STATIC_TEXT_FILES = [
  'README.md',
  'ref.md',
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
  run.json('package.json', {
    name: NAME,
    version: pluginVersion(sourceRoot),
    private: true,
    type: 'commonjs',
    description: 'Generated Traffic One plugin runtime.',
    engines: { node: pluginNodeEngine(sourceRoot) },
  });
}
