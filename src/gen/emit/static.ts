// Static plugin-root files that are part of the installable plugin but are not
// gathered from src/modules descriptors.

import * as fs from 'fs';
import * as path from 'path';

import { NAME, pluginVersion } from '../../config/plugin-identity';
import type { GenRun } from '../lib/run';

// Root docs copied verbatim. The repo-root AGENTS.md/CLAUDE.md are the
// MAINTAINER guide and deliberately NOT shipped — the installed plugin's
// AGENTS.md/CLAUDE.md (end-user instructions every host session loads) are
// emitted from src/gen/static/plugin-instructions.md instead, so a session
// inside the source repo never reads end-user project conventions.
const STATIC_TEXT_FILES = [
  'README.md',
  'ref.md',
] as const;

const PLUGIN_INSTRUCTIONS_SOURCE = path.join('src', 'gen', 'static', 'plugin-instructions.md');

// The auth gate ships as the generated .cursor/rules/auth-required.mdc kernel
// rule (from rules/common/auth-gate.md); no separate static seed — two
// always-on copies of the same guidance double the per-request cost on Cursor.

export function emitStaticPluginFiles(run: GenRun): void {
  for (const rel of STATIC_TEXT_FILES) {
    run.file(rel, fs.readFileSync(path.join(run.sourceRoot, rel), 'utf8'));
  }
  const pluginInstructions = fs.readFileSync(path.join(run.sourceRoot, PLUGIN_INSTRUCTIONS_SOURCE), 'utf8');
  run.file('AGENTS.md', pluginInstructions);
  run.file('CLAUDE.md', pluginInstructions);
  run.file(path.join('skills', '.gitkeep'), '');
  run.json('package.json', {
    name: NAME,
    version: pluginVersion(run.sourceRoot),
    private: true,
    type: 'commonjs',
    description: 'Generated Traffic One plugin runtime.',
  });
}
