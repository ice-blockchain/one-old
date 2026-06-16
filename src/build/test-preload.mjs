// src/build/test-preload.mjs
// Loaded via `node --import` before the test suite (see package.json `test`).
// Forces the managed standalone-runtime fetcher OFF so `npm test` can NEVER hit
// the network or download a 50-200MB interpreter: any test that reaches a real
// graphify/gitnexus/opencode install path on a runtime-less machine must degrade
// to install-skipped/defer, exactly as it does in the deterministic env. Real
// onboarding does not load this preload, so the download path runs there.
//
// `??=`-style guard: a test that explicitly wants the fetcher enabled can set the
// var beforehand and this won't clobber it.
if (process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF === undefined) {
  process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF = '1';
}
