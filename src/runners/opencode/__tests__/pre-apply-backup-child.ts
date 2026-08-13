// src/runners/opencode/__tests__/pre-apply-backup-child.ts
// ONE arm of the pre-apply backup sequence, in its own process, so the parent can
// enforce the deadline.
//
// A CHILD RATHER THAN AN IN-PROCESS CALL, and the reason is the whole class this
// file belongs to: before `copyPath` was routed through `copyRegularFile`, this
// exact sequence sat in `open(2)` on a FIFO forever (DRIVEN by the round-4 peer:
// SIGKILL at 8 018 ms). An in-process timer cannot bound that — it is a callback
// on an event loop a blocking `open` is holding — so the arm runs here and the
// suite asserts on the SIGNAL.
//
// FOUR SHAPES, TWO OF THEM DIRECTORIES, because the phantom survived one branch
// over. `copyPath`'s directory arm was `fs.cpSync(src, dst, {recursive, force})`,
// which SILENTLY OMITS a FIFO or a socket inside the tree, so the backup was
// recorded as taken while being unable to reconstruct the target — and the
// rollback removes the target BEFORE restoring. The record-on-disk invariant that
// pins the FILE branch HOLDS in that case (a directory backup exists; it is merely
// incomplete), which is why this child now reports the ENTRY SET AND KINDS of the
// target before and after, and of the backup itself. What a backup owes is
// reconstruction, not existence.
//
// argv: <fixtureRoot> <targetShape>  where shape is
//   `regular` | `fifo` | `dir-regular` | `dir-fifo`
// stdout: one JSON line.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { backupApplyTargets, restoreApplyTargets, type ApplyTargetBackup } from '../git-sandbox';

const root = process.argv[2]!;
const shape = process.argv[3]!;
const parent = path.join(root, '.parent');
const isDirShape = shape.startsWith('dir-');
const rel = isDirShape ? 'src/targetdir' : 'src/target.txt';
const abs = path.join(root, rel);

fs.mkdirSync(path.dirname(abs), { recursive: true });
fs.mkdirSync(parent, { recursive: true });

const kindOf = (p: string): string => {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    if (stat.isFIFO()) return 'fifo';
    if (stat.isSocket()) return 'socket';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch {
    return 'GONE';
  }
};

/**
 * What is AT this path, as an entry set with kinds. This is the property a backup
 * owes: `["ordinary.txt:file","pipe:fifo"]` cannot be reconstructed from a copy
 * that holds only the first, however healthy the copy looks.
 */
const contentsOf = (p: string): string[] => {
  const kind = kindOf(p);
  if (kind !== 'dir') return [`.:${kind}`];
  return fs.readdirSync(p).sort().map((name) => `${name}:${kindOf(path.join(p, name))}`);
};

const mkfifo = (at: string): string | null => {
  const made = spawnSync('mkfifo', [at], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL' });
  if (made.status === 0 && fs.existsSync(at)) return null;
  // A BLANK REASON IS A SKIP NOBODY CAN ACT ON. `made.stderr` is `''`, not
  // null, when the tool refuses quietly — `??` keeps the empty string and the
  // suite then prints `# SKIP no FIFO available: mkfifo unavailable: `, which is
  // what a `mkfifo` stub that exits 1 produces (driven, .tmp/bounded6b/p6-stub.tap).
  const said = (made.stderr ?? '').trim() || made.error?.message || '';
  return `mkfifo unavailable: exit ${String(made.status)}${made.signal ? ` signal ${made.signal}` : ''}`
    + `${said ? ` — ${said}` : ''}`;
};

let unavailable: string | null = null;
if (shape === 'regular') {
  fs.writeFileSync(abs, 'ORIGINAL BYTES\n', 'utf8');
} else if (shape === 'fifo') {
  unavailable = mkfifo(abs);
} else {
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'ordinary.txt'), 'ORIGINAL BYTES\n', 'utf8');
  if (shape === 'dir-fifo') unavailable = mkfifo(path.join(abs, 'pipe'));
}
if (unavailable) {
  console.log(JSON.stringify({ shape, skipped: unavailable }));
  process.exit(0);
}

const entriesBefore = contentsOf(abs);

let backups: ApplyTargetBackup[] = [];
let backupThrew: string | null = null;
try {
  backups = backupApplyTargets(root, [rel], parent);
} catch (error) {
  backupThrew = error instanceof Error ? error.message : String(error);
}

// The RECORD is the thing that lied before: `existed: true` with a `backupPath`
// that was never written — or, one branch over, one that WAS written and cannot
// reconstruct the target. Report both, plus what the backup actually holds.
const records = backups.map((backup) => ({
  existed: backup.existed,
  backupPath: backup.backupPath ?? null,
  backupOnDisk: backup.backupPath ? fs.existsSync(backup.backupPath) : false,
  backupContents: backup.backupPath && fs.existsSync(backup.backupPath) ? contentsOf(backup.backupPath) : null,
}));

// Only a caller that got a backup list rolls back; `run-model.ts` turns the throw
// into `kind: 'failed'` BEFORE `git apply` runs, so the rollback below is the
// no-throw path only.
const restoreError = backupThrew === null ? restoreApplyTargets(backups) : null;

const targetKind = kindOf(abs);

console.log(JSON.stringify({
  shape,
  backupThrew,
  records,
  restoreError,
  targetKind,
  targetBytes: targetKind === 'file' ? fs.readFileSync(abs, 'utf8') : null,
  innerBytes: targetKind === 'dir' && fs.existsSync(path.join(abs, 'ordinary.txt'))
    ? fs.readFileSync(path.join(abs, 'ordinary.txt'), 'utf8')
    : null,
  entriesBefore,
  entriesAfter: contentsOf(abs),
}));
