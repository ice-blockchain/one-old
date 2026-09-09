// src/shared/state/workspace-convert.ts
// Turn a project root into a Traffic One workspace container.
//
// A CONTAINER IS NOT AN UPGRADE OF A PROJECT. writeWorkspaceMemberRegistry
// already refuses a committed project mode for that reason. This module is the
// explicit conversion that refusal now names: when the root has no plan and no
// runs, identity can flip in place; when it does, `--yes` archives the project
// state under `.traffic-one/.converted-<ts>/` first.
//
// `.one.json` is ALWAYS archived when it exists. writeState's
// preserveCurrentRunId would otherwise restore the old run pointer onto the
// new container record (an empty currentRunId is treated as "no id"). The
// archive is what makes the committed mode disappear so the registry write
// can publish `mode: 'workspace'`.

import * as fs from 'fs';
import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { ensureDir, movePath, readJsonResult } from '../fsjson';
import { WORKSPACE_PROJECT_MODE } from '../hook/workspace-members';
import { obj } from '../obj';
import { convertToContainerYesCommand } from '../workspace-command';
import { withProjectStateLock } from './project-state-lock';
import { writeWorkspaceMemberRegistry } from './workspace-members';

export type ConvertToContainerResult =
  | { readonly outcome: 'converted'; readonly archive: string; readonly message: string }
  | { readonly outcome: 'already'; readonly message: string }
  | { readonly outcome: 'rejected'; readonly message: string }
  | { readonly outcome: 'refused'; readonly message: string };

function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasPlan(root: string): boolean {
  return isRegularFile(path.join(root, STATE_DIR, 'plan.md'));
}

function hasRuns(root: string): boolean {
  const runs = path.join(root, STATE_DIR, 'runs');
  try {
    return fs.readdirSync(runs).length > 0;
  } catch {
    return false;
  }
}

function committedMode(root: string): string {
  const read = readJsonResult<unknown>(path.join(root, STATE_FILE));
  if (read.kind !== 'ok' || !obj(read.value)) return '';
  const mode = (read.value as Record<string, unknown>).mode;
  return typeof mode === 'string' ? mode.trim() : '';
}

function archiveState(root: string, stamp: number, extras: readonly string[]): string | null {
  const archive = path.join(root, STATE_DIR, `.converted-${stamp}`);
  let moved = false;
  const stateFile = path.join(root, STATE_FILE);
  if (isRegularFile(stateFile)) {
    if (!ensureDir(archive)) return null;
    if (!movePath(stateFile, path.join(archive, '.one.json'))) return null;
    moved = true;
  }
  for (const name of extras) {
    const from = path.join(root, STATE_DIR, name);
    if (!fs.existsSync(from)) continue;
    if (!ensureDir(archive)) return null;
    if (!movePath(from, path.join(archive, name))) return null;
    moved = true;
  }
  return moved ? archive : '';
}

function convertLocked(projectRoot: string, yes: boolean): ConvertToContainerResult {
  const root = path.resolve(projectRoot);
  const mode = committedMode(root);
  if (mode === WORKSPACE_PROJECT_MODE) {
    return {
      outcome: 'already',
      message: `${root} is already a Traffic One workspace container.`,
    };
  }
  const plan = hasPlan(root);
  const runs = hasRuns(root);
  if ((plan || runs) && !yes) {
    const what = plan && runs ? 'a plan and runs' : plan ? 'a plan' : 'runs';
    return {
      outcome: 'rejected',
      message: `${root} still has ${what}. Conversion would replace this project's identity `
        + `with a container. Re-run with --yes to archive that state under .traffic-one/.converted-<ts>/: `
        + `${convertToContainerYesCommand()}`,
    };
  }
  const extras = yes ? ['plan.md', 'runs', 'digests'] : [];
  const archive = archiveState(root, Date.now(), extras);
  if (archive === null) {
    return {
      outcome: 'refused',
      message: `${root}: could not archive the current project state under ${STATE_DIR}/.converted-*`,
    };
  }
  const written = writeWorkspaceMemberRegistry(root, []);
  if (written.outcome !== 'written') {
    return {
      outcome: 'refused',
      message: written.why,
    };
  }
  return {
    outcome: 'converted',
    archive,
    message: archive
      ? `${root} is now a workspace container. Previous project state is at ${archive}. `
        + 'Register members separately — conversion does not invent them.'
      : `${root} is now a workspace container. Register members separately — conversion does not invent them.`,
  };
}

export function convertToContainer(
  projectRoot: string,
  options: { readonly yes?: boolean } = {},
): ConvertToContainerResult {
  return withProjectStateLock(projectRoot, () => convertLocked(projectRoot, options.yes === true));
}
