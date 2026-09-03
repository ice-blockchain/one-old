// src/shared/host/capability-flags.ts
// ONE record of host quirks, so a gate branches on WHAT a host does rather than
// on which host it is.
//
// The problem this replaces: `if (ctx.host === 'codex')` states a fact about
// Codex nowhere in particular. The reason lives in a comment beside one of the
// call sites, if it lives anywhere, and the next host with the same quirk gets
// added to whichever conditions somebody remembered. Reading the union of what
// Traffic One believes about a host meant grepping for its name across 87 files.
// A named flag moves the fact here, once, with the evidence for it, and leaves
// the call site saying what it actually means.
//
// Deliberately NOT part of HostCapabilityContractV1 (capability-schema.ts).
// That record is the per-run ENFORCEMENT contract: it is written to
// `.traffic-one/runs/<id>/host-capability.json`, hash-pinned
// (stableCapabilityContractHash), tamper-evidenced (evidenceHash) and
// schema-versioned at 1. Product quirks are not enforcement evidence, and
// spreading them into that artifact would churn every published sidecar's hash
// while adding fields the contract hash deliberately does not cover.
//
// ── The one rule for adding a flag ──────────────────────────────────────────
// Name the QUIRK, not the norm, so the flag is TRUE for the few hosts that have
// it and FALSE for everyone else — including a host with no row at all
// (`hostFlags()` answers false for an unknown string). That is what makes each
// migration provably behaviour-neutral: `host === 'codex'` and
// `hostFlags(host).sandboxNeedsEscalation` agree for every input, known or not,
// whereas a norm-shaped flag (`followsRoutingDocs`) would silently flip
// behaviour for an unrecognized host. A flag phrased as a capability the
// majority HAS is the one shape to reject in review.

import type { TrafficOneHost } from './capability-schema';

export interface HostCapabilityFlags {
  /**
   * The host IS an OpenCode-compatible agent, so offloading work to OpenCode
   * would be self-delegation (a worker spawning itself). Everything about the
   * OpenCode delegation feature stands down: the wizard question is not asked,
   * the toolchain is not installed, roles are not routed to it, and a plan that
   * carries an `opencode-delegate` queue is denied.
   */
  opencodeSelfHosted: boolean;
  /**
   * The host cannot tell Traffic One which model a spawned child actually got,
   * so the user has to confirm the model choice in chat and the build pauses
   * until they reply. (Cursor: the Task tool exposes a model picker whose ids
   * are only observable at spawn request time.)
   */
  modelChoiceNeedsUserReply: boolean;
  /**
   * The exact model ids offered to subagents must be captured from the host UI
   * before a run's model policy can be frozen — they are not enumerable from
   * any API.
   */
  availableModelsMustBeCaptured: boolean;
  /**
   * Tools run inside a workspace-scoped sandbox that must be escalated
   * explicitly for two routine things: binding a loopback port (the Lighthouse
   * preview server dies with `listen EPERM`) and writing outside the workspace
   * (`~/.traffic-one`, where the use-plugin choice is stored). Prose that tells
   * the agent to run a command has to name the escalation, or the command
   * fails and the agent reports a false negative.
   */
  sandboxNeedsEscalation: boolean;
  /**
   * The host's agent treats ANY gate deny as terminal: it stops the turn and a
   * non-technical user is left with no way to continue. Advisory,
   * token-optimizing gates must degrade to a nudge here instead of blocking;
   * correctness gates still block.
   */
  denyEndsTheTurn: boolean;
  /**
   * The host exposes no task-completion or resume lifecycle to a plugin, so a
   * finished child can leave a fresh `claimed` record behind. Claim-based
   * suppression cannot be trusted as proof that a worker is still live.
   */
  noTaskCompletionLifecycle: boolean;
  /**
   * A native write arrives with no agent identity attached, so an anonymous
   * pending claim is the legitimate shape of a real write rather than evidence
   * of a missing role binding.
   */
  nativeWritesCarryNoAgentIdentity: boolean;
  /**
   * The host's agent does not act on the materialized guidance — neither the
   * AGENTS.md read-routing that tells every other host to spawn the architect
   * first, nor the React/Vite stack rules. Observed on Devin Local's SWE-tier
   * agent: it jumps straight to an off-stack scaffolder (`create-next-app`).
   * Traffic One compensates twice, so both sites read from this one flag: it
   * front-loads the architect-first directive before the spawn, and it keeps a
   * scaffolder gate as the hard backstop.
   */
  ignoresMaterializedGuidance: boolean;
  /**
   * The host's native subagent bootstrap is itself an enforcement point, so
   * publishing a child's bootstrap materials is observable capability evidence.
   * Must stay in step with `native-bootstrap` in the host's
   * HOST_CAPABILITIES.enforcementPoints (asserted in the tests).
   */
  nativeBootstrapEnforcementPoint: boolean;
  /**
   * Implementer work units are file-disjoint, so a digest retry cannot edit
   * the app shell. IMPLEMENTED may restore compiled route/orphan wiring in
   * place. Hosts without this quirk (Claude Code, Cursor, Codex) must not:
   * a hook rewrite of App.tsx is observed as an out-of-band file change, and
   * Claude Code then injects "modified by the user or a linter; the change is
   * intentional; do not mention this" — which workers report as sabotage.
   */
  disjointWorkUnitFiles: boolean;
  /**
   * The host prompts the user before a model `rm -rf` of build output
   * (`dist`, `.next`, `supabase/.temp`). That Allow dialog stalls the run.
   * Named for the quirk, not the majority: only Claude Code and Cursor do this.
   */
  shellRecursiveRmPromptsUser: boolean;
}

const NONE: HostCapabilityFlags = {
  opencodeSelfHosted: false,
  modelChoiceNeedsUserReply: false,
  availableModelsMustBeCaptured: false,
  sandboxNeedsEscalation: false,
  denyEndsTheTurn: false,
  noTaskCompletionLifecycle: false,
  nativeWritesCarryNoAgentIdentity: false,
  ignoresMaterializedGuidance: false,
  nativeBootstrapEnforcementPoint: false,
  disjointWorkUnitFiles: false,
  shellRecursiveRmPromptsUser: false,
};

export const HOST_CAPABILITY_FLAGS: Readonly<Record<TrafficOneHost, HostCapabilityFlags>> = {
  claude: { ...NONE, nativeBootstrapEnforcementPoint: true, shellRecursiveRmPromptsUser: true },
  codex: { ...NONE, sandboxNeedsEscalation: true },
  cursor: {
    ...NONE,
    modelChoiceNeedsUserReply: true,
    availableModelsMustBeCaptured: true,
    shellRecursiveRmPromptsUser: true,
  },
  opencode: { ...NONE, opencodeSelfHosted: true, disjointWorkUnitFiles: true },
  kilo: { ...NONE, opencodeSelfHosted: true, noTaskCompletionLifecycle: true, disjointWorkUnitFiles: true },
  copilot: { ...NONE },
  windsurf: {
    ...NONE,
    denyEndsTheTurn: true,
    nativeWritesCarryNoAgentIdentity: true,
    ignoresMaterializedGuidance: true,
  },
};

/**
 * The quirks of `host`, or none at all when the string names no host Traffic One
 * knows. Answering "no quirks" for an unknown host is what keeps every migrated
 * call site behaviour-identical to the host-name comparison it replaced — see
 * the rule at the top of this file. It is NOT a safety default: whether an
 * unrecognized host may run at all is the tier decision, in tiers.ts, which
 * fails closed on exactly this input.
 */
export function hostFlags(host: string | null | undefined): HostCapabilityFlags {
  if (!host) return NONE;
  return HOST_CAPABILITY_FLAGS[host as TrafficOneHost] ?? NONE;
}
