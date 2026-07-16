// src/shared/state/plugin-use.ts
// The durable per-project "use Traffic One here?" choice. Lives in the PER-USER
// project preferences (~/.traffic-one/projects/<hash>/preferences.json) — never
// inside the repo — so a declined project carries NO .traffic-one folder and no
// generated files. A decline silences every Traffic One hook for that project
// until the user explicitly asks for the plugin again (the prompt hook offers
// the reconsider command only when the prompt names Traffic One).

import * as fs from 'fs';
import * as path from 'path';

import { obj, type Rec } from '../obj';
import { stateTimestamp } from './io';
import { mergeProjectPrefs, readProjectPrefs } from './local-prefs';
import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { readJson } from '../fsjson';

export interface PluginUseChoice {
  enabled: boolean;
  source: string;
  decidedAt: string;
}

export function readPluginUseChoice(cwd: string, env: NodeJS.ProcessEnv = process.env): PluginUseChoice | null {
  const raw = obj(obj(readProjectPrefs(cwd, env))?.pluginUse);
  if (!raw || typeof raw.enabled !== 'boolean') return null;
  return {
    enabled: raw.enabled,
    source: typeof raw.source === 'string' ? raw.source : '',
    decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : '',
  };
}

export function recordPluginUseChoice(cwd: string, enabled: boolean, source: string, env: NodeJS.ProcessEnv = process.env): void {
  mergeProjectPrefs(cwd, { pluginUse: { enabled, source, decidedAt: stateTimestamp() } }, env);
  if (!enabled) removeDeclinedProjectArtifacts(cwd);
}

// Forget the recorded choice entirely so the normal onboarding flow (and, when
// ASK_USE_PLUGIN_FIRST is active, the use-plugin question) runs again.
export function clearPluginUseChoice(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  mergeProjectPrefs(cwd, { pluginUse: null }, env);
}

// True when the user chose NOT to use Traffic One for this project. Every hook
// entry gate stands down on this — same posture as the plugin's own repo.
export function pluginUseDeclined(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readPluginUseChoice(cwd, env)?.enabled === false;
}

// A decline must leave the project untouched: remove the runtime junk the
// pre-decline hooks may already have created (once-markers, runs/). Only when
// the project was never genuinely onboarded — a mode-bearing .one.json means
// real state a user may want back, so it is left alone (hooks stay silent
// regardless).
export function removeDeclinedProjectArtifacts(cwd: string): void {
  try {
    const stateDir = path.join(path.resolve(cwd), STATE_DIR);
    const state = readJson<Rec>(path.join(path.resolve(cwd), STATE_FILE), {} as Rec);
    const onboarded = Boolean(state && typeof state.mode === 'string' && state.mode.trim());
    if (!onboarded) fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // best-effort — a leftover runtime dir never blocks the decline
  }
}
