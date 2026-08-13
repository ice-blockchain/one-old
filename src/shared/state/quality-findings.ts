// src/shared/state/quality-findings.ts
// Run-scoped ledger for write-time QUALITY findings that no longer interrupt
// the writer (Part of the batched-feedback contract): instead of riding a deny
// payload, warning/advisory structural and copy findings are appended here per
// role and consolidated into ONE fix-cycle document at the role's completion
// digest. Same append-ledger pattern as claim-capture.ts: best-effort, never
// throws, size-capped, and never written in the plugin's own repo.

import * as fs from 'fs';
import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { stateTimestamp } from './io';
import { readRegularFileOrThrow } from '../bounded-read';

const MAX_LEDGER_BYTES = 256 * 1024;

export interface QualityFindingEntry {
  at: string;
  role: string;
  id: string;
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  message: string;
}

export interface QualityFindingInput {
  id: string;
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  message: string;
}

function ledgerPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', String(runId), 'quality-findings.jsonl');
}

// Line numbers shift on every edit, so identity deliberately excludes them: a
// finding is "the same" when the same role gets the same message about the same
// file. Without this the ledger re-grows on each rewrite of one file and the
// consolidated document repeats itself N times.
function dedupeKey(entry: { role: string; id: string; file: string; message: string }): string {
  return `${entry.role}\0${entry.id}\0${entry.file}\0${entry.message}`;
}

function parseEntries(text: string): QualityFindingEntry[] {
  const out: QualityFindingEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.id !== 'string' || typeof parsed.file !== 'string' || typeof parsed.message !== 'string') continue;
      out.push({
        at: typeof parsed.at === 'string' ? parsed.at : '',
        role: typeof parsed.role === 'string' ? parsed.role : 'unknown',
        id: parsed.id,
        severity: parsed.severity === 'error' ? 'error' : 'warning',
        file: parsed.file,
        ...(typeof parsed.line === 'number' ? { line: parsed.line } : {}),
        message: parsed.message,
      });
    } catch {
      // skip a torn/corrupt line, keep the rest
    }
  }
  return out;
}

/** Append findings for one role, skipping ones the ledger already carries. */
export function appendQualityFindings(
  cwd: string,
  runId: string | null | undefined,
  role: string,
  findings: readonly QualityFindingInput[],
): void {
  try {
    if (isNonProjectRoot(cwd)) return;
    if (!runId || findings.length === 0) return;
    const file = ledgerPath(cwd, runId);
    let existingText = '';
    try {
      if (fs.statSync(file).size > MAX_LEDGER_BYTES) return; // cap reached — keep the early evidence
      existingText = readRegularFileOrThrow(file);
    } catch {
      // missing file → first append
    }
    const seen = new Set(parseEntries(existingText).map(dedupeKey));
    const lines: string[] = [];
    for (const finding of findings) {
      const entry: QualityFindingEntry = {
        at: stateTimestamp(),
        role,
        id: finding.id,
        severity: finding.severity,
        file: finding.file,
        ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
        message: finding.message,
      };
      const key = dedupeKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(JSON.stringify(entry));
    }
    if (lines.length === 0) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // best-effort ledger; a capture failure must never affect the gate
  }
}

/** Every accumulated finding for the run, deduped (last occurrence wins). */
export function readQualityFindings(cwd: string, runId: string): QualityFindingEntry[] {
  let text: string;
  try {
    text = readRegularFileOrThrow(ledgerPath(cwd, runId));
  } catch {
    return [];
  }
  const byKey = new Map<string, QualityFindingEntry>();
  for (const entry of parseEntries(text)) byKey.set(dedupeKey(entry), entry);
  return [...byKey.values()];
}

/**
 * Consolidate the role's accumulated findings into ONE fix-cycle document —
 * `.traffic-one/fix-cycles/<runId>/<role>-quality-findings.md` — regenerated
 * (not appended) at every completion digest so each finding surfaces exactly
 * once. Returns the project-relative path, or null when nothing accumulated.
 * Unattributed entries ride along: an interrupted resolver must not make a
 * finding vanish.
 */
export function consolidateQualityFindings(
  cwd: string,
  runId: string,
  role: string,
): string | null {
  try {
    if (isNonProjectRoot(cwd)) return null;
    if (!runId || /[\\/]/.test(runId)) return null;
    const entries = readQualityFindings(cwd, runId)
      .filter((entry) => entry.role === role || entry.role === 'main-agent' || entry.role === 'unknown')
      .sort((a, b) => (
        a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0) || a.id.localeCompare(b.id)
      ));
    if (entries.length === 0) return null;
    const rel = `.traffic-one/fix-cycles/${runId}/${role}-quality-findings.md`;
    const body = [
      `# Accumulated quality findings — ${role} — run ${runId}`,
      '',
      'These write-time findings were deliberately batched instead of interrupting each',
      'write. Apply ALL findings below in this one turn — do not stop after a slice.',
      'Findings the completion structure scan still reports as errors block the',
      'completion verdict until fixed; fix the advisory rest in the same pass.',
      '',
      ...entries.map((entry) => (
        `- ${entry.id} ${entry.file}${entry.line ? `:${entry.line}` : ''} — ${entry.message}`
      )),
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), body, 'utf8');
    return rel;
  } catch {
    return null;
  }
}
