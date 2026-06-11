// Static plugin-root files that are part of the installable plugin but are not
// gathered from src/modules descriptors.

import * as fs from 'fs';
import * as path from 'path';

import { NAME, pluginVersion } from '../../config/plugin-identity';
import type { GenRun } from '../lib/run';

const STATIC_TEXT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'ref.md',
] as const;

// The auth gate ships as the generated .cursor/rules/auth-required.mdc kernel
// rule (from rules/common/auth-gate.md); no separate static seed — two
// always-on copies of the same guidance double the per-request cost on Cursor.

export function emitStaticPluginFiles(run: GenRun): void {
  for (const rel of STATIC_TEXT_FILES) {
    run.file(rel, fs.readFileSync(path.join(run.sourceRoot, rel), 'utf8'));
  }
  run.file(path.join('skills', '.gitkeep'), '');
  run.json('package.json', {
    name: NAME,
    version: pluginVersion(run.sourceRoot),
    private: true,
    type: 'commonjs',
    description: 'Generated Traffic One plugin runtime.',
  });
}
