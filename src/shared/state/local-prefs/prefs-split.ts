// src/shared/state/local-prefs/prefs-split.ts
// Strip/extract/split of local preference fields. Leaf-most on purpose:
// state/normalize imports THIS module and must never pull the lock code.

import { obj, type Rec } from '../../obj';

import {
  LOCAL_PREF_KEYS,
  PROJECT_PREF_KEYS,
} from './pref-schema';
import {
  normalizeProjectPrefs,
  readProjectPrefs,
} from './prefs-store';
import {
  mergeProjectPrefs,
} from './prefs-merge';

export function hasLocalPreferenceFields(value: unknown): boolean {
  const v = obj(value);
  if (!v) return false;
  if (Object.keys(v).some((key) => LOCAL_PREF_KEYS.has(key) || key === 'codeGraph' || key === 'subagentTeam')) {
    return true;
  }
  const stack = obj(v.stack);
  return Boolean(stack && (
    Object.prototype.hasOwnProperty.call(stack, 'codeGraph')
    || Object.prototype.hasOwnProperty.call(stack, 'codeGraphProvider')
  ));
}

// `openCode` is the OpenCode-delegation CONSENT, and it is the only project
// preference that is an AUTHORIZATION rather than a setting. It travels one way
// only — per-user store → effective state — and is never extracted back OUT of
// the shared state file, in either of its two spellings (`openCode` itself, and
// the `openCodeDelegation.approved` record the wizard writes beside it).
//
// Not a tidiness rule. `.traffic-one/.one.json` is (a) committed, so it carries
// one user's answer into every teammate's checkout, and (b) writable by the
// agent — the onboarding gate stands down for state-file writes because its own
// prose asks the agent to write that file. Extracting consent from it therefore
// let an agent author its own authorization: measured end to end, an
// agent-written `.one.json` carrying `openCodeDelegation: { approved: true }`
// plus any one LOCAL_PREF_KEYS member made the SessionStart scrub promote it,
// and `openCodeDelegationActive(readEffectiveState(cwd))` — the predicate that
// gates the spawn gate's free-delegation push and the maintenance-triage
// OpenCode-first clause — came back true for a user who was never asked. It
// also OVERWROTE an `enabled: false` already in the store, i.e. it could reverse
// a decline, since mergeProjectPrefsObject replaces an `openCode` patch that
// carries `enabled`.
//
// No in-file field can discriminate: the wizard's record and one an agent typed
// differ in nothing a reader can check (`source: 'onboarding'` is a string the
// agent types too). The only honest discriminator is the STORE the value lives
// in, so consent is taken exclusively from the per-user store that only the
// wizard's own answer handler writes (onboarding-server/flow.ts `open-code`).
// The cost is that a project whose state file records the authorization while
// the per-user store does not gets the one-question `open-code` step re-asked —
// the same trade the generic performance/team refusal below already makes, and
// the answer re-writes both records.
const UNROUTED_PROJECT_PREF_KEYS = new Set(['openCode']);

// The same rule applied to the OTHER authorization that lives in this store.
// `hosts` is rescued wholesale below, and a host bucket carries `team` — so a
// state file carrying `hosts.<host>.team.modeChangeApproval` used to hand the
// downgrade gate a marker nobody was ever prompted for. Measured end to end on
// an agent-authored `.one.json`: the SessionStart scrub routed it,
// `hasFreshTeamModeChangeApproval(readEffectiveState(cwd))` — the exact question
// the gate asks, of the source it asks it of — came back true, and
// `teamModeDowngradeViolation` then ALLOWED the subagents → main-agent write it
// exists to deny. Only the UserPromptSubmit hook may mint this marker, so a copy
// arriving from the shared state file is dropped and the rest of the host bucket
// is rescued.
//
// `teamModeMarkerWriteViolation` now denies the nested spelling too — its
// structured arm was widened after this rescue landed — but the two are not
// redundant and the order matters. That predicate refuses a WRITE it can see
// proposed through a tool call; this one refuses to ROUTE the value however it
// arrived, including from bytes already on disk that no gate ever inspected.
// This is the first line, the deny is the second.
function hostsWithoutForgedApprovals(value: unknown): unknown {
  const hosts = obj(value);
  if (!hosts) return value;
  const out: Rec = {};
  for (const [host, bucket] of Object.entries(hosts)) {
    const entry = obj(bucket);
    const team = entry && obj(entry.team);
    if (!entry || !team || !Object.prototype.hasOwnProperty.call(team, 'modeChangeApproval')) {
      out[host] = bucket;
      continue;
    }
    const nextTeam: Rec = { ...team };
    delete nextTeam.modeChangeApproval;
    out[host] = { ...entry, team: nextTeam };
  }
  return out;
}

export function extractProjectPrefs(value: unknown): Rec {
  const source = obj(value) || {};
  const prefs: Rec = {};
  for (const key of PROJECT_PREF_KEYS) {
    if (UNROUTED_PROJECT_PREF_KEYS.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) prefs[key] = source[key];
  }
  // A leaked NEW local shape can be rescued as-is. Legacy generic performance /
  // team are intentionally omitted so they cannot be attributed to whichever
  // host happens to scrub the shared file first.
  if (Object.prototype.hasOwnProperty.call(source, 'hosts')) {
    prefs.hosts = hostsWithoutForgedApprovals(source.hosts);
  }
  // codeGraphProvider is no longer extracted into per-project prefs — it is a
  // machine-wide setting (one.json) injected by applyGlobalCodeGraphProvider.
  return normalizeProjectPrefs(prefs);
}

export function stripLocalPreferenceFields(value: unknown): Rec {
  const out: Rec = obj(value) ? { ...(value as Rec) } : {};
  for (const key of LOCAL_PREF_KEYS) delete out[key];
  delete out.codeGraph;
  // codeGraphProvider is machine-wide (one.json) — keep it out of shared state.
  // (No longer covered by the LOCAL_PREF_KEYS loop above.)
  delete out.codeGraphProvider;
  delete out.subagentTeam;
  const stack = obj(out.stack);
  if (stack) {
    const nextStack: Rec = { ...stack };
    delete nextStack.codeGraph;
    delete nextStack.codeGraphProvider;
    out.stack = nextStack;
  }
  return out;
}

export interface SplitResult {
  state: Rec;
  prefs: Rec;
  changed: boolean;
}

export function splitLocalPreferences(cwd: string, state: unknown, env: NodeJS.ProcessEnv = process.env): SplitResult {
  const stateRec = obj(state) || {};
  if (!hasLocalPreferenceFields(state)) {
    return { state: stateRec, prefs: readProjectPrefs(cwd, env), changed: false };
  }
  const localPatch = extractProjectPrefs(state);
  const prefs = mergeProjectPrefs(cwd, localPatch, env);
  return { state: stripLocalPreferenceFields(state), prefs, changed: true };
}

