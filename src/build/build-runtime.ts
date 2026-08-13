// src/build/build-runtime.ts
// Runtime build: compile src/ -> <outDir> (normally dist/scripts, the nested
// core/shared/modules/adapters/hooks/runners tree), copy module descriptors, and
// write the legacy-named .cjs SHIMS at the output root so host configs + skills
// + spawns keep invoking scripts/hook-runtime.cjs and other supported runners
// relative to the generated plugin root. Each shim is a 1-liner that require()s the
// real compiled entry and calls its main() - needed because the entry's own
// `require.main === module` guard does not fire when it is require()d.
//
// This script NEVER targets an output implicitly - the caller passes an
// explicit outDir. `npm run smoke` exercises the whole thing into a temp dir.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { copyModuleDescriptors } from './copy-module-assets';
import { buildProvenance } from '../gen/lib/build-provenance';
import { nodeFloorGuardSource } from '../shared/node-floor';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Legacy CLI path → compiled entry it forwards to. toolchain is a library (no
// CLI), sync-cursor is absorbed by `npm run gen`, and lighthouse-runner.mjs is
// ESM emitted separately — none get a CJS shim here.
export const SHIMS: Readonly<Record<string, string>> = {
  'hook-runtime.cjs': './hooks/claude-entry.js',
  'cursor-hook-runtime.cjs': './hooks/cursor-entry.js',
  'copilot-hook-runtime.cjs': './hooks/copilot-entry.js',
  'opencode-hook-runtime.cjs': './hooks/opencode-entry.js',
  'kilo-hook-runtime.cjs': './hooks/kilo-entry.js',
  'windsurf-hook-runtime.cjs': './hooks/windsurf-entry.js',
  'devin-hook-runtime.cjs': './hooks/devin-entry.js',
  'opencode-host.cjs': './runners/opencode-host/index.js',
  'kilo-host.cjs': './runners/kilo-host/index.js',
  'windsurf-host.cjs': './runners/windsurf-host/index.js',
  'doctor.cjs': './runners/doctor/index.js',
  'security-check-runner.cjs': './runners/security-check/index.js',
  'token-report.cjs': './runners/token-report/index.js',
  'one-mcp-report.cjs': './runners/one-mcp-report/index.js',
  'one-mcp-host.cjs': './runners/one-mcp-host/index.js',
  'traffic-one-cleanup.cjs': './runners/traffic-one-cleanup/index.js',
  'traffic-one-reset.cjs': './runners/traffic-one-reset/index.js',
  'traffic-one-uninstall.cjs': './runners/traffic-one-uninstall/index.js',
  'run-status.cjs': './runners/run-status/index.js',
  'qa-evidence-runner.cjs': './runners/qa-evidence/index.js',
  'gitnexus-runner.cjs': './runners/gitnexus/index.js',
  'graphify-runner.cjs': './runners/graphify/index.js',
  'opencode-runner.cjs': './runners/opencode/index.js',
  'opencode-mcp.cjs': './runners/opencode-mcp/index.js',
  'onboarding-toolchain-runner.cjs': './runners/onboarding-toolchain/index.js',
  'onboarding-server.cjs': './runners/onboarding-server/index.js',
  'onboarding-wait.cjs': './runners/onboarding-wait/index.js',
  'model-gate.cjs': './runners/model-gate/index.js',
  'one-mcp-sync.cjs': './runners/one-mcp-sync/index.js',
};

// This shim is the FIRST plugin code every host-launched hook executes: the
// hook command (gen/sources/hooks.ts) requires scripts/<name>.cjs, which is this
// file, which then requires the compiled tree. tsc emits that tree at ES2022, so
// a runtime that cannot parse it dies with a SyntaxError naming a line in a
// generated file — which is exactly the "fails however it fails" case. The node
// floor guard goes here, above that require and written in ES5, so the cause is
// named first. It warns and continues (see shared/node-floor.ts): exiting early
// would produce no stdout, which hosts read as "no verdict" — fail-open with
// every gate silently off.
function shimSource(target: string): string {
  return [
    "'use strict';",
    '// GENERATED cutover shim — preserves the legacy CLI path; the compiled runtime',
    '// lives in the nested tree. Regenerate via src/build/build-runtime.ts.',
    nodeFloorGuardSource(),
    `const m = require('${target}');`,
    "const r = typeof m.main === 'function' ? m.main() : undefined;",
    "if (typeof r === 'number') process.exitCode = r;",
    "else if (r && typeof r.then === 'function') r.then((code) => { if (typeof code === 'number') process.exitCode = code; }).catch(() => {});",
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
  path.join('runners', 'onboarding-server', 'redirect.html'),
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
// keeps `node scripts/lighthouse-runner.mjs ...` working (parallels the .cjs shims).
export function buildLighthouse(outDir: string): void {
  const lh = spawnSync('npx', ['tsc', '-p', 'tsconfig.lighthouse.build.json', '--outDir', path.join(outDir, 'runners', 'lighthouse')], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180000,
  });
  if (lh.status !== 0) {
    throw new Error(`lighthouse tsc failed:\n${lh.stdout || ''}${lh.stderr || ''}`);
  }
  fs.writeFileSync(path.join(outDir, 'lighthouse-runner.mjs'), "import './runners/lighthouse/index.mjs';\n", 'utf8');
}

export interface BuildResult {
  // Distinct module-id count (NOT a file count — see copy-module-assets.ts's
  // CopyResult doc: a module shipping N skill files used to be counted as N
  // modules).
  modulesCopied: number;
  moduleIds: ReadonlySet<string>;
  assetsCopied: string[];
  shimsWritten: string[];
  lighthouseEmitted: boolean;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// Resolve existing ancestors before appending missing path segments. This keeps
// a symlink placed inside an apparently safe temp path from redirecting cleanup
// to an unrelated directory.
function canonicalPath(target: string): string {
  let existing = path.resolve(target);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const realExisting = fs.realpathSync.native(existing);
  return path.resolve(realExisting, ...suffix);
}

/** Return the canonical output path or reject it before any destructive write. */
export function assertSafeRuntimeOutput(outDir: string): string {
  const candidate = canonicalPath(outDir);
  // Deliberately do not follow a dist/scripts symlink here: an owned path that
  // redirects outside the real repository must be rejected, not blessed.
  const generatedScripts = path.join(fs.realpathSync.native(REPO_ROOT), 'dist', 'scripts');
  if (isWithin(generatedScripts, candidate)) return candidate;

  const tempRoot = canonicalPath(os.tmpdir());
  if (isWithin(tempRoot, candidate) && candidate !== tempRoot) {
    const firstSegment = path.relative(tempRoot, candidate).split(path.sep)[0]?.toLowerCase() ?? '';
    if (firstSegment.startsWith('t1-') || firstSegment.startsWith('traffic-one-')) return candidate;
  }

  throw new Error(`refusing to clean unsafe runtime output directory: ${candidate}`);
}

export function buildRuntime(outDir: string): BuildResult {
  const resolvedOutDir = assertSafeRuntimeOutput(outDir);
  // TypeScript never removes outputs whose source files were deleted. Rebuild
  // the complete scripts tree so no retired module or shim can survive an
  // incremental build merely because its old JavaScript file already exists.
  fs.rmSync(resolvedOutDir, { recursive: true, force: true });
  fs.mkdirSync(resolvedOutDir, { recursive: true });
  const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', resolvedOutDir], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180000,
  });
  if (tsc.status !== 0) {
    throw new Error(`tsc failed:\n${tsc.stdout || ''}${tsc.stderr || ''}`);
  }
  const { moduleIds } = copyModuleDescriptors(path.join(REPO_ROOT, 'src', 'modules'), path.join(resolvedOutDir, 'modules'));
  const assetsCopied = copyRunnerAssets(resolvedOutDir);
  const shimsWritten = writeShims(resolvedOutDir);
  buildLighthouse(resolvedOutDir);
  // Runtime-subtree half of the build-identity stamp (see
  // ../gen/lib/build-provenance.ts) — written here so dist/scripts/ carries
  // its own copy of the same identity dist/ gets from `npm run gen`.
  fs.writeFileSync(
    path.join(resolvedOutDir, 'build-provenance.json'),
    `${JSON.stringify(buildProvenance(REPO_ROOT), null, 2)}\n`,
    'utf8',
  );
  return { modulesCopied: moduleIds.size, moduleIds, assetsCopied, shimsWritten, lighthouseEmitted: true };
}

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    process.stderr.write('Usage: tsx src/build/build-runtime.ts <outDir>\n(Default package script passes outDir=dist/scripts.)\n');
    process.exit(1);
  }
  const result = buildRuntime(path.resolve(outDir));
  process.stdout.write(`build-runtime: compiled to ${outDir}; ${result.modulesCopied} module descriptors; ${result.assetsCopied.length} runner assets; shims: ${result.shimsWritten.join(', ')}; lighthouse: ${result.lighthouseEmitted ? 'lighthouse-runner.mjs (ESM)' : 'skipped'}\n`);
}
