'use strict';
// GENERATED cutover shim — preserves the legacy CLI path; the compiled runtime
// lives in the nested tree. Regenerate via src/build/build-runtime.ts.
const m = require('./runners/security-check/index.js');
const r = typeof m.main === 'function' ? m.main() : undefined;
if (typeof r === 'number') process.exitCode = r;
else if (r && typeof r.catch === 'function') r.catch(() => {});
