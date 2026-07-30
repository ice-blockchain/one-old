// src/test-environment/core/run-sim/build-output.ts
// The scripted production build, and the QA scenario that exercises it.
//
// THE HONEST BOUNDARY OF THIS TIER, stated plainly: the build ARTIFACT is
// scripted (no bundler runs), but the browser EVIDENCE is real — real Chromium,
// real DOM assertions, real click steps, real console/network capture, real
// screenshots. Everything the runner measures, it measures for real.
//
// That split is deliberate. Running a true `vite build` would need a per-project
// `npm install` and a network, which is what makes 20 cases infeasible; and it
// would test Vite, not Traffic One. What Traffic One owns is the evidence
// contract, and that is exercised end to end here.
//
// The app below is small but genuinely interactive: it renders into #root,
// registers a real event listener (the runner's injected probe counts
// registrations to decide `hydrationPassed`), and stays within the viewport
// (`noHorizontalOverflow` is checked for visual contracts). None of that is
// faked — a page that only LOOKED right would fail these checks.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { CompiledArchitectureV1 } from '../../../shared/architecture-contract';
import type { VerificationContractV2 } from '../../../shared/verification-contract';

export interface QaScenarioRoute {
  route: string;
  startPath: string;
  finalPath: string;
  stableSelector: string;
  steps: Array<{ type: string; selector?: string; value?: string }>;
}

const APP_JS = [
  '(function () {',
  '  var root = document.getElementById("root");',
  '  if (!root) return;',
  '  var main = document.createElement("main");',
  '  var heading = document.createElement("h1");',
  '  heading.textContent = "Traffic One run-sim app";',
  '  var button = document.createElement("button");',
  '  button.type = "button";',
  '  button.textContent = "Toggle details";',
  '  var detail = document.createElement("p");',
  '  detail.textContent = window.location.pathname;',
  '  // A REAL listener: the runner counts registrations to decide hydration.',
  '  button.addEventListener("click", function () {',
  '    detail.hidden = !detail.hidden;',
  '  });',
  '  main.appendChild(heading);',
  '  main.appendChild(button);',
  '  main.appendChild(detail);',
  '  root.appendChild(main);',
  '})();',
  '',
].join('\n');

// Content-addressed like a real bundler, so builtAppIdentities has a stable,
// meaningful entry asset to read out of the served HTML.
function assetName(): string {
  const hash = createHash('sha256').update(APP_JS).digest('hex').slice(0, 8);
  return `app-${hash}.js`;
}

function indexHtml(asset: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>Traffic One run-sim app</title>',
    '    <style>',
    '      *, *::before, *::after { box-sizing: border-box; }',
    '      body { margin: 0; font-family: system-ui, sans-serif; }',
    '      main { max-width: 60rem; margin: 0 auto; padding: 1rem; }',
    '      h1 { font-size: 1.5rem; overflow-wrap: break-word; }',
    '    </style>',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    `    <script type="module" src="/assets/${asset}"></script>`,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Where the app's production build lands. Derived from the compiled
 * entrypoint's package root rather than hardcoded, so a profile that puts the
 * web app somewhere else keeps working.
 */
export function buildDirFor(architecture: CompiledArchitectureV1): string {
  const entry = architecture.profile.entrypoints?.[0] ?? '';
  // `apps/web/src/main.tsx` -> `apps/web`; a root-level `src/main.tsx` -> `.`
  const marker = entry.indexOf('/src/');
  const webRoot = marker > 0 ? entry.slice(0, marker) : '.';
  return webRoot === '.' ? 'dist' : `${webRoot}/dist`;
}

export function writeBuildOutput(cwd: string, buildDir: string): string {
  const asset = assetName();
  const root = path.join(cwd, buildDir);
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', asset), APP_JS, 'utf8');
  fs.writeFileSync(path.join(root, 'index.html'), indexHtml(asset), 'utf8');
  return asset;
}

// A contract route may be a pattern. The runner indexes evidence by the CONTRACT
// route but must visit a concrete URL, so a pattern needs an explicit startPath.
function concretePath(route: string): string {
  if (route === '*') return '/run-sim-not-found';
  return route
    .split('/')
    .map((segment) => (segment.startsWith(':') ? 'sample' : segment))
    .join('/');
}

/**
 * One scenario entry per route the contract says changed. Each performs a real
 * interactive step, because `actionsPassed` requires at least one — and without
 * it `hydrationPassed` is false regardless of what the page rendered.
 */
export function scenarioFor(verification: VerificationContractV2): {
  schemaVersion: 1;
  routes: QaScenarioRoute[];
} {
  const routes = verification.changedRoutes.length > 0
    ? verification.changedRoutes
    : ['/'];
  return {
    schemaVersion: 1,
    routes: routes.map((route) => {
      const startPath = concretePath(route);
      return {
        route,
        startPath,
        // The click toggles a detail element; it never navigates, so the final
        // path is the one we started on.
        finalPath: startPath,
        stableSelector: 'main',
        steps: [
          { type: 'expect-visible', selector: 'main' },
          { type: 'click', selector: 'button' },
        ],
      };
    }),
  };
}
