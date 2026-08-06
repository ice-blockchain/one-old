// src/test-environment/core/fixtures.ts
// Materialize a project fixture into a temp dir. Every fixture writes a real
// project marker (package.json + .git) so src/ path resolution treats the temp
// dir as a genuine project root — NOT the plugin authoring root and NOT a bare
// directory. Static skeletons live under ../fixtures and are copied in.

import * as fs from 'fs';
import * as path from 'path';

import type { FixtureKind } from './types';

const FIXTURE_SRC_DIR = path.resolve(__dirname, '..', 'fixtures');

function writeProjectMarkers(dir: string, name: string, opts: { git?: boolean } = {}): void {
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(pkg, JSON.stringify({ name, version: '0.0.0', private: true }, null, 2) + '\n', 'utf8');
  }
  // A .git directory makes findUp()/projectRoot() stop here. We avoid a real
  // `git init` (slow, needs git) — an empty marker dir is enough for path logic.
  // Fixtures whose case needs real diff evidence opt out and let the run-sim
  // driver create an actual repository instead.
  if (opts.git === false) return;
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) fs.mkdirSync(gitDir, { recursive: true });
}

/**
 * The e2e/unit-runner files `testerOutputs()` hands senior-tester for every
 * web-surface profile, planted as if the repo had always had them.
 *
 * Written from here rather than shipped under ../fixtures because the root
 * tsconfig includes `src/**\/*.ts`: three fixture files importing
 * `@playwright/test` and `vitest/config` break `npm run typecheck` for the whole
 * repo. (The existing React fixture only gets away with real source files
 * because `.tsx` is outside that include.)
 *
 * They have to pre-exist at all because these three paths are the difference
 * between a `nonvisual` case and none: they are unconditional tester scaffolds
 * for a web profile, and a repo adopting Playwright for the FIRST time inside
 * the run puts new `.ts` files in the baseline diff, which raises the impact to
 * `behavioral`. A project that already owns its test infrastructure is the
 * normal case; adopting a test runner is a different change shape.
 */
function writeWebTestInfrastructure(dir: string): void {
  const files: Record<string, string> = {
    'vitest.config.ts': [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      "  test: { environment: 'jsdom', globals: true },",
      '});',
      '',
    ].join('\n'),
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      "  testDir: './tests/e2e',",
      "  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4321' },",
      '});',
      '',
    ].join('\n'),
    'tests/e2e/smoke.spec.ts': [
      "import { expect, test } from '@playwright/test';",
      '',
      "test('home renders its heading', async ({ page }) => {",
      "  await page.goto('/');",
      "  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();",
      '});',
      '',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
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
    case 'empty-git':
      // Same, minus the fake `.git` marker: run-sim replaces it with a REAL
      // repository so captureArchitectureBaseline yields kind 'git-head'. An
      // empty `.git` directory would make the driver's init step delete-then-
      // recreate for no reason, and a half-real repo is the one dangerous state
      // (baselinePathSet throws on a git dir with no readable tree).
      writeProjectMarkers(dir, 'test-new-project', { git: false });
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
    case 'existing-go-api': {
      // A real Go project that never met Traffic One: no .traffic-one, no
      // .golangci.yml, no generated anything. That is what lets it prove
      // scaffold ABSENCE on existing-codebase mode — a project seeded from a
      // greenfield run would already carry the configs phase 1 wrote.
      const skeleton = path.join(FIXTURE_SRC_DIR, 'existing-go-api');
      if (fs.existsSync(skeleton)) copyDir(skeleton, dir);
      writeProjectMarkers(dir, 'existing-go-api', { git: false });
      break;
    }
    // A Go binary that serves its own browser bundle from `web/`. The ONLY
    // fixture whose capability profile has a web surface AND a root toolchain
    // this machine can actually execute, which is what makes a `nonvisual`
    // contract reachable: that impact requires `stack-build` to genuinely pass
    // (validateQaReportV2 refuses a justified not-applicable for it alone), and
    // an npm-shaped web fixture with no node_modules can only report "declared
    // but its binary is absent". Deliberately ships no root package.json scripts
    // so `resolveStackCommand` falls through to `go.mod`, the toolchain
    // AGENTS.md already requires for this tier.
    case 'existing-go-web': {
      const skeleton = path.join(FIXTURE_SRC_DIR, 'existing-go-web');
      if (fs.existsSync(skeleton)) copyDir(skeleton, dir);
      writeWebTestInfrastructure(dir);
      writeProjectMarkers(dir, 'existing-go-web', { git: false });
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
