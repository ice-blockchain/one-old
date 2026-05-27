'use strict';

const fs = require('fs');
const path = require('path');

// ── Graph preview ─────────────────────────────────────────────────────────────
// Compact (~500 token) summary of the codebase graph that subagents see in
// their SessionStart bundle. They scope file reads from this list instead of
// having to do a full Read of the graph artefact first.
const GRAPH_PREVIEW_MAX_BYTES = 2048;
const GRAPH_PREVIEW_MAX_MODULES = 30;

function generateGraphPreview(cwd, provider) {
  const lines = ['## Codebase graph preview', ''];
  if (provider === 'graphify') {
    const reportPath = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
    if (!fs.existsSync(reportPath)) return null;
    let text;
    try { text = fs.readFileSync(reportPath, 'utf8'); } catch { return null; }
    const modules = [];
    const headingRe = /^##\s+(.+?)\s*$/gm;
    let m;
    while ((m = headingRe.exec(text)) !== null) modules.push(m[1]);
    lines.push(`Provider: graphify · ${modules.length} top-level section(s):`);
    for (const name of modules.slice(0, GRAPH_PREVIEW_MAX_MODULES)) lines.push(`- ${name}`);
    if (modules.length > GRAPH_PREVIEW_MAX_MODULES) {
      lines.push(`- … +${modules.length - GRAPH_PREVIEW_MAX_MODULES} more`);
    }
    lines.push('');
    lines.push('Read `graphify-out/GRAPH_REPORT.md` for module-specific scoping.');
  } else if (provider === 'gitnexus') {
    const gnDir = path.join(cwd, '.gitnexus');
    if (!fs.existsSync(gnDir)) return null;
    const indexPath = path.join(gnDir, 'index.json');
    let listed = false;
    if (fs.existsSync(indexPath)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const modules = Array.isArray(idx.modules)
          ? idx.modules.slice(0, GRAPH_PREVIEW_MAX_MODULES)
          : [];
        if (modules.length > 0) {
          lines.push(`Provider: gitnexus · ${modules.length} top-level module(s):`);
          for (const mod of modules) lines.push(`- ${mod.name || mod.path || String(mod)}`);
          listed = true;
        }
      } catch {
        // fall through to non-listed branch
      }
    }
    if (!listed) {
      lines.push(`Provider: gitnexus · graph available at \`.gitnexus/\``);
    }
    lines.push('');
    lines.push('Read `.gitnexus/` artefacts for module-specific scoping.');
  } else {
    return null;
  }
  let body = lines.join('\n') + '\n';
  if (body.length > GRAPH_PREVIEW_MAX_BYTES) {
    body = body.slice(0, GRAPH_PREVIEW_MAX_BYTES - 80)
      + '\n…[truncated; read the full graph artefact for the complete listing]\n';
  }
  return body;
}

module.exports = { generateGraphPreview };
