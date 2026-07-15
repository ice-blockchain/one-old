// src/runners/onboarding-server/html.ts
// Serve the self-contained onboarding pages. Each is authored as a sibling .html
// (copied next to the compiled runner via RUNNER_ASSETS), read once and cached.
// Per-session values (token, port, dashboard base) are injected via %%…%%
// placeholders so the page can authenticate / build its deep link even if the URL
// query is later lost. `/` serves the redirect page (forwards to the dashboard);
// `/local` serves the full local fallback wizard.

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

export function wizardHtml(token: string): string {
  return fill(load('wizard.html'), { '%%T1_TOKEN%%': token });
}

export function redirectHtml(token: string, port: number, dashboardBase: string): string {
  return fill(load('redirect.html'), {
    '%%T1_TOKEN%%': token,
    '%%T1_PORT%%': String(port),
    '%%T1_DASHBOARD%%': dashboardBase,
  });
}
