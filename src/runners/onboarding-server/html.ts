// src/runners/onboarding-server/html.ts
// Serve the single self-contained wizard page. The HTML is authored as a sibling
// wizard.html (copied next to the compiled runner via RUNNER_ASSETS), read once
// and cached. The per-session token is injected so the page's fetch() calls can
// authenticate even if the URL query is later lost.

import * as fs from 'fs';
import * as path from 'path';

let template: string | null = null;

function load(): string {
  if (template == null) {
    template = fs.readFileSync(path.join(__dirname, 'wizard.html'), 'utf8');
  }
  return template;
}

export function wizardHtml(token: string): string {
  // Placeholder must NOT be a valid JS identifier substring — a global replace
  // would otherwise mangle `window.__T1_TOKEN__` into `window.<token>` (a syntax
  // error). `%%T1_TOKEN%%` only ever appears inside a string literal.
  return load().split('%%T1_TOKEN%%').join(token);
}
