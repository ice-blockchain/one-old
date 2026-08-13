// src/shared/opencode-plan/preserve.ts
// Preservation of the accepted `opencode-delegate` plan block across plan.md
// rewrites. Observed 13cl/13co/14cl: the architect rewrites plan PROSE and
// cannot reconstruct machine metadata from memory, so every rewrite without
// the block was denied (8 denies across 3 runs). Auto-fix doctrine instead:
// when a previously-accepted queue exists for the run, the write proceeds and
// the block is re-appended at the next runtime touchpoint (PLAN_READY gate,
// `--from-plan` delegation) — deny only on a first write with nothing to
// recover. The prior block survives the overwrite in a runtime-owned run
// sidecar (`runs/<runId>/opencode-plan-block.md`); the compiled queue
// (`runs/<runId>/opencode-queue.json`) is the reconstruction fallback.

import * as fs from 'fs';
import * as path from 'path';

import { readRegularFileResult, type BoundedRead } from '../bounded-read';
import { readOpenCodeQueue } from '../opencode-queue/store';
import { T1_DIR } from '../opencode-queue/types';
import { OPENCODE_PLAN_MIN_UNITS, parsePlanDelegationUnits } from '../opencode-roles/plan-units';

const START_MARKER = 'opencode-delegate:start';
const END_MARKER = 'opencode-delegate:end';

function planPath(cwd: string): string {
  return path.join(cwd, T1_DIR, 'plan.md');
}

function snapshotPath(cwd: string, runId: string): string {
  return path.join(cwd, T1_DIR, 'runs', runId, 'opencode-plan-block.md');
}

/**
 * BOUNDED (shared/bounded-read.ts), and this reader is the one the plan gate's
 * OWN bounded read hands its cue to — which is why it is here rather than
 * outside the boundary.
 *
 * `planReadinessViolations` (plan-guard/plan-readiness/index.ts) evaluates
 * `planOnDiskMissingOpenCodeBlock(projectRoot) && !restorePlanOpenCodeDelegateBlock(...)`.
 * The first reader was bounded first; on a planted `.traffic-one/plan.md` it
 * correctly answers "no block", which ADVANCES the `&&` chain into
 * `restorePlanOpenCodeDelegateBlock` — which read the same path with a bare
 * `fs.readFileSync`. MEASURED with only the first half bounded: the plan gate
 * still SIGKILLed at 12 017 ms on a FIFO and 12 085 ms on a symlink to
 * `/dev/zero`, with the planted path as the last logged read (load 7.23 → 10.07
 * of 10 cpus). Bounding one of two readers of the same path on the same
 * expression is not bounding the path; it is moving the block one call to the
 * right, and a boundary drawn by MODULE would have missed this because the
 * second reader lives under `shared/`.
 *
 * THREE STATES, not `string | null`, because the caller below writes. See
 * `restorePlanOpenCodeDelegateBlock`: absent licenses CREATING plan.md from the
 * preserved block, and unreadable must not.
 */
function readPlanText(file: string): BoundedRead {
  return readRegularFileResult(file);
}

function readTextOrNull(file: string): string | null {
  const read = readPlanText(file);
  return read.kind === 'text' ? read.text : null;
}

function isAcceptedBlock(blockText: string): boolean {
  return parsePlanDelegationUnits(blockText).length >= OPENCODE_PLAN_MIN_UNITS;
}

/**
 * The verbatim `opencode-delegate` block (marker line through marker line) —
 * only when it carries a previously-acceptable queue (>= min runnable units).
 */
export function extractOpenCodeDelegateBlock(planText: string): string | null {
  const start = planText.indexOf(START_MARKER);
  const end = planText.indexOf(END_MARKER);
  if (start < 0 || end < start) return null;
  const from = planText.lastIndexOf('\n', start) + 1;
  const endLineBreak = planText.indexOf('\n', end);
  const to = endLineBreak < 0 ? planText.length : endLineBreak;
  const block = planText.slice(from, to);
  return isAcceptedBlock(block) ? block : null;
}

// Reserialize the compiled queue back into a parseable plan block. Field
// values were parsed FROM pipe-delimited plan lines, so they cannot contain
// `|`; the defensive replaces keep a hand-edited queue.json from producing an
// unparseable line, and the accepted-block re-parse below catches the rest.
function reconstructBlockFromQueue(cwd: string, runId: string): string | null {
  const queue = readOpenCodeQueue(cwd, runId);
  if (!queue || queue.units.length === 0) return null;
  const field = (value: string): string => value.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();
  const lines = queue.units.map((unit) => {
    const fields = [`id: ${field(unit.id)}`, `role: ${field(unit.role)}`];
    if (unit.kind) fields.push(`kind: ${field(unit.kind)}`);
    fields.push(`files: ${field(unit.allowedFiles.join(','))}`);
    fields.push(`task: ${field(unit.task)}`);
    if (unit.dependsOn.length > 0) fields.push(`depends: ${field(unit.dependsOn.join(','))}`);
    return `- ${fields.join(' | ')}`;
  });
  const block = [`<!-- ${START_MARKER} -->`, ...lines, `<!-- ${END_MARKER} -->`].join('\n');
  return isAcceptedBlock(block) ? block : null;
}

/**
 * The previously-accepted queue block for this run, if any survives: the
 * write-time snapshot first (the architect's own authored block), then a
 * reconstruction from the compiled `opencode-queue.json`.
 */
export function preservedOpenCodeDelegateBlock(cwd: string, runId: string): string | null {
  if (!runId) return null;
  const snapshot = readTextOrNull(snapshotPath(cwd, runId));
  if (snapshot && isAcceptedBlock(snapshot)) return snapshot.replace(/\n+$/, '');
  return reconstructBlockFromQueue(cwd, runId);
}

/**
 * Write-time half of the auto-fix: called when an incoming plan.md write LACKS
 * the block. Snapshots the block still on disk (the overwrite would destroy
 * it) and answers whether a previously-accepted queue is durably recoverable —
 * `true` means the write may proceed and repair is guaranteed possible at the
 * next runtime touchpoint; `false` means first write, deny stands.
 */
export function preserveOpenCodeDelegateBlockForWrite(cwd: string, runId: string): boolean {
  if (!runId) return false;
  const onDisk = readTextOrNull(planPath(cwd));
  const block = onDisk ? extractOpenCodeDelegateBlock(onDisk) : null;
  if (block) {
    try {
      const file = snapshotPath(cwd, runId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${block}\n`, 'utf8');
      return true;
    } catch {
      // fall through: another preserved source may still guarantee repair
    }
  }
  return preservedOpenCodeDelegateBlock(cwd, runId) !== null;
}

// Remove a stray marker region so the re-appended block is the ONLY one the
// parser (first start marker … first end marker) can see.
function stripDelegateMarkers(planText: string): string {
  const start = planText.indexOf(START_MARKER);
  const end = planText.indexOf(END_MARKER);
  if (start < 0 && end < 0) return planText;
  if (start >= 0 && end > start) {
    const from = planText.lastIndexOf('\n', start) + 1;
    const endLineBreak = planText.indexOf('\n', end);
    const to = endLineBreak < 0 ? planText.length : endLineBreak + 1;
    return planText.slice(0, from) + planText.slice(to);
  }
  return planText
    .split('\n')
    .filter((line) => !line.includes(START_MARKER) && !line.includes(END_MARKER))
    .join('\n');
}

/**
 * Repair half of the auto-fix, run at the next runtime touchpoint (PLAN_READY
 * completion gate, `--from-plan` delegation): when plan.md on disk lost the
 * block, re-append the preserved queue. Returns `true` only when a repair was
 * written. A plan that still carries ANY parseable unit is never touched —
 * preservation must not overwrite content an agent authored on purpose.
 */
export function restorePlanOpenCodeDelegateBlock(cwd: string, runId: string): boolean {
  if (!runId) return false;
  // ABSENT and UNREADABLE are split here, and the `?? ''` this replaces folded
  // them. Absent is a legitimate repair: there is no plan.md, nothing is lost,
  // and the write below CREATES it from the preserved block. Unreadable is the
  // opposite — something IS there, we could not see it, and the same write
  // would destroy it. That fold was already a hazard for EACCES and EIO (a plan
  // nobody could read was replaced by the block alone) and became a second hang
  // once the read was bounded: `writeFileSync` on a FIFO with no reader blocks
  // exactly the way `open(2)` for reading does, so folding a non-regular object
  // into "empty plan" would have carried the wedge from line 141 to line 147.
  const read = readPlanText(planPath(cwd));
  if (read.kind === 'unreadable') return false;
  const plan = read.kind === 'text' ? read.text : '';
  if (parsePlanDelegationUnits(plan).length > 0) return false;
  const block = preservedOpenCodeDelegateBlock(cwd, runId);
  if (!block) return false;
  const body = stripDelegateMarkers(plan).replace(/\n+$/, '');
  try {
    fs.writeFileSync(planPath(cwd), body ? `${body}\n\n${block}\n` : `${block}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
