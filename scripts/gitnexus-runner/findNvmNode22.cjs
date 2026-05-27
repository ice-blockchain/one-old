'use strict';

const fs = require('fs');
const path = require('path');

// ── nvm-aware Node-22 binary discovery ──────────────────────────────────────
// Claude Code's hook process inherits the PATH it was launched with. Once
// the user runs `nvm alias default 22`, only NEW shells see Node 22 — the
// running Claude Code session still resolves `node` / `npm` / `gitnexus`
// against the older Node nvm folder. That's confusing for beginners who
// "did everything you told me" and still hit failures.
//
// Workaround: don't trust PATH. Glob `~/.nvm/versions/node/v22.*` directly,
// pick the highest installed v22.x.y, and use ABSOLUTE paths for node, npm,
// and gitnexus. PATH-independent. No relaunch required.
//
// Returns `{ root, node, npm, gitnexus, version }` where every value is an
// absolute path OR null when the binary doesn't exist. Returns `null` when
// no v22.* nvm install exists at all.
function findNvmNode22() {
  const home = process.env.HOME || '';
  if (!home) return null;
  const nodesRoot = path.join(home, '.nvm', 'versions', 'node');
  if (!fs.existsSync(nodesRoot)) return null;
  let candidates;
  try {
    candidates = fs.readdirSync(nodesRoot);
  } catch {
    return null;
  }
  // Match v22.x.y; pick the highest by semantic minor/patch sort.
  const v22s = candidates
    .filter((name) => /^v22\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const [, am, ap] = a.match(/^v22\.(\d+)\.(\d+)$/) || [];
      const [, bm, bp] = b.match(/^v22\.(\d+)\.(\d+)$/) || [];
      if (Number(am) !== Number(bm)) return Number(bm) - Number(am);
      return Number(bp) - Number(ap);
    });
  if (v22s.length === 0) return null;
  const version = v22s[0];
  const root = path.join(nodesRoot, version);
  const bin = path.join(root, 'bin');
  function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
  return {
    root,
    version,
    node: exists(path.join(bin, 'node')) ? path.join(bin, 'node') : null,
    npm: exists(path.join(bin, 'npm')) ? path.join(bin, 'npm') : null,
    gitnexus: exists(path.join(bin, 'gitnexus')) ? path.join(bin, 'gitnexus') : null,
  };
}

module.exports = { findNvmNode22 };
