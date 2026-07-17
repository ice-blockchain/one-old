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

// SessionStart's public MCP config sync is intentionally live in a real install.
// Keep the test suite hermetic; focused client tests inject a transport.
if (process.env.TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC === undefined) {
  process.env.TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC = '1';
}
// Reading a developer's real ~/.traffic-one/one-mcp.json would make model-tier
// and hook tests depend on whichever remote payload happened to be cached on
// that machine. Focused cache tests override this path explicitly.
if (process.env.TRAFFIC_ONE_MCP_CACHE_PATH === undefined) {
  process.env.TRAFFIC_ONE_MCP_CACHE_PATH = `/tmp/traffic-one-test-${process.pid}-one-mcp.json`;
}

// Host-registration tests inject isolated config homes directly. General hook
// tests must never append to the developer's real machine-global Codex config.
if (process.env.TRAFFIC_ONE_DISABLE_ONE_MCP_REGISTRATION === undefined) {
  process.env.TRAFFIC_ONE_DISABLE_ONE_MCP_REGISTRATION = '1';
}
