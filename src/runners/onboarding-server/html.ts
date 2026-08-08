// src/runners/onboarding-server/html.ts
// Serve the self-contained onboarding pages. Each is authored as a sibling .html
// (copied next to the compiled runner via RUNNER_ASSETS), read once and cached.
// Per-session values (port, dashboard base) are injected via %%…%% placeholders.
// `/` serves the redirect page (forwards to the dashboard); `/local` serves the
// full local fallback wizard.
//
// The session TOKEN is deliberately not injectable here. Both pages are served on
// token-free public routes (server.ts publicPath), so a token in the body is a
// token handed to any unauthenticated loopback caller — who could then drive the
// token-protected /state and /answer routes. Each page reads the token from its
// own URL query instead; keeping the substitution out of this module means a new
// public page cannot reintroduce the leak by copying an existing call site.

import * as fs from 'fs';
import * as path from 'path';

const cache: Record<string, string> = {};

function load(file: string): string {
  if (cache[file] == null) {
    cache[file] = fs.readFileSync(path.join(__dirname, file), 'utf8');
  }
  return cache[file];
}

// Placeholders must NOT be valid JS identifier substrings — a global replace would
// otherwise mangle e.g. `window.__T1_TOKEN__`. The `%%…%%` forms only ever appear
// inside string literals.
function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(key).join(value);
  }
  return out;
}

export function wizardHtml(): string {
  return load('wizard.html');
}

export function redirectHtml(port: number, dashboardBase: string): string {
  return fill(load('redirect.html'), {
    '%%T1_PORT%%': String(port),
    '%%T1_DASHBOARD%%': dashboardBase,
  });
}
