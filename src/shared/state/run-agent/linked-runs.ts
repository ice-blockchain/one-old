// src/shared/state/run-agent/linked-runs.ts
// The WORKSPACE FEATURE JOIN KEY: how one feature spanning several workspace
// members is CORRELATED, without any of those members' settlements being
// coupled.
//
// ── WHY THIS IS NOT A SHARED RUN ID ─────────────────────────────────────────
// The obvious implementation of "one feature, several members" is one run id
// for all of them, and it is wrong in a way that is worth stating before the
// code, because every future reader will reach for it again.
//
// A run id is PER PROJECT — `ensureCurrentRunId` (run-paths.ts) mints it into
// one project's `.one.json` and every artefact under
// `<project>/.traffic-one/runs/<id>/` belongs to that project alone. The
// LEDGER is per run, and it carries two things that a second member cannot
// share: `stackFingerprint`, frozen at mint and never rewritten (see
// `recordRunStackDriftResult`), and `qaContractVersion`, which selects the
// verification contract the run must satisfy. Putting a Go service and a React
// app under one run id therefore puts two technology stacks under ONE frozen
// fingerprint and ONE QA contract — so the Go service would have to produce the
// React app's browser evidence to settle, and the React app would inherit the
// Go service's identity. Neither is a thing anyone asked for, and both are
// unrecoverable once written, because the fingerprint is frozen.
//
// So the correlation is a JOIN KEY and nothing else:
//
//   - Every member keeps its OWN run, its OWN ledger, its OWN frozen
//     fingerprint, its OWN QA contract and its OWN settlement.
//   - Each of those ledgers additionally RECORDS which feature it belongs to
//     and who its siblings are, in fields no gate reads.
//   - Reporting reads those fields and joins the members back together.
//
// The invariant, stated so a test can hold this file to it: NOTHING in this
// module is read by a gate, a ledger transition, a claim admission, a
// completion-evidence check or a settlement write. A member's verdict is
// decided entirely by that member's own evidence, and mutating one member's run
// to a failing state moves nothing in a sibling's.
//
// ── THE SIBLING FINGERPRINT IS A COPY, AND SAYS SO ──────────────────────────
// `siblings[].stackFingerprint` is the sibling's frozen identity AS OBSERVED
// WHEN THE LINK WAS RECORDED. It is a copy of a value that lives in another
// project's ledger, and this module never treats it as authority: it is carried
// so a report can render a feature's stacks without opening every member's
// tree, and `workspaceFeatureReport` names any disagreement between a copy and
// the member's own record rather than picking a winner. The authoritative value
// is always the one in the member's own `run.json`.
//
// A copy recorded beside a FROZEN value must not imply the frozen value can
// move, so nothing here ever writes `stackFingerprint`. The self row below is
// READ out of the ledger, never supplied by a caller.
//
// ── MEMBER IDS ARE RECORDED, NEVER RE-DERIVED ───────────────────────────────
// The ids here are the ones the workspace member registry RECORDED
// (hook/workspace-members.ts: an id is minted once and stored, so a directory
// rename edits `path` while `id` stays put). A join key re-derived from a path
// would silently re-point every historical row the first time a monorepo
// directory is renamed, which is ordinary maintenance. This module accepts ids
// as input and validates their SHAPE; it never computes one.
//
// ── REACHABILITY ────────────────────────────────────────────────────────────
// DORMANT, exactly as the member registry was when it landed: no production
// path can mint a `mode: 'workspace'` project yet, so nothing can currently
// create a multi-member feature, so `recordWorkspaceFeatureLinkResult` has no
// production caller. Workspace onboarding is the consumer that will supply the
// first one. Everything here is therefore reachable today only from tests, and
// a malformed record cannot do worse than not existing.

import { obj, type Rec } from '../../obj';

import { isNonProjectRoot } from '../../authoring-root';
import { readJsonResult, writeJson } from '../../fsjson';
import { isSafeRunId } from '../../qa-report/schema';

import { withRunLedgerLockResult } from './ledger';
import {
  invalidateRunLedgerFingerprint,
  runLedgerFile,
} from './run-paths';
import {
  applied,
  preconditionFailed,
  unavailable,
  type MutationResult,
} from './mutation-result';

/**
 * The ONE ledger key this module owns: `workspaceFeature: { id, memberId,
 * siblings }`. Untrusted — an agent's Write tool reaches `run.json`.
 *
 * NAMESPACED ON PURPOSE, and DELIBERATELY NOT the flat `workspaceFeatureId` +
 * `siblings` the plan spells. Recorded here so the next reader does not
 * "correct" it back toward the plan text:
 *
 *   1. The ledger is an untyped `Rec` and `writeRunLedgerTransition` publishes
 *      `{...existing, ...patch}`. There is no schema and no compiler anywhere
 *      on that path, so a future key collision does not fail — it SURVIVES,
 *      with one writer's value sitting under another writer's name. With a
 *      typed record the risk would be theoretical; here it is silent.
 *   2. The flat tokens are measurably generic. `siblings` occurs ~40 times as
 *      a word across this tree, and `memberId` already appears in five other
 *      modules (shared/tool-classify.ts and shared/onboarding/** among them).
 *      None writes `run.json` today, so there is no live collision — but a
 *      name this feature area demonstrably reaches for is a bad bet as a flat
 *      key.
 *   3. The three parts are ONE FACT. Every other flat ledger key (`status`,
 *      `outcome`, `kind`, `stackFingerprint`, `qaContractVersion`, `runId`,
 *      `createdAt`, `updatedAt`, `transitionHistory`, `stackDriftHistory`) is
 *      an independent fact about the run. These three are this run's
 *      membership in a workspace feature and are meaningless apart.
 *   4. It makes the reader below sharper. Under one object "is there a link?"
 *      is a single presence test, and a partial hand-edit is legible as ONE
 *      malformed object — see `parseFeatureRecord`, where a DELETED `siblings`
 *      key is a broken record rather than an empty list.
 *   5. It keeps the absence tests scannable. `id` on its own is not a
 *      greppable token in any tree, but under this namespace no reader can
 *      reach it without first naming `workspaceFeature`, which is.
 */
export const WORKSPACE_FEATURE_KEY = 'workspaceFeature';

const FEATURE_ID_KEY = 'id';
const FEATURE_MEMBER_ID_KEY = 'memberId';
const FEATURE_SIBLINGS_KEY = 'siblings';

/**
 * A bound on how many sibling runs one record may carry.
 *
 * REFUSED at the bound rather than TRUNCATED to it, which is the opposite of
 * what `transitionHistory` and `stackDriftHistory` do — and the difference is
 * the point. Those two are HISTORIES: the newest entries are the interesting
 * ones and dropping the oldest loses the least. This is a MEMBERSHIP LIST, and
 * a truncated one is a list whose reader believes it names every member of the
 * feature when it does not. Silently dropping a member from a join key is
 * exactly how one member's work becomes invisible to the report that is
 * supposed to find it, so the caller is told instead.
 */
export const LINKED_RUN_SIBLING_LIMIT = 64;

/** One run belonging to a workspace feature. */
export interface LinkedRunSibling {
  /** The id the workspace member registry RECORDED for this member. */
  readonly memberId: string;
  /** That member's own run id, minted in that member's own project. */
  readonly runId: string;
  /**
   * That run's frozen stack identity. Authoritative for the `self` row (read
   * from the ledger); an as-observed COPY for every `siblings` row.
   * Empty when the run's ledger never stamped one, which is legal —
   * `stackFingerprintPatch` deliberately leaves the field absent rather than
   * persisting a fabricated identity.
   */
  readonly stackFingerprint: string;
}

/** What a run's ledger records about the feature it belongs to. */
export interface WorkspaceFeatureLink {
  readonly workspaceFeatureId: string;
  /** This run itself, with the fingerprint read from its own ledger. */
  readonly self: LinkedRunSibling;
  /** The OTHER members' runs, sorted by member id then run id. */
  readonly siblings: readonly LinkedRunSibling[];
}

/**
 * Four arms, following the registry reader next door
 * (hook/workspace-members.ts) rather than inventing a second vocabulary:
 *
 *   none      — the ledger is legible and records no feature. A POSITIVE
 *               finding: this run belongs to no multi-member feature.
 *   illegible — the ledger could not be read at all. NOT a finding. A report
 *               that renders this as "no siblings" is asserting something it
 *               never measured.
 *   opaque    — the ledger is legible and the `workspaceFeature` record is
 *               malformed: not an object, or an object missing a required
 *               part. Also not a finding, and separate from `illegible`
 *               because only one of the two is fixable by editing the file.
 *   linked    — every part validated.
 *
 * A HALF-RECORD IS NEVER COMPLETED WITH DEFAULTS. `siblings: []` and a DELETED
 * `siblings` key are different facts — "this run has no siblings recorded" and
 * "something removed the list" — and the second is the one worth reporting. The
 * writer therefore always emits all three parts, so an absent part can only
 * mean an edit, and the reader answers `opaque` for it rather than reading an
 * empty membership list off a record that never said so.
 *
 * THIS IS THE OPPOSITE ANSWER TO THE REGISTRY READER'S, DELIBERATELY, and the
 * two must not be harmonised. An absent `workspaceMembers` key on a legible
 * workspace state is `members: []` there, because that key is optional and a
 * file that never carried it is stating a fact rather than reporting an
 * inability. This key is not optional: the writer above emits all three parts
 * on every write, so the same shape carries the opposite information. The rule
 * both readers follow is the same one — ask whether the writer could have left
 * this out — and it is only the answer that differs.
 */
export type WorkspaceFeatureLinkRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'illegible'; readonly why: string }
  | { readonly kind: 'opaque'; readonly why: string }
  | { readonly kind: 'linked'; readonly link: WorkspaceFeatureLink };

export interface WorkspaceFeatureLinkRequest {
  readonly workspaceFeatureId: string;
  /** This run's own member id, as RECORDED by the registry. */
  readonly memberId: string;
  /** The other members' runs. Omitted or empty is legal: a feature can start with one member. */
  readonly siblings?: readonly LinkedRunSibling[];
}

function safeSegment(value: unknown): string | null {
  return typeof value === 'string' && isSafeRunId(value) ? value : null;
}

// A fingerprint is opaque to this module — it is produced by
// state/materialization.ts and only ever compared for equality — so the only
// thing checked is that it is a plausible single-line string. An empty one is
// legal and means "this run never stamped an identity".
const FINGERPRINT_MAX = 512;
function safeFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > FINGERPRINT_MAX) return null;
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}

function siblingKey(entry: LinkedRunSibling): string {
  return `${entry.memberId}\u0000${entry.runId}`;
}

function sortSiblings(entries: LinkedRunSibling[]): LinkedRunSibling[] {
  // Sorted on the way to disk so the record is a function of its CONTENT and
  // not of the order a caller happened to pass, which is what lets two
  // independently-built records of the same feature compare equal.
  return entries.sort((left, right) => (
    left.memberId.localeCompare(right.memberId) || left.runId.localeCompare(right.runId)
  ));
}

/**
 * Parse a sibling list out of untrusted bytes.
 *
 * ONE BAD ENTRY POISONS THE LIST, the same rule the member registry follows and
 * for the same reason: dropping the entry we could not read costs a member its
 * place in the join, and the reader cannot tell whether the dropped one was the
 * member being asked about. Half a membership list answers a question it never
 * read.
 */
function parseSiblings(raw: unknown, selfMemberId: string): LinkedRunSibling[] | string {
  // STRICT about the array itself: `undefined` is not folded into `[]` here,
  // because on disk that fold is precisely the half-record hazard above. The
  // request path passes `request.siblings ?? []` before calling, which is a
  // statement about the CALLER's API (offering no siblings is legal) and not
  // about the stored record.
  if (!Array.isArray(raw)) return `${FEATURE_SIBLINGS_KEY} is not an array`;
  const parsed: LinkedRunSibling[] = [];
  for (const entry of raw) {
    const record = obj(entry);
    if (!record) return `${FEATURE_SIBLINGS_KEY} holds the entry ${JSON.stringify(entry)}, which is not an object`;
    const memberId = safeSegment(record.memberId);
    if (!memberId) return `a sibling carries the member id ${JSON.stringify(record[FEATURE_MEMBER_ID_KEY])}, which is not a safe path segment`;
    const runId = safeSegment(record.runId);
    if (!runId) return `sibling ${memberId} carries the run id ${JSON.stringify(record.runId)}, which is not a safe path segment`;
    const fingerprint = safeFingerprint(record.stackFingerprint ?? '');
    if (fingerprint === null) return `sibling ${memberId} carries an unusable stack fingerprint`;
    if (memberId === selfMemberId) return `sibling ${memberId} is this run's own member`;
    const candidate: LinkedRunSibling = { memberId, runId, stackFingerprint: fingerprint };
    const existing = parsed.find((seen) => siblingKey(seen) === siblingKey(candidate));
    if (existing) {
      // An identical repeat is a duplicate and is dropped; a repeat that
      // disagrees about the frozen fingerprint is a CONTRADICTION. One
      // (member, run) pair has exactly one frozen identity, so two spellings
      // mean one of them is wrong and picking either would publish a
      // fingerprint nobody recorded.
      if (existing.stackFingerprint !== candidate.stackFingerprint) {
        return `sibling ${memberId} run ${runId} is listed twice with different stack fingerprints`;
      }
      continue;
    }
    parsed.push(candidate);
  }
  return sortSiblings(parsed);
}

/**
 * What the `workspaceFeature` value on a ledger holds — the three parts, or the
 * one reason it is unusable.
 *
 * `absent` is separated from the malformed arm because only `absent` licenses a
 * WRITE: an untouched ledger may be linked, while a ledger carrying a record
 * this parser could not read must not be overwritten by a writer that never
 * understood what was there.
 */
type FeatureRecordParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly why: string }
  | {
    readonly kind: 'ok';
    readonly id: string;
    readonly memberId: string;
    readonly siblings: LinkedRunSibling[];
  };

function parseFeatureRecord(ledger: Rec): FeatureRecordParse {
  const raw = ledger[WORKSPACE_FEATURE_KEY];
  if (raw === undefined || raw === null) return { kind: 'absent' };
  const record = obj(raw);
  if (!record) return { kind: 'malformed', why: `${WORKSPACE_FEATURE_KEY} is ${JSON.stringify(raw)}, which is not an object` };
  const id = safeSegment(record[FEATURE_ID_KEY]);
  if (!id) {
    return { kind: 'malformed', why: `${WORKSPACE_FEATURE_KEY}.${FEATURE_ID_KEY} is ${JSON.stringify(record[FEATURE_ID_KEY])}, which is not a safe path segment` };
  }
  const memberId = safeSegment(record[FEATURE_MEMBER_ID_KEY]);
  if (!memberId) {
    // A feature id with no member id joins nothing: the row has a right-hand
    // side and no left-hand side, so it cannot say WHOSE run this is.
    return { kind: 'malformed', why: `${WORKSPACE_FEATURE_KEY}.${FEATURE_MEMBER_ID_KEY} is ${JSON.stringify(record[FEATURE_MEMBER_ID_KEY])}, which is not a safe path segment` };
  }
  // A MISSING list is malformed, not empty — see the arm table above. The
  // writer always emits this key, so its absence is an edit and nothing else.
  const siblings = parseSiblings(record[FEATURE_SIBLINGS_KEY], memberId);
  if (typeof siblings === 'string') return { kind: 'malformed', why: `${WORKSPACE_FEATURE_KEY}.${siblings}` };
  return { kind: 'ok', id, memberId, siblings };
}

/** The same classification over a ledger record a caller already holds. */
export function workspaceFeatureLinkOf(ledger: unknown, runId: string): WorkspaceFeatureLinkRead {
  const record = obj(ledger);
  if (!record) return { kind: 'none' };
  const feature = parseFeatureRecord(record);
  if (feature.kind === 'absent') return { kind: 'none' };
  if (feature.kind === 'malformed') return { kind: 'opaque', why: feature.why };
  const stackFingerprint = safeFingerprint(record.stackFingerprint ?? '');
  return {
    kind: 'linked',
    link: {
      workspaceFeatureId: feature.id,
      self: { memberId: feature.memberId, runId, stackFingerprint: stackFingerprint ?? '' },
      siblings: feature.siblings,
    },
  };
}

/** Read `<cwd>/.traffic-one/runs/<runId>/run.json` and classify its feature fields. */
export function readWorkspaceFeatureLink(cwd: string, runId: unknown): WorkspaceFeatureLinkRead {
  if (typeof runId !== 'string' || !runId.trim()) return { kind: 'none' };
  const id = runId.trim();
  const read = readJsonResult<Rec>(runLedgerFile(cwd, id));
  // `absent` is `none` and the other two are not, for the reason the whole
  // codebase now separates them: an absent ledger is a fact, and bytes we could
  // not read are the absence of a fact.
  if (read.kind === 'absent') return { kind: 'none' };
  if (read.kind === 'corrupt') return { kind: 'illegible', why: 'run.json holds bytes that are not JSON' };
  if (read.kind === 'unreadable') return { kind: 'illegible', why: `run.json could not be read (${read.errno})` };
  return workspaceFeatureLinkOf(read.value, id);
}

/**
 * Record which feature this run belongs to, and who its siblings are.
 *
 * NOT A LIFECYCLE WRITE. It goes through the ledger lock because it republishes
 * `run.json`, but it touches exactly one key — `workspaceFeature`: no `status`, no
 * `outcome`, no `transitionHistory`, no `qaContractVersion`, no `updatedAt` —
 * and above all no `stackFingerprint`, which is frozen. Bumping `updatedAt`
 * would make a reporting annotation look like a state-machine event to
 * everything that reads the ledger's timestamps.
 *
 * IDEMPOTENT-AS-APPLIED, deliberately unlike `recordRunStackDriftResult`, which
 * answers `precondition-failed('drift-already-recorded')` for a no-op. That is
 * right there: drift APPENDS to a history, and refusing to append a duplicate
 * entry is a decision. Here the caller is asserting a POSTCONDITION — "this run
 * belongs to this feature with these siblings" — and when the ledger already
 * says exactly that, the postcondition holds. Answering `precondition-failed`
 * would force every caller to special-case a reason token to learn that it got
 * what it asked for. `applied` therefore means THE LEDGER NOW RECORDS THIS
 * LINK, not necessarily that this call is what put it there.
 *
 * The feature id and the member id are IMMUTABLE once recorded. A join key that
 * can be rewritten retroactively relocates historical rows between features,
 * which is the same hazard the frozen fingerprint exists to prevent, arriving
 * through a different field. Siblings, by contrast, MERGE: members join a
 * feature over time and a record that could not gain one would be stale the
 * moment the second member started.
 */
export function recordWorkspaceFeatureLinkResult(
  cwd: string,
  runId: unknown,
  request: WorkspaceFeatureLinkRequest,
): MutationResult<WorkspaceFeatureLink> {
  if (isNonProjectRoot(cwd)) return preconditionFailed('authoring-root');
  if (typeof runId !== 'string' || !runId.trim()) return preconditionFailed('no-run-id');
  const id = runId.trim();
  const workspaceFeatureId = safeSegment(request?.workspaceFeatureId);
  if (!workspaceFeatureId) return preconditionFailed('unsafe-feature-id');
  const memberId = safeSegment(request?.memberId);
  if (!memberId) return preconditionFailed('unsafe-member-id');
  const requested = parseSiblings(request?.siblings ?? [], memberId);
  if (typeof requested === 'string') return preconditionFailed('unsafe-siblings');

  return withRunLedgerLockResult<WorkspaceFeatureLink>(cwd, id, () => {
    // Read INSIDE the lock, and refuse rather than heal — the same three arms
    // `writeRunLedgerTransition` takes. An absent ledger is refused rather than
    // created: minting `run.json` from this patch would publish a record with a
    // feature id and no `status`, `createdAt` or `kind`, which is precisely the
    // fabricated ledger the `|| {}` hazard produced.
    const read = readJsonResult<Rec>(runLedgerFile(cwd, id));
    if (read.kind === 'corrupt' || read.kind === 'unreadable') return unavailable(`ledger-${read.kind}`);
    if (read.kind === 'absent') return preconditionFailed('no-ledger');
    const ledger = obj(read.value);
    if (!ledger) return preconditionFailed('no-ledger');

    // One parse of one object, which is the reader's own — so the writer and
    // the reader can never disagree about whether a record is usable, and a
    // half-record is refused here rather than silently completed with the
    // caller's values.
    const prior = parseFeatureRecord(ledger);
    if (prior.kind === 'malformed') return preconditionFailed('feature-record-malformed');
    if (prior.kind === 'ok' && prior.id !== workspaceFeatureId) return preconditionFailed('feature-id-immutable');
    if (prior.kind === 'ok' && prior.memberId !== memberId) return preconditionFailed('member-id-immutable');
    const existing = prior.kind === 'ok' ? prior.siblings : [];

    const merged = [...existing];
    for (const candidate of requested) {
      const seen = merged.find((entry) => siblingKey(entry) === siblingKey(candidate));
      if (!seen) {
        merged.push(candidate);
        continue;
      }
      if (seen.stackFingerprint !== candidate.stackFingerprint) {
        // The recorded copy and the offered one disagree about a value that is
        // frozen at its source, so one of them is wrong and this module cannot
        // tell which. Overwriting would publish a fingerprint the sibling's own
        // ledger may not carry; keeping the old one silently would discard the
        // caller's observation. Refuse and let the caller re-read the sibling.
        return preconditionFailed('sibling-fingerprint-conflict');
      }
    }
    if (merged.length > LINKED_RUN_SIBLING_LIMIT) return preconditionFailed('sibling-limit');
    sortSiblings(merged);

    const stackFingerprint = safeFingerprint(ledger.stackFingerprint ?? '');
    const link: WorkspaceFeatureLink = {
      workspaceFeatureId,
      self: { memberId, runId: id, stackFingerprint: stackFingerprint ?? '' },
      siblings: merged,
    };
    // Nothing to write is still `applied`: see the postcondition note above.
    if (prior.kind === 'ok' && merged.length === existing.length) return applied(link);

    // The boolean is the whole reason this goes through the chokepoint: it is
    // false when the consent fence refused, when a symlink was planted at
    // `run.json`, and when the write escaped the state dir. Reporting a
    // recorded link over any of those is the defect class this tree ratchets
    // against — and it is the same one `recordRunStackDriftResult` was fixed
    // for two fields over in this directory.
    const wrote = writeJson(runLedgerFile(cwd, id), {
      ...ledger,
      // All three parts, always — an absent part is what makes a record a
      // half-record, and the reader refuses to complete one with defaults.
      [WORKSPACE_FEATURE_KEY]: {
        [FEATURE_ID_KEY]: workspaceFeatureId,
        [FEATURE_MEMBER_ID_KEY]: memberId,
        [FEATURE_SIBLINGS_KEY]: merged,
      },
    });
    // The cache holds this file's frozen fingerprint and this call republished
    // the file. The value is preserved by the spread above — the whole point of
    // reading under the lock — so the drop costs one re-read and cannot be
    // wrong, whereas a cache surviving a republish it never observed can.
    invalidateRunLedgerFingerprint(cwd, id);
    return wrote ? applied(link) : unavailable('link-write-refused');
  });
}

// ── REPORTING ────────────────────────────────────────────────────────────────

export interface WorkspaceFeatureReportRow {
  readonly workspaceFeatureId: string;
  /** Every (member, run) the feature knows about, sorted, self rows preferred over copies. */
  readonly members: readonly LinkedRunSibling[];
  /**
   * The distinct stack identities under this feature, sorted. PLURAL BY DESIGN:
   * a feature spanning a Go service and a React app has two, and that is the
   * arrangement this whole item exists to make expressible. Empty fingerprints
   * are omitted — a run that never stamped an identity contributes no stack,
   * not a blank one.
   */
  readonly stackFingerprints: readonly string[];
  /**
   * (member, run) pairs whose recorded fingerprints disagree between a member's
   * own ledger and a sibling's copy of it. Reported rather than resolved: the
   * copy is advisory and the member's own record is authority, so a
   * disagreement means a copy was taken before the sibling stamped its identity
   * (or was taken wrong), and the reader is the one who can tell which.
   */
  readonly fingerprintDisagreements: readonly {
    readonly memberId: string;
    readonly runId: string;
    readonly recorded: readonly string[];
  }[];
}

/**
 * Join a set of members' links into one row per feature.
 *
 * PURE, and that is the enforcement: it takes records a caller has already
 * read, touches no filesystem, reads no ledger and writes nothing, so there is
 * no path from a feature id to a settlement decision even by accident. It is
 * also the only consumer of these fields in the tree.
 */
export function workspaceFeatureReport(
  links: readonly WorkspaceFeatureLink[],
): WorkspaceFeatureReportRow[] {
  const byFeature = new Map<string, Map<string, { entry: LinkedRunSibling; authoritative: boolean; seen: string[] }>>();
  const order: string[] = [];
  const note = (
    featureId: string,
    entry: LinkedRunSibling,
    authoritative: boolean,
  ): void => {
    let members = byFeature.get(featureId);
    if (!members) {
      members = new Map();
      byFeature.set(featureId, members);
      order.push(featureId);
    }
    const key = siblingKey(entry);
    const existing = members.get(key);
    if (!existing) {
      members.set(key, { entry, authoritative, seen: entry.stackFingerprint ? [entry.stackFingerprint] : [] });
      return;
    }
    if (entry.stackFingerprint && !existing.seen.includes(entry.stackFingerprint)) {
      existing.seen.push(entry.stackFingerprint);
    }
    // A member's own ledger outranks any copy of it, whichever arrived first.
    if (authoritative && !existing.authoritative) {
      members.set(key, { entry, authoritative, seen: existing.seen });
    }
  };
  for (const link of links) {
    note(link.workspaceFeatureId, link.self, true);
    for (const sibling of link.siblings) note(link.workspaceFeatureId, sibling, false);
  }
  order.sort((left, right) => left.localeCompare(right));
  return order.map((workspaceFeatureId) => {
    const members = [...byFeature.get(workspaceFeatureId)!.values()];
    const rows = sortSiblings(members.map((member) => member.entry));
    const fingerprints = [...new Set(rows
      .map((row) => row.stackFingerprint)
      .filter((fingerprint) => fingerprint))].sort();
    const disagreements = members
      .filter((member) => member.seen.length > 1)
      .map((member) => ({
        memberId: member.entry.memberId,
        runId: member.entry.runId,
        recorded: [...member.seen].sort(),
      }))
      .sort((left, right) => (
        left.memberId.localeCompare(right.memberId) || left.runId.localeCompare(right.runId)
      ));
    return {
      workspaceFeatureId,
      members: rows,
      stackFingerprints: fingerprints,
      fingerprintDisagreements: disagreements,
    };
  });
}
