// src/runners/doctor/findings.ts
// Turns the doctor probes into a flat list of severity-tagged findings. Ported
// 1:1 from scripts/doctor/buildFindings.cjs. Pure: derives messages from probe
// data; never reads the filesystem itself except via the toolchain spec.

import { registryEnclosureOf, workspaceMemberRegistryOf } from '../../shared/hook/workspace-members';
import { isNewProjectMode } from '../../shared/state/lifecycle';
import { toolStatus } from '../toolchain';
import { codeGraphProviderFromValue, normalizedProjectState, onboardingStateIssues, rawStateHasLegacyShape } from './lib';
import type { OverrideProbe } from './override-probe';
import type { PluginRootProbe } from './plugin-root-probe';
import { bothRunRecordsRemedy } from '../../shared/run-settlement';
import { describeSettlementLegibility } from './run-diagnostic';
import type { RunDiagnosticProbe } from './run-diagnostic';
import type {
  CodexHooksProbe,
  CursorEdgesProbe,
  GitnexusProbe,
  CanonicalAuthProbe,
  NodeProbe,
  NvmProbe,
  OneMcpProbe,
  OpenCodeMcpProbe,
  ProjectProbe,
  SessionDiagnosticsResult,
} from './probes';

type Rec = Record<string, unknown>;

export interface Finding {
  severity: 'fix-needed' | 'info';
  code: string;
  message: string;
  recommendedCommand?: string;
  tool?: string;
}

export type DoctorSummary = 'ACTION_NEEDED' | 'INFO_ONLY' | 'HEALTHY';

/**
 * The one-word verdict, derived HERE so `doctor` and `doctor --bundle` cannot
 * print different ones — the bundle carried no `summary` key at all, which made
 * the artifact an operator attaches to an issue the only view of this report with
 * no verdict in it.
 */
export function doctorSummary(findings: readonly Finding[]): DoctorSummary {
  if (findings.some((finding) => finding.severity === 'fix-needed')) return 'ACTION_NEEDED';
  return findings.length > 0 ? 'INFO_ONLY' : 'HEALTHY';
}

export interface BuildFindingsInput {
  node: NodeProbe;
  nvm: NvmProbe;
  gitnexus: GitnexusProbe;
  project: ProjectProbe;
  codexHooks?: CodexHooksProbe | null;
  auth?: CanonicalAuthProbe | null;
  oneMcp?: OneMcpProbe | null;
  openCodeMcp?: OpenCodeMcpProbe | null;
  sessionDiagnostics?: SessionDiagnosticsResult;
  pluginRoot?: PluginRootProbe | null;
  // `doctor --run <id>`/`--bundle`'s run probe. Load-bearing for the SUMMARY:
  // without it, `summary` was computed with no knowledge of stale agents or
  // expired claims, so a machine reader (an agent following the doctor skill)
  // saw HEALTHY on a wedged run while stderr's operator report printed
  // "⚠ N agent(s)/claim(s) are past their liveness window".
  runDiagnostic?: RunDiagnosticProbe | null;
  // The operator-override ledger (shared/override). Optional because every
  // caller that predates the primitive passes probes positionally by name and
  // an absent ledger is indistinguishable from "no override was ever minted".
  overrides?: OverrideProbe | null;
  // Cursor silent-break edges. Optional so callers that predate the probe
  // (and unit tests that omit it) stay silent — absent means "not asked".
  cursorEdges?: CursorEdgesProbe | null;
}

// A run whose ledger has reached one of these is DONE — nothing is expected to
// be alive for it, so "no live agent" is not a wedge. Mirrors
// run-settlement/projection.ts's TERMINAL_LEGACY_STATUS (canonical
// verified/failed/blocked ⇒ legacy completed/failed/blocked).
const TERMINAL_CANONICAL_STATUS = new Set(['verified', 'failed', 'blocked']);
const TERMINAL_LEGACY_STATUS = new Set(['completed', 'failed', 'blocked']);

function ledgerIsTerminal(ledger: RunDiagnosticProbe['ledger']): boolean {
  if (ledger.canonicalStatus) return TERMINAL_CANONICAL_STATUS.has(ledger.canonicalStatus);
  return Boolean(ledger.effectiveStatus && TERMINAL_LEGACY_STATUS.has(ledger.effectiveStatus));
}

// Every wedge shape the run probe can see, as machine-readable findings. Kept
// here rather than in run-diagnostic.ts so `summary` and the findings list stay
// single-sourced: one probe, one severity decision.
function runDiagnosticFindings(runDiagnostic: RunDiagnosticProbe): Finding[] {
  const findings: Finding[] = [];
  if (!runDiagnostic.runDirExists) {
    findings.push({
      severity: 'fix-needed',
      code: 'RUN_DIR_MISSING',
      message: `No \`.traffic-one/runs/${runDiagnostic.runId}/\` directory exists for the diagnosed run id. Either the id was never minted or doctor resolved a different project root than the one the run lives under.`,
    });
    return findings;
  }
  const staleAgents = runDiagnostic.liveAgents.filter((agent) => agent.stale);
  const liveAgents = runDiagnostic.liveAgents.filter((agent) => !agent.stale);
  const staleClaims = runDiagnostic.claims.filter((claim) => claim.stale);
  if (staleAgents.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'RUN_AGENT_STALE',
      message: `${staleAgents.length} registered agent(s) for run ${runDiagnostic.runId} are past their liveness window `
        + `(${staleAgents.map((agent) => `${agent.role} ${Math.round(agent.ageMs / 1000)}s into a ${Math.round(agent.windowMs / 1000)}s window${agent.replaced ? ' [replaced]' : ''}`).join('; ')}). `
        + 'A parent waiting on one of these will never be released. Doctor is read-only: confirm the agent process is gone, then let the next parent turn re-drive the run.',
    });
  }
  if (staleClaims.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'RUN_CLAIM_EXPIRED',
      message: `${staleClaims.length} held claim(s) for run ${runDiagnostic.runId} are past their liveness window `
        + `(${staleClaims.map((claim) => `[${claim.state}] ${claim.role} ${Math.round(claim.ageMs / 1000)}s into a ${Math.round(claim.windowMs / 1000)}s window`).join('; ')}). `
        + 'An expired claim keeps that role slot occupied, so a retry cannot take it. Doctor never prunes claims; expiry is reclaimed by the runtime on the next claim attempt for that role.',
    });
  }
  if (!ledgerIsTerminal(runDiagnostic.ledger) && liveAgents.length === 0) {
    const status = runDiagnostic.ledger.canonicalStatus
      ?? runDiagnostic.ledger.effectiveStatus
      ?? (runDiagnostic.ledger.exists ? '(no status)' : '(no run.json)');
    findings.push({
      severity: 'fix-needed',
      code: 'RUN_STALLED_NO_LIVE_AGENT',
      message: `Run ${runDiagnostic.runId} is not in a terminal state (status ${status}) but has no live agent — nothing is going to advance it on its own. `
        + `${runDiagnostic.denyCount} of ${runDiagnostic.decisionCount} recorded decisions were denies`
        + `${runDiagnostic.topDenies.length > 0 ? ` (most repeated: ${runDiagnostic.topDenies.slice(0, 3).map((deny) => `${deny.denyId}×${deny.count}`).join(', ')})` : ''}. `
        + 'Re-prompt the parent agent in the same project so the run is re-driven; do not hand-edit the ledger.',
    });
  }
  // Settlement LEGIBILITY, which no finding covered — and its absence is what
  // turned every wedge in the recoverability table into one with a remedy
  // nobody could find. The probe reported `canonicalStatus: null` for a damaged
  // record and for a legacy run alike, the report rendered both as "(no
  // settlement-v2.json — legacy/V1 run)", and the doctor's own verdict line
  // said HEALTHY while every settlement write for that run was being refused.
  // A control nobody can see is half a control.
  const settlementIllegible = runDiagnostic.ledger.canonicalLegibility !== 'ok'
    && runDiagnostic.ledger.canonicalLegibility !== 'absent';
  if (settlementIllegible) {
    findings.push({
      severity: 'fix-needed',
      code: 'RUN_SETTLEMENT_ILLEGIBLE',
      message: `Run ${runDiagnostic.runId}'s canonical settlement is \`${runDiagnostic.ledger.canonicalLegibility}\`: `
        + `${describeSettlementLegibility(runDiagnostic.ledger)} `
        + 'The next settlement write for this run preserves those bytes beside the record '
        + `(\`.traffic-one/runs/${runDiagnostic.runId}/settlement-v2.json.corrupt\`), rebuilds it, and marks the run `
        + 'permanently ineligible for verified/shipped — it stays drivable and resettable. '
        + `${bothRunRecordsRemedy(runDiagnostic.runId)}`,
    });
  }
  if (runDiagnostic.ledger.canonicalIllegibleOnce && !settlementIllegible) {
    findings.push({
      severity: 'info',
      code: 'RUN_SETTLEMENT_WAS_ILLEGIBLE',
      message: `Run ${runDiagnostic.runId}'s canonical settlement was found damaged at least once and has been `
        + 'rebuilt. The run is drivable and can settle failed/blocked, but it can never certify as '
        + 'verified/shipped: nothing on disk can say what the record claimed before the damage. '
        + `${runDiagnostic.ledger.canonicalQuarantinePath
          ? `The damaged bytes were preserved at ${runDiagnostic.ledger.canonicalQuarantinePath}. `
          : ''}`
        + 'Start a fresh run for work that has to certify.',
    });
  }
  if (runDiagnostic.ledger.rollbackBarrierNote) {
    findings.push({
      severity: 'info',
      code: 'RUN_LEDGER_ROLLBACK_BARRIER',
      message: runDiagnostic.ledger.rollbackBarrierNote,
    });
  }
  return findings;
}

/**
 * The nested `.traffic-one` roots that are actually STRAYS.
 *
 * The probe (probes-toolchain.ts listNestedTrafficOneRoots) walks the tree and
 * reports every directory below the root that owns a `.one.json`. For an
 * ordinary project each one is a leak. For a Traffic One WORKSPACE the same
 * finding is the opposite of the truth and dangerous with it: THE MEMBER IS THE
 * PROJECT — the container holds shared identity and no stack, each member holds
 * an ordinary single-stack `.one.json` and owns its runs — so a member's state
 * dir is exactly where its state belongs. Telling an operator to point the
 * cleanup runner at it, which the message below does, is user-initiated data
 * loss: it deletes the runs, claims and plan of a live project.
 *
 * EXACT membership, matching hook/paths.ts's own question about one directory
 * rather than the resolver's ancestor-or-self redirect. A member's own state is
 * the member's; a `.traffic-one` sitting in `<member>/internal` is a stray inside
 * the member and stays reported, with its wording unchanged.
 *
 * ASKED THROUGH `registryEnclosureOf`, THE SAME PREDICATE THE SWEEP ASKS — the
 * same predicate, at ONE depth, which is the whole of the claim and is narrower
 * than "the same question". This calls it once, against the registry the probe
 * already parsed out of the doctor's own cwd; the sweep calls it inside an
 * ancestor walk that re-reads each ancestor's registry from disk and stops at
 * the nearest workspace root. The two agree when the doctor is run in the
 * enclosing container and can diverge otherwise — see the structural limit at
 * the end of this block, which is that divergence. Not writing the comparison
 * here still buys the agreement that is available: whatever the predicate
 * decides about one directory, both paths decide alike. That verdict has three
 * arms that are not `none`, and only one of them is `member`:
 *
 *   - `member` — the registry NAMES this directory. Its state belongs to it.
 *   - `vouched` — an entry REACHES it without naming it (a symlinked entry, a
 *     bind mount, an entry spelled at another depth), or an entry OPTS IT OUT.
 *     Either way it is denied a member's authority and its state is deliberately
 *     KEPT: `resolveProjectRoot` answers with the directory itself, so
 *     retention's sweep withholds deletion (hook/paths.ts's `vouched-not-member`
 *     arm). The opt-out case is the one that reverses this finding's previous
 *     reading, and it reverses it in the direction the flag's own contract
 *     states: "Traffic One leaves this directory alone" cannot mean a report
 *     telling the operator to delete it by hand.
 *   - `indeterminate` — a `statSync` blipped, or the directory's name reached
 *     nothing while its `.one.json` was still readable (a rename in flight). The
 *     sweep withholds deletion there too, because "we could not tell" is not
 *     evidence of a leak.
 *
 * So this reports a stray only for `none`, the positive finding that no entry
 * reaches the directory at all. Reporting the other two would tell an operator
 * to hand-delete a live project's runs, claims and plan while the automatic
 * sweep, looking at the same directory, spares it — the advisory path and the
 * deletion path have to answer with one voice or the report is a trap.
 *
 * AND THE SAME RULE NOW GOVERNS THE REGISTRY ITSELF, which is where the two
 * voices had drifted apart again. The justification that used to sit here —
 * "`opaque` and `none` both leave every nested root reported, which is today's
 * behaviour and the safe direction: an unusable registry must not silence a real
 * leak" — was sound when it was written and is stale now. The resolution walk
 * grew an `indeterminate` arm: a container whose registry cannot be ENUMERATED
 * (torn, unreadable, or holding one malformed entry) makes the sweep WITHHOLD
 * deletion for everything beneath it, precisely because a non-member answer
 * derived from a file nobody could read is not knowledge (hook/paths.ts's
 * `workspaceMembershipOf`). "Report everything" was consistent with a sweep that
 * also deleted everything; against a sweep that now spares a correctly
 * registered member, it is the trap this docblock forbids — the report says
 * hand-delete, the automatic path says keep.
 *
 * `opaque`/`illegible` therefore produce an INFORMATIONAL finding that carries
 * no deletion advice: membership is unknown, and the honest instruction is to
 * repair the container's `.one.json`, after which the question can be answered
 * at all. `none` still reports strays with the wording unchanged — it is a
 * positive finding, and there the two paths still agree.
 *
 * IT STATS, and only where the answer cannot be had for free. The registry still
 * comes from the state record the project probe already parsed (the overload that
 * takes a value), a project that is not a workspace never reaches past
 * `workspaceMemberRegistryOf`'s first comparison, and a directory the registry
 * spells exactly is answered `member` with no syscall at all. What costs is a
 * nested root the registry does NOT spell: one stat for it, then one per entry
 * until something matches its identity. Bounded by 50 nested roots (the probe's
 * own cap) times the registry size, in a diagnostic that already walks the tree
 * to find them — and `enclosingRegisteredMember`, which this replaced, had an
 * identity pass of its own, so the module header's "never reads the filesystem
 * itself" was already about this file's imports rather than about the answers it
 * asks for.
 *
 * A FORGED OR STALE REGISTRY ENTRY HIDES A REAL STRAY, and that is accepted
 * rather than overlooked: anyone who can add `{ path: 'tools/scratch' }` to a
 * container's `.one.json` can silence this finding for `tools/scratch`, and an
 * entry left behind after a member was deleted and the directory reused does
 * the same by accident. Suppression is the safe direction here — the finding's
 * own advice is to point the cleanup runner at the directory, so a false
 * NEGATIVE costs an unreported stray while a false positive costs a live
 * project its runs, claims and plan. The registry lives in the same state file
 * the finding is derived from, so trusting it is no weaker than trusting the
 * `mode` that decided this is a workspace at all.
 *
 * IT CANNOT SEE A NESTED WORKSPACE, and that limit is structural rather than an
 * oversight. The registry read is `project.state` — the state of the directory
 * the doctor was run in — so a Traffic One workspace sitting INSIDE an ordinary
 * project has every one of its members reported as a stray, with the cleanup
 * advice attached. Closing it needs a state read per nested root, which this
 * module has no business doing; the probe is where it belongs. Recorded in
 * KNOWN-ISSUES.md with the measurement rather than half-fixed here.
 */
interface NestedRootVerdict {
  /** Directories no entry reaches: reported, with the deletion advice. */
  readonly strays: string[];
  /** Set when the registry could not be enumerated, so membership is UNKNOWN
   *  for every nested root and no advice may be attached to any of them. */
  readonly unknown: { readonly why: string; readonly roots: string[] } | null;
}

function strayNestedTrafficOneRoots(project: ProjectProbe): NestedRootVerdict {
  const nested = Array.isArray(project.nestedTrafficOneRoots) ? project.nestedTrafficOneRoots : [];
  const registry = workspaceMemberRegistryOf(project.state);
  if (registry.kind === 'opaque' || registry.kind === 'illegible') {
    return { strays: [], unknown: nested.length > 0 ? { why: registry.why, roots: nested } : null };
  }
  // `members` is the only arm that can EXEMPT anything; `none` is the positive
  // finding that this is not a workspace, so everything nested is a leak.
  if (registry.kind !== 'members') return { strays: nested, unknown: null };
  return {
    strays: nested.filter((dir) => registryEnclosureOf(project.cwd, registry, dir).kind === 'none'),
    unknown: null,
  };
}

/**
 * The state behind an `OVERRIDE_EVIDENCE_INCOMPLETE`, in the operator's terms.
 * The check ids name WHICH witness disagrees; this names what it saw, because
 * "override-snapshot-orphaned" tells a reader nothing about whether they are
 * looking at an erased audit line or a stray file someone dropped in a folder.
 * `null`/'unknown' are reported as such — this whole finding exists because a
 * probe that could not look once answered with the clean install.
 */
function describeOverrideEvidence(overrides: OverrideProbe): string {
  const parts = [
    `ledger ${overrides.ledger}`,
    overrides.snapshotScanAsked === false
      ? 'orphaned snapshots NOT SCANNED (the ledger is illegible, so that witness is off)'
      : `orphaned snapshots ${overrides.orphanSnapshots ?? 'unreadable'}`,
    `mint counter ${overrides.mintCounter}`
      + `${overrides.mintCounterCount === null ? '' : ` / ${overrides.mintCounterCount}`}`
      + `${overrides.mintCounterWritable === false ? ' (FROZEN: that file will not accept a write)' : ''}`,
    `mints this install can vouch for ${overrides.vouchableMints ?? 'unreadable'}`,
  ];
  // The deficit, in every finding that describes this state rather than only in
  // the one that refuses. It used to be printed nowhere but inside the
  // discrepancies branch, so the reading that matters most — a counter ahead of
  // the lines that remain — was invisible in exactly the reconciled and
  // illegible states where nothing else can see it either.
  const deficit = overrideCounterDeficit(overrides);
  if (deficit > 0) {
    parts.push(`${deficit} mint(s) the counter has recorded and the ledger can no longer show`);
  }
  if (overrides.reconciliations > 0) parts.push(`reconciliations on record ${overrides.reconciliations}`);
  return `Observed: ${parts.join(', ')}.`;
}

/** Mints the counter has signed for that the ledger can no longer account for.
 *  Only meaningful for a counter that verifies; 0 otherwise. */
function overrideCounterDeficit(overrides: OverrideProbe): number {
  if (overrides.mintCounter !== 'verified') return 0;
  if (overrides.mintCounterCount === null || overrides.vouchableMints === null) return 0;
  return Math.max(0, overrides.mintCounterCount - overrides.vouchableMints);
}

/** What each illegible spelling MEANS, in the operator's terms and in terms of
 *  what to do about it. Named per spelling because the three have different
 *  causes and only one of them is a permissions problem. */
function describeIllegibleLedger(kind: OverrideProbe['ledger']): string {
  if (kind === 'corrupt') {
    return 'at least one line in it is not an override record — something appended to that file, or a line '
      + 'was edited. Lines that still parse are still honoured; what is lost is the guarantee that the file '
      + 'lists every mint.';
  }
  if (kind === 'unreadable') {
    return 'the file is there and could not be read (permissions, a directory in its place, or a symlink '
      + 'loop). Nothing is lost by fixing that — and the repair below deliberately refuses this state for '
      + 'exactly that reason.';
  }
  return 'it is larger than the reader will parse, so it is not parsed at all rather than parsed halfway. '
    + 'Look at the file: an audit ledger this big is either junk somebody wrote into it or a genuine history '
    + 'worth archiving by hand before it is replaced.';
}

export function buildFindings({
  node, nvm, gitnexus, project, codexHooks = null, oneMcp = null, openCodeMcp = null, sessionDiagnostics = null, pluginRoot = null,
  runDiagnostic = null, overrides = null, cursorEdges = null,
}: BuildFindingsInput): Finding[] {
  const findings: Finding[] = [];

  // Reported FIRST, above every environment finding: an override is the one
  // condition under which the rest of this report describes a project whose
  // enforcement was deliberately relaxed, and a reader who learns that after
  // scrolling past twenty toolchain findings has already drawn conclusions.
  if (overrides) {
    // The ledger's KIND, reported whether or not a reconciliation excuses it, and
    // whether or not any line happened to parse. Two spellings used to be
    // effectively silent: an `oversized` ledger parses no lines at all, so
    // `unvouchable` was 0 and the only trace was an info line about the
    // acknowledgement; and a `corrupt` one was reported as lines that "cannot be
    // verified against this install's key", which tells an operator their key was
    // rotated when what actually happened is that something wrote junk into an
    // audit file. An illegible ledger is also the state that switches the orphan
    // scan and the mint comparison off, so it is the one an operator most needs
    // named — including while it is excused, because an acknowledged blindfold is
    // still a blindfold.
    if (overrides.ledger !== 'ok' && overrides.ledger !== 'absent') {
      findings.push({
        severity: 'fix-needed',
        code: 'OVERRIDE_LEDGER_ILLEGIBLE',
        message: `The operator-override audit ledger for this project is \`${overrides.ledger}\`: `
          + `${describeIllegibleLedger(overrides.ledger)} While it reads this way the snapshot witness and the `
          + 'mint-count comparison are not asked, and the per-run abuse guard reads the same file, so nothing '
          + `here can tell you which runs were overridden. ${describeOverrideEvidence(overrides)}`,
      });
    }
    if (overrides.forgedLines > 0) {
      findings.push({
        severity: 'fix-needed',
        code: 'OVERRIDE_LEDGER_UNVERIFIED',
        // Never a silent drop. The gates already ignore these lines (an
        // unverifiable token is absent, full stop), so this finding is the ONLY
        // way anyone learns the file was written by something that did not hold
        // the per-install key — or that the key itself was replaced, which
        // invalidates every override previously minted on this machine.
        message: `${overrides.forgedLines} operator-override ledger line(s) parse as tokens and cannot be verified against this install's key, so they are being IGNORED. Either the per-install key under the machine dir was rotated/restored from another machine, or something signed that file with a different secret. No enforcement is relaxed by these lines.`,
      });
    }
    for (const token of overrides.active) {
      findings.push({
        severity: 'fix-needed',
        code: 'OPERATOR_OVERRIDE_ACTIVE',
        message: `An operator override is live: gate \`${token.target}\` is not enforced for run \`${token.runId}\` until ${token.expiresAt} (token ${token.id}). That run can never settle as verified or shipped.`,
      });
    }
    if (overrides.runMinted > 0 && !overrides.active.length) {
      findings.push({
        severity: 'info',
        code: 'OPERATOR_OVERRIDE_SPENT',
        message: `${overrides.runMinted} operator override(s) were minted for this run and have expired. Enforcement is back on, but the run remains permanently ineligible for verified/shipped.`,
      });
    }
    // The counts above describe what the override record SAYS. This describes
    // whether it is still a complete account of itself — and it is the reason
    // this block exists at all: settlement refuses the whole project on these
    // ids, so a report that omitted them would print HEALTHY at exactly the
    // moment nothing can be certified, which is the one outcome the record is
    // supposed to make impossible.
    // The mint counter, said out loud in the two states where it is the ONLY
    // remaining witness and nothing else here would mention it: a counter that
    // cannot be verified or read, and a counter that can never advance again. The
    // second is the one worth a finding of its own — `schemaVersion` set to an
    // unknown integer in `one.json` freezes it while every read reports a signed,
    // healthy number, so the report said HEALTHY about a witness that had been
    // switched off. Neither refuses certification (shared/override/
    // mint-counter.ts states why); a mint is refused instead.
    if (overrides.mintCounterWritable === false
      || overrides.mintCounter === 'unverifiable'
      || overrides.mintCounter === 'unreadable') {
      findings.push({
        severity: 'fix-needed',
        code: 'OVERRIDE_MINT_COUNTER_UNUSABLE',
        message: `This project's signed operator-override mint counter is \`${overrides.mintCounter}\``
          + `${overrides.mintCounterWritable === false ? ' and its file will not accept a write' : ''}. `
          + 'That counter lives in the machine-wide `~/.traffic-one/one.json` and is the only witness to a '
          + 'minted override that survives deleting the override folder, so while it reads this way an '
          + 'erasure there would leave nothing behind. A new override cannot be minted until it is fixed. '
          + `${describeOverrideEvidence(overrides)}`,
      });
    }
    if (overrides.discrepancies.length > 0) {
      findings.push({
        severity: 'fix-needed',
        code: 'OVERRIDE_EVIDENCE_INCOMPLETE',
        message: `The operator-override record for this project no longer accounts for itself (${overrides.discrepancies.join(', ')}), so NO run in this project can settle as verified or shipped. ${describeOverrideEvidence(overrides)} This is deliberate and permanent until an operator reconciles it from a terminal; the repair records what happened, it does not erase it. BEFORE RUNNING IT: it is not free and it is not undoable — a reconciliation permanently refuses verified/shipped for EVERY run this project already has on disk (an erased line took its run id with it, so there is no way to forgive one run without forgiving all of them), and it pins this project's mint counter. Work started after it certifies normally. It refuses outright when the record is merely unreadable, which is the case worth checking first.`,
        recommendedCommand: overrides.repairCommand,
      });
    }
    if (overrides.duplicateLines > 0) {
      findings.push({
        severity: 'fix-needed',
        code: 'OVERRIDE_LEDGER_DUPLICATED',
        // Counted once by every witness, so no verdict moves — which is exactly
        // why it has to be said out loud. No honest mint writes a line twice.
        message: `${overrides.duplicateLines} operator-override ledger line(s) are byte-identical copies of another line. Each signed mint is counted once regardless, so nothing is relaxed by the copies, but something rewrote that file.`,
      });
    }
    if (overrides.excused.length > 0) {
      findings.push({
        severity: 'info',
        code: 'OVERRIDE_EVIDENCE_RECONCILED',
        // Says WHICH state is held still, rather than "any further change refuses
        // again" — the earlier wording promised a boundary the acknowledgement did
        // not have, and three overrides went through underneath it. What it
        // actually pins is enumerated because that list is the guarantee.
        message: `An operator reconciled this project's override record: ${overrides.excused.join(', ')} ${overrides.excused.length === 1 ? 'is' : 'are'} accounted for by a signed acknowledgement, and the runs that existed when it was signed stay permanently ineligible for verified/shipped. The acknowledgement pins the exact state it forgave — the ledger's bytes, the snapshot files present, and this project's mint counter and its value — so a later mint, a new or removed snapshot, an edited ledger or a counter that disappears all refuse again. It does not cover runs started afterwards: those certify normally, which is the point of the repair. ${describeOverrideEvidence(overrides)}`,
      });
    }
  }
  const rawState = project.state && typeof project.state === 'object' ? project.state : null;
  const state = normalizedProjectState(project as unknown as Rec);
  const provider = state && typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const pluginUse = project.localPreferences?.pluginUse && typeof project.localPreferences.pluginUse === 'object'
    ? project.localPreferences.pluginUse as Rec
    : null;
  const pluginExplicitlyDeclined = pluginUse?.enabled === false;

  if (project.legacyCapabilityMigration.status === 'auto-correctable') {
    findings.push({
      severity: 'info',
      code: 'LEGACY_CUSTOM_BACKEND_SAFE_MIGRATION',
      message: 'Legacy custom-backend + react-vite state has no frontend artifacts. Runtime will safely normalize frontend to none at the next parent SessionStart; Doctor remains read-only.',
    });
  } else if (project.legacyCapabilityMigration.status === 'ambiguous') {
    findings.push({
      severity: 'fix-needed',
      code: 'LEGACY_CUSTOM_BACKEND_AMBIGUOUS',
      message: `Legacy custom-backend + react-vite state was not changed: ${project.legacyCapabilityMigration.message || 'frontend evidence is ambiguous'}. Confirm the intended surface after the active run settles; no mid-run migration is allowed.`,
    });
  }

  // Report-only, never a deny — the plan is explicit that the allowlist making
  // `doctor` undeniable does not exist yet, so denying here would block the
  // very command that diagnoses it. A 'source' layout (the authoring checkout,
  // or `dist/` before its first build) is normal and gets no finding; only an
  // 'unverified' root (nothing recognizable at the resolved path) or two
  // present-but-disagreeing build-provenance.json copies (a stale mixed
  // install — see plugin-root-probe.ts) are worth surfacing.
  if (pluginRoot) {
    if (pluginRoot.layout === 'unverified') {
      findings.push({
        severity: 'fix-needed',
        code: 'PLUGIN_ROOT_UNVERIFIED',
        message: `The resolved plugin root (${pluginRoot.root}, from ${pluginRoot.source === 'default' ? 'the runtime\'s own location' : pluginRoot.source}) contains neither a compiled runtime (scripts/hook-runtime.cjs) nor generated content (rules/ or skills-catalog/) nor the source checkout markers. Materialization and prose lookups will silently resolve zero rules/skills against this root. Reinstall or update the plugin, or unset a stale *_PLUGIN_ROOT override.`,
      });
    } else if (pluginRoot.layerMismatch) {
      findings.push({
        severity: 'info',
        code: 'PLUGIN_ROOT_LAYER_MISMATCH',
        message: `The resolved plugin root's content subtree (${pluginRoot.contentProvenancePath}: git ${pluginRoot.contentProvenance?.gitSha ?? 'unknown'}) and its runtime subtree (${pluginRoot.runtimeProvenancePath}: git ${pluginRoot.runtimeProvenance?.gitSha ?? 'unknown'}) were built from different sources. New gate logic may be running against old prose/binaries, or the reverse. Reinstall or update the plugin so both subtrees come from the same build.`,
      });
    }
  }

  if (runDiagnostic) findings.push(...runDiagnosticFindings(runDiagnostic));

  if (sessionDiagnostics) {
    if (sessionDiagnostics.found === false) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_SESSION_NOT_FOUND',
        message: `Could not find Codex session ${sessionDiagnostics.id} under ${sessionDiagnostics.sessionsDir}.`,
      });
    } else {
      if (sessionDiagnostics.hookPayloadCount === 0
        && !pluginExplicitlyDeclined
        && codexHooks?.pluginEnabled !== false) {
        findings.push({
          severity: 'info',
          code: 'CODEX_HOOK_OUTPUT_NOT_OBSERVED_FOR_SESSION',
          message: `Codex session ${sessionDiagnostics.id} contains no attributable Traffic One hook-output evidence for cwd ${sessionDiagnostics.cwd || '(unknown)'}. Hooks may have returned only intentional no-ops; use the config and trust findings to determine whether hooks were unavailable.`,
        });
      }
    }
  }

  if (oneMcp) {
    for (const host of oneMcp.hosts) {
      const sync = host.lastSync;
      if (!sync) continue;
      const versions = `requested version ${sync.requestedVersion}, observed version ${sync.observedVersion}`;
      const source = host.catalogSource === 'one-mcp'
        ? 'The current runtime source is the last valid cached One MCP catalog.'
        : 'The current runtime source is the bundled catalog.';
      if (sync.outcome === 'invalid-response') {
        findings.push({
          severity: 'info',
          code: 'ONE_MCP_CONFIG_REJECTED',
          message: `One MCP rejected ${host.host} configuration ${host.configName} (${sync.reason || 'invalid-response'}; ${versions}). ${source}`,
        });
      } else if (sync.outcome === 'config-not-found') {
        findings.push({
          severity: 'info',
          code: 'ONE_MCP_CONFIG_NOT_FOUND',
          message: `One MCP configuration ${host.configName} for ${host.host} was not published (${versions}). ${source}`,
        });
      } else if (sync.outcome === 'temporary-error' || sync.outcome === 'unavailable') {
        findings.push({
          severity: 'info',
          code: 'ONE_MCP_SYNC_UNAVAILABLE',
          message: `One MCP sync for ${host.host} was temporarily unavailable (${sync.reason || sync.outcome}; ${versions}). ${source}`,
        });
      }
    }
  }

  if (codexHooks) {
    const hookTrust = codexHooks.hookTrust;
    if (codexHooks.pluginEnabled !== true) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_TRAFFIC_ONE_HOOKS_DISABLED',
        message: 'Traffic One is not enabled in Codex config, so its hooks are not runnable.',
      });
    }
    if (hookTrust.evaluation === 'indeterminate') {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_HOOK_TRUST_INDETERMINATE',
        message: `Codex hook trust could not be verified through the official hooks/list API (${hookTrust.reason}${hookTrust.detail ? `: ${hookTrust.detail}` : ''}). Structural config alone is not proof that Traffic One hooks are runnable.`,
      });
    } else {
      if (
        hookTrust.counts.discovered !== hookTrust.expectedCount
        || hookTrust.missingKeys.length > 0
        || hookTrust.unexpectedKeys.length > 0
      ) {
        const missing = hookTrust.missingKeys.length > 0 ? ` Missing: ${hookTrust.missingKeys.join(', ')}.` : '';
        const unexpected = hookTrust.unexpectedKeys.length > 0 ? ` Unexpected: ${hookTrust.unexpectedKeys.join(', ')}.` : '';
        findings.push({
          severity: 'fix-needed',
          code: 'CODEX_TRAFFIC_ONE_HOOK_ABI_MISMATCH',
          message: `Codex discovered ${hookTrust.counts.discovered}/${hookTrust.expectedCount} exact Traffic One hook keys.${missing}${unexpected}`,
        });
      }
      if (codexHooks.pluginEnabled === true && hookTrust.counts.disabled > 0) {
        findings.push({
          severity: 'fix-needed',
          code: 'CODEX_TRAFFIC_ONE_HOOKS_DISABLED',
          message: `${hookTrust.counts.disabled} Traffic One Codex hook${hookTrust.counts.disabled === 1 ? ' is' : 's are'} disabled.`,
        });
      }
      if (
        hookTrust.counts.modified > 0
        || hookTrust.counts.untrusted > 0
        || hookTrust.counts.runnable !== hookTrust.expectedCount
      ) {
        findings.push({
          severity: 'fix-needed',
          code: 'CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED',
          message: `Traffic One Codex hooks are not fully trusted (${hookTrust.counts.modified} modified, ${hookTrust.counts.untrusted} untrusted, ${hookTrust.counts.runnable}/${hookTrust.expectedCount} runnable).`,
        });
      }
    }
    if (codexHooks.trustCovered === false) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_WORKSPACE_UNTRUSTED',
        message: `Current workspace (${codexHooks.cwd}) is not covered by a trusted Codex project root. Codex may skip plugin hooks here; trust this workspace or a parent directory before starting Traffic One work.`,
      });
    }
  }

  if (cursorEdges?.cursorPresent) {
    if (cursorEdges.stateDbReadable && cursorEdges.thirdPartyExtensibilityEnabled !== true) {
      const db = cursorEdges.stateDbPath ?? 'Cursor state.vscdb';
      findings.push({
        severity: 'fix-needed',
        code: 'CURSOR_THIRD_PARTY_EXTENSIBILITY_OFF',
        message: `Cursor's UI, rules, and MCP can look installed while hooks are silently dead: \`thirdPartyExtensibilityEnabled\` is not \`true\` in ${db} (a missing key counts as off — a Claude install does not write this flag). Enable third-party extensibility in Cursor. Do not turn that setting off to hide a duplicate-hook symptom.`,
      });
    }
    if (cursorEdges.localInstallPresent && cursorEdges.claudeCachePresent) {
      const local = cursorEdges.localInstallPath ?? '~/.cursor/plugins/local/traffic-one';
      findings.push({
        severity: 'fix-needed',
        code: 'CURSOR_LOCAL_AND_IMPORTED',
        message: `Traffic One is present both as a Cursor Local plugin (${local}) and as an imported Claude user-scope bundle. Every hook fires twice. Remove the Local copy and keep the imported Claude bundle; do not add the plugin again via /add-plugin.`,
      });
    }
  }

  if (rawStateHasLegacyShape(rawState)) {
    findings.push({
      severity: 'fix-needed',
      code: 'LEGACY_TRAFFIC_ONE_STATE',
      message: '`.traffic-one/.one.json` uses legacy/ad hoc fields such as `projectMode`, `subagentTeam`, root `codeGraph`, or nested `stack`. Rewrite it to the canonical top-level Traffic One schema.',
    });
  }

  const legacyLocalFields = rawState && typeof rawState === 'object'
    ? ['openCode', 'codeGraphProvider', 'performance', 'team', 'toolchain', 'codeGraphAutoRun', 'graphifyAutoRun']
      .filter((field) => Object.prototype.hasOwnProperty.call(rawState, field))
    : [];
  if (legacyLocalFields.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'LOCAL_PREFERENCES_IN_PROJECT_STATE',
      message: `Project state contains local-only Traffic One fields (${legacyLocalFields.join(', ')}). They should live in the per-user preferences file${project.localPreferencesPath ? ` (${project.localPreferencesPath})` : ''}, not in committed \`.traffic-one/.one.json\`.`,
    });
  }

  if (rawState && Object.prototype.hasOwnProperty.call(rawState, 'codeGraphProvider')) {
    const canonicalProvider = codeGraphProviderFromValue(rawState.codeGraphProvider);
    if (canonicalProvider && rawState.codeGraphProvider !== canonicalProvider) {
      findings.push({
        severity: 'fix-needed',
        code: 'NONCANONICAL_CODE_GRAPH_PROVIDER',
        message: `\`codeGraphProvider\` is ${JSON.stringify(rawState.codeGraphProvider)}; write the canonical lower-case value "${canonicalProvider}".`,
      });
    }
  }

  const stateIssues = onboardingStateIssues(rawState, state);
  if (stateIssues.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'INCOMPLETE_ONBOARDING_STATE',
      message: `Traffic One new-project onboarding state is incomplete or noncanonical: missing/invalid ${stateIssues.join(', ')}. Re-run onboarding and do not continue until Agent Mode, Team Confirmation, project context, Mobile, and Code Graph are resolved.`,
    });
  }

  const runState = project.runState;
  // A registered agent or a held claim IS orchestration in progress, even
  // before the first assignment or digest is written — and the run probe is
  // the only thing that can see them (runState only knows about assignment/
  // digest FILES). Without this, doctor read a run with three registered
  // agents as a ghost and advised clearing its id, which is the single most
  // destructive thing an operator could do to a live run.
  const runHasRegisteredWork = Boolean(
    runDiagnostic
    && runDiagnostic.runId === runState?.currentRunId
    && runDiagnostic.runDirExists
    && (runDiagnostic.liveAgents.length > 0 || runDiagnostic.claims.length > 0),
  );
  if (runState?.currentRunId) {
    if (!runState.runDirExists) {
      findings.push({
        severity: 'fix-needed',
        code: 'GHOST_CURRENT_RUN_ID',
        message: `\`.traffic-one/.one.json\` currentRunId=${JSON.stringify(runState.currentRunId)} points to no \`.traffic-one/runs/${runState.currentRunId}/\` directory. Doctor is report-only: after confirming no live agents are using it, clear or rotate the run id explicitly.`,
      });
    } else if (!runState.hasOrchestratedArtifacts && runState.maintenanceTerminalOrFallbackPending) {
      findings.push({
        severity: 'info',
        code: runState.maintenanceFallbackAllowed ? 'MAINTENANCE_FALLBACK_PENDING' : 'MAINTENANCE_RUN_TERMINAL',
        message: `currentRunId=${JSON.stringify(runState.currentRunId)} has maintenance metadata (${runState.maintenanceOverallOutcome || runState.maintenanceOutcome || runState.maintenanceOpencodeOutcome || 'unknown'}). This is not a ghost run; Doctor will not rewrite it automatically.`,
      });
    } else if (!runState.hasOrchestratedArtifacts && runState.runJsonStatus !== 'planned' && runHasRegisteredWork) {
      findings.push({
        severity: 'info',
        code: 'RUN_ORCHESTRATION_IN_PROGRESS',
        message: `currentRunId=${JSON.stringify(runState.currentRunId)} has no assignments/digests yet, but the run probe found ${runDiagnostic?.liveAgents.length ?? 0} registered agent(s) and ${runDiagnostic?.claims.length ?? 0} held claim(s). This is not a ghost run — do not clear or rotate the id. See the RUN_* findings for its liveness.`,
      });
    } else if (!runState.hasOrchestratedArtifacts && runState.runJsonStatus !== 'planned') {
      findings.push({
        severity: 'fix-needed',
        code: 'GHOST_CURRENT_RUN_ID',
        message: `\`.traffic-one/.one.json\` currentRunId=${JSON.stringify(runState.currentRunId)} has no orchestrated artifacts (no assignments/digests) and is not a planned run ledger. Doctor will not rewrite it automatically; inspect the run directory, then clear or rotate the id if no live work depends on it.`,
      });
    } else if (runState.runJsonStatus === 'planned' && !runState.hasOrchestratedArtifacts) {
      findings.push({
        severity: 'info',
        code: 'PLANNED_RUN_LEDGER_ONLY',
        message: `currentRunId=${JSON.stringify(runState.currentRunId)} is a planned run ledger only. This is valid pre-orchestration state; \`run.json\` alone does not count as assignments or digests.`,
      });
    }
  }

  const nestedRoots = strayNestedTrafficOneRoots(project);
  if (nestedRoots.strays.length > 0) {
    findings.push({
      severity: 'fix-needed',
      code: 'NESTED_TRAFFIC_ONE_ROOTS',
      message: `Nested Traffic One state roots were found inside this workspace: ${nestedRoots.strays.join(', ')}. Hooks will not delete them automatically; inspect them, then use the cleanup runner in apply mode only after confirming the ancestor workspace root is the real project.`,
    });
  }
  if (nestedRoots.unknown) {
    findings.push({
      severity: 'info',
      code: 'NESTED_TRAFFIC_ONE_ROOTS_MEMBERSHIP_UNKNOWN',
      message: `This directory declares a workspace, but its member registry cannot be read (${nestedRoots.unknown.why}), so whether these nested Traffic One state roots belong to registered members is unknown: ${nestedRoots.unknown.roots.join(', ')}. No cleanup advice is offered for them, deliberately — the automatic sweep also withholds deletion under a registry it cannot enumerate, and a report that told you to delete by hand what the sweep spares would be the trap. Repair \`.one.json\` here (or restore it) and re-run doctor; the question is answerable once the registry parses.`,
    });
  }

  // The plugin's OWN runtime floor, asked before the GitNexus toolchain
  // questions below and independently of them: those ask whether a Node 22
  // exists somewhere for the code-graph provider (and the gitnexus hook can go
  // get one), this asks whether the process running the hooks is supported at
  // all. Unconditional on provider, because a machine below the floor is
  // unsupported whichever provider it chose — and reported rather than enforced,
  // because doctor is report-only and the launchers only warn (node-floor.ts).
  if (node.runningMajor !== null && node.runningMajor < node.pluginRequiredMajor) {
    findings.push({
      severity: 'fix-needed',
      code: 'HOOK_RUNTIME_NODE_BELOW_FLOOR',
      message: `The process running Traffic One is on Node ${node.runningVersion}, below the supported floor of Node ${node.pluginRequiredMajor} (\`engines.node\` in the plugin's package.json)`
        + `${node.onPath ? `; \`node\` resolves on this PATH to ${node.onPath}` : ' and no `node` was found on this PATH at all'}. `
        + `A host application launched from the desktop does not inherit a shell's PATH, so a terminal with Node ${node.pluginRequiredMajor} does not mean the hooks got it — an nvm-managed Node is invisible to a GUI launch. `
        + `Quit the host and relaunch it from a terminal, or install Node ${node.pluginRequiredMajor}+ on the system PATH; \`nvm alias default\` alone does not fix a GUI launch.`,
    });
  }

  if (node.runningMajor !== null && node.runningMajor < node.requiredMajor && provider === 'gitnexus') {
    if (nvm.installed && nvm.hasV22) {
      findings.push({
        severity: 'info',
        code: 'NODE_LT22_BUT_V22_AVAILABLE',
        message: `Hook process is on Node ${node.runningMajor} but nvm v22 (${nvm.v22Paths?.version}) is installed. The runner uses the absolute v22 path; no action required.`,
      });
    } else if (nvm.installed && !nvm.hasV22) {
      findings.push({
        severity: 'fix-needed',
        code: 'NVM_INSTALLED_NO_V22',
        message: `Hook process is on Node ${node.runningMajor} and nvm has no v22 installed. The GitNexus hook will try to prepare Node 22 automatically after provider approval; choose graphify if you need a provider that does not depend on Node 22.`,
      });
    } else {
      findings.push({
        severity: 'fix-needed',
        code: 'NO_NVM_NO_V22',
        message: `Hook process is on Node ${node.runningMajor} and nvm is not installed. Traffic One cannot prepare GitNexus automatically without a compatible Node 22 path; switch \`codeGraphProvider\` to "graphify" for a Python-based graph provider.`,
      });
    }
  }

  if (gitnexus.crashRiskInOldNvm) {
    findings.push({
      severity: 'fix-needed',
      code: 'GITNEXUS_IN_OLD_NVM_NODE',
      message: `\`gitnexus\` on PATH (${gitnexus.onPath}) lives in an old nvm Node folder — will crash with "SyntaxError: Cannot use import statement" when invoked. The onboarding hook will install a managed GitNexus copy when the provider is selected.`,
    });
  }

  if (provider === 'gitnexus' && isNewProjectMode(state) && project.nvmrc !== null && /^\d+\.\d+\.\d+$/.test(project.nvmrc) && !project.nvmrc.startsWith('22')) {
    findings.push({
      severity: 'fix-needed',
      code: 'NVMRC_PINNED_TO_OLD_NODE',
      message: `Project's .nvmrc pins Node ${project.nvmrc}, but gitnexus needs Node >=22. cd-ing into this project will yank Node down via nvm. Overwrite \`.nvmrc\` with \`22\` to lock the project to a compatible version.`,
    });
  }

  if (provider === 'gitnexus' && !project.hasGit && !project.artefacts.gitnexus) {
    findings.push({
      severity: 'info',
      code: 'NO_GIT_DIR',
      message: 'No `.git/` directory at project root. The runner auto-passes `--skip-git` to gitnexus for non-git folders; no action required unless you want git-aware analysis (then `git init`).',
    });
  }

  if (provider === 'gitnexus' && project.artefacts.gitnexus) {
    const ageDays = (Date.now() - project.artefacts.gitnexus.mtimeMs) / (24 * 60 * 60 * 1000);
    if (ageDays > 7) {
      findings.push({
        severity: 'info',
        code: 'GITNEXUS_STALE',
        message: `\`.traffic-one/.gitnexus/\` is ${Math.round(ageDays)} days old. The next build or session refreshes it automatically (the gitnexus runner rebuilds and relocates it under .traffic-one/).`,
      });
    }
  }

  if (state && typeof state.gitnexusLastError === 'string') {
    findings.push({
      severity: 'fix-needed',
      code: 'LAST_RUN_FAILED',
      message: `Most recent gitnexus runner failed: ${state.gitnexusLastError.split('\n')[0]}`,
    });
  }

  if (state && typeof state.graphifyLastError === 'string') {
    findings.push({
      severity: 'fix-needed',
      code: 'LAST_RUN_FAILED',
      message: `Most recent graphify runner failed: ${state.graphifyLastError.split('\n')[0]}`,
    });
  }

  if (rawState && !provider) {
    findings.push({
      severity: 'fix-needed',
      code: 'MISSING_CODE_GRAPH_PROVIDER',
      message: `No local code graph provider is configured for this user/project. Choose GitNexus or graphify and save it to local preferences${project.localPreferencesPath ? ` (${project.localPreferencesPath})` : ''}; do not commit this choice to \`.traffic-one/.one.json\`.`,
    });
  }

  // OpenCode delegation readiness. Only meaningful when the user enabled it in
  // the wizard; every finding here is self-healing (SessionStart re-registers
  // the Codex MCP server and re-attempts the managed install), so the messages
  // say what will happen automatically and what one-time action remains.
  const openCode = state && state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode?.enabled === true) {
    if (project.openCodeCli === 'missing') {
      findings.push({
        severity: 'fix-needed',
        code: 'OPENCODE_CLI_MISSING',
        tool: 'opencode',
        message: 'OpenCode delegation is enabled but the OpenCode CLI is not installed (managed install absent, nothing on PATH). The next session start auto-installs it in the background — make sure `npm` is on PATH. Until then every delegation falls back to a paid subagent.',
      });
    } else if (project.openCodeCli === 'path') {
      findings.push({
        severity: 'info',
        code: 'OPENCODE_CLI_UNMANAGED',
        tool: 'opencode',
        message: 'OpenCode delegation resolves a PATH-installed `opencode` (no Traffic One managed install), so its version is not pinned by the plugin. Works, but behavior may drift from the tested pinned version.',
      });
    }
    if (codexHooks && codexHooks.configExists && codexHooks.opencodeMcpRegistered === false) {
      findings.push({
        severity: 'fix-needed',
        code: 'CODEX_OPENCODE_MCP_NOT_REGISTERED',
        message: 'The opencode-worker MCP server is not registered in ~/.codex/config.toml, so the opencode_delegate tool is unavailable in Codex. The next session start registers it automatically; restart Codex once afterwards to load it.',
      });
    }
    if (openCodeMcp && !openCodeMcp.binShimExists) {
      findings.push({
        severity: 'fix-needed',
        code: 'CURSOR_OPENCODE_MCP_UNHEALTHY',
        message: `The version-stable opencode-worker MCP shim is missing at ${openCodeMcp.binShimPath}. Cursor launches MCP with CWD=$HOME and no plugin root — without this shim the server dies on startup (toolCount:0). Reload the window after sessionStart or run onboarding so Traffic One writes ~/.traffic-one/bin shims.`,
        recommendedCommand: 'node "${TRAFFIC_ONE_PLUGIN_ROOT:-.}/scripts/hook-runtime.cjs" session-start',
      });
    } else if (openCodeMcp && !openCodeMcp.pluginShimExists && openCodeMcp.pluginShimPath) {
      findings.push({
        severity: 'info',
        code: 'CURSOR_OPENCODE_MCP_UNHEALTHY',
        message: `opencode-worker plugin shim not found at ${openCodeMcp.pluginShimPath}; the bin fallback at ${openCodeMcp.binShimPath} should still work when present.`,
      });
    }
  }

  // Toolchain version drift. Walk `state.toolchain.*` against the toolchain
  // spec and emit one finding per tool below `minimum` (fix-needed) or below
  // `recommended` (info nudge).
  try {
    const stamps = (state && state.toolchain && typeof state.toolchain === 'object' ? state.toolchain : {}) as Rec;
    for (const [name, stampRaw] of Object.entries(stamps)) {
      const stamp = stampRaw && typeof stampRaw === 'object' ? (stampRaw as Rec) : {};
      const status = toolStatus(name, stamp.installedVersion);
      if (status.status === 'too-old' || status.status === 'outdated') {
        const severity: Finding['severity'] = status.status === 'too-old' ? 'fix-needed' : 'info';
        findings.push({
          severity,
          code: 'TOOLCHAIN_OUTDATED',
          tool: name,
          message: `${name} ${status.installed} installed; ${status.status === 'too-old' ? `minimum supported is ${status.minimum}` : `recommended is ${status.recommended}`}. Traffic One hooks install/upgrade selected tools automatically.`,
        });
      }
    }
  } catch {
    // toolchain spec missing or malformed; never block doctor on it.
  }

  return findings;
}
