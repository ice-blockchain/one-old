// src/shared/onboarding-server/wizard-state-write.ts
// How the wizard persists SHARED fields on `.traffic-one/.one.json`.
//
// `patchState` refuses every illegible base. That is the right default for a
// merge (a torn onboarded project must not become one wizard answer plus a
// version), and it is the wrong default for a first-time file that never
// carried a stack: empty / null / `{"mode":"new` is the signature of an
// interrupted first write, and `finalize` — the only other healer — is later
// in the wizard, so OpenCode could never reach it. This module is the
// heal-or-refuse split those two facts need, without changing `patchState`.
//
// Heal vs refuse is decided from the RAW bytes. `readState` answers every torn
// file with `{}`, which would look like "no stack" and license replacing a
// stacked project.

import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { readJsonResult, stateWritePermitted } from '../fsjson';
import { type Rec } from '../obj';
import { dirOwnsProject, projectMembershipRoot } from '../project-membership';
import { patchState, readState, statePath, writeState } from '../state';
import { projectWritesPermitted } from '../state/plugin-use';
import { usePluginQuestionPending } from './flow-view';

// A `"stack"` key whose string value has already started. The closing quote
// may be missing — that is what a torn write looks like — so the capture
// stops at the next quote or end of input. Whitespace-only and `""` do not
// count: those are not a committed stack.
const TORN_STACK_STRING = /"stack"\s*:\s*"([^"]*)/;

export function tornBytesCarryCommittedStack(text: string): boolean {
  const captured = TORN_STACK_STRING.exec(String(text ?? ''))?.[1];
  return Boolean(captured && captured.trim() !== '');
}

export function persistWizardSharedFields(cwd: string, fields: Rec): boolean {
  const read = readJsonResult(statePath(cwd));
  if (read.kind === 'ok' || read.kind === 'absent') return patchState(cwd, fields);
  if (read.kind === 'unreadable') return false;
  if (tornBytesCarryCommittedStack(read.text)) return false;
  return writeState(cwd, { ...readState(cwd), ...fields });
}

export function classifyWizardStateWriteRefusal(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (usePluginQuestionPending(cwd, env) || !projectWritesPermitted(cwd, env)) {
    return '"Use Traffic One here?" is unanswered; re-run setup / `--use` at the project root '
      + 'so `.traffic-one/.one.json` can be written';
  }
  if (isNonProjectRoot(cwd)) {
    return 'this directory is the plugin source or machine-config space; setup is not allowed '
      + 'and `.traffic-one/.one.json` cannot be written here';
  }
  const file = statePath(cwd);
  const read = readJsonResult(file);
  if (read.kind === 'absent' && !dirOwnsProject(cwd)) {
    const enclosing = projectMembershipRoot(path.dirname(path.resolve(cwd)));
    if (enclosing !== null) {
      return `this folder is inside another project at ${enclosing}; run setup at that root `
        + 'rather than creating `.traffic-one/.one.json` here';
    }
  }
  if (read.kind === 'corrupt' || read.kind === 'unreadable') {
    return '`.traffic-one/.one.json` is torn or unreadable and its current contents could not be read; '
      + 'restore it from git or delete it and re-run setup';
  }
  if (!stateWritePermitted(file)) {
    return '`.traffic-one/.one.json` is a planted symlink; remove it so the project state write '
      + 'fence can accept the write';
  }
  return null;
}

// True when a shared write will not heal and must not start. The classifier
// also names a healable first-time corrupt file (empty / torn, no stack) —
// that text is for the refuse path AFTER persist failed. Those bytes still
// heal, so they are the one classifier hit that does not skip the write.
export function wizardSharedWriteWillNotHeal(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (classifyWizardStateWriteRefusal(cwd, env) == null) return false;
  const read = readJsonResult(statePath(cwd));
  return read.kind !== 'corrupt' || tornBytesCarryCommittedStack(read.text);
}

export function wizardStateWriteRefused(
  subject: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: false; error: string } {
  const classified = classifyWizardStateWriteRefusal(cwd, env);
  if (classified) {
    return { ok: false, error: `${classified}, so ${subject} was not recorded` };
  }
  return {
    ok: false,
    error: '`.traffic-one/.one.json` did not accept the write (the project state write fence refused it, '
      + `or its current contents could not be read), so ${subject} was not recorded`,
  };
}
