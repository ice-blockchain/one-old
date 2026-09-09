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

// The same rule applied to the OTHER authorizations that live in this store.
// `hosts` is rescued below, and a host bucket carries `team` / `performance` —
// so a state file carrying `hosts.<host>.team.mode` (or `modeChangeApproval`)
// used to attribute a team setting — and a downgrade marker — to whichever
// host scrubbed the shared file first. The comment at extractProjectPrefs
// omits generic top-level `team`/`performance` for that reason; the nested
// spelling defeated it. Drop the entire nested `team` and `performance`
// objects. A legitimately leaked bucket re-prompts the user; that is the
// accepted cost. Other host fields (if any survive normalize) are still
// rescued.
//
// `teamModeMarkerWriteViolation` / `teamModeDowngradeViolation` now read the
// nested spelling too — their structured arms walk `proposedTeamObjects` —
// but those refuse a WRITE they can see proposed through a tool call; this
// one refuses to ROUTE the value however it arrived, including from bytes
// already on disk that no gate ever inspected. This is the first line, the
// deny is the second.
function hostsWithoutForgedApprovals(value: unknown): unknown {
  const hosts = obj(value);
  if (!hosts) return value;
  const out: Rec = {};
  for (const [host, bucket] of Object.entries(hosts)) {
    const entry = obj(bucket);
    if (!entry) {
      out[host] = bucket;
      continue;
    }
    const next: Rec = { ...entry };
    delete next.team;
    delete next.performance;
    out[host] = next;
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
  // A leaked NEW local shape can be rescued as-is, except nested `team` /
  // `performance` inside a host bucket — those are the same authorizations
  // as the omitted top-level keys, and attributing them to whichever host
  // scrubs the shared file first is the hole hostsWithoutForgedApprovals
  // exists to close. Legacy generic performance / team stay omitted.
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

