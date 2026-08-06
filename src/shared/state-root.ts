// src/shared/state-root.ts
// THE per-user machine state root: `$XDG_STATE_HOME/traffic-one`, or
// `~/.traffic-one` when XDG_STATE_HOME is unset. Everything Traffic One persists
// per user hangs off this one directory — one.json, one-mcp.json,
// projects/<hash>/preferences.json, bin/, toolchains/, overrides/ — and the
// expression that resolves it was INLINED in six places that agreed only by
// coincidence. Nothing made them agree: a precedence step added to one of them
// was silently ignored by the other five.
//
// A LEAF on purpose — `os` and `path`, nothing else, ever. The import direction
// is forced by the callers. shared/toolchain-paths.ts is deliberately
// dependency-light ("modules stay runner-free") while shared/state/
// traffic-one-paths.ts pulls in fsjson, host, text, core/types and config/paths,
// so the heavy module may import the light one and never the reverse; a base
// BOTH can depend on has to import less than either. Anything needing fs, a
// host or config belongs in the caller.
//
// Load-bearing beyond tidiness: the suite wrote thousands of junk project
// buckets into the maintainer's REAL ~/.traffic-one, and the fix was one line in
// src/build/test-preload.mjs pinning XDG_STATE_HOME to a per-process temp dir.
// That single pin redirects every writer ONLY because every reader consults
// XDG_STATE_HOME the same way. A caller that resolves the root by any other
// route reopens that blocker silently — the pollution lands outside the repo,
// where no assertion looks, so the suite stays green while it happens.
//
// Two spellings deliberately do NOT belong here:
//   - TRAFFIC_ONE_TOOLCHAIN_ROOT, which toolchainRoot() checks FIRST and only
//     then falls through to this base. Toolchains are venvs, npm prefixes and
//     browser binaries measured in gigabytes; the rest of the tree is kilobytes.
//     The split is the feature — XDG_STATE_HOME moves everything, the toolchain
//     knob moves only the heavy part.
//   - documentedBinDir() (shared/runner-shims.ts), which pins
//     $HOME/.traffic-one/bin and ignores XDG_STATE_HOME because ~60 places in
//     shipped prose hardcode that spelling. A deliberate divergence, not a
//     straggler to be folded in.
//
// TWO copies cannot import this and stay inlined, both for the same reason —
// they are `node -e` SOURCE for a process that runs standalone, outside the
// plugin, with no module resolution available:
//   - src/config/opencode-mcp.ts, the MCP server bootstrap the host spawns
//     before any plugin path is known (it carries a comment pointing back here);
//   - src/shared/windsurf-hook-command.ts, the launcher baked into a COMMITTED
//     `.windsurf/hooks.json`, which has to resolve on a teammate's machine.
// A precedence step added here is owed to both by hand.

import * as os from 'os';
import * as path from 'path';

// Kept exactly as the six copies read it, byte for byte, because the pin above
// depends on the READ and not just on the result: an empty XDG_STATE_HOME is
// falsy and falls through to HOME, an empty HOME falls through to os.homedir().
// Callers that need an absolute path resolve the RESULT (see machineStateDir in
// state/plugin-use.ts); resolving here would change what every other caller
// returns for a relative HOME.
export function globalTrafficOneDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
}
