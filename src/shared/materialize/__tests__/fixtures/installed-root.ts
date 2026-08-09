// src/shared/materialize/__tests__/fixtures/installed-root.ts
// The one thing every plugin-root fixture in this suite has to do before a test
// relies on it — and, deliberately, NOT a shared builder.
//
// Why the assertion and not the builder. materializeProjectAssets refuses any
// plugin root that does not classify 'installed' (materialize.ts, via
// paths.ts classifyPluginRootLayout), and the suite-wide root pinned by
// src/build/test-preload.mjs is this SOURCE checkout — which is exactly one of
// the layouts it refuses. So a fixture that stops classifying does not fail: it
// makes every assertion downstream of it pass over a refusal that wrote nothing
// and deleted nothing. Measured at the time of writing: 65 materializeProjectAssets
// call expressions across 12 files, of which 43 sat behind a single fixture with
// no such check.
//
// A shared BUILDER was considered and declined. The builders in this suite are
// not duplicates that drifted; they differ precisely in what they omit, and each
// omission is load-bearing for the file that made it — tests/replay-corpus ships
// no `agents/` and no package.json on purpose (a plugin manifest would make
// authoring-root.ts classify the tree as the authoring repo), materialize-writer
// symlinks the real content trees and copies two real role docs, torn-plugin-root
// is parameterised by tear shape, plugin-build-freshness omits `skills-catalog`
// entirely, windsurf-assets hand-writes two rules so the mirror's own rendering
// is what is under test. Unifying them turns every omission into an option and
// every call site into a seven-field configuration object: the same information,
// relocated from the body to the argument list, with a shared failure surface
// added. The vacuity — which is the actual defect — is closed by this one
// assertion regardless, so that is what ships.

import assert from 'node:assert/strict';

import { pluginRootInfo } from '../../../paths';

/**
 * Assert the ambient plugin root really is one the writer will act on.
 *
 * Call it INSIDE the fixture, after the env vars are set and before the test
 * body runs, rather than as a separate test case: a standalone case proves the
 * fixture classified once, while a call in the builder proves it for the run
 * that is about to assert something.
 */
export function assertInstalledPluginRoot(label: string): void {
  const info = pluginRootInfo();
  assert.equal(
    info.layout,
    'installed',
    `${label}: the fixture plugin root ${info.root} (resolved from ${info.source}) classified '${info.layout}'. `
    + 'materializeProjectAssets refuses every layout but \'installed\', so the assertions after this point '
    + 'would be describing a refusal that wrote nothing and deleted nothing.',
  );
}
