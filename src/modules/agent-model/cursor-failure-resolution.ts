// src/modules/agent-model/cursor-failure-resolution.ts
// Failure-to-resolution policy: API limits, model unavailability, and the
// generic path.

import {
  readRunModelPolicy,
  resolveRunPolicyFallback,
} from '../../shared/run-model-policy';
import {
  type CursorSpawnObservation,
} from '../../shared/state';
import {  type ModelFailureKind } from './failure-classify';
import {
  exhaustedModelsForRole,
} from './exhausted-models';
import {
  readModelChoice,
} from './model-choice';

import {
  CURSOR_FAILURE_BLOCK_FALLBACKS,
  block,
  type ParsedCursorTranscript,
} from './cursor-failure-prose';
import {
  exactRecommendedModel,
  sameFamily,
  unavailableModelsForRun,
} from './cursor-transcript';

interface FailureResolution {
  kind: ModelFailureKind;
  directive: string;
  prescribedModel: string | null;
  terminal: boolean;
  choicePrompted: boolean;
}

function apiResolution(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): FailureResolution {
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy || policy.host !== 'cursor') {
    return {
      kind: 'api-limit',
      prescribedModel: null,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One cannot resolve ${observation.role}'s retry because immutable model-policy.json is missing or corrupt for run ${runId}. Start a repaired parent run; do not consult mutable Cursor models.`,
    };
  }
  const captured = [...(policy.cursorAvailableModels || [])];
  const choice = readModelChoice(cwd, runId);
  const exhausted = [
    ...exhaustedModelsForRole(cwd, runId, observation.role),
    observation.requestedModel,
  ];
  const fallback = resolveRunPolicyFallback(policy, {
    tier: observation.tier,
    exhaustedModels: exhausted,
    unavailableModels: unavailableModelsForRun(cwd, runId),
    // Passing even an empty capture is intentional: a guessed family is not an
    // exact Cursor slug, and an absent family belongs to availability recovery.
    capturedModels: captured,
  });

  if (choice === 'enable-retry') {
    const recommended = exactRecommendedModel(policy, observation);
    return {
      kind: 'api-limit',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One recorded the run-level **enable** choice after ${observation.role}'s API/usage-limit failure. Restore API budget for **${recommended}** and retry this role on that exact Cursor slug; do not rotate to a fallback for this pending decision.`,
    };
  }

  if (fallback) {
    const composerFloor = /^composer/i.test(fallback.family);
    if (composerFloor && observation.tier !== 'cheapest') {
      if (choice !== 'use-fallback') {
        const recommended = exactRecommendedModel(policy, observation);
        return {
          kind: 'api-limit',
          prescribedModel: fallback.model,
          terminal: false,
          choicePrompted: true,
          directive: block('cursor-api-limit-composer-choice', {
            ROLE: observation.role,
            RECOMMENDED: recommended,
            FALLBACK: fallback.model,
          }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-composer-choice']),
        };
      }
    }
    return {
      kind: 'api-limit',
      prescribedModel: fallback.model,
      terminal: false,
      choicePrompted: false,
      directive: block('cursor-api-limit-auto-retry', {
        ROLE: observation.role,
        FAILED: observation.requestedModel,
        NEXT: fallback.model,
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-auto-retry']),
    };
  }

  const row = policy.tiers[observation.tier];
  const allActuallyLimited = row.length > 0
    && row.every((family) => exhausted.some((model) => sameFamily(model, family)));
  const composerWasAccepted = observation.tier === 'cheapest' || readModelChoice(cwd, runId) === 'use-fallback';
  if (allActuallyLimited && composerWasAccepted) {
    return {
      kind: 'api-limit',
      prescribedModel: null,
      terminal: true,
      choicePrompted: false,
      directive: block('cursor-api-limit-terminal', {
        ROLE: observation.role,
        TRIED: exhausted.join(', '),
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-terminal']),
    };
  }

  const unavailable = unavailableModelsForRun(cwd, runId);
  const firstUnavailable = row.find((family) => unavailable.some((model) => sameFamily(model, family))
    && !exhausted.some((model) => sameFamily(model, family)));
  if (firstUnavailable) {
    const recommended = exactRecommendedModel(policy, observation);
    return {
      kind: 'api-limit',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: true,
      directive: `Traffic One correlated ${observation.role}'s API-limit failure, but every remaining exact candidate in its original ${observation.tier} tier is explicitly model-unavailable. **enable** — Open Cursor Settings → Models, enable **${recommended}** and restore its API budget, then reply **enable**; I’ll retry that exact recommended slug. This is an availability flow, not “all models exhausted”. The unavailable tier candidate was **${firstUnavailable}**.`,
    };
  }

  const firstAbsent = row.find((family) => !captured.some((model) => sameFamily(model, family))
    && !exhausted.some((model) => sameFamily(model, family)));
  if (firstAbsent) {
    const recommended = exactRecommendedModel(policy, observation);
    return {
      kind: 'api-limit',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: true,
      directive: `Traffic One correlated ${observation.role}'s API-limit failure, but no exact captured fallback remains in its original ${observation.tier} tier. **${firstAbsent}** is absent from Cursor's captured model list, so this is an availability decision, not “all models exhausted”. **enable** — Open Cursor Settings → Models, enable/re-capture **${recommended}** and restore its API budget, then reply **enable**; I’ll retry that exact recommended slug. Do not guess a slug or silently change tiers.`,
    };
  }

  return {
    kind: 'api-limit',
    prescribedModel: null,
    terminal: false,
    choicePrompted: false,
    directive: `Traffic One correlated ${observation.role}'s API-limit failure, but could not resolve an exact next Cursor slug from the role's original ${observation.tier} tier. Refresh the captured Cursor model list and use generic recovery; do not infer a model switch from the transcript error text.`,
  };
}

function modelUnavailableResolution(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): FailureResolution {
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy || policy.host !== 'cursor') {
    return {
      kind: 'model-unavailable',
      prescribedModel: null,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One cannot resolve ${observation.role}'s availability retry because immutable model-policy.json is missing or corrupt for run ${runId}. Start a repaired parent run; do not consult mutable Cursor models.`,
    };
  }
  const captured = [...(policy.cursorAvailableModels || [])];
  const fallback = resolveRunPolicyFallback(policy, {
    tier: observation.tier,
    exhaustedModels: exhaustedModelsForRole(cwd, runId, observation.role),
    unavailableModels: [...unavailableModelsForRun(cwd, runId), observation.requestedModel],
    capturedModels: captured,
  });
  const fallbackLabel = fallback?.model || `the next enabled ${observation.tier}-tier model after re-capture`;
  const choice = readModelChoice(cwd, runId);
  if (choice === 'enable-retry') {
    const recommended = exactRecommendedModel(policy, observation);
    return {
      kind: 'model-unavailable',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One recorded the run-level **enable** choice after ${observation.role}'s explicit model-unavailable failure. Open Cursor Settings → Models, enable **${observation.requestedModel}**, then retry this role on the exact recommended slug **${recommended}**.`,
    };
  }
  if (choice === 'use-fallback' && fallback) {
    return {
      kind: 'model-unavailable',
      prescribedModel: fallback.model,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One correlated ${observation.role}'s Cursor child transcript to an explicit model-unavailable failure for **${observation.requestedModel}**. The user already selected fallback. **fallback** — Proceed now on **${fallback.model}**, the next exact captured slug in this role's original tier.`,
    };
  }
  return {
    kind: 'model-unavailable',
    prescribedModel: fallback?.model || null,
    terminal: false,
    choicePrompted: !choice,
    directive: block('cursor-model-unavailable-runtime-choice', {
      ROLE: observation.role,
      FAILED: observation.requestedModel,
      FALLBACK: fallbackLabel,
    }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-model-unavailable-runtime-choice']),
  };
}

function genericResolution(observation: CursorSpawnObservation): FailureResolution {
  return {
    kind: 'generic',
    prescribedModel: null,
    terminal: false,
    choicePrompted: false,
    directive: block('cursor-model-failure-generic', {
      ROLE: observation.role,
      FAILED: observation.requestedModel,
    }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-model-failure-generic']),
  };
}

export function resolutionFor(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  kind: ModelFailureKind,
): FailureResolution {
  if (kind === 'api-limit') return apiResolution(cwd, runId, observation);
  if (kind === 'model-unavailable') return modelUnavailableResolution(cwd, runId, observation);
  return genericResolution(observation);
}

export interface ClassifiedTerminalObservation {
  observation: CursorSpawnObservation;
  transcript: ParsedCursorTranscript;
  kind: ModelFailureKind;
}
