// src/modules/agent-model/spawn-bootstrap.ts
// The single derivation of a spawn's bootstrap-publish inputs, and the
// quick-fix scope regrant the reuse gate performs on its way to a DENY.
//
// TWO gates publish an envelope from the SAME spawn: handler.ts's allowSpawn on
// the way to an ALLOW, and gate-reuse.ts when a duplicate `quick-fix` spawn
// carries a `[t1-bounded-scope]` marker the live agent's contract does not
// cover. Every field below feeds `hashEnvelope`, so a second, hand-copied
// derivation of the host, the canonical agent type, the evidence source or the
// bounded scope would republish a DIFFERENT envelope for the same spawn and
// leave the two gates disagreeing about what the child may write.

import type { Ctx } from '../../core/types';
import type { Rec } from '../../shared/obj';
import { canonicalHost } from '../../shared/model-tiers';
import { canonicalHostAgentType } from '../../shared/host/spawn-types';
import { readRunHostCapability } from '../../shared/host/capabilities';
import {
  readCompiledArchitecture,
  readRuntimeAssignments,
} from '../../shared/architecture-contract';
import {
  boundedMaintenanceSourceScope,
  ensureRunBootstrap,
  pendingMaintenanceDebtSources,
  readActiveRunBootstrap,
  roleOwesPendingMaintenanceFallback,
  type EnsureRunBootstrapOptions,
} from '../../shared/run-bootstrap-policy';
import { quickFixScopeFromSpawn, spawnAgentType } from './spawn-shape';

export interface SpawnBootstrapInput {
  ctx: Ctx;
  cwd: string;
  toolInput: Rec;
  role: string;
  /** `roleEvidence.source` — how this spawn's role was identified. */
  evidenceSource: string;
  runId: string;
  modelPolicyId: string;
  spawnPromptText: string;
}

export type SpawnBootstrapPlan =
  | { readonly kind: 'capability-missing' }
  | {
      readonly kind: 'plan';
      readonly options: EnsureRunBootstrapOptions;
      /** Did a bounded maintenance scope resolve at all? handler.ts's
       *  no-scope deny turns on exactly this. */
      readonly boundedScope: readonly string[] | null;
      /** The spawn carried a VALID `[t1-bounded-scope]`/`allowedFiles` scope of
       *  its own, as opposed to inheriting one from a debt or a live envelope. */
      readonly markerScope: boolean;
    };

export function spawnBootstrapPlan(input: SpawnBootstrapInput): SpawnBootstrapPlan {
  const { ctx, cwd, toolInput, role, runId } = input;
  const capability = readRunHostCapability(cwd, runId, ctx.host);
  if (!capability) return { kind: 'capability-missing' };
  // A spawn that fell back to the host's built-in generic worker (because this
  // session's accepted-type set predates the materialized agent files) is the
  // SAME work unit as the typed spawn. Canonicalize it so both paths resolve
  // the bootstrap the parent already published for this role.
  const hostAgentType = canonicalHostAgentType(
    ctx.host,
    role,
    spawnAgentType(toolInput, { includeRoleAlias: false }).trim(),
    capability.typedSubagents === true,
    cwd,
  );
  const activeRoleBootstrap = readActiveRunBootstrap(cwd, runId, role);
  const activeBoundedMaintenance = activeRoleBootstrap
    && (
      (role === 'quick-fix' && activeRoleBootstrap.workUnit.unitId === 'quick-fix:bootstrap')
      || activeRoleBootstrap.workUnit.unitId === `${role}:bounded-maintenance`
    )
    ? activeRoleBootstrap
    : null;
  const requestedQuickFixScope = role === 'quick-fix'
    ? quickFixScopeFromSpawn(toolInput, input.spawnPromptText)
    : null;
  const explicitQuickFixScope = requestedQuickFixScope?.present
    ? (requestedQuickFixScope.valid ? requestedQuickFixScope : null)
    : null;
  // The union of every pending debt's pinned files takes precedence over
  // the active envelope's scope: `active.json` holds whichever unit's
  // envelope was published LAST, so a paid child bound from it could only
  // ever discharge that one debt and the run stayed `fallback-pending`
  // forever. The union covers the single-debt case identically (union of
  // one = that debt), and `fallbackContractMatches` admits exactly it.
  const pendingDebtSources = !requestedQuickFixScope?.present && role !== 'quick-fix'
    ? pendingMaintenanceDebtSources(cwd, runId, role)
    : null;
  const boundedMaintenanceOutputs = explicitQuickFixScope?.outputs
    || pendingDebtSources
    || (!requestedQuickFixScope?.present && activeBoundedMaintenance
      ? boundedMaintenanceSourceScope(
          runId,
          role,
          activeBoundedMaintenance.workUnit.outputs,
        )
      : undefined)
    || null;
  return {
    kind: 'plan',
    boundedScope: boundedMaintenanceOutputs,
    markerScope: Boolean(explicitQuickFixScope),
    options: {
      host: canonicalHost(ctx.host),
      hostAgentType,
      evidenceSource: input.evidenceSource,
      modelPolicyId: input.modelPolicyId,
      ...(boundedMaintenanceOutputs
        ? {
            boundedOutputs: boundedMaintenanceOutputs,
            boundedAllowlist: explicitQuickFixScope?.allowlist
              || pendingDebtSources
              || (activeBoundedMaintenance
                ? boundedMaintenanceSourceScope(
                    runId,
                    role,
                    activeBoundedMaintenance.workUnit.allowlist,
                  )
                : undefined)
              || boundedMaintenanceOutputs,
            boundedAllowlistExclude: explicitQuickFixScope?.exclude
              || (pendingDebtSources ? [] : activeBoundedMaintenance?.workUnit.allowlistExclude)
              || [],
          }
        : {}),
    },
  };
}

/**
 * May a `[t1-bounded-scope]` marker on a DUPLICATE spawn widen the live agent's
 * contract, and did it?
 *
 * The reuse gate refuses the duplicate spawn before allowSpawn ever runs, so
 * without this the marker is silently discarded and the orchestrator's only
 * remaining move is `[t1-replace-agent]` — destroying a live agent's context to
 * achieve a scope change. Three conditions make the regrant legitimate, and all
 * three are read from disk rather than from the spawn's prose:
 *
 *   - `role === 'quick-fix'`. The marker is parsed for that role ONLY
 *     (handler-side `explicitQuickFixScope` is gated on it), so for quick-fix
 *     the marker IS the origin of the bounded envelope, not a widening of an
 *     envelope some other authority granted. For a senior implementer the only
 *     origin is a pending OpenCode fallback debt, and widening THAT is what
 *     `fallbackContractMatches` exists to refuse.
 *   - No compiled architecture and no published runtime assignments. A run that
 *     has either holds an authority the marker must not override.
 *   - The role owes no PENDING maintenance fallback. This is the SAME predicate
 *     the enforcer asks: `fallbackContractMatches` returns true immediately
 *     when `!roleOwesPendingMaintenanceFallback(cwd, runId, role)` and
 *     otherwise admits only the debts' own pinned scope. Offering a regrant on
 *     any other question would make this gate and the publisher disagree.
 *
 * `ensureRunBootstrap` is the publisher either way: it is fenced, reads the
 * envelope back and hash-verifies it, and returns null on refusal. A refusal is
 * REPORTED (`refused`), never minted as an applied write — the widening did not
 * happen and an orchestrator told otherwise hands the child a file list every
 * write gate will deny.
 */
export type QuickFixScopeRegrant =
  | { readonly status: 'applied'; readonly files: readonly string[] }
  | { readonly status: 'refused'; readonly files: readonly string[] };

export function quickFixScopeRegrant(
  input: SpawnBootstrapInput,
  state: unknown,
): QuickFixScopeRegrant | null {
  const { cwd, role, runId } = input;
  if (role !== 'quick-fix' || !input.modelPolicyId.trim()) return null;
  const requested = quickFixScopeFromSpawn(input.toolInput, input.spawnPromptText);
  if (!requested.present || !requested.valid) return null;
  if (readRuntimeAssignments(cwd, runId) || readCompiledArchitecture(cwd, runId)) return null;
  if (roleOwesPendingMaintenanceFallback(cwd, runId, role)) return null;
  const plan = spawnBootstrapPlan(input);
  if (plan.kind !== 'plan' || !plan.markerScope) return null;
  const previous = readActiveRunBootstrap(cwd, runId, role)?.envelopeHash ?? null;
  // fsjson's writers rethrow every errno but ELOOP, so an unwritable bootstrap
  // directory would leave this gate as a fail-closed `pipeline-handler-crashed`
  // — a crash deny in place of a refusal that has a real remedy. The publish is
  // an OPTIONAL improvement on the deny about to be returned, so a throw is the
  // same answer as a null: the widening did not land. Same escape
  // `repairRunBootstrapForBoundChild` takes around its own publish.
  let envelope: ReturnType<typeof ensureRunBootstrap> = null;
  try {
    envelope = ensureRunBootstrap(cwd, runId, role, state, plan.options);
  } catch {
    envelope = null;
  }
  if (!envelope) return { status: 'refused', files: requested.allowlist };
  // Republishing the SAME envelope granted nothing, so there is no regrant to
  // announce and the ordinary duplicate-spawn deny is already the whole truth.
  if (envelope.envelopeHash === previous) return null;
  return {
    status: 'applied',
    files: boundedMaintenanceSourceScope(runId, role, envelope.workUnit.allowlist),
  };
}
