// src/shared/materialize/graph-preview.ts
// Compact (~500 token) codebase-graph summary written to
// `.traffic-one/graph-preview.md` by the gitnexus/graphify runners, so subagent
// SessionStart bundles can inline a module listing instead of forcing each
// subagent to Read the full graph artefact to scope its work. Ported 1:1 from
// scripts/hook-runtime/materialize/{generateGraphPreview,writeGraphPreview}.cjs.
// (The reader, readGraphPreview, lives in src/modules/session/session-start-lib.)

import * as fs from 'fs';
import * as path from 'path';

import { GITNEXUS_REL, GRAPHIFY_REPORT_REL } from '../codegraph';

const GRAPH_PREVIEW_MAX_BYTES = 2048;
const GRAPH_PREVIEW_MAX_MODULES = 30;

type Rec = Record<string, unknown>;

export function generateGraphPreview(cwd: string, provider: string): string | null {
  const lines = ['## Codebase graph preview', ''];
  if (provider === 'graphify') {
    const reportPath = path.join(cwd, GRAPHIFY_REPORT_REL);
    if (!fs.existsSync(reportPath)) return null;
    let text: string;
    try { text = fs.readFileSync(reportPath, 'utf8'); } catch { return null; }
    const modules: string[] = [];
    const headingRe = /^##\s+(.+?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(text)) !== null) {
      const name = m[1];
      if (typeof name === 'string') modules.push(name);
    }
    lines.push(`Provider: graphify · ${modules.length} top-level section(s):`);
    for (const name of modules.slice(0, GRAPH_PREVIEW_MAX_MODULES)) lines.push(`- ${name}`);
    if (modules.length > GRAPH_PREVIEW_MAX_MODULES) {
      lines.push(`- … +${modules.length - GRAPH_PREVIEW_MAX_MODULES} more`);
    }
    lines.push('');
    lines.push('Read `.traffic-one/graphify-out/GRAPH_REPORT.md` for module-specific scoping.');
  } else if (provider === 'gitnexus') {
    const gnDir = path.join(cwd, GITNEXUS_REL);
    if (!fs.existsSync(gnDir)) return null;
    const indexPath = path.join(gnDir, 'index.json');
    let listed = false;
    if (fs.existsSync(indexPath)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Rec;
        const rawModules = Array.isArray(idx.modules)
          ? (idx.modules as unknown[]).slice(0, GRAPH_PREVIEW_MAX_MODULES)
          : [];
        if (rawModules.length > 0) {
          lines.push(`Provider: gitnexus · ${rawModules.length} top-level module(s):`);
          for (const mod of rawModules) {
            const rec = mod && typeof mod === 'object' ? (mod as Rec) : null;
            const label = rec && typeof rec.name === 'string'
              ? rec.name
              : rec && typeof rec.path === 'string'
                ? rec.path
                : String(mod);
            lines.push(`- ${label}`);
          }
          listed = true;
        }
      } catch {
        // fall through to non-listed branch
      }
    }
    if (!listed) {
      lines.push('Provider: gitnexus · graph available at `.traffic-one/.gitnexus/`');
    }
    lines.push('');
    lines.push('Read `.traffic-one/.gitnexus/` artefacts for module-specific scoping.');
  } else {
    return null;
  }
  let body = `${lines.join('\n')}\n`;
  if (body.length > GRAPH_PREVIEW_MAX_BYTES) {
    body = `${body.slice(0, GRAPH_PREVIEW_MAX_BYTES - 80)}\n…[truncated; read the full graph artefact for the complete listing]\n`;
  }
  return body;
}

// Idempotent: writes .traffic-one/graph-preview.md when the graph artefact
// exists. Returns true on successful write, false when no graph or write fails.
export function writeGraphPreview(cwd: string, provider: string): boolean {
  const body = generateGraphPreview(cwd, provider);
  if (!body) return false;
  const dst = path.join(cwd, '.traffic-one', 'graph-preview.md');
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, body, 'utf8');
    return true;
  } catch {
    return false;
  }
}
