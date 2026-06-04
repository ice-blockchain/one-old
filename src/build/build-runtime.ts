// src/build/build-runtime.ts
// The cutover runtime build: compile src/ → <outDir> (the nested core/shared/
// modules/adapters/hooks/runners tree), copy the module.json descriptors, and
// write the legacy-named .cjs SHIMS at the root so the host configs + skills +
// spawns keep invoking the SAME paths they do today (scripts/hook-runtime.cjs,
// scripts/traffic-one-auth.cjs, …). Each shim is a 1-liner that require()s the
// real compiled entry and calls its main() — needed because the entry's own
// `require.main === module` guard does not fire when it is require()d.
//
// This script NEVER targets scripts/ implicitly — the caller passes an explicit
// outDir. At the manual cutover the user deletes the legacy hand-authored
// scripts/** first, then runs this with outDir=scripts, golden-diffs, and
// cross-host verifies. `npm run smoke` exercises the whole thing into a temp dir.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { copyModuleDescriptors } from './copy-module-assets';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Legacy CLI path → compiled entry it forwards to. toolchain is a library (no
// CLI), sync-cursor is absorbed by `npm run gen`, and lighthouse-runner.mjs is
// ESM emitted separately — none get a CJS shim here.
export const SHIMS: Readonly<Record<string, string>> = {
  'hook-runtime.cjs': './hooks/claude-entry.js',
  'cursor-hook-runtime.cjs': './hooks/cursor-entry.js',
  'traffic-one-auth.cjs': './runners/auth/index.js',
  'doctor.cjs': './runners/doctor/index.js',
  'security-check-runner.cjs': './runners/security-check/index.js',
  'token-report.cjs': './runners/token-report/index.js',
  'one-mcp-report.cjs': './runners/one-mcp-report/index.js',
  'gitnexus-runner.cjs': './runners/gitnexus/index.js',
  'graphify-runner.cjs': './runners/graphify/index.js',
  'onboarding-server.cjs': './runners/onboarding-server/index.js',
};

function shimSource(target: string): string {
  return [
    "'use strict';",
    '// GENERATED cutover shim — preserves the legacy CLI path; the compiled runtime',
    '// lives in the nested tree. Regenerate via src/build/build-runtime.ts.',
    `const m = require('${target}');`,
    "const r = typeof m.main === 'function' ? m.main() : undefined;",
    "if (typeof r === 'number') process.exitCode = r;",
    "else if (r && typeof r.catch === 'function') r.catch(() => {});",
    '',
  ].join('\n');
}

export function writeShims(outDir: string): string[] {
  const written: string[] = [];
  for (const [name, target] of Object.entries(SHIMS)) {
    fs.writeFileSync(path.join(outDir, name), shimSource(target), 'utf8');
    written.push(name);
  }
  return written.sort();
}

// Non-.ts runtime assets a runner reads relative to its own __dirname (tsc only
// emits compiled .ts, so these must be copied alongside). Currently just the
// toolchain spec; add here if a runner gains a sibling data file.
const RUNNER_ASSETS: ReadonlyArray<string> = [
  path.join('runners', 'toolchain', 'toolchain-versions.json'),
  path.join('runners', 'onboarding-server', 'wizard.html'),
];

export function copyRunnerAssets(outDir: string): string[] {
  const copied: string[] = [];
  for (const rel of RUNNER_ASSETS) {
    const src = path.join(REPO_ROOT, 'src', rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(rel);
  }
  return copied.sort();
}

// Lighthouse is the lone ESM runner. The rest of the engine is CommonJS with
// classic Node resolution, which cannot emit the explicit `.mjs` import
// specifiers ESM needs — so lighthouse compiles via its own NodeNext config:
//   src/runners/lighthouse/index.mts → <outDir>/runners/lighthouse/index.mjs (ESM)
//   src/runners/lighthouse/lib.ts     → <outDir>/runners/lighthouse/lib.js  (CJS)
// then a 1-line ESM entry shim at the legacy path <outDir>/lighthouse-runner.mjs
// keeps `node scripts/lighthouse-runner.mjs …` working (parallels the .cjs shims).
export function buildLighthouse(outDir: string): void {
  const lh = spawnSync('npx', ['tsc', '-p', 'tsconfig.lighthouse.build.json', '--outDir', path.join(outDir, 'runners', 'lighthouse')], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180000,
  });
  if (lh.status !== 0) {
    throw new Error(`lighthouse tsc failed:\n${lh.stdout || ''}${lh.stderr || ''}`);
  }
  fs.writeFileSync(path.join(outDir, 'lighthouse-runner.mjs'), "import './runners/lighthouse/index.mjs';\n", 'utf8');
}

export interface BuildResult { modulesCopied: number; assetsCopied: string[]; shimsWritten: string[]; lighthouseEmitted: boolean; }

export function buildRuntime(outDir: string): BuildResult {
  const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', outDir], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180000,
  });
  if (tsc.status !== 0) {
    throw new Error(`tsc failed:\n${tsc.stdout || ''}${tsc.stderr || ''}`);
  }
  const { copied } = copyModuleDescriptors(path.join(REPO_ROOT, 'src', 'modules'), path.join(outDir, 'modules'));
  const assetsCopied = copyRunnerAssets(outDir);
  const shimsWritten = writeShims(outDir);
  buildLighthouse(outDir);
  return { modulesCopied: copied.length, assetsCopied, shimsWritten, lighthouseEmitted: true };
}

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    process.stderr.write('Usage: tsx src/build/build-runtime.ts <outDir>\n(At cutover: delete legacy scripts/** first, then pass outDir=scripts.)\n');
    process.exit(1);
  }
  const result = buildRuntime(path.resolve(outDir));
  process.stdout.write(`build-runtime: compiled to ${outDir}; ${result.modulesCopied} module descriptors; ${result.assetsCopied.length} runner assets; shims: ${result.shimsWritten.join(', ')}; lighthouse: ${result.lighthouseEmitted ? 'lighthouse-runner.mjs (ESM)' : 'skipped'}\n`);
}
