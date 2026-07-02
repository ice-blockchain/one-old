// src/test-environment/core/fixtures.ts
// Materialize a project fixture into a temp dir. Every fixture writes a real
// project marker (package.json + .git) so src/ path resolution treats the temp
// dir as a genuine project root — NOT the plugin authoring root and NOT a bare
// directory. Static skeletons live under ../fixtures and are copied in.

import * as fs from 'fs';
import * as path from 'path';

import type { FixtureKind } from './types';

const FIXTURE_SRC_DIR = path.resolve(__dirname, '..', 'fixtures');

function writeProjectMarkers(dir: string, name: string): void {
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(pkg, JSON.stringify({ name, version: '0.0.0', private: true }, null, 2) + '\n', 'utf8');
  }
  // A .git directory makes findUp()/projectRoot() stop here. We avoid a real
  // `git init` (slow, needs git) — an empty marker dir is enough for path logic.
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) fs.mkdirSync(gitDir, { recursive: true });
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

// Returns the project root (== dir).
export function materializeFixture(dir: string, kind: FixtureKind): string {
  fs.mkdirSync(dir, { recursive: true });

  switch (kind) {
    case 'empty':
      // A brand-new project: just enough to be a real root for new-project flows.
      writeProjectMarkers(dir, 'test-new-project');
      break;
    case 'react-vite': {
      const skeleton = path.join(FIXTURE_SRC_DIR, 'react-vite');
      if (fs.existsSync(skeleton)) copyDir(skeleton, dir);
      writeProjectMarkers(dir, 'test-react-vite');
      break;
    }
    case 'existing-react-vite': {
      const skeleton = path.join(FIXTURE_SRC_DIR, 'existing-react-vite');
      if (fs.existsSync(skeleton)) copyDir(skeleton, dir);
      writeProjectMarkers(dir, 'existing-react-vite');
      break;
    }
    case 'existing-node-api': {
      const skeleton = path.join(FIXTURE_SRC_DIR, 'existing-node-api');
      if (fs.existsSync(skeleton)) copyDir(skeleton, dir);
      writeProjectMarkers(dir, 'existing-node-api');
      break;
    }
  }
  return dir;
}
