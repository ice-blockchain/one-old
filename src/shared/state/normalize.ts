// src/shared/state/normalize.ts
// .one.json read/write + partial-state normalization, toolchain seeding, default
// technologies, legacy-stack migration, Supabase add-on gate. Ported 1:1 from
// scripts/hook-runtime/state/normalize.cjs (dead helper setIfMissingOrDifferent
// dropped). Uses shared fsjson; state timestamps keep the legacy ms-stripped form.

import { obj, type Rec } from '../obj';
import * as fs from 'fs';
import * as path from 'path';

import { LEGACY_STACK_ALIASES, STACK_IDS } from '../../config/stacks';
import { LEGACY_LOCK_FILE, LEGACY_STATE_FILE, STATE_FILE } from '../../config/paths';
import { isNonProjectRoot } from '../authoring-root';
import { type JsonRead, readJson, readJsonResult, readText, writeJsonDurable, writeTextFile } from '../fsjson';
import { dirOwnsProject, projectMembershipRoot } from '../project-membership';
import {
  canonicalizeStateShape,
  canonicalMobileSource,
  canonicalOpenCodeSource,
  canonicalPerformanceLevel,
  canonicalTeamMode,
  canonicalTeamOverrides,
  canonicalTeamSource,
  mobileStateFromString,
  overridesEqual,
} from './canonicalize';
import { KNOWN_ADDONS } from '../../config/state';
import { stateTimestamp, stateVersion } from './io';
import { hasLocalPreferenceFields, splitLocalPreferences, stripLocalPreferenceFields } from './local-prefs';
import { initializeToolchainState } from './toolchain';
import { preserveCurrentRunId, preserveOneMcpReportId, withProjectStateLock } from './project-state-lock';
import { defaultStateForStack } from '../capabilities';

function defaultMobileState(): Rec {
  return { enabled: false, framework: 'none', source: 'none' };
}

function defaultTechnologiesFor(state: Rec): { frontend: string[]; backend: string[]; mobile: string[] } {
  const frontend: string[] = [];
  const backend: string[] = [];
  const mobile: string[] = [];
  const frontendValue = (typeof state.frontend === 'string' && state.frontend) || 'none';
  const backendValue = (typeof state.backend === 'string' && state.backend) || 'none';
  const mobileObj = obj(state.mobile);
  const mobileValue = mobileObj ? mobileObj.framework : undefined;

  if (frontendValue === 'react-vite') frontend.push('react', 'vite');
  else if (frontendValue && frontendValue !== 'none') frontend.push(frontendValue);

  if (backendValue === 'supabase' || backendValue === 'our-fork') backend.push('supabase', 'postgres');
  else if (backendValue === 'firebase') backend.push('firebase');
  else if (backendValue === 'mongo') backend.push('mongo');
  else if (backendValue && backendValue !== 'none' && backendValue !== 'external-api') backend.push(backendValue);

  if (mobileValue === 'ionic-capacitor') mobile.push('ionic', 'capacitor');
  if (mobileValue === 'react-native-expo') mobile.push('react-native', 'expo');

  return { frontend, backend, mobile };
}

function normalizeLegacyStack(state: Rec): boolean {
  if (!state.stack) return false;
  const original = state.stack;
  if (typeof original !== 'string') return false;
  const mapped = LEGACY_STACK_ALIASES[original];
  if (!mapped) return false;

  state.stack = mapped;
  if (!state.legacyStack) state.legacyStack = original;

  if (original === 'react-realtime-monorepo') {
    state.frontend = state.frontend || 'react-vite';
    state.backend = state.backend || 'supabase';
  } else if (original === 'react-frontend-only') {
    state.frontend = state.frontend || 'react-vite';
    state.backend = state.backend || 'none';
  } else if (original === 'react-native-expo-monorepo' || original === 'react-native-expo-app') {
    state.frontend = state.frontend || 'none';
    state.backend = state.backend || 'supabase';
    const existingMobile = obj(state.mobile) || {};
    state.mobile = {
      ...existingMobile,
      enabled: true,
      framework: 'react-native-expo',
      source: existingMobile.source || 'explicit',
    };
  } else if (original === 'node-backend') {
    state.frontend = state.frontend || 'none';
    state.backend = state.backend || 'node';
  } else if (original === 'framework-web') {
    state.frontend = state.frontend || 'other';
    state.backend = state.backend || 'other';
  }
  return true;
}

export function statePath(cwd: string): string {
  return path.join(cwd, STATE_FILE);
}

export function legacyStatePath(cwd: string): string {
  return path.join(cwd, LEGACY_STATE_FILE);
}

export function readState(cwd: string): Rec {
  const currentPath = statePath(cwd);
  if (fs.existsSync(currentPath)) return stripLocalPreferenceFields(readJson(currentPath, {}));

  const oldPath = legacyStatePath(cwd);
  if (fs.existsSync(oldPath)) {
    const legacy = readJson<Rec>(oldPath, {});
    if (legacy && typeof legacy === 'object') legacy.legacyStateFile = LEGACY_STATE_FILE;
    return stripLocalPreferenceFields(legacy);
  }

  const legacyPath = path.join(cwd, LEGACY_LOCK_FILE);
  const legacy = readText(legacyPath);
  if (legacy !== null) {
    return { version: stateVersion(), mode: legacy.trim(), stack: null, confirmed: false };
  }
  return {};
}

/**
 * Persist the shared project state, and report whether `.one.json` now holds it.
 *
 * The boolean is the channel this funnel did not have. 30-odd writers land here,
 * every one of them through a `void` return, so the write fence's `false` (an
 * unanswered consent question, a planted symlink, a path escaping the state dir)
 * died one frame below every caller — and five of those callers went on to
 * `return true`, telling a consumer that state which is not on disk is. The two
 * NON-refusal no-ops below answer `false` for the same reason: from a caller's
 * point of view "the plugin's own repo declines state" and "the fence refused" are
 * the same fact — the state it asked to persist is not persisted.
 *
 * Scope: the SHARED state file. The local-preference half
 * (`splitLocalPreferences`, which routes LOCAL_PREF_KEYS to the per-user store)
 * is not covered — it reports by throwing, as it always has, and a caller whose
 * subject IS a local preference must not use this function at all. That is not a
 * hypothetical: `team` is a host preference, so a `writeState` of a state object
 * carrying `team` strips it and persists nothing about it while answering `true`
 * (see onboarding/team-mode-approval.ts, which used to do exactly that).
 *
 * REPLACEMENT, not merge: the object handed in BECOMES the file, minus the two
 * fields preserveCurrentRunId/preserveOneMcpReportId pin. A caller whose subject
 * is one FIELD wants `patchState` below instead — `writeState(cwd, {
 * ...readState(cwd), ...patch })` performs its read OUTSIDE this lock, so it
 * publishes a snapshot that is already stale and drops whatever another process
 * wrote in between.
 */
export function writeState(cwd: string, state: unknown): boolean {
  // Contract: the plugin's own repo/install never gets a .one.json — a silent
  // no-op here covers every state writer (onboarding server, run claims, session
  // flows) in one place. See authoring-root.test.ts + normalize tests.
  if (isNonProjectRoot(cwd)) return false;
  // Never CREATE state in a directory that belongs to an enclosing project. Same
  // single-funnel reasoning as above: 30+ writers land here, including ones the
  // resolver never sees (the onboarding-wait runners take their cwd from argv, and
  // post-stack-setup's digestRoot bypasses resolveProjectRoot outright). Without
  // this, a Go package could still be initialized as its own project.
  //
  // Creation-time only — a dir that already owns state keeps updating, so a
  // legitimately nested project is untouched and an already-strayed root can still
  // be written until the retention sweep heals it.
  const ownsState = fs.existsSync(statePath(cwd)) || fs.existsSync(legacyStatePath(cwd));
  if (!ownsState
    && !dirOwnsProject(cwd)
    && projectMembershipRoot(path.dirname(path.resolve(cwd))) !== null) return false;
  let source: Rec = obj(state) ? { ...(state as Rec) } : {};
  delete source.pluginVersion;
  if (source.stack) {
    canonicalizeStateShape(source);
    if (typeof source.stack === 'string') {
      normalizeState(source, (typeof source.mode === 'string' && source.mode) || 'new-project');
    }
  }
  const split = splitLocalPreferences(cwd, source);
  source = split.state;
  const filePath = statePath(cwd);
  const replacement = { ...source, version: stateVersion() };
  let persisted = false;
  withProjectStateLock(cwd, () => {
    const read = readJsonResult<Rec>(filePath);
    if (!statePreservedBeforeReplace(filePath, read)) return;
    const current = read.kind === 'ok' ? read.value : {};
    persisted = writeJsonDurable(
      filePath,
      preserveCurrentRunId(current, preserveOneMcpReportId(current, replacement)),
    );
  });
  return persisted;
}

/**
 * Merge `fields` into the CURRENT on-disk state and publish the result, with the
 * read and the write inside one hold of the project state lock.
 *
 * This is the shape `writeState(cwd, { ...readState(cwd), ...patch })` was
 * reaching for and does not have. That spelling reads the file, and only then
 * asks for the lock: two hooks that each set a DIFFERENT field both publish a
 * whole-object snapshot taken before either of them started, so the lock
 * serializes the writes perfectly and the second one still erases the first's
 * field. The lock was never the missing piece — the re-read was. Only `oneUid`
 * and `currentRunId` survive that today, because they are the two fields
 * project-state-lock.ts had to special-case one at a time after each was lost in
 * production; a patch generalizes the rescue instead of extending the list.
 *
 * Declaring the fields is what makes the merge possible at all: an absent key in
 * `fields` means "not mine, leave it", which a whole-object write cannot express
 * — an absent key there is indistinguishable from a deliberate deletion.
 * A caller that genuinely means to REPLACE the file (onboarding committing a
 * stack, a repair rewriting it) still wants writeState.
 *
 * Refuses — without writing anything — when the current file cannot be read.
 * A patch is defined against a base, so a base we cannot see leaves nothing
 * honest to publish, and the caller already has a `false` channel for it. Only
 * writeState's replacement path quarantines and heals, because only a caller
 * that meant to replace the whole file has something to put there.
 *
 * The nested writeState re-enters the same lock in-process (project-state-lock.ts
 * `heldLocks`), so this is one lock hold and one cross-process critical section,
 * not two — and every guard, normalization and local-preference split writeState
 * performs applies unchanged, rather than being restated here where the two
 * could drift.
 */
export function patchState(cwd: string, fields: Rec): boolean {
  return withProjectStateLock(cwd, () => {
    const read = readJsonResult<Rec>(statePath(cwd));
    if (read.kind === 'corrupt' || read.kind === 'unreadable') return false;
    const current = read.kind === 'ok' ? obj(read.value) : null;
    return writeState(cwd, { ...(current ?? readState(cwd)), ...fields });
  });
}

// A replaced file whose previous bytes we could not parse is preserved beside
// it, never dropped. `readJson`'s `{}` fallback used to make the two
// indistinguishable here, and the consequence was specific rather than
// theoretical: `current` is what preserveOneMcpReportId and preserveCurrentRunId
// read, so an unparseable `.one.json` silently took the durable report id and
// the live run pointer with it — the exact erasure those two functions exist to
// prevent, arriving through the one input they never checked.
//
// `unreadable` (EACCES, EISDIR, EIO) gets the opposite answer to `corrupt` for
// the reason it is a separate kind: there are bytes there and we cannot copy
// them, so replacing the file would destroy content that was never even seen.
// Refusing leaves a project whose state dir is mis-permissioned reporting
// state-write-refused, which is true, instead of quietly resetting it.
//
// Proceeding after a successful quarantine rather than refusing is a product
// choice: onboarding/repair.ts and the session-start scrub both heal through
// writeState, so a permanent refusal would wedge a hand-broken `.one.json` with
// no in-product way out. Nothing is lost either way — the bytes are on disk
// beside the file — so the tie is broken towards self-healing.
const CORRUPT_STATE_SUFFIX = '.corrupt';

function statePreservedBeforeReplace(filePath: string, read: JsonRead<Rec>): boolean {
  if (read.kind === 'ok' || read.kind === 'absent') return true;
  if (read.kind === 'unreadable') return false;
  return writeTextFile(`${filePath}${CORRUPT_STATE_SUFFIX}`, read.text);
}

// Deterministic self-heal for machine-local preference fields that leaked into the
// COMMITTED project state file. writeState strips LOCAL_PREF_KEYS and routes them to the
// per-user preferences.json, but a stale long-lived runner (started before the prefs split
// was wired into its writer) can still write the merged state raw — leaving `team`,
// `toolchain` (with a machine-absolute binPath), `performance`, etc. in `.one.json`, which
// is NOT gitignored. Run this at SessionStart: it reads the RAW on-disk file (NOT readState,
// which strips on read and would hide the leak); if any local-pref field is present it
// rewrites through writeState — stripping them and merging them into preferences.json. No-op
// when the file is absent, already clean, or in the plugin authoring repo (writeState guards
// that). Returns true when it scrubbed — i.e. when the rewritten file is on disk;
// a refused rewrite leaves the leak in place and says so, because the caller's
// next honest move (log it, re-run next session) differs from "already clean".
export function scrubProjectStateLocalPrefs(cwd: string): boolean {
  const raw = readJson<Rec>(statePath(cwd), null as unknown as Rec);
  if (!raw || typeof raw !== 'object' || !hasLocalPreferenceFields(raw)) return false;
  return writeState(cwd, raw);
}

export function normalizeState(state: unknown, defaultMode?: string): boolean {
  const s = obj(state);
  if (!s) return false;

  let changed = canonicalizeStateShape(s);
  if (typeof s.currentRunId === 'number' && Number.isFinite(s.currentRunId)) {
    s.currentRunId = String(Math.trunc(s.currentRunId));
    changed = true;
  } else if (typeof s.currentRunId === 'string' && s.currentRunId.trim() && s.currentRunId !== s.currentRunId.trim()) {
    s.currentRunId = s.currentRunId.trim();
    changed = true;
  }
  if (!s.stack) return changed;

  changed = normalizeLegacyStack(s) || changed;
  if (typeof s.stack !== 'string' || !STACK_IDS.has(s.stack)) return changed;

  if (!s.mode && defaultMode) { s.mode = defaultMode; changed = true; }
  if (s.confirmed !== true) { s.confirmed = true; changed = true; }
  if (s.onboardingComplete !== true) { s.onboardingComplete = true; changed = true; }
  if (!s.confirmedAt) { s.confirmedAt = stateTimestamp(); changed = true; }
  if (!s.realtime) { s.realtime = 'none'; changed = true; }
  if (!s.frontend) {
    s.frontend = defaultStateForStack(s.stack).frontend;
    changed = true;
  }
  if (!s.backend) { s.backend = s.stack === 'minimal' ? 'none' : 'supabase'; changed = true; }

  const mobile = obj(s.mobile);
  if (!mobile) { s.mobile = defaultMobileState(); changed = true; } else {
    const frameworkAlias = mobileStateFromString(mobile.framework);
    const normalizedMobile: Rec = { ...defaultMobileState(), ...mobile };
    if (frameworkAlias) {
      normalizedMobile.enabled = frameworkAlias.enabled;
      normalizedMobile.framework = frameworkAlias.framework;
      if (!mobile.source) normalizedMobile.source = frameworkAlias.source;
    }
    normalizedMobile.source = canonicalMobileSource(normalizedMobile.source);
    if (
      mobile.enabled !== normalizedMobile.enabled
      || mobile.framework !== normalizedMobile.framework
      || mobile.source !== normalizedMobile.source
    ) { s.mobile = normalizedMobile; changed = true; }
  }

  const technologies = obj(s.technologies);
  if (!technologies) { s.technologies = defaultTechnologiesFor(s); changed = true; } else {
    const defaults = defaultTechnologiesFor(s);
    for (const key of ['frontend', 'backend', 'mobile'] as const) {
      if (!Array.isArray(technologies[key])) { technologies[key] = defaults[key]; changed = true; }
    }
  }

  const team = obj(s.team);
  if (team) {
    const normalizedTeam: Rec = {
      ...team,
      mode: canonicalTeamMode(team.mode),
      source: canonicalTeamSource((team.source as string) || 'prompted'),
    };
    const perf = obj(s.performance);
    const performanceLevel = perf ? canonicalPerformanceLevel(perf.level) : null;
    const normalizedOverrides = canonicalTeamOverrides(team.overrides, performanceLevel);
    if (normalizedOverrides) normalizedTeam.overrides = normalizedOverrides;
    else if ('overrides' in normalizedTeam) delete normalizedTeam.overrides;

    const mca = normalizedTeam.modeChangeApproval;
    if (normalizedTeam.mode !== 'subagents' && 'modeChangeApproval' in normalizedTeam) {
      delete normalizedTeam.modeChangeApproval;
    } else if ('modeChangeApproval' in normalizedTeam && (!mca || typeof mca !== 'object')) {
      delete normalizedTeam.modeChangeApproval;
    }

    if (team.approved === true) normalizedTeam.approved = true;
    else if ('approved' in normalizedTeam) delete normalizedTeam.approved;

    if (
      team.mode !== normalizedTeam.mode
      || team.source !== normalizedTeam.source
      || !overridesEqual(team.overrides, normalizedTeam.overrides)
      || team.modeChangeApproval !== normalizedTeam.modeChangeApproval
      || team.approved !== normalizedTeam.approved
    ) { s.team = normalizedTeam; changed = true; }
  }

  const performance = obj(s.performance);
  if (performance) {
    const normalizedPerformance: Rec = {
      ...performance,
      level: canonicalPerformanceLevel(performance.level),
      source: typeof performance.source === 'string' ? performance.source : 'prompted',
    };
    if (performance.level !== normalizedPerformance.level || performance.source !== normalizedPerformance.source) {
      s.performance = normalizedPerformance;
      changed = true;
    }
  }

  const openCode = obj(s.openCode);
  if (openCode) {
    const normalizedOpenCode: Rec = {
      ...openCode,
      enabled: openCode.enabled === true,
      source: canonicalOpenCodeSource(openCode.source),
    };
    if (typeof normalizedOpenCode.decidedAt !== 'string' || !(normalizedOpenCode.decidedAt as string).trim()) {
      normalizedOpenCode.decidedAt = stateTimestamp();
    }
    if (
      openCode.enabled !== normalizedOpenCode.enabled
      || openCode.source !== normalizedOpenCode.source
      || openCode.decidedAt !== normalizedOpenCode.decidedAt
    ) { s.openCode = normalizedOpenCode; changed = true; }
  }

  const nextToolchain = initializeToolchainState(s.toolchain);
  if (JSON.stringify(s.toolchain || {}) !== JSON.stringify(nextToolchain)) { s.toolchain = nextToolchain; changed = true; }

  if (s.backend === 'supabase' || s.backend === 'our-fork') {
    if (s.supabaseFunctionsAutoDeploy === undefined) { s.supabaseFunctionsAutoDeploy = 'ask'; changed = true; }
    if (!obj(s.supabaseAddons)) { s.supabaseAddons = {}; changed = true; }
  }

  return changed;
}

interface AddonGate {
  approved: boolean;
  skipped: boolean;
  status: string;
  known: boolean;
}

export function requireAddon(state: unknown, name: string): AddonGate {
  if (!KNOWN_ADDONS.has(name)) {
    return { approved: false, skipped: false, status: 'pending', known: false };
  }
  const s = obj(state);
  const addons = (s && obj(s.supabaseAddons)) || {};
  const status = typeof addons[name] === 'string' ? (addons[name] as string) : 'pending';
  return { approved: status === 'approved', skipped: status === 'skipped', status, known: true };
}
