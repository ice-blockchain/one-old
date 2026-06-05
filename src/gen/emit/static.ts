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

const STATIC_SOURCE_FILES: ReadonlyArray<{ sourceRel: string; outputRel: string }> = [
  {
    sourceRel: path.join('src', 'gen', 'static', '00-auth-required.mdc'),
    outputRel: path.join('.cursor', 'rules', '00-auth-required.mdc'),
  },
];

export function emitStaticPluginFiles(run: GenRun): void {
  for (const rel of STATIC_TEXT_FILES) {
    run.file(rel, fs.readFileSync(path.join(run.sourceRoot, rel), 'utf8'));
  }
  for (const file of STATIC_SOURCE_FILES) {
    run.file(file.outputRel, fs.readFileSync(path.join(run.sourceRoot, file.sourceRel), 'utf8'));
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
