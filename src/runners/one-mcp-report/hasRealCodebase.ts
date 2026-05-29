// src/runners/one-mcp-report/hasRealCodebase.ts
// True when the cwd looks like a real project (not a snippet/example/single
// file). Ported 1:1 from one-mcp-report/hasRealCodebase.cjs.

import * as fs from 'fs';
import * as path from 'path';

export function hasRealCodebase(cwd: string): boolean {
  const directMarkers = [
    'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml',
    'pom.xml', 'build.gradle', 'pubspec.yaml', 'Package.swift',
  ];
  if (directMarkers.some((name) => fs.existsSync(path.join(cwd, name)))) return true;
  const workspaceDirs = ['apps', 'packages', 'src', 'app', 'pages', 'supabase'];
  return workspaceDirs.some((name) => fs.existsSync(path.join(cwd, name)));
}
