// src/modules/plan-guard/plan-write/targets.ts
// Write-target classification for the plan-write dispatcher: compiled
// feature detection, text-edit reconstruction, and patch target extraction.

import * as fs from 'fs';
import * as path from 'path';
import { readRegularFile } from '../../../shared/bounded-read';
import { obj, type Rec } from '../../../shared/obj';
import {
  shellCommandHasWritePrimitive,
} from '../../../shared/feature-source';
import {   type PatchFileOperation } from '../../../shared/apply-patch';
import { projectRelativeHookPath } from '../../../shared/hook/paths';
import {
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';

export interface GateTarget {
  filePath: string;
  resultContent: string;
  addedContent: string;
  staticCheck: boolean;
  // Heredoc payload of a shell-derived target. Deliberately NOT `resultContent`:
  // it is unverified shell text, so only gates that opt in read it (see
  // `heredocBodies`). Undefined for Write/Edit/apply_patch targets.
  shellBody?: string;
}

interface TextEditSpec {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

type TextEditReconstruction =
  | { ok: true; resultContent: string; addedContent: string }
  | { ok: false; error: string };

const HOT_EDIT_MAX_BYTES = 2 * 1024 * 1024;

function normalizedRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function underRoot(filePath: string, root: string): boolean {
  const file = normalizedRelative(filePath);
  const boundary = normalizedRelative(root).replace(/\/+$/, '');
  return Boolean(boundary)
    && (file === boundary || file.startsWith(`${boundary}/`));
}

/**
 * CompiledArchitectureV1, not a fixed React/monorepo regex, owns the write
 * boundary for a v2 run. The legacy regex remains only for pre-contract runs.
 */
export function isCompiledFeatureTarget(
  architecture: CompiledArchitectureV1 | null,
  filePath: string,
): boolean {
  if (!architecture || !filePath) return false;
  const roots = [
    ...architecture.sourceRoots,
    ...architecture.layers.pages,
    ...architecture.layers.components,
    ...architecture.layers.features,
    ...architecture.layers.lib,
  ];
  return architecture.entrypoints.some((entrypoint) => (
    normalizedRelative(entrypoint) === normalizedRelative(filePath)
  )) || roots.some((root) => underRoot(filePath, root));
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function commandAppearsToWriteCompiledFeature(
  command: string,
  architecture: CompiledArchitectureV1 | null,
): boolean {
  if (!architecture || !shellCommandHasWritePrimitive(command)) return false;
  const roots = [
    ...architecture.sourceRoots,
    ...architecture.layers.pages,
    ...architecture.layers.components,
    ...architecture.layers.features,
    ...architecture.layers.lib,
    ...architecture.entrypoints.map((entrypoint) => path.posix.dirname(
      normalizedRelative(entrypoint),
    )),
  ]
    .map(normalizedRelative)
    .filter((root) => root && root !== '.');
  return [...new Set(roots)].some((root) => (
    new RegExp(`(?:^|[\\s'"\\x22\`=(:,/])${regexEscape(root)}(?:/|$|[\\s'"\\x22\`;|&)])`)
      .test(command.replace(/\\\\/g, '/'))
  ));
}

export function ownString(rec: Rec | null, keys: readonly string[]): { found: boolean; value: string } {
  if (!rec) return { found: false, value: '' };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(rec, key) && typeof rec[key] === 'string') {
      return { found: true, value: rec[key] as string };
    }
  }
  return { found: false, value: '' };
}

function editSpec(rec: Rec | null, fallbackNew?: string): TextEditSpec | null {
  const oldText = ownString(rec, ['old_string', 'oldString', 'old_str', 'oldText']);
  const newText = ownString(rec, ['new_string', 'newString', 'new_str', 'newText', 'new_content', 'newContent']);
  if (!oldText.found || (!newText.found && fallbackNew === undefined)) return null;
  return {
    oldText: oldText.value,
    newText: newText.found ? newText.value : (fallbackNew as string),
    replaceAll: rec?.replace_all === true || rec?.replaceAll === true,
  };
}

function editSpecs(raw: Rec, toolInput: Rec, fallbackNew?: string): TextEditSpec[] | null {
  const editsValue = Array.isArray(toolInput.edits)
    ? toolInput.edits
    : (Array.isArray(raw.edits) ? raw.edits : null);
  if (editsValue) {
    if (editsValue.length === 0) return null;
    const specs = editsValue.map((entry) => editSpec(obj(entry)));
    return specs.every((spec): spec is TextEditSpec => spec !== null) ? specs : null;
  }
  return [editSpec(toolInput, fallbackNew) || editSpec(raw, fallbackNew)].filter(
    (spec): spec is TextEditSpec => spec !== null,
  );
}

function occurrenceCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

export function reconstructTextEdit(
  absoluteFile: string,
  raw: Rec,
  toolInput: Rec,
  fallbackNew?: string,
): TextEditReconstruction {
  let current: string;
  try {
    const stat = fs.statSync(absoluteFile);
    if (!stat.isFile()) return { ok: false, error: 'target is not a regular file' };
    if (stat.size > HOT_EDIT_MAX_BYTES) {
      return { ok: false, error: `target exceeds the ${HOT_EDIT_MAX_BYTES}-byte hot-scan limit` };
    }
    // BOUNDED (shared/bounded-read.ts). The read this replaces had no bound at
    // all: a FIFO at the edit target blocked in `open(2)` forever, inside a
    // PreToolUse hook.
    //
    // WHAT IT DOES NOT DO, recorded because the first version of this comment
    // claimed it and the claim is FALSE: "it also moves the KIND decision off
    // the `statSync` above onto the descriptor that is actually read". It does
    // not. The `isFile()` test at the top of this block answers FIRST and
    // returns this same string, so for a shape that is already hostile when the
    // stat runs, the line below never executes — MEASURED by instrumenting
    // `openSync` on the real `fs` module: it fires for a regular file and never
    // fires for a FIFO or a symlink to `/dev/zero`. The consequence is worth
    // stating rather than leaving for the next reader to discover: no mutant of
    // `bounded-read.ts` can be killed at THIS call site, because no mutant of it
    // is reached here.
    //
    // What the bounded read is actually load-bearing for here is the narrower
    // half of the same hazard — the object being SWAPPED between the stat and
    // the read. That is the window `bounded-read.ts` argues the fd exists to
    // close, and it is the only one this site still has. The `isFile()` early
    // return is left in place deliberately: deleting it would route a DIRECTORY
    // from `target is not a regular file` into the generic
    // `target does not exist or is unreadable`, which is a worse message for the
    // commonest benign case, and the stat is needed for the size bound anyway.
    const read = readRegularFile(absoluteFile);
    if (read === null) return { ok: false, error: 'target is not a regular file' };
    current = read;
    if (current.includes('\0')) return { ok: false, error: 'target is binary' };
  } catch {
    return { ok: false, error: 'target does not exist or is unreadable' };
  }

  const specs = editSpecs(raw, toolInput, fallbackNew);
  if (!specs || specs.length === 0) {
    return { ok: false, error: 'old_string/new_string edit evidence is missing or incomplete' };
  }
  const added: string[] = [];
  for (const [index, spec] of specs.entries()) {
    if (!spec.oldText) {
      return { ok: false, error: `edit ${index + 1} has an empty old_string` };
    }
    const occurrences = occurrenceCount(current, spec.oldText);
    if (occurrences === 0) {
      return { ok: false, error: `edit ${index + 1} old_string does not match the current file` };
    }
    if (!spec.replaceAll && occurrences !== 1) {
      return { ok: false, error: `edit ${index + 1} old_string is ambiguous (${occurrences} matches)` };
    }
    current = spec.replaceAll
      ? current.split(spec.oldText).join(spec.newText)
      : current.replace(spec.oldText, spec.newText);
    added.push(spec.newText);
  }
  return { ok: true, resultContent: current, addedContent: added.join('\n') };
}

export function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

export function patchTargets(
  operations: readonly PatchFileOperation[],
  cwd: string,
  projectRoot: string,
): GateTarget[] {
  const targets: GateTarget[] = [];
  const add = (file: string, resultContent: string, addedContent: string, staticCheck: boolean): void => {
    const filePath = projectRelativeHookPath(cwd, projectRoot, file);
    if (!filePath) return;
    targets.push({ filePath, resultContent, addedContent, staticCheck });
  };
  for (const operation of operations) {
    if (operation.kind === 'delete') {
      add(operation.path, '', '', false);
    } else if (operation.kind === 'move') {
      // A move mutates both paths: ownership/readiness checks see the source
      // deletion and destination write. Every source line is newly introduced
      // at the destination, so destination static checks inspect the complete
      // reconstructed result (including a pure move with no hunks).
      add(operation.path, '', '', false);
      add(
        operation.destinationPath as string,
        operation.resultContent || '',
        operation.resultContent || '',
        true,
      );
    } else {
      add(operation.path, operation.resultContent || '', operation.addedContent, true);
    }
  }
  return targets;
}
